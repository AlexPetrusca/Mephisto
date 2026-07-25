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

ort.env.wasm.wasmPaths = '/lib/ort/';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

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

async function readBoard(bitmap, box) {
    const c = draw(bitmap, BOARD_SIZE, BOARD_SIZE, box.x, box.y, box.w, box.h);
    const out = await posSession.run({[posSession.inputNames[0]]: toTensor(c)});
    const logits = out[posSession.outputNames[0]].data; // [1,64,13], rank 8 first, file a first
    const rows = [];
    for (let r = 0; r < 8; r++) {
        let row = '', gap = 0;
        for (let f = 0; f < 8; f++) {
            const base = (r * 8 + f) * 13;
            let best = 0;
            for (let k = 1; k < 13; k++) if (logits[base + k] > logits[base + best]) best = k;
            if (best === EMPTY) gap++;
            else { if (gap) { row += gap; gap = 0; } row += SYMS[best]; }
        }
        if (gap) row += gap;
        rows.push(row);
    }
    return rows.join('/');
}

// dataUri: the captured tab. crop (optional): a drag-selected rect in image pixels.
export async function recognize({dataUri, crop}) {
    await ready();
    const blob = await (await fetch(dataUri)).blob();
    const bitmap = await createImageBitmap(blob);
    const box = crop || await detectBoard(bitmap);
    if (!box) return {error: 'no board found'};
    return {placement: await readBoard(bitmap, box), box,
            imageW: bitmap.width, imageH: bitmap.height};
}
