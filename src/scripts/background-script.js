// STARTUP TIMING, and it has to be persisted rather than traced. The trace ring below lives in this
// worker's memory, so when the WORKER is the thing that was asleep -- reported as ten seconds of
// nothing after a browser restart -- the ring is empty by definition and explains nothing. These
// marks are written to storage instead, so the next Copy Diagnostics shows where a cold start
// actually spent its time even though the worker that spent it is long gone.
const WORKER_T0 = Date.now();
// `+0ms` on the first mark is not "instant": WORKER_T0 is the first line of this file, so everything
// Chrome does BEFORE that (waking the worker, fetching and parsing this script) is invisible here
// and is exactly where a slow cold start can also hide.

const startupMarks = [];
function mark(what) { startupMarks.push(`${what} +${Date.now() - WORKER_T0}ms`); }

// The puzzle database lives in the EXTENSION's IndexedDB, and this worker is the only context the
// panel can reach that has it: the panel runs in the page's isolated world, whose indexedDB is the
// SITE's. Same file the options page uses for the import, so the key format cannot drift apart.
importScripts('/src/scripts/puzzle-db.js');
mark('puzzle-db');
// The language list + the locale loader, shared with the options page and the panel so there is one
// definition of which codes exist -- which is also what makes the fetch below safe, since `lang`
// arrives from a setting.
importScripts('/src/i18n/i18n.js');
mark('i18n');
// The self-updater, for the two questions the PANEL cannot answer for itself: is auto-updating set
// up, and start it. The install proper never runs here -- it needs showDirectoryPicker, which only a
// page has. Imported rather than reimplemented so the origin list and the handle store have one
// definition (see updater.js).
importScripts('/src/scripts/updater.js');
mark('updater');

// PRELOAD THE PANEL'S ASSETS. The pieces and board textures are bundled, so nothing is downloaded
// -- but they are read, rehomed and inlined as data URIs on first use, and panelAssetCache dies with
// the worker. A worker is evicted constantly, so "first panel open" pays that cost again and again
// and reads as the board appearing a beat late. Warmed here, off the critical path: nothing awaits
// it, every failure is swallowed, and the on-demand build stays exactly as it was if this loses the
// race. Uses the SAVED board theme, since building the wrong one would warm a cache nobody wants.
try {
  chrome.storage.local.get('board', ({board}) => {
    if (chrome.runtime.lastError) return;
    let theme = null;
    try { theme = JSON.parse(board); } catch (e) { theme = null; }
    buildPanelAssets(theme).then(() => mark('panel-assets')).catch(() => {});
  });
} catch (e) { /* no storage here -- the on-demand path still builds them */ }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // the content-script asks for its own tab id so its popup iframe can talk to ONLY this tab
  // (not whatever tab is active) -- otherwise a background tab's popup drives the foreground tab.
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
    buildPanelAssets(msg.getPanelAssets?.board).then(sendResponse).catch(e => sendResponse({error: String(e)}));
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
  // Is this a COMPLETE install? The update-only archive deliberately omits lib/engine and lib/ort,
  // so extracting it into a folder that never held a full install leaves an extension with no
  // engines -- and every failure after that is a confusing symptom (an engine that never loads, a
  // panel that analyses nothing) rather than a cause. Probe two small files inside the omitted
  // directories and let the panel say so plainly. Cached: the answer cannot change while we run.
  if (msg.assetsCheck) {
    checkBundledAssets().then(sendResponse);
    return true; // async sendResponse
  }
  // Can the panel offer a one-click update? Only when all three hold: the user switched it on, the
  // download permission is still granted, and a folder has been chosen. Anything less and the notice
  // stays a link to the release page, because there is nothing to click that would work.
  if (msg.updateReady) {
    // TWO facts, not one. `ok` is "can install right now"; `enabled` is "you asked for automatic
    // updates at all". The panel needs both to decide where its notice should send you -- a switch
    // that is ON but half set up wants the Updates section, not the release page.
    Promise.all([
      MephistoUpdater.isReady().catch(() => false),
      MephistoUpdater.enabled().catch(() => false),
    ]).then(([ok, enabled]) => sendResponse({ok, enabled}))
      .catch(() => sendResponse({ok: false, enabled: false}));
    return true; // async sendResponse
  }
  // The panel asking us to run it. The install lives on the settings page (only a page can hold the
  // directory handle's permission and show progress), so flag it and open that page -- it starts by
  // itself from there.
  if (msg.startUpdate) {
    chrome.storage.local.set({mephisto_autostart_update: true}, () => {
      chrome.runtime.openOptionsPage();
      sendResponse({ok: true});
    });
    return true; // async sendResponse
  }
  if (msg.updateCheck) {
    // `true` from the panel, `{force}` from the Updates settings page -- both truthy, and
    // `true?.force` is undefined, so the panel keeps the cached path it always had.
    updateCheck(msg.updateCheck?.force).then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  if (msg.tablebaseLookup) {
    tablebaseLookup(msg.tablebaseLookup).then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  // One local IndexedDB read. No network and no cache: it is already a disk lookup, and a puzzle
  // position is asked about once.
  // Background-play tracing from the page. Printed HERE because this worker has its own console in
  // its own window -- opening DevTools on the game tab would disable the background throttling that
  // is usually the thing under investigation.
  if (msg.bgTrace) {
    const t = new Date().toISOString().slice(11, 23);
    console.log(`[bg ${t}] ${msg.bgTrace.from} |`, ...msg.bgTrace.args);
    traceRing.push(`${t} ${msg.bgTrace.from} | ` + msg.bgTrace.args
      .map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    if (traceRing.length > TRACE_RING) traceRing.shift();
    return;
  }
  // One clipboard-sized report of everything worth knowing when something is not working. Built
  // HERE because the worker is the only place that sees the whole picture -- it is the far end of
  // every trace, and it survives the page reloads that lose the panel's own state.
  if (msg.diagnostics) {
    buildDiagnostics(msg.diagnostics).then(sendResponse).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  if (msg.puzzleLookup) {
    PuzzleDB.lookup(msg.puzzleLookup.fen, msg.puzzleLookup.site)
      .then(rec => sendResponse({solution: rec?.s || null, rating: rec?.r ?? null}))
      .catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  if (msg.puzzleDbCount) {
    PuzzleDB.count(msg.puzzleDbCount?.site).then(count => sendResponse({count})).catch(e => sendResponse({error: String(e)}));
    return true; // async sendResponse
  }
  // The panel asks for its UI strings. It runs in the page's isolated world, where fetching an
  // extension URL is blocked (web_accessible_resources is deliberately empty), so the worker reads
  // the file. English rides along as the fallback, so one round trip covers both.
  if (msg.i18nStrings) {
    (async () => {
      const lang = msg.i18nStrings.lang;
      const [strings, en] = await Promise.all([
        MephistoI18n.fetchLocale(lang).catch(() => null),
        lang === MephistoI18n.DEFAULT_LANG
          ? Promise.resolve(null)
          : MephistoI18n.fetchLocale(MephistoI18n.DEFAULT_LANG).catch(() => null),
      ]);
      sendResponse({strings, en});
    })();
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
        // JPEG, NOT PNG. This is the dominant cost of a screen read and it was being paid three
        // times over: PNG makes the browser losslessly encode the whole visible tab, the result
        // travels to the offscreen document as a base64 string, and it is decoded again there. On a
        // large display that is megabytes per frame for an image the recogniser immediately
        // downsamples to 256x256.
        //
        // Safe on the evidence rather than on the hope: when the position model was integrated it
        // was verified to read EXACT FENs on boards degraded to JPEG q20, among other abuses. 80 is
        // far above that, and the board is the least compressible thing on screen anyway.
        const t0 = Date.now();
        const dataUri = await chrome.tabs.captureVisibleTab(tab.windowId,
                                                           {format: 'jpeg', quality: SNAP_JPEG_QUALITY});
        const tCap = Date.now() - t0;
        await ensureOffscreen();
        const t1 = Date.now();
        const res = await chrome.runtime.sendMessage({recognizeBoard: {dataUri, crop: msg.captureAndRecognize.crop}});
        // Split, because the two halves have completely different fixes: the capture is the
        // browser's encoder, the recognise is the model. Without the split "screen reading is slow"
        // points at neither.
        // BYTES, not base64 characters -- dataUri.length overstated every frame by ~33% and the
        // readout exists precisely to judge whether the encoding change paid off.
        snapCaptureMs = tCap; snapRecogniseMs = Date.now() - t1;
        snapBytes = Math.round((dataUri.length - dataUri.indexOf(',') - 1) * 3 / 4);
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
    // sender.tab is authenticated by Chrome; never trust a message-supplied tab id from a CONTENT
    // SCRIPT (issue #36 §1) -- a hostile page could otherwise steer a click into another tab.
    //
    // But the TOOLBAR POPUP is an extension PAGE: it has no sender.tab at all, so this refused every
    // click it ever made. That is why popup mode could detect a board, analyse it, and never move --
    // "CDP click failed: no sender tab", once per click, forever.
    //
    // The guard is kept and NARROWED rather than dropped. An extension page is our own code at our
    // own origin, and a web page cannot forge that: Chrome sets sender.id and sender.url itself, and
    // a content script's sender.url is always the SITE's URL, never chrome-extension://. So a
    // message-supplied tab id is honoured only when the sender is genuinely one of our own pages.
    const fromOwnExtensionPage = !sender.tab
        && sender.id === chrome.runtime.id
        && typeof sender.url === 'string'
        && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
    const tabId = sender.tab?.id
        ?? ((fromOwnExtensionPage && Number.isInteger(msg.tabId)) ? msg.tabId : undefined);
    if (!tabId) { sendResponse({error: 'no sender tab'}); return; }
    if (Number.isFinite(msg.sentAt)) {
      hopLastMs = Math.max(0, Date.now() - msg.sentAt);
      if (hopLastMs > hopWorstMs) hopWorstMs = hopLastMs;
    }
    // Per-click accounting, because the CUMULATIVE counters cleared this path and the click was slow
    // anyway: avg 6ms/dispatch and cdpHung=0 cannot add up to a 1.6s click. workerMs is everything
    // this worker spent; dispMs is how much of that was actually in chrome.debugger. The caller
    // subtracts both from its own round trip, and what is left is outside this file entirely.
    const workerT0 = Date.now(), calls0 = cdpCalls, total0 = cdpTotalMs;
    const account = () => ({workerMs: Date.now() - workerT0, disp: cdpCalls - calls0, dispMs: cdpTotalMs - total0});
    cdpClick(tabId, msg.x, msg.y, msg.travelMs)
      .then(() => sendResponse({ok: true, ...account()}))
      .catch(e => sendResponse({error: String(e), ...account()}));
    return true;
  }
  if (msg.cdpDrag) {
    // Same authentication as cdpClick above, and for the same reason: never trust a tab id from a
    // content script, but do honour one from our own extension pages (the toolbar popup has no tab).
    const fromOwnExtensionPage = !sender.tab
        && sender.id === chrome.runtime.id
        && typeof sender.url === 'string'
        && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
    const tabId = sender.tab?.id
        ?? ((fromOwnExtensionPage && Number.isInteger(msg.tabId)) ? msg.tabId : undefined);
    if (!tabId) { sendResponse({error: 'no sender tab'}); return; }
    cdpDrag(tabId, msg.x1, msg.y1, msg.x2, msg.y2, msg.travelMs)
        .then(() => sendResponse({ok: true})).catch(e => sendResponse({error: String(e)}));
    return true;
  }
  // Same tab rules as cdpClick, but attaches only -- no input. A move calls this before it measures
  // anything, so the debugger infobar is already up and the board has stopped moving.
  if (msg.cdpWarm) {
    const own = !sender.tab && sender.id === chrome.runtime.id
        && typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
    const tabId = sender.tab?.id ?? ((own && Number.isInteger(msg.tabId)) ? msg.tabId : undefined);
    if (!tabId) { sendResponse({error: 'no sender tab'}); return; }
    cdpAttach(tabId).then(() => sendResponse({ok: true})).catch(e => sendResponse({error: String(e)}));
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

// Keep the last few cold starts. Five is enough to tell a one-off from a pattern and small enough
// that nobody has to think about the storage it uses.
const STARTUP_KEEP = 5;

async function saveStartup() {
  mark('ready');
  try {
    const {mephisto_startup: prev = []} = await chrome.storage.local.get('mephisto_startup');
    const rec = `${new Date(WORKER_T0).toISOString().slice(11, 19)}  ${startupMarks.join('  ')}`;
    await chrome.storage.local.set({mephisto_startup: [...prev, rec].slice(-STARTUP_KEEP)});
  } catch (e) { /* storage full or the worker died first -- never break startup for a measurement */ }
}

// --- Diagnostics ---------------------------------------------------------------------------------
// A ring of the most recent traces, so "it did nothing" can be answered from evidence instead of by
// asking someone to reproduce it with a console open. 200 lines is a few minutes of real play and a
// couple of hundred KB at worst -- small enough to paste, long enough to contain the cause.
const TRACE_RING = 200;
const traceRing = [];

// What goes in: enough to explain a failure, and nothing that identifies you. The extension id, the
// full URL and the query string are all deliberately left out -- this is meant to be pasteable into
// a public issue without a second thought.
async function buildDiagnostics(ctx = {}) {
  const m = chrome.runtime.getManifest();
  const assets = await checkBundledAssets();
  const perm = await chrome.permissions.getAll().catch(() => ({origins: []}));
  const {mephisto_startup: starts = []} = await chrome.storage.local.get('mephisto_startup').catch(() => ({}));
  // Whether a token is SET is worth knowing when the explorer is failing; the token itself never
  // leaves this machine. Read as a boolean so there is nothing here to redact.
  const {lichess_token: tok} = await chrome.storage.local.get('lichess_token').catch(() => ({}));
  const hasToken = !!(() => { try { return JSON.parse(tok ?? '""'); } catch (e) { return ''; } })();
  const lines = [
    `Mephisto ${m.version}  (${m.name})`,
    `chrome    ${(navigator.userAgent.match(/Chrome\/[\d.]+/) || ['?'])[0]}  ${navigator.platform}`,
    `engines   ${assets.ok ? 'bundled assets present' : 'MISSING: ' + assets.missing.join(', ')}`,
    `hosts     ${Object.keys(nativePorts).join(', ') || 'none connected'}`,
    `optional  ${(perm.origins || []).length} host permission(s) granted`,
    `lichess   API token ${hasToken ? 'set' : 'not set'}`,
    ctx.site ? `site      ${ctx.site}${ctx.path ? '  ' + ctx.path : ''}` : null,
    ctx.engine ? `engine    ${ctx.engine}` : null,
    ctx.detection ? `detection ${ctx.detection}` : null,
    ctx.reason ? `reason    ${ctx.reason}` : null,
    ctx.toggles ? `toggles   ${ctx.toggles}` : null,
    ctx.content ? `content   ${ctx.content}` : null,
    `worker    ${workerLoadLine()}`,
    ctx.fen ? `position  ${ctx.fen}` : null,
    '',
    '--- worker cold starts (most recent last) ---',
    ...(starts.length ? starts : ['(none recorded)']),
    '',
    `--- last ${traceRing.length} trace lines ---`,
    ...traceRing,
  ].filter(l => l !== null);
  return {report: lines.join('\n')};
}

let bundledAssets = null;
async function checkBundledAssets() {
  if (bundledAssets) return bundledAssets;
  // Small files, one per omitted directory. A GET of an absent extension resource rejects or 404s;
  // both mean the same thing here.
  const probes = ['lib/engine/maia/lc0_policy_index.json', 'lib/ort/ort.wasm.bundle.min.mjs'];
  const missing = [];
  for (const p of probes) {
    try {
      const r = await fetch(chrome.runtime.getURL(p));
      if (!r.ok) missing.push(p);
    } catch (e) {
      missing.push(p);
    }
  }
  bundledAssets = {ok: missing.length === 0, missing};
  if (!bundledAssets.ok) {
    console.warn('Mephisto: bundled engines are missing --', missing.join(', '),
                 '-- this looks like the update-only archive extracted over an incomplete install');
  }
  return bundledAssets;
}

// `force` skips the cache. Only the Updates settings page passes it, and only on a button press:
// the panel's own notice must keep using the cache or a busy session burns the 60/hour allowance.
async function updateCheck(force = false) {
  const current = chrome.runtime.getManifest().version;
  const cached = (await chrome.storage.local.get('mephisto_update_check')).mephisto_update_check;
  if (!force && cached && (Date.now() - cached.at) < UPDATE_TTL_MS) {
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
      const latest = String(json.tag_name || '').replace(/^v/, '');
      // The update archive is taken BY NAME. "the smaller of the two assets" would quietly start a
      // 585 MB download the day a release ships only the full one.
      const asset = (json.assets || []).find(a => a.name === `mephisto-${latest}-update.zip`);
      // The one-line story of the release, for the "what changed" note shown once after an update.
      // The notes always open with a bold headline sentence, so the first non-empty line is it --
      // stripped of the markdown that would otherwise read as literal asterisks in the panel, and
      // capped so a malformed release cannot push a paragraph into a one-line element.
      const headline = String(json.body || '').split('\n').map(l => l.trim())
        .find(l => l && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('>')) || '';
      // First SENTENCE, not first 240 characters: the notes open with a headline sentence followed
      // by context, and a character cap cut it mid-clause.
      const plain = headline.replace(/\*\*|__|`/g, '');
      const stop = plain.search(/[.!?](\s|$)/);
      result = {latest, url: json.html_url, asset: asset?.browser_download_url || null,
                size: asset?.size || 0, name: json.name || '',
                headline: (stop > 0 ? plain.slice(0, stop + 1) : plain).slice(0, 200)};
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

// Lichess put the opening explorer behind OAuth: every explorer route answers 401 at its proxy
// without one, while the tablebase (which declares `security: []`) still answers anonymously. Their
// own site gets through on a session cookie, but the explorer answers `access-control-allow-origin:
// *` to every origin except lichess.org's -- and a wildcard forbids credentials -- so no extension
// can ever use that route. A per-user token is the only mechanism left open to us.
//
// Empty is the normal state and is NOT an error here: the caller reports the 401 it gets, which is
// what tells the user to go and make one.
async function lichessAuthHeader() {
  try {
    const {lichess_token} = await chrome.storage.local.get('lichess_token');
    const t = JSON.parse(lichess_token ?? '""');
    return t ? {Authorization: `Bearer ${t}`} : {};
  } catch (e) {
    return {};
  }
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
      const r = await fetch(url, {signal: ctl.signal, headers: await lichessAuthHeader()});
      if (lichess_note_response(r, 'explorer')) { out = {error: `HTTP ${r.status}`}; break; } // don't try the other host
      out = r.ok ? await r.json()
        : {error: r.status === 401
            ? 'Lichess needs an API token for the opening explorer — Settings → General → Lichess API token'
            : `HTTP ${r.status}`};
      // log the REQUEST, not just the verdict: "no moves" is indistinguishable from "wrong FEN"
      // without seeing exactly what was asked for
      // the URL only -- the Authorization header is deliberately not logged
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

// `board` is the theme the panel is about to use. Only three themes have a texture (wood, marble,
// newspaper); the other nine are flat colours. Inlining all three put 784 KB of base64 into a 973 KB
// payload -- 80% of it for images that cannot all be on screen at once, shipped over sendMessage and
// parsed into the shadow root on EVERY open. Inline the one in use, or none.
async function buildPanelAssets(board) {
  const want = TEXTURED_THEMES.includes(board) ? board : null;
  if (panelAssetCache && panelAssetCache.board === want) return panelAssetCache.assets;
  {
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
    css = await inlineCssUrls(css, want);
    panelAssetCache = {board: want, assets: {html: body, css}};
  }
  return panelAssetCache.assets;
}

// rewrite url(/path.ext) -> url(data:...;base64,...) for every extension-local asset in the CSS
const TEXTURED_THEMES = ['wood', 'marble', 'newspaper'];

// `keep` is the one board texture worth carrying. Every other /res/chessboards/*.jpeg reference is
// left as-is: the rule it belongs to is for a theme that is not selected, so the browser never
// resolves the url and never notices that it points at nothing reachable from the page.
async function inlineCssUrls(css, keep) {
  // NEUTRALISE the textures we are not carrying, rather than leaving their url() in place. Left
  // alone, a rule like url(/res/chessboards/wood.jpeg) resolves against THE SITE if it is ever
  // applied -- a 404 the page can see in its Resource Timing, which is precisely the footprint this
  // whole asset-shipping design exists to avoid. `none` can never resolve to anything.
  css = css.replace(/url\(\s*["']?(\/res\/chessboards\/[^)"']+)["']?\s*\)/g,
    (m, ref) => (keep && ref.includes(`/${keep}.`)) ? m : 'none');
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
const cdpDispatch = (target, params, paced = false) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  cdpPending++;
  const hungAt = setTimeout(() => { cdpHung++; }, CDP_HUNG_MS);
  chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params, () => {
    clearTimeout(hungAt);
    cdpPending--;
    const dt = Date.now() - t0;
    cdpCalls++; cdpTotalMs += dt; if (dt > cdpWorstMs) cdpWorstMs = dt;
    // Calibration reads ONLY the serially-awaited path steps. The batched snap dispatches fire
    // concurrently but the protocol serializes them per session, so their measured durations
    // OVERLAP (~6t recorded for 3t of wall time) -- feeding those into the average was a positive
    // feedback loop: snaps inflated the estimate, the estimate shortened paths into snaps, and the
    // worker ratcheted itself into never drawing a cursor path again.
    if (paced) { pacedCalls++; pacedTotalMs += dt; }
    return chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve();
  });
});

// Move the synthetic cursor from its last position to (x, y) as a series of mouseMoved events before
// we click there. A click dispatched with NO preceding mouseMoved is a dead giveaway -- a human's
// cursor always travels to the square first (issue #36 / audit M2). The path is eased (accelerate,
// decelerate), gently bowed, and jittered so it isn't a ruler-straight teleport, and it is spread
// across travelMs so the motion actually consumes the caller's move-time budget instead of snapping.
// How many mouseMoved events a path of this length is worth. Shared with cdpClick, which needs to
// know whether the path is a single snap BEFORE it decides to batch.
//
// SIZED BY WHAT A DISPATCH ACTUALLY COSTS HERE, not by 60fps. The old rate assumed 16ms a step; a
// dispatch measures ~26ms on a real machine, so every path overran the budget it was given -- a
// 183ms travel drew 13 events and took 372ms. The press and release are part of that bill too, so
// they come out of the count rather than being added on top of a full-length path.
//
// Self-calibrating: it reads this worker's own running average once there is enough of one to
// trust, and falls back to the old assumption until then. A slow machine therefore draws a shorter
// path rather than a late one, which is the right trade -- a move that arrives on time with fewer
// waypoints beats a prettier one that misses its budget.
// Counters for the calibration below -- PACED dispatches only, see cdpDispatch.
let pacedCalls = 0, pacedTotalMs = 0;

function stepCostMs() {
  // Clamped [8, 40]: 8 is the fastest paced dispatch observed on the reference machine (an M-series
  // Mac, idle), and 40 caps how sparse a stalled stretch can make the path -- without the ceiling,
  // one loaded period inflated the lifetime average and every later move lost its cursor path
  // entirely, the M2 giveaway the path exists to prevent. 10 calls ~= one pathed move's worth.
  if (pacedCalls >= 10) return Math.min(40, Math.max(8, pacedTotalMs / pacedCalls));
  return 16; // no average worth trusting yet -- the old 60fps assumption until one exists
}

function pathSteps(travelMs) {
  // Waypoints over the travel only. Press and release are NOT deducted any more: subtracting them
  // collapsed every budget under ~4x the step cost to a single waypoint, which silently deleted the
  // path from the 50-75ms approach slice of perfectly ordinary 200-300ms moves. The two extra
  // dispatches cost ~2 steps of overrun on a pathed click; the page-side deadline absorbs it.
  return Math.max(1, Math.min(40, Math.round(travelMs / stepCostMs())));
}

// The batch-vs-path decision is the CALLER'S travel budget, not a derived step count: the content
// script sends 8ms for a snap and 0 for a hidden tab, and everything above that wants its path.
// Deriving it from pathSteps meant the calibration decided detection-relevant behaviour.
const CDP_SNAP_MS = 10;

async function cdpMove(target, fromX, fromY, x, y, travelMs, held = false) {
  // `held` = the left button is already down and this is the middle of a DRAG. Chrome only treats a
  // move as part of a drag when the event says the button is down (button + the buttons bitmask);
  // sent as a plain hover it reads as the cursor passing over the square and the drop never lands.
  // travelMs 0 means the caller wants no path at all (a hidden tab -- see dispatchSimulateClick).
  // Honour that literally: every step here is an awaited round-trip, and the minimum of three was
  // costing whole seconds in exactly the case the caller is trying to keep cheap.
  if (travelMs <= 0) return;
  const dist = Math.hypot(x - fromX, y - fromY);
  // Floor of ONE, not three. Every step is an awaited round trip through this worker, and this
  // worker is not scheduled as user-interactive -- measured under load, a click reported workerMs
  // 1466 with only 132ms of it inside chrome.debugger, the rest being the worker failing to resume
  // between awaits. Three was a floor on REALISM, but one mouseMoved already buys the thing that
  // matters (the press is not the cursor's first appearance at that point); steps two and three
  // bought nothing and cost two more chances to be descheduled. Above ~48ms the rate picks the
  // count as before, so a real path is unchanged.
  const steps = pathSteps(travelMs); // ~60fps, bounded either way
  const px = dist ? -(y - fromY) / dist : 0, py = dist ? (x - fromX) / dist : 0; // perpendicular unit
  const bow = (Math.random() - 0.5) * Math.min(dist * 0.15, 24); // sideways arc, scales with distance
  // PACE TO A DEADLINE, never by adding a fixed sleep after each step.
  //
  // Each dispatch is an awaited round-trip, and this worker also relays every frame a NATIVE engine
  // streams -- one per search depth. When that traffic makes a dispatch slow, sleeping a full slice
  // on top of it means the path costs (dispatch + slice) per step instead of max(dispatch, slice),
  // and the error compounds over the steps: a 125ms move measured 3s and hit the click timeout,
  // while the same settings on a WASM engine (which runs offscreen and never touches this worker)
  // were exact. Sleeping only until the step is DUE spends the caller's budget and not a millisecond
  // more -- and when the worker is idle the motion is spread exactly as before.
  const startedAt = Date.now();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);         // smoothstep: slow-fast-slow
    const arc = Math.sin(t * Math.PI) * bow;  // 0 at both ends, peak mid-path
    const mx = fromX + (x - fromX) * ease + px * arc + (Math.random() - 0.5) * 1.5;
    const my = fromY + (y - fromY) * ease + py * arc + (Math.random() - 0.5) * 1.5;
    await cdpDispatch(target, held ? {type: 'mouseMoved', x: mx, y: my, button: 'left', buttons: 1}
                                   : {type: 'mouseMoved', x: mx, y: my, button: 'none'}, true);
    const behind = (startedAt + travelMs * t) - Date.now();
    if (behind > 0) await cdpSleep(behind);
  }
}

// How long to let the page settle after the debugger infobar appears. Only ever paid once per tab.
const ATTACH_SETTLE_MS = 450;

function cdpClick(tabId, x, y, travelMs = 0) {
  return new Promise((resolve, reject) => {
    if (!tabId) return reject(new Error('no tabId'));
    const target = {tabId};
    const send = async () => {
      try {
        // first click on a fresh tab: no known cursor pos -- start a short hop away so there's still travel
        const from = lastPos.get(tabId) || {x: x - 40 - Math.random() * 40, y: y - 30 - Math.random() * 30};
        const opts = {x, y, button: 'left', clickCount: 1};
        // ONE SCHEDULING SLOT, NOT FOUR. Every `await` here needs this worker's process scheduled
        // again, and that process is only busy when a WASM engine is running in the offscreen
        // document beside it. With a NATIVE engine it is idle, so a loaded machine deprioritises it
        // and each resumption waits hundreds of ms -- measured: workerMs 1365 with 19ms of it inside
        // chrome.debugger, and the same load stretched this worker's own i18n load from ~10ms to
        // 3.8s. The click path is identical for both engines; only the process's state differs.
        //
        // The DevTools protocol keeps command order per session, so a snap click's events can be
        // issued in ONE task and awaited together instead of one at a time. Only when the path is a
        // single step: a real path has to be PACED, and pacing is what the awaits are for.
        if (travelMs <= CDP_SNAP_MS) {
          const evts = travelMs > 0 ? [{type: 'mouseMoved', x, y, button: 'none'}] : [];
          evts.push({...opts, type: 'mousePressed'}, {...opts, type: 'mouseReleased'});
          lastPos.set(tabId, {x, y});
          await Promise.all(evts.map(e => cdpDispatch(target, e)));
          return resolve();
        }
        await cdpMove(target, from.x, from.y, x, y, Math.max(0, travelMs));
        lastPos.set(tabId, {x, y});
        await cdpDispatch(target, {...opts, type: 'mousePressed'});
        await cdpDispatch(target, {...opts, type: 'mouseReleased'});
        resolve();
      } catch (e) { reject(e); }
    };
    cdpAttach(tabId).then(send, reject);
  });
}

// Press at the origin, travel with the button DOWN, release at the destination.
//
// Click-click is not enough on chess.com's variants board: a plain move registers, but a CAPTURE
// does not -- you have to drag the piece onto the one it takes. That is what "it fails to reach some
// squares" was: every quiet move worked and every capture silently did nothing.
function cdpDrag(tabId, x1, y1, x2, y2, travelMs = 0) {
  return new Promise((resolve, reject) => {
    if (!tabId) return reject(new Error('no tabId'));
    const target = {tabId};
    const send = async () => {
      try {
        const from = lastPos.get(tabId) || {x: x1 - 40 - Math.random() * 40, y: y1 - 30 - Math.random() * 30};
        // Reach for the piece, then carry it: the budget is split so the whole gesture still costs
        // what the caller's move-time budget says, exactly like the two clicks it replaces.
        const reach = Math.max(0, travelMs) * 0.35, carry = Math.max(0, travelMs) * 0.65;
        await cdpMove(target, from.x, from.y, x1, y1, reach);
        await cdpDispatch(target, {type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1});
        await cdpMove(target, x1, y1, x2, y2, carry, true);
        // Land ON the destination before releasing: the eased path stops a hair short of it.
        await cdpDispatch(target, {type: 'mouseMoved', x: x2, y: y2, button: 'left', buttons: 1});
        await cdpDispatch(target, {type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1});
        lastPos.set(tabId, {x: x2, y: y2});
        resolve();
      } catch (e) { reject(e); }
    };
    cdpAttach(tabId).then(send, reject);
  });
}

// Attach the debugger, resolving only once the page has settled underneath the infobar it raises.
// Split out from cdpClick so a move can raise the bar BEFORE it measures any squares: the bar shrinks
// the viewport, chess.com re-sizes the board to fit, and coordinates taken before that point aim at
// where the square used to be. Idempotent and cached, so only the first call per tab ever waits.
function cdpAttach(tabId) {
  if (attached.has(tabId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({tabId}, '1.3', () => {
      // "Another debugger is already attached" is fine -- we stay attached after the first click
      if (chrome.runtime.lastError && !/already attached/i.test(chrome.runtime.lastError.message)) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      attached.add(tabId);
      setTimeout(resolve, ATTACH_SETTLE_MS);
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
  // the panel's Maia second-inference client shares the tab's lifetime under its own id
  chrome.runtime.sendMessage({toOffscreen: true, clientId: String(tabId) + ':m2', cmd: 'dispose'},
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
// Every cold start pays for this, so it is worth knowing what it costs before assuming it is free.
ensureOffscreen().then(() => mark('offscreen')).finally(saveStartup);

// UI mode toggle (Settings -> General). Two ways to show the panel:
//   'floating' (default) -- an in-page overlay injected on toolbar click. Richer UX, but the panel
//               and its iframe live in the page DOM (a larger, page-detectable footprint).
//   'popup'    -- the classic toolbar bubble. It renders in the browser's own chrome, so the page
//               has NO handle to it at all (zero page footprint = the "safer" mode).
// Implemented purely with chrome.action.setPopup: when a popup is SET the icon opens the bubble and
// onClicked never fires; when it's CLEARED onClicked fires and we inject the overlay. The service
// worker can't read the popup's localStorage, so this one setting lives in chrome.storage.local.
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
function nativeTrace(dir, name, frame) {
  try {
    const t = new Date().toISOString().slice(11, 23);
    const f = frame || {};
    // the interesting fields, flattened -- a whole `lines` array per info frame is unreadable
    const brief = {};
    for (const k of ['id', 'innerId', 'cmd', 'fen', 'time', 'moves', 'bestmove', 'threat',
                     'done', 'error', 'fatal']) {
      if (f[k] !== undefined) brief[k] = f[k];
    }
    if (f.info) brief.info = `depth ${f.info.depth ?? '?'} pv ${(f.info.pv || []).slice(0, 2).join(' ')}`;
    if (f.options) brief.options = f.options;
    if (f.replies) brief.replies = f.replies.length + ' pairs';
    console.log(`[uci ${t}] ${dir} ${name}`, brief);
  } catch (e) { /* tracing must never break the relay */ }
}

const NATIVE_HOSTS = {
  // native-messaging host names allow only [a-z0-9._] -- NO hyphens -> underscores in the app id
  'sf-native': {app: 'com.sf_native.host', label: 'Stockfish (native)'},
  'fairy-native': {app: 'com.fairy_native.host', label: 'Fairy-Stockfish (native)'},
  // four-player chess -- see native-host/install-native.sh --tetrarch and the README
  'tetrarch-native': {app: 'com.tetrarch.host', label: 'Tetrarch (4-player)'},
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
// THE WORKER'S OWN LOAD, because nothing has ever reported it. A native engine's frames are relayed
// HERE, one per search depth, on the same single thread that dispatches every click -- so "clicks
// get slower the longer the game runs" and "it stays slow in the next game" are both questions about
// numbers only this file can see. Counted, never inferred.
// WHERE A CLICK'S TIME ACTUALLY GOES. A click is two costs and they need opposite fixes:
//   hop  = page -> worker. Big means the worker was asleep or busy, and the fix is here.
//   cdp  = chrome.debugger.sendCommand. Big means the RENDERER is busy -- input dispatch is handled
//          by the page's main thread, so a blocked page makes a trivial click take seconds, and no
//          amount of work in this file would help.
// Worst-case is what matters, not the average: one 3s command is the timeout.
let hopWorstMs = 0, hopLastMs = 0;
let cdpWorstMs = 0, cdpCalls = 0, cdpTotalMs = 0;
// A COMMAND THAT NEVER CALLS BACK IS INVISIBLE to the stats above, and that is exactly the failure:
// the averages stay at single-digit ms while a click sits at 3s and hits the panel's cap. Input
// dispatch is executed by the PAGE's renderer, so a hang here means the renderer stopped servicing
// input -- nothing in this worker can be the cause OR the fix. Counted separately so it stops
// hiding behind a healthy average.
// Screen reading, split into the browser's encode and the model's inference (see captureAndRecognize)
let snapCaptureMs = 0, snapRecogniseMs = 0, snapBytes = 0;
// Quality for the capture. Verified reading exact FENs down at q20 when the model was integrated,
// so this is not near the edge; lower would shrink the frame further for no measured gain in accuracy.
const SNAP_JPEG_QUALITY = 80;
let cdpPending = 0, cdpHung = 0;
const CDP_HUNG_MS = 1000;
let nativeFramesIn = 0;       // frames received from any native host since this worker started
let nativeFramesOut = 0;      // ...and how many panel messages they turned into
let nativeFramesRecent = [];  // arrival times in the last second, for a live rate
const workerStarted = Date.now();

function workerLoadLine() {
  const now = Date.now();
  nativeFramesRecent = nativeFramesRecent.filter(t => now - t < 1000);
  const peers = Object.entries(popupPortsByName).map(([n, s]) => `${n}:${s.size}`).join(',') || 'none';
  return [
    `frames=${nativeFramesIn}`,
    `fanout=${nativeFramesOut}`,
    `rate=${nativeFramesRecent.length}/s`,
    `owners=${nativeRequestOwner.size}`,   // leaks one per ABANDONED search: watch it climb
    `panels=${peers}`,
    `attached=${attached.size}`,
    `hop=${hopLastMs}/${hopWorstMs}ms`,                                   // last / worst page->worker
    `cdp=${cdpCalls ? Math.round(cdpTotalMs / cdpCalls) : 0}/${cdpWorstMs}ms`, // avg / worst debugger call
    `cdpHung=${cdpHung}`,        // dispatches that took over a second -- the renderer stalling
    `cdpPending=${cdpPending}`,  // ...and any still outstanding right now
    `snap=${snapCaptureMs}+${snapRecogniseMs}ms/${Math.round(snapBytes / 1024)}KB`, // capture + recognise
    `up=${Math.round((now - workerStarted) / 1000)}s`,
  ].join('  ');
}

function ensureNative(name) {
  if (nativePorts[name]) return nativePorts[name];
  const {app, label} = NATIVE_HOSTS[name];
  const np = chrome.runtime.connectNative(app);
  nativePorts[name] = np;
  const peers = () => popupPortsByName[name] || new Set();
  np.onMessage.addListener(frame => {
    nativeFramesIn++;
    nativeFramesRecent.push(Date.now());
    nativeTrace('<- host', name, frame);
    const owner = (frame && frame.id != null) ? nativeRequestOwner.get(frame.id) : null;
    if (owner) {
      // An `info` frame is one of many for this request; anything else is its terminal reply, so the
      // id is spent. Also dropped when the port disconnects, so a request that never completes
      // (engine died mid-search) cannot pin the entry forever.
      if (!frame.info) nativeRequestOwner.delete(frame.id);
      // renumber back to what the asking panel called it -- it knows nothing of our numbering
      try { nativeFramesOut++; owner.port.postMessage({...frame, id: owner.innerId}); } catch (e) { nativeRequestOwner.delete(frame.id); }
      return;
    }
    // No known owner: an unsolicited frame, or one whose asker has gone. Broadcast as before --
    // this is the path `{fatal: ...}` and any host-initiated message takes.
    nativeTrace('<- host', name, frame);
    for (const p of peers()) { try { p.postMessage(frame); } catch (e) { /* port gone */ } }
  });
  np.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    delete nativePorts[name];
    console.warn(`[uci] ${name} native host DISCONNECTED`,
                 chrome.runtime.lastError ? chrome.runtime.lastError.message : '(no error given)');
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
      nativeTrace('-> host', name, {...out, innerId: req && req.id});
      ensureNative(name).postMessage(out);
    } catch (e) {
      try { port.postMessage({id: req && req.id, error: String(e)}); } catch (_) { /* */ }
    }
  });
});
