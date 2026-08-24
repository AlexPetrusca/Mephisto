// A SANDBOXED page, and it exists for exactly one reason: chess.com's explanation engine is an
// Emscripten build whose glue calls eval(), and an MV3 extension page may not have 'unsafe-eval'.
// A sandboxed page may. It gets no chrome.* APIs and an opaque origin, so it cannot fetch anything
// itself -- the parent hands it the bytes and it does nothing but run them and relay the lines.
let worker = null;

function boot(jsText, wasmBytes, reply, hashSuffix) {
    const wasmUrl = URL.createObjectURL(new Blob([wasmBytes], {type: 'application/wasm'}));
    const jsUrl = URL.createObjectURL(new Blob([jsText], {type: 'text/javascript'}));
    // Both engines find their wasm through their own location.hash, but they read it differently:
    // the explanation engine takes the bare URL, Stockfish's WASM build splits on a comma and wants
    // the second field to say `worker` (`#<wasm>,worker`). One sandbox hosts either, so the
    // classifier mode can run chess.com's own Stockfish beside their classifier.
    worker = new Worker(jsUrl + '#' + wasmUrl + (hashSuffix || ''));
    worker.onerror = (e) => reply({type: 'error', error: String(e.message || e), detail: {msg: e.message||null, file: e.filename||null, line: e.lineno||null}});
    worker.onmessage = (e) => reply({type: 'line', line: typeof e.data === 'string' ? e.data : JSON.stringify(e.data)});
    reply({type: 'booted'});
}

window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    const reply = (m) => ev.source.postMessage({...m, id: msg.id}, '*');
    try {
        if (msg.cmd === 'boot') return boot(msg.js, msg.wasm, reply, msg.hashSuffix);
        if (msg.cmd === 'send') { worker.postMessage(msg.line); return; }
        if (msg.cmd === 'quit') { try { worker.terminate(); } catch (e) { /* gone */ } worker = null; return; }
    } catch (e) { reply({type: 'error', error: String(e)}); }
});
