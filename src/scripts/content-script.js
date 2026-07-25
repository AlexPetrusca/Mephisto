let site; // the site that the content-script was loaded on (lichess, chess.com, blitztactics.com)
let config; // configuration pulled from popup
let startPosCache; // cache of non-standard starting positions as puzzle strings (to support chess960)
let moving = false; // whether the content-script is performing a move
let mephistoTabId = null; // this tab's id, so the popup iframe talks to ONLY this tab (see below)
let deferredWhileHidden = false; // an autoplay/premove was held because the tab wasn't focused/visible

// The tab is "active" only when it's the visible tab AND the window has system focus. `hasFocus()`
// stays true when focus is inside our floating-panel iframe (same top-level browsing context), so
// using the panel doesn't count as tabbed-away.
function tabActive() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

// When the tab becomes active again after a move was held, re-scrape so the popup re-analyses the
// (still-current) position and re-issues the move -- now that we're allowed to click.
function resumeIfDeferred() {
    if (deferredWhileHidden && tabActive()) {
        deferredWhileHidden = false;
        schedulePush();
    }
}
document.addEventListener('visibilitychange', resumeIfDeferred);
window.addEventListener('focus', resumeIfDeferred);

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

const MEPHISTO_BUILD = '3.1.129'; // bump on every content-script change; verify in the page console after reload
window.onload = () => {
    console.log(`content-script build ${MEPHISTO_BUILD}`); // debranded: no product name in the page console (L8)
    const siteMap = {
        'lichess.org': 'lichess',
        'www.chess.com': 'chesscom',
        'blitztactics.com': 'blitztactics',
        'taketaketake.com': 'taketaketake',
        'www.taketaketake.com': 'taketaketake',
        'tactics.chessbase.com': 'chessbase'
    };
    site = siteMap[window.location.hostname];
    pullConfig();
    // Mephisto now loads on EVERY site so a position can be read off any page (a video, a diagram,
    // a screenshot). On a site we have no scraper for there is simply nothing to detect: skip the
    // board hunt and let the panel run in manual mode -- set up a position by FEN, play moves on the
    // panel board, or capture one from the screen. Everything below this line is scraper-only.
    if (!site) return;
    determineStartPosition();
};

function handleExtensionMessage(response, sender, sendResponse) {
    if (response.toggleOverlay) {
        toggleOverlay();
        return;
    }
    if (response.closeOverlay) { // sent to every tab when the user switches to toolbar-popup mode
        removeOverlay();
        return;
    }
    if (response.dragSelect) {
        startDragSelect();
        return;
    }
    if (response.detectVariant) {
        sendResponse({variant: detectVariant(), href: location.href});
        return;
    }
    if (response.queryfen) {
        // ALWAYS answer so the popup's in-flight poll guard clears immediately -- otherwise a poll
        // sent while we're mid-move (or before config) gets no reply and the board freezes for up
        // to the fallback timeout. While moving/unconfigured the DOM is transient, so answer 'no'
        // (skip); the next 10ms poll picks up the real position the instant we're idle again.
        let res = 'no', orient;
        if (!moving && config) {
            res = tryScrapePosition();
            orient = getOrientation();
        }
        try {
            sendToPanel({ dom: res, orient: orient, clocks: scrapeClocks(), fenresponse: true });
        } catch (e) {
            // extension was reloaded — this orphaned content-script can't reach it anymore
        }
        // Turn is shown by the panel's header king-switch (driven off the parsed FEN), not here.
        return;
    }
    if (moving) return;
    if (response.automove) {
        // Manual Mode moves (response.manual) are triggered by YOUR keypress, so they're allowed even
        // with Autoplay off. Otherwise: never auto-move if Autoplay was turned off since the message.
        if (!config.autoplay && !response.manual) return;
        // undetectability: don't click while the tab is backgrounded/unfocused -- a human wouldn't
        // move while tabbed away, and "moved while hidden" is an easy anomaly to flag. It's still our
        // turn (or a queued premove), so the position is stable: hold the move and re-scrape the
        // instant the tab is active again, which makes the popup re-issue it. Opt out with background_play.
        if (!config.background_play && !tabActive()) {
            deferredWhileHidden = true;
            return;
        }
        // apply the think/move timing the popup read FRESH from storage for this move, so changing the
        // Think/Move Time sliders mid-game takes effect on the very next move (not the game-start snapshot)
        if (response.timing) Object.assign(config, response.timing);
        beginMoving(response.think);
        try {
            if (config.puzzle_mode) {
                console.log(response.pv);
                simulatePvMoves(response.pv).finally(endMoving);
            } else if (response.premoves) {
                console.log(response.premoves);
                simulatePremoveSequence(response.premoves).finally(endMoving);
            } else {
                console.log(response.move);
                simulateMoveVerified(response.move, response.deselect, response.verify, response.think ?? null).finally(endMoving);
            }
        } catch (e) {
            endMoving(); // a sync throw (e.g. board vanished) must not leave `moving` stuck true
            console.warn('Mephisto: automove failed:', e);
        }
    } else if (response.pushConfig) {
        console.log(response.config);
        config = response.config;
        // config in hand = we can scrape. Start the event-driven pipeline and sync the panel
        // immediately (a re-opened panel must not wait for the next board mutation or fallback poll).
        startPositionObserver();
        lastPushKey = lastDisplayKey = null; // config may change how we scrape (variant) -> never dedupe across configs
        schedulePush();
    } else if (response.drawHint) {
        drawHintArrows(response.arrows);
    } else if (response.clearHint) {
        clearHintArrow();
    } else if (response.drawEvalBar) {
        drawEvalBar(response);
    } else if (response.clearEvalBar) {
        clearEvalBar();
    } else if (response.oppAlert) {
        showOppAlert(response.label, response.drop, response.san, response.uci);
    } else if (response.consoleMessage) {
        console.log(response.consoleMessage);
    }
}
chrome.runtime.onMessage.addListener(handleExtensionMessage); // background + toolbar-popup traffic
// The in-page panel is popup.js running in THIS isolated world, so it talks to us by direct call.
self.MephistoContent = {
    handle: (msg) => handleExtensionMessage(msg, {}, () => {}),
    detectVariant: () => ({variant: detectVariant(), href: location.href}),
    // popup.js's apply_compact calls this: the panel is a fixed-size scaled box, so hiding its
    // contents can't shrink it -- see setPanelCompact. Also keeps the title-bar icon in sync when
    // the panel boots with a compact state remembered from last time.
    // popup.js's apply_explorer calls this when the overlay is shown/hidden, so the fixed-size box
    // grows to fit the book block instead of clipping it (the overlay never scrolls).
    setPanelBook: (on) => setPanelBook(on),
    setPanelCompact: (on) => {
        setPanelCompact(on);
        const icon = overlayEl(PANEL_OVERLAY_ID)?.querySelector('.mephisto-overlay-compact');
        if (icon) icon.textContent = on ? '▤' : '▣';
    },
    // Settings that need a full engine re-init (engine/variant/elo) used to reload the popup page.
    // In-page that would reload the SITE, so tear the panel down and rebuild it: fresh config, fresh
    // engine, same effect. See panel_reload() in popup.js.
    reopenPanel: async () => { removeOverlay(); await toggleOverlay(); },
};

// ------------------------------------------------------------------------------------------
// Hotkeys. Keys land on the GAME page, so the listener lives here (isolated world); it maps the key
// to an action and hands it to the panel (do_hotkey in popup.js). Bindings are ACTION -> key-combo
// in config.hotkeys (one JSON key -> rides along in settings export/import); defaults + merge live in
// config-store.js so the listener, the rebind UI and the panel labels can't drift.
// canonical combo string for a keydown: "Alt+a", "Shift+Ctrl+k", " " (space), "ArrowUp"
function hotkeyString(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    return parts.join('+');
}
// exposed so the options page can capture a new binding with the same normalization
self.MephistoHotkeyString = hotkeyString;

document.addEventListener('keydown', (e) => {
    if (!self.MephistoPanel?.isBooted?.()) return; // no in-page panel -> don't swallow the site's keys
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // typing
    const pressed = hotkeyString(e);
    const bindings = MephistoConfig.hotkeys();
    for (const action in bindings) {
        if (bindings[action] && bindings[action] === pressed) {
            // only swallow the key if the panel actually acted on it -- so e.g. Space stays a page
            // scroll while Manual Mode is off (its handler returns false there).
            if (self.MephistoPanel.hotkey(action)) { e.preventDefault(); e.stopPropagation(); }
            return;
        }
    }
}, true);

// Deliver a scrape/clock push to whichever panel is live: the in-page one shares our realm (direct
// call); the toolbar popup is a real extension page and needs runtime messaging.
function sendToPanel(msg) {
    // returns a promise for the in-page panel so a click dispatch can be awaited (its cursor travel
    // paces the move); pushes ignore the return.
    if (self.MephistoPanel?.isBooted?.()) { return self.MephistoPanel.onContentMessage(msg); }
    try { return chrome.runtime.sendMessage(msg); } catch (e) { /* orphaned content-script after a reload */ }
}

// ------------------------------------------------------------------------------------------
// In-page overlay: the whole Mephisto panel (popup.html) injected into the page as a
// draggable floating window, like Chessvision's. Toggled by clicking the toolbar icon.
// Unlike the anchored popup it can be moved anywhere and stays open while you play.

const PANEL_OVERLAY_ID = 'mephisto-overlay';
const RESTORE_BADGE_ID = 'mephisto-restore-badge';
const COMPACT_H = 280;     // compact: status/move/score + up to 4 lines, and the 7 mid-game toggles
                           // (board + full settings hidden). Keep in sync with popup.css .mephisto-compact
let panelCompact = false;  // popup.js owns the setting; this mirrors it for the sizing math below
const BOOK_H = 132;        // extra height for the opening-explorer overlay (heading + 5 book moves at
                           // 21px, no scrolling). Keep in sync with popup.css body.mephisto-book.
let panelBook = false;     // likewise mirrored: the overlay only grows the panel while it's shown
const panelH = () => panelCompact ? COMPACT_H : (POPUP_H + (panelBook ? BOOK_H : 0));
const POPUP_W = 568;       // the popup page's fixed layout size (popup.css html,body)
const POPUP_H = 672; // matches popup.css body height (whichever column is taller)
const OVERLAY_SCALE = 0.8; // default render scale for fresh installs; resizing the panel persists a width
const OVERLAY_BOX_KEY = 'mephisto.overlayBox'; // per-site localStorage: {left, top, width}

// 1b (anti-detection): every injected node -- the panel + its chrome-extension:// iframe, the
// restore badge, the on-board hint arrows and the eval bar -- lives inside a single CLOSED shadow
// root under one unstyled, attribute-less host div. A page cannot pierce a closed shadow root:
// `document.querySelector('[id^="mephisto-"]')` finds nothing, `host.shadowRoot` is null, and
// enumerating `<iframe>`s can't reach the panel's extension-URL frame. The internal ids keep the
// `mephisto-` prefix on purpose -- they're only reachable from inside this closed root, so renaming
// them would add churn for zero extra hiding. Lazily created once per tab.
let overlayHost = null;
let overlayRoot = null;

function getOverlayRoot() {
    if (overlayRoot && overlayHost && overlayHost.isConnected) return overlayRoot;
    overlayHost = document.createElement('div'); // no id / class / attributes to grep for
    // The host must NOT establish a containing block (no position/transform/filter/contain), so the
    // absolutely-positioned board overlays inside still resolve against the document exactly as they
    // did when they were direct children of <body>.
    document.body.appendChild(overlayHost);
    overlayRoot = overlayHost.attachShadow({mode: 'closed'});
    return overlayRoot;
}

// look up one of our overlay nodes inside the shadow root (replaces document.getElementById)
function overlayEl(id) {
    return overlayRoot ? overlayRoot.querySelector(`#${id}`) : null;
}

function saveOverlayBox(wrap) {
    const r = wrap.getBoundingClientRect();
    try {
        localStorage.setItem(OVERLAY_BOX_KEY, JSON.stringify(
            {left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width)}));
    } catch (e) { /* storage full/blocked -- panel just won't persist its geometry */ }
}

function readOverlayBox() {
    try {
        const box = JSON.parse(localStorage.getItem(OVERLAY_BOX_KEY));
        if (!box || !(box.width > 0)) return null;
        // clamp back into the viewport (saved on a bigger screen / window since resized)
        const width = Math.min(Math.max(box.width, 340), Math.round(window.innerWidth * 0.95));
        const left = Math.min(Math.max(box.left, 0), window.innerWidth - 60);
        const top = Math.min(Math.max(box.top, 0), window.innerHeight - 40);
        return {left, top, width};
    } catch (e) {
        return null;
    }
}

// Drag a box around the board when auto-detection misses. The captured image is the VISIBLE tab at
// devicePixelRatio, so the CSS-pixel rect the user drags has to be scaled by that ratio to line up
// with the pixels the recogniser sees -- on a retina screen it is 2x and skipping this reads the
// wrong quarter of the screen.
function startDragSelect() {
    if (document.getElementById('mephisto-drag-select')) return;
    const veil = document.createElement('div');
    veil.id = 'mephisto-drag-select';
    veil.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;' +
        'background:rgba(0,0,0,0.25)';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid #14b8a6;background:rgba(20,184,166,0.15);display:none';
    const hint = document.createElement('div');
    hint.textContent = 'Drag a box around the board  ·  Esc to cancel';
    hint.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
        'background:#1b1c22;color:#fff;padding:6px 12px;border-radius:6px;font:14px sans-serif';
    veil.appendChild(box); veil.appendChild(hint);
    document.documentElement.appendChild(veil);

    let sx = 0, sy = 0, dragging = false;
    const done = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(); } }
    document.addEventListener('keydown', onKey, true);
    veil.addEventListener('mousedown', (e) => {
        dragging = true; sx = e.clientX; sy = e.clientY;
        box.style.cssText += ';display:block';
        box.style.left = sx + 'px'; box.style.top = sy + 'px';
        box.style.width = box.style.height = '0px';
        e.preventDefault();
    });
    veil.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        box.style.left = Math.min(sx, e.clientX) + 'px';
        box.style.top = Math.min(sy, e.clientY) + 'px';
        box.style.width = Math.abs(e.clientX - sx) + 'px';
        box.style.height = Math.abs(e.clientY - sy) + 'px';
    });
    veil.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        const r = window.devicePixelRatio || 1; // captureVisibleTab returns device pixels
        const crop = {
            x: Math.min(sx, e.clientX) * r, y: Math.min(sy, e.clientY) * r,
            w: Math.abs(e.clientX - sx) * r, h: Math.abs(e.clientY - sy) * r,
        };
        done();
        if (crop.w < 40 * r || crop.h < 40 * r) return; // a stray click, not a selection
        // Hand it back to the panel, which re-runs the recognise path with detection skipped. Only
        // the FLOATING panel shares this realm; in toolbar-popup mode the popup page is the panel and
        // Chrome closes it the moment you click the page to drag, so say so rather than no-op.
        if (self.MephistoPanel?.snapWithCrop) self.MephistoPanel.snapWithCrop(crop);
        else console.warn('Mephisto: drag-select needs the floating panel (the toolbar popup closes when you click the page)');
    });
}

function removeOverlay() {
    // Stop the search + go inert BEFORE tearing the panel DOM down, so nothing keeps burning cores
    // while the panel is closed. The engine stays warm (not disposed) so reopening is instant --
    // see MephistoPanel.suspend. tabs.onRemoved still frees it on real tab close.
    try { self.MephistoPanel?.suspend?.(); } catch (e) { /* not yet booted */ }
    overlayEl(PANEL_OVERLAY_ID)?.remove();
    overlayEl(RESTORE_BADGE_ID)?.remove();
    clearEvalBar();   // closing removes the iframe; the board overlays it drew must go too
    clearHintArrow();
}

// Page unload = tab is going away (navigation, close, reload). Stop any running search cleanly so a
// long analysis doesn't keep a native host busy through the unload; the tab teardown itself frees
// the engine (tabs.onRemoved disposes the offscreen doc; the native Port dies with the page).
window.addEventListener('pagehide', () => {
    try { self.MephistoPanel?.suspend?.(); } catch (e) { /* */ }
});

// Minimize = HIDE the panel without tearing it down, so the engine + autoplay/premove/help keep
// running exactly as if it were open (closing with X, which removes the iframe, is what STOPS
// everything). We use opacity:0 + pointer-events:none rather than visibility:hidden/display:none:
// the frame stays full-size and in the viewport so Chrome treats it as VISIBLE and never throttles
// its timers (a cross-origin hidden iframe gets throttled to ~1/s -> laggy autoplay). pointer-events
// :none makes it click-through so it can't sit over a destination square and eat the autoplay click.
// Compact mode's resize half. popup.js owns the setting and the class on the panel body; hiding the
// contents can't shrink anything by itself, because the panel is a FIXED POPUP_W x POPUP_H box that
// we scale -- so the box and its wrapper have to be told the new height. Called by popup.js's
// apply_compact (see MephistoContent below). No-op in the toolbar popup: no overlay there, and
// Chrome sizes the bubble around the content anyway.
function resizePanelBox() {
    const wrap = overlayEl(PANEL_OVERLAY_ID);
    const frame = wrap?.querySelector('.mephisto-panel-box');
    if (!wrap || !frame) return;
    const scale = wrap.offsetWidth / POPUP_W; // the live scale: the user may have resized the panel
    frame.style.height = `${panelH()}px`;
    wrap.style.height = `${Math.round(24 + panelH() * scale)}px`;
}

function setPanelCompact(on) {
    panelCompact = !!on;
    resizePanelBox();
}

// Same story as compact, the other direction: the opening-explorer overlay adds a block under the
// alternative lines, and a fixed-size scaled box can't grow just because content appeared.
function setPanelBook(on) {
    panelBook = !!on;
    resizePanelBox();
}

function minimizeOverlay(wrap) {
    const frame = wrap.querySelector('.mephisto-panel-box'); // the panel is a plain div now, not an iframe
    wrap.style.opacity = '0';
    wrap.style.pointerEvents = 'none';
    // set it on the iframe TOO, explicitly: the drag handler's mouseup leaves an inline
    // pointer-events:auto on the frame, which would override the wrap's inherited 'none' and keep
    // the invisible panel eating clicks. This makes the whole minimized panel click-through.
    if (frame) frame.style.pointerEvents = 'none';
    if (overlayEl(RESTORE_BADGE_ID)) return;
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
    getOverlayRoot().appendChild(badge);
}

async function toggleOverlay() {
    if (overlayEl(PANEL_OVERLAY_ID)) {
        removeOverlay();
        return;
    }
    // The panel's markup + CSS arrive from the background as BYTES. They are deliberately NOT loaded
    // by URL: a <link>/<iframe> pointing at chrome-extension://<id>/... would both hand the page our
    // id and land in its Resource Timing (issue #35 §3.1/§3.4). getOverlayRoot() first -- the style
    // is injected into the shadow root, which must exist.
    const overlayRoot = getOverlayRoot();
    let assets;
    try {
        assets = await chrome.runtime.sendMessage({getPanelAssets: true});
    } catch (e) {
        console.warn('Mephisto: could not load panel assets', e);
        return;
    }
    if (!assets || assets.error || !assets.html) {
        console.warn('Mephisto: panel assets unavailable', assets && assets.error);
        return;
    }
    // saved geometry wins (drag/resize persists it); fresh installs get the scaled default at top-right
    const saved = readOverlayBox();
    const startW = saved ? saved.width : Math.round(POPUP_W * OVERLAY_SCALE);
    let scale = startW / POPUP_W;
    const wrap = document.createElement('div');
    wrap.id = PANEL_OVERLAY_ID;
    wrap.style.cssText = 'position: fixed; z-index: 2147483646; ' +
        (saved ? `top: ${saved.top}px; left: ${saved.left}px; ` : 'top: 4px; right: 0; ') +
        `width: ${startW}px; height: ${Math.round(24 + POPUP_H * scale)}px; ` +
        'border-radius: 8px; overflow: hidden; background: #f0f0f0; ' +
        'box-shadow: 0 6px 24px rgba(0,0,0,0.45);';

    const bar = document.createElement('div');
    bar.style.cssText = 'height: 24px; background: #2d2d2d; color: #ddd; display: flex; ' +
        'align-items: center; justify-content: space-between; padding: 0 10px; ' +
        'font: 12px Roboto, sans-serif; cursor: move; user-select: none;';
    bar.innerHTML = '<span>Mephisto</span>' +
        '<span style="display: flex; align-items: center; gap: 2px;">' +
        '<span class="mephisto-overlay-compact" title="Compact / expanded: collapse to just the move and score" ' +
        'style="cursor: pointer; padding: 0 6px; font-size: 13px; line-height: 1;">▣</span>' +
        '<span class="mephisto-overlay-min" title="Minimize (autoplay keeps running)" ' +
        'style="cursor: pointer; padding: 0 6px; font-size: 18px; line-height: 1;">–</span>' +
        '<span class="mephisto-overlay-close" title="Close" ' +
        'style="cursor: pointer; padding: 0 4px; font-size: 14px;">✕</span>' +
        '</span>';

    // THE PANEL ITSELF -- no iframe. popup.html's body is injected straight into the closed shadow
    // root and driven by popup.js running in this isolated world. An <iframe> is a browsing CONTEXT:
    // the page counts it in window.length and gets a throw from window[i].location, which a closed
    // shadow root does NOT hide (issue #35 §3.1/§3.3). A plain <div> has no such tell. The markup,
    // CSS and piece images are all delivered as bytes by the background, so no chrome-extension://
    // URL is ever visible to the page or its Resource Timing (§3.4).
    const frame = document.createElement('div');
    frame.className = 'mephisto-panel-box';
    frame.style.cssText = `width: ${POPUP_W}px; height: ${POPUP_H}px; border: none; display: block; background: #f0f0f0; ` +
        `overflow: hidden; transform: scale(${scale}); transform-origin: top left;`;
    const panelBody = document.createElement('div');
    panelBody.id = 'mephisto-panel-body'; // stands in for popup.html's <body> (CSS is rehomed onto it)
    panelBody.innerHTML = assets.html;
    frame.appendChild(panelBody);
    if (!overlayRoot.querySelector('style[data-mp]')) {
        const style = document.createElement('style'); // scoped to the shadow root; never touches the page
        style.setAttribute('data-mp', '');
        style.textContent = assets.css;
        overlayRoot.appendChild(style);
    }

    // resize grip: a corner handle that rescales the whole panel (aspect-locked -- the popup is a
    // fixed layout, so resizing changes the SCALE, not the layout). Native CSS `resize` doesn't
    // work here: the iframe sits over the corner and eats the mouse.
    const grip = document.createElement('div');
    grip.title = 'Resize';
    grip.style.cssText = 'position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; ' +
        'cursor: nwse-resize; z-index: 10; ' +
        'background: linear-gradient(135deg, transparent 50%, rgba(120,120,120,0.7) 50%); ' +
        'border-bottom-right-radius: 8px;';

    wrap.append(bar, frame, grip);
    overlayRoot.appendChild(wrap);
    bar.querySelector('.mephisto-overlay-close').addEventListener('click', removeOverlay);
    bar.querySelector('.mephisto-overlay-min').addEventListener('click', () => minimizeOverlay(wrap));
    // popup.js owns the compact setting (persists it, drives the class) and calls straight back into
    // MephistoContent.setPanelCompact -- which resizes us AND repaints this icon. Just ask it to flip.
    bar.querySelector('.mephisto-overlay-compact')
        .addEventListener('click', () => self.MephistoPanel?.toggleCompact?.());
    // Boot the panel. popup.js is a content script in THIS isolated world, so this is a direct call --
    // no module import (which would need web_accessible_resources and leak the id via Resource Timing).
    // It looks its elements up through the shadow root we hand it, and talks to our tab by id.
    try {
        self.MephistoPanel.initPanel(overlayRoot, mephistoTabId);
    } catch (e) {
        console.warn('Mephisto: panel failed to start', e);
    }

    // corner-drag resize; persists like drag does
    let resizing = false, resizeFromX, resizeStartW;
    grip.addEventListener('mousedown', e => {
        resizing = true;
        frame.style.pointerEvents = 'none'; // the iframe must not eat mousemove mid-resize
        const rect = wrap.getBoundingClientRect();
        [resizeFromX, resizeStartW] = [e.clientX, rect.width];
        // anchor the top-left corner: growing a right-anchored panel would push it off-screen
        wrap.style.left = `${rect.left}px`;
        wrap.style.top = `${rect.top}px`;
        wrap.style.right = 'auto';
        e.preventDefault();
        e.stopPropagation();
    });
    window.addEventListener('mousemove', e => {
        if (!resizing) return;
        const w = Math.min(Math.max(resizeStartW + e.clientX - resizeFromX, 340),
            Math.round(window.innerWidth * 0.95));
        scale = w / POPUP_W;
        wrap.style.width = `${w}px`;
        wrap.style.height = `${Math.round(24 + panelH() * scale)}px`; // panelH(): compact must survive a resize
        frame.style.transform = `scale(${scale})`;
    });
    window.addEventListener('mouseup', () => {
        if (!resizing) return; // see the drag mouseup below for why this must be conditional
        resizing = false;
        frame.style.pointerEvents = 'auto';
        saveOverlayBox(wrap);
    });

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
        // ONLY a real drag-end may touch the frame: this global listener fires on every mouseup
        // on the page forever, and unconditionally restoring pointer-events:auto re-armed the
        // invisible MINIMIZED panel on the user's next click (a child with explicit 'auto' is
        // hit-testable even under a pointer-events:none parent) -- eating clicks again.
        if (!dragging) return;
        dragging = false;
        frame.style.pointerEvents = 'auto';
        saveOverlayBox(wrap);
    });
}

// ------------------------------------------------------------------------------------------
// Help mode: instead of autoplaying, overlay the engine's best move as an arrow directly on
// the site's board so the user can play it themselves at their own pace.

const HINT_OVERLAY_ID = 'mephisto-hint-overlay';
let lastHintKey = null;

function clearHintArrow() {
    lastHintKey = null;
    overlayEl(HINT_OVERLAY_ID)?.remove();
}

// arrows: [{move: 'e2e4', width: 0..0.25 (in squares), color: '#rrggbb'}, ...] best line first --
// the same set the popup draws on its mini board (multipv lines weighted by score, threat in red)
function drawHintArrows(arrows) {
    arrows = (arrows || []).filter(a => a && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(a.move ?? ''));
    // help mode redraws on every engine update; skip the DOM churn while the arrows are unchanged
    const key = JSON.stringify(arrows);
    if (key === lastHintKey && overlayEl(HINT_OVERLAY_ID)) return;
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
    getOverlayRoot().appendChild(svg);
    lastHintKey = key;
}

// ------------------------------------------------------------------------------------------
// Opponent-mistake toast: a small label that fades in over the TOP of the board when the popup
// judges the opponent's last move an inaccuracy/mistake/blunder. Lives in the same CLOSED shadow
// root as everything else, so it adds no page-detectable DOM (the point of "undetectable").
const OPP_ALERT_ID = 'mephisto-opp-alert';
const OPP_ALERT_STYLE = {
    inaccuracy: {text: 'Inaccuracy', bg: '#1e6fb8'},
    mistake:    {text: 'Mistake',    bg: '#c8901a'},
    blunder:    {text: 'Blunder',    bg: '#c0392b'},
};
let oppAlertTimer = null;

function showOppAlert(label, drop, san, uci) {
    const style = OPP_ALERT_STYLE[label];
    const board = getBoard();
    if (!style || !board) return;
    overlayEl(OPP_ALERT_ID)?.remove();
    const bounds = board.getBoundingClientRect();
    const el = document.createElement('div');
    el.id = OPP_ALERT_ID;
    const title = `⚠ Opponent ${style.text}${Number.isFinite(drop) ? ` (−${drop}%)` : ''}`;
    // move in SAN and UCI on a second, smaller line (e.g. "Nf6 · g8f6")
    const moveBits = [san, uci].filter(Boolean);
    const moveLine = moveBits.length ? `<div style="font-size:15px;font-weight:500;opacity:0.92;margin-top:2px">${moveBits.join(' · ')}</div>` : '';
    el.innerHTML = `<div>${title}</div>${moveLine}`;
    // centred over the top of the board; fixed so it tracks the viewport, high z-index, no pointer capture
    el.style.cssText =
        `position: fixed; left: ${bounds.left + bounds.width / 2}px; top: ${bounds.top + 10}px; ` +
        `transform: translateX(-50%); z-index: 2147483647; pointer-events: none; text-align: center; ` +
        `background: ${style.bg}; color: #fff; font: 700 19px Roboto, sans-serif; ` +
        `padding: 9px 18px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); ` +
        `opacity: 0; transition: opacity 0.2s;`;
    getOverlayRoot().appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    clearTimeout(oppAlertTimer);
    oppAlertTimer = setTimeout(() => { // stay ~3.5s, then fade
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }, 3500);
}

// ------------------------------------------------------------------------------------------
// Eval bar: a vertical evaluation bar drawn just to the LEFT of the site board, styled like the
// popup's own bar (dark = black's share, white = white's share), with the score shown inside it
// chess.com-style. The popup computes the numbers and pushes them on every eval update.

const EVALBAR_OVERLAY_ID = 'mephisto-evalbar-overlay';

function clearEvalBar() {
    overlayEl(EVALBAR_OVERLAY_ID)?.remove();
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
    const BAR_W = 28, GAP = 8;

    let bar = overlayEl(EVALBAR_OVERLAY_ID);
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
            'font: 700 12px/1.4 Roboto, Arial, sans-serif;';
        bar.append(white, num);
        getOverlayRoot().appendChild(bar);
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
// chess.com runs variants at www.chess.com/variants/<slug>/game/<id> with a React "TheBoard"
// component whose DOM is nothing like the main site's -- own board, move list and piece markup.
function isChesscomVariants() {
    return site === 'chesscom' && /\/variants\//.test(location.pathname);
}

function detectVariant() {
    if (site === 'lichess') return detectLichessVariant();
    if (site === 'chesscom') return detectChesscomVariant();
    return null;
}

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

// read the Fairy-Stockfish variant key straight out of the chess.com variants URL slug.
function detectChesscomVariant() {
    const slug = (location.pathname.match(/\/variants\/([^/]+)/) || [])[1];
    if (!slug) return null;
    const map = {
        '3-check': '3check', 'king-of-the-hill': 'kingofthehill', 'racing-kings': 'racingkings',
        'crazyhouse': 'crazyhouse', 'atomic': 'atomic', 'horde': 'horde',
        'antichess': 'antichess', 'giveaway': 'antichess', 'chess960': 'fischerandom',
        'duck': 'duck', 'minihouse': 'minihouse', 's-chess': 'seirawan', 'seirawan': 'seirawan',
        'chaturanga': 'chaturanga', 'standard': 'chess',
    };
    return map[slug] || map[slug.replace(/-/g, '')] || null;
}

function tryScrapePosition() {
    try {
        return scrapePosition() || 'no'; // scrapePosition() returns undefined when there is no board
    } catch (e) {
        return 'no'; // skip the current attempt, if we can't scrape
    }
}

function scrapePosition() {
    if (site === 'taketaketake') return scrapePositionTT(); // state-based, no DOM to scrape
    if (site === 'chessbase') return scrapePositionCB(); // FEN straight from the page's CB.* model
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
    if (isChesscomVariants()) {
        // live variant game: scrape every ply's SAN straight through to the latest move (the
        // current position). Fairy-Stockfish rebuilds the position from UCI_Variant + these SANs.
        for (const cell of getMoveRecords()) {
            res += cell.textContent.trim() + '*****';
        }
        return res;
    }
    if (site === 'chesscom') {
        for (const moveWrapper of getMoveRecords()) {
            const move = moveWrapper.lastElementChild;
            // This branch takes `.node` unfiltered, unlike the variants branch above which already
            // skips "trailing empty placeholder cells". A childless one made this a TypeError, and
            // tryScrapePosition catches that and returns 'no' for the WHOLE scrape -- so a single
            // placeholder meant the extension saw nothing at all. Skip rather than break: a trailing
            // placeholder makes them equivalent, and if one ever landed mid-list the resulting gap
            // makes the popup's SAN replay throw (caught, safe), whereas truncating to a valid
            // shorter prefix would silently analyse a stale position and play a move for it.
            if (!move) continue;
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
    if (site === 'taketaketake') {
        // the app keeps the viewer's color at the bottom ('blackDown' when playing black);
        // spectators default to white-down
        return (ttQuery()?.myColor === 'black') ? 'black' : 'white';
    }
    if (site === 'chessbase') {
        // no site board to overlay; orient the popup's own board to the side to move so the solver
        // sees the puzzle from the moving side's perspective
        return (cbState && cbState.split(' ')[1] === 'b') ? 'black' : 'white';
    }
    if (isChesscomVariants()) {
        return getChesscomVariantsOrientation();
    } else if (site === 'chesscom') {
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

// The chess.com variants board has no coordinate labels or flip class, and piece data-color codes
// are assigned per-game (5/6/7...), so we can't hardcode "white=N". Classify the two sides
// RELATIVELY: decode each colour's SVG sprite -- the lighter-filled side is White. The board is
// White-oriented (a1 bottom-left) when White's pieces sit LOWER on screen (larger translateY).
// ponytail: relative-lightness heuristic; needs both colours present on the board (true except in
// near-empty antichess/atomic endgames) -- falls back to 'white' (un-flipped) when it can't tell.
function getChesscomVariantsOrientation() {
    const pieces = [...document.querySelectorAll('.piece.BasePiece-component:not([data-dead])')];
    const groups = {}; // colour code -> {ys:[...], light}
    for (const p of pieces) {
        const c = p.getAttribute('data-color');
        const y = parseFloat((/,\s*(-?\d+(?:\.\d+)?)px/.exec(p.getAttribute('style')) || [0, 0])[1]);
        (groups[c] || (groups[c] = {ys: [], light: spriteLightness(p)})).ys.push(y);
    }
    const sides = Object.values(groups).filter(g => g.light != null);
    if (sides.length < 2) return 'white';
    const avgY = g => g.ys.reduce((a, b) => a + b, 0) / g.ys.length;
    const white = sides.reduce((a, b) => (b.light > a.light ? b : a));
    const black = sides.reduce((a, b) => (b.light < a.light ? b : a));
    return (avgY(white) > avgY(black)) ? 'white' : 'black';
}

// mean luminance of the fill colours in a variants piece's data-URI SVG sprite (0=black..1=white)
function spriteLightness(piece) {
    const b64 = getComputedStyle(piece).backgroundImage.match(/base64,([^")]+)/);
    if (!b64) return null;
    let svg;
    try { svg = atob(b64[1]); } catch (e) { return null; }
    const fills = [...svg.matchAll(/fill\s*[:=]\s*["']?(#[0-9a-fA-F]{3,6})/g)].map(m => m[1]);
    if (!fills.length) return null;
    const lum = hex => {
        hex = hex.slice(1);
        if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
        const n = parseInt(hex, 16);
        return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };
    return fills.map(lum).reduce((a, b) => a + b, 0) / fills.length;
}

// -------------------------------------------------------------------------------------------
// TakeTakeTake (taketaketake.com): the board is a WebGPU canvas with NO DOM pieces/squares, so
// the position comes from the page's React state via tt-probe.js (MAIN-world content script).
// The probe answers a 'mephisto-tt-query' CustomEvent SYNCHRONOUSLY with 'mephisto-tt-state'
// (JSON: fen, moves[{san,uci}], myColor, clocks in ms, increment), so ttQuery() is a plain
// synchronous read from the scrapers' point of view.

// item 1: the MAIN-world probes (tt-probe.js / cb-probe.js) each pick a RANDOM per-session channel
// id and announce it over the fixed 'm9' rendezvous. We capture it and wire the state/update
// listeners onto that random channel, so the data-carrying events have no fixed name to fingerprint.
// (state = query RESPONSE, update only, never schedulePush or it self-loops; update = unsolicited
// PUSH from the probe's subscription, which refreshes + schedules a scrape.)
let ttState = null, ttSid = null;
let cbState = null, cbSid = null; // cb is wired in the SAME rendezvous below; declared here for it
document.addEventListener('m9', (e) => {
    let d;
    try { d = JSON.parse(e.detail); } catch (err) { return; }
    if (!d || !d.s) return;
    if (d.t === 'tt' && d.s !== ttSid) {
        ttSid = d.s;
        document.addEventListener(ttSid + 's', ev => { try { ttState = JSON.parse(ev.detail); } catch (err) { ttState = null; } });
        document.addEventListener(ttSid + 'u', ev => { try { ttState = JSON.parse(ev.detail); } catch (err) { return; } if (config) schedulePush(); });
    } else if (d.t === 'cb' && d.s !== cbSid) {
        cbSid = d.s;
        document.addEventListener(cbSid + 's', ev => { try { cbState = JSON.parse(ev.detail); } catch (err) { cbState = null; } });
        document.addEventListener(cbSid + 'u', ev => { try { cbState = JSON.parse(ev.detail); } catch (err) { return; } if (config) schedulePush(); });
    }
});

function ttQuery() {
    if (ttSid) { try { document.dispatchEvent(new CustomEvent(ttSid + 'q')); } catch (e) { /* stale */ } }
    return ttState;
}

// scrape = the SAN move list from the probe, shipped through the same 'fen***' path lichess and
// chess.com use (standard start + SANs; the popup rebuilds the position with chess.js)
function scrapePositionTT() {
    const st = ttQuery();
    if (!st || !st.fen) return; // no active game on this page
    let res = '***ttfen***';
    for (const m of st.moves) res += m.san + '*****';
    return res.replace(/[^\w-+=#*@&]/g, '');
}

// -------------------------------------------------------------------------------------------
// ChessBase Tactics (tactics.chessbase.com): the board is ChessBase's proprietary CB.* engine, with
// no scrapeable FEN in the DOM. cb-probe.js (MAIN-world content script) reads the live model at
// window.V35s.gameKernel.getCurPos().toFEN() and bridges it: 'mephisto-cb-query' is answered
// synchronously with 'mephisto-cb-state', and 'mephisto-cb-update' is PUSHED on every move so a
// newly-solved/taken-back position is seen instantly instead of on the fallback poll.

// cbState + its state/update listeners are wired in the shared 'm9' rendezvous handler above
// (same mechanism as tt); cbQuery just fires a query on the captured random channel.
function cbQuery() {
    if (cbSid) { try { document.dispatchEvent(new CustomEvent(cbSid + 'q')); } catch (e) { /* stale */ } }
    return cbState;
}

// scrape = the current FEN straight from the model, shipped WHOLE (spaces/slashes intact, no
// sanitizer) as '***cbfen***<FEN>'. Puzzles start from arbitrary positions, so the popup feeds the
// FEN to the engine directly rather than replaying moves from the standard start.
function scrapePositionCB() {
    const fen = cbQuery();
    return (fen) ? '***cbfen***' + fen : undefined;
}

// -------------------------------------------------------------------------------------------
// Clocks: best-effort scrape of both players' remaining time + the game's increment, shipped
// with every position push so the popup's Clock Mode can budget its thinking. Missing/unparsable
// clocks yield null fields -- the popup then just behaves as if Clock Mode were off.

function parseClockText(txt) {
    // "1:23:45(.6)" / "2:41" / "0:45.3" / "45.3" -> seconds
    const m = (txt || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$|^(\d+(?:[.,]\d+)?)$/);
    if (!m) return null;
    if (m[4] != null) return parseFloat(m[4].replace(',', '.'));
    const h = m[1] ? parseInt(m[1]) : 0;
    return h * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3].replace(',', '.'));
}

function scrapeClocks() {
    if (site === 'taketaketake') { // exact server clocks (ms) from the probe, no DOM parsing
        const st = ttQuery();
        if (!st || st.whiteClockMs == null || st.blackClockMs == null) return null;
        const black = (st.myColor === 'black');
        return {
            mine: (black ? st.blackClockMs : st.whiteClockMs) / 1000,
            theirs: (black ? st.whiteClockMs : st.blackClockMs) / 1000,
            increment: st.increment,
        };
    }
    let mineTxt = null, theirsTxt = null, tcText = '';
    if (site === 'lichess') {
        mineTxt = document.querySelector('.rclock-bottom .time')?.textContent;
        theirsTxt = document.querySelector('.rclock-top .time')?.textContent;
        tcText = document.querySelector('.game__meta .setup')?.textContent || '';
    } else if (isChesscomVariants()) {
        mineTxt = document.querySelector('.playerbox-bottom .clock-component')?.textContent;
        theirsTxt = document.querySelector('.playerbox-top .clock-component')?.textContent;
    } else if (site === 'chesscom') {
        // chess.com's clock DOM varies by surface: live games use `.clock-component`, the Play Bots
        // layout reuses `.move-time` inside the player row. Read whichever exists in each player's
        // container (bottom = us, top = them). Prefer the real clock; fall back to move-time only
        // when there is no clock component (bot games, where move-time IS the running clock).
        const clockIn = (container) => {
            const c = document.querySelector(container);
            if (!c) return null;
            const el = c.querySelector('.clock-component')
                || c.querySelector('.move-time-content') || c.querySelector('.move-time-time');
            return el ? el.textContent : null;
        };
        mineTxt = clockIn('.board-layout-bottom') || clockIn('#board-layout-player-bottom')
            || document.querySelector('.clock-bottom')?.textContent;
        theirsTxt = clockIn('.board-layout-top') || clockIn('#board-layout-player-top')
            || document.querySelector('.clock-top')?.textContent;
        tcText = document.querySelector('.time-control-component, .game-time-control')?.textContent || '';
    }
    const mine = parseClockText(mineTxt), theirs = parseClockText(theirsTxt);
    if (mine == null && theirs == null) return null;
    // increment from time-control text like "3+2" / "½+0 • Rated • Bullet"; null when unknown
    const inc = tcText.match(/[\d½¼]+\s*\+\s*(\d+)/);
    return {mine, theirs, increment: inc ? parseInt(inc[1]) : null};
}

let movingWatchdog = null;

// `moving` is set/cleared explicitly, never toggled. Both the watchdog and the move's own `.finally`
// call endMoving, and for a think longer than the watchdog BOTH fire -- a toggle flipped the second
// call false->true and stranded `moving` true with no move in progress, freezing every scrape for a
// further 15s (and re-arming the watchdog to do it again).
function beginMoving(thinkMs = 0) {
    moving = true;
    // Safety net: while `moving` is true the content-script ignores ALL scrape requests, so a move
    // simulation that never resolves (a hung click / promotion) would freeze the extension ("gets
    // stuck and doesn't play anything"). The grace sits ON TOP of this move's think, which is
    // user-configurable and uncapped: a flat timeout would expire mid-think on a legitimately slow
    // move and drop the `moving` guard -- and that guard is what stops a second automove starting
    // on top of the one still waiting to click.
    clearTimeout(movingWatchdog);
    movingWatchdog = setTimeout(endMoving, (Number(thinkMs) || 0) + 15000);
}

function endMoving() {
    clearTimeout(movingWatchdog);
    moving = false;
    schedulePush(); // catch up: board mutations during the automove were suppressed
}

function pullConfig() {
    chrome.runtime.sendMessage({ pullConfig: true });
}

// -------------------------------------------------------------------------------------------
// Event-driven position pipeline. The panel used to learn about position changes by POLLING
// {queryfen} every fen_refresh ms (10ms default) -- 100 full DOM scrapes + forced layout flushes
// per second to observe a board that changes a few times a minute, running for the lifetime of
// the tab. Instead, a MutationObserver PUSHES a scrape to the panel when the page's DOM actually
// changes: zero work at idle, and detection within one debounce window of the move committing.
// The {queryfen} poll survives popup-side as a >=1s fallback (heals a missed push), and this
// pipeline reuses its exact response shape ({dom, orient, fenresponse}), so the panel consumes
// pushes and poll replies through one code path.

let positionObserver = null;
let pushDebounce = null;  // pending debounce timer id, or null
let lastPushKey = null;   // orientation|scrape of the last full (analysed) push, for dedupe
let lastDisplayKey = null; // orientation|scrape of the last displayOnly push (mid-move panel mirror)

function startPositionObserver() {
    if (positionObserver) return; // config re-pushes must not stack observers
    positionObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            // ignore mutations from our own injected UI. It now lives in a closed shadow root, so
            // its churn (panel drag, eval bar / hint redraws) never reaches this body observer at
            // all; the only light-DOM node we add is the shadow HOST, so skip that. (The legacy
            // `[id^="mephisto-"]` guard stays as a belt-and-suspenders for any stray light-DOM node.)
            const t = (m.target instanceof Element) ? m.target : m.target.parentElement;
            if (t && (t === overlayHost || t.closest('[id^="mephisto-"]'))) continue;
            schedulePush();
            return;
        }
    });
    positionObserver.observe(document.body, {
        subtree: true,
        childList: true,               // moves appended to the move list, pieces added/removed
        attributes: true,
        attributeFilter: ['class', 'style'], // piece moves = class/transform changes on both sites
        // characterData deliberately EXCLUDED: clock ticks are text mutations, every second, forever
    });
}

// Debounce: fire one scrape 30ms after the FIRST mutation of a burst (a piece animation is dozens
// of mutations). Re-arms on later mutations, so a settling burst always ends with one final scrape
// ~30ms after its LAST mutation; during a continuous burst this samples at most ~33/s, and a
// mid-animation sample is rejected by the scrapers ('no') without being pushed.
function schedulePush() {
    if (pushDebounce) return;
    pushDebounce = setTimeout(() => {
        pushDebounce = null;
        pushPosition();
    }, 30);
}

function pushPosition() {
    if (!config) return;           // no config yet -> can't scrape
    const res = tryScrapePosition();
    if (res === 'no') return;      // transient (animating, no board): never push, never dedupe
    const orient = getOrientation();
    const key = `${orient}|${res}`;
    if (key === lastPushKey) return; // already delivered as a full (analysed) push -> nothing to do
    try {
        if (moving) {
            // mid-automove: mirror the position on the panel board the INSTANT it settles, so the
            // small board tracks the move in real time instead of freezing until the move verifies.
            // Flag it displayOnly -- the popup only redraws, never re-analyses/auto-moves mid-move
            // (the `moving` guard on incoming automoves is the real double-move protection). Do NOT
            // advance lastPushKey: the authoritative full push must still fire once `moving` clears.
            if (key === lastDisplayKey) return; // dedupe repeat display pushes of the same position
            lastDisplayKey = key;
            sendToPanel({ dom: res, orient, clocks: scrapeClocks(), fenresponse: true, displayOnly: true });
            return;
        }
        lastPushKey = key;
        sendToPanel({ dom: res, orient: orient, clocks: scrapeClocks(), fenresponse: true });
    } catch (e) {
        // extension was reloaded -- this orphaned content-script can't reach it anymore
    }
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
    if (site === 'taketaketake') {
        return ttQuery()?.moves || []; // move-count verification reads .length
    }
    if (isChesscomVariants()) {
        // one <div.moves-table-cell.moves-move> per ply, textContent = SAN. Keep only real moves
        // (a SAN has a destination square, is castling, or a drop like P@e4) so trailing empty
        // placeholder cells and any result/annotation marker don't get scraped as bogus moves.
        return Array.from(document.querySelectorAll('.moves-table-cell.moves-move')).filter(el => {
            const t = el.textContent.trim();
            return /[a-h][1-8]/.test(t) || /^O-O(-O)?[+#]?$/.test(t);
        });
    }
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
    // every known selector came up empty -> read the moves off the re-anchored container instead
    // (a renamed tag inside an otherwise-intact move list lands here rather than above)
    if (!moves?.length && (site === 'lichess' || site === 'chesscom')) {
        const recovered = recoverMoveContainer();
        if (recovered) moves = sanChildren(recovered);
    }
    return moves;
}

// --- Auto-recover from a site DOM change ------------------------------------------------------
// Sites rename or re-obfuscate their move-list tags without warning (lichess went kwdb -> z7yx once
// already). When that happens the site-specific selectors quietly return nothing and a LIVE game
// falls through to the puzzle path: it still looks like it works, but it scrapes pieces instead of
// the move list, so castling rights, en-passant and repetition are silently lost -- the worst kind
// of failure. Rather than chase each new tag name, find the move list STRUCTURALLY: the element with
// the most SAN-looking leaf children. LAST RESORT ONLY -- it runs where the normal selectors already
// came up empty, so a working scrape can never be affected.
const SAN_TEXT = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/;
const RECOVER_MIN_MOVES = 6; // a real game's list -- not a stray "e4" in prose or a 2-move puzzle
let recoveredMoves = null;   // cached container the scan found
let lastRecoverScan = 0;     // throttle: don't rescan the whole DOM on every poll

function sanChildren(el) {
    return el ? Array.from(el.children).filter(c => SAN_TEXT.test(c.textContent.trim())) : [];
}

function recoverMoveContainer() {
    // still good? keep it -- this is the common path once we've re-anchored
    if (recoveredMoves?.isConnected && sanChildren(recoveredMoves).length >= RECOVER_MIN_MOVES) {
        return recoveredMoves;
    }
    const now = Date.now();
    if (now - lastRecoverScan < 2000) return null; // a page with genuinely no move list (puzzles)
    lastRecoverScan = now;
    const counts = new Map();
    for (const el of document.querySelectorAll('body *')) {
        if (el.children.length) continue; // the SAN sits on a leaf
        const t = el.textContent.trim();
        if (!t || t.length > 8 || !SAN_TEXT.test(t)) continue;
        const p = el.parentElement;
        if (p) counts.set(p, (counts.get(p) || 0) + 1);
    }
    let best = null, most = 0;
    for (const [el, n] of counts) if (n > most) { best = el; most = n; }
    if (most < RECOVER_MIN_MOVES) return (recoveredMoves = null);
    if (best !== recoveredMoves) {
        console.warn(`Mephisto: move-list selectors matched nothing - re-anchored on <${best.tagName.toLowerCase()}>`
            + ` holding ${most} moves. The site's DOM has probably changed.`);
    }
    return (recoveredMoves = best);
}

function getMoveContainer() {
    let moveContainer;
    if (site === 'taketaketake') {
        return getBoard(); // unused on this site (scrapePositionTT bypasses the DOM paths)
    }
    if (isChesscomVariants()) {
        moveContainer = document.querySelector('.moves-moves-list');
    } else if (site === 'chesscom') {
        moveContainer = document.querySelector('wc-simple-move-list');
    } else if (site === 'lichess') {
        moveContainer = getLichessMovesApp() // live game (real-time + correspondence)
            || document.querySelector('l4x') // live game (older lichess DOM)
            || document.querySelector('.tview2'); // analysis / puzzle / training
    }
    // nothing matched on a site that should have a move list -> try the structural re-anchor before
    // letting scrapePosition fall through to the puzzle path and quietly drop the move history
    if (!moveContainer && (site === 'lichess' || site === 'chesscom')) {
        moveContainer = recoverMoveContainer();
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
    // Auto-detect the side to move from the board. Any manual override lives in the PANEL now (the
    // header king switch rewrites the parsed FEN's turn), so this stays a pure detector.
    let toSquare;
    try {
        toSquare = getLastMoveHighlights()[1];
    } catch (e) {
        // no last-move highlight to read the turn from. If a move list exists, derive the turn from
        // how many moves have been played. Normally White moved first, so an even count => White to
        // move. But a lichess "From Position" game can START with Black to move -- its cached start
        // string leads with the side-to-move token -- so count parity from THAT side (M4). Absent a
        // custom start (every normal game) firstTurn stays 'w' and this is unchanged.
        if (getMoveContainer()) {
            let firstTurn = 'w';
            if (site === 'lichess') {
                const startPos = startPosCache?.get?.(location.href)?.position;
                if (startPos && startPos[0] === 'b') firstTurn = 'b';
            }
            const secondTurn = (firstTurn === 'w') ? 'b' : 'w';
            return (getMoveRecords().length % 2 === 0) ? firstTurn : secondTurn;
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
    if (site === 'taketaketake') {
        // the WebGPU canvas is exactly the 8x8 board (aspect-square) -- clicks, the eval bar and
        // hint arrows all key off its bounding rect
        return document.querySelector('canvas[class*="aspect-square"]') || document.querySelector('canvas');
    }
    if (isChesscomVariants()) {
        board = document.querySelector('.TheBoard-layers');
    } else if (site === 'chesscom') {
        board = document.querySelector('.board');
    } else if (site === 'lichess') {
        board = document.querySelector('.main-board');
    } else if (site === 'blitztactics') {
        board = document.querySelector('.chessground-board');
    }
    return board;
}

function getPieces() {
    if (site === 'taketaketake') {
        return []; // no DOM pieces; determineStartPosition's lichess-only cache never applies here
    }
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
    // taketaketake: the promotion picker is part of the canvas app; there is no DOM to click yet.
    // Returning undefined skips the promotion click cleanly (the site may auto-queen; if not, the
    // move-verify retry + watchdog keep the extension unstuck).
    if (site === 'taketaketake') return undefined;
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
    if (site === 'taketaketake') {
        return false; // state-based scrape -- there is no mid-animation DOM to misread
    }
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


// A "From Position" game's custom start could only ever be captured at move 0, by scraping the
// pieces off the board. Reload such a game at move 20 and the capture was skipped entirely -- every
// later scrape then replayed the moves from the STANDARD start, so the analysis was of a different
// game (or aborted on the first move that didn't fit). The page still knows the real start, so read
// it from the embedded game data instead of the board. Returns the start in the same piece-string
// form scrapePositionPuz produces, or null.
const FEN_RE = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+ [wb] /;

function fenToPuzString(fen) {
    const [placement, turn] = fen.trim().split(/\s+/);
    let out = `${turn}*****`;
    const rows = placement.split('/');
    if (rows.length !== 8) return null;
    for (let r = 0; r < 8; r++) {
        let file = 0;
        for (const ch of rows[r]) {
            if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
            const sq = String.fromCharCode(97 + file) + (8 - r);
            out += `${ch === ch.toUpperCase() ? 'w' : 'b'}-${ch.toLowerCase()}-${sq}*****`;
            file++;
        }
        if (file !== 8) return null;
    }
    return out;
}

// lichess ships the game's starting FEN in the page (the round data calls it initialFen). Read it
// from the raw HTML rather than a DOM path, so a markup reshuffle doesn't break it -- and validate
// hard, because a wrong start position corrupts every scrape that follows.
function readInitialFenFromPage() {
    if (site !== 'lichess') return null;
    try {
        const m = document.documentElement.innerHTML.match(/"initialFen"\s*:\s*"([^"]+)"/);
        if (!m) return null;
        const fen = m[1].replace(/\\\//g, '/').trim();
        if (fen === 'startpos' || !FEN_RE.test(fen)) return null;
        new Chess('chess', fen); // throws on anything chess.js can't read
        return fenToPuzString(fen);
    } catch (e) {
        return null;
    }
}

function onPositionLoad(retries = 10) {
    // Loaded mid-game (a refresh, or opening a game already in progress): the board no longer shows
    // the start, so ask the page for it. This is the only path that can recover a custom start after
    // move 0 -- without it the game is replayed from the standard position.
    if (getMoveRecords()?.length) {
        const fromPage = readInitialFenFromPage();
        if (fromPage && fromPage !== DEFAULT_POSITION && !readStartPos(location.href)) {
            console.log('Mephisto: recovered this game\'s custom start position from the page');
            writeStartPos(location.href, {position: fromPage, timestamp: Date.now()});
        }
        return;
    }
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
    // CENTER-WEIGHTED, not uniform: a human aims for the middle of the square and scatters softly
    // around it, so draw a triangular distribution peaking at the centre (average of two uniforms)
    // instead of spreading clicks flatly across the band. Still bounded to the central `range`
    // (default 80%), so a click can never land on an adjacent square.
    const centered = () => (Math.random() + Math.random()) / 2; // triangular in [0,1], peak at 0.5
    const x = bounds.x + (range * centered() + margin) * bounds.width;
    const y = bounds.y + (range * centered() + margin) * bounds.height;
    const [correctX, correctY] = getOffsetCorrectionXY();
    return [x + correctX, y + correctY];
}

// -------------------------------------------------------------------------------------------

function dispatchSimulateClick(x, y, travelMs = 0) {
    try {
        // goes to the PANEL (it picks CDP vs the python backend), which is in our own realm when the
        // panel is in-page -- runtime.sendMessage would only reach the extension, never our sibling.
        // travelMs is how long the cursor should take travelling to (x, y) before the click (M2).
        return sendToPanel({click: true, x: x, y: y, travelMs});
    } catch (e) {
        // "Extension context invalidated" -- this content-script was orphaned by an extension reload
        // (a fresh one loads on the next page refresh). Swallow it like the other sendMessage sites.
    }
}

function simulateClickSquare(bounds, range = 0.8, travelMs = 0) {
    const [x, y] = getRandomSampledXY(bounds, range);
    return dispatchSimulateClick(x, y, travelMs);
}

function simulateMove(move, deselect, think = null) {
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
        // an explicit per-move think (humanize / clock mode, computed in the popup) overrides the
        // static configured delay
        if (think != null) return think;
        return config.think_time + Math.random() * config.think_variance;
    }

    function getMoveTime() {
        return config.move_time + Math.random() * config.move_variance;
    }

    async function performSimulatedMoveClicks(approachMs, travelMs) {
        // Clear a stale selection (a piece left selected by a prior failed click would be DESELECTED
        // by our from-click, making the move a no-op). `deselect` is an empty square the moving piece
        // can't reach, so clicking it only ever deselects -- never moves anything. ONLY on a RETRY:
        // simulateMoveVerified passes deselect=null on the first attempt (a bare from->to). Retries
        // are rare, so its short lead click sits OUTSIDE the move_time budget on purpose.
        if (/^[a-h][1-8]$/.test(deselect ?? '')) {
            await simulateClickSquare(getBoundsFromCoords(deselect), 0.8, 80);
            await promiseTimeout(40 + Math.random() * 90);
        }
        // Two clicks: piece then target. Both are awaited, and each is a real cursor path -- so the
        // wall-clock IS approachMs + travelMs, spent as motion (M2). The caller splits the total
        // move_time budget between them (default 25% / 75%).
        await simulateClickSquare(getBoundsFromCoords(move.substring(0, 2)), 0.8, approachMs);
        await simulateClickSquare(getBoundsFromCoords(move.substring(2)), 0.8, travelMs);
    }

    // move_time (+ variance) is the TOTAL wall-clock budget for the click sequence -- whatever the
    // user sets is what a move takes. On a normal move: piece (25%) + target (75%). On a promotion:
    // piece (20%) + target (55%) + promo picker (25%). Think time stays a separate slider (that's
    // the pause BEFORE the move; this budget is the physical act of playing it).
    async function performSimulatedMoveSequence() {
        await promiseTimeout(getThinkTime());
        const total = getMoveTime();
        if (move[4]) {
            await performSimulatedMoveClicks(total * 0.20, total * 0.55);
            await simulatePromotionClicks(move[4], total * 0.25);
        } else {
            await performSimulatedMoveClicks(total * 0.25, total * 0.75);
        }
    }

    return performSimulatedMoveSequence();
}

// Autoplay clicks can silently fail (a mis-timed click during a board animation, a click landing
// a hair off after a resize, a promotion race). Play the move, then CONFIRM it registered by
// checking the move list actually grew; if not, retry. The move-count check is safe from
// double-moving: if a move was played (count went up) we treat it as success even if the
// opponent has already replied, so we never re-fire a move into a changed position.
async function simulateMoveVerified(move, deselect, verify, think = null, retries = 2, before = null) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move ?? '')) {
        return simulateMove(move, deselect); // invalid -> simulateMove logs + no-ops
    }
    // Human moves are a bare from->to. The `deselect` lead-click only exists to recover from a stale
    // selection -- which is precisely what makes an attempt FAIL -- so spend it only on a retry, not
    // on every move (see performSimulatedMoveClicks). `before !== null` == we're in the retry
    // recursion, since the first call always enters with the default null.
    const ds = (before !== null) ? deselect : null;
    // A BLIND premove (verify=false) is clicked while it is NOT our turn: the site queues it and it
    // won't appear in the move list until the opponent moves. Verifying/retrying it would re-click
    // and clobber the queued premove -- so only verify real moves played on our own turn. The popup
    // decides this from the position's side-to-move and passes it in (see request_automove). It is a
    // single attempt, so it never gets the deselect lead either.
    if (!verify) return simulateMove(move, ds, think);
    // Capture the move count ONCE, before the FIRST attempt. Re-reading it on each retry breaks the
    // check: chess.com's move list can update later than a fixed wait (board animation), so a move
    // that DID land shows up only after we'd have re-read `before` as the already-grown count -- the
    // retry then replays into a changed board and still reports "failed". Compare against the
    // original count throughout, and POLL for it to grow instead of a single snapshot.
    if (before === null) before = getMoveRecords()?.length ?? 0;
    await simulateMove(move, ds, think);
    for (let waited = 0; waited < 1500; waited += 50) { // poll up to 1.5s for the move to register
        await promiseTimeout(50);
        if ((getMoveRecords()?.length ?? 0) > before) return; // a move was played -> success
    }
    if (retries > 0) {
        console.warn(`Mephisto: move '${move}' did not register, retrying (${retries} left)`);
        // think=0: the "thinking" already happened on the first attempt; a retry is just re-clicking
        return simulateMoveVerified(move, deselect, verify, 0, retries - 1, before);
    }
    console.warn(`Mephisto: move '${move}' failed to register after retries`);
}

// Double premove: click each of our forced moves from->to back-to-back, no verify and no waiting for
// the opponent (a queued premove won't appear in the move list until they move). chess.com renders a
// premoved piece at its destination, so the second click lands on the right square. The popup only
// sends this when the whole 2-ply line is forced, so neither click can misfire.
async function simulatePremoveSequence(moves) {
    for (const move of moves) {
        await simulateMove(move, false);
    }
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
            // fixed 50ms cadence: this used to piggyback on config.fen_refresh back when that was
            // a 10ms poll interval; fen_refresh is now a >=1s fallback poll and would make puzzle
            // replies crawl (highlight checks are two getBoundingClientRect calls -- cheap).
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

async function simulatePromotionClicks(promotion, travelMs = 250) {
    // taketaketake has no DOM picker (canvas app; it auto-queens) -- don't poll, just skip.
    if (site === 'taketaketake') return;
    // The promotion picker renders a frame or two AFTER the to-click lands, and on a slow render it
    // isn't in the DOM when we first look. Checking once (the old behaviour) meant we'd skip the
    // promo click on those, leaving the pawn stuck on the 8th rank with the dialog open -- the
    // intermittent "promotion sometimes fails" on lichess. Poll up to ~1.5s for the picker instead.
    let promotionChoice = getPromotionSelection(promotion);
    for (let waited = 0; !promotionChoice && waited < 1500; waited += 40) {
        await promiseTimeout(40);
        promotionChoice = getPromotionSelection(promotion);
    }
    if (promotionChoice) {
        // the cursor travels to the chosen piece over the caller-supplied budget slice (~25% of the
        // move_time total for a promo move)
        await simulateClickSquare(promotionChoice.getBoundingClientRect(), 0.8, travelMs);
    } else {
        console.warn('Mephisto: promotion picker never appeared; move may need a retry');
    }
}
