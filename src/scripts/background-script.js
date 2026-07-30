chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if ((msg.from === 'content') && (msg.subject === 'showPageAction')) {
    chrome.pageAction.show(sender.tab.id);
  }
  // the content-script asks for its own tab id so its panel talks to ONLY this tab (not whatever
  // tab is active) -- otherwise a background tab's panel would drive the foreground tab. It also
  // keys that tab's offscreen engine (clientId == tabId), so each game tab gets its own instance.
  if (msg.getTabId) {
    sendResponse({tabId: sender.tab?.id});
  }
  // A panel is about to init its engine -- make sure the offscreen host exists first (it may not,
  // if the SW just spun up). Reply when ready so the popup only sends 'init' to a live listener.
  if (msg.ensureOffscreen) {
    ensureOffscreen().then(() => sendResponse({ok: true}));
    return true; // async sendResponse
  }
  // The in-page panel asks US for its markup/CSS/pieces. Fetching them HERE (extension context) and
  // shipping the bytes means the page never sees a chrome-extension:// URL -- no <link>/<img> to read
  // and, crucially, nothing recognizable in the page's Resource Timing (issue #35 §3.4).
  if (msg.getPanelAssets) {
    buildPanelAssets().then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true;
  }
  // Opening-explorer lookup. Deliberately done HERE, in the service worker, and never in the panel:
  // the panel runs in the PAGE's isolated world, so a fetch from there is issued by the page's
  // renderer with the page's origin -- lichess/chess.com would see a request to the explorer
  // correlated with your game, exactly the footprint the toolbar-popup mode exists to avoid. From
  // the SW it is the extension's own request and the page makes none.
  if (msg.explorerLookup) {
    explorerLookup(msg.explorerLookup).then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  if (msg.updateCheck) {
    updateCheck().then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  if (msg.tablebaseLookup) {
    tablebaseLookup(msg.tablebaseLookup).then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  // Panel asks to read the board off the screen. The SW is the only context that can capture a tab;
  // the offscreen document is the only one with onnxruntime loaded -- so capture here, recognise there.
  if (msg.captureAndRecognize) {
    (async () => {
      try {
        // Capture the window the ASKER is in, and only if the asker is the tab being shown there.
        // captureVisibleTab with no windowId grabs the active tab of the last-focused window, so a
        // panel whose Follow-screen loop kept ticking after you switched tabs was handed a DIFFERENT
        // tab's pixels -- and fed them to the recogniser, which happily read a placement out of
        // whatever was on screen and restarted that panel's search on someone else's board. Every
        // other route in this file is careful to address the sender's tab; this one was not.
        const tab = sender.tab;
        if (!tab || tab.id == null) return sendResponse({error: 'no sender tab'});
        if (!tab.active) return sendResponse({error: 'tab is not visible'});
        const dataUri = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({recognizeBoard: {dataUri, crop: msg.captureAndRecognize.crop}});
        sendResponse(res || {error: 'no response from recogniser'});
      } catch (e) {
        sendResponse({error: String(e)});
      }
    })();
    return true; // async sendResponse
  }
  // the panel asks for its piece set separately -- only it knows the configured theme
  if (msg.getPieces) {
    buildPieces(msg.pieceSet, msg.pieceExt).then(pieces => sendResponse({pieces}))
      .catch(e => sendResponse({error: String(e)}));
    return true;
  }
  // Trusted clicks: chrome.debugger is unavailable to a content script, so the panel routes CDP
  // clicks through here now that it lives in the page's isolated world.
  if (msg.cdpClick) {
    // sender.tab is authenticated by Chrome; never trust a message-supplied tab id (issue #36 §1).
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({error: 'no sender tab'}); return; }
    cdpClick(tabId, msg.x, msg.y, msg.travelMs).then(() => sendResponse({ok: true})).catch(e => sendResponse({error: String(e)}));
    return true;
  }
  // The panel can't open the options page itself: it's a content script, so a relative URL resolves
  // against the SITE and chrome-extension:// navigation from a page is blocked.
  if (msg.openUrl) { // analysis board etc. -- a content script can't reliably window.open
    // Pin to the destinations we actually open (issue #36 §1): the lichess analysis board, and this
    // fork's releases page for the update notice. Kept as exact prefixes rather than a host check --
    // a page-side message must never be able to steer this at an arbitrary URL.
    const ALLOWED = ['https://lichess.org/analysis/',
                     'https://github.com/IchNukeDichWeg/Mephisto/releases'];
    if (ALLOWED.some(prefix => msg.openUrl.startsWith(prefix))) {
      chrome.tabs.create({url: msg.openUrl});
    }
    return;
  }
  if (msg.openOptions) {
    chrome.runtime.openOptionsPage();
    return;
  }
  // Engine output -> in-page panel. The offscreen doc emits it with runtime.sendMessage, which reaches
  // extension contexts ONLY -- never a content script, which is what the in-page panel now is. Relay it
  // to that panel's tab (clientId == tabId). The toolbar popup IS an extension page, so it already got
  // the original broadcast and needs no relay.
  if (msg.fromOffscreen && msg.clientId && msg.clientId !== 'toolbar') {
    const tabId = parseInt(msg.clientId, 10);
    if (tabId) chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  }
});

// --- Panel assets, fetched extension-side and inlined (no page-visible extension URLs) -----------
const PANEL_CSS = [
  'src/popup/popup.css',
  'lib/chessboard/chessboard.min.css',
  'lib/materialize/materialize.min.css',
];
const PIECES = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];
const MIME = {svg: 'image/svg+xml', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp'};
let panelAssetCache = null; // {html, css} -- theme-independent parts

// --- Opening explorer (lichess) --------------------------------------------------------------
// Which database the dropdown in Settings maps to. Masters is the default: cleanest opening play,
// and its move list is small enough that a weighted pick stays sane.
// Two hosts, tried in order: explorer.lichess.org is what the current lichess API spec documents,
// explorer.lichess.ovh is the older name that a lot of clients still use. Either can be the live one
// (and either can be edge-blocked for a given network), so fall through rather than pick one.
const EXPLORER_HOSTS = ['https://explorer.lichess.org', 'https://explorer.lichess.ovh'];
const EXPLORER_DB = {
  masters: {path: '/masters', params: {}},
  lichess: {path: '/lichess', params: {variant: 'standard'}},
  club:    {path: '/lichess',
            params: {variant: 'standard', ratings: '1600,1800,2000,2200', speeds: 'blitz,rapid,classical'}},
};
const explorerCache = new Map(); // `${db}|${fen}` -> response; the fallback poll rescrapes the same
const EXPLORER_CACHE_MAX = 300;  // position constantly, so without this every rescan is a request

// Calibration is a FIRST-INSTALL offer, nothing else. It used to fire off nothing but "we have
// eight nps samples", which meant an existing install got the prompt during a normal game -- and a
// prompt in the panel is not free, it competes for attention with the position. Chrome tells us the
// difference: onInstalled fires with reason 'install' exactly once, on a genuinely new install, and
// with 'update' when the extension is merely reloaded or upgraded. Only the former arms the offer.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.storage.local.set({calibrate_pending: 'true'}).catch(() => {});
});

// --- Update check ------------------------------------------------------------------------------
// Ask GitHub for this fork's newest release and compare it to the running manifest version. Done in
// the SERVICE WORKER, like the explorer lookup, so the chess page never makes the request. Cached
// for 12h in chrome.storage (survives SW restarts, which are frequent) because the unauthenticated
// GitHub API allows only 60 requests/hour/IP -- an uncached check on every panel open would burn
// that on a single session. Every failure path is silent: an update notice is a nicety, and a
// rate-limited or offline check must never surface as an error in the panel.
const UPDATE_REPO = 'IchNukeDichWeg/Mephisto';
const UPDATE_TTL_MS = 12 * 60 * 60 * 1000;

// "3.1.133" -> comparable tuple. Tolerates a leading v and any number of parts.
function versionParts(v) {
  return String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}
function isNewer(candidate, current) {
  const [a, b] = [versionParts(candidate), versionParts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function updateCheck() {
  const current = chrome.runtime.getManifest().version;
  const cached = (await chrome.storage.local.get('mephisto_update_check')).mephisto_update_check;
  if (cached && (Date.now() - cached.at) < UPDATE_TTL_MS) {
    return {...cached.result, current, newer: isNewer(cached.result.latest, current), cached: true};
  }
  let result = {latest: null};
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: {'Accept': 'application/vnd.github+json'}, signal: ctl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      result = {latest: String(json.tag_name || '').replace(/^v/, ''), url: json.html_url};
    }
  } catch (e) {
    // offline, rate-limited or aborted -- fall through with latest:null and cache it, so a broken
    // check backs off for the full TTL instead of retrying on every panel open
  }
  await chrome.storage.local.set({mephisto_update_check: {at: Date.now(), result}});
  return {...result, current, newer: isNewer(result.latest, current), cached: false};
}

// --- Shared lichess budget ----------------------------------------------------------------------
// The opening explorer and the tablebase are separate features with separate caches, and both hit
// lichess. Neither knew about the other, so a session with both on could spend two independent
// request streams into the same rate limit -- and when lichess pushed back, each would keep trying,
// because a 429 to one told the other nothing.
//
// One gate for both. A 429 (or a 503) parks EVERY lichess call until the cooldown expires, honouring
// Retry-After when it is sent. Calls during a cooldown fail instantly and locally: both callers
// already treat a miss as "no answer", so the engine's move is simply used, which is exactly the
// right behaviour and costs nothing.
const LICHESS_COOLDOWN_MS = 60_000; // fallback when Retry-After is absent
let lichess_blocked_until = 0;

function lichess_blocked() {
    return Date.now() < lichess_blocked_until;
}

// Read a rate-limit response and start the shared cooldown. Returns true if it was one.
function lichess_note_response(res, label) {
    if (!res || (res.status !== 429 && res.status !== 503)) return false;
    const retry = Number(res.headers?.get?.('Retry-After'));
    const ms = Number.isFinite(retry) && retry > 0 ? retry * 1000 : LICHESS_COOLDOWN_MS;
    lichess_blocked_until = Date.now() + ms;
    console.warn(`Mephisto: lichess rate-limited (${label}, HTTP ${res.status}) -- ` +
        `pausing all lichess lookups for ${Math.round(ms / 1000)}s`);
    return true;
}

// --- Syzygy tablebase (lichess) ---------------------------------------------------------------
// Perfect play once the position is down to <=7 men. PROBED OVER THE NETWORK on purpose: the real
// tablebases are hundreds of gigabytes and nobody is downloading those to use a browser extension,
// so the only shippable form is the lookup. Fetched HERE in the service worker, like the explorer,
// so the chess page itself never issues the request.
//
// A hit is not an opinion, it is the answer -- so unlike the opening book there is no "is the engine
// close enough" filter on the caller side. `moves` comes back sorted best-first; each move's
// `category` is from the perspective of the side to move AFTER it, so a move to `loss` is a move
// that loses FOR THEM, i.e. what we want.
const TABLEBASE_HOST = 'https://tablebase.lichess.ovh';
// Our variant name -> lichess's endpoint. Probed 2026-07-26: standard, atomic and antichess are the
// ONLY ones served -- crazyhouse, horde, kingofthehill, racingkings, threecheck and giveaway all 404.
// Chess960 is deliberately absent: a <=7-man 960 position can still carry castling rights, which
// Syzygy has no notion of, so mapping it to /standard would ask about a different position.
const TABLEBASE_PATHS = {chess: 'standard', atomic: 'atomic', antichess: 'antichess'};
const tablebaseCache = new Map(); // `${variant}|${fen}` -> response
const TABLEBASE_CACHE_MAX = 300;

async function tablebaseLookup({fen, variant}) {
  const path = TABLEBASE_PATHS[variant || 'chess'];
  if (!path) return {error: `no tablebase for variant ${variant}`};
  const key = `${path}|${fen}`;
  if (tablebaseCache.has(key)) return tablebaseCache.get(key);
  if (lichess_blocked()) return {error: 'lichess cooling down'}; // cached hits above still answer
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000); // a miss just means the engine plays instead
  let out;
  try {
    // encodeURIComponent, not URLSearchParams: the latter form-encodes the FEN's spaces to '+'
    // (same trap as the explorer lookup).
    const url = `${TABLEBASE_HOST}/${path}?fen=${encodeURIComponent(fen)}`;
    const r = await fetch(url, {signal: ctl.signal});
    lichess_note_response(r, 'tablebase');
    out = r.ok ? await r.json() : {error: `HTTP ${r.status}`};
    console.log('[Tablebase]', r.status, fen, out.error ? out.error : `${out.category} (${out.moves?.length ?? 0} moves)`);
  } catch (e) {
    out = {error: String(e)}; // offline / aborted / DNS
  } finally {
    clearTimeout(timer);
  }
  if (out.error) {
    console.warn('Mephisto: tablebase lookup failed -', out.error);
  } else { // never cache a failure: the next position should retry
    if (tablebaseCache.size >= TABLEBASE_CACHE_MAX) tablebaseCache.delete(tablebaseCache.keys().next().value);
    tablebaseCache.set(key, out);
  }
  return out;
}

async function explorerLookup({fen, db}) {
  const cfg = EXPLORER_DB[db] || EXPLORER_DB.masters;
  const key = `${db}|${fen}`;
  if (explorerCache.has(key)) return explorerCache.get(key);
  if (lichess_blocked()) return {error: 'lichess cooling down'}; // shared with the tablebase probe
  // NOT URLSearchParams: it form-encodes, turning the FEN's spaces into '+'. A parser that doesn't
  // read '+' as a space then sees "...RNBQKBNR+w+KQkq+-+0+1" and matches nothing -- a 200 with an
  // empty move list, which is indistinguishable from "out of book". encodeURIComponent gives %20.
  const params = Object.entries({...cfg.params, fen, topGames: '0', recentGames: '0'})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  let out = {error: 'no host reachable'};
  for (const host of EXPLORER_HOSTS) {
    // never let a hung request pile up: a miss means "no book" and the engine's move is played
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const url = `${host}${cfg.path}?${params}`;
      const r = await fetch(url, {signal: ctl.signal});
      if (lichess_note_response(r, 'explorer')) { out = {error: `HTTP ${r.status}`}; break; } // don't try the other host
      out = r.ok ? await r.json() : {error: `HTTP ${r.status}`};
      // log the REQUEST, not just the verdict: "no moves" is indistinguishable from "wrong FEN"
      // without seeing exactly what was asked for
      console.log('[Explorer]', r.status, url, out.error ? out.error : `${out.moves?.length ?? 0} moves`);
    } catch (e) {
      out = {error: String(e)}; // offline / aborted / DNS
    } finally {
      clearTimeout(timer);
    }
    if (!out.error) break; // this host answered -- don't try the other
  }
  if (out.error) {
    // Surface it. Failing silently here is what made a blocked endpoint look like "the feature is
    // broken": the panel drew nothing and said nothing. Same lesson as the scraper re-anchor.
    console.warn('Mephisto: opening explorer lookup failed -', out.error);
  } else { // never cache a failure: the next position should retry
    if (explorerCache.size >= EXPLORER_CACHE_MAX) explorerCache.delete(explorerCache.keys().next().value);
    explorerCache.set(key, out);
  }
  return out;
}

async function text(path) {
  const r = await fetch(chrome.runtime.getURL(path));
  return r.ok ? r.text() : '';
}

async function dataUri(path, mime) {
  const r = await fetch(chrome.runtime.getURL(path));
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

async function buildPanelAssets() {
  if (!panelAssetCache) {
    const rawHtml = await text('src/popup/popup.html');
    // body markup only -- the scripts in <head> already run as content scripts
    const body = rawHtml.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
    let css = (await Promise.all(PANEL_CSS.map(text))).join('\n');
    // popup.css targets the popup PAGE's document: rehome those selectors onto the panel container,
    // since a shadow root has no <html>/<body> for them to match.
    // ORDER MATTERS, and so does SPECIFICITY. `body.mephisto-dark` (0,1,1) originally beat the
    // `html, body` base rule (0,0,1). Rewriting the base to an ID (#..., 1,0,0) would flip that and
    // the light background would win over dark mode -- white text on a light panel. So the dark rules
    // must carry the id too: `#mephisto-panel-body.mephisto-dark` (1,1,0) > `#mephisto-panel-body` (1,0,0).
    // Matches EVERY `body.mephisto-*` state class, not just dark: a rule left as a bare `body.…`
    // would escape the rehome and style the SITE's <body> instead of our panel.
    css = css.replace(/\bbody\.mephisto-/g, '#mephisto-panel-body.mephisto-')
             .replace(/html,\s*body/g, '#mephisto-panel-body');
    // Inline every url() asset (the wood/marble/newspaper board textures). Injected into the page's
    // shadow root, a path like /res/chessboards/wood.jpeg would resolve against the SITE (404), and a
    // chrome-extension:// URL would leak our id via Resource Timing. So ship the bytes.
    css = await inlineCssUrls(css);
    panelAssetCache = {html: body, css};
  }
  return panelAssetCache;
}

// rewrite url(/path.ext) -> url(data:...;base64,...) for every extension-local asset in the CSS
async function inlineCssUrls(css) {
  const refs = [...new Set([...css.matchAll(/url\(\s*["']?(\/[^)"']+)["']?\s*\)/g)].map(m => m[1]))];
  for (const ref of refs) {
    const ext = ref.split('.').pop().toLowerCase();
    const uri = await dataUri(ref.replace(/^\//, ''), MIME[ext] || 'application/octet-stream');
    if (uri) css = css.split(ref).join(uri);
  }
  return css;
}

async function buildPieces(pieceSet, pieceExt) {
  const pieces = {};
  const mime = MIME[pieceExt] || 'image/svg+xml';
  await Promise.all(PIECES.map(async p => {
    const uri = await dataUri(`res/chesspieces/${pieceSet}/${p}.${pieceExt}`, mime);
    if (uri) pieces[p] = uri;
  }));
  return pieces;
}

// --- Trusted CDP click (moved here from the panel; content scripts can't use chrome.debugger) -----
const attached = new Set();
const lastPos = new Map(); // tabId -> {x, y}: where the synthetic cursor was left after the last click
const cdpSleep = (ms) => new Promise(r => setTimeout(r, ms));
const cdpDispatch = (target, params) => new Promise((resolve, reject) => {
  chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params, () =>
    chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve());
});

// Move the synthetic cursor from its last position to (x, y) as a series of mouseMoved events before
// we click there. A click dispatched with NO preceding mouseMoved is a dead giveaway -- a human's
// cursor always travels to the square first (audit M2). The path is eased (accelerate, decelerate),
// gently bowed, and jittered so it isn't a ruler-straight teleport, and it is spread across
// travelMs so the motion actually consumes the caller's move-time budget instead of snapping.
async function cdpMove(target, fromX, fromY, x, y, travelMs) {
  const dist = Math.hypot(x - fromX, y - fromY);
  const steps = Math.max(3, Math.min(40, Math.round(travelMs / 16))); // ~60fps, bounded either way
  const px = dist ? -(y - fromY) / dist : 0, py = dist ? (x - fromX) / dist : 0; // perpendicular unit
  const bow = (Math.random() - 0.5) * Math.min(dist * 0.15, 24); // sideways arc, scales with distance
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);         // smoothstep: slow-fast-slow
    const arc = Math.sin(t * Math.PI) * bow;  // 0 at both ends, peak mid-path
    const mx = fromX + (x - fromX) * ease + px * arc + (Math.random() - 0.5) * 1.5;
    const my = fromY + (y - fromY) * ease + py * arc + (Math.random() - 0.5) * 1.5;
    await cdpDispatch(target, {type: 'mouseMoved', x: mx, y: my, button: 'none'});
    if (travelMs > 0) await cdpSleep(travelMs / steps);
  }
}

function cdpClick(tabId, x, y, travelMs = 0) {
  return new Promise((resolve, reject) => {
    if (!tabId) return reject(new Error('no tabId'));
    const target = {tabId};
    const send = async () => {
      try {
        // first click on a fresh tab: no known cursor pos -- start a short hop away so there's still travel
        const from = lastPos.get(tabId) || {x: x - 40 - Math.random() * 40, y: y - 30 - Math.random() * 30};
        await cdpMove(target, from.x, from.y, x, y, Math.max(0, travelMs));
        lastPos.set(tabId, {x, y});
        const opts = {x, y, button: 'left', clickCount: 1};
        await cdpDispatch(target, {...opts, type: 'mousePressed'});
        await cdpDispatch(target, {...opts, type: 'mouseReleased'});
        resolve();
      } catch (e) { reject(e); }
    };
    if (attached.has(tabId)) return send();
    chrome.debugger.attach(target, '1.3', () => {
      // "Another debugger is already attached" is fine -- we stay attached after the first click
      if (chrome.runtime.lastError && !/already attached/i.test(chrome.runtime.lastError.message)) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      attached.add(tabId);
      send();
    });
  });
}
chrome.debugger.onDetach?.addListener((src) => {
  if (src.tabId) { attached.delete(src.tabId); lastPos.delete(src.tabId); }
});

// Free a panel's offscreen engine when its tab closes (the popup iframe is gone with it). Tab events
// don't need the "tabs" permission. clientId == String(tabId), matching ENGINE_CLIENT in popup.js.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.runtime.sendMessage({toOffscreen: true, clientId: String(tabId), cmd: 'dispose'},
    () => void chrome.runtime.lastError);
});

// --- Offscreen engine host (N1). An offscreen document is an invisible EXTENSION-ORIGIN page, so it
// gets cross-origin isolation (SharedArrayBuffer) from the manifest COEP/COOP -- but is NOT an
// in-page iframe, so no browsing context is countable by the site (defeats issue #35 §3.1/§3.3).
// Phase 1 just stands it up and runs the probe; later phases move the real engine here.
async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false; // older Chrome: assume none, createDocument will guard
  const ctx = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
  return ctx.length > 0;
}
async function ensureOffscreen() {
  try {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['WORKERS'], // the engine spawns pthread web workers
      justification: 'Runs the WASM chess engine off the page so the panel needs no in-page iframe.',
    });
  } catch (e) {
    // a concurrent create (race) throws "Only a single offscreen document may be created" -- benign
    console.log('[Mephisto] ensureOffscreen:', String(e));
  }
}
ensureOffscreen();

// UI mode toggle (Settings -> General). Two ways to show the panel:
//   'floating' (default) -- an in-page overlay injected on toolbar click. Since N1 it is a closed
//               shadow root with NO iframe and no extension URLs, but it is still page DOM, so it
//               remains the larger footprint. Autoplay/Premove need it (they outlive a click).
//   'popup'    -- the classic toolbar bubble. It renders in the browser's own chrome, so the page
//               has NO handle to it at all (zero page footprint = the "safer" mode), but it closes
//               when you click the board -- analysis only.
// Implemented purely with chrome.action.setPopup: when a popup is SET the icon opens the bubble and
// onClicked never fires; when it's CLEARED onClicked fires and we inject the overlay. Read straight
// off chrome.storage.local here rather than through MephistoConfig -- this worker has no DOM and the
// cache would be cold on every spin-up; the get() below re-reads it each time.
function applyUiMode(mode) {
  chrome.action.setPopup({popup: mode === 'popup' ? 'src/popup/popup.html' : ''});
}
// re-applied on every service-worker spin-up (top-level), so the mode survives SW restarts
chrome.storage.local.get('ui_mode', ({ui_mode}) => applyUiMode(ui_mode || 'floating'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ui_mode) return;
  const mode = changes.ui_mode.newValue || 'floating';
  applyUiMode(mode);
  if (mode === 'popup') { // tear down any overlay that's open when the user switches to the safe mode
    chrome.tabs.query({}, tabs => tabs.forEach(t => t.id &&
      chrome.tabs.sendMessage(t.id, {closeOverlay: true}, () => void chrome.runtime.lastError)));
  }
});

// Floating mode only: clicking the icon toggles the draggable in-page overlay. (In popup mode a
// popup is set, so this listener never fires -- Chrome shows the bubble instead.)
chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, {toggleOverlay: true}, () => void chrome.runtime.lastError);
});

// --- Native messaging (opt-in full-power native engines), owned HERE in the service worker
// (connectNative() from a content script is torn down by Chrome). A persistent Port pipes BOTH ways
// so a host can STREAM many frames per request (one per search depth) to the panel: panel Port <->
// this worker <-> native stdio port. Keyed by port name so each engine gets its own host. The
// default WASM engines need none of this; native engines require native-host/install-native.sh.
const NATIVE_HOSTS = {
  // native-messaging host names allow only [a-z0-9._] -- NO hyphens -> underscores in the app id
  'sf-native': {app: 'com.sf_native.host', label: 'Stockfish (native)'},
  'fairy-native': {app: 'com.fairy_native.host', label: 'Fairy-Stockfish (native)'},
};
const nativePorts = {};              // port name -> native stdio Port
const popupPortsByName = {};         // port name -> Set of popup Ports
// ONE native host serves every tab -- that is the point, they share one engine process -- and replies
// used to be BROADCAST to all of them, matched by id at the far end. But each panel numbers its own
// requests from 1, so two tabs both had a request 1 in flight and each accepted the other's frames as
// its own: evaluations, and the bestmove that follows them, delivered to the wrong board.
//
// The ids are therefore rewritten here rather than trusted. Every request going out is given an id
// unique to THIS worker, and the reply is renumbered back to whatever the asking panel called it. That
// makes the routing exact instead of probable: two panels may both use id 1 and it still cannot be
// ambiguous, which "make the panels pick different numbers" could only ever make unlikely.
// outer id -> {port, innerId}
const nativeRequestOwner = new Map();
let nativeSeq = 0;

function ensureNative(name) {
  if (nativePorts[name]) return nativePorts[name];
  const {app, label} = NATIVE_HOSTS[name];
  const np = chrome.runtime.connectNative(app);
  nativePorts[name] = np;
  const peers = () => popupPortsByName[name] || new Set();
  np.onMessage.addListener(frame => {
    const owner = (frame && frame.id != null) ? nativeRequestOwner.get(frame.id) : null;
    if (owner) {
      // An `info` frame is one of many for this request; anything else is its terminal reply, so the
      // id is spent. Also dropped when the port disconnects, so a request that never completes
      // (engine died mid-search) cannot pin the entry forever.
      if (!frame.info) nativeRequestOwner.delete(frame.id);
      // renumber back to what the asking panel called it -- it knows nothing of our numbering
      try { owner.port.postMessage({...frame, id: owner.innerId}); } catch (e) { nativeRequestOwner.delete(frame.id); }
      return;
    }
    // No known owner: an unsolicited frame, or one whose asker has gone. Broadcast as before --
    // this is the path `{fatal: ...}` and any host-initiated message takes.
    for (const p of peers()) { try { p.postMessage(frame); } catch (e) { /* port gone */ } }
  });
  np.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    delete nativePorts[name];
    const why = `${label} native host unavailable` + (err ? ` (${err.message})` : '') +
      ' — run native-host/install-native.sh once (see the README).';
    for (const p of peers()) { try { p.postMessage({fatal: why}); } catch (e) { /* */ } }
  });
  return np;
}

chrome.runtime.onConnect.addListener(port => {
  if (!NATIVE_HOSTS[port.name]) return;
  const name = port.name;
  (popupPortsByName[name] = popupPortsByName[name] || new Set()).add(port);
  port.onDisconnect.addListener(() => {
    popupPortsByName[name].delete(port);
    for (const [id, o] of nativeRequestOwner) { if (o.port === port) nativeRequestOwner.delete(id); }
    // Last popup using this engine went away (you switched engines, or closed the page). Shut the
    // native host DOWN so a lingering search -- e.g. a long pure-analysis, or any in-flight go --
    // can't keep burning all cores and throttle the engine you just selected. It relaunches on next use.
    if (popupPortsByName[name].size === 0 && nativePorts[name]) {
      try { nativePorts[name].disconnect(); } catch (e) { /* already gone */ }
      delete nativePorts[name];
    }
  });
  port.onMessage.addListener(req => {
    try {
      let out = req;
      if (req && req.id != null) {
        const outer = ++nativeSeq;
        nativeRequestOwner.set(outer, {port, innerId: req.id});
        out = {...req, id: outer};
      }
      ensureNative(name).postMessage(out);
    } catch (e) {
      try { port.postMessage({id: req && req.id, error: String(e)}); } catch (_) { /* */ }
    }
  });
});
