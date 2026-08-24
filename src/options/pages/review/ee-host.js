// Chess.com's OWN post-game classifier, run locally.
//
// WHAT THIS IS. When a game ends on chess.com, the free post-game card (Book / Best / Excellent /
// Blunder, accuracy, the coach's sentence) is produced entirely in your browser -- measured: zero
// worker messages before the game ends, 1,275 immediately after, and not one server request carries
// any analysis. Five workers do it: four `stockfish-18-lite-single` at `go depth 10` with MultiPV 2,
// one position each, and one `explanation-engine` WASM that turns those evals into the verdict.
//
// WHY IT IS NOT BUNDLED. explanation-engine.wasm is 28.7 MB and is Chess.com's commercial Torch
// engine (its own strings say TORCH_LICENSE_OWNER / KOMODO_TEP), so shipping a copy in a public
// release would be redistributing a licensed binary. It is fetched from chess.com's own CDN on
// request, behind a button, and cached here afterwards. Exactly the bytes their page loads.
//
// WHY A SANDBOXED PAGE. The engine is an Emscripten build whose glue calls eval(), and an MV3
// extension page may not have 'unsafe-eval'. A sandboxed page may -- and its own default CSP has
// `child-src 'self'`, which blocks the blob worker, so the manifest widens that too. Both blocks
// were hit in that order; neither is optional.
const EE_VERSION = '1.124.57';
const EE_BASE = `https://www.chess.com/r2/assets-chess-engine/explanation-engine/${EE_VERSION}/default/`;
const EE_DB = 'mephisto-ee';
const EE_STORE = 'assets';

// CHESS.COM'S OWN STOCKFISH, optional and downloaded the same way. Their classifier is only as
// faithful as the evals it is fed, and ours are not theirs: our closest build still disagrees on a
// few moves per game because a 30-60cp difference at depth 10 moves a move across a class boundary.
// This is the engine that removes that variable -- "Stockfish 18 Lite WASM", official Stockfish 18,
// small net, single-threaded, GPLv3 (so unlike the classifier it COULD be shipped; it is fetched
// anyway, to keep the two halves of this feature on one rule and the download opt-in).
const SF_BUILD = 'stockfish-18-lite-single-a7c6773';
const SF_BASE = 'https://www.chess.com/r2/assets-chess-engine/Stockfish/';
// Their WASM finds its binary through location.hash and splits it on a comma; the second field is a
// MODE it must not misread. A bare wasm URL works, `#wasm,` works, and `#wasm,worker` silently
// produces an engine that never answers `uci` -- measured all three.
const SF_HASH_SUFFIX = ',';

function eeOpenDb() {
    return new Promise((resolve, reject) => {
        const rq = indexedDB.open(EE_DB, 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore(EE_STORE);
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
    });
}

function eeIdb(mode, fn) {
    return eeOpenDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(EE_STORE, mode);
        const rq = fn(tx.objectStore(EE_STORE));
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
    }));
}

// Keyed by version: a newer engine on chess.com is a different classifier, and quietly reusing the
// old one would make our answer disagree with theirs for a reason nobody could see.
const kJs = () => `js:${EE_VERSION}`;
const kWasm = () => `wasm:${EE_VERSION}`;

const kSfJs = () => `sfjs:${SF_BUILD}`;
const kSfWasm = () => `sfwasm:${SF_BUILD}`;

async function sfCached() {
    try {
        const js = await eeIdb('readonly', s => s.get(kSfJs()));
        const wasm = await eeIdb('readonly', s => s.get(kSfWasm()));
        return (js && wasm) ? {js, wasm, bytes: js.length + wasm.byteLength} : null;
    } catch (e) { return null; }
}

async function sfDownload(onProgress) {
    const say = (n, total) => { try { onProgress(n, total); } catch (e) { /* caller's problem */ } };
    const jsRes = await fetch(SF_BASE + SF_BUILD + '.js');
    if (!jsRes.ok) throw new Error(`${SF_BUILD}.js: HTTP ${jsRes.status}`);
    const js = await jsRes.text();
    const res = await fetch(SF_BASE + SF_BUILD + '.wasm');
    if (!res.ok) throw new Error(`${SF_BUILD}.wasm: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        say(got, total);
    }
    const wasm = await new Blob(chunks).arrayBuffer();
    await eeIdb('readwrite', s => s.put(js, kSfJs()));
    await eeIdb('readwrite', s => s.put(wasm, kSfWasm()));
    return {js, wasm, bytes: js.length + wasm.byteLength};
}

async function sfForget() {
    try {
        await eeIdb('readwrite', s => s.delete(kSfJs()));
        await eeIdb('readwrite', s => s.delete(kSfWasm()));
    } catch (e) { /* nothing cached */ }
}

async function eeCached() {
    try {
        const js = await eeIdb('readonly', s => s.get(kJs()));
        const wasm = await eeIdb('readonly', s => s.get(kWasm()));
        return (js && wasm) ? {js, wasm, bytes: js.length + wasm.byteLength} : null;
    } catch (e) { return null; }
}

// One download, reported in bytes as it arrives -- 28.7 MB with no progress is indistinguishable
// from a hang, which is the whole reason this is behind a button rather than automatic.
async function eeDownload(onProgress) {
    const say = (n, total, what) => { try { onProgress(n, total, what); } catch (e) { /* caller's problem */ } };
    const jsRes = await fetch(EE_BASE + 'explanation-engine.js');
    if (!jsRes.ok) throw new Error(`explanation-engine.js: HTTP ${jsRes.status}`);
    const js = await jsRes.text();

    const res = await fetch(EE_BASE + 'explanation-engine.wasm');
    if (!res.ok) throw new Error(`explanation-engine.wasm: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        say(got, total, 'engine');
    }
    const wasm = new Blob(chunks).arrayBuffer ? await new Blob(chunks).arrayBuffer() : null;
    if (!wasm) throw new Error('could not assemble the engine');
    await eeIdb('readwrite', s => s.put(js, kJs()));
    await eeIdb('readwrite', s => s.put(wasm, kWasm()));
    return {js, wasm, bytes: js.length + wasm.byteLength};
}

async function eeForget() {
    try {
        await eeIdb('readwrite', s => s.delete(kJs()));
        await eeIdb('readwrite', s => s.delete(kWasm()));
    } catch (e) { /* nothing cached */ }
}

// Run one batch of commands and hand back the verdict. The sandbox is created and destroyed per
// run: the engine holds the whole game internally and there is no command to reset it, so reusing
// one would analyse the previous game again with this one appended.
function eeRun(assets, commands, {timeoutMs = 180000} = {}) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('src/options/ee-sandbox.html');
        frame.style.display = 'none';
        let settled = false;
        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            try { frame.remove(); } catch (e) { /* already gone */ }
            err ? reject(err) : resolve(val);
        };
        const timer = setTimeout(() => finish(new Error('the explanation engine did not answer')), timeoutMs);
        const onMsg = (ev) => {
            if (ev.source !== frame.contentWindow) return;
            const m = ev.data || {};
            if (m.type === 'error') return finish(new Error(m.error || 'engine error'));
            if (m.type === 'booted') {
                for (const line of commands) frame.contentWindow.postMessage({cmd: 'send', line}, '*');
                return;
            }
            // Its answers are one line each; the verdict is the one that opens with the game header.
            if (m.type === 'line' && /^json \{"whiteElo"/.test(m.line)) {
                let out = null;
                try { out = JSON.parse(m.line.slice(5)); } catch (e) { return finish(new Error('unreadable verdict')); }
                finish(null, out);
            }
        };
        window.addEventListener('message', onMsg);
        frame.onload = () => {
            // The wasm is transferred, not copied: 28.7 MB through the structured clone twice per
            // run is a visible stall on its own.
            const copy = assets.wasm.slice(0);
            frame.contentWindow.postMessage({cmd: 'boot', js: assets.js, wasm: copy}, '*', [copy]);
        };
        document.body.appendChild(frame);
    });
}

// Search every position with chess.com's own Stockfish, in the sandbox, at their budget. One
// sandbox for the whole game: Stockfish is stateless between `position` commands, unlike the
// classifier, which accumulates the game and has no reset.
//
// `positions` is filled IN PLACE with {lines, depth} in the same shape our own engine transport
// produces -- white-relative cp, pv as an array of UCI moves -- so everything downstream (assemble,
// eeCommands, the renderer) cannot tell which engine searched.
function sfSearch(assets, positions, {depth = 10, multipv = 2, uciMoves = null, onProgress, timeoutMs = 60000} = {}) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('src/options/ee-sandbox.html');
        frame.style.display = 'none';
        let settled = false;
        let onLine = null;
        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            try { frame.contentWindow.postMessage({cmd: 'quit'}, '*'); } catch (e) { /* already gone */ }
            try { frame.remove(); } catch (e) { /* already gone */ }
            err ? reject(err) : resolve(val);
        };
        let timer = setTimeout(() => finish(new Error('Stockfish did not answer')), timeoutMs);
        const bump = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('Stockfish stopped answering')), timeoutMs); };
        const send = (line) => frame.contentWindow.postMessage({cmd: 'send', line}, '*');
        const onMsg = (ev) => {
            if (ev.source !== frame.contentWindow) return;
            const m = ev.data || {};
            if (m.type === 'error') return finish(new Error(m.error || 'Stockfish error'));
            if (m.type === 'booted') return run();
            if (m.type === 'line' && onLine) onLine(String(m.line));
        };
        const until = (re) => new Promise((res) => {
            const prev = onLine;
            onLine = (l) => { if (collect) collect(l); if (re.test(l)) { onLine = prev; res(l); } };
        });
        let collect = null;
        async function run() {
            try {
                send('uci'); await until(/^uciok/);
                // The options they set, in their order. Skill Level 20 is full strength (their
                // way of saying "not limited") and Contempt is rejected by this build as "No such
                // option" -- sent anyway, because matching their stream exactly costs nothing and
                // guessing which of their commands mattered is how a difference gets introduced.
                send('setoption name Skill Level value 20');
                send('setoption name Contempt value 0');
                send(`setoption name MultiPV value ${multipv}`);
                send('setoption name Threads value 1');
                send('isready'); await until(/^readyok/);
                for (let i = 0; i < positions.length; i++) {
                    const p = positions[i];
                    const best = {};
                    // Keep only lines at the FINAL depth: the search reports every depth on its way
                    // up, and an early one would be a shallower answer wearing the same shape.
                    collect = (l) => {
                        const mp = l.match(/multipv (\d+)/), dp = l.match(/depth (\d+)/);
                        const sc = l.match(/score (cp|mate) (-?\d+)/), pv = l.match(/ pv (.*)$/);
                        if (!mp || !dp || !sc || !pv || Number(dp[1]) !== depth) return;
                        const raw = sc[1] === 'cp' ? Number(sc[2])
                            : (Number(sc[2]) > 0 ? EE_SCORE_CAP : -EE_SCORE_CAP);
                        best[Number(mp[1])] = {cp: raw, pv: pv[1].split(' ')};
                    };
                    // THE FULL HISTORY, not a bare FEN -- chess.com sends `position fen <start>
                    // moves e2e4 e7e5 ...` for every position, and so must we. A bare FEN gives the
                    // engine the same board with no past: repetition detection sees nothing to
                    // repeat, and a position it should score as a draw it scores on the material.
                    // Costs nothing and is exactly what their command line says.
                    if (uciMoves) send(`position fen ${positions[0].fen} moves ${uciMoves.slice(0, i).join(' ')}`.trimEnd());
                    else send(`position fen ${p.fen}`);
                    send(`go depth ${depth}`);
                    await until(/^bestmove/);
                    collect = null;
                    bump();
                    // Their scores are side-to-move relative, as raw UCI always is. Everything
                    // downstream expects white-relative, which is what our own transport stores.
                    const sign = p.turn === 'w' ? 1 : -1;
                    p.lines = [1, 2].filter(k => best[k]).slice(0, multipv)
                        .map(k => ({cp: best[k].cp * sign, pv: best[k].pv}));
                    p.depth = depth;
                    if (onProgress) { try { onProgress((i + 1) / positions.length, i + 1, positions.length); } catch (e) { /* */ } }
                }
                finish(null, positions);
            } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
        }
        window.addEventListener('message', onMsg);
        frame.onload = () => {
            const copy = assets.wasm.slice(0);
            frame.contentWindow.postMessage({cmd: 'boot', js: assets.js, wasm: copy, hashSuffix: SF_HASH_SUFFIX}, '*', [copy]);
        };
        document.body.appendChild(frame);
    });
}

// THE PROTOCOL, exactly as chess.com drives it -- captured from a real game and replayed back into
// this engine, which reproduced their verdict field for field (see the suite).
//
// SCORES GO IN WHITE-POSITIVE, and this function does NOT convert them -- `positions[].lines[].cp`
// is ALREADY white-relative, because engines.js stores `Core.toWhiteCp(...)` when it parses the
// engine's info lines. Raw UCI is side-to-move relative and would need flipping; ours does not, and
// flipping it again is a double negation that only shows on black's moves.
//
// That is not hypothetical: it shipped through a full end-to-end run looking plausible. Every black
// reply was scored as its own mirror image, so the classifier saw the evaluation lurch every half
// move -- accuracy came out 73% against chess.com's 97% on the same game, with nine "missed wins"
// in a quiet Ruy Lopez. Nothing errored. The white-POV requirement itself is measured: 33 of 33
// positions in a captured real game matched white-POV and only 17 matched side-to-move.
// MEASURED CEILING: the engine takes cp 30000 and ABORTS at 31000 --
// `Aborted(Assertion failed: good_score_or_none(v.score), at: ../../src/node.cpp,447,extend)`,
// which kills the whole run with no verdict. Our own mate scores are +/-(100000 - distance), so any
// game containing a mate crashed it. Binary-searched against the real engine rather than guessed.
//
// ponytail: mate DISTANCE is flattened here -- every mate reads as +/-30000, so mate-in-1 and
// mate-in-9 are the same number. That is fine for classification, which only reads the gap between
// the best move and the played one, and both are decisive. Encode the distance if a caller ever
// needs mates ordered against each other.
const EE_SCORE_CAP = 30000;

function eeScore(cp) {
    if (!Number.isFinite(cp)) return null;
    return Math.max(-EE_SCORE_CAP, Math.min(EE_SCORE_CAP, Math.round(cp)));
}

function eeCommands({positions, moves, whiteElo, blackElo, result, userColor}) {
    const cmd = [
        'uci', 'isready',
        `setoption name UserColor value ${userColor || 'white'}`,
        `setoption name Result value ${result || '*'}`,
        `setoption name WhiteElo value ${Math.round(whiteElo || 1500)}`,
        `setoption name BlackElo value ${Math.round(blackElo || 1500)}`,
        'setoption name ClassificationV3 value true',
        'setoption name ScoreWhiteToMove value true',
        'setoption name SerializeLikeCEAC value true',
        'setoption name UCI_Variant value chess',
        'setoption name UCI_Chess960 value false',
        `position fen ${positions[0].fen}`,
    ];
    const describe = (p) => {
        for (const line of (p.lines || []).slice(0, 2)) {
            if (!line || !line.pv || !line.pv.length) continue;
            const cp = eeScore(line.cp);
            if (cp === null) continue;
            cmd.push(`variation ${line.pv.join(' ')} cp ${cp} depth ${p.depth || 10}`);
        }
    };
    for (let i = 0; i < moves.length; i++) {
        describe(positions[i]);
        cmd.push(`push ${moves[i].uci}`);
    }
    // The final position gets its lines too: the last move is classified against them.
    if (positions[moves.length]) describe(positions[moves.length]);
    cmd.push('fetch analysis', 'quit');
    return cmd;
}

// Their vocabulary -> ours. `greatFind` is our `great`; everything else already matches, and an
// unknown name becomes `good` rather than throwing a whole review away over one word.
const EE_CLASS = {
    brilliant: 'brilliant', greatFind: 'great', great: 'great', best: 'best',
    excellent: 'excellent', good: 'good', book: 'book', forced: 'forced',
    inaccuracy: 'inaccuracy', mistake: 'mistake', miss: 'miss', blunder: 'blunder',
};

export {EE_VERSION, EE_BASE, EE_CLASS, EE_SCORE_CAP, eeScore, SF_BUILD, sfCached, sfDownload, sfForget, sfSearch, eeCached, eeDownload, eeForget, eeRun, eeCommands};
