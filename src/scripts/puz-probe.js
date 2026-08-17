// Puzzle page-world probe (lichess, chess.com). OFF unless the user turns the setting on.
//
// WHAT THIS IS FOR. A puzzle has ONE scored answer, and the engine's best move is a different thing:
// a stronger move that is not the intended one still loses the puzzle. The puzzle database answers
// that, but only for positions somebody imported. These sites hand their own client the solution --
// they have to, because the page validates your moves locally and offline -- so the answer for the
// puzzle actually on screen is already in the tab. This reads it there instead.
//
// PASSIVE ONLY, AND THAT IS THE WHOLE DESIGN. An earlier attempt at this re-fetched the page URL to
// read the payload and was REVERTED: re-fetching /storm returns a DIFFERENT RUN, so the position on
// screen matched none of the 137 puzzles that came back. Feeding those solutions plays confidently
// wrong moves, which is strictly worse than not having the feature. Nothing here ever issues a
// request. It sees what the page was already given, and if it sees nothing it stays silent.
//
// The lesson from that revert is also the safety rule: COMPARE AGAINST THE RENDERED BOARD, never
// against another copy of the same guess. Everything captured here is keyed by its own position and
// checked against the board before it is ever played, on the isolated side where chess.js lives.
//
// TWO SOURCES, because the sites differ:
//   - the BOOTSTRAP JSON in the document. Lichess ships its whole Storm/Racer set this way, and
//     then DELETES the script node once it has read it -- which is why this runs at document_start
//     and snapshots the nodes as they appear, rather than reading them later and finding nothing.
//   - the FETCH/XHR responses, for every puzzle after the first (and for chess.com generally).
//
// This world cannot use chess.js, so it does SHAPE extraction only: something that looks like a FEN
// next to something that looks like a line of moves. Whether that line is legal from that position,
// and whether that position is the one on the board, is decided on the other side of the bridge.
(() => {
    // Same conventions as the other probes: a per-session random channel, no persistent
    // window.__mephisto* flag for a page to test for, no branded event names. The only fixed string
    // is the one-time rendezvous.
    const SID = 'm' + Math.random().toString(36).slice(2, 10);
    const CH = SID + 'p';
    const RDV = 'm9';   // the one rendezvous every probe announces on; 't' says which probe it is
    let acked = false;

    // A placement field: eight ranks of pieces and digits, slash separated. Deliberately matched on
    // its own rather than on a whole FEN -- some payloads carry the placement with the side to move
    // and the rights, some carry only part of it, and the isolated side normalises either way.
    const FEN_RE = /^([rnbqkpRNBQKP1-8]{1,8}\/){7}[rnbqkpRNBQKP1-8]{1,8}(\s+[wb]\b[^"]*)?$/;
    const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/;

    // A solution is either an array of UCI moves or one space-separated string of them. Anything
    // else (SAN, a site's own encoding) is NOT guessed at here: it is passed through as `raw` and
    // reported, so an unrecognised shape shows up as a diagnostic rather than as a wrong move.
    const asLine = (v) => {
        if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && UCI_RE.test(x))) {
            return v.join(' ');
        }
        if (typeof v === 'string' && v.trim()) {
            const parts = v.trim().split(/\s+/);
            if (parts.length && parts.every(x => UCI_RE.test(x))) return parts.join(' ');
        }
        return null;
    };

    // A SOLUTION AS AN ARRAY OF MOVE OBJECTS, which is what chess.com's rated puzzles ship. The
    // squares may be algebraic ("e2") or a square INDEX, and an index has two plausible origins --
    // 0 = a1 (which is what their own TCN uses) or 0 = a8. Rather than pick one, every reading is
    // offered as a candidate: the isolated side replays them and keeps whichever is legal, which is
    // the same rule that protects every other guess in this file.
    const ALG_RE = /^[a-h][1-8]$/;
    const sqFromIdx = (i, topLeft) => String.fromCharCode(97 + (i % 8))
        + (topLeft ? (8 - Math.floor(i / 8)) : (Math.floor(i / 8) + 1));

    function objLineCandidates(arr) {
        if (!Array.isArray(arr) || !arr.length || arr.length > 60) return [];
        if (!arr.every(x => x && typeof x === 'object' && !Array.isArray(x))) return [];
        const pick = (o, names) => { for (const n of names) if (o && o[n] !== undefined && o[n] !== null) return o[n]; };
        const FROM = ['from', 'fromSquare', 'src', 'f'], TO = ['to', 'toSquare', 'dst', 't'];
        // The move may BE the element, or sit one level inside it: chess.com's rated puzzles ship
        // [{move: {from, to}, moveClassification: ...}], so the squares are a wrapper down. Take the
        // element itself when it carries them, otherwise the first nested object that does.
        const inner = (o) => {
            if (pick(o, FROM) !== undefined && pick(o, TO) !== undefined) return o;
            for (const v of Object.values(o)) {
                if (v && typeof v === 'object' && !Array.isArray(v)
                    && pick(v, FROM) !== undefined && pick(v, TO) !== undefined) return v;
            }
            return null;
        };
        const cells = arr.map(inner);
        if (cells.some(x => !x)) return [];
        const froms = cells.map(o => pick(o, FROM));
        const tos = cells.map(o => pick(o, TO));
        if (froms.some(x => x === undefined) || tos.some(x => x === undefined)) return [];
        const promos = cells.map((o, i) => {
            const p = pick(o, ['promotion', 'promo', 'p']) ?? pick(arr[i], ['promotion', 'promo']);
            if (typeof p !== 'string') return '';
            // enum-style names as well as a bare letter: PROMOTION_QUEEN, PIECE_KNIGHT, "q"
            const u = p.toUpperCase();
            if (u.indexOf('QUEEN') >= 0) return 'q';
            if (u.indexOf('ROOK') >= 0) return 'r';
            if (u.indexOf('BISHOP') >= 0) return 'b';
            if (u.indexOf('KNIGHT') >= 0) return 'n';
            return p.toLowerCase().charAt(0);
        });
        const build = (conv) => {
            const out = [];
            for (let i = 0; i < arr.length; i++) {
                const f = conv(froms[i]), t = conv(tos[i]);
                if (!f || !t) return null;
                out.push(f + t + ('qrbn'.indexOf(promos[i]) >= 0 ? promos[i] : ''));
            }
            return out.join(' ');
        };
        // "e2", "E2", and the protobuf enum spelling "SQUARE_E2" are all the same square. chess.com's
        // rated puzzles use the last of those, which is why a plain algebraic test found nothing.
        const alg = (v) => {
            if (typeof v !== 'string') return null;
            const t = v.trim();
            if (ALG_RE.test(t)) return t;
            const m = /(?:^|_)([A-Ha-h])([1-8])$/.exec(t);
            return m ? (m[1].toLowerCase() + m[2]) : null;
        };
        const idx = (topLeft) => (v) => {
            const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : null);
            return (n !== null && n >= 0 && n < 64) ? sqFromIdx(n, topLeft) : null;
        };
        const seen = {}, out = [];
        for (const c of [build(alg), build(idx(false)), build(idx(true))]) {
            if (c && !seen[c]) { seen[c] = 1; out.push(c); }
        }
        return out;
    }

    // Walk any JSON and collect every object that carries BOTH a position and a line, whatever they
    // are called. Field names are not hardcoded because they differ per site and per endpoint, and a
    // hardcoded name is a feature that breaks silently the day it is renamed.
    function harvest(node, out, depth) {
        if (!node || depth > 8 || out.length >= 400) return;
        if (Array.isArray(node)) {
            for (const v of node) harvest(v, out, depth + 1);
            return;
        }
        if (typeof node !== 'object') return;
        let fen = null, line = null, alts = null, raw = null, id = null, rating = null;
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'number' && /^rating$/i.test(k) && v > 0 && v < 4000) rating = v;
            if (typeof v === 'string' && FEN_RE.test(v.trim())) fen = fen || v.trim();
            else if (!line && !alts) {
                const got = asLine(v);
                if (got) { line = got; }
                else {
                    const objs = objLineCandidates(v);
                    if (objs.length) alts = objs;
                    // A solution in an encoding this world cannot read is passed through WHOLE, not
                    // sampled: chess.com's is its own TCN, and the isolated side has the decoder for
                    // it. The key name and the real SHAPE travel too -- an array of objects stringifies
                    // to "[object Object]", which named nothing and cost a round trip to find out.
                    else if (!raw && /sol|line|move|tcn/i.test(k) && (typeof v === 'string' || Array.isArray(v))) {
                        let s;
                        try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
                        if (s && s.length <= 4000) raw = {key: k, value: s};
                    }
                }
            }
            if (!id && /^(id|puzzleId)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) id = String(v);
        }
        if (fen && (line || alts || raw)) out.push({fen, line, alts, raw, id, rating});
        for (const v of Object.values(node)) harvest(v, out, depth + 1);
    }

    // NO FEN AT ALL is the normal case, not the exception: lichess ships the puzzle as the GAME'S
    // MOVES plus a solution, and leaves deriving the position to its own client. So collect the two
    // halves wherever they sit -- they are in sibling objects (`game.pgn` and `puzzle.solution`), not
    // in one -- and pair them up.
    //
    // Pairing is deliberately GENEROUS rather than clever. A wrong pairing cannot survive the other
    // side of the bridge, where the moves are replayed and only an interpretation that is legal all
    // the way through is kept, so guessing wide costs nothing and guessing narrow loses real pages.
    // Pawn moves are the ones worth being careful about: `e4` is a file and a rank, NOT two files,
    // and a version of this that required two rejected every real game outright.
    const SAN_RE = /^(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?$/;
    const asSan = (v) => {
        if (typeof v !== 'string' || v.indexOf('/') >= 0) return null;
        const parts = v.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2 || parts.length > 400) return null;
        return parts.every(t => SAN_RE.test(t)) ? parts.join(' ') : null;
    };

    function harvestSan(node, sans, lines, plies, ratings, depth) {
        if (!node || depth > 8) return;
        if (Array.isArray(node)) {
            const l = asLine(node);
            if (l) lines.push(l);
            for (const v of node) harvestSan(v, sans, lines, plies, ratings, depth + 1);
            return;
        }
        if (typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string') {
                const s = asSan(v);
                if (s && sans.length < 20) sans.push(s);
                const l = asLine(v);
                if (l && lines.length < 20) lines.push(l);
            } else if (Array.isArray(v)) {
                const l = asLine(v);
                if (l && lines.length < 20) lines.push(l);
            } else if (typeof v === 'number' && /ply/i.test(k) && v >= 0 && v < 1000) {
                plies.push(v);
            } else if (typeof v === 'number' && /^rating$/i.test(k) && v > 0 && v < 4000) {
                ratings.push(v);   // lichess keeps it in the puzzle object, a sibling of the game pgn
            }
            harvestSan(v, sans, lines, plies, ratings, depth + 1);
        }
    }

    // EVERYTHING IS BUFFERED, because the most valuable capture happens before anyone is listening:
    // this probe runs at document_start and the isolated-world content script does not exist yet, so
    // a Storm set read out of the bootstrap script would be dispatched into an empty room and lost.
    // The buffer is replayed on request, and the buffer is also why a puzzle captured once stays
    // available when the board reaches it several puzzles later.
    const buf = [];
    const keys = new Set();
    const send = (found, where) => {
        const fresh = [];
        for (const f of found) {
            const k = (f.fen || f.pgn || '') + '|' + (f.line || '');
            if (keys.has(k)) continue;
            keys.add(k);
            const rec = {...f, where};
            buf.push(rec);
            fresh.push(rec);
        }
        if (buf.length > 600) buf.splice(0, buf.length - 600);
        if (!fresh.length) return;
        try {
            document.dispatchEvent(new CustomEvent(CH, {detail: JSON.stringify({found: fresh})}));
        } catch (e) { /* a page that broke CustomEvent is not worth fighting */ }
    };
    // INGEST FROM OUTSIDE. Patching the page's own plumbing is a race we do not always win --
    // chess.com's bundle takes its reference to fetch before this script installs, so Puzzle Rush's
    // response never passes through any wrapper here. The service worker reads that body over the
    // debugger and injects it into THIS world (executeScript world:MAIN) as a fixed-name event, so it
    // goes through exactly the same extraction as anything we caught ourselves. It has to arrive in
    // the main world: a content script dispatching across worlds hands us `detail: null` (an
    // isolated->main CustomEvent cannot carry its payload), which is measured, not assumed -- the
    // body was received and the probe saw nothing. Same-world dispatch keeps the detail intact.
    document.addEventListener('m7', (e) => {
        try { scan(String(e.detail || ''), 'cdp'); } catch (err) { /* */ }
    });

    // replay: the isolated side asks once, when it wires its listener. That request is also the ack
    // that stops the announcements above.
    document.addEventListener(SID + 'r', () => {
        acked = true;
        if (!buf.length) return;
        try { document.dispatchEvent(new CustomEvent(CH, {detail: JSON.stringify({found: buf})})); }
        catch (e) { /* */ }
    });

    // Cheap pre-filter, so an ordinary payload costs one regex and nothing else. This runs on the RAW
    // text, before JSON.parse, so it must allow the ESCAPED slashes some servers send: chess.com's
    // Puzzle Rush ships "1k4rr\/1pp5\/..." and the un-escaped board pattern found nothing, which is
    // exactly why a body that plainly held the puzzles read as empty. The field-name alternative
    // covers a solution with no board string beside it, under whatever the site calls it.
    const looksInteresting = (t) => /[rnbqkp1-8]{2,}\\?\/[rnbqkp1-8]{2,}\\?\//i.test(t)
        || /"(?:solution|line|moves|tcn[a-z]*|fen\d?|initialfen)"\s*:/i.test(t);

    function scan(text, where) {
        if (typeof text !== 'string' || text.length < 40 || text.length > 4e6) return;
        if (!looksInteresting(text)) return;
        let data;
        try { data = JSON.parse(text); } catch (e) { return; }
        scanData(data, where);
    }

    function scanData(data, where) {
        if (!data || typeof data !== 'object') return;
        const out = [];
        harvest(data, out, 0);
        // the pgn+solution form, when no position came with the payload
        if (!out.some(o => o.line)) {
            const sans = [], lines = [], plies = [], ratings = [];
            harvestSan(data, sans, lines, plies, ratings, 0);
            for (const pgn of sans) {
                for (const line of lines) out.push({pgn, line, ply: plies[0] ?? null, rating: ratings[0] ?? null});
            }
        }
        send(out, where);
    }


    // ---- source 1: the bootstrap JSON, caught before the page removes it ----
    // Lichess embeds the whole Storm/Racer set in a script node and deletes it after reading. At
    // document_start the node does not exist yet, so watch for it rather than querying for it.
    const seen = new WeakSet();
    const readScript = (el) => {
        if (!el || el.tagName !== 'SCRIPT' || seen.has(el)) return;
        seen.add(el);
        const t = (el.type || '').toLowerCase();
        if (t && !/json/.test(t)) return;             // real code, not data
        scan(el.textContent, 'page');
    };
    // OBSERVE `document`, NOT `document.documentElement`. At document_start -- which is the only time
    // that is any use here -- documentElement is frequently still null, and observe(null) THROWS, so
    // the observer was silently never installed and the whole feature captured nothing. Found by
    // listening on the probe's own channel and seeing it announce but never emit.
    try {
        new MutationObserver((recs) => {
            for (const r of recs) for (const n of r.addedNodes) readScript(n);
        }).observe(document, {childList: true, subtree: true});
    } catch (e) { /* */ }
    // A script node is sometimes inserted before its text is attached, so the childList hit above can
    // see an empty node; re-reading at these two points costs nothing and catches that case. It also
    // covers anything already parsed before this ran.
    const sweep = () => { for (const s of document.querySelectorAll('script')) { seen.delete(s); readScript(s); } };
    document.addEventListener('readystatechange', sweep);
    document.addEventListener('DOMContentLoaded', sweep);

    // ---- source 2: the responses the page fetches for every puzzle after the first ----
    // The clone() is what keeps this honest: the page gets its own untouched body, and a failure
    // anywhere in here can never break the site's own reading of its answer.
    try {
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            const p = origFetch.apply(this, args);
            try {
                p.then(res => {
                    try {
                        const ct = res.headers.get('content-type') || '';
                        if (!/json/i.test(ct)) return;
                        res.clone().text().then(t => scan(t, 'fetch'), () => {});
                    } catch (e) { /* */ }
                }, () => {});
            } catch (e) { /* */ }
            return p;
        };
    } catch (e) { /* */ }

    // ---- source 2b: the body READER, which is the one interception that cannot be raced ----
    // Patching `window.fetch` loses a race we cannot win: chess.com's bundle grabs its own reference
    // to fetch before this MAIN-world script installs, so its Puzzle Rush request never passes
    // through our wrapper. Measured directly -- a patch installed by the debugger before any page
    // script counted the call, ours counted nothing, while /challenge/puzzles plainly returned 16KB
    // of puzzles.
    //
    // `res.json()` is different: the page holds Response OBJECTS, and the method is looked up on the
    // prototype at call time, so replacing it here is seen by every caller no matter when they were
    // loaded. Whatever the page reads, we read.
    try {
        const RP = window.Response && window.Response.prototype;
        if (RP && typeof RP.json === 'function') {
            const origJson = RP.json;
            RP.json = function () {
                const pr = origJson.apply(this, arguments);
                try { pr.then(o => { try { scanData(o, 'res.json'); } catch (e) { /* */ } }, () => {}); }
                catch (e) { /* */ }
                return pr;
            };
        }
        if (RP && typeof RP.text === 'function') {
            const origText = RP.text;
            RP.text = function () {
                const pr = origText.apply(this, arguments);
                try { pr.then(t => { try { scan(t, 'res.text'); } catch (e) { /* */ } }, () => {}); }
                catch (e) { /* */ }
                return pr;
            };
        }
    } catch (e) { /* */ }

    // ---- source 3: the socket ----
    // Puzzle Rush does not fetch its puzzles: chess.com pushes them over its pubsub WEBSOCKET, so a
    // probe that only watches fetch and XHR sees a started Rush deliver nothing at all. Measured that
    // way -- Rush read seen=0 while Battle, which does ship with the page, read 80.
    // Text frames only. A binary frame would be their protobuf, which is a different job entirely and
    // is deliberately not guessed at here.
    try {
        const OrigWS = window.WebSocket;
        if (typeof OrigWS === 'function') {
            const Patched = function (...args) {
                const ws = new OrigWS(...args);
                try {
                    ws.addEventListener('message', (ev) => {
                        try { if (typeof ev.data === 'string') scan(ev.data, 'ws'); } catch (e) { /* */ }
                    });
                } catch (e) { /* */ }
                return ws;
            };
            Patched.prototype = OrigWS.prototype;
            for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
                try { Patched[k] = OrigWS[k]; } catch (e) { /* */ }
            }
            window.WebSocket = Patched;
        }
    } catch (e) { /* */ }

    try {
        const XP = XMLHttpRequest.prototype;
        const origOpen = XP.open;
        XP.open = function (...args) {
            try {
                this.addEventListener('load', () => {
                    try {
                        if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
                        const body = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
                        scan(body, 'xhr');
                    } catch (e) { /* */ }
                });
            } catch (e) { /* */ }
            return origOpen.apply(this, args);
        };
    } catch (e) { /* */ }

    // HAND THE CHANNEL ID OVER, REPEATEDLY, UNTIL SOMEONE ANSWERS. The other probes announce once
    // because they run at document_idle, alongside the content script that is listening. This one
    // runs at document_start -- it has to, or lichess has already deleted its payload -- which puts
    // every announcement it makes BEFORE the content script exists. Measured: a listener wired at
    // document_idle sees nothing at all, so the whole feature captured nothing on a real page while
    // the probe itself was working perfectly.
    //
    // `acked` stops the retries the moment the other side asks for a replay, so the usual case is a
    // couple of events and done.
    const announce = () => {
        try { document.dispatchEvent(new CustomEvent(RDV, {detail: JSON.stringify({s: SID, t: 'puz'})})); }
        catch (e) { /* */ }
    };
    announce();
    document.addEventListener('DOMContentLoaded', announce);
    window.addEventListener('load', announce);
    // Announce for the full window rather than stopping at the first ack. An ack proves SOMEONE is
    // listening, not that the content script is -- and a listener that answers first (a debugger, a
    // second frame) used to silence the announcements before the real consumer had loaded, which was
    // observed live: the probe emitted two payloads and the content script recorded seen=0. Forty
    // CustomEvents over twenty seconds is not a cost worth racing over.
    let tries = 0;
    const beat = setInterval(() => {
        if (++tries > 40) { clearInterval(beat); return; }   // ~20s, then stop quietly
        announce();
    }, 500);
})();
