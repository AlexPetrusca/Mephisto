// ONE writer for onnxruntime-web's environment, imported by every module that creates a session
// (vision.js, maia.js, maia3.js). The wasm backend initialises ONCE per document, at the first
// InferenceSession.create, with whatever env values are set at that moment -- so when each engine
// file wrote its own numThreads at import time, the thread count depended on which feature the user
// happened to touch first: a Maia engine opened before the first screen read silently reverted the
// recogniser to one thread and the measured 1109ms -> 620ms speedup never engaged. An ES module
// evaluates once however many times it is imported, which makes this file order-independent by
// construction.
//
// Thread count. Guarded on crossOriginIsolated: without SharedArrayBuffer anything above 1 fails to
// INITIALISE, and an engine that will not start is far worse than a slow one. Maia's forward pass is
// a few ms either way; the recogniser is the component this materially changes (measured 1.8x when
// it went from one thread to four).
//
// MEASURED on the position model, 7 fresh reads each, 10-core M-series Mac, otherwise idle:
//
//     threads   2      4       5      6      8
//     model   754ms  635ms   610ms  589ms  704ms
//
// So four was not the ceiling, and eight is WORSE than four -- past the physical cores the threads
// fight each other. 0.6 x cores, capped at 6, lands on the measured best here and changes nothing
// below ten cores: 4 cores still get 2, 8 cores still get 4. That matters because the numbers above
// are ONE machine, idle; a smaller box has no headroom to find and would only lose to contention.
// Worth 46ms of a ~635ms read -- real, small, and free.
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

ort.env.wasm.wasmPaths = '/lib/ort/';
// ...and then OVERRULED by a budget, because that argument optimises the wrong thing. The numbers
// above are ONE read in isolation; following a board runs that read over and over, and six threads
// held for as long as it follows is half a machine to watch something that changes every few
// seconds. What matters is not how fast one read is but how much of the machine the feature may
// take -- so the ceiling is a COUNT OF CORES, set by the user, and the speed is whatever that buys
// (user: "i want it fast but not more than 2 cores default changable via the settings"). Two
// threads read in ~754ms against ~589ms at six: barely slower per read, a third of the cores.
const VISION_THREADS_DEFAULT = 2;
const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
// A sane value from the first instant: the stored one needs an await, and a session created before
// that lands would silently keep whatever was set at the time.
ort.env.wasm.numThreads = isolated ? VISION_THREADS_DEFAULT : 1;
ort.env.wasm.proxy = false;

// THE THREAD COUNT IS READ ONCE PER DOCUMENT. onnxruntime's wasm backend initialises at the FIRST
// InferenceSession.create with whatever the env said at that moment, so every session creator must
// await this first -- and a changed setting only takes effect the next time this host starts.
let envReady = null;
function readyEnv() {
    if (envReady) return envReady;
    envReady = (async () => {
        if (!isolated) return;
        try {
            const {vision_threads: raw} = await chrome.storage.local.get('vision_threads');
            const n = parseInt(JSON.parse(raw ?? 'null'), 10);
            if (Number.isFinite(n)) ort.env.wasm.numThreads = Math.max(1, Math.min(8, n));
        } catch (e) { /* no storage here, or nothing stored -- the default above stands */ }
    })();
    return envReady;
}

export { ort, readyEnv, VISION_THREADS_DEFAULT };
