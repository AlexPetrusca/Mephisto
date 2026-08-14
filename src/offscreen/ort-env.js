// ONE writer for onnxruntime-web's environment, imported by every module that creates a session
// (vision.js, maia.js, maia3.js). The wasm backend initialises ONCE per document, at the first
// InferenceSession.create, with whatever env values are set at that moment -- so when each engine
// file wrote its own numThreads at import time, the thread count depended on which feature the user
// happened to touch first: a Maia engine opened before the first screen read silently reverted the
// recogniser to one thread and the measured 1109ms -> 620ms speedup never engaged. An ES module
// evaluates once however many times it is imported, which makes this file order-independent by
// construction.
//
// Thread count: capped at 4 (a read or a forward pass is a short burst competing with whatever
// engine is analysing -- the cap is untested above a 10-core M-series Mac; re-measure before
// raising it), halved against the cores, floored at 1. Guarded on crossOriginIsolated: without
// SharedArrayBuffer a thread count above 1 fails to INITIALISE, and an engine that will not start
// is far worse than a slow one. Maia's forward pass is a few ms either way; the recogniser is the
// component this materially changes (measured 1.8x on 4 threads).
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

ort.env.wasm.wasmPaths = '/lib/ort/';
ort.env.wasm.numThreads = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
    ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
    : 1;
ort.env.wasm.proxy = false;

export { ort };
