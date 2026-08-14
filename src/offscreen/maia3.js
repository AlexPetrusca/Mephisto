// Maia-3 (Chessformer) engine for the offscreen host: a UCI-speaking adapter running one
// onnxruntime-web forward pass of the Maia-3 transformer. Unlike Maia-1 (per-rating conv nets), this
// is ONE model conditioned on a raw target Elo (600-2600), so strength is a live input, not a net
// swap. Encoding/decoding verified byte-identical + 100% move-match vs the CSSLab/maia3 reference
// (see maia-prototype/maia3/). Same {uci, listen, terminate} interface as the other engines; uses
// global self.Chess (repo chess.js) for legal moves.
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

// ort env (threads, wasm paths) is configured ONCE in ort-env.js, shared by every session
// creator so the thread count cannot depend on which module happened to load first.
import '/src/offscreen/ort-env.js';

// ---- encoding (replicates maia3/dataset.py + utils.py) -----------------------------------------
const PIECE = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const HISTORY = 8, PIECE_CH = 12, TOKEN_DIM = HISTORY * PIECE_CH + 1; // 97

function parseFen(fen) {
    const [placement, turn] = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    let rank = 7, file = 0;
    for (const ch of placement) {
        if (ch === '/') { rank--; file = 0; }
        else if (/\d/.test(ch)) file += +ch;
        else { board[rank * 8 + file] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() }; file++; }
    }
    return { board, turn };
}

// (1,64,97) flat: the current position tokenized (mirrored square^56 + colour-swap for black),
// repeated over the 8 history slots, + a 0 clock channel. Matches use_uci_history=False default.
function encode(fen) {
    const { board, turn } = parseFen(fen);
    const black = turn === 'b';
    const tok = new Float32Array(64 * 12);
    for (let sq = 0; sq < 64; sq++) {
        const pc = board[sq];
        if (!pc) continue;
        const sqM = black ? (sq ^ 56) : sq;
        const color = black ? (pc.color === 'w' ? 'b' : 'w') : pc.color;
        tok[sqM * 12 + (color === 'w' ? 0 : 6) + PIECE[pc.type]] = 1.0;
    }
    const out = new Float32Array(64 * TOKEN_DIM);
    for (let sq = 0; sq < 64; sq++)
        for (let h = 0; h < HISTORY; h++)
            for (let c = 0; c < PIECE_CH; c++)
                out[sq * TOKEN_DIM + h * PIECE_CH + c] = tok[sq * 12 + c];
    return out;
}

// move vocab: every from->to square pair (4096) + white promotions (256) = 4352, exact order
function buildVocab() {
    const F = 'abcdefgh', name = (f, r) => F[f] + (r + 1), m = [];
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++)
        for (let tr = 0; tr < 8; tr++) for (let tf = 0; tf < 8; tf++) m.push(name(f, r) + name(tf, tr));
    for (const ff of F) for (const tt of F) for (const p of 'qrbn') m.push(`${ff}7${tt}8${p}`);
    return m;
}
const MOVE_TO_IDX = new Map(buildVocab().map((m, i) => [m, i]));
const mirrorMove = (u) => { const fl = (s) => s[0] + (9 - +s[1]); return fl(u.slice(0, 2)) + fl(u.slice(2, 4)) + (u[4] || ''); };

function wdlToCp(wdl) {                    // [loss, draw, win] logits (side to move) -> centipawns
    const m = Math.max(...wdl), e = wdl.map(v => Math.exp(v - m)), s = e[0] + e[1] + e[2];
    let win = (e[2] + e[1] / 2) / s;
    win = Math.min(0.9999, Math.max(0.0001, win));
    return Math.round(-Math.log10(1 / win - 1) * 400);
}

// ---- adapter -----------------------------------------------------------------------------------
export async function createMaia3Engine(listen, initialElo) {
    const Chess = self.Chess;
    const bytes = new Uint8Array(await fetch('/lib/engine/maia3/maia3-23m.onnx').then(r => r.arrayBuffer()));
    const session = await ort.InferenceSession.create(bytes);
    console.log(`[Maia-3] 23M model loaded (${bytes.length} bytes), onnxruntime ready`);

    let fen = null, moves = '', selfElo = initialElo || 1500, oppoElo = initialElo || 1500, multipv = 1;

    async function go() {
        const chess = new Chess('chess', fen || undefined);
        for (const u of (moves || '').split(/\s+/).filter(Boolean))
            chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        const cur = chess.fen();
        const legal = chess.moves({ verbose: true }).map(mv => mv.from + mv.to + (mv.promotion || ''));
        if (!legal.length) { listen('bestmove (none)'); return; }
        const black = cur.split(' ')[1] === 'b';
        const t0 = performance.now();
        const out = await session.run({
            tokens: new ort.Tensor('float32', encode(cur), [1, 64, TOKEN_DIM]),
            self_elo: new ort.Tensor('int64', BigInt64Array.from([BigInt(selfElo)]), [1]),
            oppo_elo: new ort.Tensor('int64', BigInt64Array.from([BigInt(oppoElo)]), [1]),
        });
        const logits = out.move_logits.data;
        // gather legal-move logits, softmax, rank
        const scored = [];
        for (const u of legal) {
            const idx = MOVE_TO_IDX.get(black ? mirrorMove(u) : u);
            if (idx !== undefined) scored.push([u, logits[idx]]);
        }
        const mx = Math.max(...scored.map(s => s[1]));
        let sum = 0; for (const s of scored) { s[2] = Math.exp(s[1] - mx); sum += s[2]; }
        for (const s of scored) s[2] /= sum;
        scored.sort((a, b) => b[2] - a[2]);
        const cp = wdlToCp(Array.from(out.value_logits.data));
        const n = Math.min(multipv, scored.length);
        for (let i = 0; i < n; i++)   // BEST-FIRST: multipv 1 resets the panel's lines array, so it
            listen(`info depth 1 multipv ${i + 1} score cp ${cp} pv ${scored[i][0]}`); // must precede 2..N
        console.log(`[Maia-3] elo ${selfElo} played ${scored[0][0]} (${(scored[0][2] * 100).toFixed(1)}%) — ${(performance.now() - t0).toFixed(1)}ms`);
        listen(`bestmove ${scored[0][0]}`);
    }

    return {
        uci(line) {
            line = line.trim();
            if (line === 'uci') { listen('id name Maia-3'); listen('uciok'); }
            else if (line === 'isready') listen('readyok');
            else if (line.startsWith('setoption')) {
                const m = /name\s+(\S+)\s+value\s+(\S+)/i.exec(line);
                if (m) {
                    const k = m[1].toLowerCase(), v = parseInt(m[2]);
                    if (k === 'selfelo' && v) selfElo = v;
                    else if (k === 'oppoelo' && v) oppoElo = v;
                    else if (k === 'multipv' && v) multipv = v;
                }
            }
            else if (line.startsWith('position')) {
                const fm = /position\s+fen\s+(.+?)(?:\s+moves\s+(.*))?$/.exec(line);
                const sm = /position\s+startpos(?:\s+moves\s+(.*))?$/.exec(line);
                if (fm) { fen = fm[1]; moves = fm[2] || ''; }
                else if (sm) { fen = null; moves = sm[1] || ''; }
            }
            else if (line.startsWith('go')) go().catch(e => listen(`info string maia3 error ${e}`));
        },
        terminate() { try { session.release && session.release(); } catch (e) { /* */ } },
    };
}
