// The Analysis page. The floating panel is built for a live game -- small, out of the way, one
// engine at a time. Studying wants the opposite: a big board you can PLAY on, the moves beside it,
// and both answers at once -- what a human of a chosen rating would play, next to what the engine
// wants. That contrast is the point of the page, which is why the human model is a permanent second
// column rather than a toggle.
//
// Everything expensive is shared rather than rebuilt: the engine drivers come from
// src/options/util/engines.js (the same ones Game Review uses), the arithmetic from review-core.js,
// and the board from panel-board.js.
import {define} from "../../framework/require.js";
import {SettingsPage} from "../../util/SettingsPage.js";
import {readBook as readPolyglot, lookup as lookupPolyglot} from "../../util/polyglot.js";

const Core = self.MephistoReviewCore;
const {ENGINES, MAIA_BANDS, makeEngine, nativeHostAvailable} = self.MephistoEngines;

const $ = (id) => document.getElementById(id);

// Its own settings: an analysis runs on different numbers from live play, and sharing one set would
// silently make the other wrong. There is no DEPTH here on purpose -- the budget is a time, and its
// last notch is no budget at all.
const CFG = {
    an_engine: 'stockfish-18-nnue',
    an_human: 'maia',
    an_band: '1500',
    an_lines: 4,
    an_threads: 1,
    an_hash: 128,
    an_wdl: true,
    an_book: true,
    an_time: 61,          // AN_INFINITE: the page's old behaviour is still the default
};

// The search-time slider: 1..60 seconds, and one notch past 60 that means `go infinite` -- the same
// shape as Game Review's budget, because it is the same question.
const AN_INFINITE = 61;

function cfg(key) {
    const raw = MephistoConfig.get(key);
    if (raw == null || raw === '') return CFG[key];
    try {
        const v = JSON.parse(raw);
        return (v === null || v === undefined) ? CFG[key] : v;
    } catch (e) { return CFG[key]; }
}
function setCfg(key, value) { MephistoConfig.set(key, JSON.stringify(value)); }

// ---- state --------------------------------------------------------------------------------------

let board = null, flipped = false;
let positions = [];      // [{fen, turn, san, uci}] -- index 0 is the start position
let cursor = 0;
let engine = null;       // the analysis engine
let human = null;        // the human model, started and stopped INDEPENDENTLY of the engine
let humanKey = null;     // which model+band is loaded, so a switch only reloads that one
let liveSearch = null;
let evalCache = new Map();
let humanCache = new Map();
let bandCache = new Map();
let bookMoves = null;    // {name, entries: Map(positionKey -> [{uci, weight}])}
let boardResizeObs = null;
let searchTimer = null;  // the budget's stopwatch; null whenever the budget is the infinite notch

// ---- page ---------------------------------------------------------------------------------------

class AnalysisPage extends SettingsPage {
    init() {
        fillSelects();
        this.registerFormElement('an_engine', 'Engine:', 'select', CFG.an_engine);
        this.registerFormElement('an_human', 'Human model:', 'select', CFG.an_human);
        this.registerFormElement('an_band', 'Rating:', 'select', CFG.an_band);
        this.registerFormElement('an_lines', 'Lines:', 'input', CFG.an_lines);
        this.registerFormElement('an_threads', 'Threads:', 'input', CFG.an_threads);
        this.registerFormElement('an_hash', 'Hash:', 'input', CFG.an_hash);
        this.registerFormElement('an_wdl', 'Win / draw / loss:', 'checkbox', CFG.an_wdl);
        this.registerFormElement('an_book', 'Opening book:', 'checkbox', CFG.an_book);
        this.registerFormElement('an_time', 'Search time:', 'range', CFG.an_time);

        // THE TWO ENGINES ARE INDEPENDENT (user report 2026-08-15): switching the human model used
        // to drop the whole rig, which threw away the analysis you were looking at and started it
        // again from depth 1. Only the model that changed is reloaded now.
        $('an_human_select')?.addEventListener('change', () => { syncBandRow(); reloadHuman(); });
        $('an_band_select')?.addEventListener('change', () => reloadHuman());
        $('an_engine_select')?.addEventListener('change', () => reloadEngine());
        for (const id of ['an_lines_input', 'an_threads_input', 'an_hash_input'])
            $(id)?.addEventListener('change', () => reloadEngine());
        $('an_wdl_checkbox')?.addEventListener('change', () => reloadEngine());
        $('an_book_checkbox')?.addEventListener('change', () => renderBook());
        // The budget needs no engine reload -- it is spent by THIS page, not sent as a UCI option.
        // Dragging only re-reads the number; letting go restarts the search on the new budget.
        $('an_time_range')?.addEventListener('input', () => syncTimeUi());
        $('an_time_range')?.addEventListener('change', () => { syncTimeUi(); go(cursor); });

        $('an_load')?.addEventListener('click', () => loadFromInput());
        $('an_start')?.addEventListener('click', () => { $('an_pgn').value = ''; loadStart(); });
        $('an_paste')?.addEventListener('click', pasteFromClipboard);
        $('an_book_btn')?.addEventListener('click', () => $('an_book_file')?.click());
        $('an_book_file')?.addEventListener('change', onBookFile);
        $('an_first')?.addEventListener('click', () => go(0));
        $('an_prev')?.addEventListener('click', () => go(cursor - 1));
        $('an_next')?.addEventListener('click', () => go(cursor + 1));
        $('an_last')?.addEventListener('click', () => go(positions.length - 1));
        $('an_flip')?.addEventListener('click', () => { flipped = !flipped; buildBoard(); render(); });
        $('an_copy_fen')?.addEventListener('click', () => copyOut(positions[cursor]?.fen || '', 'FEN'));
        $('an_copy_pgn')?.addEventListener('click', () => copyOut(pgnText(), 'PGN'));
        document.addEventListener('keydown', onKey);
        // The page loader has no onLeave hook, so the route is the teardown signal: the moment the
        // hash is not ours, stop searching and free both engines.
        const onRoute = () => {
            if (location.hash.startsWith('#analysis')) return;
            teardown();
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('hashchange', onRoute);
        };
        window.addEventListener('hashchange', onRoute);
        syncBandRow();
        syncTimeUi();
        loadStart();
        watchBoardSize();
        requestAnimationFrame(() => { buildBoard(); render(); });
    }
}

function onKey(e) {
    if (!$('an_board') || /input|textarea|select/i.test(e.target?.tagName || '')) return;
    if (e.key === 'ArrowLeft') { go(cursor - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { go(cursor + 1); e.preventDefault(); }
}

function fillSelects() {
    const es = $('an_engine_select');
    if (es && !es.options.length) {
        es.innerHTML = ENGINES.map(e => `<option value="${e.id}">${e.label}</option>`).join('');
        for (const e of ENGINES.filter(x => x.kind === 'native')) {
            nativeHostAvailable(e.id).then(ok => {
                const opt = [...es.options].find(o => o.value === e.id);
                if (opt && !ok) { opt.disabled = true; opt.text = `${e.label} (not installed)`; }
            });
        }
    }
    const hs = $('an_human_select');
    if (hs && !hs.options.length) {
        hs.innerHTML = '<option value="maia">Maia 1</option><option value="maia3">Maia 3</option>'
                     + '<option value="">Off</option>';
    }
    const bs = $('an_band_select');
    if (bs && !bs.options.length) bs.innerHTML = bandChoices().map(b => `<option value="${b}">${b}</option>`).join('');
}

// Maia 3 is one net with a rating dial, so it offers the whole range in 100s; Maia 1 offers the
// bands it actually ships as nets.
function bandChoices() {
    return cfg('an_human') === 'maia3'
        ? Array.from({length: 21}, (_, i) => String(600 + i * 100))
        : MAIA_BANDS.slice();
}

// The readout under the slider says what the notch MEANS, not what number it is. The last one is
// the honest sentence for it: the search has no budget and ends when the position does.
function syncTimeUi() {
    const slider = $('an_time_range'), out = $('an_time_unit');
    if (!slider) return;
    const secs = Math.max(1, Math.min(AN_INFINITE, +slider.value || AN_INFINITE));
    if (out) out.textContent = secs >= AN_INFINITE ? 'no limit — until you move on' : `${secs}s per position`;
    slider.style.setProperty('--fill', `${((secs - 1) / (AN_INFINITE - 1)) * 100}%`);
}

function syncBandRow() {
    const row = $('an_band_row'), bs = $('an_band_select');
    if (!row || !bs) return;
    row.style.display = cfg('an_human') ? '' : 'none';
    const want = bandChoices();
    if ([...bs.options].map(o => o.value).join() !== want.join()) {
        const keep = bs.value;
        bs.innerHTML = want.map(b => `<option value="${b}">${b}</option>`).join('');
        bs.value = want.includes(keep) ? keep : '1500';
        setCfg('an_band', bs.value);
    }
}

// ---- loading ------------------------------------------------------------------------------------

function status(text, kind) {
    const el = $('an_status');
    if (!el) return;
    el.textContent = text;
    el.className = 'an-status' + (kind ? ` an-${kind}` : '');
}

function loadStart() {
    positions = [{fen: new Chess('chess').fen(), turn: 'w', san: null, uci: null}];
    cursor = 0;
    evalCache.clear(); humanCache.clear(); bandCache.clear();
    buildBoard();
    renderMoves();
    status('');
    go(0);
}

// One box takes either: a FEN is placement data followed by a side to move, anything else is a game.
function loadFromInput() {
    const text = ($('an_pgn')?.value || '').trim();
    if (!text) return loadStart();
    try {
        if (/^[rnbqkpRNBQKP1-8/]+\s+[wb]\s/.test(text)) {
            const parts = text.split(/\s+/);
            // chess.js does NOT reliably throw on junk, so the shape is checked before it is handed over
            if ((parts[0] || '').split('/').length !== 8 || parts.length < 4) {
                throw new Error('that does not look like a FEN');
            }
            const c = new Chess('chess', text);
            positions = [{fen: c.fen(), turn: c.turn(), san: null, uci: null}];
            status('Position loaded.');
        } else {
            const game = Core.parsePgn(text)[0];
            if (!game) throw new Error('no game found in that text');
            const c = new Chess('chess', game.startFen || undefined);
            positions = [{fen: c.fen(), turn: c.turn(), san: null, uci: null}];
            for (const rec of game.moves) {
                const san = typeof rec === 'string' ? rec : rec.san;
                const mv = c.move(san);
                if (!mv) throw new Error(`illegal move in the PGN: ${san}`);
                positions.push({fen: c.fen(), turn: c.turn(), san: mv.san,
                                uci: mv.from + mv.to + (mv.promotion || '')});
            }
            // the parser is lenient by design, so say what it understood rather than loading a
            // half-copied game silently
            const n = positions.length - 1;
            status(n === 0 ? 'No moves were understood in that text.'
                 : n < 3 ? `Only ${n} move${n === 1 ? '' : 's'} understood -- check the text.`
                 : `Loaded ${n} moves.`, n === 0 ? 'err' : undefined);
        }
    } catch (e) {
        return status(String(e.message || e), 'err');
    }
    cursor = 0;
    evalCache.clear(); humanCache.clear(); bandCache.clear();
    buildBoard();
    renderMoves();
    go(0);
}

// The line as it stands, ready to paste somewhere else. A line that did not start from the initial
// position carries the FEN tags, or it is not the same game when it is read back.
function pgnText() {
    const start = positions[0]?.fen;
    const body = [];
    for (let i = 1; i < positions.length; i++) {
        if (i % 2 === 1) body.push(`${Math.ceil(i / 2)}.`);
        body.push(positions[i].san || '');
    }
    const tags = (start && start !== new Chess('chess').fen())
        ? `[SetUp "1"]\n[FEN "${start}"]\n\n` : '';
    return (tags + body.join(' ')).trim();
}

async function copyOut(text, what) {
    if (!text) return status(`There is no ${what} to copy yet.`, 'err');
    try {
        await navigator.clipboard.writeText(text);
        status(`${what} copied.`);
    } catch (e) { status(`Could not copy the ${what}: ${e.message || e}`, 'err'); }
}

async function pasteFromClipboard() {
    try {
        const text = (await navigator.clipboard.readText() || '').trim();
        if (!text) return status('The clipboard is empty.', 'err');
        $('an_pgn').value = text;
        loadFromInput();
    } catch (e) { status('Could not read the clipboard: ' + (e.message || e), 'err'); }
}

// ---- the engines --------------------------------------------------------------------------------

function engineOpts() {
    return {
        variant: 'chess',
        limitKind: 'depth',      // only the NATIVE path uses this; WASM runs `go infinite`
        limitValue: 22,
        multipv: Math.max(1, +cfg('an_lines')),
        threads: Math.max(1, +cfg('an_threads')),
        hash: Math.max(16, +cfg('an_hash')),
    };
}

// ONE ENGINE, EVEN WHEN TWO CALLERS ASK AT ONCE (user report 2026-08-15: "it breaks and cannot
// search after a single move, sometimes"). The check-then-await here was re-entrant: loading the
// first engine takes seconds, and a move played inside that window ran the whole function a second
// time, so TWO engines were built. Whichever finished last became `engine`; the other one was left
// searching with nothing pointing at it -- unstoppable, undisposable, and still feeding the old
// position's lines into the live callback, which is why the page showed a depth but never a move.
// Serialising the builder is the whole fix: the second caller waits and gets the first one's engine.
let engineChain = Promise.resolve();
function ensureEngine() {
    engineChain = engineChain.then(buildEngine, buildEngine);
    return engineChain;
}
async function buildEngine() {
    if (engine) return engine;
    const e = makeEngine(cfg('an_engine'), engineOpts(), 'analysis');
    await e.start();
    if (cfg('an_wdl')) e.send?.('setoption name UCI_ShowWDL value true');
    engine = e;
    return engine;
}

// Same shape, same reason: humanFor() is called without being awaited, so two of them overlap freely.
let humanChain = Promise.resolve();
function ensureHuman() {
    humanChain = humanChain.then(buildHuman, buildHuman);
    return humanChain;
}
async function buildHuman() {
    const kind = cfg('an_human');
    if (!kind) return null;
    const band = String(cfg('an_band') || CFG.an_band);
    const key = `${kind}|${band}`;
    if (human && humanKey === key) return human;
    if (human) { try { human.dispose?.(); } catch (e) { /* */ } human = null; }
    const h = makeEngine(kind, {...engineOpts(), multipv: 5, maiaLevel: band}, 'analysis-human');
    await h.start();
    human = h;
    humanKey = key;
    return human;
}

// Reload ONLY the analysis engine; the human model and its answers survive. The stop and the dispose
// go through the SAME queue as the searches: dropping an engine out of band could land between an
// analysis stopping the old search and starting the new one, which is the same wedge from the other
// side. (This runs more often than it looks: populating the form dispatches a change event per
// control, and four of those controls reload the engine.)
function reloadEngine() {
    evalCache.clear();
    analyseChain = analyseChain.then(async () => {
        await stopSearch();
        if (engine) { try { engine.dispose?.(); } catch (e) { /* */ } engine = null; }
    }, () => {});
    go(cursor);
}

// Reload ONLY the human model; the engine keeps thinking about the position it is on.
async function reloadHuman() {
    syncBandRow();
    humanCache.clear();
    bandCache.clear();
    if (human) { try { human.dispose?.(); } catch (e) { /* */ } human = null; humanKey = null; }
    const pos = positions[cursor];
    if (!pos) return;
    renderHumanLines(pos, null);
    try {
        const h = await ensureHuman();
        if (!h) return renderHumanLines(pos, null);
        await humanFor(pos);
        render();
        renderBands(pos);
    } catch (e) { status(`Human model unavailable (${e.message || e})`, 'err'); }
}

function teardown() {
    stopSearch();
    if (engine) { try { engine.dispose?.(); } catch (e) { /* */ } engine = null; }
    if (human) { try { human.dispose?.(); } catch (e) { /* */ } human = null; humanKey = null; }
    boardResizeObs?.disconnect();
    boardResizeObs = null;
}

// Returns a promise: the next search must not start until this one has really finished, or its
// trailing info lines are read as the new position's (see startInfinite).
function stopSearch() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    if (!liveSearch) return Promise.resolve();
    const s = liveSearch;
    liveSearch = null;
    try { return Promise.resolve(s.stop()); } catch (e) { return Promise.resolve(); }
}

// ---- stepping and analysing ---------------------------------------------------------------------

function go(ply) {
    if (!positions.length) return;
    cursor = Core.clamp(ply, 0, positions.length - 1);
    render();
    analyseCurrent();
}

// ONE ANALYSIS AT A TIME. This is the whole of the "it cannot search after a move, sometimes" bug
// (user report 2026-08-15), and it is not about engines: it is about SEARCHES on one engine.
// analyseCurrent awaits before it starts anything, so two calls could both get past `await
// stopSearch()` -- the second sees liveSearch still null, because the first has not assigned it yet
// -- and both then call startInfinite on the same engine. The engine is already searching, so it
// IGNORES the second `position fen` (UCI: you must stop first), keeps thinking about the old
// position, and streams those lines into the new callback. Every one of them is illegal on the board
// in front of you, so the column filters them all out and says "thinking..." while the depth counter
// climbs happily -- 24, 27, 29, never restarting from 1, which is what gave it away.
// Serialising them means the second call really does stop the first search before starting its own.
let analyseChain = Promise.resolve();
function analyseCurrent() {
    analyseChain = analyseChain.then(analyseNow, analyseNow);
    return analyseChain;
}

async function analyseNow() {
    const at = cursor;
    const pos = positions[at];
    if (!pos) return;
    const meta = $('an_engine_meta');
    if (meta) meta.textContent = 'thinking…';
    await stopSearch();                 // the previous search must be finished, not merely told to stop
    let e;
    try { e = await ensureEngine(); } catch (err) { return status(String(err.message || err), 'err'); }
    // The POSITION, not just the index: playing a move truncates the line, so the same cursor value
    // can mean a different board a moment later and an index check would let the old search's lines
    // through as if they described this one.
    if (cursor !== at || positions[at]?.fen !== pos.fen) return;
    const secs = +cfg('an_time');
    const search = e.startInfinite(pos.fen, pos.turn, (res) => {
        if (cursor !== at || positions[at]?.fen !== pos.fen) return;
        evalCache.set(pos.fen, res);
        renderEval(pos, res);
        renderEngineLines(pos, res);
        renderArrows(pos, res, humanCache.get(humanCacheKey(pos.fen)));
        const m = $('an_engine_meta');
        if (m) m.textContent = `depth ${res.depth}${res.nodes ? ` · ${(res.nodes / 1000).toFixed(0)}k` : ''}`;
    });
    liveSearch = search;
    // THE BUDGET IS A CHOICE (user call 2026-08-15). The last notch means the search runs until the
    // position changes, the way an analysis board always did; every other notch stops it after that
    // many seconds. `stop` rather than `go movetime` on purpose: it is the one search path, so the
    // streaming and the drain-before-the-next-position both stay exactly as they are.
    if (secs < AN_INFINITE) {
        searchTimer = setTimeout(() => {
            searchTimer = null;
            if (liveSearch !== search) return;
            stopSearch().then(() => {
                if (cursor !== at || positions[at]?.fen !== pos.fen) return;
                const m = $('an_engine_meta');
                if (m && !/done/.test(m.textContent)) m.textContent += ` · done (${secs}s)`;
            });
        }, secs * 1000);
    }
    humanFor(pos).then(() => { if (cursor === at) render(); }).catch(() => {});
    renderBands(pos);
    renderBook();
}

function humanCacheKey(fen) { return `${fen}|${cfg('an_human')}|${cfg('an_band')}`; }

async function humanFor(pos) {
    const key = humanCacheKey(pos.fen);
    if (humanCache.has(key)) return humanCache.get(key);
    const h = await ensureHuman();
    if (!h) return null;
    const res = await h.analyse(pos.fen, pos.turn);
    // THE NET'S OWN PROBABILITY, not a guess from the rank. This column used to derive its
    // percentages from the move ORDER with a fixed decay, so it printed 60.0 / 24.4 / 9.9 for every
    // position and every rating -- numbers that looked like output and carried no information. Maia
    // emits the real softmax over the legal moves now (`maiaprob`); the decay survives only as a
    // fallback for an older adapter that does not send it.
    const raw = (res.lines || []).filter(l => l.pv?.[0]);
    // A real probability is NOT renormalised over the few lines shown: it is the net's chance of
    // playing that move out of EVERY legal move, so the visible ones summing to 95% is the truth
    // and scaling them to 100% would be a different, wrong claim. Only the fallback is normalised.
    const real = raw.every(l => l.prob != null);
    const w = raw.map((l, i) => real ? l.prob : Math.max(0.0001, Math.exp(-i * 0.9)));
    const total = real ? 1 : (w.reduce((a, b) => a + b, 0) || 1);
    const out = raw.map((l, i) => ({uci: l.pv[0], prob: w[i] / total}));
    humanCache.set(key, out);
    return out;
}

// ---- playing on the board -----------------------------------------------------------------------

// A move played on the board (click or drag) TRUNCATES the line and continues from here: an
// analysis board is for asking "what if", so the answer is a new continuation, not a refusal.
function playMove(from, to, promotion) {
    const pos = positions[cursor];
    if (!pos) return false;
    try {
        const c = new Chess('chess', pos.fen);
        const mv = c.move({from, to, promotion: promotion || 'q'});
        if (!mv) return false;
        positions = positions.slice(0, cursor + 1);
        positions.push({fen: c.fen(), turn: c.turn(), san: mv.san,
                        uci: mv.from + mv.to + (mv.promotion || '')});
    } catch (e) { return false; }
    renderMoves();
    go(cursor + 1);
    return true;
}

function panelPromotes(from, to) {
    try {
        const c = new Chess('chess', positions[cursor].fen);
        const piece = c.get(from);
        if (!piece || piece.type !== 'p') return null;
        return (piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1') ? piece.color : null;
    } catch (e) { return null; }
}

function legalTargets(from) {
    try {
        return new Chess('chess', positions[cursor].fen).moves({square: from, verbose: true}).map(m => m.to);
    } catch (e) { return []; }
}

// ---- rendering ----------------------------------------------------------------------------------

function watchBoardSize() {
    if (boardResizeObs || typeof ResizeObserver === 'undefined') return;
    const wrap = document.querySelector('.an-board-wrap');
    if (!wrap) return;
    let last = Math.round(wrap.getBoundingClientRect().width);
    boardResizeObs = new ResizeObserver(() => {
        const w = Math.round(wrap.getBoundingClientRect().width);
        if (!w || Math.abs(w - last) < 3) return;
        last = w;
        buildBoard();
        render();
    });
    boardResizeObs.observe(wrap);
}

// The renderer sizes itself from its host at build time, so it is rebuilt rather than resized.
function buildBoard() {
    const host = $('an_board');
    if (!host) return;
    host.innerHTML = '';
    let set = 'wikipedia', ext = 'svg';
    try {
        const raw = MephistoConfig.get('pieces');
        if (raw) [set, ext] = String(JSON.parse(raw) || 'wikipedia.svg').split('.');
    } catch (e) { /* defaults */ }
    board = MephistoBoard(host, {
        position: positions[cursor]?.fen || 'start',
        pieceTheme: `/res/chesspieces/${set}/{piece}.${ext}`,
        showNotation: true,
        orientation: flipped ? 'black' : 'white',
        onMove: playMove,               // the board is PLAYABLE
        needsPromotion: panelPromotes,
        legalTargets,
    });
}

function render() {
    const pos = positions[cursor];
    if (!pos) return;
    if (!board) buildBoard();
    board?.position(pos.fen);
    const ev = evalCache.get(pos.fen);
    const hum = humanCache.get(humanCacheKey(pos.fen));
    renderEval(pos, ev);
    renderEngineLines(pos, ev);
    renderHumanLines(pos, hum);
    renderArrows(pos, ev, hum);
    renderBook();
    highlightMove();
}

function renderEval(pos, ev) {
    const top = (ev?.lines || []).find(l => legalHere(pos.fen, l.pv?.[0]));
    const cp = top?.cp;
    const fill = $('an_evalfill'), label = $('an_evallabel');
    const pct = cp == null ? 50 : Core.clamp(50 + 50 * Math.tanh(cp / 400), 2, 98);
    if (fill) fill.style.height = `${pct}%`;
    if (label) {
        label.textContent = cp == null ? '' : (Core.isMateScore(cp) ? (cp > 0 ? 'M' : '-M') : (cp / 100).toFixed(1));
        // the number rides the filled side of the bar so it is always readable
        label.classList.toggle('an-num-top', pct < 50);
    }
    const wdlEl = $('an_wdl_line');
    if (wdlEl) {
        const wdl = top?.wdl;
        if (!cfg('an_wdl') || !wdl) wdlEl.innerHTML = '';
        else {
            // permille and side-to-move relative -> shown white-first, which is how it is read. Three
            // bare percentages in a row read as one number soup, so each one is named and coloured
            // the way the board is: white wins, draw, black wins.
            const [w, d, l] = pos.turn === 'w' ? wdl : [wdl[2], wdl[1], wdl[0]];
            wdlEl.innerHTML =
                `<span class="an-wdl-seg an-wdl-w">White ${(w / 10).toFixed(1)}%</span>`
              + `<span class="an-wdl-seg an-wdl-d">Draw ${(d / 10).toFixed(1)}%</span>`
              + `<span class="an-wdl-seg an-wdl-b">Black ${(l / 10).toFixed(1)}%</span>`;
        }
    }
}

const RANK_COLOURS = ['#3fa45b', '#5c8bb0', '#a88865', '#8f8f8f', '#7f8b95'];

function lineRow(i, colour, move, pv, value, barPct, uci) {
    return `<div class="an-lrow ${i === 0 ? 'an-top' : ''}" style="--an-rank:${colour}" data-uci="${esc(uci)}" title="Click to play ${esc(move)}">
        <span class="an-lrank">${i + 1}</span>
        <span class="an-lmove">${esc(move)}${pv ? ` <span class="an-lpv">${esc(pv)}</span>` : ''}</span>
        <span class="an-lval">${esc(value)}</span>
        <span class="an-lbar"><i style="width:${barPct}%"></i></span>
    </div>`;
}

// clicking a line plays it, which is the fastest way to walk a variation
function wireLineClicks(host) {
    host?.querySelectorAll('.an-lrow[data-uci]').forEach(row => {
        const uci = row.dataset.uci;
        if (!uci) return;
        row.addEventListener('click', () => playMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]));
    });
}

// A line whose first move is not legal HERE belongs to another position: the engine keeps emitting
// for a moment after it is told to stop, and on a long search that tail can outlive the switch. The
// await in analyseCurrent closes most of the window; this closes it completely, because a move that
// cannot be played in the position on screen must never be shown as a recommendation.
function legalHere(fen, uci) {
    if (!uci) return false;
    try {
        return !!new Chess('chess', fen).move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
    } catch (e) { return false; }
}

function renderEngineLines(pos, ev) {
    const host = $('an_engine_lines');
    if (!host) return;
    const lines = (ev?.lines || []).filter(l => legalHere(pos.fen, l.pv?.[0]))
        .slice(0, Math.max(1, +cfg('an_lines')));
    host.innerHTML = lines.length ? lines.map((l, i) => {
        const cp = l.cp * (pos.turn === 'w' ? 1 : -1);
        const val = Core.isMateScore(l.cp) ? (cp > 0 ? '#' : '-#') : (cp / 100).toFixed(2);
        const pct = Core.clamp(Core.winPercent(l.cp * (pos.turn === 'w' ? 1 : -1)), 2, 100);
        return lineRow(i, RANK_COLOURS[Math.min(i, 4)], sanOf(pos.fen, l.pv?.[0]),
                       pvText(pos.fen, l.pv, 4), val, pct, l.pv?.[0] || '');
    }).join('') : '<div class="an-lrow"><span></span><span class="an-lval">thinking…</span><span></span></div>';
    wireLineClicks(host);
}

function renderHumanLines(pos, hum) {
    const host = $('an_human_lines');
    if (!host) return;
    const title = $('an_human_title');
    const kind = cfg('an_human');
    if (title) title.textContent = kind ? `Human ${cfg('an_band')}` : 'Human model off';
    host.innerHTML = (hum && hum.length) ? hum.map((h, i) =>
        lineRow(i, '#a8657f', sanOf(pos.fen, h.uci), '', `${(h.prob * 100).toFixed(1)}%`,
                Core.clamp(h.prob * 100, 2, 100), h.uci)).join('')
        : `<div class="an-lrow"><span></span><span class="an-lval">${kind ? 'thinking…' : 'off'}</span><span></span></div>`;
    wireLineClicks(host);
}

function renderArrows(pos, ev, hum) {
    const svg = $('an_arrows');
    if (!svg) return;
    const inner = $('an_board')?.querySelector('.board-b72b1');
    if (inner) {
        svg.style.left = `${inner.offsetLeft + 2}px`;
        svg.style.top = `${inner.offsetTop + 2}px`;
        svg.style.width = `${inner.clientWidth}px`;
        svg.style.height = `${inner.clientHeight}px`;
    }
    const out = [];
    (ev?.lines || []).filter(l => legalHere(pos.fen, l.pv?.[0]))
        .slice(0, Math.max(1, +cfg('an_lines'))).forEach((l, i) => {
        if (!l.pv?.[0]) return;
        out.push(arrow(l.pv[0], RANK_COLOURS[Math.min(i, 4)], Math.max(0.08, 0.15 - i * 0.02),
                       Math.max(0.35, 0.85 - i * 0.15), i + 1));
    });
    if (hum?.[0]) out.push(arrow(hum[0].uci, '#a8657f', 0.12, 0.8, null));
    svg.innerHTML = out.filter(Boolean).join('');
}

function arrow(uci, colour, width, opacity, rank) {
    const m = /^([a-h][1-8])([a-h][1-8])/.exec(uci || '');
    if (!m) return '';
    const sq = (t) => {
        const f = t.charCodeAt(0) - 97, r = +t[1];
        return flipped ? {x: 7.5 - f, y: r - 0.5} : {x: f + 0.5, y: 8.5 - r};
    };
    const a = sq(m[1]), b = sq(m[2]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const head = 0.30;
    const ex = b.x - ux * 0.10, ey = b.y - uy * 0.10;
    const sx = a.x + ux * 0.24, sy = a.y + uy * 0.24;
    const bx = ex - ux * head, by = ey - uy * head;
    const nx = -uy, ny = ux;
    const wing = head * 0.62;
    const pts = [`${ex},${ey}`, `${bx + nx * wing},${by + ny * wing}`, `${bx - nx * wing},${by - ny * wing}`].join(' ');
    let tag = '';
    if (rank) {
        // THE NUMBER SITS AT THE HEAD (user report 2026-08-15): at the start it lands under the
        // piece that is about to move and cannot be read. Beside the tip it is on empty board.
        const px = Core.clamp(b.x + ux * 0.16 - uy * 0.24, 0.2, 7.8);
        const py = Core.clamp(b.y + uy * 0.16 + ux * 0.24, 0.2, 7.8);
        tag = `<circle cx="${px}" cy="${py}" r="0.19" fill="${colour}" stroke="#00000055" stroke-width="0.02"/>`
            + `<text x="${px}" y="${py + 0.072}" font-size="0.24" font-weight="700" text-anchor="middle" `
            + `fill="#fff" font-family="system-ui,sans-serif">${rank}</text>`;
    }
    return `<g opacity="${opacity}" stroke-linejoin="round">`
        + `<line x1="${sx}" y1="${sy}" x2="${bx}" y2="${by}" stroke="${colour}" stroke-width="${width}" stroke-linecap="round"/>`
        + `<polygon points="${pts}" fill="${colour}"/>${tag}</g>`;
}

// ---- moves by rating ----------------------------------------------------------------------------
// ONE chart, not a row per move (user report 2026-08-15: "i cant tell what is what"). Every move is
// a line in the same axes, so they can actually be compared; each line is NAMED at its own right-hand
// end in its own colour, the y axis is labelled as what it is (how often the move is played), and the
// number that used to sit at the right -- the band a move peaks in -- moved into the legend, where it
// cannot be misread as a second rating.
let bandRun = 0;

// One green per move, darkest first, so the ranking is legible before a single label is read.
const BAND_COLOURS = ['#4aa563', '#6cbf85', '#93d5a4', '#b9e5c4', '#dcf1e0'];
const BAND_GEO = {X0: 46, X1: 300, Y0: 26, Y1: 152, W: 340, H: 178};

function bandSeries(pos, steps, acc, moves) {
    return moves.map((uci, mi) => {
        const ys = steps.map(b => ((acc[b] || []).find(x => x.uci === uci)?.prob || 0));
        return {uci, san: sanOf(pos.fen, uci), colour: BAND_COLOURS[mi % BAND_COLOURS.length], ys,
                peak: ys.indexOf(Math.max(...ys)), top: Math.max(...ys)};
    }).filter(s => s.top > 0);
}

function bandsChart(steps, series) {
    const {X0, X1, Y0, Y1, W, H} = BAND_GEO;
    const xOf = (i) => X0 + (i / Math.max(1, steps.length - 1)) * (X1 - X0);
    const yOf = (p) => Y1 - Core.clamp(p, 0, 1) * (Y1 - Y0);

    // two lines ending at the same height would print their names on top of each other
    const labels = series.map((s, i) => ({i, y: yOf(s.ys[s.ys.length - 1])})).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
        if (labels[i].y - labels[i - 1].y < 9) labels[i].y = labels[i - 1].y + 9;
    }
    const labelY = new Map(labels.map(l => [l.i, l.y]));

    const rows = [0, 0.25, 0.5, 0.75, 1].map(p =>
        `<line x1="${X0}" y1="${yOf(p)}" x2="${X1}" y2="${yOf(p)}" stroke="currentColor" stroke-opacity=".14"
               stroke-width="1" stroke-dasharray="3 3"/>`
      + `<text x="${X0 - 6}" y="${yOf(p) + 3}" font-size="8.5" text-anchor="end" fill="currentColor"
              fill-opacity=".55">${p * 100}%</text>`).join('');

    // at most six band labels, whatever the model's step count is (10 for Maia 1, 21 for Maia 3)
    const every = Math.max(1, Math.round((steps.length - 1) / 5));
    const cols = steps.map((b, i) => (i % every === 0 || i === steps.length - 1) ? i : -1).filter(i => i >= 0)
        .map(i => `<line x1="${xOf(i)}" y1="${Y0}" x2="${xOf(i)}" y2="${Y1}" stroke="currentColor"
                         stroke-opacity=".10" stroke-width="1" stroke-dasharray="3 3"/>`
                + `<text x="${xOf(i)}" y="${Y1 + 13}" font-size="8.5" text-anchor="middle" fill="currentColor"
                        fill-opacity=".55">${steps[i]}</text>`).join('');

    // the leader's area, as a haze rather than a block: it says which move owns the chart without
    // hiding the lines underneath it
    const lead = series[0];
    const area = lead
        ? `<path d="M ${xOf(0)},${Y1} ` + lead.ys.map((p, i) => `L ${xOf(i)},${yOf(p)}`).join(' ')
          + ` L ${xOf(lead.ys.length - 1)},${Y1} Z" fill="url(#anBandFade)"/>`
        : '';

    const lines = series.map((s, i) =>
        `<polyline points="${s.ys.map((p, xi) => `${xOf(xi)},${yOf(p)}`).join(' ')}" fill="none"
                   stroke="${s.colour}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"
                   vector-effect="non-scaling-stroke"/>`
      + s.ys.map((p, xi) => `<circle cx="${xOf(xi)}" cy="${yOf(p)}" r="1.9" fill="${s.colour}"/>`).join('')
      + `<text x="${X1 + 5}" y="${labelY.get(i) + 3}" font-size="9.5" font-weight="600"
              fill="${s.colour}">${esc(s.san)}</text>`).join('');

    // the key sits above the plot, in reading order, so the colours are known before the lines are
    const key = series.map((s, i) =>
        `<text x="${X1 - (series.length - 1 - i) * 30}" y="${Y0 - 9}" font-size="9.5" font-weight="600"
               text-anchor="end" fill="${s.colour}">${esc(s.san)}</text>`).join('');

    return `<svg class="an-band-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
                 aria-label="How likely a human of each rating is to play each move">
        <defs><linearGradient id="anBandFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${lead ? lead.colour : '#4aa563'}" stop-opacity=".22"/>
            <stop offset="100%" stop-color="${lead ? lead.colour : '#4aa563'}" stop-opacity="0"/>
        </linearGradient></defs>
        <text x="13" y="${(Y0 + Y1) / 2}" font-size="9.5" font-weight="600" fill="#e08a7a" text-anchor="middle"
              transform="rotate(-90 13 ${(Y0 + Y1) / 2})">Maia probability</text>
        ${rows}${cols}${key}${area}${lines}
        <g class="an-band-cursor" style="display:none">
            <line y1="${Y0}" y2="${Y1}" stroke="currentColor" stroke-opacity=".45" stroke-width="1"/>
        </g>
        <rect class="an-hit" x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}"/>
    </svg><div class="an-band-tip"></div>`;
}

// The readout follows the pointer: which band it is over, and what every move is worth there. Done
// after the markup is written rather than inline, because it needs the real pixel box of the SVG.
function wireBandsHover(host, steps, series) {
    const svg = host.querySelector('.an-band-svg'), tip = host.querySelector('.an-band-tip');
    const hit = host.querySelector('.an-hit'), cursor = host.querySelector('.an-band-cursor');
    if (!svg || !tip || !hit) return;
    const {X0, X1, Y0, Y1} = BAND_GEO;
    const xOf = (i) => X0 + (i / Math.max(1, steps.length - 1)) * (X1 - X0);
    const yOf = (p) => Y1 - Core.clamp(p, 0, 1) * (Y1 - Y0);

    const move = (ev) => {
        const box = svg.getBoundingClientRect();
        const scale = box.width / svg.viewBox.baseVal.width;
        const ux = (ev.clientX - box.left) / scale;                       // pointer in SVG units
        const i = Core.clamp(Math.round((ux - X0) / ((X1 - X0) / Math.max(1, steps.length - 1))),
                             0, steps.length - 1);
        cursor.style.display = '';
        cursor.querySelector('line').setAttribute('x1', xOf(i));
        cursor.querySelector('line').setAttribute('x2', xOf(i));
        tip.innerHTML = `<h6>${esc(steps[i])}</h6>` + series.map(s =>
            `<div><span style="color:${s.colour}">${esc(s.san)}</span>`
          + `<b style="color:${s.colour}">${(s.ys[i] * 100).toFixed(1)}%</b></div>`).join('');
        tip.classList.add('on');
        // kept inside the chart: past the middle it flips to the other side of the cursor
        const px = (xOf(i) - X0) / (X1 - X0);
        tip.style.left = px > 0.55 ? '' : `${(xOf(i) / svg.viewBox.baseVal.width) * 100}%`;
        tip.style.right = px > 0.55 ? `${100 - (xOf(i) / svg.viewBox.baseVal.width) * 100}%` : '';
        tip.style.top = `${(yOf(1) / svg.viewBox.baseVal.height) * 100}%`;
    };
    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', () => { tip.classList.remove('on'); cursor.style.display = 'none'; });
}

async function renderBands(pos) {
    const wrap = $('an_bands_wrap'), host = $('an_bands'), meta = $('an_bands_meta');
    if (!wrap || !host) return;
    const kind = cfg('an_human');
    if (!kind) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const steps = kind === 'maia3'
        ? Array.from({length: 21}, (_, i) => String(600 + i * 100))
        : MAIA_BANDS.slice();
    // THE LINES SETTING DRIVES THIS TOO (user report 2026-08-15: "why are there only 3 lines if i
    // put 4"). It was pinned at three in three separate places -- the multipv asked for, the slice
    // taken, and a hardcoded [0.6, 0.28, 0.12] of probabilities that could not describe a fourth.
    const nLines = Core.clamp(Math.round(+cfg('an_lines') || CFG.an_lines), 1, 5);
    const key = `${pos.fen}|${kind}|${nLines}`;
    const run = ++bandRun;
    if (!bandCache.has(key)) {
        const acc = {};
        let shared = null;
        try {
            if (kind === 'maia3') {   // one net, swept across its rating dial
                shared = makeEngine('maia3', {variant: 'chess', multipv: nLines, maiaLevel: steps[0],
                                              limitKind: 'depth', limitValue: 1, threads: 1, hash: 16}, 'analysis-band');
                await shared.start();
            }
            for (let i = 0; i < steps.length; i++) {
                if (run !== bandRun || positions[cursor]?.fen !== pos.fen) { shared?.dispose?.(); return; }
                if (meta) meta.textContent = `${i + 1}/${steps.length}`;
                const band = steps[i];
                try {
                    let e = shared;
                    if (!e) {
                        e = makeEngine('maia', {variant: 'chess', multipv: nLines, maiaLevel: band,
                                                limitKind: 'depth', limitValue: 1, threads: 1, hash: 16},
                                       `analysis-band-${band}`);
                        await e.start();
                    } else {
                        // MAIA 3 TAKES SelfElo/OppoElo, NOT UCI_Elo (see src/offscreen/maia3.js).
                        // setoption ignores a name it does not know, so the whole sweep silently ran
                        // at the Elo the engine was built with: 21 identical inputs, 21 identical
                        // answers, and a chart of perfectly flat lines. Both ends are set, because
                        // the model is conditioned on who is playing AND who they are playing.
                        e.send(`setoption name SelfElo value ${band}`);
                        e.send(`setoption name OppoElo value ${band}`);
                    }
                    const r = await e.analyse(pos.fen, pos.turn);
                    const ls = (r.lines || []).filter(l => l.pv?.[0]).slice(0, nLines);
                    // The net's own probability per move (see humanFor). Deriving it from the rank
                    // instead is what made every band identical: the order rarely changes across a
                    // few hundred rating points, so a decay over the order drew flat lines and said
                    // the same thing at 600 as at 2600. The fallback keeps an older adapter working.
                    const real = ls.every(l => l.prob != null);
                    const w = ls.map((l, idx) => real ? l.prob : Math.exp(-idx * 0.9));
                    const sum = real ? 1 : (w.reduce((a, b) => a + b, 0) || 1);
                    acc[band] = ls.map((l, idx) => ({uci: l.pv[0], prob: w[idx] / sum}));
                    if (!shared) e.dispose?.();
                } catch (err) { acc[band] = []; }
            }
        } finally { shared?.dispose?.(); }
        if (run !== bandRun) return;
        bandCache.set(key, acc);
    }
    if (meta) meta.textContent = `${steps[0]}-${steps[steps.length - 1]}`;
    const acc = bandCache.get(key) || {};
    const totals = new Map();
    for (const b of steps) for (const x of (acc[b] || [])) totals.set(x.uci, (totals.get(x.uci) || 0) + x.prob);
    const moves = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, nLines);
    const series = bandSeries(pos, steps, acc, moves);
    host.innerHTML = bandsChart(steps, series);
    wireBandsHover(host, steps, series);
}

// ---- opening book -------------------------------------------------------------------------------
// A book here is a position -> moves table. JSON and PGN are read directly. Polyglot .bin is
// recognised and refused with the reason: decoding one needs its Zobrist key table, which comes
// from GPL sources and is not vendored into this repo.

async function onBookFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
        if (/\.bin$/i.test(file.name)) {
            // A Polyglot book keys positions by its own Zobrist hash (lib/polyglot-random.js), so
            // this branch is not a text format at all: the bytes are read as 16-byte entries and
            // kept as a key -> moves map.
            const entries = readPolyglot(await file.arrayBuffer());
            if (!entries.size) throw new Error('that .bin has no readable entries');
            bookMoves = {name: file.name, polyglot: entries};
            status(`Book loaded: ${file.name}, ${entries.size} positions.`);
            renderBook();
            return;
        }
        const text = await file.text();
        const entries = new Map();
        if (/\.json$/i.test(file.name)) {
            // {fen: ["e2e4", ...]} or {fen: [{uci, weight}]}
            for (const [fen, moves] of Object.entries(JSON.parse(text))) {
                entries.set(keyOf(fen), (Array.isArray(moves) ? moves : []).map(m =>
                    typeof m === 'string' ? {uci: m, weight: 1} : {uci: m.uci, weight: +m.weight || 1}));
            }
        } else {
            // a PGN book: every game walked, every position counted
            for (const game of Core.parsePgn(text)) {
                const c = new Chess('chess', game.startFen || undefined);
                for (const rec of game.moves) {
                    const san = typeof rec === 'string' ? rec : rec.san;
                    const k = keyOf(c.fen());
                    const mv = c.move(san);
                    if (!mv) break;
                    const uci = mv.from + mv.to + (mv.promotion || '');
                    const list = entries.get(k) || [];
                    const hit = list.find(x => x.uci === uci);
                    if (hit) hit.weight++; else list.push({uci, weight: 1});
                    entries.set(k, list);
                }
            }
        }
        bookMoves = {name: file.name, entries};
        status(`Book loaded: ${file.name}, ${entries.size} positions.`);
        renderBook();
    } catch (err) {
        status('Could not read that book: ' + (err.message || err), 'err');
    }
}

function keyOf(fen) { return String(fen).split(' ').slice(0, 4).join(' '); }

function renderBook() {
    const wrap = $('an_book_wrap'), host = $('an_book_lines'), meta = $('an_book_meta');
    if (!wrap || !host) return;
    const pos = positions[cursor];
    const on = !!(cfg('an_book') && bookMoves && pos);
    wrap.classList.toggle('hidden', !on);
    if (!on) return;
    // a .bin is keyed by the format's own hash; a PGN/JSON book is keyed by the position text
    const raw = bookMoves.polyglot ? lookupPolyglot(bookMoves.polyglot, pos.fen)
                                   : (bookMoves.entries?.get(keyOf(pos.fen)) || []);
    const list = raw.slice().sort((a, b) => b.weight - a.weight).slice(0, 5);
    if (meta) meta.textContent = bookMoves.name;
    const total = list.reduce((a, b) => a + b.weight, 0) || 1;
    host.innerHTML = list.length ? list.map((m, i) =>
        lineRow(i, '#7d8a91', sanOf(pos.fen, m.uci), '', `${Math.round(m.weight / total * 100)}%`,
                Core.clamp(m.weight / total * 100, 2, 100), m.uci)).join('')
        : '<div class="an-lrow"><span></span><span class="an-lval">out of book</span><span></span></div>';
    wireLineClicks(host);
}

// ---- move list ----------------------------------------------------------------------------------

function renderMoves() {
    const el = $('an_moves');
    if (!el) return;
    const rows = [];
    for (let i = 1; i < positions.length; i += 2) {
        const w = positions[i], b = positions[i + 1];
        rows.push(`<div class="an-mrow"><span class="an-mnum">${Math.ceil(i / 2)}</span>`
            + `<span class="an-mcell" data-ply="${i}">${esc(w?.san || '')}</span>`
            + `<span class="an-mcell" data-ply="${i + 1}">${esc(b?.san || '')}</span></div>`);
    }
    el.innerHTML = rows.join('')
        || '<div class="an-mrow"><span class="an-mnum"></span><span class="an-mcell">play a move</span><span></span></div>';
    el.querySelectorAll('.an-mcell[data-ply]').forEach(c => c.addEventListener('click', () => go(+c.dataset.ply)));
}

function highlightMove() {
    document.querySelectorAll('.an-mcell.an-sel').forEach(e => e.classList.remove('an-sel'));
    const sel = document.querySelector(`.an-mcell[data-ply="${cursor}"]`);
    if (sel) { sel.classList.add('an-sel'); sel.scrollIntoView({block: 'nearest'}); }
}

// ---- helpers ------------------------------------------------------------------------------------

function sanOf(fen, uci) {
    if (!uci) return '';
    try {
        const c = new Chess('chess', fen);
        const mv = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        return mv ? mv.san : uci;
    } catch (e) { return uci; }
}

function pvText(fen, pv, n) {
    try {
        const c = new Chess('chess', fen);
        const out = [];
        for (const uci of (pv || []).slice(0, n)) {
            const mv = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
            if (!mv) break;
            out.push(mv.san);
        }
        return out.slice(1).join(' ');
    } catch (e) { return ''; }
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

define({
    title: 'Analysis',
    page: new AnalysisPage(),
});
