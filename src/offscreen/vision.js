// Screenshot -> FEN. Runs the two board-recognition models (see lib/engine/vision/README.md) in the
// OFFSCREEN document, because that is where onnxruntime-web already lives for Maia and where an
// extension-origin fetch of the .onnx bytes is allowed.
//
// Pipeline: a captured tab image comes in as a data URI.
//   1. bbox model (512x512) -> a board mask -> the tightest box around it
//   2. crop that box, resize to 256x256, position model -> [64,13] logits
//   3. argmax per square -> FEN placement
// A caller-supplied crop skips step 1 (that's the drag-to-select fallback).
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

// ort env (threads, wasm paths) is configured ONCE in ort-env.js, shared by every session
// creator so the thread count cannot depend on which module happened to load first.
import '/src/offscreen/ort-env.js';

const SYMS = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']; // upstream src/games.py order
const EMPTY = 12;      // the 13th channel is "empty"
const BBOX_SIZE = 512; // what the detector was trained at
const BOARD_SIZE = 256; // 8 tiles x 32px -- the position model asserts this exactly

let bboxSession = null, posSession = null;

async function session(path) {
    const r = await fetch(chrome.runtime.getURL(path));
    return ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()));
}

async function ready() {
    if (!bboxSession) bboxSession = await session('/lib/engine/vision/bbox.onnx');
    if (!posSession) posSession = await session('/lib/engine/vision/position.onnx');
}

// plain RGB 0..1 in NCHW -- upstream does NOT apply ImageNet mean/std, and adding it silently
// degrades accuracy, so this matches the reference exactly
function toTensor(canvas) {
    const {width: w, height: h} = canvas;
    const d = canvas.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, w, h).data;
    const out = new Float32Array(3 * w * h);
    const plane = w * h;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        out[p] = d[i] / 255;
        out[plane + p] = d[i + 1] / 255;
        out[2 * plane + p] = d[i + 2] / 255;
    }
    return new ort.Tensor('float32', out, [1, 3, h, w]);
}

function draw(bitmap, w, h, sx, sy, sw, sh) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', {willReadFrequently: true});
    if (sw === undefined) ctx.drawImage(bitmap, 0, 0, w, h);
    else ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    return c;
}

// mask -> the tightest box containing the confident pixels, mapped back to source pixels
async function detectBoard(bitmap) {
    const t = toTensor(draw(bitmap, BBOX_SIZE, BBOX_SIZE));
    const out = await bboxSession.run({[bboxSession.inputNames[0]]: t});
    const mask = out[bboxSession.outputNames[0]].data; // [1,1,512,512] raw logits
    let x0 = BBOX_SIZE, y0 = BBOX_SIZE, x1 = -1, y1 = -1, hits = 0;
    for (let y = 0; y < BBOX_SIZE; y++) {
        for (let x = 0; x < BBOX_SIZE; x++) {
            if (mask[y * BBOX_SIZE + x] > 0) { // logit > 0 == board
                hits++;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    // too few pixels to be a board -> tell the caller to ask for a manual selection instead of
    // returning a confident-looking crop of nothing
    if (hits < 0.01 * BBOX_SIZE * BBOX_SIZE || x1 <= x0 || y1 <= y0) return null;
    const fx = bitmap.width / BBOX_SIZE, fy = bitmap.height / BBOX_SIZE;
    return {x: x0 * fx, y: y0 * fy, w: (x1 - x0 + 1) * fx, h: (y1 - y0 + 1) * fy,
            coverage: hits / (BBOX_SIZE * BBOX_SIZE)};
}

// How many of the least-certain squares to report back. The point is to name the squares worth a
// second look, not to dump 64 numbers.
const LOW_CONFIDENCE_REPORT = 3;
const LOW_CONFIDENCE_MAX = 0.9; // only mention a square the model was not already sure about

// Softmax over one square's 13 class logits. Done in the numerically stable form (subtract the max
// first) -- raw exp() on logits overflows to Infinity and turns every probability into NaN.
function squareProbs(logits, base) {
    let max = logits[base];
    for (let k = 1; k < 13; k++) if (logits[base + k] > max) max = logits[base + k];
    let sum = 0;
    const p = new Array(13);
    for (let k = 0; k < 13; k++) { p[k] = Math.exp(logits[base + k] - max); sum += p[k]; }
    for (let k = 0; k < 13; k++) p[k] /= sum;
    return p;
}

const pieceCount = (read) => (read.placement.match(/[pnbrqk]/gi) || []).length;
const staleRead = (read) => pieceCount(read) < 2 || (read.unresolved || []).some(r => /king/.test(r));

// THE MODEL IS THE COST, AND MOST READS ASK IT THE SAME QUESTION. Measured on this machine: the
// detector is 84ms and the position model 645ms of a ~670ms read, and the shipped model is ALREADY
// int8-quantised (MatMulInteger/ConvInteger), so there is no quantisation left to win. What is left
// is not asking: while the opponent thinks, the follow loop re-reads a board that has not changed a
// pixel. The 256x256 crop IS the board, so an identical crop means an identical position -- hash it
// and reuse the answer.
//
// The hash is a cheap rolling one over every 16th byte: enough to notice a piece moving (thousands
// of pixels change) and far cheaper than the inference it avoids. A collision would have to leave
// every sampled byte identical across a real move, which is not a thing a rendered board does.
let lastCropHash = null, lastRead = null, readHits = 0;

function cropHash(canvas) {
    const d = canvas.getContext('2d', {willReadFrequently: true})
        .getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 16) { h ^= d[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
}

// --- the rules the model does not know -----------------------------------------------------------
// A misread square usually still yields a LEGAL position, which is why the per-square confidence is
// reported at all. But some misreads yield a position that CANNOT be chess -- two white kings, nine
// pawns, a pawn on the back rank -- and the model already holds the correction: the runner-up it
// kept for every square. This pass spends those runners-up on the squares that break a rule,
// least-confident offender first, and stops the moment the board is legal. Accuracy bought from the
// rules rather than from the model; no retraining, no extra inference.
//
// Placement-only rules, deliberately: side to move, castling and en passant are unknown here, so
// only what a bare diagram can violate is enforced. Each square is flipped at most once (a flip can
// create a new violation -- the loop re-checks -- and a once-only guard is what keeps two kings from
// trading places forever). A violation with no runner-up that resolves it is left alone: downstream
// chess.js validation still rejects the FEN, exactly as before this existed.
function placementViolations(squares) {
    const bySym = {};
    for (const sq of squares) if (sq.piece) (bySym[sq.piece] = bySym[sq.piece] || []).push(sq);
    const v = [];
    for (const [K, P, side] of [['K', 'P', 'white'], ['k', 'p', 'black']]) {
        const kings = bySym[K] || [], pawns = bySym[P] || [];
        if (kings.length > 1) v.push({rule: `two ${side} kings`, offenders: kings});
        if (kings.length === 0) v.push({rule: `no ${side} king`, missing: K});
        if (pawns.length > 8) v.push({rule: `${pawns.length} ${side} pawns`, offenders: pawns});
        const backRank = pawns.filter(sq => sq.square[1] === '1' || sq.square[1] === '8');
        if (backRank.length) v.push({rule: `${side} pawn on the back rank`, offenders: backRank});
        const total = squares.filter(sq => sq.piece && (sq.piece === sq.piece.toUpperCase()) === (K === 'K')).length;
        if (total > 16) v.push({rule: `${total} ${side} pieces`,
            offenders: squares.filter(sq => sq.piece && (sq.piece === sq.piece.toUpperCase()) === (K === 'K'))});
    }
    return v;
}

function repairPlacement(squares) {
    const fixed = [];
    const flipped = new Set();
    const flip = (sq) => {
        [sq.piece, sq.alt] = [sq.alt, sq.piece];
        [sq.prob, sq.altProb] = [sq.altProb, sq.prob];
    };
    // A flip only counts if the board gets STRICTLY more legal. A runner-up that trades two kings
    // for a back-rank pawn has not fixed anything -- it has changed which rule is broken, on a square
    // that can then never be flipped again. Tentative-flip-and-count catches that generically: any
    // candidate whose flip does not reduce the violation total is reverted and the next one tried,
    // and a violation none of them can reduce is REPORTED rather than papered over.
    const tryFlip = (cand, rule, before) => {
        flip(cand);
        if (placementViolations(squares).length < before) {
            fixed.push({square: cand.square, from: cand.alt, to: cand.piece, rule});
            flipped.add(cand.square);
            return true;
        }
        flip(cand);                                    // revert: this trade was not an improvement
        return false;
    };
    for (let pass = 0; pass < 12; pass++) {           // bounded: <= one flip per violation family
        const violations = placementViolations(squares);
        if (!violations.length) break;
        let progressed = false;
        for (const v of violations) {
            if (v.missing) {
                // a MISSING king cannot be fixed by removing anything: the squares whose runner-up
                // IS that king, most confident first, until one strictly helps
                const cands = squares.filter(sq => sq.alt === v.missing && !flipped.has(sq.square))
                                     .sort((a, b) => b.altProb - a.altProb);
                progressed = cands.some(c => tryFlip(c, v.rule, violations.length));
            } else {
                // too many of something: the least confident offenders, until one strictly helps
                const cands = (v.offenders || []).filter(sq => !flipped.has(sq.square) && sq.alt !== null)
                                                 .sort((a, b) => a.prob - b.prob);
                progressed = cands.some(c => tryFlip(c, v.rule, violations.length));
            }
            if (progressed) break; // re-check from scratch: a flip may have changed other counts
        }
        if (!progressed) break;                        // nothing improves anything -- report what remains
    }
    return {fixed, unresolved: placementViolations(squares).map(v => v.rule)};
}

// squares (rank 8 first, file a first) -> FEN placement, after any repairs
function placementOf(squares) {
    const rows = [];
    for (let r = 0; r < 8; r++) {
        let row = '', gap = 0;
        for (let f = 0; f < 8; f++) {
            const piece = squares[r * 8 + f].piece;
            if (!piece) gap++;
            else { if (gap) { row += gap; gap = 0; } row += piece; }
        }
        if (gap) row += gap;
        rows.push(row);
    }
    return rows.join('/');
}

async function readBoard(bitmap, box) {
    const c = draw(bitmap, BOARD_SIZE, BOARD_SIZE, box.x, box.y, box.w, box.h);
    const hash = cropHash(c);
    if (lastRead && hash === lastCropHash) { readHits++; return {...lastRead, cached: true}; }
    const out = await posSession.run({[posSession.inputNames[0]]: toTensor(c)});
    const logits = out[posSession.outputNames[0]].data; // [1,64,13], rank 8 first, file a first
    // The model's own certainty is right here and used to be discarded with the argmax. A misread
    // square usually still produces a LEGAL position, so nothing downstream can flag it -- but the
    // model itself was unsure, and saying which square it was unsure about turns "the position looks
    // wrong somewhere" into "check e4".
    const squares = [];
    for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
            const base = (r * 8 + f) * 13;
            let best = 0;
            for (let k = 1; k < 13; k++) if (logits[base + k] > logits[base + best]) best = k;
            const probs = squareProbs(logits, base);
            // The RUNNER-UP, for the squares the model is unsure about. "e4 empty 18%" tells you
            // something is wrong and nothing about what to do; "or a black knight" is a correction
            // you can take in one click, which is the difference between a warning and a fix.
            let second = -1;
            for (let k = 0; k < 13; k++) {
                if (k === best) continue;
                if (second < 0 || logits[base + k] > logits[base + second]) second = k;
            }
            squares.push({
                square: String.fromCharCode(97 + f) + (8 - r), // r=0 is rank 8, f=0 is file a
                piece: best === EMPTY ? '' : SYMS[best],
                prob: probs[best],
                alt: second < 0 ? null : (second === EMPTY ? '' : SYMS[second]),
                altProb: second < 0 ? 0 : probs[second],
            });
        }
    }
    // rules first, placement second: a decode that cannot be chess spends the runners-up the model
    // already paid for before anything downstream sees it
    const {fixed, unresolved} = repairPlacement(squares);
    const allLow = squares.filter(sq => sq.prob < LOW_CONFIDENCE_MAX);
    const low = allLow.slice().sort((a, b) => a.prob - b.prob).slice(0, LOW_CONFIDENCE_REPORT);
    // A repaired square joins the unsure list whatever its confidence NOW reads: it was changed on
    // rule grounds, and listing it (with the original as its runner-up) makes the same one-click UI
    // an undo. Deduped -- a repaired square may already be there on its own low confidence.
    for (const fx of fixed) {
        if (low.some(sq => sq.square === fx.square)) continue;
        const sq = squares.find(s => s.square === fx.square);
        if (sq) low.push({...sq, repaired: fx.rule});
    }
    // lowCount is the STALE-BOX signal: `low` is the top-3 report for the UI, so its length says
    // nothing about how bad a read was. The re-detect below used to compare that ARRAY against 8,
    // which is never true -- the stale-box recovery had been dead since the report was capped.
    const result = {placement: placementOf(squares), low, fixed, unresolved, lowCount: allLow.length};
    lastCropHash = hash;
    lastRead = result;
    return result;
}

// dataUri: the captured tab. crop (optional): a drag-selected rect in image pixels.
// THE BOARD DOES NOT MOVE WHILE YOU PLAY. The detector is a 12MB model run on a 512x512 image, and
// on a live page it answers the same box read after read -- the tab is the same size and the board
// is where it was. So the last box is kept and REUSED while the image is the same shape, and the
// detector only runs again when that stops being true or when the position model reports a read it
// is not confident about (which is what a wrong box looks like from here).
//
// The cache is per image geometry rather than per tab: a resized window, a different monitor or a
// zoom change all alter it, and all three genuinely move the board.
let boxCache = null;   // {w, h, box}
let boxMisses = 0;

export function resetBoardBox() { boxCache = null; }   // the caller can force a fresh detection

// The frame that arrives is usually the frame that arrived last time: while the opponent thinks,
// the follow loop captures a screen that has not changed. The crop hash below already skips the
// MODEL for those, but the image still had to be decoded first (~23ms of a ~26ms cached read, which
// makes decoding the dominant cost once the model is skipped). A JPEG encoder given identical
// pixels and identical settings emits identical bytes, so identical bytes mean an identical screen
// -- and the whole read can be answered without decoding anything at all.
//
// Sampled rather than compared whole: a 300KB base64 string costs real time to hash byte by byte,
// and a screen change that leaves every 64th character identical is not something a rendered board
// does. The crop hash still runs underneath, so a false match here would have to survive that too.
let lastUriHash = null, lastResult = null, uriHits = 0;

function uriHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 64) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) + ':' + s.length);
}

// TWO BOARDS ON SCREEN. Mephisto's panel carries a chessboard of its own, and the detector cannot
// know which one was meant -- picking the panel's is a failure that looks exactly like a misread.
// Painting the panel's rectangle out of the captured frame was tried first and is WRONG: the panel
// OVERLAPS the board it is being asked about (measured: panel from x1880, board 840-1960), so
// blanking it takes a strip of the real board with it and the read gets worse, not better. The
// panel is ours, so it steps out of the way for the one frame a detection capture needs -- see
// with_panel_hidden() in popup.js. A follow read passes the box it already knows and needs none of
// this.
export async function recognize({dataUri, crop}) {
    await ready();
    const t0 = performance.now();
    if (!crop && lastResult && uriHash(dataUri) === lastUriHash) {
        uriHits++;
        return {...lastResult, timing: {decodeMs: 0, detectMs: 0, readMs: 0, cachedBox: true,
                                        cachedRead: true, cachedFrame: true, uriHits,
                                        totalMs: Math.round(performance.now() - t0)}};
    }
    const blob = await (await fetch(dataUri)).blob();
    const bitmap = await createImageBitmap(blob);
    const tDecode = performance.now();
    let box = crop, cached = false, tDetect = tDecode;
    if (!box) {
        if (boxCache && boxCache.w === bitmap.width && boxCache.h === bitmap.height) {
            box = boxCache.box;
            cached = true;
        } else {
            box = await detectBoard(bitmap);
            tDetect = performance.now();
            if (box) boxCache = {w: bitmap.width, h: bitmap.height, box};
        }
    }
    if (!box) return {error: 'no board found'};
    const tBefore = performance.now();
    let read = await readBoard(bitmap, box);
    let tRead = performance.now();
    // A cached box that has gone stale reads as a board full of nothing: re-detect ONCE and keep
    // the better answer, so a moved board costs one extra read rather than a wrong position.
    // The signal is the READ, not the confidences: the int8 model's max-prob sits under 0.9 on
    // every square of an EXACT read (measured lowCount=64 on a perfect lichess frame), so any
    // confidence count fires on ordinary frames. What a stale box actually produces is a board
    // with no kings or almost no pieces (measured: off-board crop -> 0 pieces + both kings
    // unresolved; correct crop -> full position, nothing unresolved). KQK/KRK endings keep their
    // kings, so they do not trigger. Ceiling: a box HALF-overlapping the real board can decode as
    // king-bearing garbage no local signal catches -- the follow re-scrape is the recovery there.
    if (cached && staleRead(read)) {
        boxMisses++;
        const fresh = await detectBoard(bitmap);
        if (fresh) {
            boxCache = {w: bitmap.width, h: bitmap.height, box: fresh};
            const second = await readBoard(bitmap, fresh);
            if (!staleRead(second) || pieceCount(second) >= pieceCount(read)) { read = second; box = fresh; }
        }
        tRead = performance.now();
    }
    const answer = {
        placement: read.placement, low: read.low, lowCount: read.lowCount,
        unresolved: read.unresolved, box,
        imageW: bitmap.width, imageH: bitmap.height,
        // what each stage cost, so "screen reading is slow" can be answered with numbers rather
        // than with a guess about which model is the expensive one
        timing: {
            decodeMs: Math.round(tDecode - t0),
            detectMs: cached ? 0 : Math.round(tDetect - tDecode),
            readMs: Math.round(tRead - tBefore),
            cachedBox: cached,
            cachedRead: !!read.cached,
            readHits,
            uriHits,
            boxMisses,
        },
    };
    // remembered for the next frame: only a full read is worth repeating from cache
    if (!crop) { lastUriHash = uriHash(dataUri); lastResult = {...answer}; delete lastResult.timing; }
    return answer;
}
