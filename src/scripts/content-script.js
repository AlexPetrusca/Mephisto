let site; // the site that the content-script was loaded on (lichess, chess.com, blitztactics.com)
let config; // configuration pulled from popup
let startPosCache; // cache of non-standard starting positions as puzzle strings (to support chess960)
let moving = false; // whether the content-script is performing a move
let mephistoTabId = null; // this tab's id, so the popup iframe talks to ONLY this tab (see below)

// ask the background for our own tab id as early as possible (content-script sender.tab is always
// populated). The popup iframe uses it to message just this tab instead of the globally-active tab.
try {
    chrome.runtime.sendMessage({getTabId: true}, r => {
        if (!chrome.runtime.lastError) mephistoTabId = r?.tabId ?? null;
    });
} catch (e) { /* extension context not ready; popup falls back to active-tab messaging */ }

const LOCAL_CACHE = 'mephisto.startPosCache';
const DEFAULT_POSITION = 'w*****b-r-a8*****b-n-b8*****b-b-c8*****b-q-d8*****b-k-e8*****b-b-f8*****b-n-g8*****' +
    'b-r-h8*****b-p-a7*****b-p-b7*****b-p-c7*****b-p-d7*****b-p-e7*****b-p-f7*****b-p-g7*****b-p-h7*****' +
    'w-p-a2*****w-p-b2*****w-p-c2*****w-p-d2*****w-p-e2*****w-p-f2*****w-p-g2*****w-p-h2*****w-r-a1*****' +
    'w-n-b1*****w-b-c1*****w-q-d1*****w-k-e1*****w-b-f1*****w-n-g1*****w-r-h1*****';

const MEPHISTO_BUILD = '3.2.0'; // bump on every content-script change; verify in the page console after reload
window.onload = () => {
    console.log(`Mephisto is listening! (content-script build ${MEPHISTO_BUILD})`);
    const siteMap = {
        'lichess.org': 'lichess',
        'www.chess.com': 'chesscom',
        'blitztactics.com': 'blitztactics'
    };
    site = siteMap[window.location.hostname];
    pullConfig();
    determineStartPosition();
    startPositionObserver();
};

chrome.runtime.onMessage.addListener((response, sender, sendResponse) => {
    if (response.toggleOverlay) {
        toggleOverlay();
        return;
    }
    if (response.detectVariant) {
        sendResponse({variant: detectLichessVariant()});
        return;
    }
    if (response.queryfen) {
        // Fallback poll from the popup (positions normally arrive via pushPosition). ALWAYS
        // answer so the popup's in-flight guard clears immediately. While moving/unconfigured
        // the DOM is transient, so answer 'no' (skip); the observer pushes the real position
        // the instant we're idle again.
        let res = 'no', orient;
        if (!moving && config) {
            res = tryScrapePosition();
            orient = getOrientation();
        }
        try {
            chrome.runtime.sendMessage({ dom: res, orient: orient, fenresponse: true });
        } catch (e) {
            // extension was reloaded — this orphaned content-script can't reach it anymore
        }
        return;
    }
    if (moving) return;
    if (response.automove) {
        if (!config.autoplay) return; // safety: never auto-move if autoplay was turned off since the message was sent
        toggleMoving();
        try {
            if (config.puzzle_mode) {
                console.log(response.pv);
                simulatePvMoves(response.pv).finally(toggleMoving);
            } else {
                console.log(response.move);
                simulateMoveVerified(response.move, response.deselect, response.verify).finally(toggleMoving);
            }
        } catch (e) {
            toggleMoving(); // a sync throw (e.g. board vanished) must not leave `moving` stuck true
            console.warn('Mephisto: automove failed:', e);
        }
    } else if (response.pushConfig) {
        console.log(response.config);
        config = response.config;
        // a (re)opened popup hasn't seen any position yet -- invalidate the dedupe and push now
        lastPushedPosition = null;
        schedulePositionPush();
    } else if (response.drawHint) {
        drawHintArrows(response.arrows);
    } else if (response.clearHint) {
        clearHintArrow();
    } else if (response.drawEvalBar) {
        drawEvalBar(response);
    } else if (response.clearEvalBar) {
        clearEvalBar();
    } else if (response.consoleMessage) {
        console.log(response.consoleMessage);
    }
});

// ------------------------------------------------------------------------------------------
// Event-driven position updates. The popup used to POLL {queryfen} every fen_refresh ms
// (10ms default = up to 100 full DOM scrapes and forced layout passes per second, per tab),
// which starved the page's main thread and made the site -- and sometimes Chrome itself --
// stutter or hang. Instead, a MutationObserver watches the page and PUSHES a scrape only when
// the DOM actually changed; the popup keeps a slow poll purely as a safety net. Mutation
// bursts (piece animations, batched move-list updates) coalesce through a short debounce, and
// identical scrapes are deduped so the popup only ever hears about real position changes.

const PUSH_DEBOUNCE_MS = 30; // at most one scrape per 30ms, and only while the DOM is mutating

let positionObserver = null;
let positionPushTimer = null;
let lastPushedPosition = null;

function startPositionObserver() {
    if (positionObserver || !document.body) return;
    positionObserver = new MutationObserver(schedulePositionPush);
    positionObserver.observe(document.body, {
        childList: true,   // moves appended to the move list; board/pieces added or removed
        subtree: true,
        attributes: true,  // pieces move via style transforms and class changes
        attributeFilter: ['class', 'style'],
        // no characterData: clock text ticks would wake us pointlessly; anything that changes
        // the POSITION also adds/moves elements, which the two filters above already catch
    });
}

function schedulePositionPush() {
    if (positionPushTimer) return; // a push is already pending; this mutation coalesces into it
    positionPushTimer = setTimeout(() => {
        positionPushTimer = null;
        pushPosition();
    }, PUSH_DEBOUNCE_MS);
}

function pushPosition() {
    if (moving || !config) return; // mid-automove/unconfigured; toggleMoving/pushConfig re-push after
    const res = tryScrapePosition();
    if (res === 'no') return; // transient (board animating): the animation's own mutations retry this
    const orient = getOrientation();
    const key = `${orient}|${res}`;
    if (key === lastPushedPosition) return; // nothing actually changed (clock tick, hover, ...)
    lastPushedPosition = key;
    try {
        chrome.runtime.sendMessage({dom: res, orient: orient, fenresponse: true});
    } catch (e) {
        // extension was reloaded — this orphaned content-script can't reach it anymore
    }
}

// ------------------------------------------------------------------------------------------
// In-page overlay: the whole Mephisto panel (popup.html) injected into the page as a
// draggable floating window, like Chessvision's. Toggled by clicking the toolbar icon.
// Unlike the anchored popup it can be moved anywhere and stays open while you play.

const PANEL_OVERLAY_ID = 'mephisto-overlay';
const RESTORE_BADGE_ID = 'mephisto-restore-badge';
const OVERLAY_SCALE = 0.8; // render the full 548x510 popup, scaled down a notch

function removeOverlay() {
    document.getElementById(PANEL_OVERLAY_ID)?.remove();
    document.getElementById(RESTORE_BADGE_ID)?.remove();
    clearEvalBar();   // closing removes the iframe; the board overlays it drew must go too
    clearHintArrow();
}

// Minimize = HIDE the panel without tearing it down, so the engine + autoplay/premove/help keep
// running exactly as if it were open (closing with X, which removes the iframe, is what STOPS
// everything). We use opacity:0 + pointer-events:none rather than visibility:hidden/display:none:
// the frame stays full-size and in the viewport so Chrome treats it as VISIBLE and never throttles
// its timers (a cross-origin hidden iframe gets throttled to ~1/s -> laggy autoplay). pointer-events
// :none makes it click-through so it can't sit over a destination square and eat the autoplay click.
function minimizeOverlay(wrap) {
    const frame = wrap.querySelector('iframe');
    wrap.style.opacity = '0';
    wrap.style.pointerEvents = 'none';
    // set it on the iframe TOO, explicitly: the drag handler's mouseup leaves an inline
    // pointer-events:auto on the frame, which would override the wrap's inherited 'none' and keep
    // the invisible panel eating clicks. This makes the whole minimized panel click-through.
    if (frame) frame.style.pointerEvents = 'none';
    if (document.getElementById(RESTORE_BADGE_ID)) return;
    const badge = document.createElement('div');
    badge.id = RESTORE_BADGE_ID;
    badge.title = 'Restore Mephisto (autoplay is still running)';
    badge.textContent = '♞'; // ♞
    badge.style.cssText = 'position: fixed; top: 4px; right: 4px; z-index: 2147483646; ' +
        'width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; ' +
        'justify-content: center; cursor: pointer; background: #2d2d2d; color: #eee; ' +
        'font-size: 22px; line-height: 1; box-shadow: 0 3px 12px rgba(0,0,0,0.5); user-select: none;';
    badge.addEventListener('click', () => {
        wrap.style.opacity = '1';
        wrap.style.pointerEvents = 'auto';
        if (frame) frame.style.pointerEvents = 'auto';
        badge.remove();
    });
    document.body.appendChild(badge);
}

function toggleOverlay() {
    if (document.getElementById(PANEL_OVERLAY_ID)) {
        removeOverlay();
        return;
    }
    const scaledW = Math.round(548 * OVERLAY_SCALE);
    const scaledH = Math.round(510 * OVERLAY_SCALE);
    const wrap = document.createElement('div');
    wrap.id = PANEL_OVERLAY_ID;
    wrap.style.cssText = 'position: fixed; top: 4px; right: 0; z-index: 2147483646; ' +
        `width: ${scaledW}px; height: ${24 + scaledH}px; ` +
        'border-radius: 8px; overflow: hidden; background: #f0f0f0; ' +
        'box-shadow: 0 6px 24px rgba(0,0,0,0.45);';

    const bar = document.createElement('div');
    bar.style.cssText = 'height: 24px; background: #2d2d2d; color: #ddd; display: flex; ' +
        'align-items: center; justify-content: space-between; padding: 0 10px; ' +
        'font: 12px Roboto, sans-serif; cursor: move; user-select: none;';
    bar.innerHTML = '<span>Mephisto</span>' +
        '<span style="display: flex; align-items: center; gap: 2px;">' +
        '<span class="mephisto-overlay-min" title="Minimize (autoplay keeps running)" ' +
        'style="cursor: pointer; padding: 0 6px; font-size: 18px; line-height: 1;">–</span>' +
        '<span class="mephisto-overlay-close" title="Close" ' +
        'style="cursor: pointer; padding: 0 4px; font-size: 14px;">✕</span>' +
        '</span>';

    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/popup/popup.html') + (mephistoTabId ? `?tab=${mephistoTabId}` : '');
    frame.style.cssText = 'width: 548px; height: 510px; border: none; display: block; background: #f0f0f0; ' +
        `transform: scale(${OVERLAY_SCALE}); transform-origin: top left;`;

    wrap.append(bar, frame);
    document.body.appendChild(wrap);
    bar.querySelector('.mephisto-overlay-close').addEventListener('click', removeOverlay);
    bar.querySelector('.mephisto-overlay-min').addEventListener('click', () => minimizeOverlay(wrap));

    // drag by the title bar; the iframe must not eat mousemove while dragging
    let dragFromX, dragFromY, startLeft, startTop, dragging = false;
    bar.addEventListener('mousedown', e => {
        if (e.target.classList.contains('mephisto-overlay-close')) return;
        if (e.target.classList.contains('mephisto-overlay-min')) return;
        dragging = true;
        frame.style.pointerEvents = 'none';
        const rect = wrap.getBoundingClientRect();
        [dragFromX, dragFromY, startLeft, startTop] = [e.clientX, e.clientY, rect.left, rect.top];
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!dragging) return;
        wrap.style.left = `${startLeft + e.clientX - dragFromX}px`;
        wrap.style.top = `${Math.max(0, startTop + e.clientY - dragFromY)}px`;
        wrap.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
        dragging = false;
        frame.style.pointerEvents = 'auto';
    });
}

// ------------------------------------------------------------------------------------------
// Help mode: instead of autoplaying, overlay the engine's best move as an arrow directly on
// the site's board so the user can play it themselves at their own pace.

const HINT_OVERLAY_ID = 'mephisto-hint-overlay';
let lastHintKey = null;

function clearHintArrow() {
    lastHintKey = null;
    document.getElementById(HINT_OVERLAY_ID)?.remove();
}

// arrows: [{move: 'e2e4', width: 0..0.25 (in squares), color: '#rrggbb'}, ...] best line first --
// the same set the popup draws on its mini board (multipv lines weighted by score, threat in red)
function drawHintArrows(arrows) {
    arrows = (arrows || []).filter(a => a && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(a.move ?? ''));
    // help mode redraws on every engine update; skip the DOM churn while the arrows are unchanged
    const key = JSON.stringify(arrows);
    if (key === lastHintKey && document.getElementById(HINT_OVERLAY_ID)) return;
    clearHintArrow();
    if (!arrows.length) return;
    const board = getBoard();
    if (!board) return;
    const bounds = board.getBoundingClientRect();
    const orientation = getOrientation();
    const square = bounds.width / 8;

    function squareCenter(coords) {
        const [xIdx, yIdx] = (orientation === 'white')
            ? [coords.charCodeAt(0) - 'a'.charCodeAt(0), 8 - parseInt(coords[1])]
            : ['h'.charCodeAt(0) - coords.charCodeAt(0), parseInt(coords[1]) - 1];
        return [(xIdx + 0.5) * square, (yIdx + 0.5) * square];
    }

    const markerId = color => `mephisto-hint-head-${color.replace(/[^\w]/g, '')}`;
    let defs = '';
    for (const color of new Set(arrows.map(a => a.color || '#15781b'))) {
        defs += `<marker id="${markerId(color)}" markerWidth="3" markerHeight="3" refX="0.1" refY="1.5" orient="auto">
            <path d="M0,0 L2.4,1.5 L0,3 Z" fill="${color}"/></marker>`;
    }

    let lines = '';
    for (const arrow of [...arrows].reverse()) { // best line comes first; draw it last so it sits on top
        const color = arrow.color || '#15781b';
        const stroke = Math.max(2, (arrow.width || 0.2) * square);
        const [x0, y0] = squareCenter(arrow.move.substring(0, 2));
        const [x1, y1] = squareCenter(arrow.move.substring(2, 4));
        // pull the line back so the arrowhead tip lands on the target square's center
        const dist = Math.hypot(x1 - x0, y1 - y0) || 1;
        const xh = x1 - (x1 - x0) / dist * square * 0.4;
        const yh = y1 - (y1 - y0) / dist * square * 0.4;
        lines += `<line x1="${x0}" y1="${y0}" x2="${xh}" y2="${yh}" stroke="${color}" stroke-width="${stroke}"
            stroke-linecap="round" opacity="0.75" marker-end="url(#${markerId(color)})"/>`;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = HINT_OVERLAY_ID;
    svg.setAttribute('width', bounds.width);
    svg.setAttribute('height', bounds.height);
    svg.style.cssText = `position: absolute; left: ${bounds.left + window.scrollX}px; ` +
        `top: ${bounds.top + window.scrollY}px; z-index: 2147483647; pointer-events: none;`;
    svg.innerHTML = `<defs>${defs}</defs>${lines}`;
    document.body.appendChild(svg);
    lastHintKey = key;
}

// ------------------------------------------------------------------------------------------
// Eval bar: a vertical evaluation bar drawn just to the LEFT of the site board, styled like the
// popup's own bar (dark = black's share, white = white's share), with the score shown inside it
// chess.com-style. The popup computes the numbers and pushes them on every eval update.

const EVALBAR_OVERLAY_ID = 'mephisto-evalbar-overlay';

function clearEvalBar() {
    document.getElementById(EVALBAR_OVERLAY_ID)?.remove();
}

// frac = white's share of the bar (0..1); text = score magnitude ("1.1" / "M3"); winningWhite
// decides which end the number sits at and its colour. Repositioned every update (like the hint
// arrows) so it tracks the board; pointer-events:none so it never eats a click.
function drawEvalBar({frac, text, winningWhite}) {
    const board = getBoard();
    if (!board || typeof frac !== 'number') { clearEvalBar(); return; }
    const bounds = board.getBoundingClientRect();
    if (!bounds.width) { clearEvalBar(); return; }
    const flipped = getOrientation() === 'black';
    const BAR_W = 16, GAP = 8;

    let bar = document.getElementById(EVALBAR_OVERLAY_ID);
    let white, num;
    if (!bar) {
        bar = document.createElement('div');
        bar.id = EVALBAR_OVERLAY_ID;
        bar.style.cssText = 'position: absolute; z-index: 2147483646; pointer-events: none; ' +
            'background: #403d39; border-radius: 3px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.4);';
        white = document.createElement('div');
        white.className = 'mephisto-evalbar-white';
        white.style.cssText = 'position: absolute; left: 0; width: 100%; background: #f0f0f0; ' +
            'transition: height 0.2s, top 0.2s, bottom 0.2s;';
        num = document.createElement('div');
        num.className = 'mephisto-evalbar-num';
        num.style.cssText = 'position: absolute; left: 0; width: 100%; text-align: center; ' +
            'font: 700 9px/1.4 Roboto, Arial, sans-serif;';
        bar.append(white, num);
        document.body.appendChild(bar);
    } else {
        white = bar.querySelector('.mephisto-evalbar-white');
        num = bar.querySelector('.mephisto-evalbar-num');
    }

    bar.style.left = `${bounds.left + window.scrollX - GAP - BAR_W}px`;
    bar.style.top = `${bounds.top + window.scrollY}px`;
    bar.style.width = `${BAR_W}px`;
    bar.style.height = `${bounds.height}px`;

    // white's share hangs from the bottom (or the top when the board is flipped for black)
    white.style.height = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    white.style.top = flipped ? '0' : 'auto';
    white.style.bottom = flipped ? 'auto' : '0';

    // the number sits at the winning side's end, coloured to contrast that end (dark on white, light on black)
    const numAtBottom = winningWhite ? !flipped : flipped;
    num.textContent = text ?? '';
    num.style.top = numAtBottom ? 'auto' : '2px';
    num.style.bottom = numAtBottom ? '2px' : 'auto';
    num.style.color = winningWhite ? '#403d39' : '#f0f0f0';
}

// Best-effort: read the variant off lichess's game page. The variant name is a link to /variant/<key>
// (a stable URL, unlike lichess's obfuscated CSS classes). Returns a config.variant value, or null if
// it can't tell (standard games have no such link) so the caller keeps the current setting.
function detectLichessVariant() {
    if (site !== 'lichess') return null;
    const href = document.querySelector('a[href*="/variant/"]')?.getAttribute('href') || '';
    const key = (href.match(/\/variant\/(\w+)/) || [])[1];
    const map = {
        threeCheck: '3check', kingOfTheHill: 'kingofthehill', racingKings: 'racingkings',
        chess960: 'fischerandom', crazyhouse: 'crazyhouse', atomic: 'atomic',
        antichess: 'antichess', horde: 'horde', standard: 'chess',
    };
    return map[key] || null;
}

function tryScrapePosition() {
    try {
        return scrapePosition() || 'no'; // scrapePosition() returns undefined when there is no board
    } catch (e) {
        return 'no'; // skip the current attempt, if we can't scrape
    }
}

function scrapePosition() {
    if (!getBoard()) return;

    let prefix = '';
    if (site === 'chesscom') {
        prefix += '***cc'
    } else if (site === 'lichess') {
        prefix += '***li'
    } else if (site === 'blitztactics') {
        prefix += '***bt'
    }

    let res = '';
    if (config.variant === 'chess') {
        const moveContainer = getMoveContainer();
        if (moveContainer != null) {
            // "From Position" custom starts only exist on lichess. DEFAULT_POSITION matches
            // lichess's scrape order/turn but NOT chess.com's (h8-first, turn 'b' at load), so
            // on chess.com a normal game's standard start reads as "custom" and corrupts every
            // scrape (ships startpos + moves that don't apply -> "Invalid move: e3"). Gate to lichess.
            const customStart = (site === 'lichess') ? readStartPos(location.href)?.position : null;
            if (customStart && customStart !== DEFAULT_POSITION) {
                // "From Position" game (custom start, e.g. endgame practice vs the AI): the SANs
                // only make sense from THAT position, so ship it along like the chess960 path does
                prefix += 'var***';
                res = customStart + '&*****';
                res += (getMoveRecords()?.length) ? scrapePositionFen() : '?';
            } else {
                prefix += 'fen***';
                res = scrapePositionFen();
            }
        } else {
            prefix += 'puz***';
            res = scrapePositionPuz();
        }
    } else {
        prefix += 'var***';
        if (config.variant === 'fischerandom') {
            const startPos = readStartPos(location.href)?.position || DEFAULT_POSITION;
            res = startPos + '&*****';
        }
        const moves = getMoveRecords();
        res += (moves?.length) ? scrapePositionFen(moves) : '?';
    }

    if (res != null) {
        return prefix + res.replace(/[^\w-+=#*@&]/g, '');
    } else {
        return 'no';
    }
}

function scrapePositionFen() {
    let res = '';
    // The selected move only truncates the scrape when reviewing history. At the LIVE
    // position lichess often marks no move as selected (notably right after you move,
    // while the opponent is to reply) -- don't bail to an empty start position then;
    // fall through and scrape ALL moves, which is the current position.
    const selectedMove = getSelectedMoveRecord();
    if (site === 'chesscom') {
        for (const moveWrapper of getMoveRecords()) {
            const move = moveWrapper.lastElementChild
            if (move.lastElementChild?.classList.contains('icon-font-chess')) {
                res += move.lastElementChild.getAttribute('data-figurine') + move.innerText + '*****';
            } else {
                res += move.innerText + '*****';
            }
            if (!config.simon_says_mode && move === selectedMove) {
                break;
            }
        }
    } else if (site === 'lichess') {
        // In the LIVE game move list, always scrape through to the latest move (= the current
        // position). lichess obfuscates the selected-move class (`.a1t`) and it varies between
        // deploys/sessions -- if it's misread, breaking on it stops one move short and Mephisto
        // then analyses the wrong side's turn (shows the opponent's move, never autoplays). In
        // the analysis/puzzle tree (.tview2) there's no live position, so honour the selected
        // move there to keep history review working.
        const isLiveGame = !!getLichessMovesApp();
        for (const move of getMoveRecords()) {
            res += move.innerText.replace(/\n.*/, '') + '*****';
            if (!config.simon_says_mode && !isLiveGame && move === selectedMove) {
                break;
            }
        }
    }
    return res;
}

function scrapePositionPuz() {
    if (isAnimating()) {
        throw Error("Board is animating. Can't scrape.")
    }
    let res = '';
    if (site === 'chesscom') {
        for (const piece of getPieces()) {
            let [colorTypeClass, coordsClass] = [piece.classList[1], piece.classList[2]];
            if (!coordsClass.includes('square')) {
                [colorTypeClass, coordsClass] = [coordsClass, colorTypeClass];
            }
            const [color, type] = colorTypeClass;
            const coordsStr = coordsClass.split('-')[1];
            const coords = String.fromCharCode('a'.charCodeAt(0) + parseInt(coordsStr[0]) - 1) + coordsStr[1];
            res += `${color}-${type}-${coords}*****`;
        }
    } else {
        const pieceMap = {pawn: 'p', rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k'};
        const colorMap = {white: 'w', black: 'b'};
        for (const piece of getPieces()) {
            let transform;
            if (piece.classList.contains('dragging')) {
                transform = document.querySelector('.ghost').style.transform;
            } else {
                transform = piece.style.transform;
            }
            const xyCoords = transform.substring(transform.indexOf('(') + 1, transform.length - 1)
                .replaceAll('px', '').replace(' ', '').split(',')
                .map(num => Number(num) / piece.getBoundingClientRect().width + 1);
            if (piece.classList[0] === 'ghost') {
                continue; // the drag placeholder, not a real piece
            }
            // A settled piece sits on an integer file/rank. Fractional coords mean the board
            // is mid-animation (a piece sliding, or the whole-board flip at game start).
            // chessground no longer tags animating pieces with `.anim`, so isAnimating() above
            // misses it; scraping now would drop the moving pieces and emit a corrupt partial
            // position (e.g. "8/8/8/8/8/8/8/NB1QBN1R"). Abort and let the next poll retry.
            const file = Math.round(xyCoords[0]);
            const rank = Math.round(xyCoords[1]);
            if (Math.abs(xyCoords[0] - file) > 0.1 || Math.abs(xyCoords[1] - rank) > 0.1) {
                throw Error("Board is animating. Can't scrape.");
            }
            const coords = (getOrientation() === 'black')
                ? String.fromCharCode('h'.charCodeAt(0) - file + 1) + rank
                : String.fromCharCode('a'.charCodeAt(0) + file - 1) + (9 - rank);
            res += `${colorMap[piece.classList[0]]}-${pieceMap[piece.classList[1]]}-${coords}*****`;
        }
    }
    return (res) ? getTurn() + '*****' + res : null;
}

function getOrientation() {
    let orientedBlack = true;
    if (site === 'chesscom') {
        const topLeftCoord = document.querySelector('.coordinate-light')
            || document.querySelector('.coords-light');
        orientedBlack = topLeftCoord && topLeftCoord.innerHTML === '1';
    } else if (site === 'lichess') {
        const topLeftCoord = document.querySelector('.files');
        orientedBlack = topLeftCoord && topLeftCoord.classList.contains('black');
    } else if (site === 'blitztactics') {
        const topLeftCoord = document.querySelector('.files');
        orientedBlack = topLeftCoord && topLeftCoord.classList.contains('black');
    }
    return (orientedBlack) ? 'black' : 'white';
}

let movingWatchdog = null;

function toggleMoving() {
    moving = !moving;
    // Safety net: while `moving` is true the content-script ignores ALL scrape requests, so a
    // move simulation that never resolves (a hung click / promotion) would freeze the extension
    // ("gets stuck and doesn't play anything"). Force `moving` back to false after 15s -- far
    // longer than any real move takes -- so scraping always resumes.
    clearTimeout(movingWatchdog);
    if (moving) {
        movingWatchdog = setTimeout(() => { moving = false; schedulePositionPush(); }, 15000);
    } else {
        schedulePositionPush(); // pushes were suppressed while moving; catch up on the final state
    }
}

function pullConfig() {
    chrome.runtime.sendMessage({ pullConfig: true });
}

// -------------------------------------------------------------------------------------------

// The live-game move list is an `<app>` holding <z7yx> moves. In REAL-TIME games it sits under
// `.col1-moves`; in CORRESPONDENCE games it sits directly under `<i5d>` with NO `.col1-moves`
// wrapper -- so `.col1-moves app` alone misses it and the scraper wrongly falls to the puzzle
// path (analysing the starting position -> premoving opening moves). Match both.
function getLichessMovesApp() {
    return document.querySelector('.col1-moves app') || document.querySelector('i5d app');
}

function getSelectedMoveRecord() {
    let selectedMove;
    if (site === 'chesscom') {
        selectedMove = document.querySelector('.node .selected') // vs player + computer (new)
            || document.querySelector('.move-node-highlighted .move-text-component') // vs player + computer (old)
            || document.querySelector('.move-node.selected .move-text'); // analysis
    } else if (site === 'lichess') {
        selectedMove = getLichessMovesApp()?.querySelector('.a1t') // live game (real-time + correspondence)
            || document.querySelector('kwdb.a1t') // live game (older lichess DOM)
            || document.querySelector('.tview2 move.active') // analysis / puzzle / finished game
            || document.querySelector('move.active');
    }
    return selectedMove;
}

function getMoveRecords() {
    let moves;
    if (site === 'chesscom') {  // wc-chess-board
        moves = document.querySelectorAll('.node'); // vs player + computer (new)
        if (moves.length === 0) {
            moves = document.querySelectorAll('.move-text-component'); // vs player + computer (old)
        }
        if (moves.length === 0) {
            moves = document.querySelectorAll('.move-text'); // analysis
        }
    } else if (site === 'lichess') { // cg-board
        const liveMoves = getLichessMovesApp(); // live game (real-time + correspondence)
        if (liveMoves) {
            // Keep only real moves: a SAN has a destination square [a-h][1-8], or it's castling.
            // This drops the move-number tags AND the game-result/status element lichess appends
            // to the move list on game end (e.g. "0-1 White resigned • Black is victorious"),
            // which would otherwise be scraped as a bogus move and abort the whole parse.
            moves = Array.from(liveMoves.children).filter(el => {
                const t = el.textContent.trim();
                return /[a-h][1-8]/.test(t) || /^O-O(-O)?[+#]?$/.test(t);
            });
        } else {
            moves = document.querySelectorAll('kwdb'); // live game (older lichess DOM)
            if (moves.length === 0) {
                moves = document.querySelectorAll('.tview2 move'); // analysis / puzzle / training
            }
        }
    }
    return moves;
}

function getMoveContainer() {
    let moveContainer;
    if (site === 'chesscom') {
        moveContainer = document.querySelector('wc-simple-move-list');
    } else if (site === 'lichess') {
        moveContainer = getLichessMovesApp() // live game (real-time + correspondence)
            || document.querySelector('l4x') // live game (older lichess DOM)
            || document.querySelector('.tview2'); // analysis / puzzle / training
    }
    return moveContainer;
}

function getLastMoveHighlights() {
    let fromSquare, toSquare;
    if (site === 'chesscom') {
        const board = getBoard();
        let highlights = Array.from(document.querySelectorAll('.highlight'));
        if (highlights.length === 3) {
            // If there are 3 highlights, we need to figure out which of them is a user action.
            // Either a piece is being dragged or a piece was clicked and let go.
            const dragPiece = board.querySelector('.piece.dragging');
            if (dragPiece) {
                const dragSquareId = dragPiece.className.match('square-[0-9][0-9]')[0];
                highlights = highlights.filter(ht => !ht.classList.contains(dragSquareId));
            } else {
                const hoverSquare = board.querySelector('.hover-square');
                const hoverSquareId = hoverSquare.className.match('square-[0-9][0-9]')[0];
                highlights = highlights.filter(ht => !ht.classList.contains(hoverSquareId));
            }
        }
        [fromSquare, toSquare] = [highlights[0], highlights[1]];
        const toPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        if (!toPiece) {
            [fromSquare, toSquare] = [toSquare, fromSquare];
        }
    } else if (site === 'lichess') {
        [toSquare, fromSquare] = Array.from(document.querySelectorAll('.last-move'));
        const toPiece = Array.from(document.querySelectorAll('.main-board piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        if (!toPiece) {
            [toSquare, fromSquare] = [fromSquare, toSquare];
        }
    } else if (site === 'blitztactics') {
        [fromSquare, toSquare] = [document.querySelector('.move-from'), document.querySelector('.move-to')];
    }

    if (!fromSquare || !toSquare) {
        throw Error('Last move highlights not found');
    }
    return [fromSquare, toSquare];
}

function getTurn() {
    let toSquare;
    try {
        toSquare = getLastMoveHighlights()[1];
    } catch (e) {
        // no last-move highlight to read the turn from. If a move list exists, derive the
        // turn from how many moves have been played (even count => white is to move).
        if (getMoveContainer()) {
            return (getMoveRecords().length % 2 === 0) ? 'w' : 'b';
        }
        // no move list at all: on lichess that's a GAME at the starting position -- white
        // moves first (regardless of which colour the user plays), so autoplay must fire for
        // white's opening move. (The old code returned orientation-based here, which said
        // "black to move" for a white player at the start -> it never played move 1.)
        if (site === 'lichess') {
            return 'w';
        }
        return (getOrientation() === 'black') ? 'w' : 'b'; // chess.com / blitztactics puzzle
    }

    let turn;
    if (site === 'chesscom') {
        const hlPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        const hlColorType = Array.from(hlPiece.classList).find(c => c.match(/[wb][prnbkq]/));
        turn = (hlColorType[0] === 'w') ? 'b' : 'w';
    } else if (site === 'lichess') {
        const toPiece = Array.from(document.querySelectorAll('.main-board piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = (toPiece.classList.contains('white')) ? 'b' : 'w';
    } else if (site === 'blitztactics') {
        const toPiece = Array.from(document.querySelectorAll('.board-area piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = (toPiece.classList.contains('white')) ? 'b' : 'w';
    }
    return turn;
}

function getRanksFiles() {
    let fileCoords, rankCoords;
    if (site === 'chesscom') {
        const coords = Array.from(document.querySelectorAll('.coordinates text'));
        fileCoords = coords.slice(8);
        rankCoords = coords.slice(0, 8);
        if (fileCoords.length === 0 || rankCoords.length === 0) {
            fileCoords = Array.from(document.querySelectorAll('.letter'));
            rankCoords = Array.from(document.querySelectorAll('.number'));
        }
    } else if (site === 'lichess') {
        fileCoords = Array.from(document.querySelector('.files').children);
        rankCoords = Array.from(document.querySelector('.ranks').children);
    } else if (site === 'blitztactics') {
        fileCoords = Array.from(document.querySelector('.files').children);
        rankCoords = Array.from(document.querySelector('.ranks').children);
    }
    return [rankCoords, fileCoords];
}

function getBoard() {
    let board;
    if (site === 'chesscom') {
        board = document.querySelector('.board');
    } else if (site === 'lichess') {
        board = document.querySelector('.main-board');
    } else if (site === 'blitztactics') {
        board = document.querySelector('.chessground-board');
    }
    return board;
}

function getPieces() {
    if (site === 'chesscom') {
        return document.querySelectorAll('.piece');
    } else {
        let pieceSelector;
        if (site === 'lichess') {
            pieceSelector = '.main-board piece';
        } else if (site === 'blitztactics') {
            pieceSelector = '.board-area piece';
        }
        return Array.from(document.querySelectorAll(pieceSelector)).filter(piece => !!piece.classList[1]);
    }
}

function getPromotionSelection(promotion) {
    let promotions;
    if (site === 'chesscom') {
        const promotionElems = document.querySelectorAll('.promotion-piece');
        if (promotionElems.length) promotions = promotionElems;
    } else if (site === 'lichess') {
        const promotionModal = document.querySelector('#promotion-choice');
        if (promotionModal) promotions = promotionModal.children;
    } else if (site === 'blitztactics') {
        promotions = document.querySelector('.pieces').children;
    }

    const promoteMap = (site === 'chesscom')
        ? { 'b': 0, 'n': 1, 'q': 2, 'r': 3 }
        : (site === 'lichess')
            ? { 'q': 0, 'n': 1, 'r': 2, 'b': 3 }
            : { 'q': 0, 'r': 1, 'n': 2, 'b': 3 };
    const idx = promoteMap[promotion];
    return (promotions) ? promotions[idx] : undefined;
}

function isAnimating() {
    let anim;
    if (site === 'chesscom') {
        anim = getBoard().getAttribute('data-test-animating');
    } else if (site === 'lichess' || site === 'blitztactics') {
        anim = getBoard().querySelector('piece.anim');
    }
    return !!anim;
}

// -------------------------------------------------------------------------------------------

function loadStartPosCache() {
    const cache = new LRU(10);
    const entries = JSON.parse(localStorage.getItem(LOCAL_CACHE)) || [];
    for (const entry of entries.reverse()) {
        cache.set(entry.key, entry.value);
    }
    return cache;
}

function saveStartPosCache() {
    localStorage.setItem(LOCAL_CACHE, JSON.stringify(startPosCache.toJSON()));
}

function readStartPos(url) {
    const startPos = startPosCache.get(url);
    saveStartPosCache();
    return startPos;
}

function writeStartPos(url, startPos) {
    startPosCache.set(url, startPos);
    saveStartPosCache();
}

function determineStartPosition() {
    startPosCache = loadStartPosCache();
    // scrape the position when the board and pieces are present
    let retryCount = 0;
    const intervalId = setInterval(() => {
        if (getBoard() && getPieces()?.length) { // board and pieces are present?
            clearInterval(intervalId);
            onPositionLoad();
            return;
        }
        if (++retryCount >= 100) { // give up after 10s: not a game page, or the board never loaded
            console.debug('Mephisto: no chess board found on this page');
            clearInterval(intervalId);
        }
    }, 100); // check every 100ms
}


function onPositionLoad(retries = 10) {
    // cache position, if it's a non-standard starting position
    if (!getMoveRecords()?.length) { // is stating position?
        let position;
        try {
            position = scrapePositionPuz();
        } catch (e) {
            // board still animating in; a failed scrape here would lose the custom start
            // position for the whole game, so retry until the pieces settle
            if (retries > 0) setTimeout(() => onPositionLoad(retries - 1), 300);
            return;
        }
        // only lichess has "From Position" games; caching elsewhere risks a wrong-turn/order
        // scrape of the standard start being mistaken for a custom position (see scrapePosition)
        if (site === 'lichess' && position !== DEFAULT_POSITION) { // is non-standard?
            writeStartPos(location.href, {
                position: position,
                timestamp: Date.now()
            })
        }
    }
}

// -------------------------------------------------------------------------------------------

function promiseTimeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(time), time);
    });
}

function getOffsetCorrectionXY() {
    if (config.python_autoplay_backend) {
        return getBrowserOffsetXY();
    }
    return [0, 0];
}

function getBrowserOffsetXY() {
    const topBarHeight = window.outerHeight - window.innerHeight;
    const offsetX = window.screenX;
    const offsetY = window.screenY + topBarHeight;
    return [offsetX, offsetY];
}

function getRandomSampledXY(bounds, range = 0.8) {
    const margin = (1 - range) / 2;
    const x = bounds.x + (range * Math.random() + margin) * bounds.width;
    const y = bounds.y + (range * Math.random() + margin) * bounds.height;
    const [correctX, correctY] = getOffsetCorrectionXY();
    return [x + correctX, y + correctY];
}

// -------------------------------------------------------------------------------------------

function dispatchSimulateClick(x, y) {
    console.log([x, y]);
    chrome.runtime.sendMessage({
        click: true,
        x: x,
        y: y
    });
}

function simulateClickSquare(bounds, range = 0.8) {
    const [x, y] = getRandomSampledXY(bounds, range);
    dispatchSimulateClick(x, y);
}

function simulateMove(move, deselect) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move ?? '')) {
        console.warn(`Mephisto: refusing to play invalid move '${move}'`); // e.g. '(none)' or a crazyhouse drop
        return Promise.resolve();
    }
    const boardBounds = getBoard().getBoundingClientRect();
    const orientation = getOrientation();

    function getBoundsFromCoords(coords) {
        const squareSide = boardBounds.width / 8;
        const [xIdx, yIdx] = (orientation === 'white')
            ? [coords[0].charCodeAt(0) - 'a'.charCodeAt(0), 8 - parseInt(coords[1])]
            : ['h'.charCodeAt(0) - coords[0].charCodeAt(0), parseInt(coords[1]) - 1];
        return new DOMRect(boardBounds.x + xIdx * squareSide, boardBounds.y + yIdx * squareSide, squareSide, squareSide);
    }

    function getThinkTime() {
        return config.think_time + Math.random() * config.think_variance;
    }

    function getMoveTime() {
        return config.move_time + Math.random() * config.move_variance;
    }

    async function performSimulatedMoveClicks() {
        // clear any stale selection first (a piece left selected by a prior failed click would be
        // DESELECTED by our from-click, making the move a no-op). `deselect` is an empty square the
        // moving piece can't reach, so clicking it only ever deselects -- never moves anything.
        if (/^[a-h][1-8]$/.test(deselect ?? '')) {
            simulateClickSquare(getBoundsFromCoords(deselect));
            await promiseTimeout(60);
        }
        simulateClickSquare(getBoundsFromCoords(move.substring(0, 2)));
        await promiseTimeout(getMoveTime());
        simulateClickSquare(getBoundsFromCoords(move.substring(2)));
    }

    async function performSimulatedMoveSequence() {
        await promiseTimeout(getThinkTime());
        await performSimulatedMoveClicks();
        if (move[4]) {
            await promiseTimeout(getMoveTime());
            await simulatePromotionClicks(move[4]); // conditional promotion click
        }
    }

    return performSimulatedMoveSequence();
}

// Autoplay clicks can silently fail (a mis-timed click during a board animation, a click landing
// a hair off after a resize, a promotion race). Play the move, then CONFIRM it registered by
// checking the move list actually grew; if not, retry. The move-count check is safe from
// double-moving: if a move was played (count went up) we treat it as success even if the
// opponent has already replied, so we never re-fire a move into a changed position.
async function simulateMoveVerified(move, deselect, verify, retries = 2, before = null) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move ?? '')) {
        return simulateMove(move, deselect); // invalid -> simulateMove logs + no-ops
    }
    // A BLIND premove (verify=false) is clicked while it is NOT our turn: the site queues it and it
    // won't appear in the move list until the opponent moves. Verifying/retrying it would re-click
    // and clobber the queued premove -- so only verify real moves played on our own turn. The popup
    // decides this from the position's side-to-move and passes it in (see request_automove).
    if (!verify) return simulateMove(move, deselect);
    // Capture the move count ONCE, before the FIRST attempt. Re-reading it on each retry breaks the
    // check: chess.com's move list can update later than a fixed wait (board animation), so a move
    // that DID land shows up only after we'd have re-read `before` as the already-grown count -- the
    // retry then replays into a changed board and still reports "failed". Compare against the
    // original count throughout, and POLL for it to grow instead of a single snapshot.
    if (before === null) before = getMoveRecords()?.length ?? 0;
    await simulateMove(move, deselect);
    for (let waited = 0; waited < 1500; waited += 50) { // poll up to 1.5s for the move to register
        await promiseTimeout(50);
        if ((getMoveRecords()?.length ?? 0) > before) return; // a move was played -> success
    }
    if (retries > 0) {
        console.warn(`Mephisto: move '${move}' did not register, retrying (${retries} left)`);
        return simulateMoveVerified(move, deselect, verify, retries - 1, before);
    }
    console.warn(`Mephisto: move '${move}' failed to register after retries`);
}

function simulatePvMoves(pv) {
    const boardBounds = getBoard().getBoundingClientRect();

    function deriveLastMove() {
        function deriveCoords(square) {
            if (!square) return 'no';
            const squareBounds = square.getBoundingClientRect();
            const xIdx = Math.floor(((squareBounds.x + 1) - boardBounds.x) / squareBounds.width);
            const yIdx = Math.floor(((squareBounds.y + 1) - boardBounds.y) / squareBounds.height);
            return getOrientation() === 'white'
                ? String.fromCharCode('a'.charCodeAt(0) + xIdx) + (8 - yIdx)
                : String.fromCharCode('h'.charCodeAt(0) - xIdx) + (yIdx + 1);
        }

        const [fromSquare, toSquare] = getLastMoveHighlights();
        return deriveCoords(fromSquare) + deriveCoords(toSquare);
    }

    async function confirmResponse(move, lastMove) {
        let runtime = 0;
        while (runtime < 10000) { // < 10 seconds
            // fixed 50ms: fen_refresh is the popup's SLOW fallback poll now (>= 1s) and must not
            // pace this loop -- puzzle mode needs to see the opponent's reply promptly
            runtime += await promiseTimeout(50);
            try {
                const observedLastMove = deriveLastMove();
                if (observedLastMove !== lastMove) {
                    return observedLastMove === move;
                }
            } catch (error) {
                // retry on failure
            }
        }
        return false;
    }

    async function performSimulatedPvMoveSequence() {
        for (let i = 0; i < pv.length; i++) {
            let lastMove = pv[i - 1];
            let move = pv[i];
            if (i % 2 === 0) { // even index -> my move
                await simulateMove(move, false);
            } else { // odd index -> their move
                if (!await confirmResponse(move, lastMove)) return;
            }
        }
    }

    return performSimulatedPvMoveSequence();
}

async function simulatePromotionClicks(promotion) {
    const promotionChoice = getPromotionSelection(promotion);
    if (promotionChoice) {
        await simulateClickSquare(promotionChoice.getBoundingClientRect())
    }
}
