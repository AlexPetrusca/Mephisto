// The engine drivers, shared by Game Review and the Analysis page. Two transports behind one
// interface: `analyse(fen, turn)` resolves to `{lines, depth, nodes}` with every score already
// converted to WHITE-POSITIVE centipawns. Which transport is in use never leaves this file.
//
// It lives here rather than inside the review page because the analysis page needs exactly the same
// thing, and a second copy would drift: the offscreen client-id rule below (one id per engine, or
// the second init silently disposes the first) was learned once and must not be re-learned.
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
    rv_limit_value: 16,      // plies. The time-mode default is TIME_DEFAULT_MS below.
    rv_multipv: 3,
    // Not a literal: 4 is most of a two-core laptop and a quarter of a workstation. The panel
    // and the settings page already share this, so a review uses the same rule.
    get rv_threads() { return MephistoConfig.defaultThreads(); },
    rv_hash: 256,
    rv_human: '',
    rv_maia_band: '1500',
    rv_maia3_elo: 1500,
    rv_book: true,
    rv_human_report: false,
    rv_batch: false,
};

// A game whose clocks and blunders make the whole report show something. Deliberately a famous
// short one: it finishes analysing in seconds even on the small net, so the first thing a new user
// clicks does not take a minute.
// Switching between the two budgets has to move the NUMBER as well: 16 means something as a depth
// and nothing as a millisecond count.
const DEPTH_DEFAULT = 16;
const TIME_DEFAULT_MS = 1000;

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
let batchReports = null;    // every game's report, when a batch was run
// The engine currently searching, if any. Held at module scope for one reason: closing or reloading
// this tab has to shut it down. Nothing else would -- the worker frees a PANEL's engine when its tab
// closes (keyed by tab id) and this client is deliberately not one, so a run abandoned by closing
// the tab would leave a multi-threaded search burning cores with nobody watching it.
let activeEngine = null;

const $ = (id) => document.getElementById(id);

// ---- engine drivers ---------------------------------------------------------------------------
// Two transports, one interface: `analyse(fen)` resolves to `{lines, depth, nodes}` with every score
// already converted to WHITE-POSITIVE centipawns. Which transport is in use never leaves this
// section -- everything below reads `lines[i].cp` and nothing else.

// The WASM engines, over the offscreen document's UCI relay. clientId is a STRING that does not
// parse as a tab id on purpose: the service worker relays engine output to `parseInt(clientId)` and
// must not try to deliver ours to a tab (see background-script.js).
class WasmEngine {
    constructor(name, opts, clientId) {
        this.name = name;
        this.opts = opts;
        // ONE ID PER ENGINE. The offscreen host keys everything on this: a second `init` with the
        // same id DISPOSES the first engine and replaces it, and both listeners then see the
        // survivor's output. That is fine when the two run one after the other, and it was -- until
        // the batch refactor started the analysis engine and the human model together, at which
        // point Maia's init silently killed Stockfish and answered in its place. Every eval after
        // that was a depth-1 human-likelihood score, which reads as a sawtooth on the graph and as
        // a perfect game in the numbers.
        this.clientId = clientId || 'review';
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
        } else {
            // Maia has no threads and no hash -- it is one forward pass -- but it DOES read MultiPV,
            // and without this it answers with a single line. That made the human model look like it
            // had exactly one idea in every position (found on the Analysis page, 2026-08-15: the
            // human column showed one move at 100%). Game Review's human column gets the same fix.
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

    // INFINITE ANALYSIS, the way an analysis board works everywhere: the engine keeps thinking about
    // the position in front of you and the lines deepen while you look at them, until you move on.
    // `onUpdate(lines, depth, nodes)` fires as results improve; `stop()` ends it. Maia has nothing to
    // deepen (one forward pass), so it answers once and reports done.
    startInfinite(fen, turn, onUpdate) {
        const slots = new Map();
        let nodes = 0, depth = 0, stopped = false, timer = null;
        const emit = () => { if (!stopped) onUpdate(this.toResult(slots, turn, depth, nodes)); };
        const collect = (msg) => {
            if (msg.kind !== 'line') return;
            if (/^bestmove\b/.test(msg.line)) { emit(); return; }
            const info = Core.parseInfo(msg.line);
            if (!info || info.bound) return;
            nodes = Math.max(nodes, info.nodes || 0);
            depth = Math.max(depth, info.depth);
            const prev = slots.get(info.multipv);
            if (!prev || info.depth >= prev.depth) slots.set(info.multipv, info);
            // coalesced: an engine emits info far faster than a screen can show it, and rendering
            // every line is how an analysis page becomes unusable at high depth
            if (!timer) timer = setTimeout(() => { timer = null; emit(); }, 180);
        };
        this.listeners.push(collect);
        this.send(`position fen ${fen}`);
        this.send(this.isMaia() ? 'go' : 'go infinite');
        return {
            // STOP MEANS "STOPPED", NOT "ASKED TO STOP". A search that has been told to stop keeps
            // emitting info lines until its `bestmove` arrives, and those lines describe the OLD
            // position -- start the next search before it lands and they are collected as if they
            // were the new one. It showed as an engine line that is illegal in the position on the
            // board (d2d4 after 1.d4). So stop() resolves on bestmove, and the caller awaits it.
            stop: () => {
                if (stopped) return Promise.resolve();
                stopped = true;
                if (timer) { clearTimeout(timer); timer = null; }
                const drop = () => {
                    const i = this.listeners.indexOf(collect);
                    if (i >= 0) this.listeners.splice(i, 1);
                };
                if (this.isMaia()) { drop(); return Promise.resolve(); }
                const done = this.once(m => m.kind === 'line' && /^bestmove\b/.test(m.line), 8000)
                    .catch(() => null)      // an engine that never answers must not wedge the page
                    .then(() => drop());
                this.send('stop');
                return done;
            },
        };
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
                wdl: info.wdl || null,   // permille, side-to-move relative
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
    constructor(name, opts, clientId) {   // clientId is the WASM host's business; a port is its own
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

function makeEngine(id, opts, clientId) {
    const spec = ENGINES.find(e => e.id === id);
    return (spec && spec.kind === 'native')
        ? new NativeEngine(id, opts, clientId) : new WasmEngine(id, opts, clientId);
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


self.MephistoEngines = {
    ENGINES, MAIA_BANDS, WasmEngine, NativeEngine, makeEngine, nativeHostAvailable,
    NATIVE_DEPTH_CAP_MS,
};
