import {define} from "../../framework/require.js";

// Game Review: analyse a finished game on THIS page, in the background, with the extension's own
// engines. Nothing is uploaded -- the PGN stays in the tab, the engine runs in the offscreen
// document (or a native host on this machine), and the report is built here.
//
// The arithmetic lives in review-core.js so it can be run under node (test_popup_logic.js drives it
// directly). This file is the page: engine plumbing, rendering, and the export.
//
// HOW A REVIEW IS COMPUTED. Every position of the game is analysed once, from the start position to
// the final one -- N+1 searches for N moves, not 2N. The score BEFORE a move is that position's own
// evaluation; the score AFTER it is the NEXT position's evaluation, which is already being computed
// for the next move anyway. That is also what makes the played move comparable with the engine's:
// both are measured by the same search at the same budget, rather than one of them by a search that
// happened to be looking for it.

const Core = self.MephistoReviewCore;

// The engines a review can judge a game with. WASM entries need nothing installed; native entries
// are probed for a live host before they are offered, since picking one that is not installed
// produces a page that sits at 0% forever.
//
// Maia is deliberately NOT in this list. It does not search: it answers "what would a human of this
// rating play", which is a different question from "how good was this move", and a review built on
// it would report a blunder as excellent whenever it was a HUMAN-LOOKING blunder. It is the Human
// model pass instead, which is its own row directly under this one.
const ENGINES = [
    {id: 'stockfish-dev-nnue', label: 'Stockfish dev (WASM)', kind: 'wasm'},
    {id: 'stockfish-18-nnue', label: 'Stockfish 18 (WASM)', kind: 'wasm'},
    {id: 'stockfish-18-small-nnue', label: 'Stockfish 18 Small (WASM)', kind: 'wasm'},
    {id: 'stockfish-11-hce', label: 'Stockfish 11 HCE (WASM)', kind: 'wasm'},
    {id: 'sf-native', label: 'Stockfish (native)', kind: 'native'},
    {id: 'fairy-native', label: 'Fairy-Stockfish (native)', kind: 'native'},
];

// The human model. Its own list because it answers its own question, and because the bands are the
// nets that actually ship: Maia 1 is nine 100-point bands from 1100 to 2200, Maia 3 is one net with
// a rating dial.
const MAIA_BANDS = ['1100', '1200', '1300', '1400', '1500', '1600', '1700', '1800', '1900',
                    '2000', '2100', '2200'];

const CFG_DEFAULTS = {
    rv_engine: 'stockfish-18-nnue',
    rv_limit_kind: 'depth',
    rv_limit_value: 16,
    rv_multipv: 3,
    // Not a literal: 4 is most of a two-core laptop and a quarter of a workstation. The panel
    // and the settings page already share this, so a review uses the same rule.
    get rv_threads() { return MephistoConfig.defaultThreads(); },
    rv_hash: 256,
    rv_human: '',
    rv_maia_band: '1500',
    rv_maia3_elo: 1500,
    rv_book: true,
};

// A game whose clocks and blunders make the whole report show something. Deliberately a famous
// short one: it finishes analysing in seconds even on the small net, so the first thing a new user
// clicks does not take a minute.
const SAMPLE_PGN = `[Event "Immortal Game"]
[Site "London"]
[Date "1851.06.21"]
[White "Anderssen"]
[Black "Kieseritzky"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`;

// ---- module state (survives a route change; the DOM does not) ---------------------------------
let games = [];         // every game in the pasted PGN
let report = null;      // the finished review, or null
let running = false;
let cancel = false;
let board = null;
let cursor = 0;         // which ply the board is showing (0 = start position)
let flipped = false;
let nativeAvailable = null; // engine id -> bool, probed once per page load
// The engine currently searching, if any. Held at module scope for one reason: closing or reloading
// this tab has to shut it down. Nothing else would -- the worker frees a PANEL's engine when its tab
// closes (keyed by tab id) and this client is deliberately not one, so a run abandoned by closing
// the tab would leave a multi-threaded search burning cores with nobody watching it.
let activeEngine = null;

const $ = (id) => document.getElementById(id);

// ---- config -----------------------------------------------------------------------------------
// Its own keys rather than the panel's: a review runs at a depth and a thread count that would be
// absurd for live play, and inheriting the panel's numbers would silently make one of them wrong.

function cfg(key) {
    const raw = MephistoConfig.get(key);
    if (raw == null || raw === '') return CFG_DEFAULTS[key];
    try {
        const v = JSON.parse(raw);
        return (v === null || v === undefined) ? CFG_DEFAULTS[key] : v;
    } catch (e) {
        return CFG_DEFAULTS[key];
    }
}

function setCfg(key, value) { MephistoConfig.set(key, JSON.stringify(value)); }

// ---- engine drivers ---------------------------------------------------------------------------
// Two transports, one interface: `analyse(fen)` resolves to `{lines, depth, nodes}` with every score
// already converted to WHITE-POSITIVE centipawns. Which transport is in use never leaves this
// section -- everything below reads `lines[i].cp` and nothing else.

// The WASM engines, over the offscreen document's UCI relay. clientId is a STRING that does not
// parse as a tab id on purpose: the service worker relays engine output to `parseInt(clientId)` and
// must not try to deliver ours to a tab (see background-script.js).
class WasmEngine {
    constructor(name, opts) {
        this.name = name;
        this.opts = opts;
        this.clientId = 'review';
        this.listeners = [];
        this.onMessage = (msg) => {
            if (!msg || !msg.fromOffscreen || msg.clientId !== this.clientId) return;
            for (const fn of this.listeners.slice()) fn(msg);
        };
    }

    async start() {
        await chrome.runtime.sendMessage({ensureOffscreen: true});
        chrome.runtime.onMessage.addListener(this.onMessage);
        const ready = this.once(m => m.kind === 'ready' || m.kind === 'error', 120000);
        chrome.runtime.sendMessage({
            toOffscreen: true, clientId: this.clientId, cmd: 'init',
            engine: this.name, variant: this.opts.variant || 'chess', maiaLevel: this.opts.maiaLevel,
        });
        const r = await ready;
        if (r.kind === 'error') throw new Error(r.error);
        if (!this.isMaia()) {
            this.send(`setoption name Threads value ${this.opts.threads}`);
            this.send(`setoption name Hash value ${this.opts.hash}`);
            this.send(`setoption name MultiPV value ${this.opts.multipv}`);
        }
        this.send('ucinewgame');
        await this.isready();
    }

    isMaia() { return this.name === 'maia' || this.name === 'maia3'; }

    send(line) {
        chrome.runtime.sendMessage({toOffscreen: true, clientId: this.clientId, cmd: 'uci', line});
    }

    // Resolve on the first message matching `pred`. Every wait here is bounded: a WASM engine that
    // dies mid-load emits nothing at all, and an unbounded await would leave the page at 0% with a
    // progress bar and no explanation -- the exact failure the floating panel had.
    once(pred, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                off();
                reject(new Error(`the engine stopped answering after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            const fn = (msg) => { if (pred(msg)) { off(); resolve(msg); } };
            const off = () => {
                clearTimeout(timer);
                const i = this.listeners.indexOf(fn);
                if (i >= 0) this.listeners.splice(i, 1);
            };
            this.listeners.push(fn);
        });
    }

    async isready() {
        const wait = this.once(m => m.kind === 'line' && /^readyok\b/.test(m.line), 60000);
        this.send('isready');
        await wait;
    }

    // One position. Collects the best info line PER multipv slot at the deepest depth reached, then
    // returns when `bestmove` arrives -- which is the only reliable "the search is over" signal UCI
    // has. A slot is overwritten only by a line at least as deep, so a shallow re-search late in the
    // iteration cannot replace a deeper result.
    async analyse(fen, turn) {
        const slots = new Map();
        let nodes = 0, depth = 0;
        const collect = (msg) => {
            if (msg.kind !== 'line') return;
            const info = Core.parseInfo(msg.line);
            if (!info || info.bound) return;
            nodes = Math.max(nodes, info.nodes || 0);
            depth = Math.max(depth, info.depth);
            const prev = slots.get(info.multipv);
            if (!prev || info.depth >= prev.depth) slots.set(info.multipv, info);
        };
        this.listeners.push(collect);
        const done = this.once(m => m.kind === 'line' && /^bestmove\b/.test(m.line), this.searchTimeout());
        this.send(`position fen ${fen}`);
        this.send(this.goCommand());
        try {
            await done;
        } finally {
            const i = this.listeners.indexOf(collect);
            if (i >= 0) this.listeners.splice(i, 1);
        }
        return this.toResult(slots, turn, depth, nodes);
    }

    goCommand() {
        if (this.isMaia()) return 'go';                       // one forward pass; no budget to give
        const {limitKind, limitValue} = this.opts;
        return limitKind === 'depth' ? `go depth ${limitValue}` : `go movetime ${limitValue}`;
    }

    // Generous, because it is a backstop and not a budget: a 4-thread WASM search at depth 20 in a
    // sharp position can take a while, and cutting it short would silently corrupt the review.
    searchTimeout() {
        const {limitKind, limitValue} = this.opts;
        return limitKind === 'depth' ? 180000 : Math.max(30000, limitValue * 20);
    }

    toResult(slots, turn, depth, nodes) {
        const lines = [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, info]) => ({
            cp: Core.toWhiteCp(info.score, info.mate, turn),
            mate: info.mate ?? null,
            pv: info.pv,
            depth: info.depth,
        }));
        return {lines, depth, nodes};
    }

    dispose() {
        try { chrome.runtime.onMessage.removeListener(this.onMessage); } catch (e) { /* gone */ }
        try {
            chrome.runtime.sendMessage({toOffscreen: true, clientId: this.clientId, cmd: 'dispose'});
        } catch (e) { /* the worker or the offscreen doc is already gone */ }
        this.listeners = [];
    }
}

// The native hosts, over the service worker's port relay. The host answers a whole `analyse` with
// its final line list, already white-relative, so there is no UCI parsing on this path at all.
// How long a depth-mode native search is allowed to take if the host turns out not to understand
// `depth`. It has to be a real budget rather than a token one: an old host will spend all of it.
const NATIVE_DEPTH_CAP_MS = 8000;

class NativeEngine {
    constructor(name, opts) {
        this.name = name;
        this.opts = opts;
        this.seq = 0;
        this.pending = new Map();
    }

    async start() {
        this.port = chrome.runtime.connect({name: this.name});
        this.port.onMessage.addListener((frame) => {
            if (frame && frame.fatal) {
                for (const {reject} of this.pending.values()) reject(new Error(frame.fatal));
                this.pending.clear();
                return;
            }
            if (!frame || frame.id == null) return;
            const p = this.pending.get(frame.id);
            if (!p) return;
            if (frame.info) return;               // a streamed depth update, not the answer
            this.pending.delete(frame.id);
            if (frame.error) p.reject(new Error(frame.error));
            else p.resolve(frame);
        });
        this.port.onDisconnect.addListener(() => {
            const err = new Error('the native host disconnected -- run native-host/install.sh once');
            for (const {reject} of this.pending.values()) reject(err);
            this.pending.clear();
            this.port = null;
        });
        await this.request('configure', {options: {
            MultiPV: this.opts.multipv, Threads: this.opts.threads, Hash: this.opts.hash,
            UCI_Variant: 'chess',
        }});
    }

    request(cmd, data) {
        return new Promise((resolve, reject) => {
            if (!this.port) return reject(new Error('the native host is not connected'));
            const id = ++this.seq;
            this.pending.set(id, {resolve, reject});
            // The host has no cancel: if it never answers, this promise would hold the whole run.
            setTimeout(() => {
                if (!this.pending.has(id)) return;
                this.pending.delete(id);
                reject(new Error('the native host did not answer this position'));
            }, Math.max(30000, (this.opts.limitKind === 'depth'
                ? NATIVE_DEPTH_CAP_MS : (this.opts.limitValue || 300)) * 20));
            try { this.port.postMessage({id, cmd, ...data}); } catch (e) { this.pending.delete(id); reject(e); }
        });
    }

    async analyse(fen) {
        // BOTH budgets go over the wire. A host that understands `depth` uses it; one that predates
        // the field ignores it and uses `time` exactly as before, so an old install keeps working
        // rather than silently doing something else. In depth mode `time` is the safety cap.
        const depthMode = this.opts.limitKind === 'depth';
        const frame = await this.request('analyse', {
            fen,
            time: depthMode ? NATIVE_DEPTH_CAP_MS : this.opts.limitValue,
            depth: depthMode ? this.opts.limitValue : undefined,
        });
        const lines = (frame.lines || []).filter(l => l.pv && l.pv.length).map(l => ({
            // the host already reports white-relative scores (python-chess `.white()`), so unlike
            // the WASM path there is no turn to fold in here
            cp: (l.mate != null && l.mate !== undefined)
                ? (l.mate > 0 ? Core.MATE_CP - Math.abs(l.mate) : -(Core.MATE_CP - Math.abs(l.mate)))
                : (l.score || 0),
            mate: l.mate ?? null,
            pv: l.pv,
            depth: l.depth || 0,
        }));
        return {lines, depth: lines.length ? lines[0].depth : 0, nodes: 0};
    }

    dispose() {
        try { this.port?.disconnect(); } catch (e) { /* already gone */ }
        this.port = null;
        this.pending.clear();
    }
}

function makeEngine(id, opts) {
    const spec = ENGINES.find(e => e.id === id);
    return (spec && spec.kind === 'native') ? new NativeEngine(id, opts) : new WasmEngine(id, opts);
}

// Is a native host installed? Same probe the panel uses: `ping` is answered without launching the
// engine, so this costs nothing even when all three are present.
function nativeHostAvailable(portName) {
    return new Promise(resolve => {
        let done = false, port;
        const finish = (ok) => { if (done) return; done = true; try { port.disconnect(); } catch (e) { /* */ } resolve(ok); };
        try { port = chrome.runtime.connect({name: portName}); } catch (e) { return resolve(false); }
        port.onMessage.addListener(frame => finish(!frame.fatal));
        port.onDisconnect.addListener(() => finish(false));
        try { port.postMessage({id: -1, cmd: 'ping'}); } catch (e) { return finish(false); }
        setTimeout(() => finish(false), 1200);
    });
}

// ---- the run ----------------------------------------------------------------------------------

// Replay the game once to get every position, and reject the PGN here rather than half-way through
// a five-minute analysis. An illegal SAN is almost always a variant game pasted into a page that
// only reviews standard chess, so it is worth saying which move failed.
function buildPositions(game) {
    const chess = new Chess('chess', game.startFen || undefined);
    const positions = [{fen: chess.fen(), turn: chess.turn(), over: null}];
    const moves = [];
    for (let i = 0; i < game.moves.length; i++) {
        const san = game.moves[i].san;
        let mv;
        try {
            mv = chess.move(san);
        } catch (e) {
            mv = null;
        }
        if (!mv) {
            const num = Math.floor(i / 2) + 1;
            throw new Error(`Move ${num}${i % 2 ? '...' : '.'} ${san} is not legal in this position `
                + `(ply ${i + 1}). Game Review reads standard chess only.`);
        }
        moves.push({
            san: mv.san,
            uci: mv.from + mv.to + (mv.promotion || ''),
            color: mv.color,
            ply: i,
            clk: game.moves[i].clk,
            to: mv.to,
            // A recapture on the square the opponent just took on. Excluded from the engine-match
            // numbers: finding it is not a result, and counting it is what makes a naive match rate
            // read 80% for everyone.
            isRecapture: !!(mv.captured && i > 0 && moves[i - 1] && moves[i - 1].to === mv.to
                && moves[i - 1].captured),
            captured: mv.captured || null,
        });
        // A finished position gets NO info lines from any engine -- there is nothing to search -- so
        // the score has to come from the rules. Without this the last move of every decisive game
        // was left unclassified, which is the one move a review is most often opened to look at.
        positions.push({
            fen: chess.fen(), turn: chess.turn(),
            over: chess.isCheckmate() ? 'mate' : (chess.isGameOver() ? 'draw' : null),
        });
    }
    return {positions, moves};
}

// Seconds spent on each move, from the clock left after it. The first move of each side has no
// previous clock to subtract from, so it is unknown rather than guessed; an increment is added back
// because the clock shown after a move already includes it.
function fillThinkTime(moves, incrementSec) {
    const prev = {w: null, b: null};
    for (const m of moves) {
        if (m.clk == null) { m.seconds = null; continue; }
        const before = prev[m.color];
        m.seconds = (before == null) ? null : Math.max(0, before - m.clk + (incrementSec || 0));
        prev[m.color] = m.clk;
    }
}

function incrementFromTimeControl(tc) {
    const m = /^(\d+)(?:\+(\d+))?/.exec(String(tc || ''));
    return m && m[2] ? +m[2] : 0;
}

async function runReview(game) {
    const opts = {
        variant: 'chess',
        limitKind: cfg('rv_limit_kind'),
        limitValue: +cfg('rv_limit_value'),
        multipv: Math.max(1, +cfg('rv_multipv')),
        threads: Math.max(1, +cfg('rv_threads')),
        hash: Math.max(16, +cfg('rv_hash')),
    };
    const {positions, moves} = buildPositions(game);
    fillThinkTime(moves, incrementFromTimeControl(game.tags.TimeControl));

    const humanKind = cfg('rv_human');
    // How many of Maia's own choices to keep. Its rank of the played move is far more informative
    // than a yes/no match: "the human model had this fourth" says something a boolean cannot.
    const HUMAN_LINES = 5;
    const total = positions.length + (humanKind ? moves.length : 0);
    let done = 0;
    const tick = (what) => {
        done++;
        progress(done / total, what);
    };

    const engine = makeEngine(cfg('rv_engine'), opts);
    activeEngine = engine;
    let human = null;
    try {
        progress(0, 'starting the engine');
        await engine.start();
        for (let i = 0; i < positions.length; i++) {
            if (cancel) throw new Error('stopped');
            const p = positions[i];
            const r = await engine.analyse(p.fen, p.turn);
            p.lines = r.lines;
            p.depth = r.depth;
            tick(`position ${i + 1} of ${positions.length}`);
        }
    } finally {
        engine.dispose();
        activeEngine = null;
    }

    if (humanKind && !cancel) {
        const level = humanKind === 'maia3' ? String(cfg('rv_maia3_elo')) : String(cfg('rv_maia_band'));
        human = makeEngine(humanKind, {...opts, multipv: HUMAN_LINES, maiaLevel: level});
        activeEngine = human;
        try {
            progress(done / total, 'starting the human model');
            await human.start();
            for (let i = 0; i < moves.length; i++) {
                if (cancel) break;
                const r = await human.analyse(positions[i].fen, positions[i].turn);
                const order = r.lines.map(l => l.pv?.[0]).filter(Boolean);
                moves[i].maiaMove = order[0] || null;
                moves[i].maiaOrder = order;
                const at = order.indexOf(moves[i].uci);
                // Outside the list is not "unknown", it is "further down than we looked". Recorded
                // as one past the end so it counts against the match rate rather than vanishing.
                moves[i].maiaRank = order.length ? (at >= 0 ? at + 1 : order.length + 1) : null;
                moves[i].maiaMatch = moves[i].maiaRank === 1;
                tick(`human model, move ${i + 1} of ${moves.length}`);
            }
        } catch (e) {
            // A missing Maia net must not throw the whole review away: the engine pass is the report.
            note(`Human model unavailable (${e.message}) -- the rest of the report is unaffected.`, true);
        } finally {
            human.dispose();
            activeEngine = null;
        }
    }

    const book = cfg('rv_book') ? await lookupOpening(positions, moves) : {name: null, plies: 0};
    return assemble(game, positions, moves, book, opts);
}

// The opening, from the Lichess masters database, via the service worker (never from this page, so
// the request carries the extension's origin rather than a game site's). Stops at the first position
// the database does not know: that ply is where the players left theory.
async function lookupOpening(positions, moves) {
    let name = null, plies = 0;
    for (let i = 0; i < Math.min(positions.length - 1, 30); i++) {
        let r;
        try {
            r = await chrome.runtime.sendMessage({explorerLookup: {fen: positions[i].fen, db: 'masters'}});
        } catch (e) {
            break;
        }
        if (!r || r.error || !r.moves || !r.moves.length) break;
        if (r.opening && r.opening.name) name = `${r.opening.eco} ${r.opening.name}`;
        // the move actually played has to be one the database knows, or the NEXT position is out of
        // book and this ply was the last one in it
        if (!r.moves.some(m => m.uci === moves[i].uci)) break;
        plies = i + 1;
    }
    return {name, plies};
}

// Fold the raw searches into the move table the whole report is drawn from.
function assemble(game, positions, moves, book, opts) {
    for (const m of moves) {
        const before = positions[m.ply];
        const after = positions[m.ply + 1];
        const bestCp = before.lines?.[0]?.cp;
        // `after` is terminal: checkmate is a win for whoever just moved, anything else is a draw.
        const afterCp = after.over === 'mate' ? (m.color === 'w' ? Core.MATE_CP : -Core.MATE_CP)
            : after.over === 'draw' ? 0
            : after.lines?.[0]?.cp;
        if (bestCp == null || afterCp == null) continue;

        // Everything from the MOVER's point of view: a white-positive score is good for white, so
        // black's numbers are the negation. Getting this backwards makes every black move look like
        // a blunder, which is at least a loud failure.
        const sign = m.color === 'w' ? 1 : -1;
        m.evalBefore = bestCp * sign;
        m.evalAfter = afterCp * sign;
        m.winBefore = Core.winPercent(bestCp * sign);
        m.winAfter = Core.winPercent(afterCp * sign);
        m.cpLoss = Math.max(0, Math.min(1000, m.evalBefore - m.evalAfter));
        m.acc = Core.moveAccuracy(m.winBefore, m.winAfter);
        m.best = before.lines[0].pv[0];
        m.bestLines = before.lines;
        m.depth = before.depth;

        const idx = before.lines.findIndex(l => l.pv[0] === m.uci);
        m.rank = idx >= 0 ? idx + 1 : null;
        // How much better the engine's move was than its second choice. A big gap is a position
        // where being right is a real achievement, which is the only kind worth counting as evidence.
        m.complexity = before.lines.length > 1
            ? Math.abs(before.lines[0].cp - before.lines[1].cp) : null;
        m.onlyMove = before.lines.length === 1;
        m.isBook = m.ply < book.plies;
        m.klass = Core.classify({
            winBefore: m.winBefore, winAfter: m.winAfter, rank: m.rank,
            onlyMove: m.onlyMove, isBook: m.isBook,
        });
    }
    const phases = Core.gamePhases(positions.map(p => p.fen));
    return {
        game, positions, moves, book, opts, phases,
        accuracy: {w: Core.accuracyFor(moves, 'w'), b: Core.accuracyFor(moves, 'b')},
        indicators: {
            w: Core.indicators(moves, 'w', opts.multipv, phases, game.tags),
            b: Core.indicators(moves, 'b', opts.multipv, phases, game.tags),
        },
        counts: {w: countClasses(moves, 'w'), b: countClasses(moves, 'b')},
        engineId: cfg('rv_engine'),
        humanKind: cfg('rv_human'),
        at: new Date().toISOString(),
    };
}

function countClasses(moves, color) {
    const out = {};
    for (const k of Core.CLASS_ORDER) out[k] = 0;
    for (const m of moves) if (m.color === color && m.klass) out[m.klass]++;
    return out;
}

// ---- rendering --------------------------------------------------------------------------------

function progress(frac, text) {
    $('rv_progress_wrap')?.classList.remove('hidden');
    const bar = $('rv_progress_bar');
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    const t = $('rv_progress_text');
    if (t) t.textContent = text ? `${Math.round(frac * 100)}% — ${text}` : '';
}

function note(text, bad) {
    const el = $('rv_pgn_status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('rv-bad', !!bad);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

function scoreText(cp, mate) {
    if (mate != null) return (mate > 0 ? '#' : '#-') + Math.abs(mate);
    // No mate field to hand (the move table keeps one number per move): the distance is still in
    // there, because that is exactly how toWhiteCp encodes it. `#` with no number reads as a bug.
    if (Core.isMateScore(cp)) {
        return (cp > 0 ? '#' : '#-') + (Core.MATE_CP - Math.abs(cp));
    }
    return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
}

// The same eight colours review.css declares, as literals -- the export carries no stylesheet of
// ours, and a second list that drifts is worse than one list read from two places.
const CLASS_COLOUR = {
    best: '#2f7d41', excellent: '#4c9a5e', good: '#7d8a91', book: '#8a6d3b', forced: '#5b6b8a',
    inaccuracy: '#b8860b', mistake: '#cc7722', blunder: '#b03030',
};

const CLASS_LABEL = {
    best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book', forced: 'Forced',
    inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder',
};

function renderReport() {
    if (!report) return;
    $('rv-report').classList.remove('hidden');
    $('rv-indicators').classList.remove('hidden');
    $('rv_export').disabled = false;
    renderHeader();
    renderCards();
    renderGraph();
    renderMoves();
    renderIndicators();
    ensureBoard();
    showPly(report.moves.length);
}

// "GM Carlsen (2839)". The title comes from the PGN's own tag, which chess.com and lichess both
// write; a game without one just renders the name.
function playerName(color) {
    const t = report.game.tags;
    const title = color === 'w' ? t.WhiteTitle : t.BlackTitle;
    const name = (color === 'w' ? t.White : t.Black) || (color === 'w' ? 'White' : 'Black');
    return (title && title !== '-' ? `${title} ` : '') + name;
}

function playerLine(color) {
    const t = report.game.tags;
    const elo = color === 'w' ? t.WhiteElo : t.BlackElo;
    return playerName(color) + (elo ? ` (${elo})` : '');
}

function renderHeader() {
    const t = report.game.tags;
    const bits = [];
    if (t.Event) bits.push(esc(t.Event));
    if (t.Date) bits.push(esc(Core.formatDate(t.Date)));
    if (t.TimeControl) bits.push(esc(t.TimeControl));
    if (report.book.name) bits.push(esc(report.book.name));
    const eng = ENGINES.find(e => e.id === report.engineId);
    const budget = report.opts.limitKind === 'depth'
        ? `depth ${report.opts.limitValue}` : `${report.opts.limitValue}ms/move`;
    bits.push(`${esc(eng ? eng.label : report.engineId)}, ${budget}, ${report.opts.multipv} line(s)`);
    $('rv_header').innerHTML =
        `<div class="rv-vs">${esc(playerLine('w'))} &ndash; ${esc(playerLine('b'))}`
        + ` &nbsp;${esc(report.game.result)}</div>`
        + `<div class="rv-meta">${bits.join(' · ')}</div>`;
}

function renderCards() {
    const t = report.game.tags;
    const card = (color) => {
        const name = playerLine(color);
        const acc = report.accuracy[color];
        const ind = report.indicators[color];
        const counts = report.counts[color];
        const rows = Core.CLASS_ORDER
            .filter(k => counts[k])
            .map(k => `<div class="rv-kv rv-c-${k}"><span><b>${CLASS_LABEL[k]}</b></span><span>${counts[k]}</span></div>`)
            .join('');
        return `<div class="rv-card">
            <h4>${esc(name)}</h4>
            <div class="rv-big">${acc == null ? '—' : acc.toFixed(1) + '%'}</div>
            <div class="rv-sub">accuracy over ${ind.moves} moves</div>
            <div style="margin-top:10px">${rows}</div>
            <div class="rv-kv" style="margin-top:8px"><span>Avg. centipawn loss</span><span>${ind.acpl ?? '—'}</span></div>
            ${ind.top1 == null ? '' : `<div class="rv-kv"><span>Engine's first choice</span><span>${(ind.top1 * 100).toFixed(0)}%</span></div>`}
            ${ind.secMedian == null ? '' : `<div class="rv-kv"><span>Median think time</span><span>${ind.secMedian.toFixed(1)}s</span></div>`}
        </div>`;
    };
    $('rv_cards').innerHTML = card('w') + card('b');
}

// The eval graph: white's advantage over the game, clamped so one mate score cannot flatten
// everything else into a straight line. Clicking it jumps the board to that move.
function renderGraph() {
    const svg = buildGraphSvg(true);
    if (!svg) return;
    $('rv_graph').innerHTML = svg;
    const el = $('rv_graph').querySelector('svg');
    el.addEventListener('click', (e) => {
        const r = el.getBoundingClientRect();
        showPly(Math.round(((e.clientX - r.left) / r.width) * (report.positions.length - 1)));
    });
    $('rv_graph_legend').innerHTML = Core.CLASS_ORDER
        .filter(k => report.counts.w[k] || report.counts.b[k])
        .map(k => `<span class="rv-c-${k}">${CLASS_LABEL[k]} — white ${report.counts.w[k]}, black ${report.counts.b[k]}</span>`)
        .join('');
}

// The eval graph. `live` uses the page's CSS variables (so it follows dark mode and the cursor line
// is there to move); the export needs the same picture with literal colours and no cursor, since it
// carries no stylesheet of ours and runs no script.
function buildGraphSvg(live) {
    const W = 1000, H = 150, MID = H / 2;
    const pts = report.positions.map(p => p.lines?.[0]?.cp ?? 0);
    if (!pts.length) return '';
    const col = live
        ? {up: 'var(--mp-hair)', down: 'var(--mp-line)', ink: 'var(--mp-text)', mid: 'var(--mp-mute)', bg: 'var(--mp-bg)'}
        : {up: '#eceef0', down: '#dcdfe3', ink: '#14171a', mid: '#8b9198', bg: '#ffffff'};
    // A logistic squash rather than a linear scale: the difference between +1 and +2 pawns matters
    // and the difference between +8 and +9 does not, and a linear axis spends all its room on the
    // second one.
    const y = (cp) => MID - MID * 0.94 * Math.tanh(Core.clamp(cp, -2500, 2500) / 400);
    const x = (i) => (pts.length === 1) ? 0 : (i / (pts.length - 1)) * W;
    const line = pts.map((cp, i) => `${x(i).toFixed(1)},${y(cp).toFixed(1)}`).join(' ');
    const area = `0,${MID} ` + line + ` ${W},${MID}`;
    const blunderMarks = report.moves
        .filter(m => m.klass === 'blunder' || m.klass === 'mistake')
        .map(m => `<circle cx="${x(m.ply + 1).toFixed(1)}" cy="${y(report.positions[m.ply + 1].lines?.[0]?.cp ?? 0).toFixed(1)}"
                    r="5" fill="${live ? 'var(--rv-c)' : CLASS_COLOUR[m.klass]}" stroke="${col.bg}" stroke-width="1.5"
                    ${live ? `class="rv-c-${m.klass}"` : ''}><title>${esc(moveLabel(m))} ${CLASS_LABEL[m.klass]}</title></circle>`)
        .join('');
    // Opening / middlegame / endgame, on lichess's own divider so the boundaries land where a
    // lichess user expects them. Drawn as a line and a label rather than a tinted band: the graph
    // already uses fill to mean "who is better", and a second meaning for fill would fight it.
    const ph = report.phases || {};
    const marks = [];
    if (ph.mid != null) marks.push([ph.mid, 'middlegame']);
    if (ph.end != null) marks.push([ph.end, 'endgame']);
    const phaseSvg = marks.map(([ply, label]) => {
        const px = x(Math.min(ply, pts.length - 1));
        return `<line x1="${px.toFixed(1)}" y1="0" x2="${px.toFixed(1)}" y2="${H}" `
            + `stroke="${col.mid}" stroke-width="1" stroke-dasharray="4 4" opacity="0.85"/>`
            + `<text x="${(px + 6).toFixed(1)}" y="13" fill="${col.mid}" font-size="11" `
            + `font-family="-apple-system, system-ui, sans-serif">${label}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <rect x="0" y="0" width="${W}" height="${MID}" fill="${col.up}"/>
        <rect x="0" y="${MID}" width="${W}" height="${MID}" fill="${col.down}"/>
        <polygon points="${area}" fill="${col.ink}" opacity="0.72"/>
        <polyline points="${line}" fill="none" stroke="${col.ink}" stroke-width="1.5" opacity="0.9"/>
        <line x1="0" y1="${MID}" x2="${W}" y2="${MID}" stroke="${col.mid}" stroke-width="1" opacity="0.5"/>
        ${phaseSvg}
        ${live ? `<line id="rv_graph_cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="var(--mp-on)" stroke-width="2"/>` : ''}
        ${blunderMarks}
    </svg>`;
}

function moveLabel(m) {
    return `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'} ${m.san}`;
}

function renderMoves() {
    const rows = [];
    for (let i = 0; i < report.moves.length; i += 2) {
        const num = i / 2 + 1;
        rows.push(`<div class="rv-mrow"><div class="rv-mnum">${num}</div>`
            + moveCell(report.moves[i]) + moveCell(report.moves[i + 1]) + '</div>');
    }
    const el = $('rv_moves');
    el.innerHTML = rows.join('');
    // Delegated, and bound ONCE per page render: innerHTML replaces the rows but not the container,
    // so a listener added here on every re-render would fire N times per click.
    if (!el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('click', (e) => {
            const cell = e.target.closest('.rv-mcell[data-ply]');
            if (cell) showPly(+cell.dataset.ply + 1);
        });
    }
}

function moveCell(m) {
    if (!m) return '<div class="rv-mcell"></div>';
    const k = m.klass || 'good';
    const loss = (m.cpLoss == null || m.cpLoss < 1) ? '' : `−${Math.round(m.cpLoss)}`;
    return `<div class="rv-mcell rv-c-${k}" data-ply="${m.ply}" title="${esc(CLASS_LABEL[k])}">
        <span class="rv-dot"></span><span class="rv-san">${esc(m.san)}</span>
        <span class="rv-loss">${loss}</span></div>`;
}

function renderIndicators() {
    // The key. Printed from the same list the levels are assigned from, so a caption that disagrees
    // with the labels underneath it is not possible.
    $('rv_levels').innerHTML = Core.LEVELS.map(l =>
        `<div class="rv-lvl"><span class="rv-ev-flag rv-ev-${l.key}">${esc(l.label)}</span>`
        + `<span>${esc(l.what)}</span></div>`).join('');
    const col = (color) => {
        const name = playerName(color);
        const ind = report.indicators[color];
        const evid = Core.evidence(ind, {});
        const items = evid.map(e => `<div class="rv-ev">
            <span class="rv-ev-flag rv-ev-${e.level}">${e.level}</span>${esc(e.text)}
            <span class="rv-ev-note">${esc(e.note)}</span></div>`).join('');
        return `<div class="rv-ind-col"><h4>${esc(name)}</h4>${items || '<div class="rv-ev">Not enough data.</div>'}</div>`;
    };
    $('rv_indicators').innerHTML = col('w') + col('b');
}

// ---- board ------------------------------------------------------------------------------------

function ensureBoard() {
    const host = $('rv_board');
    if (!host) return;
    const [set, ext] = String(cfg('pieces') || 'wikipedia.svg').split('.');
    board = MephistoBoard(host, {
        position: 'start',
        pieceTheme: `/res/chesspieces/${set}/{piece}.${ext}`,
        showNotation: true,
        orientation: flipped ? 'black' : 'white',
    });
}

function showPly(ply) {
    if (!report) return;
    cursor = Core.clamp(ply, 0, report.positions.length - 1);
    const pos = report.positions[cursor];
    board?.position(pos.fen);
    const played = cursor > 0 ? report.moves[cursor - 1] : null;
    drawArrows(pos, played);
    renderDetail(pos, played);
    const line = $('rv_graph_cursor');
    if (line) {
        const x = (cursor / Math.max(1, report.positions.length - 1)) * 1000;
        line.setAttribute('x1', x); line.setAttribute('x2', x);
    }
    document.querySelectorAll('.rv-mcell.rv-sel').forEach(el => el.classList.remove('rv-sel'));
    const sel = document.querySelector(`.rv-mcell[data-ply="${cursor - 1}"]`);
    if (sel) {
        sel.classList.add('rv-sel');
        sel.scrollIntoView({block: 'nearest'});
    }
}

// The move that was played, in its classification colour, plus the engine's alternatives for the
// position now on the board. Drawn back to front so the best line sits on top of the rest.
function drawArrows(pos, played) {
    const svg = $('rv_arrows');
    if (!svg) return;
    // The renderer floors the square size and draws a 2px border, so the board is never exactly the
    // wrapper's box. Take the overlay's geometry from the board element itself rather than from the
    // wrapper, or every arrow lands a few pixels off its square.
    const inner = $('rv_board')?.querySelector('.board-b72b1');
    if (inner) {
        svg.style.left = `${inner.offsetLeft + 2}px`;
        svg.style.top = `${inner.offsetTop + 2}px`;
        svg.style.width = `${inner.clientWidth}px`;
        svg.style.height = `${inner.clientHeight}px`;
    }
    const specs = [];
    // The engine's lines first, thinning and fading down the list, so #1 reads as the recommendation
    // and the rest as context.
    (pos.lines || []).slice(0, report.opts.multipv).forEach((l, i) => {
        if (!l.pv?.[0]) return;
        specs.push({
            uci: l.pv[0],
            color: ENGINE_ARROW,
            width: Math.max(0.085, 0.15 - i * 0.022),
            opacity: Math.max(0.3, 0.82 - i * 0.15),
            rank: i + 1,
        });
    });
    // The played move last, so it is drawn on top of everything: it is the thing being judged.
    if (played) {
        specs.push({
            uci: played.uci,
            color: CLASS_COLOUR[played.klass] || CLASS_COLOUR.good,
            width: 0.17,
            opacity: 0.95,
            played: true,
        });
    }
    svg.innerHTML = specs.map(arrow).filter(Boolean).join('');
}

const ENGINE_ARROW = '#2f7d41';

// One arrow in board coordinates (0..8 on both axes). A rounded shaft that stops short of the head
// so the two never overlap into a blob, a head with slightly concave wings so it reads as an arrow
// rather than a triangle stuck on a stick, and a soft outline underneath so a light arrow is still
// visible on a light square. The played move gets a dashed centre line, which is what distinguishes
// it from an engine arrow of the same colour when the two agree.
function arrow(spec) {
    const m = /^([a-h][1-8])([a-h][1-8])/.exec(spec.uci || '');
    if (!m) return '';
    const sq = (t) => {
        const f = t.charCodeAt(0) - 97, r = +t[1] - 1;
        return flipped ? {x: 7 - f + 0.5, y: r + 0.5} : {x: f + 0.5, y: 7 - r + 0.5};
    };
    const a = sq(m[1]), b = sq(m[2]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!len) return '';
    const ux = dx / len, uy = dy / len;
    const w = spec.width;
    const head = Math.min(0.34, len * 0.45);      // never longer than the move itself
    // start a little off the origin square's centre, so the piece under it stays readable
    const sx = a.x + ux * 0.16, sy = a.y + uy * 0.16;
    const ex = b.x - ux * head, ey = b.y - uy * head;
    const wing = head * 0.52;
    const nx = -uy, ny = ux;
    // concave back edge: the wings pull slightly toward the tip
    const notch = head * 0.22;
    const pts = [
        `${b.x},${b.y}`,
        `${ex + nx * wing},${ey + ny * wing}`,
        `${ex + ux * notch},${ey + uy * notch}`,
        `${ex - nx * wing},${ey - ny * wing}`,
    ].join(' ');
    // The outline is a STROKE on the same two shapes rather than a scaled copy underneath: a scaled
    // polygon drifts off its own tip, which is exactly where an arrow is read.
    const edge = 0.022;
    return `<g opacity="${spec.opacity}" stroke-linejoin="round">`
        + `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#0000004d" `
        + `stroke-width="${w + edge * 2}" stroke-linecap="round"/>`
        + `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${spec.color}" `
        + `stroke-width="${w}" stroke-linecap="round"/>`
        + `<polygon points="${pts}" fill="${spec.color}" stroke="#0000004d" stroke-width="${edge * 2}"/>`
        + `</g>`;
}

function renderDetail(pos, played) {
    const el = $('rv_move_detail');
    if (!el) return;
    if (!played) {
        el.innerHTML = `<span class="rv-meta">Start position${report.book.name ? ` — ${esc(report.book.name)}` : ''}.</span>`;
    } else {
        const k = played.klass || 'good';
        const bits = [`<span class="rv-c-${k}"><span class="rv-klass">${CLASS_LABEL[k]}</span></span>`,
            `<b>${esc(moveLabel(played))}</b>`];
        if (played.cpLoss > 0) bits.push(`gave up ${Math.round(played.cpLoss)}cp`);
        if (played.rank) bits.push(`engine's #${played.rank}`);
        else if (played.best) bits.push(`engine played ${esc(uciToSan(report.positions[played.ply].fen, played.best))}`);
        if (played.seconds != null) bits.push(`${played.seconds.toFixed(1)}s on the clock`);
        if (played.maiaMove) {
            bits.push(played.maiaMatch
                ? 'the human model expected this'
                : `the human model expected ${esc(uciToSan(report.positions[played.ply].fen, played.maiaMove))}`);
        }
        el.innerHTML = bits.join(' · ');
    }
    const lines = (pos.lines || []).slice(0, report.opts.multipv);
    $('rv_lines').innerHTML = lines.map((l, i) => {
        const stm = pos.turn;
        const shown = l.cp * (stm === 'w' ? 1 : -1); // from the side to move, like every engine UI
        return `<div class="rv-line"><span class="rv-score">${esc(scoreText(shown, l.mate))}</span>
            <span class="rv-pv">${esc(pvToSan(pos.fen, l.pv).join(' '))}</span></div>`;
    }).join('');
}

// UCI -> SAN for display. A pv that goes illegal (it can, at the tail of a truncated line) stops
// there rather than throwing the whole panel away.
function pvToSan(fen, pv) {
    const out = [];
    try {
        const chess = new Chess('chess', fen);
        for (const uci of (pv || []).slice(0, 12)) {
            const mv = chess.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
            if (!mv) break;
            out.push(mv.san);
        }
    } catch (e) { /* stop at the last legal move */ }
    return out;
}

function uciToSan(fen, uci) {
    return pvToSan(fen, [uci])[0] || uci;
}

// ---- export -----------------------------------------------------------------------------------
// The report exactly as it looks on this page, minus the page: same markup, same stylesheets, same
// board. Rebuilding it as a second, simpler document was the first version and it drifted from the
// real one within a day -- two renderers for one report is one too many. This clones what is on
// screen instead, so the file cannot disagree with the page it came from.
//
// Everything it needs is inlined, because the file has to still open in five years on a machine
// that has never heard of this extension: the three stylesheets, the twelve piece images, and no
// script at all.

const EXPORT_CSS = ['/src/options/options.css', '/src/options/pages/review/review.css',
                    '/lib/chessboard/chessboard.min.css'];

// options.css styles the whole options SHELL, so the parts that assume a sidebar have to be undone.
// Kept as an explicit override block rather than by editing that sheet: it is the shell's stylesheet
// and it is right about the shell.
const EXPORT_RESET = `
  html, body { margin: 0; padding: 0; }
  body { padding: 28px 22px 40px; }
  header, main, footer { padding-left: 0 !important; }
  main > .container { width: 100% !important; max-width: 1180px; margin: 0 auto; }
  .set-sec:first-child { margin-top: 0; }
  .rv-nav, .rv-arrows text { display: none; }
  /* The board carries its own pixel size from the page it was cloned from, so the 1:1 wrapper must
     shrink to it. Left at a 1:1 ratio on a full-width column it became a 900px-tall box with a
     350px board sitting at the top of it. */
  .rv-board-wrap { width: max-content; aspect-ratio: auto; }
  .rv-board { width: auto; height: auto; }
  #rv_graph svg, .rv-mcell { cursor: default; }
  .rv-mcell:hover { background: none; }
  .rv-moves { max-height: none; }
  /* the page follows a toggle; a file follows whoever opens it */
  @media (prefers-color-scheme: dark) {
    :root {
      --mp-bg: #16171b; --mp-raised: #1c1e22; --mp-hair: #26282d; --mp-line: #34353d;
      --mp-text: #e8eaec; --mp-dim: #b7bbc0; --mp-mute: #6b7079; --mp-on: #3f9d54;
      --mp-on-soft: #16311e; --mp-track: #3a3a42;
    }
    .rv-c-best { --rv-c: #4bb265; } .rv-c-excellent { --rv-c: #63b478; }
    .rv-c-good { --rv-c: #98a3aa; } .rv-c-book { --rv-c: #b08d55; }
    .rv-c-forced { --rv-c: #8095c0; } .rv-c-inaccuracy { --rv-c: #d8a628; }
    .rv-c-mistake { --rv-c: #e08a3c; } .rv-c-blunder { --rv-c: #d15050; }
    .rv-ev-notable { color: #d8a628; } .rv-ev-high { color: #e08a3c; }
    .rv-ev-strong { color: #d15050; }
  }
`;

async function inlineText(path) {
    try {
        const r = await fetch(chrome.runtime.getURL(path.replace(/^\//, '')));
        return r.ok ? await r.text() : '';
    } catch (e) {
        return '';
    }
}

async function inlineImage(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const type = r.headers.get('content-type') || 'image/png';
        return `data:${type};base64,${btoa(bin)}`;
    } catch (e) {
        return null;
    }
}

// The full move table, which the page does not show: on screen the detail is a click away, in a
// file there is nothing to click.
function exportMoveTable() {
    const rows = report.moves.map(m => `<tr>
        <td>${esc(moveLabel(m))}</td>
        <td class="rv-c-${m.klass || 'good'}"><b>${esc(CLASS_LABEL[m.klass] || '')}</b></td>
        <td class="n">${m.evalBefore == null ? '' : esc(scoreText(m.evalBefore, null))}</td>
        <td class="n">${m.cpLoss == null ? '' : Math.round(m.cpLoss)}</td>
        <td class="n">${m.rank ?? ''}</td>
        <td class="n">${m.seconds == null ? '' : m.seconds.toFixed(1)}</td>
        <td>${m.best ? esc(uciToSan(report.positions[m.ply].fen, m.best)) : ''}</td>
        <td>${m.maiaMove ? esc(uciToSan(report.positions[m.ply].fen, m.maiaMove))
              + (m.maiaRank ? ` (#${m.maiaRank})` : '') : ''}</td>
        <td>${esc(Core.phaseOf(m.ply, report.phases || {}))}</td>
    </tr>`).join('\n');
    return `<section class="set-sec"><h3 class="set-h">Every move</h3>
      <table class="rv-table"><thead><tr>
        <th>Move</th><th>Quality</th><th>Eval</th><th>Lost</th><th>Rank</th><th>Time</th>
        <th>Engine</th><th>Human model</th><th>Phase</th>
      </tr></thead><tbody>${rows}</tbody></table></section>`;
}

async function exportHtml(btn) {
    if (!report) return;
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    try {
        // Show the start position, so the exported board is the game's own opening rather than
        // whatever move happened to be selected when the button was pressed.
        const wasAt = cursor;
        showPly(0);

        const css = (await Promise.all(EXPORT_CSS.map(inlineText))).join('\n') + EXPORT_RESET;

        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="row"><div class="col s12"><div class="big-section">`
            + $('rv-report').outerHTML + $('rv-indicators').outerHTML
            + `</div></div></div>`;
        wrap.querySelectorAll('.hidden').forEach(el => el.classList.remove('hidden'));
        wrap.querySelectorAll('.rv-nav, .tooltipped .info-tooltip').forEach(el => el.remove());
        wrap.querySelector('#rv_graph_cursor')?.remove();
        wrap.querySelector('#rv_move_detail')?.remove();

        // the board's pieces are extension URLs, which mean nothing outside this browser
        const imgs = [...wrap.querySelectorAll('img[src]')];
        const seen = new Map();
        for (const img of imgs) {
            if (!seen.has(img.src)) seen.set(img.src, await inlineImage(img.src));
            const data = seen.get(img.src);
            if (data) img.src = data; else img.remove();
        }

        const t = report.game.tags;
        const title = `${playerName('w')} vs ${playerName('b')}`;
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Game review — ${esc(title)}</title>
<style>${css}</style>
</head><body><main><div class="container">
${wrap.innerHTML}
${exportMoveTable()}
<p class="rv-status">Generated ${esc(Core.formatDate(new Date().toISOString().slice(0, 10).replace(/-/g, '.')))}
 by the Mephisto Chess Extension. The analysis in this file was produced on the machine that wrote it;
 nothing was uploaded.</p>
</div></main></body></html>`;

        showPly(wasAt);
        const name = `review-${(t.White || 'white').replace(/\W+/g, '_')}`
            + `-vs-${(t.Black || 'black').replace(/\W+/g, '_')}.html`;
        const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

// ---- chess.com import -------------------------------------------------------------------------
// The public archive API: no key, no login, public games only. Reachable from here because an
// EXTENSION PAGE is not subject to the page CORS rules a content script would be -- and doing it
// here rather than in the game tab means chess.com never sees the request alongside a live game.

async function fetchChesscom(user) {
    const clean = String(user || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!clean) throw new Error('Type a chess.com username first.');
    const arch = await fetch(`https://api.chess.com/pub/player/${clean}/games/archives`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`chess.com answered ${r.status}`)));
    const urls = (arch.archives || []).slice(-2).reverse(); // this month and last
    if (!urls.length) throw new Error(`No public games found for "${clean}".`);
    const out = [];
    for (const u of urls) {
        const month = await fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
        for (const g of (month?.games || [])) if (g.pgn) out.push(g.pgn);
        if (out.length >= 40) break;
    }
    if (!out.length) throw new Error(`No games with a PGN in "${clean}"'s last two months.`);
    return out.reverse().slice(0, 40).join('\n\n');
}

// ---- page wiring ------------------------------------------------------------------------------

function loadPgnText(text) {
    const el = $('rv_pgn');
    if (el) el.value = text;
    parsePgnBox();
}

function parsePgnBox() {
    const text = $('rv_pgn')?.value || '';
    games = text.trim() ? Core.parsePgn(text) : [];
    const sel = $('rv_game_select');
    const row = $('rv_games_row');
    if (games.length > 1) {
        sel.innerHTML = games.map((g, i) => {
            const t = g.tags;
            return `<option value="${i}">${esc(`${i + 1}. ${t.White || '?'} — ${t.Black || '?'}`
                + `  ${g.result}  ${t.Date || ''}`)}</option>`;
        }).join('');
        row.classList.remove('hidden');
    } else {
        row.classList.add('hidden');
    }
    if (!text.trim()) note('');
    else if (!games.length) note('No games found in that text. A PGN needs at least one move.', true);
    else note(`${games.length} game${games.length > 1 ? 's' : ''} read`
        + (games.length === 1 ? ` — ${games[0].moves.length} moves` : '') + '.');
}

function selectedGame() {
    if (!games.length) return null;
    const i = games.length > 1 ? +($('rv_game_select')?.value || 0) : 0;
    return games[i] || games[0];
}

async function onRun() {
    if (running) return;
    const game = selectedGame();
    if (!game) return note('Paste a PGN first.', true);
    running = true;
    cancel = false;
    $('rv_run').disabled = true;
    $('rv_stop').disabled = false;
    note('');
    try {
        const built = await runReview(game);
        built.pgnText = $('rv_pgn')?.value || '';
        report = built;
        renderReport();
        progress(1, 'done');
        $('rv-report').scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (e) {
        if (cancel) note('Stopped.');
        else note(String(e.message || e), true);
        progress(0, '');
        $('rv_progress_wrap')?.classList.add('hidden');
    } finally {
        running = false;
        cancel = false;
        // The page is re-injected on every route change, so these can be gone by the time a long
        // run ends -- the run itself is module state and outlives the DOM it started from.
        if ($('rv_run')) $('rv_run').disabled = false;
        if ($('rv_stop')) $('rv_stop').disabled = true;
    }
}

function syncLimitUi() {
    const kind = $('rv_limit_kind').value;
    const v = $('rv_limit_value');
    if (kind === 'depth') {
        v.min = 1; v.max = 40; v.step = 1;
        $('rv_limit_unit').textContent = 'plies';
    } else {
        v.min = 50; v.max = 60000; v.step = 50;
        $('rv_limit_unit').textContent = 'ms per position';
    }
    // A depth of 16 is sensible and 16ms is not, so switching the KIND has to move the value into
    // that kind's range rather than leaving a number that means something else entirely.
    const n = +v.value;
    if (kind === 'depth' && n > 40) v.value = 20;
    if (kind === 'time' && n < 50) v.value = 300;
    setCfg('rv_limit_value', +v.value);
    updateEngineOptions();
}

function updateEngineOptions() {
    const sel = $('rv_engine');
    if (!sel) return;
    const depthMode = $('rv_limit_kind').value === 'depth';
    const current = sel.value;
    sel.innerHTML = ENGINES.map(e => {
        const missing = e.kind === 'native' && nativeAvailable && !nativeAvailable[e.id];
        const noDepth = e.kind === 'native' && depthMode;
        const why = missing ? ' — host not installed' : (noDepth ? ' — needs a time budget' : '');
        return `<option value="${e.id}"${missing || noDepth ? ' disabled' : ''}>${esc(e.label + why)}</option>`;
    }).join('');
    const opt = [...sel.options].find(o => o.value === current && !o.disabled);
    sel.value = opt ? current : ([...sel.options].find(o => !o.disabled)?.value || ENGINES[0].id);
    if (sel.value !== current) setCfg('rv_engine', sel.value);
}

function bindNumber(id, key) {
    const el = $(id);
    if (!el) return;
    el.value = cfg(key);
    el.addEventListener('change', () => {
        const n = Core.clamp(+el.value || CFG_DEFAULTS[key], +el.min || 0, +el.max || 1e9);
        el.value = n;
        setCfg(key, n);
    });
}

function bindSteppers() {
    document.querySelectorAll('.set-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = btn.parentElement.querySelector('input[type=number]');
            if (!input) return;
            const step = +btn.dataset.step || 1;
            const next = (+input.value || 0) + step * (Math.abs(step) === 1 ? (+input.step || 1) : 1);
            input.value = Core.clamp(next, +input.min || 0, +input.max || 1e9);
            input.dispatchEvent(new Event('change', {bubbles: true}));
        });
    });
}

function bindHumanUi() {
    const sel = $('rv_human');
    // The bands come from ONE list. The markup carries them too so the row renders before this runs,
    // but this is the authority -- a net added to the build should only have to be named once.
    const band0 = $('rv_maia_band');
    band0.innerHTML = MAIA_BANDS.map(b => `<option value="${b}">${b}</option>`).join('');
    const sync = () => {
        $('rv_maia_band').classList.toggle('hidden', sel.value !== 'maia');
        $('rv_maia3_wrap').classList.toggle('hidden', sel.value !== 'maia3');
    };
    sel.value = cfg('rv_human');
    sel.addEventListener('change', () => { setCfg('rv_human', sel.value); sync(); });
    const band = $('rv_maia_band');
    band.value = cfg('rv_maia_band');
    band.addEventListener('change', () => setCfg('rv_maia_band', band.value));
    sync();
}

class ReviewPage {
    async onInit() {
        await MephistoConfig.ready;
        await window.mephistoApplyLanguage?.();
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});

        $('rv_pgn').addEventListener('input', parsePgnBox);
        $('rv_file_btn').addEventListener('click', () => $('rv_file').click());
        $('rv_file').addEventListener('change', async () => {
            const f = $('rv_file').files[0];
            if (f) loadPgnText(await f.text());
            $('rv_file').value = ''; // the same file again must fire 'change' again
        });
        $('rv_clip_btn').addEventListener('click', async () => {
            try { loadPgnText(await navigator.clipboard.readText()); }
            catch (e) { note('Could not read the clipboard. Paste into the box instead.', true); }
        });
        $('rv_sample_btn').addEventListener('click', () => loadPgnText(SAMPLE_PGN));
        $('rv_clear_btn').addEventListener('click', () => loadPgnText(''));
        $('rv_fetch_btn').addEventListener('click', async () => {
            const btn = $('rv_fetch_btn');
            btn.disabled = true;
            note('Fetching from chess.com...');
            try { loadPgnText(await fetchChesscom($('rv_user').value)); }
            catch (e) { note(String(e.message || e), true); }
            finally { btn.disabled = false; }
        });

        $('rv_limit_kind').value = cfg('rv_limit_kind');
        $('rv_limit_kind').addEventListener('change', () => {
            setCfg('rv_limit_kind', $('rv_limit_kind').value);
            syncLimitUi();
        });
        bindNumber('rv_limit_value', 'rv_limit_value');
        bindNumber('rv_multipv', 'rv_multipv');
        bindNumber('rv_threads', 'rv_threads');
        bindNumber('rv_hash', 'rv_hash');
        bindNumber('rv_maia3_elo', 'rv_maia3_elo');
        bindSteppers();
        bindHumanUi();

        const book = $('rv_book');
        book.checked = !!cfg('rv_book');
        book.addEventListener('change', () => setCfg('rv_book', book.checked));

        // Probing three native hosts takes up to a second; do it once and re-render the list when it
        // lands rather than making the page wait for it.
        updateEngineOptions();
        $('rv_engine').value = cfg('rv_engine');
        $('rv_engine').addEventListener('change', () => setCfg('rv_engine', $('rv_engine').value));
        syncLimitUi();
        if (!nativeAvailable) {
            const ids = ENGINES.filter(e => e.kind === 'native').map(e => e.id);
            Promise.all(ids.map(id => nativeHostAvailable(id))).then(oks => {
                nativeAvailable = {};
                ids.forEach((id, i) => { nativeAvailable[id] = oks[i]; });
                updateEngineOptions();
            });
        } else {
            updateEngineOptions();
        }

        $('rv_run').addEventListener('click', onRun);
        $('rv_stop').addEventListener('click', () => { cancel = true; note('Stopping after this position...'); });
        $('rv_export').addEventListener('click', () => exportHtml($('rv_export')));
        $('rv_first').addEventListener('click', () => showPly(0));
        $('rv_prev').addEventListener('click', () => showPly(cursor - 1));
        $('rv_next').addEventListener('click', () => showPly(cursor + 1));
        $('rv_last').addEventListener('click', () => showPly(report ? report.positions.length - 1 : 0));
        $('rv_flip').addEventListener('click', () => {
            flipped = !flipped;
            board?.orientation(flipped ? 'black' : 'white');
            showPly(cursor);
        });
        document.removeEventListener('keydown', onKey); // re-injected page: never bind twice
        document.addEventListener('keydown', onKey);

        // Closing or reloading the tab has to stop a search, not orphan it. pagehide rather than
        // beforeunload: it also fires when the tab is discarded or navigated by the browser.
        window.removeEventListener('pagehide', stopOnUnload);
        window.addEventListener('pagehide', stopOnUnload);

        // Coming back to this page after visiting another one: the module survived, the DOM did not.
        if (report) {
            $('rv_pgn').value = report.pgnText || '';
            parsePgnBox();
            renderReport();
        }
    }
}

function stopOnUnload() {
    cancel = true;
    try { activeEngine?.dispose(); } catch (e) { /* already gone */ }
    activeEngine = null;
}

function onKey(e) {
    if (!report) return;
    // optional call: the target is not always an Element (a key dispatched at the document is not)
    if (e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { showPly(cursor - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { showPly(cursor + 1); e.preventDefault(); }
    if (e.key === 'Home') { showPly(0); e.preventDefault(); }
    if (e.key === 'End') { showPly(report.positions.length - 1); e.preventDefault(); }
}

define({
    title: 'Game Review',
    page: new ReviewPage(),
});
