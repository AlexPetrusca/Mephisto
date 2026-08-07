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
        // (square) -> ['e4','e5',...]: where the piece on `square` may legally go. The board holds no
        // rules of its own -- it draws pieces and reports clicks -- so the legality comes from the
        // panel, which has chess.js and the real position. Absent, nothing is highlighted.
        const legalTargets = cfg.legalTargets || null;
        let selected = null;               // the square currently picked up, if any
        let targets = [];                  // legal destinations for `selected`, drawn as dots
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
            if (selected === alg) { selected = null; targets = []; render(); return; }
            if (selected) {
                const from = selected;
                selected = null; targets = [];
                if (submitMove(from, alg) === false) render(); // rejected -> just drop the selection
                return;
            }
            if (!pos[alg]) return;   // nothing there to pick up
            selected = alg;
            // Ask the panel where this piece may go. A piece with no legal moves still selects, so
            // the highlight tells you it IS pinned or blocked rather than that the click missed.
            try { targets = legalTargets ? (legalTargets(alg) || []) : []; } catch (e) { targets = []; }
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
                        else if (targets.includes(alg)) {
                            // A dot for an empty square, a ring for a capture -- the same language
                            // every chess site uses, so it needs no explaining.
                            const dot = document.createElement('div');
                            dot.style.cssText = pos[alg]
                                ? `position:absolute;inset:0;border-radius:50%;box-sizing:border-box;` +
                                  `border:${Math.max(3, Math.round(sq * 0.08))}px solid rgba(20,184,166,0.85);pointer-events:none`
                                : `position:absolute;left:50%;top:50%;width:${Math.round(sq * 0.28)}px;` +
                                  `height:${Math.round(sq * 0.28)}px;margin:-${Math.round(sq * 0.14)}px 0 0 ` +
                                  `-${Math.round(sq * 0.14)}px;border-radius:50%;` +
                                  `background:rgba(20,184,166,0.55);pointer-events:none`;
                            s.appendChild(dot);
                        }
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

    // ---------------------------------------------------------------------------------------------
    // 14x14 four-player board. DISPLAY ONLY -- a separate renderer rather than a widened MephistoBoard
    // on purpose: every one of the 4PC bugs so far came from four-player positions being pushed down a
    // two-player path, and the 8x8 board above is the one piece of this panel that must not regress.
    //
    // Pieces are drawn as text glyphs, not artwork: the bundled piece sets have two colours and this
    // needs four, and a tinted white bishop reads worse than a coloured outline.
    const F4 = 'abcdefghijklmn'.split('');
    const SEAT_FILL = {r: '#d24b4b', b: '#4b7fd2', y: '#d9b036', g: '#43a35f'};
    const GLYPH = {K: '\u265A', Q: '\u265B', R: '\u265C', B: '\u265D', N: '\u265E', P: '\u265F'};
    // The cut corners: a 3x3 block at each. Same squares chess.com marks data-invisible, and the same
    // ones FEN4 writes as ordinary empty squares.
    const isCorner = (row, col) => (row < 3 || row > 10) && (col < 3 || col > 10);

    // Which board square each screen cell shows, for each seat sitting at the bottom. Canonical is
    // Red at the bottom: row 0 is rank 14, col 0 is file a. The other three are that rotated, worked
    // out once here so nothing downstream has to think about rotation.
    const VIEW = {
        r: (r, c) => [c, 13 - r],            // [fileIndex, rankIndex] (rankIndex 0 == rank 1)
        y: (r, c) => [13 - c, r],
        b: (r, c) => [13 - r, 13 - c],
        g: (r, c) => [r, c],
    };

    function fen4ToObj(fen4) {
        const obj = {};
        if (!fen4) return obj;
        // Board is the LAST dash-separated field (RULES.md 11.1) -- turn/dead/castling/points/halfmove
        // and the optional {extra} block all come before it.
        const rows = String(fen4).slice(String(fen4).lastIndexOf('-') + 1).split('/');
        for (let i = 0; i < rows.length && i < 14; i++) {
            const rank = 14 - i;                       // rank 14 is written first
            let file = 0;
            for (const cell of rows[i].split(',')) {
                if (/^\d+$/.test(cell)) { file += parseInt(cell, 10); continue; }   // a run of empties
                if (cell.length >= 2 && file < 14) obj[F4[file] + rank] = {seat: cell[0], type: cell[1]};
                file++;
            }
        }
        return obj;
    }

    function MephistoBoard4PC(elOrId, cfg) {
        cfg = cfg || {};
        const host = (typeof elOrId === 'string') ? (cfg.root || document).getElementById(elOrId) : elOrId;
        let pos = {}, seat = 'r';                      // `seat` is whoever sits at the BOTTOM
        let hl = [];   // [{from, to, color, width}] -- one per engine line, best first
        let last = null;                               // the FEN4 on screen, so a re-scrape is a no-op
        const SQ4 = /^([a-n](?:1[0-4]|[1-9]))([a-n](?:1[0-4]|[1-9]))/;

        function render() {
            if (!host) return;
            const sq = Math.max(8, Math.floor((host.clientWidth || 350) / 14));
            const board = document.createElement('div');
            board.className = 'board-b72b1';
            board.style.cssText = `width:${sq * 14}px;height:${sq * 14}px;position:relative`;
            const view = VIEW[seat] || VIEW.r;
            const centre = {};                         // algebraic -> pixel centre, for the arrow
            for (let r = 0; r < 14; r++) {
                const row = document.createElement('div');
                row.style.cssText = 'clear:both';
                for (let c = 0; c < 14; c++) {
                    const s = document.createElement('div');
                    s.style.cssText = `width:${sq}px;height:${sq}px;float:left;position:relative`;
                    const [fi, ri] = view(r, c);
                    if (isCorner(13 - ri, fi)) {       // outside the cross: no square at all
                        s.style.background = 'transparent';
                        row.appendChild(s);
                        continue;
                    }
                    const alg = F4[fi] + (ri + 1);
                    centre[alg] = {x: c * sq + sq / 2, y: r * sq + sq / 2};
                    const p = pos[alg];
                    s.style.background = (fi + ri) % 2 === 0 ? '#8f8f8f' : '#d9d9d9';
                    if (p && GLYPH[p.type]) {
                        const g = document.createElement('div');
                        g.textContent = GLYPH[p.type];
                        g.style.cssText = `position:absolute;inset:0;line-height:${sq}px;text-align:center;` +
                            `font-size:${Math.round(sq * 1.04)}px;color:${SEAT_FILL[p.seat] || '#888'};` +
                            `-webkit-text-stroke:${Math.max(1, Math.round(sq * 0.05))}px #1a1a1a;`;
                        s.appendChild(g);
                    }
                    row.appendChild(s);
                }
                board.appendChild(row);
            }
            // The suggested move, as an arrow. The page-side arrows the two-player panel relies on are
            // drawn over an 8x8 board and know nothing about a 14x14 one, so without this the move is
            // text only -- and `a8f13` is not something you can find on a 196-square board at a glance.
            // Drawn back to front, so the best line's arrow sits on top of the alternatives.
            const drawable = hl.map(h => ({h, a: centre[h.from], b: centre[h.to]}))
                               .filter(x => x.a && x.b);
            if (drawable.length) {
                const NS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(NS, 'svg');
                svg.setAttribute('width', sq * 14);
                svg.setAttribute('height', sq * 14);
                svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
                for (const {h, a, b: b2} of drawable.slice().reverse()) {
                    const ang = Math.atan2(b2.y - a.y, b2.x - a.x);
                    const head = Math.max(6, sq * 0.42);
                    // stop the shaft short of the head so the two do not overlap into a blob
                    const tx = b2.x - Math.cos(ang) * head, ty = b2.y - Math.sin(ang) * head;
                    const line = document.createElementNS(NS, 'line');
                    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
                    line.setAttribute('x2', tx); line.setAttribute('y2', ty);
                    line.setAttribute('stroke', h.color);
                    line.setAttribute('stroke-width', Math.max(2, sq * h.width));
                    line.setAttribute('stroke-linecap', 'round');
                    line.setAttribute('opacity', '0.9');
                    const tip = document.createElementNS(NS, 'polygon');
                    const wing = (k) => `${b2.x - Math.cos(ang - k) * head},${b2.y - Math.sin(ang - k) * head}`;
                    tip.setAttribute('points', `${b2.x},${b2.y} ${wing(0.5)} ${wing(-0.5)}`);
                    tip.setAttribute('fill', h.color);
                    tip.setAttribute('opacity', '0.9');
                    svg.appendChild(line); svg.appendChild(tip);
                }
                board.appendChild(svg);
            }
            host.innerHTML = '';
            host.appendChild(board);
        }

        render();
        requestAnimationFrame(() => render());   // same settle as the 8x8 board: CSS may not be applied yet
        return {
            // A CHANGED position invalidates the old suggestion, so the arrow goes with it rather
            // than pointing at a move nobody is going to play. An UNCHANGED one must not: the board
            // is re-scraped on the fallback poll every second or so, and clearing on every call wiped
            // the arrow a second after it was drawn.
            position(fen4) {
                if (fen4 === last) return;
                last = fen4; pos = fen4ToObj(fen4); hl = []; render();
            },
            orientation(s) {
                const next = (s || 'r').toLowerCase();
                if (next === seat) return;
                seat = next; render();
            },
            // A move, or a list of them: [{move, color, width}]. The panel board is the same
            // answer as the page board, so it shows the same arrows -- one per engine line rather
            // than only the best, which is what Multiple Lines asks for everywhere else.
            highlight(moves) {
                const list = Array.isArray(moves) ? moves : (moves ? [{move: moves}] : []);
                hl = list.map(x => {
                    const m = SQ4.exec((typeof x === 'string' ? x : x && x.move) || '');
                    return m ? {from: m[1], to: m[2],
                                color: (x && x.color) || '#14b8a6', width: (x && x.width) || 0.2} : null;
                }).filter(Boolean);
                render();
            },
            resize() { render(); },
        };
    }

    self.MephistoBoard4PC = MephistoBoard4PC;

})();
