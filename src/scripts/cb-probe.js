// ChessBase Tactics (tactics.chessbase.com) page-world probe. The board is ChessBase's proprietary
// CB.* engine (a jQWidgets UI) -- the position never appears as a scrapeable FEN anywhere in the
// DOM. But the live game model IS reachable in the MAIN world as window.V35s (a CB.ChessTrainingApp):
//   V35s.gameKernel.getCurPos().toFEN()                  -> the exact current position (side to
//                                                            move, castling, en passant, counters)
//   V35s.gameKernel.game.addOnCurPosChangedListener(fn)  -> fires on every move / navigation
// Content scripts run in an ISOLATED world and cannot read page globals, so this probe is injected
// into the MAIN world ("world": "MAIN") and bridges via DOM CustomEvents, mirroring tt-probe.js:
//   - 'mephisto-cb-query'  is answered SYNCHRONOUSLY with 'mephisto-cb-state' (the current FEN).
//   - 'mephisto-cb-update' is PUSHED on the model's onCurPosChanged the instant the position
//     changes, so a solved/taken-back move is seen immediately instead of on the fallback poll.
// Puzzles start from ARBITRARY positions, so the FEN is shipped whole (the content-script wraps it
// as '***cbfen***' and the popup feeds it to the engine directly -- no move replay).
(() => {
    // 1c (anti-detection): no persistent `window.__mephisto*` flag (a page could test
    // `'__mephistoCBProbe' in window`) and no `mephisto-*` event names. This IIFE runs once per
    // document load; a rare double injection only duplicates harmless events, so no global guard is
    // needed. Bridge channel names are de-branded to neutral tokens shared with the content script.
    // item 1: a per-SESSION RANDOM channel id, so the data-carrying events have no fixed name to
    // fingerprint. The only fixed string is the rendezvous the probe uses once to hand its id over.
    const SID = 'n' + Math.random().toString(36).slice(2, 10);
    const CB_Q = SID + 'q', CB_S = SID + 's', CB_U = SID + 'u';
    const RDV = 'm9';
    let acked = false;

    const isFen = (s) => typeof s === 'string' &&
        /^([1-8pnbrqkPNBRQK]+\/){7}[1-8pnbrqkPNBRQK]+\s+[wb]\s/.test(s);

    function curFen() {
        try {
            const gk = window.V35s && window.V35s.gameKernel;
            const fen = gk && gk.getCurPos && gk.getCurPos().toFEN();
            return isFen(fen) ? fen : null;
        } catch (e) { return null; }
    }

    // WHERE THE BOARD IS, from the same model the FEN comes from. ChessBase paints on a canvas, so
    // there is no element to measure and no class to match -- but boardWin carries the numbers
    // outright: x0/y0 (the board's origin inside the canvas), nSqPix (a square), and blackIsBottom
    // (the orientation). Canvas units are converted to page pixels by the canvas's own scale.
    // Verified against pixels: markers drawn at a1/h8/e4 landed on those squares.
    function curGeometry() {
        try {
            const gk = window.V35s && window.V35s.gameKernel;
            const bw = gk && gk.boardWin;
            const cv = gk && gk.boardArea && gk.boardArea.cbcanvas && gk.boardArea.cbcanvas.canvas;
            if (!bw || !cv || !cv.getBoundingClientRect) return null;
            const r = cv.getBoundingClientRect();
            if (!(r.width > 0) || !(cv.width > 0) || !(bw.nSqPix > 0)) return null;
            const scale = r.width / cv.width;
            return {
                x: r.left + bw.x0 * scale,
                y: r.top + bw.y0 * scale,
                size: bw.nSqPix * 8 * scale,
                flipped: !!bw.blackIsBottom,
            };
        } catch (e) { return null; }
    }

    // The payload is {fen, geo} now. It used to be the FEN alone, so a plain string is still
    // understood on the other side -- an old content script and a new probe must not deadlock.
    const send = (name, fen) =>
        document.dispatchEvent(new CustomEvent(name, {
            detail: JSON.stringify(fen == null ? null : {fen, geo: curGeometry()})}));

    // (Re)subscribe to the current game's position-changed event so moves push instantly. The game
    // object is reused across puzzles (reset + assign, not replaced), but re-check identity each
    // time in case a future build swaps it. Only real position changes fire -- this can't loop.
    let subGame = null;
    function ensureSubscribed() {
        try {
            const g = window.V35s && window.V35s.gameKernel && window.V35s.gameKernel.game;
            if (!g || g === subGame || typeof g.addOnCurPosChangedListener !== 'function') return;
            subGame = g;
            g.addOnCurPosChangedListener(() => {
                const fen = curFen();
                if (fen) send(CB_U, fen);
            });
        } catch (e) { /* model not ready / no listener API -- query + fallback poll still cover it */ }
    }

    // query side: always answers synchronously with the CURRENT position (null if no game yet)
    document.addEventListener(CB_Q, () => {
        acked = true; // the content script is talking on our channel -> stop announcing
        ensureSubscribed();
        send(CB_S, curFen());
    });

    // hand our random channel id to the ISOLATED content script over the fixed rendezvous, retrying
    // until it starts querying on that id (covers either injection order); then stop.
    const announce = () => document.dispatchEvent(new CustomEvent(RDV, {detail: JSON.stringify({t: 'cb', s: SID})}));
    announce();
    const annInt = setInterval(() => acked ? clearInterval(annInt) : announce(), 100);
    setTimeout(() => clearInterval(annInt), 5000);

    // The app boots async; poll briefly until the model exists, then push the first position and
    // wire the subscription. After that, onCurPosChanged pushes and queries carry the state.
    let tries = 0;
    const boot = setInterval(() => {
        const fen = curFen();
        if (fen) { ensureSubscribed(); send(CB_U, fen); clearInterval(boot); }
        if (++tries > 60) clearInterval(boot); // ~30s ceiling, then rely on queries
    }, 500);
})();
