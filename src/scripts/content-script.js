let site; // the site that the content-script was loaded on (lichess, chess.com, blitztactics.com)
let config; // configuration pulled from popup
let startPosCache; // cache of non-standard starting positions as puzzle strings (to support chess960)
let moving = false; // whether the content-script is performing a move
let mephistoTabId = null; // this tab's id, so the popup iframe talks to ONLY this tab (see below)
let deferredWhileHidden = false; // an autoplay/premove was held because the tab wasn't focused/visible

// The tab is "active" only when it's the visible tab AND the window has system focus. `hasFocus()`
// stays true when focus is inside our floating-panel iframe (same top-level browsing context), so
// using the panel doesn't count as tabbed-away.
// Background-play tracing. Quiet during normal play -- it only speaks when the tab is NOT active,
// which is exactly the situation that is hard to observe: you cannot watch the console of the tab
// you have tabbed away from while it happens, so the trail has to be there when you come back.
// Background-play tracing. Quiet during normal play -- it only speaks when the tab is NOT active,
// which is exactly the situation that is hard to observe.
//
// It ALSO forwards to the service worker, and that is the point: the page's own console is useless
// here, because opening DevTools on the tab disables the very background throttling being
// investigated. The worker has a SEPARATE console in a separate window, so the game tab stays
// genuinely backgrounded while you read it. Fire-and-forget: tracing must never be able to break the
// thing it is tracing.
function bgLog(...args) {
    // Premove keeps the trace live in the foreground: the move-guard decisions it logs (a dropped
    // move, a superseded premove) are foreground symptoms, and they were invisible exactly when
    // they mattered. Worker console only -- ordinary play still sees nothing.
    if (tabActive() && !(config && config.premove)) return;
    console.log('[Mephisto/bg]', ...args);
    try {
        chrome.runtime.sendMessage({bgTrace: {from: 'content', args: args.map(bgSafe)}}, () => void chrome.runtime.lastError);
    } catch (e) { /* orphaned content-script */ }
}

// Messages are JSON-serialized, so anything unserializable would throw away the whole line.
function bgSafe(v) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
}

function tabActive() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

// When the tab becomes active again after a move was held, re-scrape so the popup re-analyses the
// (still-current) position and re-issues the move -- now that we're allowed to click.
//
// The position has NOT changed while we were away, and both ends dedupe on exactly that: pushPosition
// drops a push whose key matches lastPushKey, and the popup skips analysis when last_eval.fen already
// equals the incoming fen. Two independent "nothing new here" guards, and between them the held move
// was never re-issued -- coming back to the tab just froze. Clear our key and mark the push a resume
// so the popup clears its own.
let resumePush = false; // next push is a resume: both dedupes must be bypassed for it
function resumeIfDeferred() {
    if (deferredWhileHidden && tabActive()) {
        deferredWhileHidden = false;
        resumePush = true;
        lastPushKey = lastDisplayKey = null;
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

// These two keys live in the SITE's localStorage (they are read synchronously while the panel is
// being built, which chrome.storage cannot do), so the site can read them. Named for what they are
// and nothing else -- `mephisto.*` was a one-grep giveaway in the very storage the README promises
// carries no extension keys, which is the same discipline the injected nodes already follow
// ("no id / class / attributes to grep for"). Renaming orphans the old values; the panel falls back
// to its default geometry once and the cache refills on the next scrape.
const LOCAL_CACHE = 'ui.sp.cache';
const DEFAULT_POSITION = 'w*****b-r-a8*****b-n-b8*****b-b-c8*****b-q-d8*****b-k-e8*****b-b-f8*****b-n-g8*****' +
    'b-r-h8*****b-p-a7*****b-p-b7*****b-p-c7*****b-p-d7*****b-p-e7*****b-p-f7*****b-p-g7*****b-p-h7*****' +
    'w-p-a2*****w-p-b2*****w-p-c2*****w-p-d2*****w-p-e2*****w-p-f2*****w-p-g2*****w-p-h2*****w-r-a1*****' +
    'w-n-b1*****w-b-c1*****w-q-d1*****w-k-e1*****w-b-f1*****w-n-g1*****w-r-h1*****';

const MEPHISTO_BUILD = '3.1.204'; // bump on every content-script change; verify in the page console after reload
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
    if (response.hideOpponent !== undefined) {
        applyHideOpponent(response.hideOpponent);
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
            sendToPanel({ dom: res, orient: orient, clocks: scrapeClocks(), fenresponse: true,
                          puzzlePage: isPuzzlePage(), fourPCPage: is4PC() });
        } catch (e) {
            // extension was reloaded — this orphaned content-script can't reach it anymore
        }
        // Turn is shown by the panel's header king-switch (driven off the parsed FEN), not here.
        return;
    }
    if (moving) {
        // Stale latch? Break it here rather than waiting for a timer that may be throttled to a
        // crawl. Only once the budget this move was actually given has elapsed, so a legitimately
        // slow move (a long humanize think) is never cut off.
        if (movingSince && Date.now() - movingSince > movingBudget) {
            console.warn(`Mephisto: clearing a stuck move guard after ` +
                `${Math.round((Date.now() - movingSince) / 1000)}s (budget ${Math.round(movingBudget / 1000)}s)`);
            endMoving();
        } else if (response.automove && response.verify && movingSpeculative) {
            // A BLIND PREMOVE is in flight and a REAL move for the current position has arrived.
            // The premove was a guess about a position the opponent has now decided; this move is
            // the actual answer to what they played. Dropping the real one to protect the guess is
            // backwards, and it is why enabling Premove could stop autoplay entirely: with a chain
            // armed on nearly every move (a certified premove chain), a premove click session was in flight
            // most of the time, so the next real move kept landing on this guard.
            // Superseding is safe: the premove's clicks are already queued at the SITE, and this
            // move carries its own `deselect`, so it starts by clearing any half-made selection.
            bgLog('superseding an in-flight blind premove with the real move', {move: response.move});
        } else {
            if (response.automove) bgLog('DROPPED: a previous move is still in progress (moving=true)');
            return;
        }
    }
    if (response.automove) {
        // Manual Mode moves (response.manual) are triggered by YOUR keypress, so they're allowed even
        // with Autoplay off. Otherwise: never auto-move if Autoplay was turned off since the message.
        // `pv` is the shape a PUZZLE move arrives in -- without it this line read
        // `{move: undefined, premoves: undefined}` for every database move, which is exactly the
        // case most likely to be under investigation when someone is reading this log.
        bgLog('automove received', {move: response.move, pv: response.pv, premoves: response.premoves,
            autoplay: config.autoplay, background_play: config.background_play, moving,
            visible: document.visibilityState, focused: document.hasFocus()});
        if (!config.autoplay && !response.manual) { bgLog('DROPPED: autoplay is off'); return; }
        // undetectability: don't click while the tab is backgrounded/unfocused -- a human wouldn't
        // move while tabbed away, and "moved while hidden" is an easy anomaly to flag. It's still our
        // turn (or a queued premove), so the position is stable: hold the move and re-scrape the
        // instant the tab is active again, which makes the popup re-issue it. Opt out with background_play.
        if (!config.background_play && !tabActive()) {
            bgLog('DEFERRED: tab inactive and Background Play is off');
            deferredWhileHidden = true;
            return;
        }
        // The board must still be the position the panel analysed (see boardStillMatchesAnalysis).
        // If it moved on, throw this move away and re-scrape: the panel re-analyses what is actually
        // there. Never click into a position the move was not computed for.
        // boardStillMatchesAnalysis re-scrapes through the 8x8 path and compares against the
        // analysed FEN. On a 14x14 board that comparison can never succeed, so it dropped every 4PC
        // move after the first. The lane has its own protection: it re-analyses whatever is actually
        // on the board, and a move computed for a stale position simply loses to the next scrape.
        if (!response.fourpc && !boardStillMatchesAnalysis()) {
            bgLog('DROPPED: board no longer matches the analysed position');
            mismatchAborts++;
            console.warn(`Mephisto: board changed since the analysed position -- move dropped, re-scraping (${mismatchAborts} so far)`);
            // BOTH dedupes, not just ours. Clearing lastPushKey lets the re-push leave here, but the
            // popup has its own guard (`last_eval.fen !== fen`) and the position we are re-pushing is
            // very often the SAME one -- so without `resume` the push arrived and was silently
            // swallowed at the far end. That is the whole "it drops the move and then never
            // re-scrapes" failure: the warning above fired, and nothing ever followed it.
            lastPushKey = lastDisplayKey = null;
            resumePush = true;
            pushWhenSettled();
            return;
        }
        // apply the think/move timing the popup read FRESH from storage for this move, so changing the
        // Think/Move Time sliders mid-game takes effect on the very next move (not the game-start snapshot)
        if (response.timing) Object.assign(config, response.timing);
        const gen = beginMoving(response.think, response.verify === false);
        try {
            // Dispatch on the SHAPE OF THE MESSAGE, never on our own copy of the config.
            //
            // This used to branch on `config.puzzle_mode`, but the popup picked the shape it sent
            // from ITS copy of the config and these are two separately-synced snapshots. Whenever
            // they disagreed -- the window around any Puzzle Mode toggle, hotkey or options page,
            // and the panel's config is a snapshot -- the wrong reader ran: `simulatePvMoves`
            // against a message carrying `move`, or `simulateMoveVerified` against one carrying
            // `pv`. Either way the argument was undefined, no click was ever issued, and
            // `.finally(endMoving)` tidied up behind it, so autoplay simply skipped a move with
            // nothing stuck and nothing logged. The sender already decided; read what it sent.
            if (response.fourpc && !is4PCGame()) {
                bgLog('DROPPED: 4PC move outside a game url', {path: location.pathname});
                endMoving();
            } else if (response.fourpc) {
                // FIRST, and on an explicit flag: 4PC must not be reachable by shape inference,
                // which is how Puzzle Mode silently stole these moves into the 8x8 simulator.
                simulateMove4PC(response.move, response.think ?? null).finally(() => endMoving(gen));
            } else if (response.pv) {
                simulatePvMoves(response.pv).finally(() => endMoving(gen));
            } else if (response.premoves) {
                simulatePremoveSequence(response.premoves).finally(() => endMoving(gen));
            } else if (response.move) {
                simulateMoveVerified(response.move, response.deselect, response.verify, response.think ?? null)
                    .finally(() => endMoving(gen));
            } else {
                // No move in a message that claimed to carry one. Nothing to click, so release the
                // guard rather than sitting on it until the watchdog.
                endMoving();
                console.warn('Mephisto: automove with no move to play -- ignored');
            }
        } catch (e) {
            endMoving(); // a sync throw (e.g. board vanished) must not leave `moving` stuck true
            console.warn('Mephisto: automove failed:', e);
        }
    } else if (response.pushConfig) {
        console.log(response.config);
        config = response.config;
        applyHideOpponent(!!config.hide_opponent); // follows the setting on every config push
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
    // ...but a key pressed inside OUR panel never looks like typing from out here: the shadow root is
    // mode:'closed', so the event is retargeted to the host DIV and composedPath() stops there. The
    // test above therefore passed for every keystroke into the panel's own FEN box, and typing a FEN
    // fired a hotkey per character. We hold the closed root, so ask it who actually has focus.
    if (t === overlayHost) {
        const focused = overlayRoot?.activeElement;
        if (focused && (focused.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return;
    }
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
const POPUP_H = 646; // matches popup.css body height (whichever column is taller)
const OVERLAY_SCALE = 0.8; // default render scale for fresh installs; resizing the panel persists a width
const OVERLAY_BOX_KEY = 'ui.pnl.box'; // per-site localStorage: {left, top, width} -- see LOCAL_CACHE

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

// Blur the opponent's name and avatar on the PAGE (opt-in, off by default). Purely cosmetic and
// local -- it changes nothing the site sees. Worth knowing: this is the one feature that
// deliberately adds a <style> to the page, so it is off unless you ask for it.
const HIDE_OPP_ID = 'mephisto-hide-opp';
const HIDE_OPP_SELECTORS = [
    // chess.com
    '.player-component .user-username-component', '.player-tagline .user-username-component',
    '.user-tagline-username', '.player-avatar', '.user-avatar-component',
    // lichess
    '.game__meta .player .user-link', '.ruser a', '.ruser .name', '.game__meta .player .name',
].join(', ');

function applyHideOpponent(on) {
    const existing = document.getElementById(HIDE_OPP_ID);
    if (!on) { existing?.remove(); return; }
    if (existing) return;
    const st = document.createElement('style');
    st.id = HIDE_OPP_ID;
    // blur rather than hide: the layout stays intact, so the page looks normal
    st.textContent = `${HIDE_OPP_SELECTORS} { filter: blur(6px) !important; }`;
    (document.head || document.documentElement).appendChild(st);
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
// running exactly as if it were open (closing with X, which removes the panel, is what STOPS
// everything). opacity:0 + pointer-events:none rather than visibility:hidden/display:none. The
// timer-throttling reason this was originally written for is GONE -- that applied to the N1
// cross-origin iframe, and the panel is a plain div in this document now, which Chrome never
// throttles. What still matters is pointer-events:none: it makes the box click-through so it cannot
// sit over a destination square and eat the autoplay click.
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
    // The brand, then a slot the panel's own status line and engine-health dot get moved into (see
    // below). They used to sit inside the panel body: the status ate a full 26px row at the top of
    // the left column, and the dot floated in the corner with nothing to belong to.
    bar.innerHTML = '<span style="display: flex; align-items: center; gap: 7px; min-width: 0;">' +
        '<span style="flex: none;">Mephisto</span>' +
        '<span class="mephisto-bar-slot" style="display: flex; align-items: center; gap: 6px; ' +
        'min-width: 0; overflow: hidden;"></span>' +
        '</span>' +
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

    // Status line + engine-health dot move into the title bar. They are MOVED, not copied: popup.js
    // finds them by id through PANEL_ROOT (the shadow root), which still contains them, so every
    // existing writer keeps working with no change. The class tells popup.css the left column no
    // longer starts with a status row -- the toolbar popup has no bar, never gets the class, and
    // keeps the status where it is. Sizes are inline because these nodes now sit OUTSIDE the scaled
    // panel body, where popup.css's rules for them no longer apply.
    const barSlot = bar.querySelector('.mephisto-bar-slot');
    const barStatus = panelBody.querySelector('#game-detection');
    const barHealth = panelBody.querySelector('#engine-health');
    if (barSlot && barStatus) {
        barStatus.style.cssText = 'width: auto; font: 11px Roboto, sans-serif; color: #9aa0a6; ' +
            'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;';
        barSlot.appendChild(barStatus);
        panelBody.classList.add('mephisto-bar-host');
    }
    if (barSlot && barHealth) {
        // Only the positioning is dropped. Set property by property, NOT cssText: `background` must
        // stay unset inline or it would beat the #engine-health.ok / .down rules that are the whole
        // point of the dot, and `display` must survive -- refresh_engine_health toggles it, and it
        // starts hidden until the first probe answers.
        for (const [k, v] of [['position', 'static'], ['top', 'auto'], ['right', 'auto'],
                              ['flex', 'none'], ['width', '7px'], ['height', '7px']]) {
            barHealth.style.setProperty(k, v);
        }
        barSlot.appendChild(barHealth);
    }
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
    // FOUR-PLAYER. The 8x8 filter below rejects a move like `m8l8` outright, which is why Help Mode
    // drew nothing at all on a 4PC board -- the arrows were requested, then discarded here. The
    // geometry differs on every axis (14 files, 14 ranks, four rotations), so it gets its own
    // measurements; everything after this point is shared.
    const fourpc = is4PC();
    const SQ4 = '[a-n](?:1[0-4]|[1-9])';
    const moveRe = fourpc ? new RegExp(`^${SQ4}${SQ4}[qrbnQRBN]?$`) : /^[a-h][1-8][a-h][1-8][qrbn]?$/;
    arrows = (arrows || []).filter(a => a && moveRe.test(a.move ?? ''));
    // help mode redraws on every engine update; skip the DOM churn while the arrows are unchanged
    const key = JSON.stringify(arrows);
    if (key === lastHintKey && overlayEl(HINT_OVERLAY_ID)) return;
    clearHintArrow();
    if (!arrows.length) return;

    let bounds, square, squareCenter;
    if (fourpc) {
        const geo = fourPCGeometry();
        if (!geo) return;
        bounds = geo.rect;
        square = geo.size;
        // fourPCSquareXY already handles all four seat rotations and returns VIEWPORT coords; the
        // overlay is positioned at the board's origin, so subtract it back off.
        squareCenter = (sq) => {
            const pt = fourPCSquareXY(sq);
            return pt ? [pt.x - bounds.left, pt.y - bounds.top] : [0, 0];
        };
    } else {
        const board = getBoard();
        if (!board) return;
        bounds = board.getBoundingClientRect();
        const orientation = getOrientation();
        square = bounds.width / 8;
        squareCenter = (coords) => {
            const [xIdx, yIdx] = (orientation === 'white')
                ? [coords.charCodeAt(0) - 'a'.charCodeAt(0), 8 - parseInt(coords[1])]
                : ['h'.charCodeAt(0) - coords.charCodeAt(0), parseInt(coords[1]) - 1];
            return [(xIdx + 0.5) * square, (yIdx + 0.5) * square];
        };
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
        // a 4PC square is 2 OR 3 characters (`a1` .. `n14`), so the split cannot be a fixed offset
        const [from, to] = fourpc
            ? arrow.move.match(new RegExp(`^(${SQ4})(${SQ4})`)).slice(1, 3)
            : [arrow.move.substring(0, 2), arrow.move.substring(2, 4)];
        const [x0, y0] = squareCenter(from);
        const [x1, y1] = squareCenter(to);
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
const EVALHIST_OVERLAY_ID = 'mephisto-evalhist-overlay';

function clearEvalBar() {
    overlayEl(EVALHIST_OVERLAY_ID)?.remove();
    overlayEl(EVALBAR_OVERLAY_ID)?.remove();
}

// frac = white's share of the bar (0..1); text = score magnitude ("1.1" / "M3"); winningWhite
// decides which end the number sits at and its colour. Repositioned every update (like the hint
// arrows) so it tracks the board; pointer-events:none so it never eats a click.
function drawEvalBar({frac, text, winningWhite, history, phases}) {
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

    drawEvalHistory(history, bounds, flipped, phases);
}

// The eval graph: the game so far as a curve, in the shape lichess's computer-analysis graph uses.
// White's advantage rides above the midline, black's below, the area between curve and midline is
// filled, and a cursor marks the move you are on. Sits UNDER the board, full board width -- a curve
// needs a time axis, and the only free axis next to a vertical eval bar is horizontal.
//
// The fill trick: instead of clipping two coloured areas at the midline (which needs the crossing
// points solved), the area is ONE path from the curve to the midline, filled with a gradient whose
// hard stop sits exactly at the midline. Above it the gradient is light, below it dark, so each
// segment is coloured correctly by construction and crossings need no maths at all.
const EVALHIST_H = 96;   // tall enough that a swing is a shape, not a wobble

function drawEvalHistory(history, bounds, flipped, phases) {
    if (!Array.isArray(history) || history.length < 2) {
        overlayEl(EVALHIST_OVERLAY_ID)?.remove();
        return;
    }
    let box = overlayEl(EVALHIST_OVERLAY_ID);
    if (!box) {
        box = document.createElement('div');
        box.id = EVALHIST_OVERLAY_ID;
        box.style.cssText = 'position: absolute; z-index: 2147483646; pointer-events: none; ' +
            'background: #262421; border-radius: 3px; overflow: hidden; ' +
            'box-shadow: 0 1px 3px rgba(0,0,0,0.4);';
        getOverlayRoot().appendChild(box);
    }
    const W = Math.max(1, Math.round(bounds.width));
    box.style.left = `${bounds.left + window.scrollX}px`;
    box.style.top = `${bounds.top + window.scrollY + bounds.height + 8}px`;
    box.style.width = `${W}px`;
    box.style.height = `${EVALHIST_H}px`;

    const H = EVALHIST_H, mid = H / 2, n = history.length;
    const xAt = (i) => (n === 1) ? 0 : (i / (n - 1)) * W;
    // frac is white's share (0..1). White up, black down -- NOT mirrored for a flipped board: this
    // is a graph, and every eval graph puts white on top.
    const pts = history.map((f, i) => {
        // NOT `Number(f) || 0.5`: frac 0 is black completely winning, and 0 is falsy -- that
        // silently redrew a lost position as dead level.
        const v = Number(f);
        const y = (1 - Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))) * H;
        return [xAt(i), y];
    });
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const area = `${line}L${W},${mid}L0,${mid}Z`;

    // Phase dividers, from lichess's own Divider algorithm (ported in the panel). A phase only gets
    // a line and a label when it actually occurred -- a game that never left the opening draws one
    // label and no lines, rather than three labels crammed against the left edge.
    const marks = [];
    const label = (x, text) =>
        `<text x="${(x + 3).toFixed(1)}" y="4" fill="#8a8580" font-size="10" ` +
        `font-family="Roboto, Arial, sans-serif" transform="rotate(90 ${(x + 3).toFixed(1)},4)">` +
        `${text}</text>`;
    marks.push(label(0, 'Opening'));
    for (const [ply, text] of [[phases?.mid, 'Middlegame'], [phases?.end, 'Endgame']]) {
        if (!Number.isInteger(ply) || ply <= 0 || ply >= n) continue;
        const x = xAt(ply);
        marks.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" ` +
                   `stroke="#4d4a46" stroke-width="1"/>`);
        marks.push(label(x, text));
    }

    box.innerHTML =
        `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" ` +
        `xmlns="http://www.w3.org/2000/svg">` +
        // gradientUnits="userSpaceOnUse" is load-bearing, not decoration. The DEFAULT is
        // objectBoundingBox, which maps 0..1 onto the PATH's own bounding box -- and this path only
        // ever spans from the curve to the midline. So the hard stop landed in the middle of whatever
        // band happened to be filled rather than on the midline, painting the lower half of a white
        // advantage solid black. In user space the stop sits at `mid`, which IS the midline, whatever
        // shape the curve takes.
        `<defs><linearGradient id="mp-eh" gradientUnits="userSpaceOnUse" ` +
        `x1="0" y1="0" x2="0" y2="${H}">` +
        `<stop offset="0" stop-color="#e8e6e3"/>` +
        `<stop offset="${(mid / H).toFixed(6)}" stop-color="#e8e6e3"/>` +
        `<stop offset="${(mid / H).toFixed(6)}" stop-color="#0e0d0c"/>` +
        `<stop offset="1" stop-color="#0e0d0c"/>` +
        `</linearGradient></defs>` +
        `<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#8a8580" stroke-width="1"/>` +
        `<path d="${area}" fill="url(#mp-eh)" fill-opacity="0.85"/>` +
        `<path d="${line}" fill="none" stroke="#d64f00" stroke-width="1.5" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>` +
        marks.join('') +
        `<line x1="${pts[n - 1][0].toFixed(1)}" y1="0" ` +
        `x2="${pts[n - 1][0].toFixed(1)}" y2="${H}" stroke="#d64f00" stroke-width="1"/>` +
        `</svg>`;
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

// MISMATCH GUARD. The panel analysed the position we last pushed (lastPushKey); by the time its move
// comes back the board may not be that position any more -- the opponent replied, a takeback landed,
// or the DOM was mid-update when we read it. Clicking then plays a correct answer to a stale board,
// which is indistinguishable from a blunder and is exactly how the torn-read bug presented.
//
// Cheap: one extra scrape per move, of class names we already read. It compares the SAME key the
// push used, so anything that would have produced a different push produces a mismatch here.
// A scrape we cannot take ('no', i.e. mid-animation) counts as a mismatch on purpose -- unverifiable
// is not the same as unchanged, and the cost of waiting is one re-push.
let mismatchAborts = 0; // surfaced in the console; a rising count means the board is outrunning us

function boardStillMatchesAnalysis() {
    if (!lastPushKey) return true; // nothing analysed yet -- nothing to contradict
    const res = tryScrapePosition();
    if (res === 'no') return false;
    return `${getOrientation()}|${res}` === lastPushKey;
}

// Both "board is animating" aborts below are WAITS, and a wait needs a deadline. chessground
// animates in ~200ms, so past this the DOM is stuck, not moving -- a piece left tagged `.anim`
// or parked on a fractional coordinate by an animation that got cut short. Storm/Racer swap the
// whole position between puzzles and hit that constantly. Unbounded, one stuck piece froze the
// panel on a dead position FOREVER: it kept re-issuing the old puzzle's move into a board that
// had moved on, and the half-completed two-click left a piece selected -- the "board gets
// bugged" report. Same reasoning as PUZ_TEAR_RETRIES below: accept a state that PERSISTS rather
// than stall the panel. Degrading is safe -- a stuck piece reads at its rounded-off square.
const ANIM_STALL_MS = 700;
let animStallSince = 0;

function animationStalled() {
    const now = Date.now();
    if (!animStallSince) {
        animStallSince = now; // first refusal: this is a real animation, wait for it
        return false;
    }
    return now - animStallSince > ANIM_STALL_MS;
}

let lastScrapeFail = '';

function tryScrapePosition() {
    try {
        const res = scrapePosition(); // undefined when there is no board
        animStallSince = 0; // scraped clean -- restart the stall clock
        if (!res || res === 'no') {
            let pieces = -1;
            try { pieces = getPieces().length; } catch (e) { /* selector itself failed */ }
            lastScrapeFail = !getBoard() ? 'no board element' : `board but ${pieces} pieces`;
        }
        return res || 'no';
    } catch (e) {
        // the frame matters as much as the message: an unexpected TypeError anywhere in the scrape
        // wedges the panel exactly like the deliberate aborts do, but needs a completely different fix
        lastScrapeFail = String(e && e.message).slice(0, 40)
            + ' @ ' + String((String(e && e.stack).split('\n')[1] || '').trim()).slice(0, 70);
        return 'no'; // skip the current attempt, if we can't scrape
    }
}

function scrapePosition() {
    if (is4PC()) return scrapePosition4PC();   // 14x14 FEN4, not a chess.js position
    if (/\/variants\/4-player/.test(location.pathname)) {
        // 4PC url but is4PC() said no -- that can only be `site`, which is assigned in window.onload
        // and so is undefined in a content script injected into an already-loaded page.
        return fourPCFail(`4-player url but site=${JSON.stringify(site)} -- reload the page`);
    }
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

// "square-54" (chess.com's file-then-rank digit pair, on pieces AND highlight overlays) -> "e4".
// Same conversion the piece loop below does inline; named here because the last-move highlights
// need it too. Returns null for anything that isn't a square class.
function chesscomSquareOf(el) {
    const m = (el?.className || '').match(/square-(\d)(\d)/);
    return m ? String.fromCharCode('a'.charCodeAt(0) + parseInt(m[1]) - 1) + m[2] : null;
}

// Last ACCEPTED chess.com piece-only scrape, for the second torn-read guard in scrapePositionPuz.
// A tear is "the highlight pair moved but the pieces didn't"; these hold what to compare against.
let lastPuzPlacement = '';
let lastPuzHighlight = '';
let puzTearKey = '';
let puzTearCount = 0;
const PUZ_TEAR_RETRIES = 3; // a real tear closes in a frame or two; anything that persists is real

// Are we on a puzzle page? From the URL, because the SCRAPE cannot tell: a lichess puzzle has a
// real move list (.tview2), so it comes through the ordinary `fen***` path exactly like a game --
// only chess.com's puzzles, which ship no move list at all, fall to the `puz***` prefix.
//
// Puzzle Rush / Storm / Racer / Streak are included: they are puzzles, played under a clock.
function isPuzzlePage() {
    const path = location.pathname;
    if (site === 'lichess') return /^\/(training|storm|racer|streak)(\/|$)/.test(path);
    if (site === 'chesscom') return /^\/(puzzles|lessons\/practice)(\/|$)/.test(path);
    if (site === 'blitztactics') return true; // the whole site is puzzles
    return false;
}

function scrapePositionPuz() {
    if (isAnimating() && !animationStalled()) {
        throw Error("Board is animating. Can't scrape.")
    }
    let res = '';
    const occupied = new Set(); // squares holding a piece, for the torn-read guard below
    if (site === 'chesscom') {
        for (const piece of getPieces()) {
            let [colorTypeClass, coordsClass] = [piece.classList[1], piece.classList[2]];
            if (!coordsClass.includes('square')) {
                [colorTypeClass, coordsClass] = [coordsClass, colorTypeClass];
            }
            const [color, type] = colorTypeClass;
            const coordsStr = coordsClass.split('-')[1];
            const coords = String.fromCharCode('a'.charCodeAt(0) + parseInt(coordsStr[0]) - 1) + coordsStr[1];
            occupied.add(coords);
            res += `${color}-${type}-${coords}*****`;
        }
        // A chess.com puzzle ships PIECES ONLY -- there is no move list on the page, so the FEN the
        // popup rebuilds from them carries an empty en-passant field and ep captures simply do not
        // exist for the engine. That silently breaks the pawn endgames these puzzles are full of.
        // The last move IS on the page, as the two highlighted squares: ship it and let the popup
        // decide whether it was a double pawn push. Best-effort -- no highlights (the puzzle's
        // opening position) just means there is no ep right to declare.
        const placement = res; // pieces only, before any lm- suffix -- the torn-read comparison key
        let highlightKey = '';
        try {
            const [from, to] = getLastMoveHighlights().map(chesscomSquareOf);
            if (from && to) {
                highlightKey = `${from}${to}`;
                // SECOND TORN-READ GUARD, and the one that actually catches a QUIET move.
                // getLastMoveHighlights swaps from/to so that `to` is whichever end holds a piece
                // (the DOM order of .highlight is arbitrary, so that swap is how the destination is
                // identified at all). The consequence is that the `occupied.has(from)` test below is
                // structurally unable to fire for a quiet move: in a torn read the only occupied end
                // IS the origin, so the swap renames it `to` and `from` is the empty square. It only
                // ever caught CAPTURES, where the captured piece keeps the destination occupied so no
                // swap happens. A torn quiet move sailed through as a REVERSED last move.
                //
                // What a tear cannot fake: every real move moves a piece. So if the highlight pair
                // changed since the last accepted scrape while the placement did not, the highlight
                // overlay has been updated and the pieces have not -- exactly the gap. Bounded by
                // PUZ_TEAR_RETRIES so a state that PERSISTS is accepted rather than stalling the
                // panel forever (the failure mode the guard below is deliberately shaped to avoid).
                const tearKey = `${placement}|${highlightKey}`;
                if (lastPuzPlacement && placement === lastPuzPlacement && highlightKey !== lastPuzHighlight) {
                    puzTearCount = (puzTearKey === tearKey) ? puzTearCount + 1 : 1;
                    puzTearKey = tearKey;
                    if (puzTearCount <= PUZ_TEAR_RETRIES) {
                        throw Error('Board mid-update (highlight moved but no piece did).');
                    }
                } else {
                    puzTearKey = ''; puzTearCount = 0;
                }
                // TORN-READ GUARD. Pieces come from `.piece.square-NN` classes and the last move from
                // the separate `.highlight` overlays -- two independent bits of DOM that chess.com does
                // not update in one paint. In the gap the highlight can already name the opponent's
                // reply while the moved piece is STILL ON ITS ORIGIN square. That scrape is a position
                // which never existed; it is perfectly legal so nothing downstream rejects it, and the
                // turn getTurn() derives from that same highlight says it is our move -- so the engine
                // analyses a fiction and plays a move for it. That is the "didn't wait for the opponent
                // and then blundered" bug; data-test-animating does not reliably cover the window.
                //
                // ONLY `from` still being occupied proves a tear. Deliberately NOT also requiring `to`
                // to be occupied: chess.com highlights castling by the KING's squares here, but if it
                // ever highlights the rook's, both ends read empty afterwards -- and rejecting on that
                // would reject the settled position too, on every retry and every fallback poll, which
                // stalls the panel on that position permanently. When only `to` looks wrong we simply
                // don't claim a last move (so no ep right) and scrape the position as before.
                if (occupied.has(from)) {
                    throw Error('Board mid-update (piece still on the last move\'s origin square).');
                }
                if (occupied.has(to)) res += `lm-${from}${to}*****`;
            }
        } catch (e) {
            if (/mid-update/.test(e.message)) throw e; // torn read: must NOT be scraped at all
            /* no readable last move -- fall through with pieces only, as before */
        }
        // Only an ACCEPTED read updates the baseline; a rejected one threw above, so the next attempt
        // still compares against the last position we actually believed.
        lastPuzPlacement = placement;
        lastPuzHighlight = highlightKey;
    } else {
        const pieceMap = {pawn: 'p', rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k'};
        const colorMap = {white: 'w', black: 'b'};
        for (const piece of getPieces()) {
            let transform;
            if (piece.classList.contains('dragging')) {
                transform = document.querySelector('.ghost')?.style.transform ?? piece.style.transform;
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
            if ((Math.abs(xyCoords[0] - file) > 0.1 || Math.abs(xyCoords[1] - rank) > 0.1)
                    && !animationStalled()) {
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
// ==================================================================================================
// FOUR-PLAYER CHESS (chess.com /variants/4-player-*)
//
// A 14x14 board with the four 3x3 corners removed, four seats, and positions in FEN4 -- none of
// which chess.js can represent, so this adapter does NOT feed the normal pipeline. It produces a
// FEN4 string straight from the DOM and the panel hands that to Tetrarch untouched.
//
// Everything here was measured against a live rotated game rather than assumed. Two facts carried
// the design:
//   * `data-color` is a COLOUR IDENTITY (0=R 1=B 2=Y 3=G), not a seat position. Verified by
//     comparing an unrotated lobby board against a game where the user sat Green: the pieces moved
//     around the screen, the ids stayed with their colours.
//   * the board ROTATES so your seat is at the bottom, and chess.com re-renders its coordinate
//     labels when it does. So orientation is READ from those labels, never inferred -- which is why
//     this works for any seat without a special case.
// ==================================================================================================

const FOURPC_SEATS = ['R', 'B', 'Y', 'G'];              // FEN4's array order, and data-color's
const FOURPC_FILES = 'abcdefghijklmn'.split('');
// each seat's back row: the 8 squares between (and including) its two rook corners. Setup-independent
// -- classic/modern/by/byg/rg only move the king between index 7 and 8 (RULES.md 3.3, 6.1).
const FOURPC_BACK = {R: ['rank', 1], B: ['file', 'a'], Y: ['rank', 14], G: ['file', 'n']};
let fourPCPrev = null;   // previous board, for the en-passant diff
let fourPCTurn = null;   // last KNOWN side to move; sticky across scrapes that saw no move

// Commissioning diagnostic for the four-player lane. bgLog is silent while the tab is focused unless
// Premove is on, and a 4PC bring-up failure is exactly the thing you are staring at when it happens --
// so this reports to the PAGE console instead, once per distinct reason.
const fourPCSeen = new Set();
function fourPCFail(reason) {
    lastScrapeFail = '4PC: ' + reason;
    if (fourPCSeen.has(reason)) return undefined;
    fourPCSeen.add(reason);
    console.warn(`Mephisto 4PC: ${reason}`);
    return undefined;
}

function is4PC() {
    return site === 'chesscom' && /\/variants\/4-player/.test(location.pathname);
}

// ...but CLICKING is gated harder: only inside a real game, never on the lobby's preview board or a
// setup page. Those render a full, perfectly scrapeable position, and autoplay would happily start
// clicking pieces around a board that is not a game. The setup slug varies (4-player-chess,
// 4-player-classic, ...) while the game path does not: /variants/<slug>/game/<id>.
function is4PCGame() {
    return site === 'chesscom' && /^\/variants\/4-player[\w-]*\/game\/\d+/.test(location.pathname);
}

// The board's own coordinate labels -> which screen axis carries ranks, and what sits at each index.
// viewBox is "0 0 14 14", so one SVG unit is one square and Math.floor(x) is the column.
function fourPCGeometry() {
    const svg = [...document.querySelectorAll('svg')]
        .find(e => /Coordinates/.test(String(e.getAttribute('class') || '')));
    if (!svg) return fourPCFail('no Coordinates svg on the page') || null;
    const labels = [...svg.querySelectorAll('text')].map(t => ({
        v: (t.textContent || '').trim(), x: parseFloat(t.getAttribute('x')), y: parseFloat(t.getAttribute('y')),
    })).filter(t => isFinite(t.x) && isFinite(t.y));
    const digits = labels.filter(t => /^\d+$/.test(t.v));
    const letters = labels.filter(t => /^[a-n]$/.test(t.v));
    if (digits.length !== 14 || letters.length !== 14) {
        return fourPCFail(`coordinate labels: ${digits.length} digits, ${letters.length} letters (want 14/14)`) || null;
    }
    // ranks vary along whichever axis has 14 distinct values; files take the other
    const spread = (a, k) => new Set(a.map(t => Math.floor(t[k]))).size;
    const rankAxis = spread(digits, 'x') > spread(digits, 'y') ? 'x' : 'y';
    const fileAxis = rankAxis === 'x' ? 'y' : 'x';
    const rankAt = {}, fileAt = {};
    for (const t of digits) rankAt[Math.floor(t[rankAxis])] = parseInt(t.v, 10);
    for (const t of letters) fileAt[Math.floor(t[fileAxis])] = t.v;
    const host = document.querySelector('.TheBoard-squares') || svg.parentElement;
    const rect = host.getBoundingClientRect();
    return {rankAxis, fileAxis, rankAt, fileAt, size: rect.width / 14, rect};
}

// piece elements -> {square: {seat, type}}. Corners carry data-invisible and are skipped; FEN4
// writes them as ordinary empty squares anyway (RULES.md 11.2).
function fourPCBoard(geo) {
    const board = {};
    for (const p of document.querySelectorAll('.piece')) {
        if (p.hasAttribute('data-invisible')) continue;
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(p.getAttribute('style') || '');
        if (!m) continue;
        const col = Math.round(parseFloat(m[1]) / geo.size), row = Math.round(parseFloat(m[2]) / geo.size);
        const file = geo.fileAt[geo.fileAxis === 'x' ? col : row];
        const rank = geo.rankAt[geo.rankAxis === 'x' ? col : row];
        const type = p.getAttribute('data-piece'), seat = FOURPC_SEATS[+p.getAttribute('data-color')];
        if (!file || !rank || !type || !seat) continue;
        board[file + rank] = {seat, type};
    }
    return board;
}

const fourPCSquare = (seat, i) =>
    FOURPC_BACK[seat][0] === 'rank' ? FOURPC_FILES[i - 1] + FOURPC_BACK[seat][1] : FOURPC_BACK[seat][1] + i;

// Castling rights, DERIVED (RULES.md 6.1 -- "squares are derived, never tabulated"). The king starts
// at index 7 or 8 of its back row with rooks at 4 and 11; the SHORT side is the end it starts nearer.
// A king that has left its home square loses both, which is the conservative direction: the cost of
// a missed castle is one ordinary move, the cost of an invented one is an illegal move.
function fourPCCastling(board) {
    const short = [], long = [];
    for (const seat of FOURPC_SEATS) {
        let kingIdx = null;
        for (const i of [7, 8]) {
            const p = board[fourPCSquare(seat, i)];
            if (p && p.seat === seat && p.type === 'K') kingIdx = i;
        }
        if (kingIdx === null) { short.push(0); long.push(0); continue; }
        const rookAt = (i) => {
            const p = board[fourPCSquare(seat, i)];
            return (p && p.seat === seat && p.type === 'R') ? 1 : 0;
        };
        short.push(rookAt(kingIdx === 8 ? 11 : 4));
        long.push(rookAt(kingIdx === 8 ? 4 : 11));
    }
    return {short, long};
}

// En passant, from the diff against the previous scrape. FEN4 stores BOTH squares as `M:T` -- the
// square the pusher skipped and the square the pawn now stands on -- because fairy pawns can move
// diagonally and one square would be ambiguous (RULES.md 5.2). SAN alone cannot give us this: the
// move list writes a bare destination for pawns, so a single push onto the double-push rank looks
// identical to a double push. The diff knows the origin, so it is exact.
// The single move between two scrapes: the square that emptied and the one that gained a piece.
// Returns null for anything that is not one quiet move (a capture leaves `lost` empty, castling
// moves two pieces), which is exactly when the callers should fall back.
function fourPCDiff(board, prev) {
    if (!prev) return null;
    const same = (a, b) => (!a && !b) || (a && b && a.seat === b.seat && a.type === b.type);
    // ARRIVED means "the occupant CHANGED", not "the square was empty and now is not". A capture
    // leaves its destination occupied before AND after, so the old test never saw one -- and since
    // captures are most of a middlegame, the turn fell back to the broken move-count almost every
    // ply. Vacated is squares that emptied.
    const arrived = [], vacated = [];
    for (const sq of new Set([...Object.keys(board), ...Object.keys(prev)])) {
        if (same(board[sq], prev[sq])) continue;
        if (board[sq]) arrived.push(sq); else vacated.push(sq);
    }
    if (!arrived.length || !vacated.length) return null;
    // Castling moves two pieces; the king is the one that identifies the mover, and its seat is the
    // same either way, so prefer it and fall back to whatever arrived.
    const to = arrived.find(sq => board[sq].type === 'K') || arrived[0];
    const moved = board[to];
    // the origin must have held the SAME piece -- otherwise a promotion or a shuffle picks the wrong one
    const from = vacated.find(sq => prev[sq] && prev[sq].seat === moved.seat && prev[sq].type === moved.type)
              || vacated.find(sq => prev[sq] && prev[sq].seat === moved.seat)
              || vacated[0];
    return {from, to, moved, arrived: arrived.length, vacated: vacated.length};
}

function fourPCEnPassant(board, prev) {
    const ep = ['', '', '', ''];
    const d = fourPCDiff(board, prev);
    if (!d) return ep;
    // a double push is one piece moving to an empty square: anything else (capture, castle) is not
    // an en-passant opportunity even when the geometry happens to look like one
    if (d.arrived !== 1 || d.vacated !== 1) return ep;
    const to = d.to, from = d.from, moved = d.moved;
    if (!moved || moved.type !== 'P') return ep;
    const f = (sq) => sq.replace(/\d+$/, ''), r = (sq) => parseInt(sq.match(/\d+$/)[0], 10);
    const df = FOURPC_FILES.indexOf(f(to)) - FOURPC_FILES.indexOf(f(from)), dr = r(to) - r(from);
    if (Math.abs(df) + Math.abs(dr) !== 2) return ep;          // not a two-square push
    const mid = (df !== 0)
        ? FOURPC_FILES[FOURPC_FILES.indexOf(f(from)) + df / 2] + r(from)
        : f(from) + (r(from) + dr / 2);
    ep[FOURPC_SEATS.indexOf(moved.seat)] = `${mid}:${to}`;
    return ep;
}

// The whole position as a canonical FEN4 -- the spelling Tetrarch itself writes, so a round trip is
// byte-identical. Field order is turn-dead-castleK-castleQ-points-halfmove[-{extra}]-board, board
// LAST (RULES.md 11.1), rank 14 first, empty runs as counts.
function scrapePosition4PC() {
    const geo = fourPCGeometry();
    if (!geo) return;                             // fourPCGeometry already said why
    const board = fourPCBoard(geo);
    if (Object.keys(board).length < 4) {
        return fourPCFail(`only ${Object.keys(board).length} pieces mapped to squares`);
    }
    // WHOSE TURN. `moveCount % 4` was wrong: it assumes every round has exactly four cells, which
    // stops being true the moment a seat is eliminated or skipped -- and the counts already do not
    // reconcile (24 cells against rows of 4,4,4,4,4,1). So ask the BOARD instead: the piece that
    // appeared since the last scrape names the seat that just moved, and the turn is the next seat
    // still holding a king. Falls back to the modulo only on the first scrape, where there is no
    // previous position to diff and nothing better is available.
    const alive = (seat) => Object.values(board).some(p => p.seat === seat && p.type === 'K');
    const d = fourPCDiff(board, fourPCPrev);
    // THE MOVE LIST IS THE AUTHORITY, ON EVERY SCRAPE. It used to seed the turn on the first scrape
    // only, after which the value was advanced by the board diff and otherwise kept as-is -- so a
    // single diff the board could not explain (a capture, a castle, two moves landing between polls,
    // the panel opening mid-move) left the turn one seat behind FOREVER, with nothing able to correct
    // it. That is the "it does not realise it is my turn" case, and why it looked intermittent: a
    // stale turn is only visible when it happens to be yours.
    //
    // chess.com renders all four seat cells for the current round and leaves the unplayed ones empty,
    // so only non-empty cells count as moves.
    const played = [...document.querySelectorAll('.moves-table-cell.moves-move')]
        .filter(c => c.textContent.trim()).length;
    let turn = FOURPC_SEATS[played % 4];
    // The board and the move table do not repaint in the same frame. When the board has already moved
    // and the table has not caught up, the diff is the fresher of the two -- but it only ever nudges
    // the count-derived answer forward by one seat, it can no longer replace it.
    if (d && d.moved && FOURPC_SEATS[played % 4] === d.moved.seat) {
        let i = FOURPC_SEATS.indexOf(d.moved.seat);
        for (let n = 0; n < 4; n++) { i = (i + 1) % 4; if (alive(FOURPC_SEATS[i])) break; }
        turn = FOURPC_SEATS[i];
    }
    // ponytail: an eliminated seat stops taking turns, which `played % 4` cannot know about, so skip
    // forward off a dead seat. Untested -- no game has been observed past an elimination yet.
    for (let n = 0; n < 4 && !alive(turn); n++) turn = FOURPC_SEATS[(FOURPC_SEATS.indexOf(turn) + 1) % 4];
    if (turn !== fourPCTurn) bgLog('4PC turn', {turn, played, diff: d && d.moved && d.moved.seat});
    fourPCTurn = turn;
    // `dead` is no longer hardcoded either -- a seat with no king is out, and in Teams that changes
    // the evaluation substantially.
    const dead = FOURPC_SEATS.map(seat => alive(seat) ? 0 : 1);
    const {short, long} = fourPCCastling(board);
    const ep = fourPCEnPassant(board, fourPCPrev);
    fourPCPrev = board;
    const ranks = [];
    for (let r = 14; r >= 1; r--) {
        const out = []; let run = 0;
        for (const f of FOURPC_FILES) {
            const p = board[f + r];
            if (p) { if (run) { out.push(String(run)); run = 0; } out.push(p.seat.toLowerCase() + p.type); }
            else run++;
        }
        if (run) out.push(String(run));
        ranks.push(out.join(','));
    }
    // the extra block is omitted entirely when empty -- never written as {} (RULES.md 11.1)
    const extra = ep.some(Boolean) ? `-{'enPassant':(${ep.map(e => `'${e}'`).join(',')})}` : '';
    return `4PC:${fourPCOurSeat() || '?'}:${turn}-${dead.join(',')}-${short.join(',')}-${long.join(',')}-0,0,0,0-0${extra}-${ranks.join('/')}`;
}

// square -> viewport point, for clicking a move the engine returned. Same coordinate map in reverse,
// so a rotated board needs no special case.
function fourPCSquareXY(sq) {
    const geo = fourPCGeometry();
    if (!geo) return null;
    const file = sq.replace(/\d+$/, ''), rank = parseInt(sq.match(/\d+$/)[0], 10);
    const colOf = (map, want) => Object.keys(map).find(k => String(map[k]) === String(want));
    const rIdx = colOf(geo.rankAt, rank), fIdx = colOf(geo.fileAt, file);
    if (rIdx == null || fIdx == null) return null;
    const col = geo.rankAxis === 'x' ? +rIdx : +fIdx;
    const row = geo.rankAxis === 'x' ? +fIdx : +rIdx;
    return {x: geo.rect.left + (col + 0.5) * geo.size, y: geo.rect.top + (row + 0.5) * geo.size};
}


// Which seat is OURS. chess.com always seats you at the bottom, but you can be any colour, so this
// asks the coordinate map which back row lies along the bottom edge rather than trusting a position.
function fourPCOurSeat() {
    const geo = fourPCGeometry();
    if (!geo) return null;
    const bottom = 13;   // screen row 13 is the last rank of the board as drawn
    if (geo.fileAxis === 'y') {
        const f = geo.fileAt[bottom];
        if (f === 'n') return 'G';
        if (f === 'a') return 'B';
    } else {
        const r = geo.rankAt[bottom];
        if (r === 1) return 'R';
        if (r === 14) return 'Y';
    }
    return null;
}

// Play a 4PC move. simulateMove is 8x8 to its bones -- an [a-h][1-8] regex and boardBounds/8 -- so
// this is a separate path rather than a parameterisation of it. Only the square->rect step differs;
// the clicking itself is the same primitive, so cursor travel and the move-time budget behave
// exactly as they do everywhere else.
function simulateMove4PC(move, think = null) {
    const SQ = '[a-n](?:1[0-4]|[1-9])';
    const m = new RegExp(`^(${SQ})(${SQ})([qrbnQRBN]?)$`).exec(move ?? '');
    if (!m) {
        console.warn(`Mephisto: refusing to play invalid 4PC move '${move}'`);
        return Promise.resolve();
    }
    // Measured fresh for EACH click, never once up front. The first click of a game is what raises
    // Chrome's debugger infobar, and that shrinks the viewport out from under a board chess.com sizes
    // to it -- so a destination measured before that click points at where the square USED to be, and
    // the move dies half-played. The two-player path already measures per click (getBoundsFromCoords
    // below); this one did not, which is the whole bug.
    const rectOf = (sq) => {
        const geo = fourPCGeometry();
        const pt = geo && fourPCSquareXY(sq);
        return pt ? new DOMRect(pt.x - geo.size / 2, pt.y - geo.size / 2, geo.size, geo.size) : null;
    };
    if (!rectOf(m[1]) || !rectOf(m[2])) {
        console.warn(`Mephisto: 4PC move '${move}' has no on-screen square`);
        return Promise.resolve();
    }
    return (async () => {
        await warmClicker();
        await promiseTimeout(think != null ? think : config.think_time + Math.random() * config.think_variance);
        const total = config.move_time + Math.random() * config.move_variance;
        const click = async (sq, travel) => {
            const r = rectOf(sq);
            if (!r) { console.warn(`Mephisto: 4PC square '${sq}' vanished mid-move`); return; }
            bgLog('4PC click', {sq, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                                size: Math.round(r.width), vh: window.innerHeight});
            await simulateClickSquare(r, 0.8, travel);
        };
        await click(m[1], total * 0.25);
        await click(m[2], total * 0.75);
        if (m[3]) {
            // Promotion. 4PC's picker has not been read yet, so the move is played and the picker is
            // left to the user rather than clicking blind at a guessed offset.
            console.warn(`Mephisto: 4PC promotion to '${m[3]}' -- pick the piece manually (picker not wired yet)`);
        }
    })();
}

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
// When `moving` began and how long it was allowed. The watchdog below is a setTimeout, and in a
// BACKGROUND tab that is not a reliable escape: if the keep-alive tone lapses, Chrome's intensive
// throttling pushes timers out to roughly one a minute, so a 15s watchdog may not fire for far
// longer. Meanwhile `moving` blocks EVERY message in handle(), so one move that fails to resolve
// silently latches the extension off -- which is exactly what "works, then randomly stops, and stays
// stopped" looks like. These let the next automove notice the latch is stale and break it itself,
// without depending on a timer that may not be running.
let movingSince = 0;
let movingBudget = 0;
let movingSpeculative = false; // the in-flight session is a blind premove, not a real move
let moveGen = 0;               // identifies a session, so a superseded one can't clear its successor

function beginMoving(thinkMs = 0, speculative = false) {
    moving = true;
    // A BLIND PREMOVE is speculative: it is queued at the site during the OPPONENT'S turn, for a
    // move they may never make. A real on-turn move is not. The panel already tells them apart --
    // it sends verify=false for exactly the blind case (popup.js request_automove) -- and the
    // difference matters here because a speculative session must never outrank a real move.
    movingSpeculative = !!speculative;
    movingSince = Date.now();
    movingBudget = (Number(thinkMs) || 0) + 15000;
    // Safety net: while `moving` is true the content-script ignores ALL scrape requests, so a move
    // simulation that never resolves (a hung click / promotion) would freeze the extension ("gets
    // stuck and doesn't play anything"). The grace sits ON TOP of this move's think, which is
    // user-configurable and uncapped: a flat timeout would expire mid-think on a legitimately slow
    // move and drop the `moving` guard -- and that guard is what stops a second automove starting
    // on top of the one still waiting to click.
    clearTimeout(movingWatchdog);
    const gen = ++moveGen;
    movingWatchdog = setTimeout(() => endMoving(gen), movingBudget);
    return gen;
}

function endMoving(gen) {
    // A superseded session finishing late must not clear the guard belonging to the move that
    // replaced it -- otherwise the winner's own clicks run unprotected and the next scrape lands
    // mid-move. Sessions started before the current one simply do nothing here.
    if (gen !== undefined && gen !== moveGen) return;
    clearTimeout(movingWatchdog);
    moving = false;
    movingSpeculative = false;
    movingSince = 0;
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
// Re-push once the board has stopped moving.
//
// schedulePush's 30ms debounce is far shorter than a piece animation (~200ms on lichess), so a
// re-push fired from the mismatch guard lands mid-flight, reads a half-moved board, and mismatches
// again -- a loop that gets TIGHTER the faster we answer. That is why it shows up now: a move from
// the puzzle database is issued in the same tick as the position that produced it, with no search in
// between to let the board settle, so the guard meets an animation every time instead of rarely.
//
// An animating board is not a changed board, it is a board mid-repaint. Bounded, so a site that
// animates forever (or a stuck class) still gets its push rather than nothing at all.
function pushWhenSettled(tries = 12) {
    // Never wait in a HIDDEN tab. Chrome throttles timers there to about one a second, and to one a
    // MINUTE after five minutes hidden -- so this retry chain, which costs 480ms in a visible tab,
    // costs up to twelve minutes in a backgrounded one. That is the opposite of what Background Play
    // is for. There is nothing to wait for anyway: the settle-wait exists to dodge a piece animation
    // that a hidden tab is not painting, and pushPosition already retries a scrape that comes back
    // transient.
    let moving = false;
    try { moving = !document.hidden && isAnimating(); } catch (e) { /* no board -- nothing to wait for */ }
    if (!moving || tries <= 0) { schedulePush(); return; }
    setTimeout(() => pushWhenSettled(tries - 1), 40);
}

function schedulePush() {
    if (pushDebounce) return;
    pushDebounce = setTimeout(() => {
        pushDebounce = null;
        pushPosition();
    }, 30);
}

// A rejected scrape ('no') used to just give up until the NEXT board mutation or the 1s fallback
// poll. But 'no' overwhelmingly means "mid-animation", and a chess.com piece animation runs ~200ms
// -- longer than the 30ms debounce -- so the settling scrape landed inside it, was dropped, and the
// panel then sat on a stale position for up to a FULL SECOND waiting for the fallback poll. That is
// the real source of the lag, not the debounce. Retry quickly a bounded number of times instead.
const NO_SCRAPE_RETRY_MS = 40;
const NO_SCRAPE_MAX_RETRIES = 10; // 10 x 40ms = 400ms, then let the fallback poll take over
let noScrapeRetries = 0;

function pushPosition() {
    if (!config) return;           // no config yet -> can't scrape
    const res = tryScrapePosition();
    if (res === 'no') {            // transient (animating, no board): never push, never dedupe
        bgLog('scrape returned nothing', {why: lastScrapeFail, retry: noScrapeRetries,
            giveUp: noScrapeRetries >= NO_SCRAPE_MAX_RETRIES, build: MEPHISTO_BUILD});
        if (noScrapeRetries < NO_SCRAPE_MAX_RETRIES) {
            noScrapeRetries++;
            // reuse pushDebounce so a mutation arriving mid-retry doesn't schedule a second chain
            pushDebounce = setTimeout(() => { pushDebounce = null; pushPosition(); }, NO_SCRAPE_RETRY_MS);
        }
        return;
    }
    if (noScrapeRetries) bgLog('scrape recovered', {afterRetries: noScrapeRetries});
    noScrapeRetries = 0;
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
        const resume = resumePush;
        resumePush = false; // one-shot: only the push that follows the tab regaining focus
        sendToPanel({ dom: res, orient: orient, clocks: scrapeClocks(), fenresponse: true, resume });
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
    // Every known selector came up empty -> read the moves off the re-anchored container instead
    // (a renamed tag inside an otherwise-intact move list lands here rather than above).
    //
    // ...but ONLY when the move list itself is missing. "No moves" and "our selector is broken" are
    // different states and this used to conflate them: an EMPTY move list is completely normal -- a
    // fresh analysis board, move 0 of a game, a puzzle -- and treating it as a broken selector sent
    // the structural scan hunting for anything that looks like moves. On a lichess analysis board it
    // duly found the ENGINE'S PRINCIPAL VARIATION (div.pv, ten SAN spans) and the panel replayed
    // lichess's suggested line as if it had been played, analysing a position from a game that never
    // happened. If the container is there and holds nothing, nothing is what it means.
    if (!moves?.length && !knownMoveContainer() && (site === 'lichess' || site === 'chesscom')) {
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
// Containers that hold ENGINE OUTPUT rather than played moves. Excluded from the structural scan.
const ENGINE_LINE_SEL = '.pv, .ceval, .analyse__ceval, .engine, [class*="pv-"]';
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
        // An engine's suggested line is made of SAN too, and there is nothing about its SHAPE that
        // says it is not a game -- so the shape-based scan cannot tell them apart and has to be told.
        // These are lines the site is PROPOSING, not moves anybody played; adopting one makes the
        // panel analyse a game that does not exist. (lichess: div.pv / span.pv-san under .ceval.)
        if (el.closest(ENGINE_LINE_SEL)) continue;
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

// The site's own selectors, with NO structural fallback -- "is there a move list on this page at
// all", asked separately from "what is in it". getMoveContainer adds the fallback on top.
function knownMoveContainer() {
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
    return moveContainer;
}

function getMoveContainer() {
    // nothing matched on a site that should have a move list -> try the structural re-anchor before
    // letting scrapePosition fall through to the puzzle path and quietly drop the move history
    const known = knownMoveContainer();
    if (known) return known;
    if (site === 'lichess' || site === 'chesscom') return recoverMoveContainer();
    return undefined;
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
    // Every read below can come up empty, and NONE of them used to be guarded: `.find` returns
    // undefined when no piece sits on the last-move destination, which happens whenever the
    // highlight overlay and the pieces disagree -- constantly on Storm/Racer, where the whole
    // position is swapped between puzzles. The deref threw out of getTurn, out of the scrape, and
    // tryScrapePosition turned it into a permanent 'no': the panel froze on the dead position and
    // spent the rest of the run re-issuing its move into a board that had moved on. There is
    // already a considered fallback for "the board won't tell us the turn" -- it just sat in a
    // catch that only covered the first line. Route every failure into it.
    function turnFromContext() {
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

    // Storm and Racer never need the guess. Every position the site renders is YOURS to move --
    // it plays the opponent's reply itself and never stops on it -- and the board is always
    // oriented with the player at the bottom. Reading the turn off the last-move highlight infers
    // it from which colour landed on the destination square, which is wrong whenever the overlay
    // and the pieces disagree, and they disagree constantly here because the whole position is
    // swapped between puzzles. Orientation is stated by the site, so use it. /training is NOT
    // included: it renders the opponent's reply as a real position, so there the turn genuinely
    // alternates and the highlight read is still the right instrument.
    if (site === 'lichess' && /^\/(storm|racer)(\/|$)/.test(location.pathname)) {
        return (getOrientation() === 'black') ? 'b' : 'w';
    }

    let toSquare;
    try {
        toSquare = getLastMoveHighlights()[1];
    } catch (e) {
        return turnFromContext(); // no last-move highlight to read the turn from
    }

    let turn;
    if (site === 'chesscom') {
        const hlPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        const hlColorType = hlPiece && Array.from(hlPiece.classList).find(c => c.match(/[wb][prnbkq]/));
        turn = hlColorType ? ((hlColorType[0] === 'w') ? 'b' : 'w') : null;
    } else if (site === 'lichess' || site === 'blitztactics') {
        const scope = (site === 'lichess') ? '.main-board piece' : '.board-area piece';
        const toPiece = Array.from(document.querySelectorAll(scope))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = toPiece ? (toPiece.classList.contains('white') ? 'b' : 'w') : null;
    }
    return turn || turnFromContext();
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

// Resolves with the time that ACTUALLY passed, not the time that was asked for. Those are the same
// number in a foreground tab and wildly different in a background one: Chrome clamps timers in a
// hidden tab to one per second, so `promiseTimeout(50)` really takes 1000ms. Callers that summed the
// requested delay to build a deadline were therefore out by 20x -- a "10 second" wait became 200 real
// seconds, long enough for the move watchdog (which does use real time) to tear the move down
// underneath them. That is why background play worked with DevTools open and not with it closed:
// DevTools disables the clamp, so the lie was true exactly while anyone was watching.
function promiseTimeout(time) {
    const started = Date.now();
    return new Promise((resolve) => {
        setTimeout(() => resolve(Date.now() - started), time);
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

// Ask the panel to attach the debugger now. The FIRST click of a session is what raises Chrome's
// infobar, which shrinks the viewport and re-lays-out the board -- so the click that triggers it, and
// anything measured just before it, aims at stale geometry. Doing it up front, ahead of the think
// delay, means the bar is already up and settled by the time a single square is measured. No-op on
// every later move.
function warmClicker() {
    try { return Promise.resolve(sendToPanel({warm: true})).catch(() => {}); }
    catch (e) { return Promise.resolve(); }   // orphaned content-script
}

function dispatchSimulateClick(x, y, travelMs = 0) {
    try {
        // NO CURSOR TRAVEL IN A HIDDEN TAB, for two independent reasons.
        //
        // Practical: each step of the travel is its own awaited round-trip into the service worker,
        // and the background trace showed those costing seconds rather than milliseconds once the tab
        // is hidden -- 8 steps (travelMs 131) timed out at 3s while 3 steps (travelMs 44) returned in
        // 77ms. The move sequence awaits every one of them, and that is what wedges `moving` and
        // stops background play.
        //
        // And it is the more faithful behaviour anyway: the travel exists so a click looks like a
        // human reached for the square (audit M2). But a human who has tabbed away is not moving
        // their cursor over this board AT ALL -- synthesising a cursor path across a board nobody is
        // looking at is the anomaly, not the fix for one.
        if (document.hidden) travelMs = 0;
        // goes to the PANEL (it picks CDP vs the python backend), which is in our own realm when the
        // panel is in-page -- runtime.sendMessage would only reach the extension, never our sibling.
        // travelMs is how long the cursor should take travelling to (x, y) before the click (M2).
        bgLog('dispatching click', {x: Math.round(x), y: Math.round(y), travelMs});
        // A click that is dispatched but never returns, and one that returns and changes nothing, are
        // different failures; the log could not tell them apart.
        const clickStarted = Date.now();
        return Promise.resolve(sendToPanel({click: true, x: x, y: y, travelMs}))
            .then((r) => { bgLog('click returned', {ms: Date.now() - clickStarted, r}); return r; })
            .catch((e) => { bgLog('click FAILED', {ms: Date.now() - clickStarted, e: String(e)}); throw e; });
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
        await warmClicker();
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
    // Real elapsed time, not a count of intended steps -- see promiseTimeout. Under a background
    // tab's 1s timer clamp the step-counting version polled for 30 real seconds, not 1.5.
    for (const deadline = Date.now() + 1500; Date.now() < deadline; ) { // poll up to 1.5s
        await promiseTimeout(50);
        if ((getMoveRecords()?.length ?? 0) > before) return; // a move was played -> success
    }
    if (retries > 0) {
        console.warn(`Mephisto: move '${move}' did not register, retrying (${retries} left)`);
        // think=0: the "thinking" already happened on the first attempt; a retry is just re-clicking
        return simulateMoveVerified(move, deselect, verify, 0, retries - 1, before);
    }
    console.warn(`Mephisto: move '${move}' failed to register after retries`);
    // Giving up used to be a DEAD END. The board is unchanged, so the next scrape produces the same
    // key as the last push -- lastPushKey swallows it here, and even if it got through, the popup's
    // own `last_eval.fen !== fen` guard swallows it there. Nothing re-analysed and nothing re-tried:
    // the panel simply sat on a position it had already answered, with the answer unplayed. Clear
    // both dedupes the way the mismatch abort does, so the position is pushed again as a resume.
    lastPushKey = lastDisplayKey = null;
    resumePush = true;
    schedulePush();
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
    for (const deadline = Date.now() + 1500; !promotionChoice && Date.now() < deadline; ) {
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
