// Maia engine for the offscreen host: a UCI-speaking adapter that runs ONE onnxruntime-web forward
// pass of an lc0 Maia net (no lc0, no search). Same {uci, listen, onError, terminate} interface as
// the Stockfish engines, so popup.js drives it identically. Encoding/decoding verified against lc0
// itself at 99.6% move-match (see maia-prototype/STATUS.md). Loaded via dynamic import from
// offscreen.js. Uses the global `self.Chess` (repo chess.js, loaded in offscreen.html) for legal
// moves + history replay.
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

// ort env (threads, wasm paths) is configured ONCE in ort-env.js, shared by every session
// creator so the thread count cannot depend on which module happened to load first.
import '/src/offscreen/ort-env.js';

// ---- lc0 canonical 1858 policy index (harvested from lc0; ships as JSON) -----------------------
let moveToIdx = null;
async function loadTable() {
    if (moveToIdx) return;
    const arr = await fetch('/lib/engine/maia/lc0_policy_index.json').then(r => r.json());
    moveToIdx = new Map(arr.map((m, i) => [m, i]).filter(([m]) => m));
}

// ---- input encoding: lc0 classic 112-plane (verified) ------------------------------------------
const PLANE = 64, HIST = 8, PER_POS = 13, AUX = 104, TOTAL = 112;
const PIECE_IDX = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

function parseFen(fen) {
    const [placement, stm, castle, , halfmove] = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    let r = 7, f = 0;
    for (const ch of placement) {
        if (ch === '/') { r--; f = 0; }
        else if (/\d/.test(ch)) f += +ch;
        else { board[r * 8 + f] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() }; f++; }
    }
    return {
        board, stm,
        castle: { K: castle.includes('K'), Q: castle.includes('Q'), k: castle.includes('k'), q: castle.includes('q') },
        rule50: parseInt(halfmove) || 0,
    };
}

function fillPlane(out, n, v) { const b = (AUX + n) * PLANE; for (let i = 0; i < PLANE; i++) out[b + i] = v; }

// positions: parsed FENs, MOST RECENT FIRST. Up to 8 used; older zero-filled. Rank-flip for black.
function encode(positions) {
    const out = new Float32Array(TOTAL * PLANE);
    const cur = positions[0];
    const black = cur.stm === 'b';
    const persp = (sqi) => { const f = sqi % 8; let rr = (sqi / 8) | 0; if (black) rr = 7 - rr; return rr * 8 + f; };
    for (let h = 0; h < HIST && h < positions.length; h++) {
        const pos = positions[h], base = h * PER_POS * PLANE;
        for (let sqi = 0; sqi < 64; sqi++) {
            const pc = pos.board[sqi];
            if (!pc) continue;
            const planeNo = (pc.color === cur.stm ? 0 : 6) + PIECE_IDX[pc.type];
            out[base + planeNo * PLANE + persp(sqi)] = 1.0;
        }
    }
    const usK = cur.stm === 'w' ? cur.castle.K : cur.castle.k;
    const usQ = cur.stm === 'w' ? cur.castle.Q : cur.castle.q;
    const themK = cur.stm === 'w' ? cur.castle.k : cur.castle.K;
    const themQ = cur.stm === 'w' ? cur.castle.q : cur.castle.Q;
    if (usQ) fillPlane(out, 0, 1); if (usK) fillPlane(out, 1, 1);
    if (themQ) fillPlane(out, 2, 1); if (themK) fillPlane(out, 3, 1);
    if (black) fillPlane(out, 4, 1);
    fillPlane(out, 5, cur.rule50);
    fillPlane(out, 7, 1);
    return out;
}

// ---- decoding (verified) -----------------------------------------------------------------------
const CASTLE = { e1g1: 'e1h1', e1c1: 'e1a1', e8g8: 'e8h8', e8c8: 'e8a8' }; // lc0 = king-to-rook
function toPerspUci(uci, black) {
    uci = CASTLE[uci] || uci;
    const flip = (s) => black ? s[0] + (9 - +s[1]) : s;
    return flip(uci.slice(0, 2)) + flip(uci.slice(2, 4)) + (uci[4] || '');
}
// Rank every legal move by the net's policy (softmax over the legal subset). Returns
// [[uci, prob], ...] best-first -- the top is the move to play; the rest are the multi-PV candidates.
function scoreMoves(logits, legalUcis, black) {
    const scored = [];
    for (const uci of legalUcis) {
        const idx = moveToIdx.get(toPerspUci(uci, black));
        if (idx !== undefined) scored.push([uci, logits[idx]]);
    }
    if (!scored.length) return [[legalUcis[0], 1]];
    const mx = Math.max(...scored.map(s => s[1]));
    let sum = 0; for (const s of scored) { s[2] = Math.exp(s[1] - mx); sum += s[2]; }
    for (const s of scored) s[1] = s[2] / sum;
    scored.sort((a, b) => b[1] - a[1]);
    return scored;
}
function valueToCp(wdl) {
    let win = (Array.isArray(wdl) && wdl.length === 3) ? wdl[0] + wdl[1] / 2 : (wdl[0] + 1) / 2;
    win = Math.min(0.9999, Math.max(0.0001, win));
    return Math.round(-Math.log10(1 / win - 1) * 400);
}

// ---- the UCI adapter ---------------------------------------------------------------------------
export async function createMaiaEngine(level, listen) {
    await loadTable();
    const Chess = self.Chess;
    // fetch the net bytes ourselves (like fetchNnue) and hand ort the buffer -- more robust than
    // letting ort fetch a URL from inside the offscreen doc, and matches the rest of the host.
    const bytes = new Uint8Array(await fetch(`/lib/engine/maia/maia-${level}.onnx`).then(r => r.arrayBuffer()));
    const session = await ort.InferenceSession.create(bytes);
    console.log(`[Maia] net maia-${level} loaded (${bytes.length} bytes), onnxruntime ready`);

    let history = [], legalUcis = [], black = false, multipv = 1;

    function setPosition(fen, moves) {
        const chess = new Chess('chess', fen || undefined);
        const fens = [chess.fen()];
        for (const uci of (moves || '').split(/\s+/).filter(Boolean)) {
            chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
            fens.push(chess.fen());
        }
        history = fens.reverse().map(parseFen);
        black = history[0].stm === 'b';
        legalUcis = chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    }

    async function go() {
        if (!legalUcis.length) { listen('bestmove (none)'); return; }
        const t0 = performance.now();
        const out = await session.run({ '/input/planes': new ort.Tensor('float32', encode(history.slice(0, 8)), [1, 112, 8, 8]) });
        const scored = scoreMoves(out['/output/policy'].data, legalUcis, black);
        const cp = valueToCp(Array.from(out['/output/wdl'].data)); // one position eval (same for every line)
        // Emit one info line per requested line, ranked by human-likelihood. The multipv field is
        // REQUIRED: without it the panel's activeLines goes NaN and no arrows draw. BEST-FIRST
        // (multipv 1 first): the panel resets last_eval.lines when it sees multipv 1, so it must
        // arrive before lines 2..N or they get wiped (which left only one arrow/line showing).
        const n = Math.min(multipv, scored.length);
        for (let i = 0; i < n; i++)
            listen(`info depth 1 multipv ${i + 1} score cp ${cp} pv ${scored[i][0]}`);
        console.log(`[Maia] level ${level} played ${scored[0][0]} (${(scored[0][1] * 100).toFixed(1)}%) — net pass ${(performance.now() - t0).toFixed(1)}ms`);
        listen(`bestmove ${scored[0][0]}`);
    }

    return {
        uci(line) {
            line = line.trim();
            if (line === 'uci') { listen('id name Maia'); listen('uciok'); }
            else if (line === 'isready') listen('readyok');
            else if (line.startsWith('setoption')) {
                const m = /name\s+MultiPV\s+value\s+(\d+)/i.exec(line);
                if (m) multipv = Math.max(1, parseInt(m[1]) || 1);
            }
            else if (line.startsWith('position')) {
                const fenM = /position\s+fen\s+(.+?)(?:\s+moves\s+(.*))?$/.exec(line);
                const startM = /position\s+startpos(?:\s+moves\s+(.*))?$/.exec(line);
                if (fenM) setPosition(fenM[1], fenM[2]);
                else if (startM) setPosition(null, startM[1]);
            }
            else if (line.startsWith('go')) go().catch(e => listen(`info string maia error ${e}`));
            // ucinewgame/stop/quit: no-ops (single pass, no search state)
        },
        terminate() { try { session.release && session.release(); } catch (e) { /* */ } },
    };
}
