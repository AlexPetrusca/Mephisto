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

// --- CLOUD EVALUATION -----------------------------------------------------------------------
// A real Stockfish on somebody else's machine, over HTTPS. THE POSITION LEAVES THIS MACHINE:
// that is the entire cost of this engine and it is not hidden -- the dropdown entries say
// "cloud", the settings tooltip says it in words, and this is the only code in the extension
// that sends a position anywhere. A native host is faster AND private, so this is the fallback
// for a machine that cannot run a strong engine locally, not an upgrade for one that can.
//
// It lives in the WORKER rather than the panel because the panel runs inside the page, where a
// strict Content-Security-Policy (lichess ships one) can block a cross-origin fetch outright.
// Both providers answer `access-control-allow-origin: *` (measured), so no host permission is
// needed and none is requested.
//
// Both APIs report WHITE-RELATIVE evals and mate distances -- measured, not assumed: black
// winning reads -14.24 / -13.79, and a black mate-in-1 reads mate -1 on both. `rawScore` in the
// envelope below is UCI, which is SIDE-TO-MOVE relative, hence the sign flip.
const CLOUD_TIMEOUT_MS = 20000;
const CLOUD_RETRY_PAUSE_MS = 400;   // long enough for a blip, short enough to still make the move
const CLOUD_429_PAUSE_MS = 1500;    // a rate limit needs longer than a blip does
// A position asked for TWICE is a request nobody needed. The panel re-pushes the same position
// more often than you would think (the fallback poll, a re-render, a settings touch), and each
// duplicate is another hit against someone else's rate limit -- stockfish.online started
// answering 429 during a normal game. Same question inside this window: same answer, no request.
// Short enough that a real re-analysis of a position you are sitting on still happens.
const CLOUD_CACHE_MS = 15000;
const cloudCache = new Map();       // key -> {at, value}
const cloudInFlight = new Map();    // key -> Promise, so two asks at once become one request
const CLOUD_PROVIDERS = {
  'cloud-chessapi': {
    label: 'chess-api.com',
    // "Stockfish 18 NNUE", per chess-api.com's own front page (checked 2026-08-15). The dropdown
    // says the version because that is what tells you how strong the answer is.
    engineName: 'Stockfish 18',
    maxDepth: 18,        // their documented ceiling; asking for more is silently capped anyway
    defaultDepth: 12,
    // The ONE thing this provider takes beyond fen+depth, and it is the real limiter: measured
    // 50ms -> depth 12, 500ms -> 14, 1000ms -> 17, 3000ms -> 17 (it plateaus). Depth stays the
    // ceiling. Capped at 10s so a request cannot outlive CLOUD_TIMEOUT_MS.
    takesThinkingTime: true,
    // IT REFUSES ANY FEN WITH AN EN-PASSANT SQUARE. Measured against the live API: the ordinary
    // French position after 1.e4 e6 2.d4 d5 ("... w KQkq d6 0 3") comes back "Cannot evaluate
    // given position - wrong FEN", and so does 1.e4 e5; drop the field and the same position is
    // answered. It refuses it even when the capture is LEGAL, so this is not a validation rule we
    // can satisfy -- the field has to go. The cost is real and small: in a position where an en
    // passant capture is available, this provider cannot see that one move. stockfish.online takes
    // the field correctly and is the one to use if that matters.
    sanitizeFen: (fen) => {
      const p = String(fen).trim().split(/\s+/);
      if (p.length >= 4 && p[3] !== '-') p[3] = '-';
      return p.join(' ');
    },
    request: (fen, depth, thinkMs) => ['https://chess-api.com/v1', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({fen, depth,
        ...(thinkMs ? {maxThinkingTime: Math.max(1, Math.min(10000, Math.round(thinkMs)))} : {})}),
    }],
    parse: (j, turn) => {
      if (!j || j.type === 'error' || j.error) return {error: j?.text || j?.error || 'chess-api.com rejected that position'};
      if (!j.move) return {error: j.text || 'chess-api.com returned no move'};
      const cont = Array.isArray(j.continuationArr) ? j.continuationArr : [];
      // `mate` comes back as the string "1" when positive and the number -1 when negative
      const mate = (j.mate === null || j.mate === undefined || j.mate === '') ? null : Number(j.mate);
      return cloudEnvelope([j.move, ...cont], mate,
        mate === null ? Math.round(Number(j.eval) * 100) : null, Number(j.depth) || 0, turn);
    },
  },
  'cloud-stockfish-online': {
    label: 'stockfish.online',
    // "Stockfish 17.1 REST API", per stockfish.online's own front page (checked 2026-08-15).
    engineName: 'Stockfish 17.1',
    maxDepth: 15,        // measured: depth 16 is REFUSED ("Depth must be less than 16"), not capped
    defaultDepth: 12,
    // fen and depth are the whole API here -- there is no time control to give it, which is why
    // selecting this engine switches the search budget to Depth (see config-store.js).
    takesThinkingTime: false,
    request: (fen, depth) => [
      `https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${depth}`, {method: 'GET'}],
    parse: (j, turn, depth) => {
      if (!j || !j.success) return {error: j?.data || j?.error || 'stockfish.online could not evaluate that position'};
      const best = String(j.bestmove || '').split(/\s+/)[1];
      if (!best) return {error: 'stockfish.online returned no move'};
      const cont = String(j.continuation || '').trim().split(/\s+/).filter(Boolean);
      const mate = (j.mate === null || j.mate === undefined) ? null : Number(j.mate);
      return cloudEnvelope(cont[0] === best ? cont : [best, ...cont], mate,
        mate === null ? Math.round(Number(j.evaluation) * 100) : null, depth, turn);
    },
  },
};

// The shape remote-engine.py answers with, so the panel's remote path needs no special case:
// white-relative `score`/`mate`, side-to-move-relative `rawScore`, pv as UCI strings.
function cloudEnvelope(pv, mateWhite, cpWhite, depth, turn) {
  const sign = turn === 'w' ? 1 : -1;
  const line = {move: pv[0], pv, depth, multipv: 1};
  if (mateWhite === null || Number.isNaN(mateWhite)) {
    const cp = Number.isFinite(cpWhite) ? cpWhite : 0;
    line.score = cp;
    line.rawScore = `cp ${cp * sign}`;
  } else {
    line.mate = mateWhite;
    line.rawScore = `mate ${mateWhite * sign}`;
  }
  return {bestmove: pv[0], threat: pv[1] || '(none)', lines: [line]};
}

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
  // Open the settings page AT the Updates section, without arming an install the way startUpdate
  // does -- this is "come and finish setting this up", not "run it now".
  if (msg.openUpdates) {
    chrome.storage.local.set({mephisto_focus_updates: true}, () => {
      chrome.runtime.openOptionsPage();
      sendResponse({ok: true});
    });
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
  if (msg.chesscomAnalyze) {
    chesscomAnalyze(msg.chesscomAnalyze).then(sendResponse).catch(e => sendResponse({error: String(e)}));
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
  if (msg.cloudAnalyse) {
    (async () => {
      const {engine, fen, depth, thinkMs} = msg.cloudAnalyse;
      const p = CLOUD_PROVIDERS[engine];
      if (!p) return sendResponse({error: `unknown cloud engine ${engine}`});
      const turn = String(fen || '').split(/\s+/)[1] === 'b' ? 'b' : 'w';
      const want = Math.max(1, Math.min(p.maxDepth, Math.round(Number(depth) || p.defaultDepth)));

      // ONE ATTEMPT, THEN ONE RETRY. These are other people's servers: a stall or a throttle happens
      // (seen live -- one request hung past the timeout while a curl to the same endpoint answered
      // in 130ms), and losing the move to it is worse than waiting another moment. Retried only for
      // the failures a retry can fix: a timeout, a rate limit, a gateway. A 400 means the position
      // was refused and asking again would just be rude.
      const RETRYABLE = [429, 500, 502, 503, 504];
      const attempt = async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), CLOUD_TIMEOUT_MS);
        try {
          const asked = p.sanitizeFen ? p.sanitizeFen(fen) : fen;
          const [url, init] = p.request(asked, want, p.takesThinkingTime ? thinkMs : null);
          const res = await fetch(url, {...init, signal: ctl.signal, cache: 'no-store'});
          if (!res.ok) {
            return {retry: RETRYABLE.includes(res.status), rateLimited: res.status === 429,
                    error: res.status === 429
                      ? `${p.label} is rate-limiting this machine (HTTP 429)`
                      : `${p.label} answered HTTP ${res.status}`};
          }
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* an error page, not JSON */ }
          if (!json) return {retry: false, error: `${p.label} did not return JSON`};
          return {value: p.parse(json, turn, want)};
        } catch (e) {
          return {retry: e.name === 'AbortError',
                  error: e.name === 'AbortError'
                    ? `${p.label} did not answer within ${CLOUD_TIMEOUT_MS / 1000}s`
                    : `${p.label}: ${e.message}`};
        } finally {
          clearTimeout(timer);
        }
      };
      const key = `${engine}|${want}|${thinkMs || 0}|${p.sanitizeFen ? p.sanitizeFen(fen) : fen}`;
      const now = Date.now();
      const hit = cloudCache.get(key);
      if (hit && now - hit.at < CLOUD_CACHE_MS) return sendResponse(hit.value);
      // Already asking this very question: wait for that answer instead of sending a second one.
      const pending = cloudInFlight.get(key);
      if (pending) return sendResponse(await pending);

      const run = (async () => {
        let out = await attempt();
        if (!out.value && out.retry) {
          await new Promise(r => setTimeout(r, out.rateLimited ? CLOUD_429_PAUSE_MS : CLOUD_RETRY_PAUSE_MS));
          const second = await attempt();
          out = second.value ? second : {error: `${out.error} (retried once)`};
        }
        const answer = out.value || {error: out.error};
        if (out.value) {
          cloudCache.set(key, {at: Date.now(), value: answer});
          // keep the map from growing for ever in a long session
          if (cloudCache.size > 200) {
            for (const [k, v] of cloudCache) if (Date.now() - v.at > CLOUD_CACHE_MS) cloudCache.delete(k);
          }
        }
        return answer;
      })();
      cloudInFlight.set(key, run);
      try {
        sendResponse(await run);
      } finally {
        cloudInFlight.delete(key);
      }
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
        // the recogniser's own split: which model actually costs the time, and whether the board
        // box came from the cache (see vision.js). "Screen reading is slow" is answerable now.
        snapStages = res?.timing || null;
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

// ---- chess.com's game review, v2 -----------------------------------------------------------------
// The endpoint (wss://analysis.chess.com/v2/game-review) speaks PROTOBUF, not JSON. The first message
// IS the game natively encoded: moves as from/to square pairs (a1=1 .. h8=64) with a promotion piece
// (n=1,b=2,r=3,q=4) and, for castling, the rook's own from/to; clocks in ms; players + Elo; the game
// id; the winner; and an option envelope. The encoder below reproduces a real captured hello
// BYTE-FOR-BYTE (pinned in the ladder), and the promotion/castling encodings were each mapped from
// their own captures, so it is trustworthy on any standard game. The response is decoded the same way.
//
// AUTH IS THE BROWSER'S OWN chess.com SESSION: the socket must go out with a native
// Origin: https://www.chess.com and the first-party session cookie, neither of which a service-worker
// socket can send (that is a 1008). So it runs in the MAIN world of a chess.com TAB via
// chrome.scripting.executeScript -- an already-open one, or one opened in the background and closed
// again. THE GAME LEAVES THIS MACHINE (that is the point): the PGN goes to chess.com, as on their
// own analysis page.
//
// Still as-captured until a second capture maps them: the strength tier (f3) and the option flags
// (the Strength select is carried but not yet applied). Player UUIDs are omitted (a PGN has none).

// >>> CCR_PROTO_BEGIN  (pure; the ladder slices this block and runs it against the captured bytes)
function ccrVarint(n) {
  const o = []; n = Math.trunc(n);
  while (n > 127) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  o.push(n); return o;
}
function ccrTag(f, w) { return ccrVarint((f << 3) | w); }
function ccrVf(f, n) { return [...ccrTag(f, 0), ...ccrVarint(n)]; }
function ccrBf(f, b) { return [...ccrTag(f, 2), ...ccrVarint(b.length), ...b]; }
function ccrSf(f, str) { return ccrBf(f, [...new TextEncoder().encode(str)]); }
function ccrMf(f, arr) { return ccrBf(f, arr); }
// algebraic square -> chess.com's 1-based index: a1=1, b1=2, ... h8=64
function ccrSquare(alg) { return (alg.charCodeAt(0) - 96) + (Number(alg[1]) - 1) * 8; }

function ccrEncodeGameReview(g) {
  // The move's from/to sub-message. Two extensions, both mapped from real captures: a PROMOTION adds
  // f3 = the piece (n=1, b=2, r=3, q=4 -- q, r and n each verified from a capture, b bracketed between
  // them); CASTLING adds f5 = {kingFrom, kingTo, rookFrom, rookTo}, with f1/f2 staying the king's own
  // from/to. A check adds nothing to the move (it is a property of the position).
  const moveInner = (m) => {
    let parts = [].concat(ccrVf(1, m.from), ccrVf(2, m.to));
    if (m.promo) parts = parts.concat(ccrVf(3, m.promo));
    if (m.castle) parts = parts.concat(ccrMf(5, [].concat(
      ccrVf(1, m.from), ccrVf(2, m.to), ccrVf(3, m.castle.rookFrom), ccrVf(4, m.castle.rookTo))));
    return parts;
  };
  const move = (m) => [].concat(
    ccrMf(1, moveInner(m)),
    ccrMf(2, ccrVf(2, m.clockMs || 0)),
  );
  const player = (colour, pl) => [].concat(
    ccrVf(1, colour),
    ccrMf(2, ccrVf(1, pl.elo || 0)),
    pl.uuid ? ccrMf(3, ccrSf(1, pl.uuid)) : [],
    ccrSf(4, pl.name || ''),
  );
  const moves = g.moves.reduce((a, m) => a.concat(ccrMf(2, move(m))), []);
  const meta = ccrMf(3, [].concat(
    ccrMf(1, player(1, g.white)),
    ccrMf(1, player(2, g.black)),
    ccrMf(2, ccrMf(1, ccrVf(1, g.tcMs || 0))),
    ccrMf(6, [].concat(ccrSf(1, g.reqUuid), ccrVf(2, g.gameId || 0), ccrVf(4, g.winner || 0))),
    ccrVf(10, 0),
  ));
  const game = moves.concat(meta);
  const inner = [].concat(ccrMf(1, game), ccrMf(3, ccrVf(3, 1)));
  return [].concat(
    ccrMf(1, ccrMf(1, inner)),
    ccrMf(2, ccrMf(3, ccrVf(1, 2))),
    ccrVf(3, g.strength || 10),
    ccrMf(4, ccrVf(1, 1)),
    ccrMf(5, [].concat(ccrVf(1, 1), ccrVf(2, 2), ccrMf(3, [].concat(ccrVf(1, g.ts || 0), ccrVf(2, g.ns || 0))))),
    ccrMf(6, [].concat(ccrVf(4, 5), ccrVf(5, 1))),
    ccrMf(7, [].concat(ccrSf(1, g.coach || 'Generic_coach'), ccrSf(2, g.locale || 'en-US'))),
  );
}
// <<< CCR_PROTO_END

// >>> CCR_DECODE_BEGIN  (pure; the ladder slices this and decodes the captured 5107-byte response)
function ccrWalk(b) {
  const out = []; let i = 0;
  const varint = () => { let v = 0, s = 0; for (;;) { const x = b[i++]; v += (x & 0x7f) * 2 ** s; if (!(x & 0x80)) return v; s += 7; } };
  while (i < b.length) {
    const t = varint(), f = t >>> 3, w = t & 7;
    if (w === 0) out.push({f, w, v: varint()});
    else if (w === 5) { out.push({f, w, v: new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true)}); i += 4; }
    else if (w === 1) { out.push({f, w, v: new DataView(b.buffer, b.byteOffset + i, 8).getFloat64(0, true)}); i += 8; }
    else if (w === 2) { const ln = varint(); out.push({f, w, v: b.subarray(i, i + ln)}); i += ln; }
    else break;
  }
  return out;
}
const ccrSub = (b, f) => { const e = b && ccrWalk(b).find(x => x.f === f && x.w === 2); return e ? e.v : null; };
const ccrSubs = (b, f) => (b ? ccrWalk(b).filter(x => x.f === f && x.w === 2).map(x => x.v) : []);
const ccrNum = (b, f) => { const e = b && ccrWalk(b).find(x => x.f === f && (x.w === 0 || x.w === 5)); return e ? e.v : null; };
const ccrStr = (b, f) => { const v = ccrSub(b, f); return v ? new TextDecoder().decode(v) : null; };
const ccrAlg = (n) => (n >= 1 && n <= 64) ? 'abcdefgh'[(n - 1) % 8] + (Math.floor((n - 1) / 8) + 1) : null;

function ccrIsMsg(b) {
  try {
    let i = 0, n = 0;
    const vi = () => { let v = 0, s = 0; for (;;) { const x = b[i++]; v += (x & 0x7f) * 2 ** s; if (!(x & 0x80)) return v; s += 7; } };
    while (i < b.length) {
      const t = vi(), f = t >>> 3, w = t & 7;
      if (f === 0 || w === 3 || w === 4 || w === 6 || w === 7) return false;
      if (w === 0) vi(); else if (w === 1) i += 8; else if (w === 5) i += 4;
      else { const ln = vi(); if (i + ln > b.length) return false; i += ln; }
      n++;
    }
    return i === b.length && n > 0;
  } catch (e) { return false; }
}

function ccrText(b) {
  const parts = [];
  const rec = (x) => {
    for (const {f, w, v} of ccrWalk(x)) {
      if (w !== 2 || f === 2) continue;
      if (ccrIsMsg(v)) { rec(v); continue; }
      let txt = null;
      try { txt = new TextDecoder('utf-8', {fatal: true}).decode(v); } catch (e) { txt = null; }
      if (txt != null && /[a-zA-Z]/.test(txt) && !/[\x00-\x08\x0e-\x1f]/.test(txt)) parts.push(txt);
    }
  };
  rec(b);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function ccrDecodeReview(outer) {
  const game = ccrSub(outer, 2);
  if (!game) return null;
  const summary = ccrSub(game, 2);
  const acc = ccrSub(summary, 3);
  const s5 = ccrSub(summary, 5);
  const op = ccrSub(game, 6);
  const md = ccrSub(game, 3);
  const moves = ccrSubs(md, 3).map((e) => {
    const a = ccrSub(e, 2);
    const ft = ccrSub(a, 1);
    return {
      from: ccrAlg(ccrNum(ft, 1)),
      to: ccrAlg(ccrNum(ft, 2)),
      // the played move's classification is a.f3 (a.f4.f3 is a constant book/eval tag -- 13 -- not this)
      classification: ccrNum(a, 3),
      commentary: ccrText(ccrSub(a, 5)),
    };
  });
  return {
    accuracy: acc ? {white: ccrNum(acc, 1), black: ccrNum(acc, 2)} : null,
    ratings: s5 ? {white: ccrNum(ccrSub(s5, 1), 4), black: ccrNum(ccrSub(s5, 2), 4)} : null,
    summaryLine: ccrStr(s5, 3),
    opening: op ? {name: ccrStr(op, 1), eco: ccrStr(op, 3)} : null,
    headline: ccrStr(md, 1),
    moves,
  };
}

function ccrDecodeFrames(rawFrames) {
  let progress = null, review = null;
  for (const bytes of rawFrames) {
    for (const {f, w, v} of ccrWalk(bytes)) {
      if (w !== 2) continue;
      if (f === 1) { const pf = ccrWalk(v).find(x => x.f === 1 && x.w === 5); if (pf) progress = pf.v; }
      else if (f === 2) review = ccrDecodeReview(v);
    }
  }
  return {progress, review};
}
// <<< CCR_DECODE_END

function toB64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}
function b64ToU8(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// THE SOCKET RUNS FROM A CHESS.COM PAGE, NOT FROM US. chess.com's v2 review authenticates by the
// FIRST-PARTY session: the site's own request carries Origin: https://www.chess.com and the logged-in
// cookies. A websocket opened from the extension's service worker carries Origin:
// chrome-extension://<id> and no chess.com cookies, and 1008s -- and DNR cannot rewrite a
// service-worker websocket handshake (measured: the rule is added but never matches the request). So
// the socket is opened in the MAIN world of a logged-in chess.com tab, where the browser attaches the
// right Origin and cookies natively. This is the tt-probe / cb-probe pattern: page context does what
// the extension context cannot. No cookie blob, nothing to keep fresh -- just a logged-in tab.
//
// Injected as a stringified function, so it must be SELF-CONTAINED (no closures, no worker consts).
function ccrPageSocket(b64) {
  return new Promise((resolve) => {
    let bytes;
    try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    catch (e) { return resolve({error: 'bad payload'}); }
    let ws;
    try { ws = new WebSocket('wss://analysis.chess.com/v2/game-review'); }
    catch (e) { return resolve({error: 'websocket refused: ' + e.message}); }
    ws.binaryType = 'arraybuffer';
    const frames = [];
    let settled = false;
    const done = (extra) => { if (settled) return; settled = true; try { ws.close(); } catch (e) {} resolve(Object.assign({frames}, extra)); };
    const timer = setTimeout(() => done({note: 'stopped after 90s (no known terminal frame yet)'}), 90000);
    ws.onopen = () => { try { ws.send(bytes); } catch (e) { clearTimeout(timer); done({error: 'send failed: ' + e.message}); } };
    ws.onmessage = (ev) => {
      const u = new Uint8Array(ev.data); let bin = '';
      for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
      if (frames.length < 300) frames.push(btoa(bin));
    };
    ws.onerror = () => { /* the close event carries the code */ };
    ws.onclose = (ev) => { clearTimeout(timer); done({closeCode: ev.code, closeReason: ev.reason || ''}); };
  });
}

// Resolve when the tab finishes loading, or after a timeout -- chess.com is heavy, but the socket
// only needs the tab's ORIGIN (for its first-party cookies), which is live long before load finishes,
// so the timeout is a floor, not a failure.
function ccrWaitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {} resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    try { chrome.tabs.onUpdated.addListener(onUpd); } catch (e) { return resolve(); }
    setTimeout(finish, timeoutMs);
  });
}

// The socket must run in a logged-in chess.com tab (native Origin + first-party session cookie). If
// one is already open we borrow it; otherwise we open one in the BACKGROUND -- the session cookie
// lives in the browser profile, so a fresh tab carries it -- and the caller closes it again after.
async function ccrEnsureTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({url: ['*://www.chess.com/*', '*://chess.com/*']}); } catch (e) { /* */ }
  const existing = tabs.find((t) => t.id != null);
  if (existing) return {tab: existing, spawned: false};
  let tab;
  try { tab = await chrome.tabs.create({url: 'https://www.chess.com/', active: false}); }
  catch (e) { return {error: `could not open a chess.com tab (${e.message})`}; }
  await ccrWaitComplete(tab.id, 15000);
  return {tab, spawned: true};
}

async function chesscomAnalyze({game}) {
  if (!game || !Array.isArray(game.moves) || !game.moves.length) return {error: 'no game to send'};
  let bytes;
  try { bytes = new Uint8Array(ccrEncodeGameReview(game)); }
  catch (e) { return {error: `encode failed: ${e.message}`}; }
  const b64 = toB64(bytes);

  const found = await ccrEnsureTab();
  if (found.error) return {sentBytes: bytes.length, error: `${found.error} - or open chess.com in a tab and log in, then retry`, needChesscomTab: true};
  const tab = found.tab;
  try {
    let res;
    try {
      const out = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: ccrPageSocket, args: [b64]});
      res = out && out[0] && out[0].result;
    } catch (e) { return {sentBytes: bytes.length, error: `could not run in the chess.com tab (${e.message}) - reload that tab and retry`}; }
    if (!res) return {sentBytes: bytes.length, error: 'the chess.com tab returned nothing'};
    if (res.error) return {sentBytes: bytes.length, sentB64: b64, viaTab: tab.url, spawnedTab: found.spawned, error: res.error};

    const frames = (res.frames || []).map((f) => ({b64: f, len: b64ToU8(f).length}));
    let decoded = null;
    try { decoded = ccrDecodeFrames((res.frames || []).map(b64ToU8)); } catch (e) { decoded = {error: String(e.message || e)}; }
    return {sentBytes: bytes.length, sentB64: b64, viaTab: tab.url, spawnedTab: found.spawned, decoded, frames, closeCode: res.closeCode, closeReason: res.closeReason, note: res.note};
  } finally {
    // close ONLY a tab we opened; one the user already had stays put.
    if (found.spawned) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* */ } }
  }
}

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
            ? 'Lichess needs an API token for the opening explorer - Settings → General → Lichess API token'
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
  if (src.tabId) { attached.delete(src.tabId); lastPos.delete(src.tabId); puzzleNetTabs.delete(src.tabId); }
});

// --- reading puzzle payloads over the debugger -----------------------------------------------------
// WHY THIS EXISTS RATHER THAN A PAGE PATCH. The page-world probe wraps fetch, XHR and the Response
// body readers, and on most sites that is enough. On chess.com's Puzzle Rush it is not: their bundle
// takes its own reference to fetch before a MAIN-world content script can install, so the request
// that carries the puzzles never passes through anything we own. Measured repeatedly -- 16-20KB of
// puzzles returned by /callback/tactics/challenge/puzzles while the probe recorded seen=0.
//
// The debugger sees the response whatever the page did to get it. We already hold that permission and
// already stay attached for autoplay's clicks, so the cost here is the attachment lasting while a
// puzzle page is open, which is exactly what the setting is for. It is OPT-IN and off by default: the
// attachment raises Chrome's "being debugged" infobar, and that is the user's call to make, not ours.
const puzzleNetTabs = new Set();          // tabs we have enabled the Network domain on
const PUZZLE_BODY_URL = /\/(callback\/tactics|puzzles?|tactics|training|storm|racer)\b|challenge\/puzzles|puzzle/i;
const PUZZLE_BODY_MAX = 4e6;
// Diagnostics only, parallel to the content script's counters: "off", "attached but the page sent
// nothing", and "sent bodies we forwarded" are three different states and one flag cannot tell them
// apart. Read via self.puzzleNetDebug().
const puzzleNet = {matched: 0, forwarded: 0, urls: []};
self.puzzleNetDebug = () => ({tabs: [...puzzleNetTabs], ...puzzleNet, urls: puzzleNet.urls.slice(-6)});

// Both toggles, read fresh: values are JSON strings in this store, and "false" is a truthy string.
async function puzzleNetWanted() {
  try {
    const c = await chrome.storage.local.get(['puzzle_mode', 'puzzle_capture', 'puzzle_capture_cdp']);
    const on = (k) => { try { return JSON.parse(c[k] ?? 'false') === true; } catch (e) { return false; } };
    return on('puzzle_mode') && on('puzzle_capture') && on('puzzle_capture_cdp');
  } catch (e) { return false; }
}

// A puzzle page finished loading: if the user asked for it, stay attached and watch the network.
chrome.tabs?.onUpdated?.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab?.url || '';
  if (!/^https?:\/\/(www\.)?(chess\.com|lichess\.org)\//.test(url)) return;
  if (!/\/(puzzles|training|storm|racer|lessons\/practice)\b/.test(url)) return;
  if (!(await puzzleNetWanted())) return;
  try { await puzzleNetEnable(tabId); } catch (e) { /* the user can decline the attachment */ }
});

async function puzzleNetEnable(tabId) {
  if (puzzleNetTabs.has(tabId)) return;
  await cdpAttach(tabId);
  await new Promise((res) => chrome.debugger.sendCommand({tabId}, 'Network.enable', {}, () => {
    void chrome.runtime.lastError; res();
  }));
  puzzleNetTabs.add(tabId);
}

chrome.debugger.onEvent?.addListener((src, method, params) => {
  if (method !== 'Network.responseReceived' || !src.tabId || !puzzleNetTabs.has(src.tabId)) return;
  try {
    const url = params?.response?.url || '';
    const mime = params?.response?.mimeType || '';
    if (!/json/i.test(mime) || !PUZZLE_BODY_URL.test(url)) return;
    puzzleNet.matched++;
    puzzleNet.urls.push(url.replace(/^https?:\/\/[^/]+/, '').slice(0, 80));
    // The body is only fetchable for a short window after the response lands, so ask straight away
    // rather than waiting for loadingFinished.
    setTimeout(() => {
      chrome.debugger.sendCommand({tabId: src.tabId}, 'Network.getResponseBody',
        {requestId: params.requestId}, (r) => {
          if (chrome.runtime.lastError || !r || r.base64Encoded || typeof r.body !== 'string') return;
          if (!r.body || r.body.length > PUZZLE_BODY_MAX) return;
          puzzleNet.forwarded++;
          // Inject the body straight into the page's MAIN world, where the probe lives, as a fixed
          // 'm7' event. It MUST land in the main world: a content script cannot pass an event detail
          // to the page (isolated->main hands over null), so bouncing through the content script
          // silently dropped the body. executeScript's args cross worlds cleanly, and the dispatch
          // then happens in the same world as the listener.
          try {
            chrome.scripting.executeScript({
              target: {tabId: src.tabId}, world: 'MAIN',
              func: (body) => { try { document.dispatchEvent(new CustomEvent('m7', {detail: body})); } catch (e) { /* */ } },
              args: [r.body],
            }).catch(() => { /* tab navigated or closed */ });
          } catch (e) { /* tab gone */ }
        });
    }, 60);
  } catch (e) { /* a diagnostic path must never break the worker */ }
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
let snapCaptureMs = 0, snapRecogniseMs = 0, snapBytes = 0, snapStages = null;
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
    snapStages ? `stages=decode${snapStages.decodeMs}/detect${snapStages.detectMs}/read${snapStages.readMs}`
               + `${snapStages.cachedBox ? '(box cached)' : ''}${snapStages.boxMisses ? ` misses=${snapStages.boxMisses}` : ''}`
               : 'stages=none',
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
      ' - run native-host/install-native.sh once (see the README).';
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
