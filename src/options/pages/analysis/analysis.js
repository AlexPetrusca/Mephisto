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
import {wirePgnDrop} from "../../util/dragdrop.js";
import {refreshLimitWarnings} from "../../util/limits.js";

const Core = self.MephistoReviewCore;
const {ENGINES, MAIA_BANDS, makeEngine, nativeHostAvailable} = self.MephistoEngines;

const $ = (id) => document.getElementById(id);

// Its own settings: an analysis runs on different numbers from live play, and sharing one set would
// silently make the other wrong. There is no DEPTH here on purpose -- the budget is a time, and its
// last notch is no budget at all.
const CFG = {
    an_variant: 'chess',
    an_engine2: '',       // off: the second column is a choice, not a default
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
// THE LINE IS A VIEW OF A TREE. `positions` is still the flat array everything below reads --
// the path from the start through the current node and on down its first children -- and `cursor`
// is still an index into it. What changed is what a move DOES: it used to truncate the array, so
// the branch you stepped out of was gone; it now adds (or follows) a child, and renderMoves shows
// every branch. Keeping the flat view is what let the rest of the page not care.
let positions = [];      // the current line: [{fen, turn, san, uci, ...node}], index 0 = the start
let cursor = 0;
let treeRoot = null;     // the start node; every node is {fen, turn, san, uci, parent, children[]}
let treeNode = null;     // the node on screen == positions[cursor]
let nodeSeq = 0;         // ids for the move-list markup

// Which rules the board plays by. Everything that builds a Chess() goes through newChess so the one
// variant reaches all of it -- `variant: 'chess'` used to be hardcoded in three places and implied
// in nine more, which is why the page could not open the Crazyhouse or 960 game the panel just
// played. Human model / bands / tablebase / opening names stay standard-chess only and hide
// elsewhere when this is not 'chess'.
const AN_VARIANTS = [
    ['chess', 'Standard'], ['fischerandom', 'Chess960'], ['crazyhouse', 'Crazyhouse'],
    ['3check', 'Three-check'], ['kingofthehill', 'King of the Hill'], ['antichess', 'Antichess'],
    ['atomic', 'Atomic'], ['horde', 'Horde'], ['racingkings', 'Racing Kings'],
];
// the variants only Fairy-Stockfish can analyse; chess + 960 run on any mainline SF (UCI_Chess960)
const FAIRY_ONLY = ['crazyhouse', '3check', 'kingofthehill', 'antichess', 'atomic', 'horde', 'racingkings'];
const FAIRY_ENGINE = 'fairy-stockfish-14-nnue';
function anVariant() { return String(cfg('an_variant') || 'chess'); }
function newChess(fen) { return fen === undefined ? new Chess(anVariant()) : new Chess(anVariant(), fen); }

// crazyhouse only: what each side holds, tracked HERE because this chess.js plays drops but keeps
// no pockets of its own (verified: fen() never carries holdings and any drop is accepted). Captures
// add to the capturer's pocket -- a captured PROMOTED piece goes back as a pawn, which is why the
// promoted squares ride along -- and a drop spends one.
function mkNode(fen, turn, san, uci, parent, extra = {}) {
    return {fen, turn, san, uci, parent, children: [], id: ++nodeSeq,
            holdings: extra.holdings || (parent ? parent.holdings : {w: '', b: ''}),
            promoted: extra.promoted || (parent ? parent.promoted : ''),
            checksLeft: extra.checksLeft || (parent ? parent.checksLeft : {w: 3, b: 3})};
}

// the flat view: back through the parents, forward down the FIRST children
function relinkLine() {
    const back = [];
    for (let n = treeNode; n; n = n.parent) back.push(n);
    back.reverse();
    let tip = treeNode;
    const fwd = [];
    while (tip.children[0]) { tip = tip.children[0]; fwd.push(tip); }
    positions = back.concat(fwd);
    cursor = back.length - 1;
}

// The position AS THE ENGINE MUST SEE IT. chess.js's fen() is placement-only truth: crazyhouse
// pockets and three-check counts live on the node, and Fairy reads both from the FEN -- holdings in
// brackets after the placement, checks as a +W+B field after the en-passant square (both verified
// against the shipped Fairy build). Every other variant passes through untouched.
function engineFen(pos) {
    const v = anVariant();
    if (v === 'crazyhouse') {
        const parts = pos.fen.split(' ');
        const held = (pos.holdings?.w || '').toUpperCase() + (pos.holdings?.b || '').toLowerCase();
        parts[0] = `${parts[0]}[${held}]`;
        return parts.join(' ');
    }
    if (v === '3check') {
        const parts = pos.fen.split(' ');
        const c = pos.checksLeft || {w: 3, b: 3};
        parts.splice(4, 0, `+${c.w}+${c.b}`);
        return parts.join(' ');
    }
    return pos.fen;
}
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
let lastBands = null;    // the chart as last drawn, so the export can describe what is on screen
let openingBook = null;  // fen(4 fields) -> name, lazily fetched from the review's bundled table
let tbCache = new Map(); // fen -> tablebase answer (or null for "asked, nothing"), so a revisit is free

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
        this.registerFormElement('an_variant', 'Variant:', 'select', CFG.an_variant);
        this.registerFormElement('an_engine2', 'Second engine:', 'select', CFG.an_engine2);
        $('an_variant_select')?.addEventListener('change', () => onVariantChange());
        $('an_engine2_select')?.addEventListener('change', () => reloadEngine2());
        for (const id of ['an_lines_input', 'an_threads_input', 'an_hash_input'])
            $(id)?.addEventListener('change', () => reloadEngine());
        // a number the machine cannot honour gets one amber sentence, live as it is typed
        const anWarn = () => refreshLimitWarnings($('an_limits_warn'), $('an_threads_input')?.value, $('an_hash_input')?.value);
        $('an_threads_input')?.addEventListener('input', anWarn);
        $('an_hash_input')?.addEventListener('input', anWarn);
        setTimeout(anWarn, 300);   // once the stored values have been pulled into the form
        $('an_wdl_checkbox')?.addEventListener('change', () => reloadEngine());
        $('an_book_checkbox')?.addEventListener('change', () => renderBook());
        // The budget needs no engine reload -- it is spent by THIS page, not sent as a UCI option.
        // Dragging only re-reads the number; letting go restarts the search on the new budget.
        $('an_time_range')?.addEventListener('input', () => syncTimeUi());
        $('an_time_range')?.addEventListener('change', () => { syncTimeUi(); go(cursor); });

        $('an_load')?.addEventListener('click', () => loadFromInput());
        // drop a .pgn anywhere on the page; one shared helper with Game Review (util/dragdrop.js)
        wirePgnDrop(document.getElementById('an-form'), $('an_pgn'), (text) => {
            $('an_pgn').value = text;
            loadFromInput();
        });
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
        $('an_export')?.addEventListener('click', (e) => exportPosition(e.currentTarget));
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
    const vs = $('an_variant_select');
    if (vs && !vs.options.length) {
        vs.innerHTML = AN_VARIANTS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    }
    const e2 = $('an_engine2_select');
    if (e2 && !e2.options.length) {
        e2.innerHTML = '<option value="">Off</option>'
            + ENGINES.map(e => `<option value="${e.id}">${e.label}</option>`).join('');
        for (const e of ENGINES.filter(x => x.kind === 'native')) {
            nativeHostAvailable(e.id).then(ok => {
                const opt = [...e2.options].find(o => o.value === e.id);
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
    if (out) out.textContent = secs >= AN_INFINITE ? 'no limit - until you move on' : `${secs}s per position`;
    slider.style.setProperty('--fill', `${((secs - 1) / (AN_INFINITE - 1)) * 100}%`);
}

function syncBandRow() {
    const row = $('an_band_row'), bs = $('an_band_select');
    if (!row || !bs) return;
    // the Maia nets are standard chess only -- in a variant the whole human column stands down
    row.style.display = (cfg('an_human') && anVariant() === 'chess') ? '' : 'none';
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
    const c = newChess();
    treeRoot = mkNode(c.fen(), c.turn(), null, null, null,
                      {holdings: {w: '', b: ''}, promoted: '', checksLeft: {w: 3, b: 3}});
    treeNode = treeRoot;
    relinkLine();
    evalCache.clear(); evalCache2.clear(); humanCache.clear(); bandCache.clear();
    buildBoard();
    renderMoves();
    renderPockets();
    status('');
    go(0);
}

// lichess/PGN variant names -> this chess.js's ids. Unknown names load as standard with a note,
// which is what the page did for every variant before this existed.
const PGN_VARIANTS = {
    'standard': 'chess', 'chess960': 'fischerandom', 'fischerandom': 'fischerandom',
    'fischerrandom': 'fischerandom', 'crazyhouse': 'crazyhouse', 'three-check': '3check',
    'threecheck': '3check', 'three check': '3check', 'king of the hill': 'kingofthehill',
    'kingofthehill': 'kingofthehill', 'antichess': 'antichess', 'giveaway': 'antichess',
    'atomic': 'atomic', 'horde': 'horde', 'racing kings': 'racingkings', 'racingkings': 'racingkings',
};

function setVariant(v) {
    if (anVariant() === v) return;
    setCfg('an_variant', v);
    const sel = $('an_variant_select');
    if (sel) sel.value = v;
    onVariantChange(true);
}

// A variant change is a rules change: every cached answer is about a different game now. The engine
// is reloaded (it needs the new UCI_Variant / UCI_Chess960), and an engine that cannot play the
// variant is switched to the one that can rather than silently analysing the wrong game -- Fairy
// answers an unknown variant by staying on the previous one, which is the failure mode the offscreen
// loader exists to catch.
function onVariantChange(quiet) {
    const v = anVariant();
    if (FAIRY_ONLY.includes(v)) {
        if (cfg('an_engine') !== FAIRY_ENGINE) {
            setCfg('an_engine', FAIRY_ENGINE);
            const es = $('an_engine_select');
            if (es) es.value = FAIRY_ENGINE;
            if (!quiet) status(`Engine switched to Fairy-Stockfish: only it plays ${v}.`);
        }
        if (cfg('an_engine2') && cfg('an_engine2') !== FAIRY_ENGINE) {
            setCfg('an_engine2', '');
            const e2 = $('an_engine2_select');
            if (e2) e2.value = '';
        }
    }
    syncBandRow();
    reloadEngine2();
    reloadEngine();   // clears the eval caches and re-analyses via go(cursor)
    loadFromInput();  // reload whatever is in the box under the new rules (empty box = start position)
}

// One box takes either: a FEN is placement data followed by a side to move, anything else is a game.
function loadFromInput() {
    const text = ($('an_pgn')?.value || '').trim();
    if (!text) return loadStart();
    try {
        // a [Variant] tag decides the rules BEFORE anything is replayed -- a Crazyhouse game read
        // under standard rules dies on its first drop, which is exactly the game this page could
        // not open before
        const tagged = /\[Variant\s+"([^"]+)"\]/.exec(text);
        if (tagged) {
            const v = PGN_VARIANTS[tagged[1].trim().toLowerCase()];
            if (v && v !== anVariant()) {
                setCfg('an_variant', v);
                const sel = $('an_variant_select');
                if (sel) sel.value = v;
                onVariantChange(true);
                return;    // onVariantChange re-enters loadFromInput under the new rules
            }
            if (!v) status(`Variant "${tagged[1]}" is not one this board can play -- loading as standard.`, 'err');
        }
        if (/^[rnbqkpRNBQKP1-8/]+(\[[a-zA-Z]*\])?\s+[wb]\s/.test(text)) {
            // a crazyhouse FEN carries its pockets in brackets; the local rules engine keeps no
            // pockets, so they are lifted out here and tracked on the node instead
            let fenText = text;
            let holdings = {w: '', b: ''};
            const held = /\[([a-zA-Z]*)\]/.exec(fenText);
            if (held) {
                holdings = {w: (held[1].match(/[A-Z]/g) || []).join('').toLowerCase(),
                            b: (held[1].match(/[a-z]/g) || []).join('')};
                fenText = fenText.replace(/\[[a-zA-Z]*\]/, '');
            }
            const parts = fenText.split(/\s+/);
            // chess.js does NOT reliably throw on junk, so the shape is checked before it is handed over
            if ((parts[0] || '').split('/').length !== 8 || parts.length < 4) {
                throw new Error('that does not look like a FEN');
            }
            const c = newChess(fenText);
            treeRoot = mkNode(c.fen(), c.turn(), null, null, null,
                              {holdings, promoted: '', checksLeft: {w: 3, b: 3}});
            treeNode = treeRoot;
            status('Position loaded.');
        } else {
            const game = Core.parsePgn(text)[0];
            if (!game) throw new Error('no game found in that text');
            const c = newChess(game.startFen || undefined);
            treeRoot = mkNode(c.fen(), c.turn(), null, null, null,
                              {holdings: {w: '', b: ''}, promoted: '', checksLeft: {w: 3, b: 3}});
            let at = treeRoot;
            for (const rec of game.moves) {
                const san = typeof rec === 'string' ? rec : rec.san;
                const mv = c.move(san);
                if (!mv) throw new Error(`illegal move in the PGN: ${san}`);
                const child = mkNode(c.fen(), c.turn(), mv.san, uciOfMove(mv), at, nodeExtras(at, mv));
                at.children.push(child);
                at = child;
            }
            treeNode = treeRoot;
            // the parser is lenient by design, so say what it understood rather than loading a
            // half-copied game silently
            let n = 0;
            for (let x = treeRoot; x.children[0]; x = x.children[0]) n++;
            status(n === 0 ? 'No moves were understood in that text.'
                 : n < 3 ? `Only ${n} move${n === 1 ? '' : 's'} understood -- check the text.`
                 : `Loaded ${n} moves.`, n === 0 ? 'err' : undefined);
        }
    } catch (e) {
        return status(String(e.message || e), 'err');
    }
    relinkLine();
    evalCache.clear(); evalCache2.clear(); humanCache.clear(); bandCache.clear();
    buildBoard();
    renderMoves();
    renderPockets();
    go(cursor);
}

// a drop's identity is its SAN ('P@e5'); a normal move's is from+to+promotion
function uciOfMove(mv) {
    return mv.san?.includes('@') ? mv.san.replace(/[+#]$/, '')
         : mv.from + mv.to + (mv.promotion || '');
}

// The node state a move carries forward: crazyhouse pockets + promoted squares, three-check counts.
// Cheap for every other variant -- the parent's values ride along untouched.
function nodeExtras(parent, mv) {
    const v = anVariant();
    const out = {};
    if (v === 'crazyhouse') {
        let {w, b} = parent.holdings || {w: '', b: ''};
        let promoted = parent.promoted || '';
        const squares = promoted ? promoted.split(',').filter(Boolean) : [];
        const drop = mv.san?.includes('@');
        if (drop) {
            const type = mv.san[1] === '@' ? mv.san[0].toLowerCase() : 'p';
            if (mv.color === 'w') w = w.replace(type, '');
            else b = b.replace(type, '');
        } else {
            if (mv.captured) {
                // a captured PROMOTED piece goes back to the pocket as the pawn it once was
                const capSq = mv.flags?.includes?.('e') || (mv.flags & 8)   // ep: the pawn is not on `to`
                    ? mv.to[0] + (mv.color === 'w' ? '5' : '4') : mv.to;
                const wasPromoted = squares.includes(capSq);
                const type = wasPromoted ? 'p' : mv.captured;
                if (mv.color === 'w') w += type; else b += type;
                if (wasPromoted) squares.splice(squares.indexOf(capSq), 1);
            }
            // the promoted mark travels with its piece, and a promotion creates one
            const fromIdx = squares.indexOf(mv.from);
            if (fromIdx >= 0) { squares.splice(fromIdx, 1); squares.push(mv.to); }
            if (mv.promotion) squares.push(mv.to);
        }
        out.holdings = {w, b};
        out.promoted = squares.join(',');
    }
    if (v === '3check') {
        const c = {...(parent.checksLeft || {w: 3, b: 3})};
        if (/[+#]$/.test(mv.san || '')) {
            // the MOVER gave the check: their remaining count goes down
            if (mv.color === 'w') c.w = Math.max(0, c.w - 1); else c.b = Math.max(0, c.b - 1);
        }
        out.checksLeft = c;
    }
    return out;
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
    const varTag = anVariant() !== 'chess'
        ? `[Variant "${(AN_VARIANTS.find(v => v[0] === anVariant()) || ['', ''])[1]}"]\n` : '';
    const tags = (start && start !== newChess().fen())
        ? `${varTag}[SetUp "1"]\n[FEN "${start}"]\n\n` : (varTag ? varTag + '\n' : '');
    return (tags + body.join(' ')).trim();
}

async function copyOut(text, what) {
    if (!text) return status(`There is no ${what} to copy yet.`, 'err');
    try {
        await navigator.clipboard.writeText(text);
        status(`${what} copied.`);
    } catch (e) { status(`Could not copy the ${what}: ${e.message || e}`, 'err'); }
}

// ---- export ---------------------------------------------------------------------------------
// THE POSITION, NOT A PICTURE OF IT. A screenshot of the chart is the thing people actually send,
// and it cannot be read back: no FEN, no PGN, no numbers. This writes one self-contained file --
// the board as it stands, the line that got here, the chart, and the table behind the chart --
// with the stylesheets inlined and the pieces embedded, the same shape the review page exports in.
// No scripts, nothing to fetch, opens anywhere.

const AN_EXPORT_CSS = ['/src/options/options.css', '/src/options/pages/analysis/analysis.css',
                       '/lib/chessboard/chessboard.min.css'];

const AN_EXPORT_RESET = `
  html, body { margin: 0; padding: 0; }
  body { padding: 28px 22px 40px; }
  header, main, footer { padding-left: 0 !important; }
  main > .container { width: 100%; max-width: 1100px; margin: 0 auto; }
  .an-board-wrap { width: max-content; aspect-ratio: auto; }
  .an-board { width: auto; height: auto; }
  .an-export-grid { display: grid; grid-template-columns: max-content 1fr; gap: 28px; align-items: start; }
  @media (max-width: 820px) { .an-export-grid { grid-template-columns: 1fr; } }
  .an-export-fen { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
                   word-break: break-all; color: var(--mp-dim); }
  .an-export-t { border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
  .an-export-t th, .an-export-t td { border: 1px solid var(--mp-line); padding: 3px 8px; text-align: right;
                                     font-variant-numeric: tabular-nums; }
  .an-export-t th:first-child, .an-export-t td:first-child { text-align: left;
                                     font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .an-band-tip { display: none; }
`;

async function inlineText(path) {
    try {
        const r = await fetch(chrome.runtime.getURL(path.replace(/^\//, '')));
        return r.ok ? await r.text() : '';
    } catch (e) { return ''; }
}

async function inlineImage(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return `data:${r.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}`;
    } catch (e) { return null; }
}

// The chart's numbers as a table: a reader with the picture can see the shape, and a reader with
// this can check it, quote it, or paste it somewhere else.
function exportBandTable() {
    if (!lastBands?.series?.length) return '';
    const {steps, series} = lastBands;
    const head = `<tr><th>Rating</th>${series.map(s => `<th>${esc(s.san)}</th>`).join('')}</tr>`;
    const rows = steps.map((b, i) =>
        `<tr><td>${esc(b)}</td>${series.map(s => `<td>${(s.ys[i] * 100).toFixed(1)}%</td>`).join('')}</tr>`).join('');
    return `<table class="an-export-t">${head}${rows}</table>`;
}

async function exportPosition(btn) {
    const pos = positions[cursor];
    if (!pos) return;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    try {
        const css = (await Promise.all(AN_EXPORT_CSS.map(inlineText))).join('\n') + AN_EXPORT_RESET;
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="an-export-grid">`
            + `<div>${document.querySelector('.an-boardrow')?.outerHTML || ''}</div>`
            + `<div>${$('an_bands_wrap')?.outerHTML || ''}</div></div>`;
        wrap.querySelectorAll('.an-hit, .an-band-cursor, .tooltipped .info-tooltip').forEach(el => el.remove());

        // the pieces are extension URLs, which mean nothing outside this browser
        const seen = new Map();
        for (const img of [...wrap.querySelectorAll('img[src]')]) {
            if (!seen.has(img.src)) seen.set(img.src, await inlineImage(img.src));
            const data = seen.get(img.src);
            if (data) img.src = data; else img.remove();
        }

        const human = cfg('an_human') ? `${cfg('an_human') === 'maia3' ? 'Maia 3' : 'Maia 1'}` : 'off';
        const pgn = pgnText();
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Position - ${esc(pos.fen.split(' ')[0].slice(0, 24))}</title>
<style>${css}</style>
</head><body><main><div class="container">
<h3 class="set-h">Position</h3>
${wrap.innerHTML}
<h3 class="set-h">FEN</h3>
<p class="an-export-fen">${esc(pos.fen)}</p>
${pgn ? `<h3 class="set-h">Moves</h3><p class="an-export-fen">${esc(pgn)}</p>` : ''}
${lastBands ? `<h3 class="set-h">How often each move is played, by rating</h3>
<p class="an-status">Human model: ${esc(human)}. Each figure is that move's share of ALL legal moves at
 that rating, so a row summing to under 100% is the rest of the moves, not a rounding error.</p>
${exportBandTable()}` : ''}
<p class="an-status">Written by the Mephisto Chess Extension. Everything in this file was computed on the
 machine that wrote it; nothing was uploaded.</p>
</div></main></body></html>`;

        const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
        const a = document.createElement('a');
        a.href = url;
        a.download = `position-${pos.fen.split(' ')[0].replace(/\W+/g, '').slice(0, 24)}.html`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        status('Position exported.');
    } catch (e) {
        status('Could not build the export: ' + (e.message || e), 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
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
        variant: anVariant(),
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

// THE SECOND ENGINE, side by side. The page contrasted an engine with a human model; contrasting
// two ENGINES answers a different question -- does the 15MB net see what the 112MB one sees --
// which is the thing to settle before trusting the small one in a game. Same serialisation
// discipline as the first engine and for the same measured reasons; its own client id, its own
// cache, its own column, and the SAME budget -- one slider, both searches.
let engine2 = null;
let liveSearch2 = null;
let evalCache2 = new Map();
let engine2Chain = Promise.resolve();
function ensureEngine2() {
    engine2Chain = engine2Chain.then(buildEngine2, buildEngine2);
    return engine2Chain;
}
async function buildEngine2() {
    if (!cfg('an_engine2')) return null;
    if (engine2) return engine2;
    const e = makeEngine(cfg('an_engine2'), engineOpts(), 'analysis-b');
    await e.start();
    if (cfg('an_wdl')) e.send?.('setoption name UCI_ShowWDL value true');
    engine2 = e;
    return engine2;
}
function reloadEngine2() {
    evalCache2.clear();
    analyseChain = analyseChain.then(async () => {
        await stopSearch();
        if (engine2) { try { engine2.dispose?.(); } catch (e) { /* */ } engine2 = null; }
    }, () => {});
    const col = $('an_engine2_col');
    if (col) col.classList.toggle('hidden', !cfg('an_engine2'));
    go(cursor);
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
    if (engine2) { try { engine2.dispose?.(); } catch (e) { /* */ } engine2 = null; }
    if (human) { try { human.dispose?.(); } catch (e) { /* */ } human = null; humanKey = null; }
    boardResizeObs?.disconnect();
    boardResizeObs = null;
}

// Returns a promise: the next search must not start until this one has really finished, or its
// trailing info lines are read as the new position's (see startInfinite).
function stopSearch() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    const stops = [];
    if (liveSearch) {
        const s = liveSearch;
        liveSearch = null;
        try { stops.push(Promise.resolve(s.stop())); } catch (e) { /* */ }
    }
    if (liveSearch2) {
        const s2 = liveSearch2;
        liveSearch2 = null;
        try { stops.push(Promise.resolve(s2.stop())); } catch (e) { /* */ }
    }
    return stops.length ? Promise.all(stops) : Promise.resolve();
}

// ---- stepping and analysing ---------------------------------------------------------------------

function go(ply) {
    if (!positions.length) return;
    treeNode = positions[Core.clamp(ply, 0, positions.length - 1)];
    relinkLine();          // stepping BACK re-roots the forward tail on the mainline children
    render();
    renderPockets();
    analyseCurrent();
}

// jump to any node in the tree (a variation cell in the move list)
function goNode(n) {
    if (!n) return;
    treeNode = n;
    relinkLine();
    render();
    renderMoves();         // the highlighted line may have changed shape
    renderPockets();
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
    // the engine sees the node's FULL state -- crazyhouse pockets, three-check counts -- while the
    // page keeps keying its caches by the plain fen the board renders
    const search = e.startInfinite(engineFen(pos), pos.turn, (res) => {
        if (cursor !== at || positions[at]?.fen !== pos.fen) return;
        evalCache.set(pos.fen, res);
        renderEval(pos, res);
        renderEngineLines(pos, res);
        renderArrows(pos, res, humanCache.get(humanCacheKey(pos.fen)));
        const m = $('an_engine_meta');
        if (m) m.textContent = `depth ${res.depth}${res.nodes ? ` · ${(res.nodes / 1000).toFixed(0)}k` : ''}`;
    });
    liveSearch = search;
    if (cfg('an_engine2')) {
        try {
            const e2 = await ensureEngine2();
            if (e2 && cursor === at && positions[at]?.fen === pos.fen) {
                liveSearch2 = e2.startInfinite(engineFen(pos), pos.turn, (res) => {
                    if (cursor !== at || positions[at]?.fen !== pos.fen) return;
                    evalCache2.set(pos.fen, res);
                    renderEngine2Lines(pos, res);
                    const m2 = $('an_engine2_meta');
                    if (m2) m2.textContent = `depth ${res.depth}${res.nodes ? ` · ${(res.nodes / 1000).toFixed(0)}k` : ''}`;
                });
            }
        } catch (err) { status(`Second engine unavailable (${err.message || err})`, 'err'); }
    }
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
    if (anVariant() !== 'chess') return null;   // the nets know one game
    const key = humanCacheKey(pos.fen);
    if (humanCache.has(key)) return humanCache.get(key);
    const kind = cfg('an_human');
    // The sweep has already priced every move here at every band -- its answer for the selected band
    // IS this column, so a position the chart has visited never costs a second forward pass. The
    // sweep keeps twelve lines; this column keeps its usual five.
    const swept = bandCache.get(bandKey(pos.fen, kind))?.[cfg('an_band')];
    if (swept?.length) {
        const out = swept.slice(0, 5);
        humanCache.set(key, out);
        return out;
    }
    const h = await ensureHuman();
    if (!h) return null;
    // With Maia 3 the sweep runs on THIS engine, so the call goes through the same queue the sweeps
    // use -- an analyse landing mid-sweep would answer at whatever rating the dial was passing. The
    // queue also means a sweep may finish first and leave the answer in its cache; take it and skip
    // the pass. Maia 1 keeps its own per-band engines, and skips the queue rather than waiting
    // behind a sweep it cannot collide with.
    const res = kind === 'maia3'
        ? await queueSweep(() => {
              const again = bandCache.get(bandKey(pos.fen, kind))?.[cfg('an_band')];
              return again?.length ? {cached: again} : h.analyse(pos.fen, pos.turn);
          })
        : await h.analyse(pos.fen, pos.turn);
    if (res?.cached) {
        const out = res.cached.slice(0, 5);
        humanCache.set(key, out);
        return out;
    }
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

// A move played on the board (click or drag) used to TRUNCATE the line -- right for "what if",
// wrong for studying, because the branch you stepped out of was gone. It BRANCHES now: a move that
// already exists as a child is followed, anything else becomes a new variation, and the move list
// shows every branch with a way back in. `drop` is a crazyhouse pocket piece ('P'..'Q', ours),
// played by SAN because that is the only drop syntax this chess.js accepts.
function playMove(from, to, promotion, drop) {
    const pos = positions[cursor];
    if (!pos) return false;
    let mv, fenAfter, turnAfter;
    try {
        const c = newChess(pos.fen);
        if (drop) {
            // the page keeps the pockets (chess.js accepts ANY drop), so the pocket is the gate
            const type = drop.toLowerCase();
            const side = pos.turn;
            if (!(pos.holdings?.[side] || '').includes(type)) return false;
            mv = c.move(`${type === 'p' ? 'P' : type.toUpperCase()}@${to}`);
        } else {
            mv = c.move({from, to, promotion: promotion || 'q'});
        }
        if (!mv) return false;
        fenAfter = c.fen(); turnAfter = c.turn();
    } catch (e) { return false; }
    const uci = uciOfMove(mv);
    const existing = treeNode.children.find(ch => ch.uci === uci);
    if (existing) {
        treeNode = existing;                       // walking back INTO a branch follows it
    } else {
        const child = mkNode(fenAfter, turnAfter, mv.san, uci, treeNode, nodeExtras(treeNode, mv));
        treeNode.children.push(child);             // children[0] stays the mainline
        treeNode = child;
    }
    relinkLine();
    renderMoves();
    renderPockets();
    armDrop(null);
    go(cursor);
    return true;
}

function panelPromotes(from, to) {
    try {
        const c = newChess(positions[cursor].fen);
        const piece = c.get(from);
        if (!piece || piece.type !== 'p') return null;
        return (piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1') ? piece.color : null;
    } catch (e) { return null; }
}

function legalTargets(from) {
    try {
        return newChess(positions[cursor].fen).moves({square: from, verbose: true}).map(m => m.to);
    } catch (e) { return []; }
}

// ---- crazyhouse pockets ---------------------------------------------------------------------------
// The pockets are the page's own state (see mkNode): two strips beside the board, the opponent's
// above and ours below, following the flip. Clicking a held piece ARMS it; the next click on an
// empty board square drops it there (chess.js validates the square -- no pawns on the back ranks --
// and the page has already validated the pocket). Clicking the armed piece again, or pressing
// Escape, disarms.
let armedDrop = null;   // 'p'|'n'|'b'|'r'|'q' from the side to move's pocket, or null

function armDrop(type) {
    armedDrop = armedDrop === type ? null : type;
    renderPockets();
}

const POCKET_GLYPHS = {w: {p: '\u2659', n: '\u2658', b: '\u2657', r: '\u2656', q: '\u2655'},
                       b: {p: '\u265F', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B'}};

function pocketHtml(side, holdings, canArm) {
    const counts = {};
    for (const ch of holdings || '') counts[ch] = (counts[ch] || 0) + 1;
    return ['q', 'r', 'b', 'n', 'p'].filter(k => counts[k]).map(k =>
        `<span class="an-pk ${canArm && armedDrop === k ? 'an-pk-armed' : ''}" ${canArm ? `data-drop="${k}"` : ''}
              title="${canArm ? `Click, then click an empty square to drop` : `Held by the opponent`}">
            ${POCKET_GLYPHS[side][k]}${counts[k] > 1 ? `<i>${counts[k]}</i>` : ''}</span>`).join('');
}

function renderPockets() {
    const top = $('an_pocket_top'), bottom = $('an_pocket_bottom');
    if (!top || !bottom) return;
    const zh = anVariant() === 'crazyhouse';
    top.classList.toggle('hidden', !zh);
    bottom.classList.toggle('hidden', !zh);
    if (!zh) { armedDrop = null; return; }
    const pos = positions[cursor];
    if (!pos) return;
    const bottomSide = flipped ? 'b' : 'w';
    const topSide = flipped ? 'w' : 'b';
    // arming is only offered on the side TO MOVE -- a drop out of turn is not a legal ask
    top.innerHTML = pocketHtml(topSide, pos.holdings?.[topSide], pos.turn === topSide) || '<span class="an-pk-none">no pieces in hand</span>';
    bottom.innerHTML = pocketHtml(bottomSide, pos.holdings?.[bottomSide], pos.turn === bottomSide) || '<span class="an-pk-none">no pieces in hand</span>';
    for (const host of [top, bottom]) {
        host.querySelectorAll('[data-drop]').forEach(el =>
            el.addEventListener('click', () => armDrop(el.dataset.drop)));
    }
}

// an armed drop lands wherever the next board click does; the board's own move handling is not
// involved (there is no `from` square), so the square is read off the click's geometry
function wireDropClicks(host) {
    host.addEventListener('click', (e) => {
        if (!armedDrop || anVariant() !== 'crazyhouse') return;
        const inner = host.querySelector('.board-b72b1') || host;
        const r = inner.getBoundingClientRect();
        if (!r.width) return;
        const fx = Math.floor(((e.clientX - r.left) / r.width) * 8);
        const fy = Math.floor(((e.clientY - r.top) / r.height) * 8);
        if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return;
        const file = flipped ? 7 - fx : fx;
        const rank = flipped ? fy + 1 : 8 - fy;
        const sq = String.fromCharCode(97 + file) + rank;
        // an occupied square cannot take a drop -- fall through to normal click handling instead
        try { if (newChess(positions[cursor].fen).get(sq)) return; } catch (err) { return; }
        playMove(null, sq, null, armedDrop);
    }, true);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armedDrop) armDrop(armedDrop); });

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
    if (!host.dataset.dropWired) { wireDropClicks(host); host.dataset.dropWired = '1'; }
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
    renderExtras(pos);
    const ev = evalCache.get(pos.fen);
    const hum = humanCache.get(humanCacheKey(pos.fen));
    renderEval(pos, ev);
    renderEngineLines(pos, ev);
    const col2 = $('an_engine2_col');
    if (col2) col2.classList.toggle('hidden', !cfg('an_engine2'));
    if (cfg('an_engine2')) renderEngine2Lines(pos, evalCache2.get(pos.fen));
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
        if (uci.includes('@')) return !!newChess(fen).move(uci.replace(/[+#]$/, ''));   // a drop line from Fairy
        return !!newChess(fen).move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
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

// the second engine's column: same rows, its own palette, so the two reads sit side by side
const RANK_COLOURS_B = ['#c98a2d', '#b0925c', '#a88865', '#8f8f8f', '#7f8b95'];

function renderEngine2Lines(pos, ev) {
    const host = $('an_engine2_lines');
    if (!host) return;
    const title = $('an_engine2_title');
    if (title) {
        const id = cfg('an_engine2');
        title.textContent = ENGINES.find(x => x.id === id)?.label || 'Second engine';
    }
    const lines = (ev?.lines || []).filter(l => legalHere(pos.fen, l.pv?.[0]))
        .slice(0, Math.max(1, +cfg('an_lines')));
    host.innerHTML = lines.length ? lines.map((l, i) => {
        const cp = l.cp * (pos.turn === 'w' ? 1 : -1);
        const val = Core.isMateScore(l.cp) ? (cp > 0 ? '#' : '-#') : (cp / 100).toFixed(2);
        const pct = Core.clamp(Core.winPercent(l.cp * (pos.turn === 'w' ? 1 : -1)), 2, 100);
        return lineRow(i, RANK_COLOURS_B[Math.min(i, 4)], sanOf(pos.fen, l.pv?.[0]),
                       pvText(pos.fen, l.pv, 4), val, pct, l.pv?.[0] || '');
    }).join('') : '<div class="an-lrow"><span></span><span class="an-lval">thinking…</span><span></span></div>';
    wireLineClicks(host);
}

function renderHumanLines(pos, hum) {
    const host = $('an_human_lines');
    if (!host) return;
    const title = $('an_human_title');
    const kind = anVariant() === 'chess' ? cfg('an_human') : '';
    if (title) title.textContent = kind ? `Human ${cfg('an_band')}`
        : (cfg('an_human') && anVariant() !== 'chess' ? 'Human model (standard chess only)' : 'Human model off');
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
const BAND_COLOURS = ['#358a4d', '#4aa563', '#63b478', '#7cc28d', '#95d0a3', '#aeddb9', '#c6e8ce', '#dcf1e0'];
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
        // the colour is a DOT, not the text: the pale end of the palette is legible as a 2px line on
        // the plot and unreadable as 10px type on the readout's own background
        tip.innerHTML = `<h6>${esc(steps[i])}</h6>` + series.map(s =>
            `<div><span><i style="background:${s.colour}"></i>${esc(s.san)}</span>`
          + `<b>${(s.ys[i] * 100).toFixed(1)}%</b></div>`).join('');
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

function bandSteps(kind) {
    return kind === 'maia3' ? Array.from({length: 21}, (_, i) => String(600 + i * 100))
                            : MAIA_BANDS.slice();
}

// EVERYTHING ABOVE 1%, not a fixed count. The clamp at five was OURS, not the model's -- Maia has
// already priced every legal move in the one forward pass, so asking for the top twelve costs
// nothing over asking for five, and the chart then shows every move a human actually plays here.
// Twelve in, eight drawn: no real position has more than a handful above 1%, and eight is where the
// palette and the label spacing stop being readable.
const BAND_MULTIPV = 12;
const BAND_SHOW_MAX = 8;
function bandKey(fen, kind) { return `${fen}|${kind}`; }

// ONE SWEEP AT A TIME, whoever asked for it. The visible sweep and the one running ahead of the
// cursor use the same engines, so overlapping them would mean two Maia 3 nets in memory and two
// searches interleaved on one adapter -- the same shape as the bug that wedged the analyses.
let bandChain = Promise.resolve();
function queueSweep(fn) { bandChain = bandChain.then(fn, fn); return bandChain; }

// Fill the cache for one position. `onStep` is how the visible sweep shows progress; a sweep running
// ahead of the cursor passes nothing and is silent. Any sweep is abandoned the moment a newer one is
// asked for, which is what `bandRun` is: stepping through a game must not queue up twenty stale ones.
async function sweepBands(pos, kind, run, onStep) {
    const steps = bandSteps(kind);
    const acc = {};
    let shared = null;
    let borrowed = false;
    try {
        if (kind === 'maia3') {   // one net, swept across its rating dial
            // The human column's engine IS this net. Loading a second 92MB copy for the sweep is
            // what made the first sweep after picking Maia 3 a long wait, so borrow the one already
            // running instead: every caller of it is serialised through queueSweep, so the dial can
            // be turned without a search in flight.
            shared = await ensureHuman().catch(() => null);
            if (shared) {
                borrowed = true;
                shared.send(`setoption name MultiPV value ${BAND_MULTIPV}`);
            } else {
                shared = makeEngine('maia3', {variant: 'chess', multipv: BAND_MULTIPV, maiaLevel: steps[0],
                                              limitKind: 'depth', limitValue: 1, threads: 1, hash: 16}, 'analysis-band');
                await shared.start();
            }
        }
        for (let i = 0; i < steps.length; i++) {
            if (run !== bandRun) return null;
            onStep?.(i + 1, steps.length);
            const band = steps[i];
            try {
                let e = shared;
                if (!e) {
                    e = makeEngine('maia', {variant: 'chess', multipv: BAND_MULTIPV, maiaLevel: band,
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
                const ls = (r.lines || []).filter(l => l.pv?.[0]).slice(0, BAND_MULTIPV);
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
    } finally {
        if (borrowed) {
            // hand it back the way the human column runs it: five lines at the selected rating
            shared.send('setoption name MultiPV value 5');
            shared.send(`setoption name SelfElo value ${cfg('an_band')}`);
            shared.send(`setoption name OppoElo value ${cfg('an_band')}`);
        } else { shared?.dispose?.(); }
    }
    if (run !== bandRun) return null;
    bandCache.set(bandKey(pos.fen, kind), acc);
    return acc;
}

// SWEEP THE NEXT PLY WHILE YOU ARE LOOKING AT THIS ONE. Walking a game used to re-sweep from scratch
// at every step -- twenty-one forward passes per move with Maia 3 -- because the work only ever
// started when the position was already on screen. The cache is keyed by position, so a ply swept
// ahead of time is on screen instantly when you reach it. Only ONE ply ahead: that is the step a
// reader is about to take, and anything more is work for a position they may never look at.
let prefetchTimer = null;
function schedulePrefetch() {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
        prefetchTimer = null;
        const kind = cfg('an_human');
        const next = positions[cursor + 1];
        if (!kind || !next) return;
        if (bandCache.has(bandKey(next.fen, kind))) return;
        const run = bandRun;                       // a newer visible sweep supersedes this one
        queueSweep(() => sweepBands(next, kind, run, null).catch(() => null));
    }, 500);
}

async function renderBands(pos) {
    const wrap = $('an_bands_wrap'), host = $('an_bands'), meta = $('an_bands_meta');
    if (!wrap || !host) return;
    const kind = cfg('an_human');
    if (!kind || anVariant() !== 'chess') { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const steps = bandSteps(kind);
    const key = bandKey(pos.fen, kind);
    const run = ++bandRun;
    if (!bandCache.has(key)) {
        const got = await queueSweep(() => sweepBands(pos, kind, run, (i, n) => {
            if (meta && cursor >= 0 && positions[cursor]?.fen === pos.fen) meta.textContent = `${i}/${n}`;
        }));
        if (!got || run !== bandRun || positions[cursor]?.fen !== pos.fen) return;
    }
    if (meta) meta.textContent = `${steps[0]}-${steps[steps.length - 1]}`;
    const acc = bandCache.get(key) || {};
    const totals = new Map();
    for (const b of steps) for (const x of (acc[b] || [])) totals.set(x.uci, (totals.get(x.uci) || 0) + x.prob);
    // every move that clears 1% at ANY band, best first; the cap is legibility, not the model
    const moves = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const series = bandSeries(pos, steps, acc, moves).filter(sr => sr.top >= 0.01).slice(0, BAND_SHOW_MAX);
    host.innerHTML = bandsChart(steps, series);
    wireBandsHover(host, steps, series);
    lastBands = {pos, steps, series, kind};           // what an export would have to describe
    schedulePrefetch();                               // ...and get the next ply ready meanwhile
}

// ---- what the position IS: its opening name, and the tablebase's verdict ------------------------
// Both are facts the extension already knows how to establish -- the review names openings from its
// bundled table (3,810 lines, keyed by POSITION so transpositions come out right), and the panel
// asks the lichess tablebase through the worker once seven or fewer men are left. This page just
// asks the same questions for the position on its board.

const TB_MAX_MEN = 7;   // the largest Syzygy set lichess serves

async function loadOpeningBook() {
    if (openingBook) return openingBook;
    try {
        const r = await fetch(chrome.runtime.getURL('src/options/pages/review/openings.json'));
        openingBook = r.ok ? await r.json() : {};
    } catch (e) { openingBook = {}; }
    return openingBook;
}

function pieceCount(fen) {
    return (String(fen).split(' ')[0].match(/[a-zA-Z]/g) || []).length;
}

// Async on purpose, guarded by position: the book is a fetch and the tablebase is a network round
// trip, and by the time either answers the board may show a different position. An answer for a
// position no longer on screen is dropped, never drawn.
async function renderExtras(pos) {
    const opEl = $('an_opening'), tbEl = $('an_tb');
    if (!opEl && !tbEl) return;

    if (anVariant() !== 'chess') {
        // the opening table and the lichess tablebase both describe standard chess and nothing else
        if (opEl) opEl.textContent = '';
        if (tbEl) tbEl.textContent = '';
        return;
    }
    if (opEl) {
        const book = await loadOpeningBook();
        if (positions[cursor]?.fen !== pos.fen) return;
        // the deepest named position on the way HERE, so stepping back through the moves walks back
        // through the names too
        let name = null;
        for (let i = 0; i <= cursor && i < positions.length; i++) {
            const hit = book[positions[i].fen.split(' ').slice(0, 4).join(' ')];
            if (hit) name = hit;
        }
        opEl.textContent = name || '';
    }

    if (tbEl) {
        if (pieceCount(pos.fen) > TB_MAX_MEN) { tbEl.textContent = ''; return; }
        if (!tbCache.has(pos.fen)) {
            const res = await new Promise(resolve => {
                try {
                    chrome.runtime.sendMessage({tablebaseLookup: {fen: pos.fen, variant: 'chess'}}, (r) => {
                        resolve(chrome.runtime.lastError || !r || r.error ? null : r);
                    });
                } catch (e) { resolve(null); }
            });
            tbCache.set(pos.fen, res);
        }
        if (positions[cursor]?.fen !== pos.fen) return;
        const tb = tbCache.get(pos.fen);
        if (!tb || !tb.category) { tbEl.textContent = ''; return; }
        // side-to-move relative, exactly as lichess reports it; the count is moves, not plies
        const n = Math.abs(tb.dtm ?? tb.dtz ?? 0);
        const best = tb.moves?.[0]?.uci;
        const san = best ? sanOf(pos.fen, best) : '';
        const word = tb.category === 'win' ? `win in ${n}`
            : tb.category === 'loss' ? `lost in ${n}`
            : tb.category === 'draw' ? 'draw'
            : tb.category === 'cursed-win' ? `win in ${n} (50-move drawn)`
            : tb.category === 'blessed-loss' ? `lost in ${n} (50-move saved)` : tb.category;
        tbEl.textContent = `Tablebase: ${word}${san && tb.category !== 'draw' ? ` - ${san}` : ''}`;
    }
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
                const c = new Chess('chess', game.startFen || undefined);   // books are standard chess
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

// The move list is the TREE now. The mainline renders as the familiar numbered rows; wherever a
// node has more than one child, the alternatives render underneath as indented, parenthesised lines
// (each recursively carrying its own sub-variations). Every cell knows its node, so clicking any
// move -- mainline or buried three variations deep -- walks the board back into that line.
const nodeIndex = new Map();   // id -> node, rebuilt per render (the tree is tiny)

function moveNumberOf(node) {
    // the ply is the DEPTH, not an array index: variations share their depth with the mainline
    let ply = 0;
    for (let n = node; n.parent; n = n.parent) ply++;
    return {num: Math.ceil(ply / 2), white: ply % 2 === 1};
}

function varLineHtml(node) {
    // one variation: this node onward, down FIRST children, with sub-variations nested
    const parts = [];
    let n = node;
    let first = true;
    while (n) {
        const {num, white} = moveNumberOf(n);
        const prefix = white ? `${num}. ` : (first ? `${num}... ` : '');
        parts.push(`<span class="an-mcell an-vcell" data-node="${n.id}">${prefix}${esc(n.san || '')}</span>`);
        for (const alt of n.children.slice(1)) parts.push(`<span class="an-var">(${varLineHtml(alt)})</span>`);
        n = n.children[0];
        first = false;
    }
    return parts.join(' ');
}

function renderMoves() {
    const el = $('an_moves');
    if (!el) return;
    nodeIndex.clear();
    (function index(n) { nodeIndex.set(n.id, n); n.children.forEach(index); })(treeRoot);
    // the mainline of the tree (first children all the way), rendered in numbered pairs; a node
    // with siblings drops its variation block after the row the branching move appears in
    const main = [];
    for (let n = treeRoot.children[0]; n; n = n.children[0]) main.push(n);
    const rows = [];
    for (let i = 0; i < main.length; i += 2) {
        const w = main[i], b = main[i + 1];
        rows.push(`<div class="an-mrow"><span class="an-mnum">${Math.ceil((i + 1) / 2)}</span>`
            + `<span class="an-mcell" data-node="${w.id}">${esc(w?.san || '')}</span>`
            + `<span class="an-mcell" ${b ? `data-node="${b.id}"` : ''}>${esc(b?.san || '')}</span></div>`);
        for (const branchOwner of [w, b]) {
            if (!branchOwner?.parent) continue;
            for (const alt of branchOwner.parent.children.slice(1)) {
                // siblings of a MAINLINE move: the variations you could have played instead
                if (branchOwner.parent.children[0] !== branchOwner) continue;
                rows.push(`<div class="an-mrow an-vrow"><span class="an-mnum"></span>`
                    + `<span class="an-vline">(${varLineHtml(alt)})</span></div>`);
            }
        }
    }
    el.innerHTML = rows.join('')
        || '<div class="an-mrow"><span class="an-mnum"></span><span class="an-mcell">play a move</span><span></span></div>';
    el.querySelectorAll('[data-node]').forEach(c =>
        c.addEventListener('click', (e) => { e.stopPropagation(); goNode(nodeIndex.get(+c.dataset.node)); }));
}

function highlightMove() {
    document.querySelectorAll('.an-mcell.an-sel').forEach(e => e.classList.remove('an-sel'));
    const sel = document.querySelector(`.an-mcell[data-node="${treeNode?.id}"]`);
    if (sel) { sel.classList.add('an-sel'); sel.scrollIntoView({block: 'nearest'}); }
}

// ---- helpers ------------------------------------------------------------------------------------

function sanOf(fen, uci) {
    if (!uci) return '';
    try {
        const c = newChess(fen);
        const mv = uci.includes('@') ? c.move(uci.replace(/[+#]$/, ''))
                                     : c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        return mv ? mv.san : uci;
    } catch (e) { return uci; }
}

function pvText(fen, pv, n) {
    try {
        const c = newChess(fen);
        const out = [];
        for (const uci of (pv || []).slice(0, n)) {
            const mv = uci.includes('@') ? c.move(uci.replace(/[+#]$/, ''))
                                         : c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
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
