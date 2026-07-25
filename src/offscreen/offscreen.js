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

function send(clientId, payload) {
    try { chrome.runtime.sendMessage({fromOffscreen: true, clientId, ...payload}); } catch (e) { /* no receiver */ }
}

// Mirror popup.js fetch_nnue: nets over 100MB ship split as <name>.part0..N -- stitch them back.
async function fetchNnue(base, nnue) {
    const whole = await fetch(`${base}/${nnue}`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (whole) return whole;
    const parts = [];
    for (let i = 0; ; i++) {
        const part = await fetch(`${base}/${nnue}.part${i}`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
        if (!part) break;
        parts.push(part);
    }
    if (!parts.length) throw new Error(`NNUE not found: ${nnue}`);
    const buf = new Uint8Array(parts.reduce((t, p) => t + p.byteLength, 0));
    parts.reduce((off, p) => { buf.set(new Uint8Array(p), off); return off + p.byteLength; }, 0);
    return buf.buffer;
}

function disposeClient(clientId) {
    const engine = clients[clientId];
    if (!engine) return;
    try { engine.uci && engine.uci('quit'); } catch (e) { /* */ }
    try { engine.terminate && engine.terminate(); } catch (e) { /* */ }
    delete clients[clientId];
}

// Create (or replace) the engine for one panel and load its NNUE net(s). Mirrors the WASM half of
// popup.js initialize_engine EXACTLY (incl. Fairy's UCI_Variant-before-NNUE quirk); everything after
// (Hash/Threads/MultiPV/Elo/ucinewgame/isready) stays in the popup and arrives as 'uci' commands.
async function initEngine(clientId, engineName, variant, maiaLevel) {
    disposeClient(clientId);
    // Maia: not a Stockfish WASM build -- a UCI adapter running one onnxruntime forward pass of the
    // selected lc0 Maia net (no search). Same interface, so the panel drives it like any engine.
    if (engineName === 'maia' || engineName === 'maia3') {
        const engine = engineName === 'maia3'
            ? await (await import('/src/offscreen/maia3.js')).createMaia3Engine((line) => send(clientId, { kind: 'line', line }), maiaLevel)
            : await (await import('/src/offscreen/maia.js')).createMaiaEngine(maiaLevel || '1500', (line) => send(clientId, { kind: 'line', line }));
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
    engine.listen = (line) => send(clientId, {kind: 'line', line});
    engine.onError = (e) => send(clientId, {kind: 'error', error: String(e)});
    // NOTE: do NOT publish to clients[] yet. The panel no longer waits for us, so uci can arrive
    // mid-load; while we're unpublished it queues, and a 'go' can't reach an engine whose NNUE
    // isn't in yet (it would search with no net). Publish + flush together, below.

    if (engineName.includes('nnue')) {
        if (engineName === 'fairy-stockfish-14-nnue') {
            engine.uci(`setoption name UCI_Variant value ${variant}`);
            const net = variantNnueMap[variant] || variantNnueMap['chess'];
            engine.setNnueBuffer(new Uint8Array(await fetchNnue(base, net)), 0);
        } else {
            const nets = [];
            for (let i = 0; ; i++) { const n = engine.getRecommendedNnue(i); if (!n || nets.includes(n)) break; nets.push(n); }
            for (let i = 0; i < nets.length; i++) engine.setNnueBuffer(new Uint8Array(await fetchNnue(base, nets[i])), i);
        }
    }
    // Fully loaded: publish it and flush everything the panel sent while we were loading, in order.
    // The panel doesn't block on us any more, so its board paints instantly even for Fairy (whose
    // per-variant NNUE takes a while) -- the engine just catches up with the queued commands.
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
    if (cmd === 'init') {
        initEngine(clientId, msg.engine, msg.variant, msg.maiaLevel).catch(e => send(clientId, {kind: 'error', error: String(e)}));
    } else if (cmd === 'uci') {
        const engine = clients[clientId];
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
