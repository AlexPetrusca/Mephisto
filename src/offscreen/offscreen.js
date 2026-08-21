// Mephisto offscreen engine host (N1).
// The WASM engine builds are pthread (SharedArrayBuffer) builds, so they need a cross-origin-isolated
// EXTENSION-ORIGIN context. This offscreen document is exactly that -- and, unlike the old in-page
// popup iframe, it is NOT a browsing context the game page can see or count (defeats issue #35
// §3.1/§3.3). One engine instance is kept per panel (keyed by the panel's tab id), so multiple game
// tabs stay independent, exactly as when each had its own iframe engine.
//
// Protocol (over chrome.runtime.sendMessage, filtered by clientId):
//   popup  -> offscreen : {toOffscreen, clientId, cmd:'init', engine, variant, maiaLevel?}
//                         {toOffscreen, clientId, cmd:'uci', line}
//                         {toOffscreen, clientId, cmd:'dispose'}
//   offscreen -> popup  : {fromOffscreen, clientId, kind:'ready'}
//                         {fromOffscreen, clientId, kind:'line',  line}
//                         {fromOffscreen, clientId, kind:'error', error}

const engineMap = {
    'stockfish-dev-nnue': 'stockfish-dev/sf_dev.js',
    'stockfish-18-nnue': 'stockfish-18/sf_18.js',
    'stockfish-18-small-nnue': 'stockfish-18-small/sf_18_smallnet.js',
    'stockfish-11-hce': 'stockfish-11-hce/sfhce.js',
    'fairy-stockfish-14-nnue': 'fairy-stockfish-14/fsf_14.js',
};
// Fairy-Stockfish ships one NNUE net per variant (it can't recommend its own like mainline SF).
const variantNnueMap = {
    'chess': 'nn-46832cfbead3.nnue',
    'fischerandom': 'nn-46832cfbead3.nnue',
    'crazyhouse': 'crazyhouse-8ebf84784ad2.nnue',
    'kingofthehill': 'kingofthehill-978b86d0e6a4.nnue',
    '3check': '3check-cb5f517c228b.nnue',
    'antichess': 'antichess-dd3cbe53cd4e.nnue',
    'atomic': 'atomic-2cf13ff256cc.nnue',
    'horde': 'horde-28173ddccabe.nnue',
    'racingkings': 'racingkings-636b95f085e3.nnue',
    'duck': 'duck-ba21f91f5d81.nnue',
    'minihouse': 'minihouse-d415b4dbfe2c.nnue',
    'seirawan': 'seirawan-432c65fe71fc.nnue',
    'chaturanga': 'chaturanga-1889e98f8d54.nnue',
};

const clients = {}; // clientId -> engine instance
const pending = {}; // clientId -> uci lines sent before the engine finished loading (see below)
// clientId -> load generation. A Fairy net takes seconds to fetch, so a second `init` (switching
// engine or variant twice in a row) can start while the first is still awaiting -- and the two
// publish in COMPLETION order, not request order. The loser overwrote clients[] with the engine the
// panel had already moved on from, and the winner's worker was left running with nothing pointing at
// it. Each load claims a generation and abandons itself if a newer one has since started; a dispose
// bumps it too, so a teardown mid-load can't be undone by the load finishing afterwards.
const epoch = {};

function send(clientId, payload) {
    // every engine's output funnels through here, so this is the one place that sees a search end
    if (payload && payload.kind === 'line' && /^bestmove/.test(payload.line || '')) searching[clientId] = false;
    try { chrome.runtime.sendMessage({fromOffscreen: true, clientId, ...payload}); } catch (e) { /* no receiver */ }
}

// --- Orphaned searches ---------------------------------------------------------------------------
// THIS DOCUMENT IS NOT A TAB. Nothing tears it down when a panel dies without saying goodbye: a page
// navigation, a reload, a crashed tab, the extension reloading under it. The engine simply keeps
// whatever it was last told -- and with Autoplay off that is `go infinite` on a pthread build, which
// pins every core for as long as the browser lives, with no window open to explain it. (Reported
// from the wild: ~400% CPU with everything closed.) chrome.tabs.onRemoved covers only the case where
// the tab is CLOSED, which is the one case that was never the problem.
//
// So: a panel renews a lease while it is searching (cmd:'ping', see popup.js), and a search whose
// owner has gone quiet is stopped. The engine INSTANCE is kept -- a panel that comes back gets it
// warm, and an idle engine costs nothing. Only the burn ends.
// ponytail: stop, not dispose. Freeing the worker's memory too would need a second, much longer
// timer, and memory was not what anybody noticed.
const LEASE_MS = 60000;
const ABANDON_MS = 300000;   // 5 min of silence: the panel is gone, not just thinking
const LEASE_SWEEP_MS = 20000;
const lastSeen = {};   // clientId -> when its panel last spoke to us
const searching = {};  // clientId -> is a search running for it right now

// Exported shape kept dead simple so the ladder can drive it without a browser.
function orphanedSearches(now, lease = LEASE_MS) {
    return Object.keys(searching).filter(id => searching[id] && now - (lastSeen[id] || 0) > lease);
}

function stopOrphanedSearches(now = Date.now()) {
    for (const id of orphanedSearches(now)) {
        console.log(`[Mephisto] offscreen: lease expired for ${id} -- stopping an orphaned search`);
        searching[id] = false;
        try { clients[id]?.uci('stop'); } catch (e) { /* engine already gone */ }
    }
    // A panel that has been silent for MINUTES is not coming back (its tab navigated away, reloaded
    // or crashed). Stopping its search saved the cores; disposing it is what lets this document go
    // idle and hand the workers back.
    for (const id of Object.keys(clients)) {
        if (now - (lastSeen[id] || 0) <= ABANDON_MS) continue;
        console.log(`[Mephisto] offscreen: ${id} abandoned -- disposing its engine`);
        disposeClient(id);
    }
}
setInterval(stopOrphanedSearches, LEASE_SWEEP_MS);

// --- On-demand nets ---------------------------------------------------------------------------
// The nets are most of the download (the Stockfish and Maia nets alone are ~280 MB), so a build can
// ship WITHOUT them and fetch what it actually uses on first run. Anything already bundled is used
// as-is and never fetched, so this costs nothing for a full install and there is no behaviour change
// unless a net is genuinely absent.
//
// Stockfish nets come from the project's own net server -- the same place Stockfish itself pulls
// them from -- and are content-addressed (the filename IS the hash), so a name can only ever refer
// to one file. Downloads are cached permanently, so it is a one-time cost per net.
const NET_CACHE = 'mephisto-nets-v1';

function remoteNetUrl(nnue) {
    // nn-<hash>.nnue are official Stockfish nets; the variant nets are Fairy's and are not hosted there
    return /^nn-[0-9a-f]{12}\.nnue$/.test(nnue)
        ? `https://tests.stockfishchess.org/api/nn/${nnue}` : null;
}

async function fetchRemoteNet(nnue, onProgress) {
    const url = remoteNetUrl(nnue);
    if (!url) return null;
    try {
        const cache = await caches.open(NET_CACHE);
        const hit = await cache.match(url);
        if (hit) return hit.arrayBuffer();       // already downloaded once
        onProgress?.(`downloading ${nnue}`);
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        // cache.put wants a Response; store a copy so the buffer stays usable here
        await cache.put(url, new Response(buf.slice(0)));
        return buf;
    } catch (e) {
        return null; // offline, blocked, or storage full -> caller reports a clear error
    }
}

// Mirror popup.js fetch_nnue: nets over 100MB ship split as <name>.part0..N -- stitch them back.
async function fetchNnue(base, nnue, onProgress) {
    const whole = await fetch(`${base}/${nnue}`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (whole) return whole;
    const parts = [];
    for (let i = 0; ; i++) {
        const part = await fetch(`${base}/${nnue}.part${i}`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
        if (!part) break;
        parts.push(part);
    }
    if (!parts.length) {
        // not bundled in any form -> fetch it once and keep it
        const remote = await fetchRemoteNet(nnue, onProgress);
        if (remote) return remote;
        throw new Error(`NNUE not found and could not be downloaded: ${nnue}`);
    }
    const buf = new Uint8Array(parts.reduce((t, p) => t + p.byteLength, 0));
    parts.reduce((off, p) => { buf.set(new Uint8Array(p), off); return off + p.byteLength; }, 0);
    return buf.buffer;
}

// THESE BUILDS CANNOT BE KILLED FROM HERE. lila-stockfish-web exposes `uci` and nothing else --
// MEASURED: `typeof engine.terminate === 'undefined'`, so the terminate() call this used to rely on
// has always been a silent no-op. `quit` is all we have, and it does not reap the pthread pool: a
// dropped engine keeps its workers, and if it was mid-`go infinite` it keeps every core busy for
// the life of the browser. Found in the wild as ~400% CPU with no window open, and confirmed here
// as four orphaned sf_dev worker sets alive while the client map was EMPTY.
// So: stop first (a `quit` behind a running search is not what ends it), then quit, then let the
// document close once nothing is left -- closing it is the only reclaim that actually works.
function disposeClient(clientId) {
    epoch[clientId] = (epoch[clientId] || 0) + 1; // invalidate any load still in flight
    const engine = clients[clientId];
    delete searching[clientId];
    delete lastSeen[clientId];
    if (!engine) return;
    // STOP, AND DO NOT QUIT. Measured on this build: `stop` takes a 403% search to 0% -- but a
    // `quit` sent straight after it kills the main thread before it has processed the stop, and the
    // pthreads keep spinning at full tilt with nothing left to talk to them (395% -> 394% across a
    // dispose, which is how the leak survived every teardown we thought we had). `stop` alone frees
    // the cores; closing the document is what hands the workers back.
    // ponytail: idle workers may linger until the last client goes and the document closes. They
    // cost memory, not CPU, and that was never what anyone noticed.
    try { engine.uci && engine.uci('stop'); } catch (e) { /* */ }
    try { engine.terminate && engine.terminate(); } catch (e) { /* if a build ever grows one */ }
    delete clients[clientId];
    maybeGoIdle();
}

// The workers belong to this DOCUMENT, so closing it is what reclaims them -- including any that
// were stranded before this code existed. Only once nothing is left and nothing has come back for
// a while, since the panel re-inits on every engine switch and closing under that would just add a
// reload to each one. The service worker owns the offscreen lifecycle, so it does the closing.
const IDLE_CLOSE_MS = 30000;
let idleTimer = null;
// An engine being LOADED is deliberately not in clients[] yet (see initEngine: publishing early
// would let a `go` reach an engine with no net). So "no clients" is not the same as "nothing going
// on" -- without counting loads in flight, this closes the document out from under an engine that
// is still starting, and the panel gets a ready engine that vanishes. Caught in testing, not in
// the wild, and only because the search that followed used no CPU at all.
const loading = new Set();
const busy = () => Object.keys(clients).length > 0 || loading.size > 0;
function maybeGoIdle() {
    clearTimeout(idleTimer);
    if (busy()) return;
    idleTimer = setTimeout(() => {
        if (busy()) return;   // somebody came back
        // CLOSE OURSELVES, in the same tick as the check. Asking the service worker to do it opens
        // a gap -- it is a message, then a promise, then the close -- and a panel that starts an
        // engine inside that gap gets it killed a moment later: the engine is gone, the panel is
        // still holding a search it thinks is running, and it waits forever on frames that will
        // never come. Seen exactly once, as `owed=1 last-frame=2238ms go=go infinite`.
        try { window.close(); } catch (e) { /* fall back to staying open; costs memory, not CPU */ }
    }, IDLE_CLOSE_MS);
}

// Create (or replace) the engine for one panel and load its NNUE net(s). Mirrors the WASM half of
// popup.js initialize_engine EXACTLY (incl. Fairy's UCI_Variant-before-NNUE quirk); everything after
// (Hash/Threads/MultiPV/Elo/ucinewgame/isready) stays in the popup and arrives as 'uci' commands.
async function initEngine(clientId, engineName, variant, maiaLevel) {
    disposeClient(clientId); // also bumps the generation, so ours is the newest from here on
    loading.add(clientId);   // ...and this document is NOT idle while we load (see maybeGoIdle)
    try {
        return await loadEngine(clientId, engineName, variant, maiaLevel);
    } finally {
        loading.delete(clientId);
    }
}

async function loadEngine(clientId, engineName, variant, maiaLevel) {
    const gen = epoch[clientId];
    // True once a newer init (or a dispose) has superseded this load. Checked after every await, and
    // again immediately before publishing, since that is the moment that would do the damage.
    const superseded = () => epoch[clientId] !== gen;
    // Same rule as disposeClient: stop, never quit. A superseded load is usually not searching yet,
    // but `quit` cannot reap these workers either (they have no terminate) -- the document close is
    // what does that, and it needs this engine to be quiet, not half torn down.
    const abandon = (engine) => {
        try { engine?.uci && engine.uci('stop'); } catch (e) { /* */ }
        try { engine?.terminate && engine.terminate(); } catch (e) { /* */ }
        maybeGoIdle();
    };
    // Maia: not a Stockfish WASM build -- a UCI adapter running one onnxruntime forward pass of the
    // selected lc0 Maia net (no search). Same interface, so the panel drives it like any engine.
    if (engineName === 'maia' || engineName === 'maia3') {
        const engine = engineName === 'maia3'
            ? await (await import('/src/offscreen/maia3.js')).createMaia3Engine((line) => send(clientId, { kind: 'line', line }), maiaLevel)
            : await (await import('/src/offscreen/maia.js')).createMaiaEngine(maiaLevel || '1500', (line) => send(clientId, { kind: 'line', line }));
        if (superseded()) return abandon(engine);
        clients[clientId] = engine;
        const queued = pending[clientId] || []; delete pending[clientId];
        for (const line of queued) { try { engine.uci(line); } catch (e) { send(clientId, { kind: 'error', error: String(e) }); } }
        send(clientId, { kind: 'ready' });
        return;
    }
    const enginePath = `/lib/engine/${engineMap[engineName]}`;
    const base = enginePath.substring(0, enginePath.lastIndexOf('/'));
    const module = await import(enginePath);
    const engine = await module.default();
    if (superseded()) return abandon(engine);
    engine.listen = (line) => send(clientId, {kind: 'line', line});
    engine.onError = (e) => send(clientId, {kind: 'error', error: String(e)});
    // NOTE: do NOT publish to clients[] yet. The panel no longer waits for us, so uci can arrive
    // mid-load; while we're unpublished it queues, and a 'go' can't reach an engine whose NNUE
    // isn't in yet (it would search with no net). Publish + flush together, below.

    if (engineName.includes('nnue')) {
        if (engineName === 'fairy-stockfish-14-nnue') {
            // A VARIANT THE ENGINE DOES NOT HAVE IS IGNORED, SILENTLY. Fairy answers an unknown
            // UCI_Variant by staying on the one it was already playing -- so asking it for Duck
            // Chess gets you a full-strength STANDARD CHESS analysis of a duck position, with no
            // sign that anything is wrong. Measured: this build declares 84 variants and duck is
            // not among them. The engine lists them in its own `uci` handshake, so the list is
            // asked for rather than hardcoded, and the panel is told when the answer is no.
            engine.uci('uci');
            const declared = await new Promise((resolve) => {
                const found = [];
                const done = setTimeout(() => resolve(found), 3000);
                const prev = engine.listen;
                engine.listen = (line) => {
                    prev(line);
                    const m = /option name UCI_Variant type combo default \S+ (.*)$/.exec(line || '');
                    if (m) found.push(...m[1].split(/\s+/).filter(w => w && w !== 'var'));
                    if (/^uciok/.test(line || '')) { clearTimeout(done); engine.listen = prev; resolve(found); }
                };
            });
            if (declared.length && !declared.includes(variant)) {
                send(clientId, {kind: 'line',
                    line: `info string mephisto-unsupported-variant ${variant}`});
            }
            engine.uci(`setoption name UCI_Variant value ${variant}`);
            const net = variantNnueMap[variant] || variantNnueMap['chess'];
            const note = (m) => send(clientId, {kind: 'line', line: `info string ${m}`});
            // Fairy's nets live one level down in nnue/, unlike mainline SF's, which sit beside the
            // .js. Fetching them from `base` missed every one of them: the .partN probe missed too,
            // and remoteNetUrl only serves official nn-<hash> nets, so this THREW -- before the
            // publish below, so the engine was never registered and every command the panel sent
            // queued in `pending` forever. Fairy WASM could not load at all. (bench.html:25 has
            // always used the nnue/ path; only this copy of the path was wrong.)
            engine.setNnueBuffer(new Uint8Array(await fetchNnue(`${base}/nnue`, net, note)), 0);
        } else {
            const nets = [];
            for (let i = 0; ; i++) { const n = engine.getRecommendedNnue(i); if (!n || nets.includes(n)) break; nets.push(n); }
            const note = (m) => send(clientId, {kind: 'line', line: `info string ${m}`});
            for (let i = 0; i < nets.length; i++) {
                engine.setNnueBuffer(new Uint8Array(await fetchNnue(base, nets[i], note)), i);
            }
        }
    }
    // Fully loaded: publish it and flush everything the panel sent while we were loading, in order.
    // The panel doesn't block on us any more, so its board paints instantly even for Fairy (whose
    // per-variant NNUE takes a while) -- the engine just catches up with the queued commands.
    if (superseded()) return abandon(engine);
    clients[clientId] = engine;
    const queued = pending[clientId] || [];
    delete pending[clientId];
    for (const line of queued) { try { engine.uci(line); } catch (e) { send(clientId, {kind: 'error', error: String(e)}); } }
    send(clientId, {kind: 'ready'});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Screenshot -> FEN. Lives here because onnxruntime-web is already set up in this document and
    // the .onnx bytes are same-origin. Async, so keep the channel open with `return true`.
    if (msg && msg.recognizeBoard) {
        import('/src/offscreen/vision.js')
            .then(m => m.recognize(msg.recognizeBoard))
            .then(sendResponse)
            .catch(e => sendResponse({error: String(e)}));
        return true;
    }
    if (!msg || !msg.toOffscreen) return;
    const {clientId, cmd} = msg;
    lastSeen[clientId] = Date.now();   // any word from the panel renews its lease
    clearTimeout(idleTimer);           // ...and a panel that is talking is not an idle document
    if (cmd === 'ping') return;        // nothing else to do: the line above WAS the point
    if (cmd === 'init') {
        initEngine(clientId, msg.engine, msg.variant, msg.maiaLevel).catch(e => send(clientId, {kind: 'error', error: String(e)}));
    } else if (cmd === 'uci') {
        const engine = clients[clientId];
        if (/^go\b/.test(msg.line || '')) searching[clientId] = true;
        if (/^(stop|quit)\b/.test(msg.line || '')) searching[clientId] = false;
        if (engine) {
            try { engine.uci(msg.line); } catch (e) { send(clientId, {kind: 'error', error: String(e)}); }
        } else {
            (pending[clientId] = pending[clientId] || []).push(msg.line); // still loading -> queue
        }
    } else if (cmd === 'dispose') {
        disposeClient(clientId);
        delete pending[clientId];
    }
});
