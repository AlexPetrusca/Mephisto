// The Analysis page. The floating panel is built for a live game -- small, out of the way, one
// engine at a time. Studying wants the opposite: a big board, the moves beside it, and BOTH
// answers at once -- what a human of a chosen rating would play, next to what the engine wants.
// That contrast is the whole point of the page, and it is why the human model is not a toggle
// here but a permanent second column.
//
// Everything expensive is shared rather than rebuilt: the engine drivers come from
// src/options/util/engines.js (the same ones Game Review uses), the arithmetic from review-core.js,
// and the board from panel-board.js. This file is layout, wiring and the per-position render.
import {define} from "../../framework/require.js";
import {SettingsPage} from "../../util/SettingsPage.js";

const Core = self.MephistoReviewCore;
const {ENGINES, MAIA_BANDS, makeEngine, nativeHostAvailable} = self.MephistoEngines;

const $ = (id) => document.getElementById(id);

// Its own settings, like the review's: an analysis depth is a different number from a live-play
// budget, and sharing one would silently make the other wrong. Depth 12 by default -- quick enough
// to step through a game move by move, which is what this page is for.
const CFG = {
    an_engine: 'stockfish-18-nnue',
    an_human: 'maia',
    an_maia_band: '1500',
    an_maia3_elo: 1500,
    an_multipv: 4,
    an_threads: 1,
    an_hash: 128,
};

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
let rig = null;          // {engine, human, opts}
let busy = false;        // one analysis at a time; a fast clicker must not stack searches
let queued = null;       // the ply asked for while busy, so the last click always wins
let evalCache = new Map();   // fen -> {lines, depth}
let humanCache = new Map();  // fen|band -> [{uci, prob}]
let bandCache = new Map();   // fen -> {band: [{uci, prob}]}
let tallies = {best: 0, mistake: 0, blunder: 0};

// ---- page ---------------------------------------------------------------------------------------

class AnalysisPage extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        fillEngineSelects();
        this.registerFormElement('an_engine', 'Engine:', 'select', CFG.an_engine);
        const human = this.registerFormElement('an_human', 'Human model:', 'select', CFG.an_human);
        this.registerFormElement('an_maia3_elo', 'Maia 3 rating:', 'input', CFG.an_maia3_elo);
        this.registerFormElement('an_multipv', 'Lines:', 'input', CFG.an_multipv);
        this.registerFormElement('an_threads', 'Threads:', 'input', CFG.an_threads);
        const syncMaia3 = () => {
            const row = $('an_maia3_row');
            if (row) row.style.display = human.getValue() === 'maia3' ? '' : 'none';
        };
        human.registerChangeListener(() => { syncMaia3(); dropRig(); });
        syncMaia3();
        // any engine-shaping setting invalidates the running engine and the cached numbers
        for (const k of ['an_engine', 'an_multipv', 'an_threads', 'an_maia3_elo']) {
            const el = document.getElementById(`${k}_${k === 'an_engine' ? 'select' : 'input'}`);
            el?.addEventListener('change', () => { dropRig(); evalCache.clear(); humanCache.clear(); bandCache.clear(); });
        }

        // the toolbar mirrors the settings below it: same keys, either place, both directions
        const band = $('an_tb_band');
        if (band && !band.options.length) {
            band.innerHTML = MAIA_BANDS.map(b => `<option value="${b}">Maia ${b}</option>`).join('')
                + '<option value="">Human model off</option>';
        }
        const tb = [['an_tb_lines', 'an_multipv']];
        for (const [tbId, key] of tb) {
            const el = $(tbId);
            if (!el) continue;
            el.value = cfg(key);
            el.addEventListener('change', () => {
                const v = Math.max(1, parseInt(el.value) || cfg(key));
                setCfg(key, v);
                const twin = $(`${key}_input`);
                if (twin) { twin.value = v; }
                dropRig(); evalCache.clear(); humanCache.clear(); bandCache.clear();
                go(cursor);
            });
        }
        if (band) {
            band.value = cfg('an_human') ? String(cfg('an_maia_band')) : '';
            band.addEventListener('change', () => {
                if (band.value) { setCfg('an_human', 'maia'); setCfg('an_maia_band', band.value); }
                else setCfg('an_human', '');
                dropRig(); humanCache.clear(); bandCache.clear();
                go(cursor);
            });
        }
        $('an_tb_paste')?.addEventListener('click', async () => {
            try {
                const text = (await navigator.clipboard.readText() || '').trim();
                if (!text) return status('The clipboard is empty.', 'err');
                // a FEN is one line with slashes; anything else is treated as a game
                if (/^[rnbqkpRNBQKP1-8\/]+\s+[wb]\s/.test(text)) { $('an_fen').value = text; $('an_pgn').value = ''; }
                else { $('an_pgn').value = text; $('an_fen').value = ''; }
                loadFromInputs();
            } catch (e) { status('Could not read the clipboard: ' + (e.message || e), 'err'); }
        });
        $('an_load')?.addEventListener('click', () => loadFromInputs());
        $('an_start')?.addEventListener('click', () => { $('an_pgn').value = ''; $('an_fen').value = ''; loadStart(); });
        $('an_sample')?.addEventListener('click', () => {
            $('an_pgn').value = SAMPLE;
            $('an_fen').value = '';
            loadFromInputs();
        });
        $('an_first')?.addEventListener('click', () => go(0));
        $('an_prev')?.addEventListener('click', () => go(cursor - 1));
        $('an_next')?.addEventListener('click', () => go(cursor + 1));
        $('an_last')?.addEventListener('click', () => go(positions.length - 1));
        $('an_flip')?.addEventListener('click', () => { flipped = !flipped; ensureBoard(true); render(); });
        document.addEventListener('keydown', onKey);
        // THE PAGE LOADER HAS NO onLeave HOOK (options.js injects a page and forgets the last one),
        // so the engines this page starts would keep their offscreen clients and their threads
        // after you navigated away. Watch the route instead: the moment the hash is not ours, drop
        // the rig and unhook. Cheap, and it cannot leak an engine into the rest of the session.
        const onRoute = () => {
            if (location.hash.startsWith('#analysis')) return;
            dropRig();
            boardResizeObs?.disconnect();
            boardResizeObs = null;
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('hashchange', onRoute);
        };
        window.addEventListener('hashchange', onRoute);
        loadStart();
        watchBoardSize();
        // one deferred rebuild for the same reason: the first paint can land before the page's
        // stylesheet is back on, and the board would keep that first, wrong width
        requestAnimationFrame(() => { ensureBoard(true); render(); });
    }
}

const SAMPLE = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';

function onKey(e) {
    if (!$('an_board') || /input|textarea|select/i.test(e.target?.tagName || '')) return;
    if (e.key === 'ArrowLeft') { go(cursor - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { go(cursor + 1); e.preventDefault(); }
}

function fillEngineSelects() {
    const es = $('an_engine_select');
    if (es && !es.options.length) {
        es.innerHTML = ENGINES.map(e => `<option value="${e.id}">${e.label}</option>`).join('');
        // a native engine that is not installed would sit at "thinking" forever; disable what is absent
        for (const e of ENGINES.filter(x => x.kind === 'native')) {
            nativeHostAvailable(e.id).then(ok => {
                const opt = [...es.options].find(o => o.value === e.id);
                if (opt && !ok) { opt.disabled = true; opt.text = `${e.label} (not installed)`; }
            });
        }
    }
    const hs = $('an_human_select');
    if (hs && !hs.options.length) {
        hs.innerHTML = '<option value="maia">Maia 1 (rating band)</option>'
            + '<option value="maia3">Maia 3 (rating dial)</option>'
            + '<option value="">None</option>';
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
    tallies = {best: 0, mistake: 0, blunder: 0};
    ensureBoard(true);
    renderMoves();
    render();
    go(0);
}

function loadFromInputs() {
    const fen = ($('an_fen')?.value || '').trim();
    const pgn = ($('an_pgn')?.value || '').trim();
    try {
        if (fen) {
            // chess.js does NOT reliably throw on junk (found 2026-08-15: 'not a fen at all' was
            // accepted and the page happily analysed the start position instead of saying no), so
            // the shape is checked here first: six fields, eight ranks, a side to move.
            const parts = fen.split(/\s+/);
            const ranks = (parts[0] || '').split('/');
            if (parts.length < 4 || ranks.length !== 8 || !/^[wb]$/.test(parts[1] || '')
                || !/^[rnbqkpRNBQKP1-8]+$/.test(parts[0])) {
                throw new Error('that does not look like a FEN');
            }
            const c = new Chess('chess', fen);
            positions = [{fen: c.fen(), turn: c.turn(), san: null, uci: null}];
        } else if (pgn) {
            const game = Core.parsePgn(pgn)[0];
            if (!game) throw new Error('no game found in that PGN');
            const c = new Chess('chess', game.startFen || undefined);
            positions = [{fen: c.fen(), turn: c.turn(), san: null, uci: null}];
            for (const rec of game.moves) {
                // parsePgn yields RECORDS ({san, clk, eval, comment}), not bare strings -- passing
                // the record to chess.js fails with "Invalid move: {...}", which is exactly how this
                // was found (the sample game refused to load while the start position analysed fine).
                const san = typeof rec === 'string' ? rec : rec.san;
                const mv = c.move(san);
                if (!mv) throw new Error(`illegal move in the PGN: ${san}`);
                positions.push({fen: c.fen(), turn: c.turn(), san: mv.san,
                                uci: mv.from + mv.to + (mv.promotion || '')});
            }
        } else {
            return loadStart();
        }
    } catch (e) {
        status(String(e.message || e), 'err');
        return;
    }
    cursor = 0;
    tallies = {best: 0, mistake: 0, blunder: 0};
    evalCache.clear(); humanCache.clear(); bandCache.clear();
    ensureBoard(true);
    renderMoves();
    // SAY WHAT WAS UNDERSTOOD. The PGN parser is lenient by design -- it keeps the move tokens it
    // recognises and drops the rest -- so a mistyped or half-copied game loads as a SHORTER game
    // rather than as an error. Silently analysing three moves of a forty-move paste is the worst
    // of both, so the count is reported every time and a suspiciously short game says so.
    const n = positions.length - 1;
    if (!fen) {
        status(n === 0 ? 'No moves were understood in that text.'
             : n < 3 ? `Only ${n} move${n === 1 ? '' : 's'} understood -- check the text.`
             : `Loaded ${n} moves.`, n === 0 ? 'err' : undefined);
    }
    go(0);
}

// ---- the engines --------------------------------------------------------------------------------

async function ensureRig() {
    if (rig) return rig;
    const opts = {
        variant: 'chess',
        // the fallback budget for a NATIVE host, which answers a whole search rather than
        // streaming one; the WASM path ignores this and runs `go infinite` (see startInfinite)
        limitKind: 'depth',
        limitValue: 22,
        multipv: Math.max(1, +cfg('an_multipv')),
        threads: Math.max(1, +cfg('an_threads')),
        hash: Math.max(16, +cfg('an_hash')),
    };
    const engine = makeEngine(cfg('an_engine'), opts, 'analysis');
    await engine.start();
    let human = null;
    const kind = cfg('an_human');
    if (kind) {
        const level = kind === 'maia3' ? String(cfg('an_maia3_elo')) : String(cfg('an_maia_band'));
        // Its own client id: it runs ALONGSIDE the analysis engine, and the offscreen host disposes
        // whatever shares an id (the trap the review found the hard way).
        human = makeEngine(kind, {...opts, multipv: 5, maiaLevel: level}, 'analysis-human');
        try { await human.start(); }
        catch (e) { human = null; status(`Human model unavailable (${e.message})`, 'err'); }
    }
    rig = {engine, human, opts};
    return rig;
}

function dropRig() {
    stopSearch();
    if (!rig) return;
    try { rig.engine.dispose?.(); } catch (e) { /* */ }
    try { rig.human?.dispose?.(); } catch (e) { /* */ }
    rig = null;
}

// ---- stepping -----------------------------------------------------------------------------------

function go(ply) {
    if (!positions.length) return;
    cursor = Core.clamp(ply, 0, positions.length - 1);
    render();                     // instant: board, move list, whatever is already known
    analyseCurrent();             // stops the running search and starts this position's
}

// THE ENGINE NEVER STOPS ON ITS OWN (3.1.254, user call): an analysis board thinks about the
// position in front of you until you move on, the way every analysis board does. There is no depth
// setting here for the same reason -- the answer is "as deep as you leave it". Moving to another
// position stops the search and starts the next one; the numbers reached so far are kept, so
// stepping back to a position you have already looked at shows what it had found.
let liveSearch = null;

async function analyseCurrent() {
    const at = cursor;
    const pos = positions[at];
    if (!pos) return;
    stopSearch();
    let r;
    try {
        r = await ensureRig();
    } catch (e) {
        return status(String(e.message || e), 'err');
    }
    if (cursor !== at) return;                       // the user moved on while the engine loaded
    const meta0 = $('an_engine_meta');
    if (meta0) meta0.textContent = 'thinking…';
    liveSearch = r.engine.startInfinite(pos.fen, pos.turn, (res) => {
        if (cursor !== at) return;
        evalCache.set(pos.fen, res);
        updateTallies(at);
        renderBars(pos, res);
        renderLines(pos, res, humanCache.get(`${pos.fen}|${bandKey()}`));
        renderArrows(pos, res, humanCache.get(`${pos.fen}|${bandKey()}`));
        renderTallies();
        // the running depth belongs WITH the engine's lines, not in the page's notice line: it
        // used to overwrite whatever the page had just told you (a refused FEN, how many moves
        // loaded), which made those messages last about a second
        const meta = $('an_engine_meta');
        if (meta) meta.textContent = `depth ${res.depth}${res.nodes ? ` · ${(res.nodes / 1000).toFixed(0)}k` : ''}`;
    });
    // the human model answers once -- it is a single forward pass, there is nothing to deepen
    if (r.human) {
        humanFor(r, pos).then(() => { if (cursor === at) render(); }).catch(() => {});
    }
    renderBands(pos);
}

function stopSearch() {
    if (!liveSearch) return;
    try { liveSearch.stop(); } catch (e) { /* engine already gone */ }
    liveSearch = null;
}

function humanCacheKey(fen) { return humanCache.has(`${fen}|${bandKey()}`); }
function bandKey() { return cfg('an_human') === 'maia3' ? `m3-${cfg('an_maia3_elo')}` : `m1-${cfg('an_maia_band')}`; }

async function humanFor(r, pos) {
    const key = `${pos.fen}|${bandKey()}`;
    if (humanCache.has(key)) return humanCache.get(key);
    const res = await r.human.analyse(pos.fen, pos.turn);
    // Maia scores every line at depth 1; its ORDER is the human likelihood, and the cp values are
    // its own confidence. Normalised here so the column reads as probabilities, which is what the
    // number means to a person looking at it.
    const raw = (res.lines || []).filter(l => l.pv?.[0]);
    const weights = raw.map((l, i) => Math.max(0.0001, Math.exp(-i * 0.9)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const out = raw.map((l, i) => ({uci: l.pv[0], prob: weights[i] / total}));
    humanCache.set(key, out);
    return out;
}

// The played move's verdict, for the tallies beside the move list. Only counts a ply once, and only
// when both positions have been analysed -- a tally built on half the data is worse than none.
function updateTallies(at) {
    if (at < 1) return;
    const before = positions[at - 1], after = positions[at];
    const b = evalCache.get(before.fen), a = evalCache.get(after.fen);
    if (!b || !a || !b.lines?.length || !a.lines?.length) return;
    const sign = before.turn === 'w' ? 1 : -1;
    const winBefore = Core.winPercent(b.lines[0].cp * sign);
    const winAfter = Core.winPercent(a.lines[0].cp * sign);
    const lost = Math.max(0, winBefore - winAfter);
    const key = `t${at}`;
    if (updateTallies[key]) return;
    updateTallies[key] = true;
    if (b.lines[0].pv?.[0] === after.uci) tallies.best++;
    else if (lost >= 20) tallies.blunder++;
    else if (lost >= 10) tallies.mistake++;
}

// ---- rendering ----------------------------------------------------------------------------------

// The board renderer sizes itself ONCE, from the width of its host at build time. Coming back to
// this page re-injects the markup while the page's stylesheet is still disabled (options.js
// re-enables the cached sheet around the same tick), so the host is briefly full-width and the
// board is built that size and stays it -- a board twice as wide as its column, with the move list
// pushed underneath. Watch the wrapper instead and rebuild whenever its width really changes;
// that covers the re-entry race and an ordinary window resize with the same three lines.
let boardResizeObs = null;
function watchBoardSize() {
    if (boardResizeObs || typeof ResizeObserver === 'undefined') return;
    const wrap = document.querySelector('.an-board-wrap');
    if (!wrap) return;
    let last = Math.round(wrap.getBoundingClientRect().width);
    boardResizeObs = new ResizeObserver(() => {
        const w = Math.round(wrap.getBoundingClientRect().width);
        if (!w || Math.abs(w - last) < 3) return;
        last = w;
        ensureBoard(true);
        render();
    });
    boardResizeObs.observe(wrap);
}

function ensureBoard(rebuild) {
    const host = $('an_board');
    if (!host) return;
    if (board && !rebuild) return;
    host.innerHTML = '';
    const [set, ext] = String(MephistoConfig.get('pieces') ? JSON.parse(MephistoConfig.get('pieces')) : 'wikipedia.svg').split('.');
    board = MephistoBoard(host, {
        position: positions[cursor]?.fen || 'start',
        pieceTheme: `/res/chesspieces/${set}/{piece}.${ext}`,
        showNotation: true,
        orientation: flipped ? 'black' : 'white',
    });
}

function render() {
    const pos = positions[cursor];
    if (!pos) return;
    ensureBoard(false);
    board?.position(pos.fen);
    const ev = evalCache.get(pos.fen);
    const human = humanCache.get(`${pos.fen}|${bandKey()}`);
    renderBars(pos, ev);
    renderLines(pos, ev, human);
    renderArrows(pos, ev, human);
    renderBands(pos);
    renderTallies();
    highlightMove();
}

function renderBars(pos, ev) {
    const cp = ev?.lines?.[0]?.cp;
    const win = cp == null ? 50 : Core.winPercent(cp);      // always white-relative
    const fill = $('an_winfill'), label = $('an_winlabel');
    if (fill) fill.style.height = `${Core.clamp(win, 0, 100)}%`;
    if (label) label.textContent = cp == null ? '—' : `${win.toFixed(1)}%`;
    const ef = $('an_evalfill'), el = $('an_evallabel');
    // the eval bar is the engine's own number, squashed to the bar with the same curve the panel uses
    const pct = cp == null ? 50 : Core.clamp(50 + 50 * Math.tanh(cp / 400), 0, 100);
    if (ef) ef.style.height = `${pct}%`;
    if (el) el.textContent = cp == null ? '—'
        : (Core.isMateScore(cp) ? (cp > 0 ? 'M' : '-M') : (cp / 100).toFixed(1));
}

const RANK_COLOURS = ['#3fa45b', '#5c8bb0', '#a88865', '#8f8f8f', '#7f8b95'];

function renderLines(pos, ev, human) {
    const eng = $('an_engine_lines');
    if (eng) {
        const lines = (ev?.lines || []).slice(0, Math.max(1, +cfg('an_multipv')));
        eng.innerHTML = lines.length ? lines.map((l, i) => {
            const cp = l.cp * (pos.turn === 'w' ? 1 : -1);   // mover-relative, like every UI shows it
            const val = Core.isMateScore(l.cp) ? (cp > 0 ? '#' : '-#') : (cp / 100).toFixed(2);
            const width = Core.clamp(Core.winPercent(l.cp * (pos.turn === 'w' ? 1 : -1)), 2, 100);
            return `<div class="an-lrow ${i === 0 ? 'an-top' : ''}" style="--an-rank:${RANK_COLOURS[Math.min(i, 4)]}">
                <span class="an-lrank">${i + 1}</span>
                <span class="an-lmove">${esc(sanOf(pos.fen, l.pv?.[0]))}${l.pv?.[1] ? ` <span class="an-lval">${esc(pvText(pos.fen, l.pv, 4))}</span>` : ''}</span>
                <span class="an-lval">${val}</span>
                <span class="an-lbar"><i style="width:${width}%"></i></span>
            </div>`;
        }).join('') : `<div class="an-lrow"><span></span><span class="an-lval">thinking…</span><span></span></div>`;
    }
    const hum = $('an_human_lines');
    if (hum) {
        const title = $('an_human_title');
        if (title) title.textContent = cfg('an_human') === 'maia3'
            ? `Human ${cfg('an_maia3_elo')}` : (cfg('an_human') ? `Human ${cfg('an_maia_band')}` : 'Human model off');
        hum.innerHTML = (human && human.length) ? human.map((h, i) => `
            <div class="an-lrow ${i === 0 ? 'an-top' : ''}" style="--an-rank:#a8657f">
                <span class="an-lrank">${i + 1}</span>
                <span class="an-lmove">${esc(sanOf(pos.fen, h.uci))}</span>
                <span class="an-lval">${(h.prob * 100).toFixed(1)}%</span>
                <span class="an-lbar"><i style="width:${Core.clamp(h.prob * 100, 2, 100)}%"></i></span>
            </div>`).join('')
            : `<div class="an-lrow"><span></span><span class="an-lval">${cfg('an_human') ? 'thinking…' : 'off'}</span><span></span></div>`;
    }
}

// Both engines on the board at once: the engine's lines numbered like the review's, the human
// model's first choice in its own colour, so agreement and disagreement are visible at a glance.
function renderArrows(pos, ev, human) {
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
    (ev?.lines || []).slice(0, Math.max(1, +cfg('an_multipv'))).forEach((l, i) => {
        if (!l.pv?.[0]) return;
        out.push(arrow(l.pv[0], RANK_COLOURS[Math.min(i, 4)], Math.max(0.08, 0.15 - i * 0.02),
                       Math.max(0.35, 0.85 - i * 0.15), i + 1));
    });
    if (human?.[0]) out.push(arrow(human[0].uci, '#a8657f', 0.12, 0.8, null));
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
        const px = a.x + ux * 0.62 - uy * 0.20, py = a.y + uy * 0.62 + ux * 0.20;
        tag = `<circle cx="${px}" cy="${py}" r="0.16" fill="${colour}" stroke="#00000040" stroke-width="0.015"/>`
            + `<text x="${px}" y="${py + 0.06}" font-size="0.2" font-weight="700" text-anchor="middle" `
            + `fill="#fff" font-family="system-ui,sans-serif">${rank}</text>`;
    }
    return `<g opacity="${opacity}" stroke-linejoin="round">`
        + `<line x1="${sx}" y1="${sy}" x2="${bx}" y2="${by}" stroke="${colour}" stroke-width="${width}" stroke-linecap="round"/>`
        + `<polygon points="${pts}" fill="${colour}"/>${tag}</g>`;
}

// How the choice changes with strength: the same position asked of several Maia bands. Computed
// lazily and only for Maia 1 (Maia 3 is one net with a dial, so there are no bands to compare).
// EVERY band, in 100-Elo steps (user call 2026-08-15). Maia 1 ships one net per band from 1100 to
// 2200; Maia 3 is a single net with a rating input, so its dial is swept from 600 to 2600 -- far
// cheaper, since it loads once and is asked twenty-one times.
const MAIA1_STEPS = MAIA_BANDS.slice();
const MAIA3_STEPS = Array.from({length: 21}, (_, i) => String(600 + i * 100));

let bandRun = 0;   // cancels a sweep whose position is no longer on the board

async function renderBands(pos) {
    const wrap = $('an_bands_wrap'), host = $('an_bands');
    if (!wrap || !host) return;
    const kind = cfg('an_human');
    if (!kind) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const steps = kind === 'maia3' ? MAIA3_STEPS : MAIA1_STEPS;
    const key = `${pos.fen}|${kind}`;
    const run = ++bandRun;
    if (!bandCache.has(key)) {
        const acc = {};
        // Maia 3 is ONE net asked at many ratings: load it once and sweep the dial. Maia 1 is one
        // net PER band, so each step pays a load -- which is why its sweep is the slower of the two.
        let shared = null;
        try {
            if (kind === 'maia3') {
                shared = makeEngine('maia3', {variant: 'chess', multipv: 3, maiaLevel: steps[0],
                                              limitKind: 'depth', limitValue: 1, threads: 1, hash: 16},
                                    'analysis-band');
                await shared.start();
            }
            for (let i = 0; i < steps.length; i++) {
                const band = steps[i];
                if (run !== bandRun || positions[cursor]?.fen !== pos.fen) { shared?.dispose?.(); return; }
                host.innerHTML = `<div class="an-lrow"><span></span><span class="an-lval">reading the bands… ${i + 1}/${steps.length}</span><span></span></div>`;
                try {
                    let e = shared;
                    if (!e) {
                        e = makeEngine('maia', {variant: 'chess', multipv: 3, maiaLevel: band,
                                                limitKind: 'depth', limitValue: 1, threads: 1, hash: 16},
                                       `analysis-band-${band}`);
                        await e.start();
                    } else {
                        e.send(`setoption name UCI_Elo value ${band}`);   // Maia 3's rating dial
                    }
                    const r = await e.analyse(pos.fen, pos.turn);
                    acc[band] = (r.lines || []).filter(l => l.pv?.[0]).slice(0, 3)
                        .map((l, idx) => ({uci: l.pv[0], prob: [0.6, 0.28, 0.12][idx]}));
                    if (!shared) e.dispose?.();
                } catch (err) { acc[band] = []; }
            }
        } finally { shared?.dispose?.(); }
        if (run !== bandRun) return;
        bandCache.set(key, acc);
    }
    const acc = bandCache.get(key) || {};
    // one row per move any band likes, one cell per band, ordered by how often it is chosen
    const counts = new Map();
    for (const b of steps) for (const x of (acc[b] || [])) counts.set(x.uci, (counts.get(x.uci) || 0) + x.prob);
    const moves = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 6);
    const cols = `grid-template-columns: repeat(${steps.length}, 1fr)`;
    // only every other label when the sweep is long, or the axis becomes a smear
    const labelEvery = steps.length > 12 ? 2 : 1;
    host.innerHTML = moves.map(uci => `
        <div class="an-band-row">
            <span class="an-band-move">${esc(sanOf(pos.fen, uci))}</span>
            <div class="an-band-cells" style="${cols}">
                ${steps.map(b => {
                    const hit = (acc[b] || []).find(x => x.uci === uci);
                    const pct = hit ? Math.round(hit.prob * 100) : 0;
                    return `<div class="an-band-cell" title="${b}: ${pct}%"><i style="width:${pct}%"></i></div>`;
                }).join('')}
            </div>
        </div>`).join('')
        + `<div class="an-band-row"><span></span><div class="an-band-axis" style="${cols}">`
        + steps.map((b, i) => `<span>${i % labelEvery ? '' : b}</span>`).join('') + '</div></div>';
}

function renderTallies() {
    const el = $('an_tallies');
    if (!el) return;
    el.innerHTML = `
        <div class="an-tally rv-c-best"><b>${tallies.best}</b><span>best</span></div>
        <div class="an-tally rv-c-mistake"><b>${tallies.mistake}</b><span>mistakes</span></div>
        <div class="an-tally rv-c-blunder"><b>${tallies.blunder}</b><span>blunders</span></div>`;
}

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
    el.innerHTML = rows.join('') || '<div class="an-mrow"><span class="an-mnum"></span><span class="an-mcell">no moves</span><span></span></div>';
    el.querySelectorAll('.an-mcell[data-ply]').forEach(c =>
        c.addEventListener('click', () => go(+c.dataset.ply)));
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
