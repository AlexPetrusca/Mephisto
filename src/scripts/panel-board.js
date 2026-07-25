// Minimal drop-in replacement for chessboard.js (N1 Phase 4a).
// The panel uses only a tiny slice of chessboard.js: position get/set, orientation get/set, on a
// DISPLAY-ONLY board (draggable:false). chessboard.js needs jQuery and looks its board element up via
// `document`, so it can't live in a shadow root -- this can. It emits the SAME DOM class names
// chessboard.js does (.board-b72b1 / .square-55d63 / .white-1e1d7 / .black-3c85d / .piece-417db /
// .notation-322f9 / .alpha-d2270 / .numeric-fc462), so popup.css + chessboard.css style it unchanged.
//
// API (the subset popup.js calls):
//   const b = MephistoBoard(elOrId, {position:'start'|fen|obj, orientation, pieceTheme, showNotation, root,
//                                    onMove(from, to, promotion), needsPromotion(from,to)})
//   click OR drag to move; onMove returns false to reject. needsPromotion returns 'w'/'b' to
//   pop the underpromotion picker first.
//   b.position()      -> {square: 'wP', ...}      b.position(fen|'start'|obj) -> set + re-render
//   b.orientation()   -> 'white'|'black'          b.orientation('white'|'black') -> set + re-render
//   b.resize()        -> re-render at current container size
(function () {
    const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

    function fenToObj(fen) {
        if (fen == null) return {};
        if (fen === 'start') fen = START;
        if (typeof fen === 'object') return fen;
        fen = String(fen).split(' ')[0]; // piece-placement field only
        const obj = {};
        const rows = fen.split('/');
        for (let r = 0; r < 8 && r < rows.length; r++) {
            const rank = 8 - r;
            let file = 0;
            for (const ch of rows[r]) {
                if (ch >= '1' && ch <= '8') { file += (ch.charCodeAt(0) - 48); }
                else { obj[FILES[file] + rank] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase(); file++; }
            }
        }
        return obj;
    }

    function MephistoBoard(elOrId, cfg) {
        cfg = cfg || {};
        const host = (typeof elOrId === 'string')
            ? (cfg.root || document).getElementById(elOrId)
            : elOrId;
        let orientation = cfg.orientation || 'white';
        let pos = fenToObj(cfg.position);
        const theme = cfg.pieceTheme || '';
        const pieceMap = cfg.pieceMap || null; // in-page panel: inlined data: URIs (no extension URLs)
        const showNotation = cfg.showNotation;
        const onMove = cfg.onMove || null; // onMove(from, to, promotion) -- promotion set only when asked
        const needsPromotion = cfg.needsPromotion || null; // (from,to) -> 'w'|'b'|null: ask before moving
        let selected = null;               // the square currently picked up, if any
        // Fall back to the theme path if the inlined map is missing this piece: buildPieces only
        // records pieces whose fetch succeeded, so one failure left `src=""` -- which the browser
        // renders as a broken-image glyph on that piece alone (seen on a promoted queen).
        const pieceUrl = (p) => {
            if (pieceMap && pieceMap[p]) return pieceMap[p];
            return theme ? theme.replace('{piece}', p) : '';
        };

        // Click-to-move rather than drag: the panel lives in a closed shadow root inside an
        // arbitrary page, where HTML5 drag events are unreliable and a page's own handlers can eat
        // them. Two clicks (pick up, put down) work everywhere. Clicking the same square, or an
        // empty one with nothing selected, just clears the selection.
        // Drag: remember where the press started, then resolve on release over whichever square is
        // under the pointer. elementFromPoint is used on the ROOT (the shadow root in-page), because
        // document.elementFromPoint would return the host element, not the square inside it.
        let dragFrom = null, dragX = 0, dragY = 0, dragGhost = null;

        function dragStart(ev, alg) {
            if (!pos[alg] || ev.button !== 0) return; // only a real piece, only the left button
            dragFrom = alg; dragX = ev.clientX; dragY = ev.clientY;
            ev.preventDefault();
            const root = cfg.root || document;
            const move = (e) => {
                if (!dragFrom) return;
                if (!dragGhost && Math.hypot(e.clientX - dragX, e.clientY - dragY) > 4) {
                    const src = pieceUrl(pos[dragFrom]);
                    dragGhost = document.createElement('img');
                    dragGhost.src = src;
                    const sz = host.clientWidth ? Math.floor(host.clientWidth / 8) : 40;
                    dragGhost.style.cssText = `position:fixed;width:${sz}px;height:${sz}px;` +
                        'pointer-events:none;z-index:2147483647;opacity:0.85';
                    (root.body || root).appendChild(dragGhost);
                }
                if (dragGhost) {
                    const sz = dragGhost.offsetWidth || 40;
                    dragGhost.style.left = (e.clientX - sz / 2) + 'px';
                    dragGhost.style.top = (e.clientY - sz / 2) + 'px';
                }
            };
            const up = (e) => {
                window.removeEventListener('pointermove', move, true);
                window.removeEventListener('pointerup', up, true);
                const from = dragFrom; dragFrom = null;
                const dragged = !!dragGhost;
                if (dragGhost) { dragGhost.remove(); dragGhost = null; }
                if (!dragged) return; // barely moved -> it was a click; let the click handler run
                const el = (root.elementFromPoint ? root : document).elementFromPoint(e.clientX, e.clientY);
                const sqEl = el && el.closest && el.closest('.square-55d63');
                const to = sqEl && [...sqEl.classList].map(c => c.match(/^square-([a-h][1-8])$/))
                    .find(Boolean)?.[1];
                selected = null;
                if (to && to !== from) { if (submitMove(from, to) === false) render(); }
                else render();
            };
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', up, true);
        }

        // Underpromotion. The caller decides whether a move promotes (it owns the rules); the board
        // draws the choice over the destination square, so click AND drag both get it.
        function promptPromotion(from, to, colour, done) {
            const board = host.firstChild;
            const sqEl = host.querySelector(`.square-${to}`);
            if (!board || !sqEl) return done('q'); // nowhere to put the picker -> queen, never a dead end
            const sq = sqEl.offsetWidth || Math.floor((host.clientWidth || 350) / 8);
            const menu = document.createElement('div');
            const below = sqEl.offsetTop + sq * 4 <= board.offsetHeight; // hang down unless it would overflow
            menu.style.cssText = `position:absolute;left:${sqEl.offsetLeft}px;` +
                `top:${below ? sqEl.offsetTop : sqEl.offsetTop + sq - sq * 4}px;` +
                `width:${sq}px;z-index:60;background:#f0f0f0;` +
                'box-shadow:0 2px 8px rgba(0,0,0,0.45);border-radius:3px';
            for (const t of (below ? ['q','r','b','n'] : ['n','b','r','q'])) {
                const cell = document.createElement('div');
                cell.style.cssText = `width:${sq}px;height:${sq}px;cursor:pointer`;
                const url = pieceUrl(colour + t.toUpperCase());
                if (url) {
                    const im = document.createElement('img');
                    im.src = url; im.alt = '';
                    im.style.cssText = `width:${sq}px;height:${sq}px`;
                    cell.appendChild(im);
                } else { // no artwork available -> still selectable, just lettered
                    cell.textContent = t.toUpperCase();
                    cell.style.cssText += ';text-align:center;font:bold 18px sans-serif;color:#000';
                }
                cell.addEventListener('click', (e) => { e.stopPropagation(); close(); done(t); });
                menu.appendChild(cell);
            }
            const veil = document.createElement('div'); // click anywhere else = cancel
            veil.style.cssText = 'position:absolute;inset:0;z-index:59';
            veil.addEventListener('click', (e) => { e.stopPropagation(); close(); done(null); });
            function close() { menu.remove(); veil.remove(); }
            board.appendChild(veil);
            board.appendChild(menu);
        }

        function submitMove(from, to) {
            const colour = needsPromotion && needsPromotion(from, to);
            if (!colour) return onMove(from, to);
            promptPromotion(from, to, colour, (piece) => {
                if (piece) onMove(from, to, piece); else render(); // cancelled -> put the piece back
            });
            return true;
        }

        function squareClicked(alg) {
            if (!onMove) return;
            if (selected === alg) { selected = null; render(); return; }
            if (selected) {
                const from = selected;
                selected = null;
                if (submitMove(from, alg) === false) render(); // rejected -> just drop the selection
                return;
            }
            if (!pos[alg]) return;   // nothing there to pick up
            selected = alg;
            render();
        }

        function render() {
            if (!host) return;
            const size = host.clientWidth || 350;
            const sq = Math.floor(size / 8);
            const board = document.createElement('div');
            board.className = 'board-b72b1';
            board.style.width = (sq * 8) + 'px';
            board.style.height = (sq * 8) + 'px';
            const ranks = (orientation === 'white') ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
            const files = (orientation === 'white') ? FILES : [...FILES].reverse();
            for (let ri = 0; ri < 8; ri++) {
                const row = document.createElement('div');
                row.style.cssText = 'clear:both';
                for (let fi = 0; fi < 8; fi++) {
                    const f = files[fi], rk = ranks[ri], alg = f + rk;
                    const light = (FILES.indexOf(f) + rk) % 2 === 0; // a1 dark, h1 light
                    const s = document.createElement('div');
                    s.className = `square-55d63 ${light ? 'white-1e1d7' : 'black-3c85d'} square-${alg}`;
                    s.style.cssText = `width:${sq}px;height:${sq}px;float:left;position:relative`;
                    if (onMove) {
                        s.style.cursor = 'pointer';
                        if (alg === selected) s.style.boxShadow = 'inset 0 0 0 3px rgba(20,184,166,0.9)';
                        s.addEventListener('click', () => squareClicked(alg));
                        // DRAG as well as click: dragging a piece is what most people reach for first.
                        // Pointer events (not HTML5 drag-and-drop, which is unreliable inside a closed
                        // shadow root and can be swallowed by the page). A press that travels less than
                        // a few pixels is left to the click handler, so both gestures coexist.
                        s.addEventListener('pointerdown', (ev) => dragStart(ev, alg));
                    }
                    const p = pos[alg];
                    const pUrl = p ? pieceUrl(p) : '';
                    if (p && pUrl) {
                        const img = document.createElement('img');
                        img.className = 'piece-417db';
                        img.alt = '';           // no alt text to render if it ever fails to load
                        img.src = pUrl;
                        img.style.cssText = `width:${sq}px;height:${sq}px`;
                        s.appendChild(img);
                    }
                    if (showNotation) {
                        if (fi === 0) { const n = document.createElement('div'); n.className = 'notation-322f9 numeric-fc462'; n.textContent = rk; s.appendChild(n); }
                        if (ri === 7) { const n = document.createElement('div'); n.className = 'notation-322f9 alpha-d2270'; n.textContent = f; s.appendChild(n); }
                    }
                    row.appendChild(s);
                }
                board.appendChild(row);
            }
            host.innerHTML = '';
            host.appendChild(board);
        }

        render();
        // The first render can run before the injected <style> has been applied/laid out, so
        // host.clientWidth may not be the CSS's 350px yet and the squares come out mis-sized.
        // Re-render once on the next frame, when layout has settled. Cheap and self-healing.
        requestAnimationFrame(() => render());
        return {
            position(arg) { if (arg === undefined) return {...pos}; pos = fenToObj(arg); render(); },
            orientation(o) { if (o === undefined) return orientation; orientation = o; render(); },
            resize() { render(); },
            clearSelection() { if (selected) { selected = null; render(); } },
        };
    }

    self.MephistoBoard = MephistoBoard;
})();
