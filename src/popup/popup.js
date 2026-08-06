// Loaded as a CLASSIC script in two places: the popup PAGE (toolbar popup) and, once the panel
// moves in-page, the content-script isolated world. It can't be an ES module (content scripts
// aren't) and must not be dynamic-imported (that needs web_accessible_resources and leaks the
// extension id via Resource Timing -- issue #35 §3.4). IIFE-wrapped so its globals (config,
// engine, board, ...) can't collide with content-script.js's in the shared isolated world.
(function () {

// the tab this popup iframe was injected into (passed by the content-script). Everything this popup
// sends/receives is scoped to THIS tab, so a background tab's popup can't drive the foreground tab
// or turn on its modes. Null only if opened before the content-script learned its id (falls back).
let MY_TAB_ID = parseInt(new URLSearchParams(location.search).get('tab'), 10) || null;
let PANEL_BOOTED = false; // popup.js also loads on every chess page as a content script --
// its listeners must stay inert until THIS tab's panel is actually opened.

// When shown as the toolbar POPUP (Panel Style = "popup") this page is top-level; when shown as the
// floating panel it's an iframe the content-script scales down itself. Only the top-level toolbar
// popup renders at full 568x672, so shrink just that one (CSP blocks an inline <head> script, so we
// tag it here — a brief flash as the popup opens is fine). The floating iframe is left untouched.
if (location.protocol === 'chrome-extension:' && window.top === window.self) {
    document.documentElement.classList.add('toolbar-popup'); // real toolbar popup only, never the host page
}

// Where the panel's own DOM lives. It's `document` while the panel is an iframe (and the toolbar
// popup); Phase 4c repoints PANEL_ROOT at the closed shadow root when the panel moves in-page, and
// the panel's element lookups go through it. (Global page listeners -- pointerdown/visibilitychange
// for keep-alive -- stay on `document`.)
// popup.js runs in two contexts. As a CONTENT SCRIPT (panel in-page) chrome.tabs doesn't exist and
// runtime.sendMessage can't reach content-script.js -- but it shares our realm, so we call it
// directly. As the toolbar popup it's a real extension page and must use tabs messaging.
const IS_CONTENT_SCRIPT = (location.protocol !== 'chrome-extension:');
let PANEL_MSG_HANDLER = null; // content-script -> panel, invoked directly when in-page
let PANEL_ROOT = document;
const BOARD_THEMES = ['brown','red','orange','tan','green','sky','blue','purple','grey','wood','marble','newspaper'];
let PANEL_ASSETS = null; // {pieces:{wP:dataURI,...}} when the panel is in-page
let PANEL_TIP_HOST = document.body || document.documentElement;

let engine;
let board;
let fen_cache;
let config;

// Warm-engine tracking so a closed-then-reopened panel skips the expensive engine re-init (net
// reload). popup.js module state -- including the offscreen engine keyed by ENGINE_CLIENT -- survives
// panel close (only the DOM is torn down), so a reopen can reuse the loaded engine instead of
// disposing and reloading its NNUE. Reset on engine crash (initialize_engine reruns) and naturally
// on tab close (the whole context dies).
let engine_ready = false;
let last_init_engine = null;
let last_init_variant = null;
let last_init_maia = null; // Maia rating at last init; a change loads a different net (part of net identity)
let last_init_fp = null; // fingerprint of the engine-affecting config at last init; unchanged => skip setup

let turn_override = null;      // header king switch: 'w'|'b' forced side to move, or null (auto). Transient.
let turn_detected_prev = null; // last RAW detected side; when it changes, the override auto-clears.

// Swap a FEN's side-to-move (and drop the now-invalid en-passant square). Used by the manual turn
// override to hand the move to the other side.
function flip_fen_turn(fen) {
    const p = fen.split(' ');
    p[1] = (p[1] === 'w') ? 'b' : 'w';
    if (p.length > 3) p[3] = '-';
    return p.join(' ');
}

let is_calculating = false;
// UI language. `i18n(key, english, vars)` -- the English is written at the call site so the source
// still reads as English prose and a missing key can never render blank.
const i18n = (key, dflt, vars) => {
    // NEVER throws. This runs on the scrape/response path as well as on labels, so when i18n.js was
    // missing from the toolbar popup the first lookup took initPanel down and every later response
    // with it -- one absent script tag presenting as a dead scraper. English is always a usable
    // answer, so fall back to the call site's own text rather than propagating.
    try { return MephistoI18n.t(key, dflt, vars); } catch (e) {
        return vars ? String(dflt).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : dflt;
    }
};

// Background-play tracing from the PANEL side, to the service worker's own console -- see bgLog in
// the content-script for why not this page's. Silent while the tab is active. Without this half, a
// silent log is ambiguous: "the panel never issued a move" and "the content-script dropped it" look
// identical from the other end.
function bgTrace(...args) {
    try {
        if (document.visibilityState === 'visible' && document.hasFocus()) return;
        chrome.runtime.sendMessage({bgTrace: {from: 'panel', args: args.map((v) => {
            if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
            try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
        })}}, () => void chrome.runtime.lastError);
    } catch (e) { /* extension context gone */ }
}

// The panel cannot read the locale files itself: it runs in the page's isolated world, where a fetch
// of a chrome-extension:// URL is blocked (web_accessible_resources is deliberately empty). The
// service worker reads them and sends both the chosen language and English underneath it.
function load_language(lang) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({i18nStrings: {lang}}, (res) => {
                if (!chrome.runtime.lastError && res && !res.error) {
                    MephistoI18n.setFallback(res.en || res.strings);
                    MephistoI18n.setStrings(lang, res.strings || res.en);
                }
                resolve();
            });
        } catch (e) {
            resolve(); // extension context gone -- English, which is what the markup already says
        }
    });
}

// Re-translate the panel in place. Cheap (it walks the panel's own small DOM) and it is the only
// thing a language change needs, since every string in the markup carries its key.
function apply_language() {
    MephistoI18n.apply(PANEL_ROOT);
    annotate_hotkey_labels(); // the "(A)" suffixes are appended to label text -- redo them after
    update_best_move(null);   // re-render the readout with the new confidence/tablebase suffixes
}

let pending_stops = 0; // bestmoves still owed by searches we abandoned -- drop that many (see abandon_search)
// Remote/native supersession. `pending_stops` only protects the WASM path -- on_engine_response
// returns early for is_remote(), so a request issued for an OLD position used to be acted on
// whenever it resolved late, playing a move computed for a position that is no longer on the board.
// Every remote analysis carries the generation it was issued in; a resolved response from an older
// generation is dropped. Bumped when a new analysis is issued and when a search is abandoned.
let remote_gen = 0;
// The position an analyse is currently OUT for on a native host. The panel supersedes results
// client-side, but nothing cancels the abandoned search at the host -- `send_engine_uci('stop')` is
// a no-op for native engines -- so a duplicate push for the SAME position issues a second search
// that queues behind the first. The panel then drops the first as superseded and waits on a second
// the host has not begun. Observed as two identical `on_new_pos` lines, one "dropping a superseded
// remote result", and then silence. One request per position fixes it at the source.
let native_inflight = null;
let search_active = false; // a 'go' was issued whose bestmove hasn't arrived yet (is_calculating can't be
                           // used for this: it flips false on the first info line, not on bestmove)
let last_pos = {startFen: null, moves: ''}; // the position's own start + UCI move list, for Copy PGN
let premove_tracker = {fen: '', lines: {}}; // per-multipv reply stability while the opponent thinks
let search_threads_set = null; // last Threads value pushed to the engine; opponent-turn search is capped unless Pondering
let remote_multipv_set = null; // last MultiPV pushed to a NATIVE host (it stores options; the analyse request has none)
let premove_lines = 2; // top-N lines premove tracks/certifies; widened to the ponder width while pondering (see ponder_line_count)
let prog = 0;
let last_eval = {fen: '', activeLines: 0, lines: []};
let detected_prefix = null; // which site the last scrape came from ('li'/'cc'/'bt'/'tt')
let last_clocks = null;   // {mine, theirs, increment, at} scraped off the page (Clock Mode)
let last_our_eval = null; // our-perspective cp after our previous move (humanize criticality)
let opp_clock_mark = null; // opponent's clock when their turn started...
let opp_spend = null;      // ...so their spend on their LAST move = mark - now (Clock Mode mirroring)
let prev_ply_count = 0;    // plies in the last-seen position; a drop back to the start = a NEW GAME

// Maia's strength IS the net (a rating-conditioned one for maia3), so UCI_Elo means nothing to it
// and the Elo row is hidden rather than shown doing nothing. Its nets are standard-chess only, so
// Chess960 is off the table too.
const NO_CHESS960_ENGINES = ['maia', 'maia3'];
const NO_ELO_ENGINES = ['maia', 'maia3'];

// engines that speak native messaging (Chrome auto-launches the host, no server -- see
// native-host/install-native.sh). The port name == the engine value (see NATIVE_HOSTS).
const NATIVE_ENGINES = ['sf-native', 'fairy-native', 'tetrarch-native'];
// FOUR-PLAYER. Tetrarch plays 14x14 4PC, which chess.js cannot represent at all -- so this
// engine does NOT ride the normal pipeline: no chess.js legality, no premove, no arrows. It is
// offered only on chess.com's 4PC pages and drives the bypass lane (see FOURPC_SITES).
const FOURPC_ENGINES = ['tetrarch-native'];
// What to fall back to when leaving 4PC with no remembered engine -- bundled, needs no native host,
// and plays standard chess, which is the whole point of the fallback.
const FOURPC_FALLBACK_ENGINE = 'stockfish-18-nnue';
// native engines that ARE full Fairy-Stockfish -> offer the whole variant list, like the WASM Fairy
const FAIRY_ENGINES = ['fairy-stockfish-14-nnue', 'fairy-native'];

// The variants our bundled chess.js can actually REPLAY. The dropdown offers four more (Duck,
// Minihouse, Seirawan, Chaturanga) because Fairy ships nets for them and the engine can evaluate
// them -- but chess.js can't, and `new Chess(<unknown variant>)` does NOT throw: it silently falls
// back to the standard start position (see its constructor -> _getDefaultStartingPosition). So the
// scrape would be replayed as an ordinary game and analysed as the wrong position entirely, with
// nothing on screen to say so. `set_detection_status` turns that silence into a plain message.
const CHESSJS_VARIANTS = ['chess', 'fischerandom', 'crazyhouse', 'kingofthehill', '3check',
                          'antichess', 'atomic', 'horde', 'racingkings'];

// UCI_Elo [min, max] per engine, taken from each engine's own source (out-of-range values are
// silently ignored by Stockfish, so the slider must stay within these): modern SF uses
// Skill::LowestElo/HighestElo = 1320/3190; SF 11 = 1350/2850; Fairy-SF 14 = 500/2850.
const ELO_RANGE = {
    'stockfish-dev-nnue': [1320, 3190],
    'stockfish-18-nnue': [1320, 3190],
    'stockfish-18-small-nnue': [1320, 3190],
    'stockfish-11-hce': [1350, 2850],
    'fairy-stockfish-14-nnue': [500, 2850],
    // full-power native engines (real Stockfish/Fairy -> same UCI_Elo ranges)
    'sf-dev-native': [1320, 3190],
    'sf18-native': [1320, 3190],
    'sf11-native': [1350, 2850],
    'fairy-native': [500, 2850],
    'remote': [1320, 3190], // unknown engine; assume the modern SF range
};
// Sits above every engine's ceiling (max is 3190), so it reads as "no cap / full strength".
// Both slider ends map to full strength: 0 on the left (Off) and this on the right.
const FULL_STRENGTH_ELO = 3200;
// Slider stops: index 0 = 0 (Off / full strength), then the engine's range in 50-Elo steps with
// the true max always included, and FULL_STRENGTH_ELO as the final right-hand "3200+" stop.
function elo_stops(engine) {
    const [min, max] = ELO_RANGE[engine] || [1320, 3190];
    const stops = [0];
    for (let e = min; e < max; e += 50) stops.push(e);
    stops.push(max);
    stops.push(FULL_STRENGTH_ELO);
    return stops;
}

let turn = ''; // 'w' | 'b'

// --- Background keep-alive --------------------------------------------------------------------
// Chrome throttles timers in a hidden tab and freezes it after ~5 min, so alt-tabbing to another
// app (or a fullscreen window) mid-game would stall autoplay. A tab that is playing audio is exempt
// from both, so while Autoplay is on we run a single inaudible tone. Browsers require a user gesture
// to start audio, so this is (re)started from the popup's own clicks and on visibility changes
// (once the user has interacted, sticky activation lets resume() work even after tabbing away).
let keep_alive_ctx = null;
// STICKY ACTIVATION. Browsers refuse to start audio before the user has interacted with the page, but
// once they have, the permission STICKS -- creating an AudioContext later is allowed and silent.
// Tracking that is what lets every caller arm the tone, instead of only the two that happen to be
// user gestures themselves. Without it, turning Background Play on from the OPTIONS PAGE armed
// nothing: watch_config_changes calls in with allowCreate=false, keep_alive returned immediately at
// the `!keep_alive_ctx` check, and the setting was on while the exemption that makes it work was
// not. Whether the feature worked came down to where you had clicked, which nothing told you.
let user_has_gestured = false;
// allowCreate is true ONLY when called from a real user gesture -- creating/resuming an AudioContext
// without one logs Chrome's "AudioContext was not allowed to start" warning, so non-gesture callers
// (page load, visibilitychange) only resume an already-created context (sticky activation permits that).
// The tone is only worth its cost when moves are actually meant to fire while the tab is hidden.
function keep_alive_wanted() {
    return !!(config.autoplay && config.background_play);
}

function keep_alive(active, allowCreate = false) {
    try {
        if (active) {
            if (!keep_alive_ctx) {
                // `allowCreate` = this call IS a gesture; `user_has_gestured` = one already happened
                // and the permission stuck. Either is enough; neither means it would warn, so don't.
                if (!allowCreate && !user_has_gestured) return;
                keep_alive_ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = keep_alive_ctx.createOscillator();
                const gain = keep_alive_ctx.createGain();
                gain.gain.value = 0.001; // ~-60 dB: inaudible, but nonzero so the tab counts as "audible"
                osc.connect(gain).connect(keep_alive_ctx.destination);
                osc.start();
            }
            if (keep_alive_ctx.state !== 'running') keep_alive_ctx.resume().catch(() => {});
        } else if (keep_alive_ctx && keep_alive_ctx.state === 'running') {
            keep_alive_ctx.suspend().catch(() => {});
        }
    } catch (e) { /* Web Audio unavailable -> background throttling stays; no worse than before */ }
}

async function initPanel(root, tabId) {
    // root = the closed shadow root when the panel lives in-page (4c-2); unset in the popup PAGE
    // (toolbar popup), where the panel owns the whole document.
    if (root) { PANEL_ROOT = root; PANEL_TIP_HOST = root; }
    else { PANEL_TIP_HOST = document.body || document.documentElement; }
    if (tabId != null) { MY_TAB_ID = tabId; ENGINE_CLIENT = String(tabId); } // no ?tab= when in-page
    PANEL_BOOTED = true;
    // The 4PC lane keeps its own dedupe, and popup.js is a CONTENT SCRIPT -- it survives the panel
    // being closed and reopened on the same page. So `fourpc_last` still held the position on screen,
    // the reopened panel deduped its very first scrape, and nothing appeared until someone moved or
    // the page was reloaded. `fourpc_busy` is worse: closing mid-search left it true forever, and
    // every later position was queued behind a search that would never report.
    // `board4pc` is the same trap one step further on: the renderer holds a reference to the #board
    // element it was built against, and a reopened panel builds a NEW one. Left set, `show_4pc_board`
    // saw a non-null renderer, skipped constructing one, and painted 14x14 into a detached element --
    // so the panel detected the game, sized the pieces, drew the arrow, and showed the 8x8 board.
    fourpc_last = ''; fourpc_busy = false; fourpc_pending = null; board4pc = null;
    await MephistoConfig.init(); // load config from chrome.storage.local into the sync cache first
    // load extension configurations from the config store (chrome.storage.local, cached)
    const computeTime = JSON.parse(MephistoConfig.get('compute_time'));
    const fenRefresh = JSON.parse(MephistoConfig.get('fen_refresh'));
    const thinkTime = JSON.parse(MephistoConfig.get('think_time'));
    const thinkVariance = JSON.parse(MephistoConfig.get('think_variance'));
    const moveTime = JSON.parse(MephistoConfig.get('move_time'));
    const moveVariance = JSON.parse(MephistoConfig.get('move_variance'));
    const autoplay = JSON.parse(MephistoConfig.get('autoplay'));
    const computerEval = JSON.parse(MephistoConfig.get('computer_evaluation'));
    // engines dropped in this version — migrate stale selections to the current default
    const REMOVED_ENGINES = ['stockfish-6', 'stockfish-16-nnue-40', 'stockfish-16-nnue-7', 'lc0', 'stockfish-17-nnue-79'];
    let storedEngine = JSON.parse(MephistoConfig.get('engine'));
    if (REMOVED_ENGINES.includes(storedEngine)) storedEngine = null;
    config = {
        // general settings
        engine: storedEngine || 'stockfish-dev-nnue',
        variant: JSON.parse(MephistoConfig.get('variant')) || 'chess',
        elo: JSON.parse(MephistoConfig.get('elo')) || 0, // strength cap; 0 = full strength (no UCI_LimitStrength)
        maia_level: JSON.parse(MephistoConfig.get('maia_level')) || '1500', // which Maia net (rating band) when engine=maia
        maia3_elo: JSON.parse(MephistoConfig.get('maia3_elo')) || 1500, // Maia-3 target Elo (600-2600, live input, not a reload)
        compute_time: (computeTime != null) ? computeTime : 300,
        fen_refresh: (fenRefresh != null) ? fenRefresh : 1000, // FALLBACK poll; positions arrive event-driven
        multiple_lines: JSON.parse(MephistoConfig.get('multiple_lines')) || 1,
        threads: JSON.parse(MephistoConfig.get('threads')) || MephistoConfig.defaultThreads(),
        memory: JSON.parse(MephistoConfig.get('memory')) || 512,
        think_time: (thinkTime != null) ? thinkTime : 0,
        think_variance: (thinkVariance != null) ? thinkVariance : 0,
        move_time: (moveTime != null) ? moveTime : 400, // ms of cursor travel to the target square (M2)
        move_variance: (moveVariance != null) ? moveVariance : 400,
        humanize: JSON.parse(MephistoConfig.get('humanize')) || false,
        clock_mode: JSON.parse(MephistoConfig.get('clock_mode')) || false,
        mirror_mode: JSON.parse(MephistoConfig.get('mirror_mode')) || false,
        // Manual Mode: the engine searches until YOU press the play-move hotkey, then it plays the
        // best move it found. Your own timing -- overrides the clock-pacing modes and never auto-fires.
        manual_mode: JSON.parse(MephistoConfig.get('manual_mode')) || false,
        // Opponent-mistake toast: flag when the opponent plays an inaccuracy/mistake/blunder (Lichess
        // win% method), but only when both evals reached a trustworthy depth.
        opp_alert: JSON.parse(MephistoConfig.get('opp_alert')) || false,
        computer_evaluation: (computerEval != null) ? computerEval : true,
        threat_analysis: JSON.parse(MephistoConfig.get('threat_analysis')) || false,
        simon_says_mode: JSON.parse(MephistoConfig.get('simon_says_mode')) || false,
        autoplay: (autoplay != null) ? autoplay : false,
        premove: JSON.parse(MephistoConfig.get('premove')) || false,
        // Pondering (settings page only): keep searching, at full threads, while it's the OPPONENT's
        // turn -- burn the wait on a deeper reply. OFF (default) still analyses the opponent's turn for
        // premove/threat/help, but capped to 1 thread so idle time isn't a full-core burn.
        ponder: JSON.parse(MephistoConfig.get('ponder')) || false,
        tablebase: JSON.parse(MephistoConfig.get('tablebase')) || false,
        move_reason: JSON.parse(MephistoConfig.get('move_reason')) || false,
        eval_history: JSON.parse(MephistoConfig.get('eval_history')) || false,
        // Opening explorer: `explorer` draws the overlay, `book_play` actually plays a weighted-random
        // book move. Two independent toggles -- turning on the overlay must never change how you play.
        // Blur the opponent's name and avatar on the page. For screenshots and screen sharing --
        // a real person's username should not end up in a bug report or a README.
        hide_opponent: JSON.parse(MephistoConfig.get('hide_opponent')) || false,
        explorer: JSON.parse(MephistoConfig.get('explorer')) || false,
        book_play: JSON.parse(MephistoConfig.get('book_play')) || false,
        explorer_db: JSON.parse(MephistoConfig.get('explorer_db') || '"masters"'),
        puzzle_mode: JSON.parse(MephistoConfig.get('puzzle_mode')) || false,
        language: JSON.parse(MephistoConfig.get('language')) || 'en',
        help_mode: JSON.parse(MephistoConfig.get('help_mode')) || false,
        eval_bar: JSON.parse(MephistoConfig.get('eval_bar')) || false,
        python_autoplay_backend: JSON.parse(MephistoConfig.get('python_autoplay_backend')) || false,
        // undetectability: by default only move while the game tab is focused+visible (humans don't
        // play while tabbed away). Opt in to keep autoplay running in the background.
        background_play: JSON.parse(MephistoConfig.get('background_play')) || false,
    };
    Object.assign(config, {
        // appearance settings
        pieces: JSON.parse(MephistoConfig.get('pieces')) || 'wikipedia.svg',
        board: JSON.parse(MephistoConfig.get('board')) || 'brown',
        coordinates: JSON.parse(MephistoConfig.get('coordinates')) || false,
        dark_mode: JSON.parse(MephistoConfig.get('dark_mode')) || false,
        compact: JSON.parse(MephistoConfig.get('compact')) || false,
    });
    panel_body()?.classList.toggle('mephisto-dark', config.dark_mode); // dark theme (set in Appearance)
    apply_compact();
    // Keep-alive tone. Chrome applies intensive timer throttling to a hidden tab after ~5 minutes,
    // which is what actually stops a backgrounded game -- an inaudible oscillator makes the tab count
    // as playing audio, and audible tabs are exempt.
    //
    // Gated on BACKGROUND PLAY, not on Autoplay. It used to run whenever Autoplay was on, which meant
    // a tab that defers its moves anyway (Background Play off, the default) was still marked audible
    // -- Chrome puts a speaker icon on the tab strip for that, so it bought nothing and added a
    // visible tell. Now it runs only when you have actually asked to play in the background.
    const on_gesture = () => { user_has_gestured = true; keep_alive(keep_alive_wanted(), true); };
    document.addEventListener('pointerdown', on_gesture, true); // gesture: may create
    document.addEventListener('keydown', on_gesture, true);     // ...and so is a hotkey
    document.addEventListener('visibilitychange', () => keep_alive(keep_alive_wanted()));
    push_config();
    init_quick_settings();
    maybe_autodetect_variant(); // variant game page -> auto-apply the variant (+ Fairy) once

    // init chess board
    const boardEl = PANEL_ROOT.getElementById('board');
    // clear any stale theme first, then apply -- a missing/unknown value would leave the squares
    // unthemed (falling back to chessboard.css's defaults), which is what "had to switch the board
    // colour to get the board back" looked like.
    BOARD_THEMES.forEach(t => boardEl.classList.remove(t));
    boardEl.classList.add(BOARD_THEMES.includes(config.board) ? config.board : 'brown');
    const [pieceSet, ext] = config.pieces.split('.');
    // In-page panel: piece images MUST be inlined data: URIs. A chrome-extension:// <img src> would
    // surface in the page's Resource Timing and identify the extension (issue #35 §3.4) -- exactly the
    // leak we removed the iframe to avoid. The popup PAGE keeps the plain extension path.
    if (PANEL_ROOT !== document) {
        try {
            const r = await chrome.runtime.sendMessage({getPieces: true, pieceSet, pieceExt: ext});
            if (r && r.pieces) PANEL_ASSETS = {pieces: r.pieces};
        } catch (e) { /* fall back to the path below */ }
    }
    board = MephistoBoard('board', {
        root: PANEL_ROOT, // in-page the board element is inside the shadow root, not `document`
        position: 'start',
        pieceMap: PANEL_ASSETS?.pieces || null,               // in-page: inlined data: URIs
        pieceTheme: `/res/chesspieces/${pieceSet}/{piece}.${ext}`, // popup page: plain extension path
        showNotation: config.coordinates,
        onMove: play_on_panel_board, // click or drag a piece to play it and keep analysing
        needsPromotion: panel_move_promotes, // ask which piece before a promoting move
        legalTargets: panel_legal_targets,   // dots on where the picked-up piece may actually go
    });

    // init fen LRU cache
    fen_cache = new LRU(100);

    // init engine webworker -- reuseWarm=true so a reopen reuses the engine left loaded by the last
    // close (see initialize_engine); a first-ever open has engine_ready=false and does a full init.
    await initialize_engine(true);

    // listen to messages from content-script
    PANEL_MSG_HANDLER = function (response, sender) {
        // popup.js is a content script on EVERY chess page now: stay completely inert unless this
        // tab's panel is actually open, or a panel-less page would act on another tab's traffic.
        if (!PANEL_BOOTED) return;
        // the content-script broadcasts (runtime.sendMessage) reach EVERY tab's popup -- ignore any
        // that came from a different tab's content-script so tabs never cross-talk. (Background
        // messages have no sender.tab and pass through.)
        if (MY_TAB_ID && sender.tab && sender.tab.id !== MY_TAB_ID) return;
        if (response.fenresponse) { // reply received -> the poll interval may fire the next request
            fen_request_inflight = false;
            sync_puzzle_mode_to_page(response.puzzlePage);
            sync_fourpc_engine_to_page(response.fourPCPage);
            clearTimeout(fen_request_timer);
            if (response.clocks) last_clocks = {...response.clocks, at: Date.now()}; // for Clock Mode budgeting
        }
        if (response.fenresponse && response.dom && response.dom !== 'no') {
            // A manually set position OWNS the panel: the page keeps scraping and would otherwise
            // overwrite it on the very next poll (~1s), which is what makes a paste-a-FEN box useless.
            if (setup_fen) return;
            // FOUR-PLAYER: the payload is a FEN4, not anything chess.js can parse. Route it out of
            // the normal pipeline before the parse that would throw on it.
            if (typeof response.dom === 'string' && response.dom.startsWith('4PC:')) {
                on_new_pos_4pc(response.dom.slice(4));
                return;
            }
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            let parsed;
            try {
                parsed = parse_position_from_response(response.dom);
            } catch (e) {
                console.warn('Mephisto: skipping unparseable scrape:', e.message);
                return; // transient scrape garbage — the next poll (100ms) retries
            }
            let {fen, startFen, moves} = parsed;
            cross_check_position(fen); // warns only; never gates the move
            if (!is_legal_position(fen)) {
                // a corrupt/transient scrape (mid-animation, wrong turn guess) can yield an
                // illegal position; feeding one to the wasm engine crashes it (OOB). Skip it.
                console.warn('Mephisto: skipping illegal scraped position:', fen);
                return;
            }
            if (response.displayOnly) {
                // mid-move mirror: just show the settled position on the panel board so it tracks the
                // move in real time. NO analysis/autoplay -- the authoritative full push (sent when the
                // content-script's `moving` clears) drives those.
                board.position(fen);
                return;
            }
            // Manual turn override (header king switch): force which side is to move. STICKY per
            // position -- held while the same position sits on the board so you can toggle back and
            // forth -- and auto-cleared the instant a real move changes the detected side (below) or
            // the panel closes, so normal play keeps auto-tracking. Flipping rewrites the FEN's turn
            // field (dropping the now-invalid en passant); if handing the move to that side would be
            // illegal we refuse the flip. When forced, treat it as a fresh position (no move chain).
            const rawTurn = fen.split(' ')[1];
            if (rawTurn !== turn_detected_prev) { turn_override = null; turn_detected_prev = rawTurn; }
            if (turn_override && turn_override !== rawTurn) {
                const flipped = flip_fen_turn(fen);
                if (is_legal_position(flipped)) { fen = flipped; startFen = flipped; moves = ''; turn = turn_override; }
                else turn_override = null;
            }
            // Header switch mirrors the side we're actually about to analyse (post-override).
            update_turn_badge(fen);
            // `resume` = the tab regained focus with a move still held (see resumeIfDeferred in the
            // content-script). The position is unchanged BY DEFINITION, so this guard would skip the
            // whole block and the held move would never be re-issued -- coming back to the tab just
            // froze. Fall through on a resume instead. Note this deliberately does NOT clear
            // last_eval.fen: premove_instant_reply matches its tracker against it, so leaving it
            // intact lets an already-certified reply fire immediately rather than re-searching.
            if (last_eval.fen !== fen || (response.resume && config.autoplay)) {
                // Clock Mode mirroring: bookkeep the opponent's clock at turn boundaries. When a
                // position lands on OUR turn, they just moved -- their spend = their clock at the
                // start of their turn minus now (they get the increment back after moving). When it
                // lands on THEIR turn, our move went through -- mark where their clock starts.
                const ourColor = (our_side() === 'white') ? 'w' : 'b';
                if (turn === ourColor) {
                    opp_spend = (opp_clock_mark != null && last_clocks?.theirs != null)
                        ? Math.max(0, opp_clock_mark - last_clocks.theirs + (last_clocks.increment || 0))
                        : null;
                } else if (last_clocks?.theirs != null) {
                    opp_clock_mark = last_clocks.theirs;
                }
                // check BEFORE on_new_pos: the tracker belongs to the position we were analysing
                const instant = premove_instant_reply(fen, moves);
                on_new_pos(fen, startFen, moves);
                if (instant) {
                    // SAFETY: a certified reply is only played if it moves OUR piece and (on our
                    // turn) is legal right now. Guards against a stale/mismatched reply making us
                    // click the opponent's move or an illegal move -- discard it, normal search plays.
                    if (premove_reply_playable(fen, instant)) {
                        console.log('Premove: certified instant reply', instant);
                        request_automove(instant);
                    } else {
                        console.warn('Mephisto: discarding premove reply not playable in this position:', instant);
                    }
                }
            }
        } else if (response.pullConfig) {
            push_config();
        } else if (response.warm) {
            // Attach the debugger BEFORE the move measures any squares. Only meaningful for the CDP
            // clicker -- the python backend moves the real mouse and raises no infobar.
            if (config.python_autoplay_backend) return;
            // NO EARLY RETURN ON A MISSING TAB ID. The in-page panel is handed an empty sender
            // (`PANEL_MSG_HANDLER(msg, {})`), so there is no id here and never was -- bailing on it
            // meant the in-page panel, which is every real game, never warmed at all. Send regardless
            // and let the worker fall back to its own authenticated sender.tab, exactly as the click
            // path already does; the id below only matters for the toolbar popup, which has no tab.
            return chrome.runtime.sendMessage({cdpWarm: true, tabId: sender?.tab?.id})
                .then(r => { if (r && r.error) console.warn('CDP warm failed:', r.error); })
                .catch(() => {});
        } else if (response.click) {
            // click the GAME tab (the content-script's sender tab), not whatever tab is active --
            // otherwise a move firing while you're on another tab (e.g. chrome://extensions) dispatches
            // there and fails ("Cannot access a chrome:// URL"). Returned so the in-page caller can
            // AWAIT the click (its cursor travel paces the from->to gap -- see performSimulatedMoveClicks).
            return dispatch_click_event(response.x, response.y, sender?.tab?.id, response.travelMs);
        }
    };
    // Only the toolbar popup needs the runtime listener; in-page, content-script.js calls
    // PANEL_MSG_HANDLER directly (runtime.sendMessage can't cross to a sibling content script).
    if (!IS_CONTENT_SCRIPT) chrome.runtime.onMessage.addListener(PANEL_MSG_HANDLER);

    // FALLBACK poll only: the content-script pushes positions event-driven (MutationObserver);
    // this slow poll just heals a missed push (e.g. a mutation the observer filter skipped).
    // Clamped to >=1s so a legacy saved fen_refresh (10ms era) can't reinstate the old
    // 100-scrapes-a-second polling stampede.
    request_fen();
    setInterval(function () {
        request_fen();
        // Re-assert the keep-alive tone. Chrome can SUSPEND an AudioContext in a hidden tab, and
        // nothing revived it -- the only other caller is visibilitychange, which by definition does
        // not fire while you are still away. Once the tone lapses the tab is throttled again and a
        // backgrounded game quietly stops. Resume-only (no gesture here), and a no-op when the
        // context is already running or Background Play is off.
        keep_alive(keep_alive_wanted());
    }, Math.max(1000, config.fen_refresh));

    // Update check: one message to the SW, which caches for 12h. Silent unless there is genuinely a
    // newer release -- a failed or rate-limited check leaves the notice hidden, exactly as if the
    // build were current. Clicking it opens the release page via the background (window.open from a
    // content script runs in the SITE's context and gets swallowed).
    check_for_update();
    watch_config_changes();
    // a reload (Engine/Variant/Elo) rebuilds this script -- bring back any position that was set
    restore_setup_state();

    // register button click listeners
    PANEL_ROOT.getElementById('analyze').addEventListener('click', () => {
        const variantNameMap = {
            'chess': 'standard',
            'fischerandom': 'chess960',
            'crazyhouse': 'crazyhouse',
            'kingofthehill': 'kingOfTheHill',
            '3check': 'threeCheck',
            'antichess': 'antichess',
            'atomic': 'atomic',
            'horde': 'horde',
            'racingkings': 'racingKings',
        }
        const variant = variantNameMap[config.variant];
        // Board only: just the piece-placement field, no side-to-move / castling / clocks. Keep the
        // '/' separators raw -- encodeURIComponent would turn them into %2F and lichess won't parse it.
        const url = `https://lichess.org/analysis/${variant}?fen=${last_eval.fen.split(' ')[0]}`;
        // the background opens it: window.open from a content script runs in the SITE's context and
        // gets swallowed by popup blocking / page policy
        chrome.runtime.sendMessage({openUrl: url});
    });
    PANEL_ROOT.getElementById('copyfen')?.addEventListener('click', () => copy_to_button('copyfen', last_eval.fen));
    PANEL_ROOT.getElementById('copypgn')?.addEventListener('click', () => copy_to_button('copypgn', current_pgn()));
    PANEL_ROOT.getElementById('config').addEventListener('click', () => {
        chrome.runtime.sendMessage({openOptions: true}); // the background opens it (see above)
    });
    // force re-detection: an SPA can swap games without any reload (e.g. a rematch), and if a
    // scrape ever goes stale this rescans the page and restarts the analysis from scratch
    PANEL_ROOT.getElementById('recheck')?.addEventListener('click', () => {
        // Re-detect always returns to the live game: clear any manually set position first, or the
        // scrape guard would swallow the very response this button just asked for. Set directly
        // rather than via clear_setup_fen(), which clicks THIS button (and would recurse).
        setup_fen = null;
        snap_crop = null;
        snap_follow_stop();
        stash_setup_state();
        const setupRow = PANEL_ROOT.getElementById('setup-fen-row');
        if (setupRow) setupRow.style.display = 'none';
        last_eval.fen = '';   // treat whatever comes back as a brand-new position
        prev_ply_count = 0;   // treat it as a fresh game...
        opp_spend = opp_clock_mark = last_our_eval = null; // ...and clear stale clock/mirror/humanize pacing
        abandon_search(); // L1: the stopped search still flushes a bestmove -- for the position we're discarding
        fen_request_inflight = false; // don't let an in-flight poll's 500ms guard swallow the re-query
        push_config();        // resets the content-script's push dedupe + triggers an immediate push
        request_fen();        // and poll right now as well -- fires immediately now the guard is clear
    });
    PANEL_ROOT.getElementById('selftest')?.addEventListener('click', run_self_test);
    PANEL_ROOT.getElementById('setupfen')?.addEventListener('click', toggle_setup_fen);
    PANEL_ROOT.getElementById('snapfen')?.addEventListener('click', () => snap_position());
    // Flip the READ position. The board reader has no way to know which way round the board on
    // screen was, so it assumes White at the bottom; one click corrects it rather than making the
    // user retype a FEN.
    // click a move in the panel line to walk back to it; playing from there overwrites the rest
    PANEL_ROOT.getElementById('panel-line')?.addEventListener('click', (e) => {
        const idx = e.target?.dataset?.idx;
        if (idx === undefined) return;
        panel_line_goto(parseInt(idx, 10));
    });
    PANEL_ROOT.getElementById('snap_follow')?.addEventListener('click', snap_follow_toggle);
    PANEL_ROOT.getElementById('setup_fen_flip')?.addEventListener('click', () => {
        const box = PANEL_ROOT.getElementById('setup_fen_input');
        const current = (box?.value || setup_fen || '').trim();
        if (!current) return;
        // "This board is being shown from the other side." That is ONE fact with two consequences,
        // so the button applies both: the recogniser maps the image's top-left to a8 no matter which
        // way the board was drawn, so the DATA needs turning round -- and the VIEW needs turning with
        // it, or the picture jumps 180 degrees away from the screen it is supposed to mirror. Doing
        // only the data (what this did) left you reading a black-side board off white-side
        // coordinates: the pieces looked right, a1 was labelled bottom-left, and it was the labels
        // and the FEN that were wrong.
        setup_view = (setup_view === 'black') ? 'white' : 'black';
        snap_flipped = !snap_flipped;   // and every FOLLOWED read from here on is rotated to match
        const flipped = rotate_fen_180(current);
        if (box) box.value = flipped;
        apply_setup_fen();
    });
    PANEL_ROOT.getElementById('setup_fen_input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); apply_setup_fen(); }
        if (e.key === 'Escape') { e.preventDefault(); clear_setup_fen(); }
    });

    // tooltips (replaces Materialize's M.Tooltip -- Materialize's JS looks elements up via `document`
    // and can't run in a shadow root; this queries a passed root instead). PANEL_ROOT/PANEL_TIP_HOST
    // default to `document`/`document.body` in the iframe; the shadow-root phase passes the root.
    annotate_hotkey_labels(); // show each toggle's shortcut next to it, e.g. "Autoplay (A)"
    init_tooltips(PANEL_ROOT, PANEL_TIP_HOST);
    // The locale arrives AFTER the panel is on screen, never before it.
    //
    // This used to be awaited up here, and it made opening the panel visibly slower: the fetch is a
    // round-trip to the service worker, which is usually asleep and has to be woken first, and
    // nothing rendered until it answered. The markup is already English, so blocking on it bought
    // exactly one thing -- English users waiting for English. Paint first, translate when it lands.
    //
    // Re-running the two calls above afterwards is required, not tidiness: annotate_hotkey_labels
    // APPENDS the "(A)" suffix to label text, and Materialize snapshots data-tooltip when a tooltip
    // is initialised, so both have to be redone against the translated markup.
    if ((config.language || MephistoI18n.DEFAULT_LANG) !== MephistoI18n.DEFAULT_LANG) {
        load_language(config.language).then(() => {
            MephistoI18n.apply(PANEL_ROOT);
            annotate_hotkey_labels();
            init_tooltips(PANEL_ROOT, PANEL_TIP_HOST);
        });
    }

    // The content-script's first push (fired ~30ms after push_config above) can arrive before this
    // panel's message handler exists -- it's dropped, but its dedupe key is already recorded, so the
    // board would stay stale until the position next CHANGES (an opponent move). Now that we're fully
    // wired, force one clean re-fetch: reset the dedupe and re-scrape immediately.
    last_eval.fen = '';
    fen_request_inflight = false;
    push_config();  // resets the content-script's push dedupe + triggers an immediate push
    request_fen();
    // Engine switches go through panel_reload(), so probing here covers them too. Not awaited: the
    // probe waits up to 1s on a host that may not exist, and the panel must not boot behind it.
    refresh_engine_health();
    hide_unavailable_natives();
}

// Native "(local)" engines only work if their messaging host is installed. Probe each on panel load
// and HIDE the dropdown options whose host isn't responding, so the list only offers engines you can
// actually run (a fresh install with no host shows just the WASM + Maia engines + Remote). Probing a
// host that isn't installed fails fast; only installed hosts are briefly launched to answer the ping.
// The currently-selected engine is never hidden -- the health badge already flags it if it's down.
async function hide_unavailable_natives() {
    const sel = PANEL_ROOT.getElementById('qs_engine');
    if (!sel) return;
    await Promise.all(NATIVE_ENGINES.map(async (eng) => {
        const opt = [...sel.options].find(o => o.value === eng);
        if (!opt) return;
        const ok = await native_host_available(eng); // native port name == engine value here
        opt.hidden = !ok && eng !== config.engine;
    }));
}
// In the iframe (and toolbar popup) the panel boots on DOMContentLoaded. Once the panel moves in-page
// (4c-2) the content-script imports this module and calls initPanel(shadowRoot) directly instead --
// by then DOMContentLoaded has long fired, so this listener simply never runs there.
if (!IS_CONTENT_SCRIPT) document.addEventListener('DOMContentLoaded', () => initPanel());
// (in-page, content-script.js calls initPanel(shadowRoot, tabId) on toolbar click instead)

// lightweight hover tooltip for `.tooltipped[data-tooltip]` elements (Materialize replacement)
function init_tooltips(queryRoot, appendTo) {
    const tip = document.createElement('div');
    tip.className = 'mephisto-tip';
    tip.style.cssText = 'position:fixed;z-index:2147483647;max-width:240px;padding:6px 9px;'
        + 'background:#323232;color:#fff;font:12px/1.4 Roboto,Arial,sans-serif;border-radius:4px;'
        + 'pointer-events:none;opacity:0;transition:opacity .12s;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    appendTo.appendChild(tip);
    let hideTimer = null;
    const show = (el) => {
        const text = el.getAttribute('data-tooltip');
        if (!text) return;
        clearTimeout(hideTimer);
        tip.textContent = text;
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        // place below by default; nudge left so a wide tip stays on-screen
        const left = Math.min(Math.max(4, r.left), (window.innerWidth || 1200) - 250);
        tip.style.left = left + 'px';
        tip.style.top = (r.bottom + 6) + 'px';
        requestAnimationFrame(() => { tip.style.opacity = '1'; });
    };
    const hide = () => { tip.style.opacity = '0'; hideTimer = setTimeout(() => { tip.style.display = 'none'; }, 150); };
    queryRoot.querySelectorAll('.tooltipped').forEach(el => {
        el.addEventListener('mouseenter', () => show(el));
        el.addEventListener('mouseleave', hide);
    });
}

// Move a number input by one of its own steps, clamped to its own min/max. The amount is NOT
// hard-coded here: it comes from the element's `step`, so the increment lives in the markup beside
// the bounds it must respect. Dispatching `change` is the part that matters -- the config binding
// listens for exactly that, so a stepped value saves and pushes just like a typed one.
function step_number_input(input, dir) {
    const step = Number(input.step) || 1;
    const min = (input.min === '' || input.min == null) ? -Infinity : Number(input.min);
    const max = (input.max === '' || input.max == null) ? Infinity : Number(input.max);
    const now = Number(input.value);
    const next = (Number.isFinite(now) ? now : 0) + step * dir;
    input.value = String(Math.min(max, Math.max(min, next)));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return input.value;
}

function init_quick_settings() {
    const save = (key, value) => MephistoConfig.set(key, JSON.stringify(value));
    // Tab strip. Pure show/hide -- no state to persist and nothing to sync, since every control
    // inside the panels is bound by id exactly as it was when they all sat in one column.
    const tabs = [...PANEL_ROOT.querySelectorAll('.qs-tab')];
    for (const tab of tabs) {
        tab.addEventListener('click', () => {
            for (const t of tabs) {
                const on = t === tab;
                t.setAttribute('aria-selected', String(on));
                PANEL_ROOT.getElementById(t.dataset.panel)?.classList.toggle('qs-on', on);
            }
        });
    }
    // Threads is a count of real cores, so the stepper must not be able to reach a number this
    // machine cannot use. The markup's max=24 is the engine-side cap; the machine's own core count
    // is usually lower and wins. Same ceiling MephistoConfig.defaultThreads() picks from, so the
    // default always sits inside the range the -/+ buttons can walk.
    const threadsInput = PANEL_ROOT.getElementById('qs_threads');
    if (threadsInput) {
        threadsInput.max = String(Math.max(1, Math.min(24, navigator.hardwareConcurrency || 8)));
    }
    // -/+ steppers: the button names its input and its direction; the amount comes from the input.
    for (const btn of PANEL_ROOT.querySelectorAll('.qs-step')) {
        btn.addEventListener('click', () => {
            const input = PANEL_ROOT.getElementById(btn.dataset.for);
            if (input) step_number_input(input, Number(btn.dataset.d));
        });
    }
    // toggles apply live
    for (const [id, key] of [['qs_autoplay', 'autoplay'], ['qs_premove', 'premove'],
                             ['qs_puzzle', 'puzzle_mode'], ['qs_help', 'help_mode'],
                             ['qs_evalbar', 'eval_bar'], ['qs_evalhist', 'eval_history'],
                             ['qs_tablebase', 'tablebase'],
                             ['qs_humanize', 'humanize'],
                             ['qs_clock', 'clock_mode'], ['qs_mirror', 'mirror_mode'],
                             ['qs_manual', 'manual_mode'],
                             ['qs_explorer', 'explorer'], ['qs_book', 'book_play']]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue; // stale cached popup.html mid-update; don't let one missing control kill the popup
        elem.checked = config[key];
        elem.addEventListener('change', () => {
            config[key] = elem.checked;
            save(key, elem.checked);
            keep_alive(keep_alive_wanted(), true); // this change is a user gesture -> can (re)start the tone now
            if (key === 'help_mode' && !elem.checked) request_clear_hint();
            if (key === 'help_mode' || key === 'manual_mode' || key === 'autoplay') mark_autoplay_overridden();
            if (key === 'autoplay' && elem.checked) fourpc_last = '';   // replay the board on screen
            if (key === 'eval_bar' && !elem.checked) request_clear_eval_bar();
            // the strip is drawn by drawEvalBar, so clearing and letting the next eval redraw is
            // enough -- clear_eval_bar removes both overlays and the live bar comes straight back
            if (key === 'eval_history') request_clear_eval_bar();
            if (key === 'explorer' || key === 'book_play') {
                // turning either on mid-game should look this position up right away rather than
                // waiting for the next move; the out-of-book latch is per game, so clear it too
                explorer_out_of_book = false; explorer_empty_streak = 0;
                render_explorer();
                if (last_eval.fen) request_explorer(last_eval.fen);
            }
            if (key === 'tablebase') {
                tablebase_data = null; // a stale answer must not survive a toggle
                if (last_eval.fen) request_tablebase(last_eval.fen);
            }
            if (key === 'humanize') {
                // humanize picks among alternative lines, so it needs MultiPV headroom; re-apply
                // the line count (which drops back to config.multiple_lines when it's turned off,
                // so the engine stops searching the wide list) and restart under the new setting.
                abandon_search();
                if (is_remote()) {
                    remote_multipv_set = effective_multipv();
                    request_remote_configure({MultiPV: remote_multipv_set}).catch(() => { remote_multipv_set = null; });
                } else {
                    send_engine_uci(`setoption name MultiPV value ${effective_multipv()}`);
                }
                last_eval.fen = '';
            }
            if (['help_mode', 'autoplay', 'clock_mode', 'mirror_mode', 'manual_mode'].includes(key)) {
                // Turning Autoplay ON while an unbounded analysis is ALREADY running on this position
                // is the one case where restarting is strictly worse. With Autoplay off the search is
                // `go infinite`, so by the time you flip the toggle it is usually far deeper than the
                // fresh `go movetime` that would replace it -- and abandon_search would then throw
                // that result away (it counts the incoming bestmove into pending_stops). Send a bare
                // `stop` instead and KEEP the bestmove: it arrives through the normal handler, which
                // now sees autoplay on and plays it. Deeper move, and no second search.
                //
                // Gated hard: WASM only (a native host has no stop channel -- its analyse is bounded
                // by the request's `time`, so there is nothing to harvest and it must re-ask), our
                // turn only (the opponent's-turn search returns THEIR move), and only when no other
                // mode is independently forcing the infinite search.
                const our = (our_side() === 'white') ? 'w' : 'b';
                const harvest = key === 'autoplay' && elem.checked && search_active && !is_remote()
                    && !config.help_mode && !config.manual_mode
                    && last_eval.fen && last_eval.fen.split(' ')[1] === our;
                if (harvest) {
                    // NOT abandon_search(): that is the discard path. last_eval.fen is left intact so
                    // the next push doesn't re-analyse the position we just harvested.
                    send_engine_uci('stop');
                    push_config();
                    return;
                }
                // the go mode (infinite vs movetime) / search budget depends on these; abandon the
                // current search and re-analyse the position under the new mode on the next push
                abandon_search();
                last_eval.fen = '';
            }
            push_config();
        });
    }
    // Header turn switch: a king-glyph toggle (White = left, Black = right) in place of the old
    // "Quick Settings" title. It shows the analysed side to move and flips it on tap (routes to
    // flipTurn, same as the on-board badge). Its state is set by update_turn_badge on every position.
    const turnSwitchEl = PANEL_ROOT.getElementById('qs_turn_switch');
    if (turnSwitchEl) {
        const flip = () => self.MephistoPanel.flipTurn();
        turnSwitchEl.addEventListener('click', flip);
        turnSwitchEl.addEventListener('keydown', (e) => { // space/enter toggles (it's role=button)
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
        });
    }
    // timing settings apply live: compute_time is read at every 'go', think/move times are pushed to the page
    for (const [id, key] of [['qs_search', 'compute_time'],
                             ['qs_move', 'move_time'], ['qs_move_var', 'move_variance']]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const value = Math.max((key === 'compute_time') ? 50 : 0, parseInt(elem.value) || 0);
            config[key] = value;
            save(key, value);
            push_config();
        });
    }
    // Settings that apply WITHOUT rebuilding the panel. Threads and Hash cannot be set mid-search, so
    // they are queued and flushed at the next `go` (see flush_engine_options); the running search
    // finishes on the settings it began with. Line count and the fallback poll apply immediately.
    //
    // These used to be in the reload group below, which is why nudging Threads restarted a search in
    // progress -- and, worse, discarded a captured position along with the whole panel.
    for (const [id, key, parse] of [
        ['qs_threads', 'threads', v => parseInt(v) || MephistoConfig.defaultThreads()],
        ['qs_memory', 'memory', v => parseInt(v) || 512],
        ['qs_lines', 'multiple_lines', v => parseInt(v) || 1],
        ['qs_fen', 'fen_refresh', v => Math.max(1000, parseInt(v) || 1000)], // floor 1s (see interval clamp)
    ]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const value = parse(elem.value);
            config[key] = value;
            save(key, value);
            if (key === 'threads') queue_engine_option('Threads', value);
            if (key === 'memory') queue_engine_option('Hash', value); // flush_engine_options clamps for WASM
            if (key === 'multiple_lines') {
                if (is_remote()) {
                    remote_multipv_set = effective_multipv();
                    request_remote_configure({MultiPV: remote_multipv_set}).catch(() => { remote_multipv_set = null; });
                } else {
                    queue_engine_option('MultiPV', effective_multipv());
                }
            }
            if (is_remote() && (key === 'threads' || key === 'memory')) {
                // a native host applies options on its own lock and they take effect on the next
                // analyse, so there is nothing to defer
                request_remote_configure({Threads: config.threads, Hash: config.memory}).catch(() => {});
            }
            push_config();
        });
    }
    // engine settings that genuinely need a full re-init; reload the panel, it re-reads storage
    for (const [id, key, parse] of [
        ['qs_engine', 'engine', v => v],
        ['qs_variant', 'variant', v => v],
        ['qs_maia_level', 'maia_level', v => v], // changing the Maia rating loads a different net
    ]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            // only Fairy-Stockfish plays fairy variants; other engines force standard chess so the
            // net + legality checks stay correct -- EXCEPT Chess960, which every mainline Stockfish
            // plays via UCI_Chess960 (sent at engine init), so it survives an engine switch. Maia is
            // standard-chess only (its nets have no 960), so switching to it always forces chess.
            if (key === 'engine') {
                const eng = parse(elem.value);
                if (eng === 'maia' || eng === 'maia3') save('variant', 'chess');
                else if (!FAIRY_ENGINES.includes(eng) && !['chess', 'fischerandom'].includes(config.variant)) save('variant', 'chess');
            }
            if (key === 'engine') stop_current_engine(); // free the old process before switching
            save(key, parse(elem.value));
            panel_reload();
        });
    }
    // Maia: strength is the NET (the Maia Level dropdown), not UCI_Elo, and it's standard-chess only
    // -> hide the Elo + Variant rows, show the level dropdown.
    const isMaia = config.engine === 'maia';
    const isMaia3 = config.engine === 'maia3';
    const maiaRow = PANEL_ROOT.getElementById('qs_maia_row');
    if (maiaRow) {
        maiaRow.style.display = isMaia ? '' : 'none';
        const ml = PANEL_ROOT.getElementById('qs_maia_level');
        if (ml) ml.value = config.maia_level;
    }
    // Maia-3 Elo slider: live-applied via setoption (SelfElo/OppoElo) -- no net reload -- then re-analyse.
    const maia3Row = PANEL_ROOT.getElementById('qs_maia3_row');
    if (maia3Row) {
        maia3Row.style.display = isMaia3 ? '' : 'none';
        const sl = PANEL_ROOT.getElementById('qs_maia3_elo');
        const lbl = PANEL_ROOT.getElementById('qs_maia3_val');
        if (sl && lbl) {
            sl.value = String(config.maia3_elo);
            lbl.textContent = config.maia3_elo;
            sl.addEventListener('input', () => { lbl.textContent = sl.value; });
            sl.addEventListener('change', () => {
                const v = parseInt(sl.value) || 1500;
                config.maia3_elo = v;
                save('maia3_elo', v);
                send_engine_uci(`setoption name SelfElo value ${v}`);
                send_engine_uci(`setoption name OppoElo value ${v}`);
                abandon_search();
                last_eval.fen = '';   // re-analyse the current position at the new rating
                push_config();
            });
        }
    }
    const eloRow = PANEL_ROOT.getElementById('qs_elo_row');
    if (eloRow) eloRow.style.display = (isMaia || isMaia3 || NO_ELO_ENGINES.includes(config.engine)) ? 'none' : '';
    const variantRow = PANEL_ROOT.getElementById('qs_variant_row');
    if (variantRow) {
        if (isMaia || NO_CHESS960_ENGINES.includes(config.engine)) {
            variantRow.style.display = 'none';
        } else {
            const fairy = FAIRY_ENGINES.includes(config.engine);
            variantRow.style.display = '';
            PANEL_ROOT.querySelectorAll('#qs_variant option').forEach(o => {
                o.hidden = !fairy && !['chess', 'fischerandom'].includes(o.value);
            });
        }
    }
    const detectBtn = PANEL_ROOT.getElementById('qs_variant_detect');
    if (detectBtn) {
        detectBtn.addEventListener('click', () => {
            detectBtn.disabled = true;
            request_detect_variant(v => {
                detectBtn.disabled = false;
                if (v) apply_detected_variant(v);                        // detected -> apply (+ Fairy) & reload
                else { detectBtn.textContent = '?'; setTimeout(() => { detectBtn.textContent = '↻'; }, 1200); }
            });
        });
    }
    // Elo slider: index-mapped so its stops follow the selected engine's real UCI_Elo range
    // (position 0 = Off / full strength). Saves the mapped Elo and reloads to re-init the engine.
    const eloSlider = PANEL_ROOT.getElementById('qs_elo');
    const eloLabel = PANEL_ROOT.getElementById('qs_elo_val');
    if (eloSlider && eloLabel) {
        const stops = elo_stops(config.engine);
        const idxOf = (elo) => { // nearest stop to the stored Elo
            if (!(elo > 0)) return 0;                              // Off (far left)
            if (elo >= FULL_STRENGTH_ELO) return stops.length - 1; // 3200+ (far right)
            let best = 1, bestD = Infinity;
            stops.forEach((e, i) => { // nearest real stop; skip the full-strength sentinel
                if (i && e < FULL_STRENGTH_ELO && Math.abs(e - elo) < bestD) { bestD = Math.abs(e - elo); best = i; }
            });
            return best;
        };
        eloSlider.max = String(stops.length - 1);
        eloSlider.value = String(idxOf(config.elo));
        const paint = () => {
            const v = stops[+eloSlider.value];
            // the right-hand full-strength stop shows the engine's OWN ceiling (SF dev 3190,
            // SF 11 / Fairy 2850), not the internal 3200 sentinel -- stops[len-2] is that max.
            eloLabel.textContent = v === 0 ? 'Off / Full Strength'
                : v >= FULL_STRENGTH_ELO ? `${stops[stops.length - 2]}+ / Full Strength` : v;
        };
        paint();
        eloSlider.addEventListener('input', paint);
        eloSlider.addEventListener('change', () => { save('elo', stops[+eloSlider.value]); panel_reload(); });
    }
    // range sliders show their value in the label while dragging ('change' above still does the
    // save+reload when the thumb is released). Only Memory is still a slider -- Threads and Multi
    // Lines are steppers now, and a stepper shows its value in the field itself.
    for (const id of ['qs_memory']) {
        const slider = PANEL_ROOT.getElementById(id);
        const label = PANEL_ROOT.getElementById(`${id}_val`);
        if (!slider || !label) continue;
        label.textContent = slider.value;
        slider.addEventListener('input', () => { label.textContent = slider.value; });
    }
    // The green fill up to the thumb is a gradient stop CSS cannot compute -- only the element knows
    // its own value -- so it is set here as `--fill`. Runs LAST in this function, after the Elo and
    // Maia sliders have had their real min/max/value assigned above; a slider painted before that
    // would show a fill for the placeholder range.
    const paint_range = (r) => {
        const min = Number(r.min) || 0, max = Number(r.max);
        const span = (max - min) || 1;
        r.style.setProperty('--fill', ((Number(r.value) - min) / span * 100) + '%');
    };
    for (const r of PANEL_ROOT.querySelectorAll('input[type=range]')) {
        paint_range(r);
        r.addEventListener('input', () => paint_range(r));
    }
}

// N1: the WASM engine now lives in the offscreen document (extension origin, cross-origin isolated),
// not in this in-page iframe. `offscreen_engine` is a proxy with the same `.uci(line)` interface the
// popup used on the in-iframe engine object, so send_engine_uci and initialize_engine barely change;
// engine output/errors come back over chrome.runtime and route to the existing handlers below.
let ENGINE_CLIENT = (MY_TAB_ID != null) ? String(MY_TAB_ID) : 'toolbar'; // one engine per panel
const WASM_ENGINES = ['stockfish-dev-nnue', 'stockfish-18-nnue', 'stockfish-18-small-nnue',
                      'fairy-stockfish-14-nnue', 'stockfish-11-hce', 'maia', 'maia3'];
const offscreen_engine = {
    uci: (line) => { try { chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'uci', line}); } catch (e) { /* SW/offscreen gone */ } },
};
// engine output -> existing handlers (filtered to THIS panel's engine)
chrome.runtime.onMessage.addListener((msg) => {
    if (!PANEL_BOOTED || !msg || !msg.fromOffscreen || msg.clientId !== ENGINE_CLIENT) return;
    if (msg.kind === 'line') on_engine_response(msg.line);
    else if (msg.kind === 'error') on_engine_error(msg.error);
});
// Create/replace this panel's offscreen engine and load its NNUE; resolves when it reports 'ready'.
// The setoption/ucinewgame/isready lines that follow in initialize_engine are then forwarded in order.
async function ensure_offscreen_engine(engineName) {
    try { await chrome.runtime.sendMessage({ensureOffscreen: true}); } catch (e) { /* SW spinning up */ }
    // Fire the init and return WITHOUT waiting for 'ready'. The offscreen host queues any uci sent
    // while it loads and flushes it in order, so nothing is lost -- and the panel no longer stalls
    // behind a slow engine load (Fairy's per-variant NNUE), which is why its board used to appear late.
    chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'init',
                                engine: engineName, variant: config.variant, maiaLevel: engineName === 'maia3' ? config.maia3_elo : config.maia_level});
}

async function initialize_engine(reuseWarm = false) {
    pending_stops = 0; // a crashed/replaced engine never flushes what it owed; don't eat the new engine's first result
    // Options queued for the PREVIOUS engine are not this engine's. flush_engine_options only runs
    // in the WASM branch of on_new_pos, so anything queued while a native engine was selected sat
    // here untouched until a WASM engine picked it up and applied it -- including a Hash the WASM
    // heap cannot allocate. This function is about to push the right values for the new engine.
    pending_engine_options = {};
    search_active = false;
    // Fingerprint every engine-affecting setting. If NONE changed since the last init, a reopen can
    // skip engine setup ENTIRELY: the engine is still loaded, still configured, and its hash is warm,
    // so it's ready to take `position ... / go` the instant the first fen lands. This is what makes a
    // warm reopen instant -- no NNUE reload, no Hash realloc, and crucially no `ucinewgame`, which
    // would clear a multi-GB hash (the stall you saw on a native engine with a big Hash). Keeping the
    // hash across a reopen is a bonus: the next search starts warm.
    const fp = [config.engine, config.variant, config.memory, config.threads,
                effective_multipv(), config.elo, !!config.premove, config.maia_level].join('|');
    if (reuseWarm && engine_ready && fp === last_init_fp) {
        if (WASM_ENGINES.includes(config.engine)) engine = offscreen_engine;
        console.log('Engine warm — reused as-is (no reconfigure)');
        return;
    }
    // Net stays loaded only when its IDENTITY is unchanged: engine + variant (+ maia_level, since a
    // Maia rating switch loads a different .onnx). A settings-only change (threads/hash/lines/elo)
    // still reconfigures but skips the reload.
    const warm = reuseWarm && engine_ready && config.engine === last_init_engine
        && config.variant === last_init_variant && config.maia_level === last_init_maia;
    if (WASM_ENGINES.includes(config.engine)) {
        // WASM engine runs in the offscreen document now (see offscreen_engine above). This creates
        // it + loads its NNUE net(s) for THIS panel and resolves when ready; the setoption lines in
        // the `else` below then forward to it in order. Cross-origin isolation / SharedArrayBuffer is
        // guaranteed there (it's an extension page), so the old in-popup SAB check is gone.
        engine = offscreen_engine;
        if (!warm) await ensure_offscreen_engine(config.engine); // else keep the already-loaded engine
    }

    if (is_remote()) {
        request_remote_configure({
            "Hash": config.memory,
            "Threads": config.threads,
            "MultiPV": effective_multipv(), // bumped for Humanize (needs alt-line headroom), like WASM
            "Premove": !!config.premove, // opt-in; engines without the option skip it
            // remote-engine.py skips options the engine doesn't declare, so this is safe everywhere.
            // ALWAYS sent, never omitted-when-standard: the host keeps the last configure it was
            // given (engine_options is a dict it only ever writes into), so leaving these out on the
            // way BACK to Standard left it building Chess960 or Fairy boards for a standard game --
            // the variant was a one-way door. The host handles the explicit standard values
            // (UCI_Variant 'chess' drops the variant net) and skips options an engine doesn't declare.
            "UCI_Chess960": config.variant === 'fischerandom',
            "UCI_Variant": config.variant || 'chess',
            ...(config.elo > 0 && config.elo <= 3190 ? {"UCI_LimitStrength": true, "UCI_Elo": config.elo} : {}),
        }).catch(on_remote_error);
        remote_multipv_set = effective_multipv(); // baseline just configured; don't re-push it
    } else {
        // WASM engines can't allocate the big hash the slider now allows (4 GB) -- their heap is
        // capped, so clamp to 512 MB here. Native engines (remote branch above) get the full value.
        send_engine_uci(`setoption name Hash value ${Math.min(config.memory, 512)}`);
        send_engine_uci(`setoption name Threads value ${config.threads}`);
        search_threads_set = config.threads; // baseline; on_new_pos re-pushes only when the per-turn target differs
        remote_multipv_set = null;           // WASM path: no host to have configured
        send_engine_uci(`setoption name MultiPV value ${effective_multipv()}`);
        // Win/Draw/Loss readout under the score. Modern Stockfish (dev/18) reports `wdl W D L` per
        // info line once this is on; SF11/Fairy don't declare it and silently ignore this line.
        send_engine_uci('setoption name UCI_ShowWDL value true');
        // Chess960: a mainline Stockfish must be told, or it treats the game as standard chess and
        // mishandles castling whenever the king/rooks aren't on their normal files. (Fairy-Stockfish
        // already gets this from its 'fischerandom' UCI_Variant above, so only the SF engines need it.)
        if (config.variant === 'fischerandom' && config.engine !== 'fairy-stockfish-14-nnue') {
            send_engine_uci('setoption name UCI_Chess960 value true');
        }
        // Strength cap: every Stockfish/Fairy build clamps UCI_Elo to its own range, so send it raw.
        // The native troll engines don't declare the option. 0 = full strength (leave limiting off).
        if (!NO_ELO_ENGINES.includes(config.engine)) {
            // Cap only within the engine's own range; 0 (Off) or anything above its max (the
            // "3200+" slider stop) means full strength -> leave limiting off.
            const eloMax = (ELO_RANGE[config.engine] || [1320, 3190])[1];
            if (config.elo > 0 && config.elo <= eloMax) {
                send_engine_uci('setoption name UCI_LimitStrength value true');
                send_engine_uci(`setoption name UCI_Elo value ${config.elo}`);
            } else {
                send_engine_uci('setoption name UCI_LimitStrength value false');
            }
        }
        send_engine_uci('ucinewgame');
        send_engine_uci('isready');
    }
    engine_ready = true;
    last_init_engine = config.engine;
    last_init_variant = config.variant;
    last_init_maia = config.maia_level;
    last_init_fp = fp;
    console.log('Engine ready!', engine);
}

async function fetch_nnue(engineBasePath, nnue) {
    // GitHub refuses blobs over 100MB, so oversized nets ship split into
    // `<name>.part0..N` chunks (plain byte splits); stitch them back together here.
    const whole = await fetch(`${engineBasePath}/${nnue}`).then(res => res.ok ? res.arrayBuffer() : null).catch(() => null);
    if (whole) return whole;
    const parts = [];
    for (let i = 0; ; i++) {
        const part = await fetch(`${engineBasePath}/${nnue}.part${i}`).then(res => res.ok ? res.arrayBuffer() : null).catch(() => null);
        if (!part) break;
        parts.push(part);
    }
    if (!parts.length) throw new Error(`NNUE not found: ${nnue} (neither whole file nor .partN chunks)`);
    const buffer = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    parts.reduce((offset, part) => {
        buffer.set(new Uint8Array(part), offset);
        return offset + part.byteLength;
    }, 0);
    return buffer.buffer;
}

function send_engine_uci(message) {
    try {
        if (engine instanceof Worker) {
            engine.postMessage(message);
        } else if (engine && 'uci' in engine) {
            engine.uci(message);
        }
    } catch (e) {
        // wasm engine crashed on the main thread (e.g. RuntimeError: unaligned access / Aborted)
        on_engine_error(`${e}`);
    }
}

// Abandon the search in flight. UCI: `stop` makes the engine flush ONE bestmove for the position it
// was searching. By the time it lands, the position has moved on -- so it must be dropped, or it gets
// played as our move in a position it was never chosen for.
//
// Counted, not a flag: A->B->C arriving before bestmove(A) lands issues two flush-producing stops and
// so owes TWO bestmoves. A flag cleared by the first would let bestmove(B) through as a terminal
// result for the superseded position B. Only a search actually in flight flushes anything -- the
// engine ignores a `stop` with no `go` outstanding, so counting that would eat the NEXT real bestmove.
// Engine options that can only be set between searches. UCI forbids `setoption` while a search is
// running, and Threads/Hash in particular tear down and rebuild the engine's internal state.
//
// These used to force a full panel reload, which is why changing Threads mid-think restarted
// everything -- and why it threw away a captured position with it. They are recorded here instead
// and flushed immediately before the next `go`, once the previous search has been stopped. The
// search you are watching finishes on the settings it started with, which is the only coherent
// answer: changing the thread count under a running search would invalidate everything it has done.
let pending_engine_options = {};

function queue_engine_option(name, value) {
    pending_engine_options[name] = value;
}

// Called from on_new_pos AFTER abandon_search() and BEFORE the `go` -- the one window where UCI
// allows this.
function flush_engine_options() {
    const opts = pending_engine_options;
    pending_engine_options = {};
    for (const name in opts) {
        if (is_remote()) continue; // the native path sends these through request_remote_configure
        // Clamp HERE, not where the value was queued. The queue site can only see the engine that
        // was selected when the slider moved; this runs against the engine that will actually
        // receive it. A WASM heap is capped, so the 4 GB the slider allows has to come down to the
        // same 512 MB initialize_engine applies -- otherwise the queued value silently undoes it.
        const value = (name === 'Hash') ? Math.min(opts[name], 512) : opts[name];
        send_engine_uci(`setoption name ${name} value ${value}`);
        if (name === 'Threads') search_threads_set = value; // keep the per-turn tracker honest
    }
    return opts;
}

function abandon_search() {
    if (search_active) pending_stops++;
    search_active = false;
    remote_gen++; // a remote/native request still in flight is now for a position we've left
    // ...and release the native in-flight slot with it. Bumping remote_gen commits us to DROPPING
    // that request's result, so continuing to treat it as "the search covering this position" is
    // wrong by definition: send_analysis refuses to issue a second search while native_inflight
    // holds the same posKey, so the panel sat waiting on a result it had already decided to discard.
    //
    // That is what "toggling Autoplay breaks the engine" was. With Autoplay OFF the native budget is
    // an hour (`rt = 3600000`, the pure-analysis rail), and the watchdog that would free the slot is
    // only armed for `rt < 60000` -- so nothing came back and nothing new was issued until the
    // abandoned hour-long search finally answered. Clearing here is safe: both the `.finally` settle
    // and the watchdog re-check `native_inflight === posKey`, so neither can clobber a newer request.
    native_inflight = null;
    send_engine_uci('stop');
}

// Claim the current generation for a remote/native analysis about to be issued, and return a wrapper
// that only lets a callback run if that generation is STILL current. A host request is a promise, not
// a stream we can cancel -- `stop` does not unmake it, so a request issued for an old position still
// resolves, and before this guard its bestmove was played into whatever position had replaced it. In
// a puzzle that is a guaranteed miss: our move flips the board to their scripted reply, the reply
// lands, and the superseded search resolves two plies late.
function remote_result_gate() {
    const gen = ++remote_gen;
    return (fn) => (v) => {
        if (gen !== remote_gen) {
            console.log('Mephisto: dropping a superseded remote result (the position moved on)');
            return;
        }
        fn(v);
    };
}

// The restart budget is for a build that traps REPEATEDLY -- three crashes in quick succession mean
// the engine is not going to work here. It is NOT a lifetime allowance: this counter only ever went
// up, so three unrelated crashes spread over hours of play permanently disabled recovery and the
// panel told you to change engine while the engine was in fact fine. Cleared once the engine has run
// healthily for a while (see note_engine_healthy).
const ENGINE_HEALTHY_MS = 5 * 60 * 1000;
let engine_restarts = 0;
let engine_restarting = false;
let last_engine_crash_at = 0;

// Called whenever a search completes normally. A crash long ago says nothing about the engine now.
function note_engine_healthy() {
    if (!engine_restarts || engine_restarting) return;
    if (Date.now() - last_engine_crash_at < ENGINE_HEALTHY_MS) return;
    console.log(`Mephisto: engine healthy for ${Math.round(ENGINE_HEALTHY_MS / 60000)} min -- restart budget reset`);
    engine_restarts = 0;
}

function on_engine_error(message) {
    console.error(message);
    if (engine_restarting) return;
    // Two different things arrive here: a CRASH of a running engine (restartable, the regex below)
    // and a failure to LOAD one at all -- a missing net, a model that won't fetch, a bad build. The
    // second kind fell through the regex and was dropped, so the panel just sat on its progress bar
    // with the single most useful sentence already in hand. Say it, whatever kind it is.
    update_best_move(i18n('panel.msg.engine_error', 'Engine error — {detail}', {detail: String(message).slice(0, 120)}));
    if (!/RuntimeError|Aborted|worker sent an error/.test(String(message))) {
        engine_ready = false; // a load that failed is not a warm engine; make the next open re-init
        toggle_calculating(false); // nothing is coming, so stop pretending a search is running
        return;
    }
    if (engine_restarts >= 3) {
        // ponytail: cap restarts — a build that keeps trapping (some wasm builds on some machines) shouldn't loop forever
        update_best_move(i18n('panel.msg.engine_keeps_crashing', 'Engine keeps crashing — pick a different engine in Settings.'));
        return;
    }
    engine_restarts++;
    last_engine_crash_at = Date.now();
    engine_restarting = true;
    engine = null; // drop the dead instance; send_engine_uci becomes a no-op meanwhile
    engine_ready = false; // a reopen mid-restart must do a full init, not warm-reuse the dead engine
    update_best_move(i18n('panel.msg.engine_restarting', 'Engine crashed — restarting (attempt {n}/3)', {n: engine_restarts}));
    initialize_engine()
        .then(() => { last_eval = {fen: '', activeLines: 0, lines: []}; }) // force re-analysis on next fen poll
        .catch((e) => console.error('Engine restart failed:', e))
        .finally(() => engine_restarting = false);
}

function on_engine_best_move(best, threat, isTerminal=false) {
    if (is_remote()) {
        last_eval.activeLines = last_eval.lines.length;
    }

    console.log('EVALUATION:', JSON.parse(JSON.stringify(last_eval)));
    const piece_name_map = {
        P: i18n('piece.pawn', 'Pawn'), R: i18n('piece.rook', 'Rook'), N: i18n('piece.knight', 'Knight'),
        B: i18n('piece.bishop', 'Bishop'), Q: i18n('piece.queen', 'Queen'), K: i18n('piece.king', 'King'),
    };
    const white = i18n('color.white', 'White'), black = i18n('color.black', 'Black');
    const toplay = (turn === 'w') ? white : black;
    const next = (turn === 'w') ? black : white;
    if (!best || best === '(none)') { // game over (or crashed search) — there is no move to draw or play
        const pvLine = last_eval.lines[0] || {};
        if ('mate' in pvLine) {
            update_evaluation(i18n('panel.msg.checkmate', 'Checkmate!'));
            if (config.variant === 'antichess') {
                update_best_move(i18n('panel.msg.wins', '{side} Wins', {side: toplay}));
            } else {
                update_best_move(i18n('panel.msg.wins', '{side} Wins', {side: next}));
            }
        } else {
            update_evaluation(i18n('panel.msg.stalemate', 'Stalemate!'));
            if (config.variant === 'antichess') {
                update_best_move(i18n('panel.msg.wins', '{side} Wins', {side: toplay}));
            } else {
                update_best_move(i18n('panel.msg.draw', 'Draw'));
            }
        }
        clear_next_move_eta(); // game over: no move coming, drop any countdown started at search time
        toggle_calculating(false);
        return;
    } else if (config.simon_says_mode) {
        if (toplay.toLowerCase() === our_side()) {
            const startSquare = best.substring(0, 2);
            const startPiece = board.position()[startSquare];
            const startPieceType = (startPiece) ? startPiece.substring(1) : null;
            if (startPieceType) {
                update_best_move(piece_name_map[startPieceType]);
            }
        } else {
            update_best_move('');
        }
    } else {
        // Threat Analysis draws the red arrow (draw_threat) -- it no longer prints a second text
        // line; the "Best response for ..." readout was removed.
        // Pondering the opponent's turn (their move, ponder on): flag it so the live readout reads
        // "Pondering -- Black to play, ..." rather than looking like a stalled search on our move.
        // Maia is a single forward pass -- it can't deepen, so it never really ponders; every other
        // engine (WASM, native SF/Fairy, remote) does.
        const pondering = config.ponder && toplay.toLowerCase() !== our_side()
            && config.engine !== 'maia' && config.engine !== 'maia3';
        update_best_move(`${pondering ? i18n('panel.msg.pondering', 'Pondering — ') : ''}` + i18n('panel.msg.to_play_best', '{side} to play, best move is {move}', {side: toplay, move: best}));
    }

    if (toplay.toLowerCase() === our_side()) {
        last_eval.bestmove = best;
        last_eval.threat = threat;
        if (config.simon_says_mode) {
            const startSquare = best.substring(0, 2);
            if (board.position()[startSquare] == null) {
                // The current best move is stale so abort! This happens when the opponent makes a move in
                // the middle of continuous evaluation: the engine isn't done evaluating the opponent's
                // position and ends up returning the opponent's best move on our turn.
                return;
            }
            const startPiece = board.position()[startSquare].substring(1);
            if (last_eval.lines[0] != null) {
                if ('mate' in last_eval.lines[0]) {
                    request_console_log(`${piece_name_map[startPiece]} ==> #${last_eval.lines[0].mate}`);
                } else {
                    request_console_log(`${piece_name_map[startPiece]} ==> ${last_eval.lines[0].score / 100.0}`);
                }
            }
            if (config.threat_analysis) {
                clear_annotations();
                draw_threat();
            }
        }
        // Manual Mode plays on YOUR keypress and nothing else. It normally never reaches here because
        // its search is `go infinite` and so emits no bestmove -- but Maia/Maia-3 are a single forward
        // pass that answers a `go` regardless of the limit, so on those engines Manual Mode was
        // autoplaying by itself. State the contract here instead of relying on the engine to withhold
        // a bestmove, the way every other move-path guard already lists the mode.
        if (isTerminal) {
            bgTrace('bestmove', {best, autoplay: config.autoplay, help: config.help_mode,
                manual: config.manual_mode});
        }
        // Every reason autoplay can decline, said out loud in the PAGE console. This is the last
        // silent branch in the move path: a terminal bestmove arrives, the gate refuses, and nothing
        // is printed anywhere -- which is indistinguishable from the engine never answering.
        if (isTerminal && config.autoplay && !config.help_mode && !config.manual_mode
                && !premove_reply_playable(last_eval.fen, best)) {
            const f = String(last_eval.fen || '');
            console.warn('Mephisto: NOT autoplaying', best, '-- premove_reply_playable said no.',
                {fen: f, sideToMove: f.split(' ')[1], ourSide: our_side(),
                 pieceOnFrom: (() => { try { return new Chess(config.variant, f).get(best.slice(0, 2)); }
                                       catch (e) { return 'unreadable'; } })()});
        }
        if (isTerminal && config.autoplay && (config.help_mode || config.manual_mode)) {
            console.warn('Mephisto: NOT autoplaying', best,
                config.help_mode ? '-- Help Mode is on' : '-- Manual Mode is on');
        }
        if (!config.help_mode && !config.manual_mode && config.autoplay && isTerminal) {
            // SAFETY: only autoplay a move that actually moves OUR piece and is legal right now.
            // If the turn was mis-scraped we'd otherwise play the opponent's best move as ours.
            if (premove_reply_playable(last_eval.fen, best)) {
                // humanize: maybe swap in a close alternative + a human-looking think delay;
                // a clock-aware mode alone still shapes the timing (budget / opponent mirror).
                // Never in puzzle mode, whose PV playback must follow the engine line exactly.
                // Book move (weighted random over the human distribution) outranks the engine's pick
                // while we're still in book -- Move priority: Puzzle DB > Tablebase > Book > Humanize > engine.
                // It only
                // replaces WHICH move is played; the timing below is untouched, so Clock/Mirror/
                // Humanize still pace it exactly as they would have. Null whenever the lookup hasn't
                // landed, we're out of book, or every candidate failed the games/engine filters.
                const book = book_pick(last_eval.fen);
                if (book && !premove_reply_playable(last_eval.fen, book)) {
                    console.warn('Mephisto: ignoring a book move that is not ours/legal here:', book);
                }
                // Tablebase outranks everything: at <=7 men the position is SOLVED, so this is not a
                // preference the engine could out-search, it is the move. Same shape as the book --
                // it replaces only WHICH move is played, never the timing, so Clock/Mirror/Humanize
                // still pace it exactly as they would have. Null whenever the probe is off, out of
                // range, or hasn't landed yet, in which case nothing here changes.
                const tb = tablebase_pick(last_eval.fen);
                if (tb && !premove_reply_playable(last_eval.fen, tb)) {
                    console.warn('Mephisto: ignoring a tablebase move that is not ours/legal here:', tb);
                }
                // No puzzle-database branch here on purpose: a position the database knows is played
                // by maybe_play_puzzle_move before any search starts, so if we have reached a
                // bestmove at all, the database did not have this position.
                const tb_ok = tb && premove_reply_playable(last_eval.fen, tb);
                const played = tb_ok ? tb
                    : (book && premove_reply_playable(last_eval.fen, book)) ? book : best;
                if (tb_ok && tb !== best) console.log(`Tablebase: playing ${tb} over ${best} (solved position)`);
                if (!tb_ok && played !== best) console.log(`Book: playing ${played} over ${best} (weighted random)`);
                if (puzzle_display_search) {
                    // A depth-10 look at a position whose answer is already known. Showing it is the
                    // whole point; playing it is how you fail a puzzle with a stronger move.
                    puzzle_display_search = false;
                    console.log('Puzzle: display-only search finished -- the known solution stands');
                } else if ((config.humanize || clock_aware()) && !config.puzzle_mode) {
                    const pick = humanize_pick(best);
                    if (played !== best) pick.move = played; // book wins the move, humanize keeps the clock
                    if (pick.move !== best) console.log(`Humanize: playing ${pick.move} over ${best}`);
                    // the search already burned most of the intended think (on_new_pos sized it to
                    // the pace), so only wait out the RESIDUAL -- never idle time the engine could
                    // have spent searching. Clock-aware paces are largely consumed by the search;
                    // a pure-humanize long think still waits here (its search stayed at the default).
                    const elapsed = Date.now() - search_start;
                    const residual = Math.max(0, Math.round(pick.think - elapsed));
                    // re-anchor the countdown to the AUTHORITATIVE total (search_start + think) and
                    // add the move category -- it keeps counting the full time down to the play, so
                    // the move fires exactly when the countdown hits zero.
                    set_move_countdown(search_start + pick.think, pick.source, pick.category);
                    request_automove(pick.move, residual);
                } else {
                    request_automove(played); // in help mode draw_moves() mirrors the arrows instead
                }
            } else {
                console.warn('Mephisto: not autoplaying a move that is not ours/legal here:', best);
            }
        }
    }

    render_move_reason(best); // opt-in; renders nothing at all when the toggle is off

    if (!config.simon_says_mode) {
        draw_moves();
        if (config.threat_analysis) {
            draw_threat()
        }
    }

    note_engine_healthy(); // a search that finished is the only evidence the engine is well
    toggle_calculating(false);
}

function update_eval_bar(line) {
    const bar = PANEL_ROOT.getElementById('eval-bar-white');
    if (!bar || !line) return;
    // Reclaim the colours if the 4PC lane painted this bar red/blue. Those are inline styles on the
    // same two elements, so without this a normal game inherits Team Red vs Team Blue until the panel
    // happens to be rebuilt.
    if (bar.style.background) {
        bar.style.background = '';
        const wrap = PANEL_ROOT.getElementById('eval-bar');
        if (wrap) wrap.style.background = '';
    }
    let frac; // white's share of the bar; scores/mates are white-relative here
    if ('mate' in line) {
        // mate 0 = the side to move IS checkmated, so the sign carries no direction
        frac = (line.mate === 0) ? ((turn === 'w') ? 0 : 1) : ((line.mate > 0) ? 1 : 0);
    } else {
        const winning_chance = 2 / (1 + Math.exp(-0.00368 * line.score)) - 1; // lichess curve, cp -> [-1,1]
        frac = Math.max(0.03, Math.min(0.97, 0.5 + winning_chance / 2));
    }
    // mirror the player's perspective like lichess: the bar's bottom belongs to the bottom player,
    // so when playing black the white share hangs from the top and black grows from the bottom.
    // (the TEXT eval stays white-relative on purpose -- positive is always good for white.)
    const flipped = board.orientation() === 'black';
    bar.style.top = flipped ? '0' : 'auto';
    bar.style.bottom = flipped ? 'auto' : '0';
    bar.style.height = `${frac * 100}%`;

    // Eval history: one entry per POSITION seen this game, as the same 0..1 white-share the live bar
    // uses, so the strip and the bar are the same quantity drawn two ways. Keyed by the position's
    // move count so a re-analysis of the same position overwrites rather than appends -- the panel
    // re-evaluates constantly (every info line, every fallback poll) and appending would turn a
    // 40-move game into thousands of bands.
    record_eval_history(frac);

    // mirror the bar onto the site board (chess.com-style: score inside, on the winning side's end)
    if (config.eval_bar) {
        const text = ('mate' in line) ? `M${Math.abs(line.mate)}` : (Math.abs(line.score) / 100).toFixed(1);
        request_draw_eval_bar({frac, text, winningWhite: frac >= 0.5,
                               history: config.eval_history ? eval_history : null,
                               phases: config.eval_history
                                   ? game_phases(premove_tracker.startFen, premove_tracker.moves) : null});
    }
}

// Below this much search, the engine's nodes/elapsed is dividing by a 0-1ms integer and the answer
// is noise rather than a speed (see nps_is_trustworthy).
const NPS_MIN_MS = 50;
// Nothing reaches 30M nps -- not even a native build with every thread. Anything above it is the
// same divide-by-almost-zero artifact wearing a plausible-looking number.
const NPS_MAX = 30_000_000;

// Is this line's nps a real speed, or the artifact?
//
// Elapsed is derived as nodes/nps rather than read from the info's own `time`, because that field's
// UNIT depends on which engine path produced it: the WASM engines are parsed straight from raw UCI,
// where `time` is INTEGER MILLISECONDS, while the native + remote hosts go through python-chess,
// which does `info["time"] = int(time_ms) / 1000.0` -- FLOAT SECONDS. A single threshold can't mean
// both, and gating on it hid nps entirely on every native engine. nodes/nps is the engine's own
// elapsed whichever path it came from, and needs no unit at all.
function nps_is_trustworthy(line) {
    if (!Number.isFinite(line.nps) || line.nps <= 0 || line.nps > NPS_MAX) return false;
    if (!Number.isFinite(line.nodes) || line.nodes <= 0) return true; // can't derive: the cap stands alone
    return (line.nodes / line.nps) * 1000 >= NPS_MIN_MS;
}

// nodes/second, grouped Swiss-style: 1019100 -> "1'019'100 NPS" (so you can see engine speed)
function format_nps(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'") + ' NPS';
}

function on_engine_evaluation(info) {
    if (!info.lines[0]) return;
    update_eval_bar(info.lines[0]);

    // nps is nodes/elapsed, so the opening instants of a search divide by ~0 and report impossible
    // speeds -- one real report read 843'779'000 NPS, which is exactly 843'779 nodes "in 1ms". Show
    // it only once it's believable (see nps_is_trustworthy); until then keep the last good value.
    const npsEl = PANEL_ROOT.getElementById('nps');
    const l0 = info.lines[0];
    if (npsEl && nps_is_trustworthy(l0)) {
        npsEl.textContent = format_nps(l0.nps);
        // Calibration samples ride the same filter -- it already rejects the impossible readings the
        // opening milliseconds of a search produce. Depth-gated on top: an early iteration's nps is
        // real but unrepresentative, and the point is to measure this machine at speed.
        if (Number.isFinite(l0.depth) && l0.depth >= 12) record_nps_sample(l0.nps);
    }
    if ('mate' in info.lines[0]) {
        update_evaluation(`Checkmate in ${info.lines[0].mate}`);
    } else {
        update_evaluation(`Score: ${info.lines[0].score / 100.0} at depth ${info.lines[0].depth}`)
    }
    render_wdl(info.lines[0]);
    render_alt_lines();

    // track this position's eval (white-relative cp + depth) for the opponent-mistake alert
    const l0d = info.lines[0];
    if (l0d && Number.isFinite(l0d.depth)) {
        const cpWhite = ('mate' in l0d) ? (l0d.mate > 0 ? 100000 : -100000) : l0d.score; // score is white-relative
        last_pos_eval = {fen: last_eval.fen, cpWhite, depth: l0d.depth, sideToMove: turn};
        opp_alert_maybe_fire();
    }
}

// Win/Draw/Loss line under the score, from the engine's own UCI_ShowWDL output. `wdl` is
// [white, draw, black] in permille. Shown from YOUR side (board orientation) so your colour is
// always listed first and the order stays put across moves. Blank for engines that don't report
// it (SF11, Fairy, remote engines without a WDL model) so the row just collapses.
function render_wdl(line) {
    const el = PANEL_ROOT.getElementById('wdl');
    if (!el) return;
    const wdl = line && line.wdl;
    if (!Array.isArray(wdl) || wdl.length !== 3) { el.textContent = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    const whitePct = (wdl[0] / 10).toFixed(1);
    const drawPct = (wdl[1] / 10).toFixed(1);
    const blackPct = (100 - wdl[0] / 10 - wdl[1] / 10).toFixed(1); // derive third -> always sums to 100
    const w = `White ${whitePct}%`, d = `Draw ${drawPct}%`, b = `Black ${blackPct}%`;
    el.textContent = (board.orientation() === 'black') ? `${b} | ${d} | ${w}` : `${w} | ${d} | ${b}`;
}

// One distinct colour per engine line, so with Multi Lines on you can tell which arrow is which:
// line 1 (best) blue, then green / amber / orange / purple for 2nd..5th. Used for the arrows on BOTH
// the panel board and (in Help Mode) the site board, and echoed on the alternative-lines panel so it
// reads as a legend -- the green row is the green arrow. Was: line 1 blue, every other line the same
// grey, so 2nd/3rd/4th/5th were indistinguishable.
const LINE_COLORS = ['#0a5bd3', '#0f9d58', '#e0a400', '#e8710a', '#9333ea'];
function line_color(i) { return LINE_COLORS[Math.min(i, LINE_COLORS.length - 1)]; }

// pv arrives as a space-joined STRING from the wasm engines but can be a LIST of UCI moves from a
// native/remote host (python-chess formats pv as an array) -- normalize before any .split use
function pv_moves(pv) {
    return Array.isArray(pv) ? pv.map(String) : (pv || '').split(' ');
}

// first few moves of a UCI pv as SAN, for the alternative-lines panel
function san_preview(fen, pv, plies = 6) {
    const ucis = pv_moves(pv).slice(0, plies);
    try {
        const chess = new Chess(config.variant, fen);
        return ucis.map(u => chess.move({from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4]}).san).join(' ');
    } catch (e) {
        return ucis.join(' '); // variant/parse hiccup -> raw UCI is still useful
    }
}

// the panel under the board: one row per engine line (eval + start of the line) when the
// Multi Lines slider asks for more than one; hidden otherwise
// The overlay. Draws the opening name and the most-played replies with their win/draw/loss split,
// straight from the database -- it reflects what the lookup returned and never decides anything.
function render_explorer() {
    const panel = PANEL_ROOT.getElementById('book-lines');
    if (!panel) return;
    // show the block whenever the explorer is on and we have either data OR something to report
    const show = config.explorer && (explorer_data?.moves?.length || explorer_error || explorer_out_of_book);
    panel.style.display = show ? '' : 'none';
    apply_explorer(!!show); // grow/shrink the fixed-size panel box to match
    if (!show) { panel.innerHTML = ''; return; }
    if (!explorer_data?.moves?.length) { // no book data -- say WHY rather than render an empty box
        panel.innerHTML = `<div class="bk-opening">${explorer_error
            ? `Explorer unavailable (${explorer_error})` : 'Out of book'}</div>`;
        return;
    }
    const rows = [];
    if (explorer_data.opening?.name) {
        const eco = explorer_data.opening.eco ? `${explorer_data.opening.eco} ` : '';
        rows.push(`<div class="bk-opening">${eco}${explorer_data.opening.name}</div>`);
    }
    for (const m of explorer_data.moves.slice(0, 5)) {
        const w = m.white || 0, d = m.draws || 0, b = m.black || 0, n = w + d + b;
        if (!n) continue;
        const pct = v => Math.round(100 * v / n);
        // W/D/L is always White's side of it, matching how the database reports it
        rows.push(`<div class="bk-line"><b>${m.san}</b> ` +
            `<span class="bk-pct">${pct(w)}/${pct(d)}/${pct(b)}%</span> ` +
            `<span class="bk-pct">(${n.toLocaleString()})</span></div>`);
    }
    panel.innerHTML = rows.join('');
    draw_book_moves();
}

// The panel is a fixed-size box the content script scales, so showing the overlay can't enlarge it
// on its own -- same problem compact mode has, and the same fix (see setPanelBook).
function apply_explorer(show) {
    panel_body()?.classList.toggle('mephisto-book', !!show);
    self.MephistoContent?.setPanelBook?.(!!show);
}

function render_alt_lines() {
    const panel = PANEL_ROOT.getElementById('alt-lines');
    if (!panel) return;
    if (config.multiple_lines <= 1) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';
    const rows = [];
    for (let i = 0; i < config.multiple_lines; i++) {
        const line = last_eval.lines?.[i];
        if (!line || !line.pv) continue;
        const evalTxt = ('mate' in line) ? `#${line.mate}` : (line.score / 100).toFixed(2);
        // colour the eval to match this line's board arrow, so the panel is a legend for the arrows.
        // inline style -- beats the dark-mode `#alt-lines .alt-eval` colour rule (no !important there).
        // The line's OWN move carries the weight; the continuation behind it is context, so it is
        // dimmed rather than competing with it at equal strength. 7 plies = the move plus the next
        // six. A short pv just yields a shorter tail, and a 1-ply pv none at all.
        const sans = san_preview(last_eval.fen, line.pv, 7).split(' ').filter(Boolean);
        const head = sans[0] || '';
        const cont = sans.slice(1).join(' ');
        rows.push(`<div class="alt-line"><span class="alt-eval" style="color:${line_color(i)}">${evalTxt}</span> ` +
            `<span class="alt-moves">${head}</span>` +
            (cont ? ` <span class="alt-cont">${cont}</span>` : '') + `</div>`);
    }
    panel.innerHTML = rows.join('');
}

function on_engine_response(message) {
    console.log('on_engine_response', message);
    if (is_remote()) {
        last_eval = Object.assign(last_eval, message);
        on_engine_evaluation(last_eval);
        on_engine_best_move(last_eval.bestmove, last_eval.threat, true);
        return;
    }

    if (pending_stops > 0) {
        // output of a search we abandoned; UCI ordering ends each one with its flushed bestmove, so
        // one bestmove settles one owed stop -- the rest of that search's info lines are dropped too.
        // Clearing search_active matters as much as the decrement: this branch RETURNS, so it used to
        // skip the `search_active = false` below and leave the flag set on a search that had just
        // ended. The next abandon_search then charged a stop for a search owing nothing, and that
        // off-by-one is PERMANENT -- every later bestmove is eaten and the panel never moves again
        // for the rest of the session. A `go` that produces no bestmove at all is enough to start it
        // (Maia is a single forward pass: if it rejects, nothing is ever emitted). The next `go`
        // sets the flag again, so this is safe for the ordinary supersession case.
        if (message.startsWith('bestmove')) { pending_stops--; search_active = false; }
        return;
    }

    if (message.includes('lowerbound') || message.includes('upperbound') || message.includes('currmove')) {
        return; // ignore these messages
    } else if (message.startsWith('bestmove')) {
        search_active = false;
        const arr = message.split(' ');
        const best = arr[1];
        const threat = arr[3];
        on_engine_best_move(best, threat, true);
    } else if (message.startsWith('info depth')) {
        const lineInfo = {};
        const tokens = message.split(' ').slice(1);
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token === 'score') {
                lineInfo.rawScore = `${tokens[i + 1]} ${tokens[i + 2]}`;
                i += 2; // take 2 tokens
            } else if (token === 'wdl') {
                // `wdl <win> <draw> <loss>` in permille, from the side-to-move's perspective.
                // Normalize to [white, draw, black] so the display never needs the turn again.
                const w = parseInt(tokens[i + 1]), d = parseInt(tokens[i + 2]), l = parseInt(tokens[i + 3]);
                lineInfo.wdl = (turn === 'w') ? [w, d, l] : [l, d, w];
                i += 3; // take 3 tokens
            } else if (token === 'pv') {
                lineInfo['move'] = tokens[i + 1];
                lineInfo[token] = tokens.slice(i + 1).join(' '); // take rest of tokens
                break;
            } else {
                const num = parseInt(tokens[i + 1]);
                lineInfo[token] = isNaN(num) ? tokens[i + 1] : num;
                i++; // take 1 token
            }
        }

        const scoreNumber = Number(lineInfo.rawScore.substring(lineInfo.rawScore.indexOf(' ') + 1));
        const scoreType = lineInfo.rawScore.includes('cp') ? 'score' : 'mate';
        lineInfo[scoreType] = (turn === 'w' ? 1 : -1) * scoreNumber;

        const pvIdx = (lineInfo.multipv - 1) || 0;
        // premove: while this position is searched, track how stable each line's 2nd move
        // (our reply to the predicted opponent move) is across depths 13 / 14 / latest
        if (config.premove && lineInfo.pv && pvIdx < premove_lines && Number.isInteger(lineInfo.depth)) {
            const [pred, reply] = lineInfo.pv.split(' ');
            const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
            if (lineInfo.depth === PREMOVE_DEPTH_PREV) line.dPrev = `${pred} ${reply}`;
            if (lineInfo.depth === PREMOVE_DEPTH_LAST) line.dLast = `${pred} ${reply}`;
            line.latest = `${pred} ${reply}`;
            line.pred = pred;
            line.reply = reply;
            line.depth = lineInfo.depth;
            if (pvIdx === 0) maybe_premove_forced_reply(line);
        }
        last_eval.activeLines = Math.max(last_eval.activeLines, lineInfo.multipv);
        if (pvIdx === 0) {
            // fresh depth: clear last depth's lines, then set line 0
            last_eval.lines = new Array(config.multiple_lines);
            last_eval.lines[pvIdx] = lineInfo;
            // Show THIS depth's best move right away. It used to show the PREVIOUS depth's line 0
            // instead, so on the first depth (no previous line) the move text stayed "Calculating..."
            // while the score and NPS had already updated -- a visible one-depth lag. The native path
            // (on_native_info) already shows the current move; this makes WASM match it, so the panel
            // streams the move from the very first depth.
            const arr = lineInfo.pv.split(' ');
            on_engine_best_move(arr[0], arr[1]);
            on_engine_evaluation(last_eval);
        } else {
            last_eval.lines[pvIdx] = lineInfo;
            render_alt_lines(); // alternative lines land AFTER the pv-1 reset; keep the panel current
            // ...and REDRAW THE ARROWS. draw_moves only ran from the pv-1 branch, which clears the
            // line array first -- so it always drew with exactly one line in hand and Multi Lines
            // showed a single arrow no matter how many lines the panel listed. Help Mode mirrors the
            // same set onto the site board, so it was one arrow there too.
            if (!config.simon_says_mode) draw_moves();
        }
    }

    if (is_calculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        PANEL_ROOT.getElementById('progBar')?.setAttribute('value', `${Math.round(progMapping)}`);
    }
}

// A SECOND opinion on the position, where the page happens to publish one.
//
// Every scraping bug this project has had shares a shape: the reconstruction is wrong but perfectly
// LEGAL, so nothing downstream can object and the engine quietly answers a different game. A missing
// en-passant square, absent castling rights, a torn read caught mid-update -- all invisible from the
// inside. An independent source settles it instantly.
//
// The panel runs in the page's isolated world, so it can read the page's own DOM directly -- no
// message round trip. Best-effort BY DESIGN: most pages publish nothing, the ones that do move their
// markup, and this must never gate a move. It only ever warns. Placement ONLY, because a page's FEN
// and ours legitimately differ on move counters, and on side-to-move when the page is showing a
// browsed position rather than the live one.
const FEN_PLACEMENT_RE = /((?:[pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8})/;
let last_crosscheck_warn = 0;

function page_published_placement() {
    try {
        // lichess keeps the live FEN in a copyable input; some pages expose one in a data attribute.
        // Anything that parses as a placement field will do -- we are not guessing at a schema.
        const el = document.querySelector('input.copyable[value*="/"], input[name="fen"], [data-fen]');
        const raw = el?.value || el?.getAttribute?.('data-fen') || '';
        const m = FEN_PLACEMENT_RE.exec(raw);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

function cross_check_position(fen) {
    try {
        const ours = (fen || '').split(' ')[0];
        // Both sides must actually LOOK like a placement field. Without this, a garbage `fen` is
        // "different from" the page's real one and produces a warning whose text is the garbage --
        // which reports the wrong problem. A scrape that malformed is caught by is_legal_position
        // immediately after this call; the cross-check is only here to compare two real positions.
        if (!ours || !FEN_PLACEMENT_RE.test(ours)) return;
        const theirs = page_published_placement();
        if (!theirs || theirs === ours) return;
        if (Date.now() - last_crosscheck_warn < 5000) return; // one complaint per position, not per poll
        last_crosscheck_warn = Date.now();
        console.warn('Mephisto: the position we reconstructed disagrees with the one the page publishes.\n' +
            `  ours: ${ours}\n  page: ${theirs}\n` +
            '  The page is more likely right -- re-detect, or report this with both strings.');
    } catch (e) { /* a diagnostic must never break the move path */ }
}

function is_legal_position(fen) {
    let chess;
    try {
        chess = new Chess(config.variant, fen);
    } catch (e) {
        return false; // chess.js could not parse the FEN
    }
    // Strict legality only for standard chess / chess960. Other variants have their own
    // rules (antichess & horde legitimately have no king, racingkings differs) and run on
    // fairy-stockfish, which tolerates unusual positions.
    if (config.variant === 'chess' || config.variant === 'fischerandom') {
        if (chess._kings.w === -1 || chess._kings.b === -1) {
            return false; // a missing king crashes the wasm engine (OOB)
        }
        const opponent = (chess.turn() === 'w') ? 'b' : 'w';
        if (chess._isKingAttacked(opponent)) {
            return false; // side-not-to-move in check => its king is capturable (engine OOB)
        }
        const ranks = fen.split(' ')[0].split('/');
        if (/[pP]/.test(ranks[0]) || /[pP]/.test(ranks[7])) {
            return false; // pawns cannot stand on the back ranks
        }
    }
    // A castling right with no king or rook behind it is not an unusual position, it is a corrupt
    // FEN, and it is the same class of hazard as the missing king above: the bundled WASM Stockfish
    // reads the right, looks for the rook, and never answers -- the panel then waits on a bestmove
    // that is not coming. Standard chess only; in 960 the rook is not on a corner by definition.
    if (config.variant === 'chess') {
        const CASTLE_HOME = {K: ['e1', 'h1', 'w'], Q: ['e1', 'a1', 'w'],
                             k: ['e8', 'h8', 'b'], q: ['e8', 'a8', 'b']};
        for (const right of (fen.split(' ')[2] || '-')) {
            if (right === '-') continue;
            const home = CASTLE_HOME[right];
            if (!home) return false; // not a castling character at all
            const [kingSq, rookSq, color] = home;
            const king = chess.get(kingSq), rook = chess.get(rookSq);
            if (!king || king.type !== 'k' || king.color !== color) return false;
            if (!rook || rook.type !== 'r' || rook.color !== color) return false;
        }
    }
    return true;
}

// "Premove" without the blunder risk: while the opponent thinks we certify a reply to their
// PREDICTED move (max 2 candidate lines). It only fires if the new position is EXACTLY the
// predicted one -- any other move discards the table and searches normally, so a wrong guess
// costs nothing. Certification = the reply is identical at depth 13, depth 14 and the latest
// depth (>= 14) -- see PREMOVE_DEPTH_PREV/LAST. Residual risk is only a marginally weaker
// (still certified) move, never a move meant for a different position.
// Final gate before ANY premove reply is clicked: it must move OUR piece, and when it is already
// our turn (an instant reply, not a premove queued during the opponent's turn) it must be fully
// legal right now. This rejects a stale/mismatched chain that would otherwise click the opponent's
// move or an illegal move (the observed "it plays the opponent's move and gets stuck" bug).
// Premove certification window. A (their move, our reply) pair is only trusted once the search has
// reached PREMOVE_DEPTH_LAST and has not changed its mind over the final two iterations: the pair
// must be identical at depth 13, at depth 14, and at the latest depth reported. Raised from the old
// 6 / 9 / >=10 window -- a pair that is merely stable in shallow search still flips often enough by
// depth 14 that premoves were firing on replies the engine went on to abandon.
const PREMOVE_DEPTH_PREV = 13;
const PREMOVE_DEPTH_LAST = 14;

// shared by BOTH `info depth` parsers (WASM and native) so the two gates cannot drift apart
function premove_certified(line) {
    return !!line && line.depth >= PREMOVE_DEPTH_LAST
        && !!line.dPrev && line.dPrev === line.dLast && line.dPrev === line.latest;
}

function premove_reply_playable(fen, uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return false;
    try {
        const chess = new Chess(config.variant, fen);
        const our = (our_side() === 'white') ? 'w' : 'b';
        const piece = chess.get(uci.slice(0, 2));
        if (!piece || piece.color !== our) return false; // never our-play the opponent's (or an empty) square
        if (fen.split(' ')[1] === our) {                 // our turn -> the reply must be legal immediately
            chess.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        }
        return true;
    } catch (e) {
        return false; // illegal move, or can't parse -> don't play it
    }
}

// A physical premove is SAFE when the certified reply could never be legal after any opponent
// move OTHER than the predicted one: forced moves (no other moves exist) and recaptures/replies
// bound to the predicted move (anything else makes the premove illegal, and the site silently
// cancels illegal premoves). Either way it cannot fire in a wrong position.
function premove_is_safe(fen, pred, reply) {
    const [from, to, promotion] = [reply.slice(0, 2), reply.slice(2, 4), reply[4]];
    let others;
    try {
        others = new Chess(config.variant, fen).moves({verbose: true});
    } catch (e) {
        return false;
    }
    for (const move of others) {
        if (`${move.from}${move.to}${move.promotion || ''}` === pred) continue;
        try {
            const after = new Chess(config.variant, fen);
            after.move({from: move.from, to: move.to, promotion: move.promotion});
            after.move({from, to, promotion});
            return false; // the reply is also legal after a different opponent move -> could blunder
        } catch (e) {
            // reply illegal after this move: the site would cancel the premove -- safe here
        }
    }
    return true; // forced move (no other moves) or a reply only legal in the predicted position
}

// Humanize-only extra gate on premoves: even a premove that can't misfire looks robotic when it
// instantly snaps off a piece that merely moved in to attack. With Humanize on, only let a premove
// fire when a human reflexively would -- a TRUE recapture (the opponent's predicted move was itself
// a capture and we take back on that square) or a genuinely forced reply (the only legal move after
// it). Anything else is held so the normal humanized think time plays it. Off when Humanize is off:
// Mirror/Clock keep full premove speed (they don't chase the "look human" goal). Fail-safe: if the
// position can't be verified, hold the premove (with Humanize on, erring toward looking human).
function premove_human_reflex(fen, pred, reply) {
    try {
        const c = new Chess(config.variant, fen);
        const predMove = c.moves({verbose: true}).find(m => `${m.from}${m.to}${m.promotion || ''}` === pred);
        if (!predMove) return false;
        if (predMove.captured && reply.slice(2, 4) === pred.slice(2, 4)) return true; // true recapture
        c.move({from: pred.slice(0, 2), to: pred.slice(2, 4), promotion: pred[4]});
        return c.moves().length === 1; // forced: exactly one legal reply after the predicted move
    } catch (e) {
        return false;
    }
}

// Don't wait for the opponent when waiting can't help: queue the certified reply as a REAL
// site premove (clicks during their turn) whenever premove_is_safe says it can't misfire.
function maybe_premove_forced_reply(line) {
    if (premove_tracker.premoved || !config.autoplay) return;
    // taketaketake: blind premoves RE-ENABLED (user testing) -- the site has its own premove
    // system (ctx.premove in the board actor), so the same contract as chess.com/lichess should
    // hold. The earlier queen blunder predates the optimistic-state probe (v3); if it recurs,
    // gate this on `detected_prefix === 'tt'` again.
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return;
    if (!premove_certified(line)) return;
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) return;
    const mover = (premove_tracker.fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover === our_side()) return; // only while the opponent is to move
    if (premove_tracker.safe === undefined) {
        // cached per position; certification pins (pred, reply) via the depth-13 snapshot,
        // so at most one pair can ever be checked here per position
        premove_tracker.safe = premove_is_safe(premove_tracker.fen, line.pred, line.reply);
    }
    if (!premove_tracker.safe) return;
    // Humanize: hold premoves that aren't a true recapture / forced reply (see premove_human_reflex)
    if (config.humanize && !premove_human_reflex(premove_tracker.fen, line.pred, line.reply)) return;
    premove_tracker.premoved = true;
    // DOUBLE PREMOVE (chess.com only): if the continuation after our reply is also forced, queue a
    // second premove in the same click session. Only when the whole 2-ply line is forced can the
    // second move never land in a wrong position -- see forced_second_premove.
    const second = forced_second_premove(premove_tracker.fen, line.pred, line.reply);
    if (second) {
        console.log('Premove: forced 2-ply chain -- double premove', line.reply, second);
        request_double_premove([line.reply, second]);
    } else {
        console.log('Premove: reply cannot misfire (forced/bound to predicted move) -- premoving', line.reply);
        request_automove(line.reply);
    }
}

// Second premove for a DOUBLE premove. Returns its UCI, or null if the line isn't forced enough to
// stack one safely. chess.com only, standard chess only. The bar is "1 legal move back to back": the
// opponent's move (pred) must be their ONLY legal move here, and after our reply the opponent must be
// forced again (1 legal move), and our follow-up then forced (1 legal move) -- that lone move is the
// second premove. Anything less and a different opponent move could leave the second premove in a
// position it was never meant for, so we return null and queue just the one.
function forced_second_premove(fen, pred, reply) {
    if (detected_prefix !== 'cc' || (config.variant && config.variant !== 'chess')) return null;
    try {
        const c = new Chess(config.variant, fen);
        if (c.moves().length !== 1) return null;                                      // opp not forced -> pred uncertain
        c.move({from: pred.slice(0, 2), to: pred.slice(2, 4), promotion: pred[4]});   // M1: opp's only move
        c.move({from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4]}); // R1: our first premove
        if (c.moves().length !== 1) return null;                                      // opp not forced next -> no known M2
        c.move(c.moves({verbose: true})[0]);                                          // M2: opp's only move
        if (c.moves().length !== 1) return null;                                      // our follow-up not forced
        const r2 = c.moves({verbose: true})[0];                                       // R2: our only legal move
        return `${r2.from}${r2.to}${r2.promotion || ''}`;
    } catch (e) {
        return null; // couldn't build/verify the chain -> just the single premove
    }
}

function premove_instant_reply(new_fen, new_moves) {
    if (!config.premove || !config.autoplay) return null;
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return null;
    if (premove_tracker.premoved) return null; // already queued as a real site premove
    if (!premove_tracker.fen || premove_tracker.fen !== last_eval.fen) return null;
    const mover = (new_fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover !== our_side()) return null; // the certified reply must be OUR move
    let certified = 0;
    for (let idx = 0; idx < premove_lines; idx++) {
        const line = premove_tracker.lines[idx];
        if (!premove_certified(line)) continue;
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) continue;
        certified++;
        // primary match: the exact MOVE, per the premove contract (robust across sites --
        // fen string reconstruction proved fragile)
        // Humanize holds non-reflex replies (returns null -> normal humanized search plays it);
        // off when Humanize is off, so plain Premove / Clock / Mirror keep full instant speed.
        const held = config.humanize && !premove_human_reflex(premove_tracker.fen, line.pred, line.reply);
        if (premove_tracker.moves && new_moves
                && new_moves === `${premove_tracker.moves} ${line.pred}`) {
            return held ? null : line.reply; // the opponent played exactly the predicted move
        }
        try { // fallback for moves-less contexts: apply the prediction and compare positions
            const chess = new Chess(config.variant, premove_tracker.fen);
            chess.move({from: line.pred.slice(0, 2), to: line.pred.slice(2, 4), promotion: line.pred[4]});
            if (chess.fen() === new_fen) {
                return held ? null : line.reply;
            }
        } catch (e) {
            // predicted move not applicable to this position; fall through to the next line
        }
    }
    if (certified) { // diagnostic: we HAD a certified reply and the opponent's move missed it
        console.log('Premove(WASM): no match for certified line(s)',
            {tracked: premove_tracker.moves, got: new_moves});
    }
    return null;
}

// While pondering we don't know which move the opponent will pick -- and they won't mirror the
// engine's #1 -- so ponder the top 5 candidate replies: it warms the TT for whichever they play and
// lets Premove certify a reply to any of them. Applies to every engine: the caller sits above the
// engine branch in on_new_pos, and the native path pushes the matching MultiPV to its host.
// Narrow it when the position is forcing, where the
// realistic replies are few and the width is better spent on depth: 1-2 legal moves (a real forced
// move), or a recapture of the piece we just moved (lastUci's destination is capturable).
function ponder_line_count(fen, lastUci) {
    try {
        const legal = new Chess(config.variant, fen).moves({verbose: true});
        if (legal.length <= 2) return Math.max(1, legal.length);
        const ourDest = /^[a-h][1-8][a-h][1-8]/.test(lastUci || '') ? lastUci.slice(2, 4) : null;
        if (ourDest && legal.some(m => m.to === ourDest && m.captured)) return 2; // recapture likely
        return 5;
    } catch (e) {
        return 5; // variant fen chess.js can't parse: default to the wide ponder
    }
}

// --- Opening explorer -------------------------------------------------------------------------
// Human opening data from lichess, used two ways: an overlay in the panel (`explorer`), and an
// actual weighted-random book move (`book_play`). They are separate toggles on purpose -- switching
// on a read-out must never silently change your play.
//
// It is NEVER on the critical path. The lookup is fired the moment a position arrives and never
// awaited: if the answer hasn't landed by the time the engine's move is ready, the engine move is
// played and the book is simply skipped for that move. A slow or rate-limited request can therefore
// never delay a move or eat into a Clock/Mirror time budget.
const BOOK_MIN_GAMES = 20;   // drop 3-game oddities -- the move must be statistically real
const BOOK_MAX_LOSS = 40;    // cp: the engine's veto. A book move this far below its best is "worse"
let explorer_data = null;    // {fen, moves:[...], opening} for the position we last looked up
let explorer_out_of_book = false; // latched per game: first empty answer stops all further lookups
let explorer_error = null;   // last lookup failure, shown in the overlay instead of drawing nothing
const INITIAL_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'; // standard start array
let setup_fen = null;        // a manually set position: while held, page scrapes are IGNORED
let snap_crop = null;        // the screen rect the last capture came from, for re-scanning it

// A panel reload rebuilds this whole script, so every module variable goes with it -- including a
// position you had just captured off the screen. Changing Engine or Variant would silently throw
// your board away and go back to following the page. Park it in storage across the rebuild instead.
// (Threads, Hash, Lines and the poll no longer reload at all -- see the settings handler.)
const SETUP_STASH_KEY = 'setup_fen_stash';

function stash_setup_state() {
    try {
        if (setup_fen) {
            MephistoConfig.set(SETUP_STASH_KEY, JSON.stringify({fen: setup_fen, crop: snap_crop, view: setup_view, flipped: snap_flipped}));
        } else {
            MephistoConfig.set(SETUP_STASH_KEY, JSON.stringify(null));
        }
    } catch (e) { /* storage unavailable -- the reload simply loses it, as before */ }
}

function restore_setup_state() {
    try {
        const raw = JSON.parse(MephistoConfig.get(SETUP_STASH_KEY) || 'null');
        if (!raw?.fen || !is_legal_position(raw.fen)) return false;
        setup_fen = raw.fen;
        snap_crop = raw.crop || null;
        setup_view = (raw.view === 'white' || raw.view === 'black') ? raw.view : null;
        snap_flipped = !!raw.flipped;
        const row = PANEL_ROOT.getElementById('setup-fen-row');
        if (row) row.style.display = '';
        const input = PANEL_ROOT.getElementById('setup_fen_input');
        if (input) input.value = setup_fen;
        setup_fen_msg(i18n('panel.fen.restored', 'Restored the position you had set — Re-detect to follow the page again'));
        update_snap_follow_button();
        try {
            turn = setup_fen.split(' ')[1] || 'w';
            board.orientation(setup_view || (turn === 'w' ? 'white' : 'black'));
            board.position(setup_fen);
            update_turn_badge(setup_fen);
        } catch (e) { /* board not ready yet */ }
        on_new_pos(setup_fen, setup_fen, '');
        return true;
    } catch (e) {
        return false;
    }
}
let explorer_empty_streak = 0; // consecutive empty lookups; 3 = genuinely out of book

// --- Syzygy tablebase --------------------------------------------------------------------------
// With <=7 men on the board the position is SOLVED, so a hit here is not an opinion the engine can
// out-search -- it is the answer, and it beats any move a bounded search produces. Probed over the
// network (in the service worker, so the page issues nothing): the real tablebases are hundreds of
// gigabytes, which is not something to ship with a browser extension.
//
// Off by default and opt-in under Settings, exactly like the Opening Explorer: it tells a third
// party the position you are looking at, and that is the user's call to make, not a default.
//
// NEVER on the critical path. The lookup is fired when a position arrives and never awaited -- if
// the answer has not landed by the time the engine's move is ready, the engine's move is played and
// the probe is simply skipped for that move. A slow or blocked endpoint cannot delay a move or eat
// into a Clock/Mirror budget.
const TABLEBASE_MAX_MEN = 7;   // the largest Syzygy set lichess serves
let tablebase_data = null;     // {fen, category, dtz, dtm, moves:[...]} for the last position probed

// lichess serves Syzygy for standard, atomic and antichess only (probed -- everything else 404s).
// Chess960 is excluded on purpose: a <=7-man 960 position can still carry castling rights, which
// Syzygy does not model, so /standard would be answering about a different position.
const TABLEBASE_VARIANTS = ['chess', 'atomic', 'antichess'];

function tablebase_enabled() {
    return config.tablebase && TABLEBASE_VARIANTS.includes(config.variant || 'chess');
}

// men on the board, straight off the FEN placement field
function piece_count(fen) {
    return (fen.split(' ')[0].match(/[prnbqkPRNBQK]/g) || []).length;
}

// Fire-and-forget. Never awaited by the move path (see the note above).
function request_tablebase(fen) {
    if (!tablebase_enabled()) return;
    // A hidden tab makes no third-party requests -- unless Background Play is on, in which case the
    // game IS still being played and a tablebase answer is exactly as wanted as it is in front of you.
    if (document.hidden && !config.background_play) return;
    if (piece_count(fen) > TABLEBASE_MAX_MEN) return;  // out of range -- don't ask
    if (tablebase_data?.fen === fen) return;           // already have this position
    chrome.runtime.sendMessage({tablebaseLookup: {fen, variant: config.variant || 'chess'}}, (res) => {
        if (chrome.runtime.lastError || !res || res.error || !res.moves?.length) return;
        tablebase_data = {fen, ...res};
        console.log(`Tablebase: ${res.category} (dtz ${res.dtz}, dtm ${res.dtm}) -> ${res.moves[0].uci}`);
        update_best_move_suffix();
    });
}

// The optimal move for THIS position, or null. lichess returns `moves` sorted best-first, so the
// answer is simply moves[0] -- there is nothing to weigh or filter, and deliberately no "is the
// engine's move close enough" check like the opening book has: a solved position has a best move
// and everything else is worse by definition.
function tablebase_pick(fen) {
    if (!tablebase_enabled()) return null;
    if (tablebase_data?.fen !== fen) return null;      // stale or never answered
    const best = tablebase_data.moves?.[0]?.uci;
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best ?? '') ? best : null;
}

// Appended to the move readout so a tablebase move is never silently substituted for the engine's.
function tablebase_label() {
    if (!tablebase_data || tablebase_data.fen !== last_eval.fen) return '';
    const c = tablebase_data.category;
    const n = Math.abs(tablebase_data.dtm ?? tablebase_data.dtz ?? 0);
    if (c === 'win') return i18n('panel.tb.win', 'Tablebase: win in {n}', {n});
    if (c === 'loss') return i18n('panel.tb.loss', 'Tablebase: lost in {n}', {n});
    if (c === 'draw') return i18n('panel.tb.draw', 'Tablebase: draw');
    if (c === 'cursed-win') return i18n('panel.tb.cursed', 'Tablebase: win in {n} (50-move drawn)', {n});
    if (c === 'blessed-loss') return i18n('panel.tb.blessed', 'Tablebase: loss (50-move drawn)');
    return '';
}

// --- Lichess puzzle database ---------------------------------------------------------------------
// Opt-in, and opting in is importing the file (Settings -> Puzzle Database). With nothing imported
// every lookup misses and Puzzle Mode behaves exactly as it always has.
//
// Why it is worth having: the engine's best move and the puzzle's INTENDED move are not the same
// thing. A puzzle has one scored answer, and a stronger move that isn't it still loses the puzzle.
// When the position is in the database the whole solution is known, so there is nothing to search.
//
// The read has to go through the service worker. This panel runs in the page's ISOLATED WORLD, and
// an isolated world's indexedDB belongs to the SITE -- the extension's database is not reachable
// from here at all, however the code is arranged.
//
// A hit is expanded ONCE into every our-turn position of the line, so plies 2, 3, 4... answer from
// memory with no further round-trip. If the opponent ever leaves the line the position simply isn't
// in the map, the lookup misses, and the engine plays -- no special case needed.
let puzzle_solutions = null;   // Map(placement+stm -> our uci) for the line we last matched
let puzzle_asked = null;       // the position the last request was for (don't re-ask on every poll)

const PUZZLE_DB_SITES = ['li', 'cc'];   // sites a puzzle database can be imported for
function puzzle_db_enabled() {
    // LICHESS ONLY, and that is a resource decision as much as a correctness one. The database is
    // built from lichess games, so a chess.com or BlitzTactics position is not in it and never will
    // be -- looking it up there is a message to the service worker and a disk read per position, every
    // one of them a guaranteed miss. Ask only where an answer can exist.
    //
    // Standard chess only for the same reason plus one: the key is a bare placement, so a variant
    // position could in principle collide with a standard one.
    // Each site has its OWN database now, so the question is no longer "is this lichess" but
    // "does a database exist for where we are". BlitzTactics and TakeTakeTake still have none, and
    // asking there would be a message and a disk read per position for a guaranteed miss.
    if (!PUZZLE_DB_SITES.includes(detected_prefix)) return false;
    return config.puzzle_mode && (!config.variant || config.variant === 'chess');
}

function puzzle_key(fen) {
    const parts = String(fen).split(' ');
    return `${parts[0]} ${parts[1] || 'w'}`;
}

// Walk the solution from the position it was stored against, recording OUR move for each of our
// turns. The stored line alternates ours/theirs starting with ours, so our positions are the even
// steps. chess.js is what makes the intermediate positions trustworthy -- unlike the import, this
// runs once per puzzle, not six million times.
function puzzle_expand(fen, solution) {
    const map = new Map();
    try {
        const chess = new Chess(config.variant, fen);
        const moves = solution.split(' ').filter(Boolean);
        for (let i = 0; i < moves.length; i++) {
            if (i % 2 === 0) map.set(puzzle_key(chess.fen()), moves[i]);
            const m = moves[i];
            if (!chess.move({from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4]})) break;
        }
    } catch (e) {
        return map; // a line that doesn't replay gives back whatever it managed; the rest just misses
    }
    return map;
}

// --- Puzzle Storm / Racer -------------------------------------------------------------------------
// These pages DO ship their whole puzzle set with the page -- exact FEN and full solution for every
// puzzle, 137 for Storm and 69 for Racer -- which would be better than the database here: no import
// needed, and an exact FEN on a page that has no move list and therefore has to infer castling and
// en passant.
//
// It was implemented and REVERTED, because re-fetching the URL to read that payload returns a
// DIFFERENT RUN. Verified against a live board: the position on screen matched NONE of the 137
// puzzles a fetch returned. Feeding those solutions would play confidently wrong moves -- strictly
// worse than not having the feature.
//
// (The test that made it look safe compared two fetches TO EACH OTHER. Both were new runs, so they
// agreed with each other and told us nothing about the run being displayed. Compare against the
// rendered board, never against another copy of the same guess.)
//
// The data is only in the page at LOAD time -- lichess deletes its own bootstrap script once it has
// read it, which is why it cannot be re-read afterwards. A correct implementation would need a
// content script at `run_at: document_start` capturing that script node before the page removes it.
// Not built: it is a real change to how the extension injects, and unverified guesses have cost
// enough today.

// Fire-and-forget, exactly like the tablebase probe: the move path never awaits it, it either has an
// answer by the time a move is due or it doesn't.
function request_puzzle_solution(fen) {
    if (!puzzle_db_enabled()) return;
    if (puzzle_solutions?.has(puzzle_key(fen))) return; // already covered by the line in hand
    if (puzzle_asked === puzzle_key(fen)) return;       // asked once; the answer is coming or was null
    puzzle_asked = puzzle_key(fen);
    chrome.runtime.sendMessage({puzzleLookup: {fen, site: detected_prefix}}, (res) => {
        // ANSWERED EITHER WAY. A miss used to return silently, which is why the search had to be
        // started speculatively -- and a search started speculatively is a search that can finish
        // first and play the engine's move into a puzzle the database could have answered.
        puzzle_answered = puzzle_key(fen);
        if (chrome.runtime.lastError || !res || res.error || !res.solution) {
            release_deferred_search(fen);
            return;
        }
        // A HIT ends the wait too. Without this the deferral stays armed and its watchdog re-enters
        // on_new_pos 1.5s later for a position that has already been answered and played.
        puzzle_deferred = null;
        clearTimeout(puzzle_defer_timer);
        puzzle_solutions = puzzle_expand(fen, res.solution);
        puzzle_rating = res.rating ?? null;
        console.log(`Puzzle DB: solution known -- ${res.solution}` +
                    (puzzle_rating ? ` (rated ${puzzle_rating})` : ''));
        update_best_move_suffix();
        // The answer landed after on_new_pos ran: draw it and play it now.
        if (last_eval.fen === fen) draw_moves();
        maybe_play_puzzle_move(fen);
    });
}

// The position we have a definitive database answer for -- hit OR miss -- and the search that is
// waiting on one. Puzzle Mode holds the engine until the database has spoken, because an engine move
// played into a position the database knew is precisely how a solved puzzle gets failed.
let puzzle_answered = null;
let puzzle_deferred = null;   // {fen, startFen, moves} -- re-entered once the answer lands
let puzzle_defer_timer = null;
// How long the engine will wait on the database before giving up and searching anyway. A lookup is
// one message and one indexed read, so this is generous by an order of magnitude -- it exists so a
// worker that never answers costs a slower move rather than NO move, which is the worse failure.
const PUZZLE_LOOKUP_WAIT_MS = 1500;

function release_deferred_search(fen) {
    const w = puzzle_deferred;
    if (!w || puzzle_key(w.fen) !== puzzle_key(fen)) return;
    puzzle_deferred = null;
    clearTimeout(puzzle_defer_timer);
    console.log('Puzzle DB: no entry for this position -- searching normally');
    on_new_pos(w.fen, w.startFen, w.moves);
}

// Our move in THIS position per the database, or null.
function puzzle_pick(fen) {
    if (!puzzle_db_enabled()) return null;
    const uci = puzzle_solutions?.get(puzzle_key(fen));
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '') ? uci : null;
}

// Play the known move NOW, without waiting for the engine.
//
// This started out hanging off the engine's bestmove handler, next to the tablebase and book picks,
// and that was wrong twice over. It made the whole feature depend on a search TERMINATING -- so with
// Autoplay's `go movetime` it merely wasted the search, and on any path that does not produce a
// terminal bestmove nothing was ever played at all. Worse, the gate around that block tests whether
// the ENGINE's move is playable, so a database move could be discarded because the engine's own
// suggestion was unusable. And it defeats the point: when the position is in the database the entire
// solution is known, and there is nothing left for a search to decide.
//
// Is there a known move for this position that we are allowed to play right now? Split from the
// action because on_new_pos has to decide whether to start a search BEFORE it is in a state where
// the move can actually be issued.
//
// Same safety the engine's own moves get: the move must belong to US and be legal here. A database
// hit is a position match, not proof that this board is that position.
function puzzle_move_ready(fen) {
    if (!config.autoplay || config.help_mode || config.manual_mode || config.simon_says_mode) return null;
    const uci = puzzle_pick(fen);
    if (!uci) return null;
    if (!premove_reply_playable(fen, uci)) {
        console.warn('Mephisto: ignoring a puzzle move that is not ours/legal here:', uci);
        return null;
    }
    return uci;
}

// Called at the end of on_new_pos AND from the lookup callback -- on the first position of a puzzle
// the answer arrives a moment after on_new_pos has already run. No latch of its own: a second call
// for the same position is what a FAILED move needs (the content-script re-pushes it), and a double
// click is already impossible -- the content-script's `moving` guard drops it.
// A beat before the first click, and ONLY on a database move.
//
// Every other move path has a search in front of it, and that search is what has always been letting
// the board finish animating before anything gets clicked. A known solution has no search to hide
// behind: without this the click is issued in the same tick as the scrape that produced it, while the
// opponent's reply is still moving across the board. That is what made the mismatch guard fire on
// essentially every puzzle move. Delaying the SEND (rather than sleeping inside the click sequence)
// also means the content-script's guard judges a board that has settled.
const PUZZLE_MOVE_DELAY_MS = 300;
// Depth for the look-only search run when the database already knows the answer. Not a budget in
// milliseconds: the point is a comparable number on every machine, not a fixed wait.
const PUZZLE_DISPLAY_DEPTH = 10;
let puzzle_display_search = false;   // the search in flight decides nothing and must not be played
// The pending pre-move pause. Superseded rather than stacked: on_new_pos can legitimately run twice
// for the SAME board -- a re-push flagged as a resume does exactly that -- and two live timers would
// send the move twice, which the content-script then has to drop on its `moving` guard.
let puzzle_move_timer = null;
let puzzle_rating = null;   // what the publisher rated the puzzle we are on, when they said

// ...and a watchdog behind it, because the puzzle click path does NOT verify itself.
//
// A normal autoplay move goes through simulateMoveVerified: it checks the move list actually grew,
// retries, and on final failure clears both dedupes so the position is re-analysed. A puzzle move is
// one UNVERIFIED click. So any single failure -- a dropped click, a mismatch abort, a mid-animation
// board -- is PERMANENT: the board never changes, so the popup's own `last_eval.fen` dedupe swallows
// every re-push and nothing ever tries again. That is the difference between a hiccup and a panel
// that has quietly stopped playing.
//
// Capped, and deliberately no engine fallback after the cap: the failure here is in CLICKING, not in
// choosing the move, and the engine's move would go out through the very same clicks.
// Bounded by TIME, not by attempts. It counted attempts first, and the log showed why that is
// wrong: three retries inside four seconds all came back "DROPPED: a previous move is still in
// progress" -- which is not a failed move, it is a move still happening -- and then it gave up on a
// position that was about to work. Time is the honest budget: keep offering the move until the board
// changes or the window closes, and let the content-script drop whatever arrives too early.
const PUZZLE_MOVE_RETRY_MS = 1500;
const PUZZLE_MOVE_WINDOW_MS = 9000;
let puzzle_retry_timer = null;
let puzzle_retry = {key: null, until: 0};

function maybe_play_puzzle_move(fen, opts = {}) {
    const uci = puzzle_move_ready(fen);
    if (!uci) return false;
    console.log(`Puzzle DB: playing ${uci} (known solution, no search)`);
    abandon_search(); // no search is wanted here, and none of its output should arrive behind ours
    toggle_calculating(false);
    update_best_move(i18n('panel.msg.puzzle_solution', 'Puzzle solution: {move}', {move: uci}));
    clearTimeout(puzzle_move_timer);
    puzzle_move_timer = setTimeout(() => {
        // Only skip if the BOARD really moved on. Compared on placement + side to move, not on the
        // whole FEN: on a puzzle page the castling rights and ep square are inferred and the move
        // counters are often re-derived, so the FEN string can change while the position in front of
        // you has not. Comparing strings here meant a cosmetic re-scrape cancelled the move -- and
        // because this function had already told on_new_pos it was handling things (returning true,
        // which skips the search), that left the position with NO move and NO search at all.
        if (puzzle_key(last_eval.fen) !== puzzle_key(fen)) {
            console.log('Puzzle DB: position moved on during the pre-move pause -- not sending');
            return;
        }
        request_automove(uci, null, false, {paused: true, retry: opts.retry});
        watch_puzzle_move(fen, uci);
    }, PUZZLE_MOVE_DELAY_MS);
    return true;
}

// Did the move we just sent actually land? The only evidence that matters is the board changing, so
// that is what this waits for: same position still there = it did not land = send it again.
function watch_puzzle_move(fen, uci) {
    const key = puzzle_key(fen);
    // A new position opens a fresh window; the same one keeps the deadline it already had.
    if (puzzle_retry.key !== key) puzzle_retry = {key, until: Date.now() + PUZZLE_MOVE_WINDOW_MS};
    clearTimeout(puzzle_retry_timer);
    puzzle_retry_timer = setTimeout(() => {
        if (puzzle_key(last_eval.fen) !== key) return; // the board moved on -- the move landed
        if (Date.now() > puzzle_retry.until) {
            console.warn(`Mephisto: puzzle move ${uci} did not land within ` +
                `${PUZZLE_MOVE_WINDOW_MS}ms -- giving up on this position (Re-detect to retry)`);
            bgTrace('puzzle move gave up', {uci});
            return;
        }
        bgTrace('puzzle move re-issued', {uci, msLeft: puzzle_retry.until - Date.now()});
        maybe_play_puzzle_move(last_eval.fen, {retry: true});
    }, PUZZLE_MOVE_RETRY_MS);
}

// Appended to the move readout, so a database move is never silently substituted for the engine's.
function puzzle_label() {
    if (!puzzle_pick(last_eval.fen)) return '';
    // The rating belongs on THIS line rather than beside the move: this is the line that says where
    // the move came from, and "how hard was it" is the same kind of fact.
    return i18n('panel.puzzle_db_label', 'Puzzle database')
        + (puzzle_rating ? ` (${i18n('panel.msg.puzzle_rating', 'Rating {r}', {r: puzzle_rating})})` : '');
}

function explorer_enabled() {
    return (config.explorer || config.book_play)
        && (!config.variant || config.variant === 'chess') // API is standard-chess only here
        && !config.puzzle_mode;                            // puzzles are not book positions
}

// Fire-and-forget. Never awaited by the move path (see the note above).
function request_explorer(fen) {
    if (!explorer_enabled() || explorer_out_of_book) return;
    // Same rule as the tablebase probe: silent in a hidden tab, unless Background Play says the game
    // is still going. Otherwise a backgrounded game silently loses its book moves.
    if (document.hidden && !config.background_play) return;
    if (explorer_data?.fen === fen) return; // already have this position
    chrome.runtime.sendMessage({explorerLookup: {fen, db: config.explorer_db || 'masters'}}, (res) => {
        // A failed lookup must SAY so. Drawing nothing is indistinguishable from "the feature is
        // broken" -- which is exactly how a blocked endpoint presented.
        if (chrome.runtime.lastError || !res || res.error) {
            explorer_error = res?.error || chrome.runtime.lastError?.message || 'no response';
            explorer_data = null;
            console.warn('Mephisto: explorer lookup failed -', explorer_error);
            render_explorer();
            return;
        }
        explorer_error = null;
        if (!res.moves?.length) {
            // Don't latch on a SINGLE empty answer. "Out of book" at move 1 is impossible, so one
            // empty response means something is wrong with the lookup, not that the game left book
            // -- and latching there would kill the feature for the rest of the game with no retry.
            // Three in a row is a real exit from book; anything less retries on the next move.
            explorer_empty_streak++;
            console.warn(`Mephisto: explorer returned no moves for ${fen} (${explorer_empty_streak}/3)`);
            if (explorer_empty_streak >= 3) explorer_out_of_book = true;
            explorer_data = null;
            render_explorer();
            return;
        }
        explorer_empty_streak = 0;
        explorer_data = {fen, moves: res.moves, opening: res.opening || null};
        render_explorer();
    });
}

// Weighted-random pick, with BOTH filters the design calls for:
//   1. minimum games   -- the move has to be statistically real, not a 3-game curiosity
//   2. the engine veto -- it must also be within BOOK_MAX_LOSS cp of the engine's own best, judged
//      from the MultiPV lines the engine is already producing (no extra search)
// Returns a UCI move, or null to let the engine's move stand.
function book_pick(fen) {
    if (!config.book_play || !explorer_data || explorer_data.fen !== fen) return null;
    const evals = engine_line_scores();          // uci -> cp, from the current MultiPV lines
    const best = Math.max(...Object.values(evals), -Infinity);
    const pool = [];
    for (const m of explorer_data.moves) {
        const games = (m.white || 0) + (m.draws || 0) + (m.black || 0);
        if (games < BOOK_MIN_GAMES) continue;                       // filter 1: statistically real
        const cp = evals[m.uci];
        if (cp === undefined) continue;                             // engine never looked at it -> skip
        if (Number.isFinite(best) && best - cp > BOOK_MAX_LOSS) continue; // filter 2: engine veto
        pool.push({uci: m.uci, games});
    }
    if (!pool.length) return null;
    let roll = Math.random() * pool.reduce((s, m) => s + m.games, 0);
    for (const m of pool) { if ((roll -= m.games) <= 0) return m.uci; }
    return pool[pool.length - 1].uci;
}

// cp score per first-move-of-PV, from the lines the engine has already returned for this position.
// Mate scores collapse to a large cp so a mate never loses the veto comparison.
// Scores are OURS, not White's. `line.score`/`line.mate` are stored WHITE-relative (see the
// (turn === 'w' ? 1 : -1) flip in the info parsers), so book_pick's `Math.max(...)` was picking the
// line best for WHITE. As Black that is the line worst for us: the veto then kept the blunders and
// discarded the good book moves, and only as Black -- correct as White, so invisible half the time.
// line_cp_ours is the flip every other consumer already goes through, including mate-in-0.
function engine_line_scores() {
    const out = {};
    for (const line of last_eval.lines || []) {
        if (!line?.pv) continue;
        const uci = pv_moves(line.pv)[0];
        if (!uci) continue;
        const cp = line_cp_ours(line);
        if (typeof cp === 'number') out[uci] = cp;
    }
    return out;
}

// --- Set up a position by FEN ------------------------------------------------------------------
// Opens an input under the lines; a valid FEN is analysed instead of the page's board. While one is
// held the panel stops following the page entirely (see the `setup_fen` guard in the scrape handler),
// because a live scrape would otherwise replace it on the next poll.
// Play a move on the PANEL's own board and keep analysing from there. Any move takes the panel out
// of page-following mode (the same `setup_fen` hold the FEN box uses) -- otherwise the next scrape
// would overwrite the position a second later. That makes the little board a usable analysis board:
// set up or capture a position, then walk the line move by move. Returns false on an illegal move so
// the board just drops the selection.
// Does this move promote? Returns the mover's colour (so the picker shows the right pieces), or
// null. Asked BEFORE the move is made, so it works for click and drag alike.
function panel_move_promotes(from, to) {
    const base = setup_fen || last_eval.fen;
    if (!base) return null;
    try {
        const c = new Chess(config.variant, base);
        const m = c.moves({verbose: true}).find(x => x.from === from && x.to === to && x.promotion);
        return m ? m.color : null;
    } catch (e) {
        return null; // can't tell -> don't interrupt with a picker, the move path will auto-queen
    }
}

// --- Panel move history -------------------------------------------------------------------------
// A line you can walk. Every move played ON THE PANEL BOARD is appended here with the position it
// produced, so you can click back to any point and carry on from there -- and playing a different
// move at that point OVERWRITES the rest, which is what you want when you are trying something out
// rather than reviewing a fixed game.
//
// Deliberately a single line, not a tree. A branching tree needs a tree UI, and the thing being asked
// for is "let me take that back and try the other move", which truncation answers exactly.
let panel_line = [];      // [{san, uci, fen}] -- fen is the position AFTER that move
let panel_line_base = ''; // the position the line started from
let panel_line_idx = -1;  // -1 = at the base position, otherwise the index we are sitting on

function panel_line_reset(base) {
    panel_line = [];
    panel_line_base = base || '';
    panel_line_idx = -1;
    render_panel_line();
}

// Append a move, truncating anything after the point we are currently sitting on.
function panel_line_push(san, uci, fen) {
    if (panel_line_idx < panel_line.length - 1) panel_line.length = panel_line_idx + 1; // overwrite
    panel_line.push({san, uci, fen});
    panel_line_idx = panel_line.length - 1;
    render_panel_line();
}

// Jump to a point in the line. -1 is the position it started from.
function panel_line_goto(idx) {
    if (idx < -1 || idx >= panel_line.length) return;
    const fen = (idx === -1) ? panel_line_base : panel_line[idx].fen;
    if (!fen) return;
    panel_line_idx = idx;
    setup_fen = fen;
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = fen;
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = '';
    setup_fen_msg(i18n('panel.fen.walking_line', 'Walking the panel line — play a move to continue from here, Re-detect to follow the page'));
    last_eval.fen = ''; prev_ply_count = 0;
    abandon_search();
    try {
        turn = fen.split(' ')[1] || 'w';
        board.position(fen);
        update_turn_badge(fen);
    } catch (e) { /* board not ready */ }
    render_panel_line();
    on_new_pos(fen, fen, '');
}

function render_panel_line() {
    const el = PANEL_ROOT.getElementById('panel-line');
    if (!el) return;
    if (!panel_line.length) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    const parts = [`<span class="pl-move${panel_line_idx === -1 ? ' pl-current' : ''}" data-idx="-1">start</span>`];
    panel_line.forEach((m, i) => {
        const num = (i % 2 === 0) ? `${Math.floor(i / 2) + 1}.` : '';
        parts.push(`<span class="pl-move${i === panel_line_idx ? ' pl-current' : ''}" data-idx="${i}">${num}${m.san}</span>`);
    });
    el.innerHTML = parts.join(' ');
    // Scroll the strip ITSELF, by setting its scrollLeft. NOT scrollIntoView(): that walks up and
    // scrolls every ancestor scroll container it finds, which here means the panel body -- so a line
    // long enough to overflow dragged the WHOLE panel sideways and clipped the title, the readout and
    // the FEN box off the left edge.
    const cur = el.querySelector('.pl-current');
    if (cur) {
        const target = cur.offsetLeft - (el.clientWidth / 2) + (cur.offsetWidth / 2);
        el.scrollLeft = Math.max(0, target);
    }
}

// Where the piece on `square` may legally go, for the board's move dots. The board itself knows no
// rules -- it draws pieces and reports clicks -- so legality is answered here, against the position
// the panel is actually analysing.
//
// Returns [] rather than throwing on anything unexpected: a piece with no legal moves still selects,
// and an empty list is the honest answer for a pinned or blocked one. It also means a variant fen
// chess.js cannot parse degrades to "no dots" instead of breaking the board.
function panel_legal_targets(square) {
    try {
        const base = setup_fen || last_eval.fen;
        if (!base) return [];
        return new Chess(config.variant, base)
            .moves({square, verbose: true})
            .map(m => m.to);
    } catch (e) {
        return [];
    }
}

function play_on_panel_board(from, to, promotion) {
    const base = setup_fen || last_eval.fen;
    if (!base) return false;
    let next, san;
    try {
        const c = new Chess(config.variant, base);
        // `promotion` comes from the board's picker when the move promotes; queen otherwise
        const mv = c.move({from, to, promotion: promotion || 'q'});
        if (!mv) return false;
        next = c.fen();
        san = mv.san; // `mv` is block-scoped to this try -- read what we need while it is in scope
    } catch (e) {
        return false; // illegal move (or a variant fen chess.js can't parse) -> keep the position
    }
    // record it in the walkable line BEFORE setup_fen moves on -- the base is whatever we were on
    if (!panel_line.length && !panel_line_base) panel_line_base = base;
    panel_line_push(san, `${from}${to}${promotion || ''}`, next);
    setup_fen = next;
    stash_setup_state();
    // SHOW the setup row: it carries the "not following the page" message and the live FEN, and a
    // hidden row would leave that state invisible -- the board would just stop tracking the game with
    // no explanation. It also means the FEN of whatever you've walked to is always there to copy.
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = '';
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = next;
    setup_fen_msg(i18n('panel.fen.panel_board', 'Playing on the panel board — Re-detect to follow the page again'));
    last_eval.fen = ''; prev_ply_count = 0;
    opp_spend = opp_clock_mark = last_our_eval = null;
    explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0;
    abandon_search();
    turn = next.split(' ')[1];
    // The header switch is only refreshed on the SCRAPE path, and a move played on the panel board
    // never goes near it -- so walking a line left the header stuck on whoever moved first while the
    // position underneath it had moved on. It is the panel's own move; it has to keep its own state.
    update_turn_badge(next);
    on_new_pos(next, next, '');
    return true;
}

// Read the position off the screen. Captures the tab, lets the recogniser find the board, and loads
// the result as a manual position -- so it works on any page (a video, a diagram, an image), and the
// board it produces is immediately playable. `crop` (from the drag-select fallback) skips detection.
// Rotate a position 180 degrees: a1 becomes h8. Colours are untouched -- this turns the BOARD, it
// does not swap sides.
//
// Needed because the board reader has no idea which way round the board on screen was. It maps the
// image's top-left corner to a8, always, so a board shown from Black's perspective (which is how
// every game looks to the player with black, and how plenty of videos are framed) is read upside
// down. The result is usually still a LEGAL position, so nothing downstream can catch it -- it just
// quietly analyses a different game. Detecting the orientation from pixels is not reliable, so this
// is offered as one click instead of guessed at.
// Which way up the panel draws a HELD position (a typed FEN or one read off the screen), or null to
// derive it from the side to move as before. It is remembered across follow ticks and panel rebuilds,
// because a board being watched on a screen does not turn round between plies -- and re-deriving it
// from the turn meant the view flipped every single move.
let setup_view = null;
// FOLLOW SCREEN reads a fresh board every tick and always maps the image's top-left to a8. On a
// board drawn from Black's side every read is therefore 180 degrees out -- and, because a rotated
// position is usually still LEGAL, nothing notices. Flipping used to rotate `setup_fen` only, so the
// very next read came back unrotated, could not be explained as one legal move, and re-seeded from
// the raw placement -- silently undoing the flip. That is the board "randomly flipping back".
// This flag makes the flip STICK: every incoming read is rotated before it is used.
let snap_flipped = false;

// The colour the panel is ANSWERING FOR, which is not the same question as which way the board is
// drawn. On a live game they coincide: the side the page shows us is the side we play. On a held
// position there is no "us" -- the answer wanted is always for whoever is to move -- and that is what
// apply_setup_fen used to encode by forcing the orientation to follow the turn. Splitting the two is
// what lets Flip board turn the VIEW round without the panel concluding it now plays the other
// colour and going quiet. For a live game this returns exactly board.orientation(), as before.
function our_side() {
    if (setup_fen) return (turn === 'w') ? 'white' : 'black';
    return board.orientation();
}

function rotate_fen_180(fen) {
    try {
        const parts = fen.split(' ');
        const squares = [];
        for (const ch of parts[0]) {
            if (ch === '/') continue;
            if (/\d/.test(ch)) squares.push(...Array(Number(ch)).fill(''));
            else squares.push(ch);
        }
        if (squares.length !== 64) return fen;
        squares.reverse(); // 180 degrees is simply the square sequence backwards
        const rows = [];
        for (let r = 0; r < 8; r++) {
            let row = '', gap = 0;
            for (let f = 0; f < 8; f++) {
                const sq = squares[r * 8 + f];
                if (sq) { if (gap) { row += gap; gap = 0; } row += sq; }
                else gap++;
            }
            if (gap) row += gap;
            rows.push(row);
        }
        parts[0] = rows.join('/');
        parts[3] = '-'; // any en-passant square is meaningless once the board has turned
        parts[2] = '-'; // ...and so are castling rights: they name squares the pieces have left
        return parts.join(' ');
    } catch (e) {
        return fen;
    }
}

// --- Follow the screen ---------------------------------------------------------------------------
// Re-read the SAME rectangle on a timer, so a board that is playing on screen -- a video, a stream,
// a game being shown in another app -- keeps the panel in step without capturing by hand each move.
//
// Only offered after a capture, because it needs the rectangle that capture found; there is nothing
// to re-scan before one. Each pass is the ordinary recognise path with detection skipped, so it is
// as cheap as it can be, and a scan that reads the SAME position does nothing at all -- an unchanged
// board must not restart the search on every tick.
const SNAP_FOLLOW_MS = 250;
let snap_follow_timer = null;
let snap_follow_busy = false;

function snap_following() {
    return snap_follow_timer !== null;
}

function snap_follow_stop() {
    if (snap_follow_timer !== null) clearTimeout(snap_follow_timer);
    snap_follow_timer = null;
    update_snap_follow_button();
}

function snap_follow_start() {
    if (snap_following() || !snap_crop) return;
    // Chained, NOT setInterval. A read is a full-tab PNG capture plus a 59MB ONNX pass, and
    // chrome.tabs.captureVisibleTab is throttled by Chrome to about 2 calls/second -- so a fixed
    // 250ms clock did not produce 4 reads/second, it produced quota errors and ticks dropped by the
    // busy flag, which is why the panel ran behind a video. Firing the next read when the last one
    // FINISHES runs the pipeline flat out at whatever rate it can actually sustain.
    const loop = async () => {
        if (snap_follow_timer === null) return;
        const t0 = Date.now();
        await snap_follow_tick();
        snap_last_read_ms = Date.now() - t0;
        if (snap_follow_timer === null) return;
        snap_follow_timer = setTimeout(loop, Math.max(SNAP_FOLLOW_MS - snap_last_read_ms, 0));
    };
    snap_follow_timer = setTimeout(loop, 0);
    update_snap_follow_button();
    setup_fen_msg(i18n('panel.fen.following', 'Following the screen · {ms}ms', {ms: SNAP_FOLLOW_MS})); // terse: it sits above the buttons
}

function snap_follow_toggle() {
    if (snap_following()) { snap_follow_stop(); setup_fen_msg(i18n('panel.fen.stopped_following', 'Stopped following')); }
    else snap_follow_start();
}

// Which single legal move turns `prevFen` into the placement we just read off the screen? Returns the
// FULL fen after that move -- side to move, ep square, castling rights and counters all derived rather
// than guessed -- or null when nothing explains the read.
//
// Null is the important return. At this poll rate a settled board is one ply from the last one, so a
// placement that NO legal move produces is not a position: it is a frame caught mid-animation, or a
// square the recogniser got wrong. Skipping it is free (the next read is 250ms away) and accepting it
// is not: the panel would analyse a position that never existed, and any turn flip made on the way in
// would stay wrong for good.
//
// The second pass is what lets the colour sort itself out. A capture is seeded White-to-move because
// the recogniser reports pieces and nothing else; if the ply only makes sense as Black's, that IS the
// evidence that the seed was wrong, so it is adopted rather than left for the king switch.
function follow_infer_ply(prevFen, placement) {
    if (!prevFen) return null;
    const from_side = (fen) => {
        try {
            const chess = new Chess(config.variant, fen);
            const hits = [];
            for (const san of chess.moves()) {
                chess.move(san);
                if (chess.fen().split(' ')[0] === placement) hits.push(chess.fen());
                chess.undo();
                if (hits.length > 1) return null; // ambiguous -- take nothing rather than a coin flip
            }
            return (hits.length === 1) ? hits[0] : null;
        } catch (e) { return null; }
    };
    return from_side(prevFen) || from_side(flip_fen_turn(prevFen));
}

let snap_last_read_ms = 0;     // how long the last capture+recognise round trip actually took
let snap_last_error = null;    // dedupe the read-failure warning
let snap_unexplained = 0;      // consecutive reads no single legal move explains
const SNAP_RESEED_AFTER = 8;   // ~2s at 250ms: long enough to ride out an animation, short enough to recover

async function snap_follow_tick() {
    if (snap_follow_busy || !snap_crop) return;   // a slow read must not stack up behind itself
    if (document.hidden) return;                  // nothing of ours is on screen to read (see below)
    snap_follow_busy = true;
    try {
        const res = await chrome.runtime.sendMessage({captureAndRecognize: {crop: snap_crop}});
        if (res?.error) {
            // Surfaced, not swallowed. The usual one is Chrome's captureVisibleTab quota (~2/sec),
            // and a silent skip made that look like "the recogniser is slow" rather than "we asked
            // too often". Throttled reads are normal, so say it once rather than every tick.
            if (res.error !== snap_last_error) {
                snap_last_error = res.error;
                console.warn('Mephisto: screen read failed:', res.error);
            }
            return;
        }
        snap_last_error = null;
        if (!res || !res.placement) return;
        // Rotate the READ, not just the stored position. Everything below -- the unchanged-check,
        // the ply inference and the re-seed -- then works in the same frame the panel is holding.
        // `res` is a const, so this is a local rather than a reassignment.
        let placement = res.placement;
        if (snap_flipped) {
            const rot = rotate_fen_180(`${placement} w - - 0 1`).split(' ')[0];
            if (rot) placement = rot;
        }
        const prev = (setup_fen || '').split(' ');

        if (setup_fen && placement === prev[0]) return; // unchanged -- do not restart the search
        // Work out WHICH ply was played, rather than assuming one was. follow_infer_ply replays every
        // legal move from the position we hold and keeps the one that lands on what we just read, so
        // the side to move, the en-passant square, the castling rights and the move counters all come
        // out right -- and, just as importantly, the read is CONFIRMED. A bare "the pieces changed, so
        // flip the colour" cannot tell a ply from a single misread square, and one misread would put
        // the colour permanently out of phase for the rest of the session with nothing to correct it.
        // It also self-corrects the STARTING colour: the recogniser cannot see whose move it is, so a
        // capture is seeded White-to-move, and if the first ply only makes sense as a Black move the
        // inference says so and adopts it. That is the colour switching itself, instead of being your job.
        let fen = follow_infer_ply(setup_fen, placement);
        if (fen) {
            snap_unexplained = 0;
        } else {
            // Nothing legal explains the read. Usually that is a frame caught mid-animation and the
            // next tick resolves it -- but not always, and "wait for a read I can explain" was a trap:
            // if the board jumped more than one ply (a video scrubbed, a new game, a position the
            // recogniser got wrong once), NOTHING is ever one ply from what we hold and following
            // stops dead while still claiming to follow. So give up explaining after a short run and
            // take the position as read, seeding the turn the same way a fresh capture does.
            if (++snap_unexplained < SNAP_RESEED_AFTER) return;
            snap_unexplained = 0;
            const prev = (setup_fen || '').split(' ');
            fen = `${placement} ${prev[1] || 'w'} - - 0 1`;
            if (!is_legal_position(fen)) fen = flip_fen_turn(fen);
            console.warn('Mephisto: could not explain the board as one move -- re-seeding from what is on screen');
            setup_fen_msg(i18n('panel.fen.reseeded', 'Re-seeded · check the side to move'));
        }
        if (!is_legal_position(fen)) return;       // belt and braces; the inference only plays legal moves
        setup_fen = fen;
        stash_setup_state();
        const input = PANEL_ROOT.getElementById('setup_fen_input');
        if (input) input.value = fen;
        last_eval.fen = '';
        try { turn = fen.split(' ')[1] || 'w'; board.position(fen); update_turn_badge(fen); } catch (e) { /* */ }
        on_new_pos(fen, fen, '');
    } catch (e) {
        // the tab went away, or the offscreen recogniser is not up -- stop rather than spin
        snap_follow_stop();
        setup_fen_msg(i18n('panel.fen.follow_failed', 'Stopped following (the capture failed)'));
    } finally {
        snap_follow_busy = false;
    }
}

// The button exists only while there is a rectangle to re-scan.
function update_snap_follow_button() {
    const btn = PANEL_ROOT.getElementById('snap_follow');
    if (!btn) return;
    btn.hidden = !snap_crop;
    btn.textContent = snap_following() ? 'Stop following' : 'Follow screen';
    btn.classList.toggle('following', snap_following());
}

async function snap_position(crop) {
    setup_fen_msg('');
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = '';
    setup_fen_msg(i18n('panel.fen.reading', 'Reading the board from the screen…'));
    let res;
    try {
        res = await chrome.runtime.sendMessage({captureAndRecognize: {crop}});
    } catch (e) {
        setup_fen_msg(i18n('panel.fen.capture_failed', 'Capture failed ({detail})', {detail: e}));
        return;
    }
    if (!res || res.error) {
        // No board found -> offer the manual path rather than dead-ending. This is the documented
        // fallback: the detector is the flakiest step on a busy page or a video frame.
        setup_fen_msg(`${res?.error === 'no board found' ? 'No board found' : `Failed: ${res?.error}`} — drag a box around the board`);
        request_drag_select();
        return;
    }
    // The recogniser reports placement only: it cannot know whose move it is or the castling rights.
    // Assume white to move with no rights -- both are then correctable (the header king switch flips
    // the turn, and the FEN box is right there showing what was read).
    const fen = `${res.placement} w - - 0 1`;
    if (!is_legal_position(fen)) {
        setup_fen_msg(i18n('panel.fen.illegal_read', 'Read a position that is not legal — try dragging a box around the board'));
        request_drag_select();
        return;
    }
    setup_fen = fen;
    snap_crop = res.box || crop || null; // remember WHERE it was read from
    stash_setup_state();
    update_snap_follow_button();
    panel_line_reset(fen); // a freshly read position starts its own line
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = fen;
    // Name the squares the model was least sure of. A misread square usually still yields a legal
    // position, so this is the only warning anyone gets that a piece may be in the wrong place.
    const unsure = (res.low || []).filter(sq => sq.prob < 0.9)
        .map(sq => `${sq.square} ${sq.piece ? sq.piece : 'empty'} ${Math.round(sq.prob * 100)}%`);
    setup_fen_msg('Read from screen — turn with the king switch, orientation with Flip board'
        + (unsure.length ? ` · least sure: ${unsure.join(', ')}` : ''));
    last_eval.fen = ''; prev_ply_count = 0;
    opp_spend = opp_clock_mark = last_our_eval = null;
    explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0;
    abandon_search();
    turn = 'w';
    setup_view = null;          // a new capture has not been told which way up it is yet
    snap_flipped = false;       // ...and neither has its follow loop
    board.orientation('white');
    on_new_pos(fen, fen, '');
}

// Ask the content-script to put a drag-to-select overlay on the page; it replies with the rect in
// image pixels, which goes back through the same recognise path with detection skipped.
function request_drag_select() {
    send_to_active_tab({dragSelect: true});
}

function setup_fen_msg(text) {
    const el = PANEL_ROOT.getElementById('setup_fen_msg');
    if (el) el.textContent = text || '';
}

function toggle_setup_fen() {
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (!row) return;
    if (setup_fen || row.style.display !== 'none') return clear_setup_fen(); // second click = back to live
    row.style.display = '';
    setup_fen_msg('');
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) { input.value = last_eval.fen || ''; input.focus(); input.select(); }
}

function apply_setup_fen() {
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    const fen = (input?.value || '').trim();
    if (!fen) return clear_setup_fen();
    // Validate BEFORE anything downstream sees it. A bad position is worse than no position: an
    // illegal one crashes the wasm engine outright (the same OOB guard the scrape path has).
    let parsed;
    try {
        parsed = new Chess(config.variant, fen).fen();
    } catch (e) {
        setup_fen_msg(i18n('panel.fen.not_valid', 'Not a valid FEN'));
        return;
    }
    // chess.js SILENTLY falls back to the standard start position for input it can't read, so a
    // successful parse is not proof the FEN was understood -- typing junk would quietly set up a new
    // game. The piece placement round-trips exactly, so compare it: if it doesn't match what was
    // typed, chess.js substituted its default and the input was never a FEN.
    if (parsed.split(' ')[0] !== fen.split(/\s+/)[0]) {
        setup_fen_msg(i18n('panel.fen.not_valid', 'Not a valid FEN'));
        return;
    }
    if (!is_legal_position(parsed)) {
        setup_fen_msg(i18n('panel.fen.illegal', 'Illegal position'));
        return;
    }
    setup_fen = parsed;
    stash_setup_state();
    setup_fen_msg(i18n('panel.fen.set', 'Set — the panel is no longer following the page'));
    // treat it as a brand-new game so no stale pacing/premove/book state carries over
    last_eval.fen = ''; prev_ply_count = 0;
    opp_spend = opp_clock_mark = last_our_eval = null;
    explorer_out_of_book = false; explorer_data = null;
    abandon_search();
    turn = parsed.split(' ')[1];
    // The view is sticky once chosen (Flip board), and only DERIVED from the turn when it has never
    // been set. Deriving it every time meant the board spun round on every ply of a followed game --
    // which is also why our_side() exists: what the panel answers for no longer rides on this.
    board.orientation(setup_view || (turn === 'w' ? 'white' : 'black'));
    on_new_pos(parsed, parsed, '');
}

function clear_setup_fen() {
    panel_line_reset(''); // back to the live game -- the walked line is finished with
    setup_view = null;    // the page decides the orientation again
    snap_crop = null;
    snap_follow_stop();
    stash_setup_state(); // clears the stash: a reload must NOT bring the position back
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = 'none';
    if (!setup_fen) return;         // was only open, never applied -- nothing to restore
    setup_fen = null;
    setup_fen_msg('');
    PANEL_ROOT.getElementById('recheck')?.click(); // back to the live game, same path as Re-detect
}

function on_new_pos(fen, startFen, moves) {
    console.log("on_new_pos", fen, startFen, moves);
    // PAINT FIRST. Showing the position we were just handed needs none of the ~200 lines below it --
    // not the search dispatch, the premove bookkeeping, the explorer/tablebase lookups or the native
    // configure round-trip -- yet the repaint used to sit at the very END of all of it, so the small
    // board visibly lagged the page. It is a synchronous DOM render (panel-board.js renders on the
    // spot, no animation), so doing it here costs nothing and the board tracks the page immediately.
    // Annotations come with it: they belong to the position that just left, and drawing the new
    // position under the old arrows is worse than a blank board for the moment before draw_moves().
    try {
        hide_4pc_board();   // a normal position means the 14x14 renderer must give the host back
        board.position(fen);
        clear_annotations();
        clear_book_annotations(); // stale book arrows go now; the new position's lookup redraws them
    } catch (e) { /* board not built yet (first push before init finished) -- the next push paints it */ }
    opp_alert_on_new_pos(fen); // arm the opponent-mistake check from the just-finished position's eval
    last_pos = {startFen: startFen || null, moves: moves || ''}; // Copy PGN reads this
    clear_next_move_eta(); // the countdown belonged to the position that just changed
    humanize_roll = null;  // and so did any pre-rolled humanize outcome
    if (config.help_mode) request_clear_hint(); // position changed; last hint is stale
    premove_tracker = {fen: fen, startFen: startFen || fen, moves: moves || '', lines: {}}; // certifications belong to exactly one position
    // NEW-GAME RESET. On sites that swap games WITHOUT a page reload (taketaketake rematch, SPA
    // rematches), per-game pacing state would otherwise carry over -- Mirror Time mirroring the LAST
    // opponent's spend, or the wall-clock idle gap between games, and Humanize's swing keyed off the
    // finished game's eval. When the ply count drops back to the start, start the new game clean.
    const ply_count = moves ? moves.trim().split(/\s+/).filter(Boolean).length : 0;
    // a DROP in ply count back near the start = a new game (live-game plies only ever climb). The
    // `<= 4` keeps it to real restarts (catches fast bullet where a couple plies land before the
    // first scrape) while a transient mid-game mis-scrape can't trip it from a deep position.
    if (ply_count < prev_ply_count && ply_count <= 4) {
        opp_spend = null; opp_clock_mark = null; last_our_eval = null;
        explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0; // new game = back in book
    }
    // fire the book lookup NOW so the answer has the whole search to arrive; never awaited
    request_explorer(fen);
    request_tablebase(fen);
    request_puzzle_solution(fen);
    bgTrace('on_new_pos', {turn, autoplay: config.autoplay, puzzle: config.puzzle_mode,
        known: !!puzzle_pick(fen), fen: fen.split(' ')[0].slice(0, 46)});
    prev_ply_count = ply_count;
    // Do we already know this position's move (ply 2+ of a solution looked up a move ago)? Decided
    // HERE so the engine branch below can be skipped, but PLAYED at the very end of this function --
    // request_automove reads last_eval, and last_eval only describes this position once we get there.
    const puzzle_known = puzzle_move_ready(fen);
    toggle_calculating(true);
    // SIZE THE SEARCH TO THE PACE. When a clock-aware mode intends to spend, say, 1.2s on this move,
    // the engine should SEARCH ~1.2s (minus a margin to play it) rather than find a shallow move in
    // the default time and then idle -- the wait becomes a deeper move instead of dead time. Floor
    // at the configured search time so pacing never makes the engine think LESS than the default,
    // unless it's genuinely time to hurry (low clock, or a forced move). Pure Humanize (no clock)
    // keeps the default search: its long thinks key off the position's criticality, which isn't
    // known until after the search, so that time stays a post-search wait.
    const pace = paced_move_target_ms();
    let movetime = config.compute_time;
    if (pace != null) {
        const filled = Math.round(pace.ms - MOVE_MARGIN);
        movetime = pace.lowClock
            ? Math.max(50, Math.min(filled, Math.round(pace.ms))) // hurrying: let it drop below default
            : Math.max(config.compute_time, filled);              // else fill the pace, never under default
        movetime = Math.max(50, movetime);
    } else {
        // humanize without a clock mode: fill the estimated human think, never under the default
        const hz = humanize_presearch_ms(fen);
        if (hz != null) movetime = Math.max(config.compute_time, Math.round(hz - MOVE_MARGIN));
    }
    // a forced move (one legal reply) needs no thinking time -- play it fast even mid-pace
    try {
        if (new Chess(config.variant, fen).moves().length === 1) movetime = Math.min(movetime, config.compute_time);
    } catch (e) { /* variant fen chess.js can't parse -- skip the forced-move shortcut */ }
    search_start = Date.now();
    // start the countdown NOW (the search fills the pace), on our turn, when a mode changes the
    // base time -- so the full time counts down while the engine thinks. Category is added once the
    // move is picked. Cleared at the top of this function, so a non-pacing move shows nothing.
    // Manual Mode times the move itself (you press the key), so no auto-countdown.
    if (config.autoplay && !config.help_mode && !config.puzzle_mode && !config.manual_mode
        && ((turn === 'w') ? 'white' : 'black') === our_side()) {
        const est = estimated_move_total_ms(fen);
        if (est) {
            // pre-roll the humanize outcome so the countdown shows the coming move from the start
            if (config.humanize) humanize_roll = roll_humanize_category(fen);
            set_move_countdown(search_start + est.ms, est.source, humanize_roll ? humanize_roll.category : null);
        }
    }
    // whose move is it -- drives the ponder budget (remote/native) and the per-turn thread cap (WASM)
    const our_turn = ((turn === 'w') ? 'white' : 'black') === our_side();
    // Ponder width, hoisted ABOVE the engine branch because it is engine-agnostic. It used to live in
    // the WASM branch only, so on a native engine Pondering never actually widened the candidate list
    // and premove_lines stayed at 2 -- the width bought nothing there.
    const ponder_now = config.ponder && !our_turn;
    premove_lines = ponder_now ? ponder_line_count(fen, moves ? moves.trim().split(' ').pop() : null) : 2;
    const want_multipv = ponder_now ? premove_lines : effective_multipv();

    // Puzzle Mode never analyses the opponent's turn. In a puzzle their reply is scripted and lands
    // in a couple of hundred ms, and nothing consumes an opponent-turn search here: Premove is
    // disabled in Puzzle Mode (all three entry points bail on it), so there is no certification to
    // feed, and the bestmove it produces moves one of THEIR pieces, which premove_reply_playable
    // rejects anyway. It only burns cores and leaves a search in flight that the real position then
    // has to supersede. Stop whatever is running and wait for their move instead.
    // WAIT FOR THE DATABASE BEFORE SEARCHING. The lookup is a message to the worker plus a disk
    // read; a search is slower, but not always, and the engine finishing first is what produced
    // moves that failed puzzles the database could have solved. Deferred, not skipped: the answer
    // re-enters this function, so a miss searches exactly as it always did.
    if (puzzle_db_enabled() && !puzzle_known && puzzle_answered !== puzzle_key(fen)) {
        puzzle_deferred = {fen, startFen, moves};
        abandon_search();
        toggle_calculating(true);
        clearTimeout(puzzle_defer_timer);
        puzzle_defer_timer = setTimeout(() => {
            console.warn('Mephisto: the puzzle database did not answer in time -- searching anyway');
            puzzle_answered = puzzle_key(fen);   // do not wait again for this position
            release_deferred_search(fen);
        }, PUZZLE_LOOKUP_WAIT_MS);
        return;
    }
    if (puzzle_known) {
        // THE MOVE IS ALREADY DECIDED, so this search chooses nothing -- it runs only so the panel
        // still shows an evaluation for the position instead of a blank readout. Bounded at depth 10:
        // deep enough to mean something, cheap enough to be free next to a solution we already hold.
        // Its bestmove must never be played (see puzzle_display_search in on_engine_best_move) --
        // the puzzle's line wins, and an objectively stronger move still fails the puzzle.
        abandon_search();
        if (!is_remote()) {
            puzzle_display_search = true;
            send_engine_uci(moves ? `position fen ${startFen} moves ${moves}` : `position fen ${fen}`);
            send_engine_uci(`go depth ${PUZZLE_DISPLAY_DEPTH}`);
            search_active = true;
        }
    } else if (config.puzzle_mode && !our_turn) {
        abandon_search();
    } else if (is_remote()) {
        // pure analysis (Help Mode / Autoplay off) keeps deepening like the WASM `go infinite`: give
        // it a long budget that the next position (a new request supersedes this one) cuts short.
        // PONDERING rides the same rail on the opponent's turn: the native hosts and remote engine
        // turn this `time` into their search limit, so the engine thinks through their whole move
        // instead of stopping after our move time. Superseded by the next position like Help Mode.
        const open_ended = config.help_mode || !config.autoplay || config.manual_mode
                           || (config.ponder && !our_turn);
        // MULTIPV NEEDS A SEARCH THAT ENDS. a native host may compute lines 2..k only once the main search is
        // over -- re-searching with the better lines' first moves excluded at the root, then emits
        // the whole `multipv 1..k` batch in one go, just before bestmove. On the open-ended rail that
        // moment never arrives: the panel asks for an hour, the engine streams untagged per-depth
        // frames forever, every one of them lands on line 1, and the Multi Lines panel shows exactly
        // one row no matter what the slider says. (Verified against the host: at time=3600000, 15s of
        // streaming yields 20 info frames and not one multipv tag; at time=250 it yields all five.)
        //
        // So when more than one line is asked for, bound the search even in analysis mode. The cost
        // is real and worth naming: analysis stops deepening at the move budget instead of running
        // indefinitely. That is the trade for MultiPV working at all -- and at Multi Lines 1, which
        // is the default, nothing changes.
        const rt = (open_ended && !(uses_native() && want_multipv > 1)) ? 3600000 : movetime;
        const posKey = moves ? `${startFen}|${moves}` : fen;
        const send_analysis = () => {
            if (uses_native() && native_inflight === posKey) {
                console.log('Mephisto: already analysing this position -- not issuing a second search');
                return;
            }
            const fresh = remote_result_gate(); // drop this result if the position moves on first
            // Cleared however the promise settles -- including for a result we discard as
            // superseded -- so a later push for this same position can still be searched.
            const settle = () => { if (native_inflight === posKey) native_inflight = null; };
            if (uses_native()) {
                native_inflight = posKey;
                if (rt < 60000) {
                    setTimeout(() => {
                        if (native_inflight !== posKey) return;   // it settled; nothing to do
                        console.warn('Mephisto: the engine never answered this search -- releasing ' +
                                     'it so the next position push can retry');
                        native_inflight = null;
                    }, rt + 6000);
                }
            }
            if (moves) {
                request_remote_analysis(startFen, rt, moves)
                    .then(fresh(on_engine_response)).catch(fresh(on_remote_error)).finally(settle);
            } else {
                request_remote_analysis(fen, rt)
                    .then(fresh(on_engine_response)).catch(fresh(on_remote_error)).finally(settle);
            }
        };
        // The host reads MultiPV out of its stored options, not out of the analyse request, so the
        // width is configured separately. FIRE AND FORGET, never awaited.
        //
        // It was awaited at first, to avoid a race: the host handles each message on its own thread
        // and they only serialise on the engine lock, so a configure sent alongside an analyse can
        // lose and apply its width to the NEXT position instead. That reasoning was right and the
        // fix was wrong -- chaining the analysis onto the configure's promise means a configure that
        // never settles issues NO SEARCH AT ALL. With Pondering on, the width changes every time the
        // turn flips, so that is one round-trip per move, and one that fails to resolve leaves the
        // panel with a spinning progress bar and no move. A width that is one position stale is a
        // vastly better failure than a search that never starts.
        if (want_multipv !== remote_multipv_set) {
            remote_multipv_set = want_multipv;
            // on failure, forget what we think the host has so the next position re-pushes it
            request_remote_configure({MultiPV: want_multipv}).catch(() => { remote_multipv_set = null; });
        }
        send_analysis();
    } else {
        // discards the flushed bestmove of the search we're superseding -- `turn` already belongs to
        // the NEW position, so if the old search was for the opponent's side (they replied mid-search)
        // that stale bestmove would otherwise be automoved as OUR move
        abandon_search();
        // Threads/Hash changed while a search was running: apply them NOW, in the gap between the
        // stop above and the go below. That is the only point UCI allows it.
        //
        // BEFORE the per-turn cap, not after. It used to run after, so on the opponent's turn the cap
        // sent `Threads 2` and the flush immediately sent the slider's full value straight over the
        // top of it -- two contradictory setoptions back to back, the background search running at
        // full cores, and search_threads_set left equal to the full count so nothing ever corrected
        // it. Flushing first makes the cap the last word, which is the whole point of the cap.
        flush_engine_options();
        // Thread budget per turn: our move gets the full count; the opponent's turn is background
        // work, so it is capped unless Pondering is on (then keep full strength -- see the go
        // below, which also lets a ponder run infinite for the whole opponent think). Maia is a single
        // forward pass with no Threads option, so leave it alone. Only re-push when the target changes.
        if (config.engine !== 'maia' && config.engine !== 'maia3') {
            // The cap applies ONLY to the real in-game wait on the opponent. Analysis / Help / Manual
            // have no opponent to save cores for, so they keep the full count -- as does our own move.
            //
            // 2, not 1: this search is what Premove certifies from, and certification now needs the
            // pair stable at depth 13 AND 14 (see PREMOVE_DEPTH_PREV/LAST). One thread frequently
            // never got there inside the move time, so premoves stopped firing with Pondering off.
            // Two roughly doubles the nodes for the same wall clock while still leaving the machine
            // to the browser. Never ABOVE the user's own budget -- if they set 1 thread, they get 1.
            const bg_wait = config.autoplay && !config.help_mode && !config.manual_mode
                && !our_turn && !config.ponder;
            const want_threads = bg_wait ? Math.min(2, config.threads) : config.threads;
            if (want_threads !== search_threads_set) {
                send_engine_uci(`setoption name Threads value ${want_threads}`);
                search_threads_set = want_threads;
            }
        }
        // Re-assert the line count every move: humanize_rates() is read fresh per pick, so turning
        // the Mistakes/Blunders sliders on has to widen the engine's list NOW (see
        // effective_multipv). Set at engine init only, those sliders would silently do nothing until
        // the next re-init -- the exact trap that made the whole mix look broken. Free between
        // searches; we just stopped one. (The remote/native path reaches the same width a different
        // way: an analyse request carries only {fen, time, moves}, so MultiPV goes to the host via
        // request_remote_configure -- see the awaited push in that branch.)
        // Pondering overrides the width: the opponent's turn is searched over their top few candidate
        // replies (ponder_line_count), not our configured line count -- premove_lines mirrors it so an
        // instant reply can be certified for any of them.
        send_engine_uci(`setoption name MultiPV value ${want_multipv}`);
        if (moves) {
            send_engine_uci(`position fen ${startFen} moves ${moves}`);
        } else {
            send_engine_uci(`position fen ${fen}`);
        }
        // Manual Mode searches forever too: it plays on YOUR keypress, never on a timer. Pondering on
        // the opponent's turn is also open-ended: ponder the whole think, abandon_search cuts it off
        // the instant they move (its bestmove is discarded, being for the opponent's side).
        if (config.help_mode || !config.autoplay || config.manual_mode || (config.ponder && !our_turn)) {
            send_engine_uci('go infinite'); // pure analysis / manual / ponder: keep deepening until the position changes
        } else {
            send_engine_uci(`go movetime ${movetime}`); // autoplay needs a final bestmove to act on
        }
        search_active = true;
    }

    // (the repaint + annotation clear that used to live here now run at the TOP of this function)
    if (config.simon_says_mode) {
        const toplay = (turn === 'w') ? 'White' : 'Black';
        if (toplay.toLowerCase() !== our_side()) {
            draw_moves();
            request_console_log('Best Move: ' + last_eval.bestmove);
        }
    }
    last_eval = {fen, activeLines: 0, lines: new Array(config.multiple_lines),
        lastMove: moves ? moves.trim().split(' ').pop() : null}; // opp's last move (humanize recapture check)
    // A known solution means no search ran, so nothing else will ever call draw_moves for this
    // position -- the arrow has to be drawn from here or there is no arrow at all.
    if (puzzle_pick(fen)) draw_moves();
    if (puzzle_known) maybe_play_puzzle_move(fen);
}

// Restore the en-passant square on a position that was rebuilt from PIECES ALONE (chess.com
// puzzles: no move list on the page). Such a FEN always serialises "-" for ep, so an ep capture is
// invisible to the engine -- and in a pawn endgame that is frequently the entire point of the
// puzzle, which is why they were being failed. `lastMove` is the page's last-move highlight.
//
// The square is only declared when the capture is genuinely available: the last move was a two-rank
// pawn push, and a pawn of the side to move stands beside it. Declaring it otherwise would change
// the position's identity (and its hash) without changing what is legal.
// Restore castling rights on a position rebuilt from PIECES ALONE. Same root cause as the missing
// en-passant square: clear()+put() cannot carry rights, so every chess.com puzzle position came out
// with "-" and NEITHER side could ever castle. That is wrong twice over -- the engine can't find a
// solution that IS O-O, and, far more often, it evaluates a position that isn't the one on screen
// (king safety and rook activity both hinge on whether the king may still castle), so it plays a
// good move for the wrong position.
//
// Inferred the standard way, from the board: a side gets a right only when its king sits on the home
// square AND the matching rook sits on its home corner. That is the same convention diagram-to-FEN
// tools and chess.com's own puzzle FENs use. It is a well-behaved guess, not proof -- a king or rook
// that moved away and came back would be granted a right it does not really have. In a tactical
// puzzle that is vanishingly rare, and the failure it replaces (never castling, in every puzzle) is
// both far more common and worse: the wrong castle at most fails to click, the wrong evaluation
// silently picks the wrong move.
//
// Standard chess only: chess960 home squares are not e1/a1/h1, and this path already handles a real
// game's move-0 position separately (isStartPos), where the rights are a fact rather than a guess.
function apply_castling_rights(fen) {
    if (config.variant && config.variant !== 'chess') return fen;
    try {
        const c = new Chess(config.variant, fen);
        const home = (sq, type, color) => {
            const p = c.get(sq);
            return !!p && p.type === type && p.color === color;
        };
        let rights = '';
        if (home('e1', 'k', 'w')) {
            if (home('h1', 'r', 'w')) rights += 'K';
            if (home('a1', 'r', 'w')) rights += 'Q';
        }
        if (home('e8', 'k', 'b')) {
            if (home('h8', 'r', 'b')) rights += 'k';
            if (home('a8', 'r', 'b')) rights += 'q';
        }
        // An empty inference CLEARS the field, it does not leave the old one standing. The piece-only
        // rebuild arms KQkq before placing pieces, and chess.js assigns those bits 960-style to
        // whatever squares the kings and rooks land on -- so a position with both kings off their home
        // squares kept rights that no rook backs. chess.js will then happily generate a castle from
        // them (a rook endgame with kings on d4/d6 offered O-O), while the engine, which ignores
        // unbacked rights, never suggests it. For standard chess this inference is the whole truth.
        rights = rights || '-';
        const fields = fen.split(' ');
        if (fields[2] === rights) return fen;
        fields[2] = rights;
        const patched = fields.join(' ');
        new Chess(config.variant, patched); // reject a patch this chess.js won't parse
        return patched;
    } catch (e) {
        return fen; // the position without rights is still a valid position
    }
}

function apply_ep_square(fen, lastMove) {
    if (!/^[a-h][1-8][a-h][1-8]$/.test(lastMove ?? '')) return fen;
    try {
        const [from, to] = [lastMove.slice(0, 2), lastMove.slice(2, 4)];
        if (from[0] !== to[0]) return fen;                       // not a straight push
        const moved = new Chess(config.variant, fen).get(to);
        if (!moved || moved.type !== 'p') return fen;             // not a pawn that landed there
        const stm = fen.split(' ')[1];
        if (moved.color === stm) return fen;                      // the mover must be the OTHER side
        const [fromRank, toRank] = [Number(from[1]), Number(to[1])];
        const double = (moved.color === 'w' && fromRank === 2 && toRank === 4)
                    || (moved.color === 'b' && fromRank === 7 && toRank === 5);
        if (!double) return fen;
        // an enemy pawn must actually be beside the pushed pawn, or there is no ep right to record
        const file = to.charCodeAt(0);
        const board = new Chess(config.variant, fen);
        const adjacent = [file - 1, file + 1]
            .filter(f => f >= 'a'.charCodeAt(0) && f <= 'h'.charCodeAt(0))
            .map(f => board.get(String.fromCharCode(f) + to[1]));
        if (!adjacent.some(p => p && p.type === 'p' && p.color === stm)) return fen;

        const fields = fen.split(' ');
        fields[3] = to[0] + ((moved.color === 'w') ? '3' : '6');
        const patched = fields.join(' ');
        new Chess(config.variant, patched); // reject a patch this chess.js won't parse
        return patched;
    } catch (e) {
        return fen; // anything unexpected: the position without ep is still a valid position
    }
}

function parse_position_from_response(txt) {
    const prefixMap = {
        li: i18n('panel.detected_on', 'Game detected on {site}', {site: 'Lichess.org'}),
        cc: i18n('panel.detected_on', 'Game detected on {site}', {site: 'Chess.com'}),
        bt: i18n('panel.detected_on', 'Game detected on {site}', {site: 'BlitzTactics.com'}),
        tt: i18n('panel.detected_on', 'Game detected on {site}', {site: 'TakeTakeTake'}),
        cb: i18n('panel.position_detected_on', 'Position detected on {site}', {site: 'ChessBase Tactics'}),
    };

    function parse_position_from_moves(txt, startFen = null) {
        const directKey = (startFen) ? `${startFen}_${txt}` : txt;
        const directHit = fen_cache.get(directKey);
        if (directHit) { // reuse position
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        let record;
        const lastMoveRegex = /([\w-+=#]+[*]+)$/;
        const indirectKey = directKey.replace(lastMoveRegex, '');
        const indirectHit = fen_cache.get(indirectKey);
        if (indirectHit) { // append newest move
            const chess = new Chess(config.variant, indirectHit.fen);
            const moveReceipt = chess.move(txt.match(lastMoveRegex)[0].split('*****')[0]);
            turn = chess.turn();
            record = {fen: chess.fen(), startFen: indirectHit.startFen, moves: indirectHit.moves + ' ' + moveReceipt.lan}
        } else { // perform all moves
            const chess = new Chess(config.variant, startFen);
            const sans = txt.split('*****').slice(0, -1);
            let moves = '';
            for (const san of sans) {
                const moveReceipt = chess.move(san);
                moves += moveReceipt.lan + ' ';
            }
            turn = chess.turn();
            record = {fen: chess.fen(), startFen: chess.startFen(), moves: moves.trim()};
        }

        fen_cache.set(directKey, record);
        return record;
    }

    // isStartPos: this is a game's move-0 position (chess960 / lichess "From Position"), not a
    // puzzle. It decides whether castling rights are inferred -- see the block below.
    function parse_position_from_pieces(txt, isStartPos = false) {
        const directHit = fen_cache.get(txt);
        if (directHit) { // reuse position
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        const chess = new Chess(config.variant);
        chess.clear(); // clear the board so we can place our pieces
        // A position built by clear()+put() can NEVER hold castling rights: _put only records the
        // king/rook "initial" squares while _castling is ALREADY non-zero, and clear() zeroes it --
        // a chicken-and-egg that made every position parsed here serialize with "-". For a game's
        // start that's wrong and fatal: the replay of the real move list hits the first O-O and
        // throws "Invalid move: O-O", so EVERY scrape of a "From Position" game (queen odds, etc.)
        // was skipped and the panel showed "no game detected". Arming the bits first lets the
        // placements below register the true king/rook squares -- chess960 included, since _put
        // reads a rook placed before the king as queenside and after it as kingside, and the pieces
        // arrive in file order. Only for a start position: in a puzzle the king has usually already
        // moved, and granting rights there would invent a castle that isn't legal.
        if (isStartPos) {
            chess.setCastlingRights('w', {k: true, q: true});
            chess.setCastlingRights('b', {k: true, q: true});
        }
        const [playerTurn, ...tokens] = txt.split('*****').slice(0, -1);
        // `lm-<from><to>` is the page's last-move highlight, shipped by the chess.com puzzle scrape
        // purely so the en-passant square can be recovered (see below). Everything else is a piece.
        let lastMove = null;
        for (const token of tokens) {
            if (token.startsWith('lm-')) { lastMove = token.slice(3); continue; }
            const attributes = token.split('-');
            chess.put({type: attributes[1], color: attributes[0]}, attributes[2]);
        }
        if (isStartPos) {
            // Keep only the rights the board actually backs. A start with no rook on a side (an
            // endgame position, say) would otherwise serialize a right nothing supports -- an
            // illegal FEN, and those are what crash the wasm engine (see the en-prise guard below).
            for (const color of ['w', 'b']) {
                const backed = chess._rooksInitial[color].reduce((flags, r) => flags | r.flag, 0);
                chess._castling[color] &= backed;
            }
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();

        // a mid-animation scrape or wrong turn guess can yield a position where the side to move
        // could capture the king — searching such a position crashes the stockfish wasm (OOB)
        const opponent = (turn === 'w') ? 'b' : 'w';
        if (chess._isKingAttacked(opponent)) {
            throw Error('illegal position scraped (opponent king en prise)');
        }

        // The STANDARD initial array can only ever occur at move 0 -- pawns cannot move backwards, so
        // it is unreachable once a game is under way. Its castling rights are therefore necessarily
        // KQkq, which makes this a fact rather than a guess. It matters because this path builds
        // positions with clear()+put(), which cannot carry rights (see above), and lichess has no
        // move list before the first move -- so a live game's opening position came through here and
        // serialized as "w - -". The engine then analysed a start position where neither side may
        // castle, and the opening-explorer lookup matched nothing (no master game has that position).
        // Rebuild it as a start position so the rights are armed before the pieces are placed.
        // Variant-safe by construction: chess960 and the other variants don't have this placement.
        if (!isStartPos && chess.fen().split(' ')[0] === INITIAL_PLACEMENT) {
            return parse_position_from_pieces(txt, true); // isStartPos=true -> cannot recurse again
        }

        // Both patches restore information the piece scrape cannot carry. Castling first: it only
        // reads piece placement, so it is independent of the ep field it is followed by.
        const record =  {fen: apply_ep_square(apply_castling_rights(chess.fen()), lastMove)};
        fen_cache.set(txt, record);
        return record;
    }

    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    detected_prefix = prefix;
    set_detection_status(prefixMap[prefix]);
    txt = txt.substring(11);

    if (metaTag.includes('var')) {
        if (txt.includes('&')) { // a custom start position is shipped along (chess960 / "From Position")
            const puzTxt = txt.substring(0, txt.indexOf('&'));
            const fenTxt = txt.substring(txt.indexOf('&') + 6);
            // `true` = this is the game's move-0 position, so castling rights are inferred from the
            // board (see parse_position_from_pieces). That replaces a chess960-only string patch
            // (`startFen.replace('-', 'KQkq')`) which papered over the same missing-rights bug for
            // 960 alone -- which is why 960 castled fine while every standard "From Position" game
            // died on its first O-O.
            const startFen = parse_position_from_pieces(puzTxt, true).fen;
            return parse_position_from_moves(fenTxt, startFen);
        }
        return parse_position_from_moves(txt);
    } else if (metaTag.includes('puz')) { // chess.com & blitztactics.com puzzle pages
        return parse_position_from_pieces(txt);
    } else if (metaTag === 'cbfen') { // ChessBase Tactics: a complete FEN shipped as-is
        turn = txt.split(' ')[1] || 'w';
        return {fen: txt};
    } else { // chess.com and lichess.org pages
        return parse_position_from_moves(txt);
    }
}

function update_evaluation(eval_string) {
    if (eval_string != null && config.computer_evaluation) {
        PANEL_ROOT.getElementById('evaluation').innerHTML = eval_string;
    }
}

// One line: the "Best response for X is Y" threat readout used to occupy a second line here, and
// its empty reserved row showed as a gap under the move. Threat Analysis is now arrow-only.
// --- Why this move ------------------------------------------------------------------------------
// Names the tactic behind the engine's choice: fork, promotion, a capture that wins material, mate.
// Opt-in (Settings -> Explain Moves), off by default, and shown on its own line rather than over the
// board -- the opponent-mistake toast already owns that space and two things fighting for it is
// worse than either alone.
//
// DELIBERATELY CONSERVATIVE. Only motifs that can be established from the position itself are named;
// pins, skewers and discovered attacks need a judgement this cannot make reliably, so they are not
// guessed at. When nothing is certain it says nothing, because a confidently wrong explanation is
// worse than none -- you would learn the wrong thing from it.
const REASON_PIECE_CP = {p: 100, n: 320, b: 330, r: 500, q: 900, k: 0};
const REASON_FORK_MIN = 320; // only a knight or better counts as a forked target

function move_reason(fen, uci) {
    if (!config.move_reason) return '';
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return '';
    try {
        const before = new Chess(config.variant, fen);
        const from = uci.slice(0, 2), to = uci.slice(2, 4);
        const mover = before.get(from);
        if (!mover) return '';
        const captured = before.get(to);
        const rec = before.move({from, to, promotion: uci[4]});
        if (!rec) return '';

        const reasons = [];
        if (before.isCheckmate()) return 'checkmate';
        if (uci[4]) reasons.push(`promotes to ${({q: 'a queen', r: 'a rook', b: 'a bishop', n: 'a knight'})[uci[4]]}`);

        // A capture is only worth naming when it WINS something: taking a defended equal is a trade.
        if (captured) {
            const gain = REASON_PIECE_CP[captured.type] || 0;
            const defended = before.moves({verbose: true}).some(m => m.to === to);
            if (!defended) reasons.push(`wins a ${({p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen'})[captured.type]}`);
            else if (gain - (REASON_PIECE_CP[mover.type] || 0) >= 100) reasons.push('wins material');
        }

        // Fork: the piece that just moved now attacks two or more valuable things. Computed by asking
        // what OUR piece on `to` could take -- which needs the turn flipped back, since the move has
        // just handed it over.
        const after = new Chess(config.variant, before.fen());
        after.setTurn(mover.color);
        let targets = 0;
        try {
            for (const m of after.moves({square: to, verbose: true})) {
                if (m.captured && (REASON_PIECE_CP[m.captured] || 0) >= REASON_FORK_MIN) targets++;
            }
        } catch (e) { /* flipping the turn made an illegal position -- just skip the fork test */ }
        const givesCheck = before.isCheck();
        // Phrasing matters here: "check, forking" read like a sentence that had been cut off.
        if (targets >= 2) reasons.push('a fork');
        else if (givesCheck && targets >= 1) reasons.push('a fork with check');
        else if (givesCheck) reasons.push('check');

        return reasons.length ? reasons.join(', ') : '';
    } catch (e) {
        return '';
    }
}

function render_move_reason(uci) {
    const el = PANEL_ROOT.getElementById('move-reason');
    if (!el) return;
    const text = move_reason(last_eval.fen, uci);
    el.textContent = text ? `Why: ${text}` : '';
    el.hidden = !text;
}

// How much better the best move is than the second best -- the thing a human actually wants to know
// and the one thing the panel never said. "Only move" and "six moves are all fine" are completely
// different situations that both used to render as a single arrow and a score.
//
// Reads the MultiPV lines that are already on screen; needs no extra search. Silent when only one
// line is being computed (Multi Lines = 1), because with nothing to compare against there is no gap
// to report -- it does NOT widen the search to find one.
const CONFIDENCE_ONLY_MOVE_CP = 150; // best is winning by this much more -> effectively forced
const CONFIDENCE_EQUAL_CP = 20;      // within this -> genuinely a choice

function move_confidence_label() {
    try {
        if (!last_eval.fen || config.simon_says_mode) return '';
        // a single legal move is "only move" regardless of what the engine reports
        const legal = new Chess(config.variant, last_eval.fen).moves().length;
        if (legal === 1) return i18n('panel.conf.only_move', 'Only move');
        const a = last_eval.lines?.[0], b = last_eval.lines?.[1];
        if (!a || !b) return '';                       // Multi Lines = 1, or line 2 not in yet
        // mate scores don't subtract meaningfully against centipawns
        if (a.mate != null || b.mate != null) {
            return (a.mate != null && b.mate == null) ? i18n('panel.conf.only_line_mates', 'Only line that mates') : '';
        }
        if (typeof a.score !== 'number' || typeof b.score !== 'number') return '';
        const gap = Math.abs(a.score - b.score);
        if (gap >= CONFIDENCE_ONLY_MOVE_CP) return i18n('panel.conf.clearly_best', 'Clearly best (+{gap})', {gap: (gap / 100).toFixed(1)});
        if (gap <= CONFIDENCE_EQUAL_CP) return i18n('panel.conf.several_equal', 'Several equal');
        return i18n('panel.conf.over_second', '+{gap} over #2', {gap: (gap / 100).toFixed(2)});
    } catch (e) {
        return ''; // unparseable variant fen etc. -- the readout is better bare than wrong
    }
}

// The tablebase verdict and the confidence gap go on their OWN line, not appended to the move text.
// body sets `white-space: nowrap` and the left column is 378px, so "White to play, best move is a6a7
// -- tablebase: win in 13" simply ran off the edge and was clipped mid-word. A second, smaller line
// costs ~18px of a column that has room, and neither string has to be abbreviated to fit.
function readout_extras() {
    // Both labels return BARE text and the separator is added here. They used to carry their own
    // leading '—' / '·', so which punctuation started the line depended on which label happened to
    // be present -- and stripping it back off needed a regex that missed the em dash.
    const extra = [puzzle_label(), tablebase_label(), move_confidence_label()].filter(Boolean).join(' · ');
    return extra ? `<span class="line1-extra">${extra}</span>` : '';
}

function update_best_move(line1) {
    if (line1 != null) {
        last_best_move_line = line1;
        PANEL_ROOT.getElementById('chess_line_1').innerHTML = line1 + readout_extras();
    }
}
let last_best_move_line = null; // the readout without the tablebase suffix, so it can be re-rendered

// The tablebase answer arrives AFTER the readout is drawn (it is never awaited), so re-render with
// the verdict appended rather than leaving the panel claiming a plain engine move.
function update_best_move_suffix() {
    if (last_best_move_line == null) return;
    const el = PANEL_ROOT.getElementById('chess_line_1');
    if (el) el.innerHTML = last_best_move_line + readout_extras();
}


// Config changes that need a full engine re-init used to just reload the popup page. In-page that
// would reload the SITE, so rebuild the panel instead -- same outcome: fresh config, fresh engine.
// Copy to the clipboard. navigator.clipboard needs a secure context + focus; the button click gives
// us the gesture, but fall back to the old execCommand path if it's unavailable/denied.
async function copy_text(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

// Copy `text`, flashing the button's own icon as the receipt. Shared by Copy FEN and Copy PGN.
async function copy_to_button(id, text) {
    if (!text) return;
    const icon = PANEL_ROOT.getElementById(id)?.querySelector('.mp-icon');
    const ok = await copy_text(text);
    if (!icon) return;
    const was = icon.textContent;
    icon.textContent = ok ? '✓' : '✕';
    setTimeout(() => { icon.textContent = was; }, 900);
}

// The game so far, as PGN. chess.js has no pgn() of its own, so build it from history()'s SAN --
// the same replay the analysis already does. Returns null when there's nothing to copy, or when the
// variant is one chess.js can't replay (see CHESSJS_VARIANTS), rather than emitting a wrong game.
function current_pgn() {
    const {startFen, moves} = last_pos;
    if (!moves) return null;
    let san;
    try {
        const chess = new Chess(config.variant, startFen || undefined);
        for (const uci of moves.split(' ').filter(Boolean)) chess.move(uci);
        san = chess.history();
    } catch (e) { return null; }
    if (!san.length) return null;

    const tags = [`[Variant "${config.variant}"]`];
    // A non-standard start (chess960, "From Position") MUST ship as SetUp+FEN tags -- without them
    // the PGN reads back from move 1 of the standard position, i.e. a different game entirely.
    if (startFen) tags.push('[SetUp "1"]', `[FEN "${startFen}"]`);

    // Number from the START position rather than from "1." with white: a From-Position game can
    // begin at any move number, and with black to play -- which PGN writes as `12... Nf6`.
    const fields = (startFen || '').split(' ');
    let num = parseInt(fields[5]) || 1;
    let black = fields[1] === 'b';
    let body = '';
    for (let i = 0; i < san.length; i++) {
        if (!black) body += `${num}. `;
        else if (i === 0) body += `${num}... `; // black to move at the start needs the ellipsis once
        body += san[i] + ' ';
        if (black) num++;
        black = !black;
    }
    return `${tags.join('\n')}\n\n${body.trim()}`;
}

// The element the panel's own classes live on: the panel body in-page, <body> in the toolbar popup.
function panel_body() {
    return (PANEL_ROOT === document) ? document.body : PANEL_ROOT.getElementById('mephisto-panel-body');
}

// Compact mode: collapse to just the status + move lines + score, hiding the board, the eval bar,
// quick-settings and the extras. The toggle lives in the floating panel's TITLE BAR (window chrome,
// next to minimize) -- the button row along the bottom is full, and a control that hides the panel's
// contents shouldn't live among the contents it hides.
function toggle_compact() {
    config.compact = !config.compact;
    MephistoConfig.set('compact', config.compact);
    apply_compact();
}

function apply_compact() {
    panel_body()?.classList.toggle('mephisto-compact', !!config.compact);
    // Hiding elements can't shrink the panel on its own: it's a FIXED-size box that the content
    // script scales, so the box and its wrapper have to be resized too. No-op in the toolbar popup,
    // where Chrome sizes the bubble around the content.
    self.MephistoContent?.setPanelCompact?.(!!config.compact);
}

// Native engines are a separate process that may simply not be installed, and the failure is
// otherwise silent (the panel just never evaluates). Probe the host -- `ping` answers WITHOUT
// launching the engine -- and show a dot. WASM engines are bundled, so the dot is hidden for them.
async function refresh_engine_health() {
    const el = PANEL_ROOT.getElementById('engine-health');
    if (!el) return;
    if (!NATIVE_ENGINES.includes(config.engine)) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.className = 'probing';
    el.title = 'Checking the native host…';
    const want = config.engine; // a switch mid-probe must not let a stale result paint the new engine
    const ok = await native_host_available(native_port_name());
    if (config.engine !== want) return;
    el.className = ok ? 'ok' : 'down';
    el.title = ok ? 'Native host is responding' : 'Native host not responding — run native-host/install.sh once';
}

// The status line under the buttons. A variant chess.js can't replay would otherwise sit there
// showing a normal "Game detected on ..." while analysing the wrong position -- say so instead.
function set_detection_status(text) {
    const el = PANEL_ROOT.getElementById('game-detection');
    if (!el) return;
    if (!CHESSJS_VARIANTS.includes(config.variant)) {
        // reuse the dropdown's own label rather than keeping a second name map in sync
        const opt = [...(PANEL_ROOT.getElementById('qs_variant')?.options || [])]
            .find(o => o.value === config.variant);
        el.innerText = `${opt ? opt.innerText : config.variant}: analysis not supported`;
        el.classList.add('unsupported');
        return;
    }
    el.classList.remove('unsupported');
    el.innerText = text;
}

function panel_reload() {
    if (IS_CONTENT_SCRIPT) { self.MephistoContent?.reopenPanel?.(); return; }
    location.reload();
}

// "Receiving end does not exist" means the tab has no live content-script. The overwhelmingly common
// cause is a RELOADED EXTENSION with the game tab still open: reloading orphans every content script
// already injected, and the orphan cannot be messaged again. The popup then polls into the void and
// sits on "No Chess Game Detected" forever -- which reads as a broken scraper rather than a page that
// needs reloading. This is toolbar-popup-only by nature: the floating panel IS the content script, so
// it cannot be orphaned away from itself.
//
// The error was deliberately swallowed (it is expected on non-chess tabs), so this counts instead:
// a couple of consecutive failures is a dead relay, one is just a tab that isn't ready.
// Chrome names the cause, and the two causes need different fixes -- so report WHICH, rather than
// one message that is right half the time:
//   "Receiving end does not exist"  -> no live content-script (extension reloaded, tab not reloaded)
//   "Cannot access contents of..."  -> no host permission for this site (a manifest matter, and the
//                                      reason the toolbar popup can fail where the floating panel
//                                      cannot: the panel talks to content-script.js in its own
//                                      isolated world and never touches chrome.tabs at all)
let relay_failures = 0;
function note_relay_result(lastError) {
    if (!lastError) { relay_failures = 0; return; }
    if (++relay_failures !== 3) return; // exactly 3 -> report once, don't repaint every poll
    const why = String(lastError.message || lastError);
    console.warn('Mephisto: the panel cannot reach this tab\'s content script:', why);
    set_detection_status(/access|permission/i.test(why)
        ? i18n('panel.no_site_access', 'No access to this site — check the extension\'s permissions')
        : i18n('panel.reload_the_page', 'Reload this page — the extension was updated'));
}

function send_to_active_tab(message) {
  // In-page panel: content-script.js is in THIS isolated world -- call it directly. chrome.tabs is
  // undefined here, and runtime.sendMessage would go to the extension, never to a sibling content script.
  if (IS_CONTENT_SCRIPT) {
      try { self.MephistoContent?.handle(message); } catch (e) { console.warn('Mephisto: panel->content failed', e); }
      return;
  }
  try { // chrome.* throws "Extension context invalidated" if the extension was reloaded while this
        // popup page is still live -- harmless (a reload re-injects a fresh one)
    // read lastError so "Receiving end does not exist" (no content-script on tab) stays unlogged
    if (MY_TAB_ID) { // normal path: talk to OUR tab only, even when it's in the background
        chrome.tabs.sendMessage(MY_TAB_ID, message, () => note_relay_result(chrome.runtime.lastError));
        return;
    }
    // The TOOLBAR POPUP always lands here: chrome.action.setPopup registers popup.html with no
    // ?tab= param, so MY_TAB_ID is null for the whole session. This is the path that has to report,
    // not the one above -- which is why the first version of note_relay_result never fired in the
    // one mode it was written for.
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) { // fallback: no tab id yet
        if (!tabs[0]?.id) return note_relay_result({message: 'no active tab'});
        chrome.tabs.sendMessage(tabs[0].id, message, () => note_relay_result(chrome.runtime.lastError));
    });
  } catch (e) { /* extension context invalidated -- ignore */ }
}

let fen_request_inflight = false;
let fen_request_timer = null;

function request_fen() {
    // don't pile up overlapping fen requests when the scrape round-trip is slower than the poll
    // interval (10ms). Self-heals: the content-script skips replying while it performs a move (or
    // before config arrives), so a 500ms fallback clears the flag -- polling can never wedge.
    if (fen_request_inflight) return;
    fen_request_inflight = true;
    clearTimeout(fen_request_timer);
    fen_request_timer = setTimeout(() => { fen_request_inflight = false; }, 500);
    send_to_active_tab({queryfen: true});
}

// An empty square that the moving piece CANNOT legally reach -- clicking it first clears any
// stale board selection (e.g. a piece left selected by a failed click) without risking an
// accidental move (a random empty square might be a legal destination and would move the piece).
function safe_deselect_square(fen, move) {
    if (!/^[a-h][1-8][a-h][1-8]/.test(move ?? '')) return null;
    try {
        const chess = new Chess(config.variant, fen);
        const from = move.slice(0, 2), to = move.slice(2, 4);
        const dests = new Set(chess.moves({square: from, verbose: true}).map(m => m.to));
        for (const f of 'abcdefgh') {
            for (const r of '12345678') {
                const sq = f + r;
                if (sq === from || sq === to) continue;
                if (chess.get(sq)) continue;   // occupied
                if (dests.has(sq)) continue;   // a legal destination -> clicking it could move the piece
                return sq;
            }
        }
    } catch (e) { /* bad fen -> no deselect */ }
    return null;
}

// -------------------------------------------------------------------------------------------
// Humanize + Clock Mode: decide WHAT to play (occasionally a non-best line, capped loss) and
// HOW LONG to visibly "think" (instant recaptures/forced moves, long thinks on critical
// positions, everything scaled to the clock when Clock Mode reads one off the page).

// How many lines the ENGINE searches. Humanize picks its move out of that list, so the list has to
// actually contain the move it wants; the DISPLAY still honours config.multiple_lines.
//
// The mistake/blunder bands (200-400cp / 400-600cp worse, see humanize_pick) can only be filled by
// moves the engine ranks LOW. Its top 3 all sit within ~40cp of each other, so at MultiPV 3 those
// pools were always empty and every mistake/blunder roll silently fell back to the best move --
// which is exactly why the mix produced 97%-accuracy, 0-mistake games. Moves that bad usually start
// around rank 6-12 in a middlegame, so ask for a deep list when those bands are switched on.
//
// Only when they're switched on: a wide MultiPV makes the engine search every one of those root
// moves properly, which costs real depth. Nobody who leaves mistakes/blunders at 0 should pay it.
const HUMANIZE_DEEP_MULTIPV = 20;
// Roughly how far down the cp ladder a short (6-line) list reaches in a typical middlegame: its 6th
// move is usually only ~40-60cp worse than best. Any band that extends past this needs a wide list.
const HUMANIZE_SHALLOW_REACH_CP = 60;

function effective_multipv() {
    if (!config.humanize) return config.multiple_lines;
    const rates = humanize_rates();
    const t = humanize_thresholds();
    // Every non-top band picks its move from the engine's LINE LIST, so the list must reach as deep
    // as the worst band you've given a share. This used to trigger the wide search only for
    // inaccuracy/mistake/blunder -- but a "third/fourth line" move sits just as far down the list
    // (rank ~8-13), so with a 6-line list those rolls found an empty pool and silently fell back to
    // the TOP move. That's why a 60%-non-top mix still played like a 96%-accuracy engine: the deeper
    // bands never had candidates. Go wide whenever the deepest band with a share reaches past what a
    // short list covers -- which correctly keeps a pure top+near-best mix on the cheap 6-line search.
    let deepest = 0;
    for (const cat of ['second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder'])
        if ((rates[cat] || 0) > 0) deepest = Math.max(deepest, t[cat]);
    const wantsDeep = deepest > HUMANIZE_SHALLOW_REACH_CP;
    return Math.max(wantsDeep ? HUMANIZE_DEEP_MULTIPV : 6, config.multiple_lines);
}

// Ordered worst-to... no: BEST-to-worst. The roll walks these as cumulative % slices; each non-top
// category is a centipawn BAND whose upper bound is its own threshold and lower bound is the
// previous category's threshold (top = 0). Shared by the roll and the pick so they can't drift.
const HUMANIZE_ORDER = ['top', 'second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder'];
const HUMANIZE_LABEL = {
    top: 'top engine', second: 'second line', third: 'third line', fourth: 'fourth line',
    inaccuracy: 'inaccuracy', mistake: 'mistake', blunder: 'blunder',
};

function humanize_get(key, dflt) {
    try {
        const v = JSON.parse(MephistoConfig.get(key));
        return (v != null && isFinite(+v)) ? Math.max(0, +v) : dflt;
    } catch (e) { return dflt; }
}

// Humanize move mix in PERCENT (the seven HUMANIZE_ORDER categories, normalized to sum 100). Tuned
// by the sliders in the options page and read fresh on EVERY pick -- the options page and this popup
// share the extension's storage, so edits apply to the very next move, no reload. fourth/inaccuracy
// default to 0 so adding them didn't change any existing user's behaviour.
function humanize_rates() {
    const r = {
        top: humanize_get('humanize_top', 50),
        second: humanize_get('humanize_second', 40),
        third: humanize_get('humanize_third', 4),
        fourth: humanize_get('humanize_fourth', 0),
        inaccuracy: humanize_get('humanize_inaccuracy', 0),
        mistake: humanize_get('humanize_mistake', 5),
        blunder: humanize_get('humanize_blunder', 1),
    };
    const sum = HUMANIZE_ORDER.reduce((a, k) => a + r[k], 0);
    if (sum > 0) for (const k in r) r[k] = r[k] * 100 / sum;
    return r;
}

// Per-category centipawn thresholds -- each is a band's UPPER bound; the lower bound is the previous
// category's. Defaults trace Lichess's own move-quality boundaries (WinPercent.scala / Advice.scala):
// from an equal position a 110cp loss is a 10% win-chance drop (Inaccuracy), 230cp a 20% drop
// (Mistake), 377cp a 30% drop (Blunder). Clamped strictly ascending so a hand-edited/again-misordered
// store can't invert a band.
function humanize_thresholds() {
    const t = {
        second: humanize_get('humanize_cp_second', 40),
        third: humanize_get('humanize_cp_third', 75),
        fourth: humanize_get('humanize_cp_fourth', 110),
        inaccuracy: humanize_get('humanize_cp_inaccuracy', 230),
        mistake: humanize_get('humanize_cp_mistake', 377),
        blunder: humanize_get('humanize_cp_blunder', 600),
    };
    let prev = 0;
    for (const k of ['second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder']) {
        t[k] = Math.max(prev + 1, t[k]);
        prev = t[k];
    }
    return t;
}

// (lo, hi] cp band per non-top category, from the ascending thresholds.
function humanize_band_bounds() {
    const t = humanize_thresholds();
    return {
        second: [0, t.second], third: [t.second, t.third], fourth: [t.third, t.fourth],
        inaccuracy: [t.fourth, t.inaccuracy], mistake: [t.inaccuracy, t.mistake],
        blunder: [t.mistake, t.blunder],
    };
}

// Which category a 0-100 roll lands in, given the % shares. Cumulative over HUMANIZE_ORDER.
function category_for_roll(r, rates) {
    let acc = 0;
    for (const cat of HUMANIZE_ORDER) { acc += rates[cat] || 0; if (r < acc) return cat; }
    return 'top';
}

// Pre-rolled humanize outcome for the current move, decided at SEARCH START so the countdown can
// show which move is coming from the very beginning (not just the last instant). The random slice
// roll doesn't need the search -- only whether the chosen line is actually PLAYABLE does, which
// humanize_pick checks later using this same roll (`humanize_roll.r`), so what's shown matches what
// gets played, with a rare late correction (a recapture, or a rolled slice that turns out too weak
// and falls back to the top move). {r: the 0-100 roll, category: the label to show}.
let humanize_roll = null;

function roll_humanize_category(fen) {
    try {
        if (new Chess(config.variant, fen).moves().length === 1) return {r: 0, category: 'instant response'};
    } catch (e) { /* variant fen chess.js can't parse -- fall through to the mix roll */ }
    const r = Math.random() * 100;
    return {r, category: HUMANIZE_LABEL[category_for_roll(r, humanize_rates())]};
}

// our-perspective centipawns for a line whose score/mate are stored white-relative;
// mates map to huge cp so comparisons Just Work (closer mate = bigger)
function line_cp_ours(line) {
    const sign = (turn === 'w') ? 1 : -1;
    if ('mate' in line) {
        if (line.mate === 0) return -100000 * sign; // side to move IS mated
        return sign * Math.sign(line.mate) * (100000 - 1000 * Math.abs(line.mate));
    }
    return sign * line.score;
}

// Clock Mode and Mirror Time are both "clock-aware": either one reads the scraped clock and
// paces to it. They differ in HOW: Clock Mode budgets from OUR clock (T/30 + 0.6*increment),
// Mirror Time paces to the OPPONENT's spend (x0.9). Mirror falls back to the budget when their
// spend hasn't been measured yet, and both share the same low-time safety rails.
function clock_aware() {
    return config.clock_mode || config.mirror_mode;
}

// per-move time budget in ms from the scraped clock, or null when no clock-aware mode is on
// (or the clock is unreadable). ~T/30 + 60% of the increment, never more than T/8.
function clock_budget_ms() {
    if (!clock_aware() || !last_clocks || last_clocks.mine == null) return null;
    const elapsed = (Date.now() - last_clocks.at) / 1000; // the scrape is a moment old
    const T = Math.max(1, last_clocks.mine - elapsed);
    const I = last_clocks.increment || 0;
    return Math.max(120, Math.min((T / 30 + 0.6 * I) * 1000, T * 1000 / 8));
}

// time reserved (ms) to actually click the move + engine stop/flush overhead, so the SEARCH never
// eats the whole budget and leave nothing to play it in
const MOVE_MARGIN = 150;
let search_start = 0; // when the current autoplay search was issued (for the residual think below)

// The intended TOTAL time (ms) for the current move from the clock-aware modes, computed WITHOUT
// the search results (Mirror = opponent's spend x0.9, Clock = the T/30 budget). Used to SIZE the
// search in on_new_pos so the engine thinks the whole time instead of finding a shallow move fast
// and then idling. null when no clock-aware mode is active or the clock is unreadable. This is an
// estimate that omits humanize's kind-based caps (which need the results) -- humanize_pick stays
// the authoritative think, and on_engine_best_move only waits out whatever the search didn't cover.
function paced_move_target_ms() {
    if (!clock_aware() || !last_clocks || last_clocks.mine == null) return null;
    const T = last_clocks.mine - (Date.now() - last_clocks.at) / 1000; // seconds remaining
    let ms;
    if (config.mirror_mode && opp_spend != null) {
        ms = opp_spend * 900;                                     // mirror: 90% of their spend
        if (last_clocks.theirs != null && T < last_clocks.theirs) ms *= 0.7; // catch up when behind
    } else {
        ms = clock_budget_ms();
        if (ms == null) return null;
    }
    ms = Math.min(ms, T * 1000 / 8);   // never sink an eighth of the clock into one move
    if (T < 20) ms = Math.min(ms, 250);
    if (T < 8) ms = 0;
    return {ms, lowClock: T < 20};
}

// Pre-search estimate (ms) of humanize's think for THIS move, for humanize WITHOUT a clock-aware
// mode (which would otherwise size the search itself). Humanize's real "long think" keys off the
// position's criticality, only known after the search -- so here we estimate it from the signals
// available BEFORE it: game phase and how balanced the game is (|last eval|). A tense, level game
// gets a deep search; an opening or a decided game gets a quick one. It's just a search size --
// humanize_pick still decides the actual think from the results, and any shortfall is waited out.
function humanize_presearch_ms(fen) {
    if (!config.humanize || clock_aware() || !config.autoplay
        || config.help_mode || config.puzzle_mode) return null;
    let fullmove = 999;
    try { fullmove = parseInt(fen.split(' ')[5]) || 999; } catch (e) { /* variant fen */ }
    if (fullmove < 8) return 500;                                   // opening: reel it off
    const evalCp = (last_our_eval != null) ? Math.abs(last_our_eval) : 0;
    if (evalCp > 600) return 500;                                  // game decided: moves matter less
    if (evalCp < 150) return 2500;                                 // balanced & tense: think
    return 1200;                                                   // ordinary middlegame
}

// {move, think}: which move to actually play, and how long to sit on it first
function humanize_pick(best) {
    const fen = last_eval.fen;
    const lines = (last_eval.lines || []).filter(l => l && l.move && l.pv);
    const bestLine = lines.find(l => l.move === best) || lines[0];
    const bestCp = bestLine ? line_cp_ours(bestLine) : 0;

    let category = 'top engine'; // which slice of the move mix the pick came from (for the countdown)
    // reflex moves first: a human ALWAYS bangs out the recapture / the only legal move --
    // instantly, and without ever "choosing" an alternative
    const lastOpp = last_eval.lastMove; // opponent's move that produced this position (lan)
    // True recapture only: the opponent's move must have been a CAPTURE (which zeroes the FEN
    // halfmove clock) AND we take back on that same square. Instantly snapping off a piece that
    // merely moved in to attack (e.g. a knight hitting our queen) is NOT a reflex for a human --
    // treating it as one made the instant replies look illegitimate. (A pawn push also zeroes the
    // clock, but taking a just-pushed pawn on its square is still a fair reflex; those are rare.)
    let halfmove = 1;
    try { halfmove = parseInt(fen.split(' ')[4]); } catch (e) { /* variant fen: leave >0, no false reflex */ }
    const recapture = lastOpp && halfmove === 0 && best.slice(2, 4) === lastOpp.slice(2, 4);
    let forced = false, fullmove = 999;
    try {
        const chess = new Chess(config.variant, fen);
        forced = chess.moves().length === 1;
        fullmove = parseInt(fen.split(' ')[5]) || 999;
    } catch (e) { /* variant fen chess.js can't parse -- classification just loses two signals */ }

    // ---- WHAT to play: mostly the best move; sometimes a close second; rarely a real mistake.
    // (only Humanize deviates -- with Clock Mode alone this function only shapes the timing)
    let move = best;
    if (config.humanize && !recapture && !forced
        && lines.length >= 2 && bestLine && bestCp < 90000 /* never toy with our own mate */) {
        const playable = (m) => premove_reply_playable(fen, m); // moves OUR piece + legal here
        const loss = (l) => bestCp - line_cp_ours(l);
        const alts = lines.filter(l => l !== bestLine && line_cp_ours(l) > -90000); // never move INTO mate
        const rates = humanize_rates(); // move mix percents; live-tunable in the options page
        // reuse the roll made at search start (so the countdown's shown move matches what's played)
        const r = (humanize_roll != null) ? humanize_roll.r : Math.random() * 100;
        // Each non-top category is a (lo, hi] centipawn band whose edges the user sets in the options
        // page (Move-Quality Thresholds); pick a random alternative whose loss falls in the rolled
        // band. A move worse than the top of the blunder band is never played -- that's a hanging
        // queen, not a human error -- so an out-of-band roll falls back to the best move.
        const bands = humanize_band_bounds();
        const fromBand = ([lo, hi]) => {
            const pool = alts.filter(l => loss(l) > lo && loss(l) <= hi);
            return pool[Math.floor(Math.random() * pool.length)];
        };
        const cat = category_for_roll(r, rates);
        let cand = null;
        // blunders never in an already-decided game (we're the ones winning/losing big)
        if (cat !== 'top' && !(cat === 'blunder' && Math.abs(bestCp) >= 600)) {
            cand = fromBand(bands[cat]);
            if (cand) category = HUMANIZE_LABEL[cat];
        }
        if (cand && playable(cand.move)) move = cand.move;
        else category = 'top engine'; // top slice / pool empty / not playable -> best move after all
    }

    // ---- HOW LONG to think: classify the position, then sample a duration.
    const second = lines.find(l => l !== bestLine);
    const gap = second ? bestCp - line_cp_ours(second) : Infinity;
    const swing = (last_our_eval != null) ? bestCp - last_our_eval : 0;
    last_our_eval = bestCp;

    let kind;
    if (recapture || forced) kind = 'instant';
    else if (gap < 35 && Math.abs(bestCp) < 150) kind = 'long';   // tense: close choices, level game
    else if (swing < -120) kind = 'long';                          // something went wrong -- "sit up"
    else if (gap > 250 || fullmove < 8) kind = 'quick';            // obvious move / opening reel-off
    else kind = 'normal';

    const r = Math.random();
    let think = {instant: r * 150, quick: 250 + r * 500,
                 normal: 600 + r * 1400, long: 2000 + r * 4500}[kind];

    // ---- clock pacing (only when a clock-aware toggle is on and a clock was read).
    // Mirror Time (its own toggle): spend what the opponent spent on their last move, minus 10%,
    // so our clock tracks theirs while slowly pulling ahead (plus 30% extra haste whenever we're
    // actually behind on time). Falls back to Clock Mode's T/30 + 0.6*increment budget when their
    // spend hasn't been measured (first move, unreadable clock) -- and Clock Mode alone uses that
    // budget always. Reflex moves stay instant regardless, and both paths share the safety rails.
    // `source` = who decided the timing (priority: reflex > mirror > clock > humanize), for the
    // "Playing in ..." countdown under the score.
    if (recapture || forced) category = 'instant response';
    let source = (kind === 'instant') ? 'Reflex' : 'Humanize';
    const budget = clock_budget_ms();
    if (budget != null) {
        const T = last_clocks.mine - (Date.now() - last_clocks.at) / 1000;
        if (config.mirror_mode && kind !== 'instant' && opp_spend != null) {
            think = opp_spend * 900; // 90% of their spend, in ms
            if (last_clocks.theirs != null && T < last_clocks.theirs) think *= 0.7;
            think = Math.min(think, T * 1000 / 8); // never sink an eighth of the clock into one move
            source = 'Mirror Time';
        } else {
            const cap = {instant: think, quick: budget * 0.35, normal: budget, long: budget * 2.5}[kind];
            think = Math.min(think, cap);
            if (kind !== 'instant') source = 'Clock Mode';
        }
        if (T < 20) think = Math.min(think, 250);
        if (T < 8) think = 0;
    }
    return {move, think: Math.round(think), source, category: config.humanize ? category : null};
}

// "Playing in X.Xs (Mirror Time)" countdown under the score -- shown whenever a pacing mode
// (mirror/clock/humanize) decided a think delay for the move that is about to be played
let eta_timer = null, eta_target = 0, eta_source = '', eta_category = null;

// The "Playing in X.Xs" countdown is TARGET-anchored so it can span the whole move: it's started
// when the SEARCH begins (on_new_pos) with the full intended time -- so it counts the entire pace
// down while the engine thinks, not just the ~150ms tail left after the search fills the time --
// and updated when the move is picked (on_engine_best_move) to add which humanize slice is coming.
function set_move_countdown(target, source, category = null) {
    eta_target = target; eta_source = source; eta_category = category;
    clearInterval(eta_timer);
    const tick = () => {
        const el = PANEL_ROOT.getElementById('next-move');
        if (!el) { clearInterval(eta_timer); return; }
        const left = eta_target - Date.now();
        const suffix = eta_category ? ` · ${eta_category}` : ''; // humanize: which move it plays next
        if (left <= 50) {
            el.textContent = i18n('panel.eta.now', 'Playing now ({source}){suffix}', {source: eta_source, suffix});
            clearInterval(eta_timer);
            return;
        }
        el.textContent = i18n('panel.eta.in', 'Playing in {secs}s ({source}){suffix}',
        {secs: (left / 1000).toFixed(1), source: eta_source, suffix});
    };
    tick();
    eta_timer = setInterval(tick, 100);
}

function clear_next_move_eta() {
    clearInterval(eta_timer);
    eta_target = 0;
    const el = PANEL_ROOT.getElementById('next-move');
    if (el) el.textContent = '';
}

// Estimated TOTAL time (ms) this move will take + who's pacing it -- known before the search from
// the clock (Mirror/Clock) or the humanize criticality estimate. null when nothing changes the
// base time (plain autoplay), so no countdown is shown then.
function estimated_move_total_ms(fen) {
    const pace = paced_move_target_ms();
    if (pace != null) {
        if (pace.ms <= 0) return null; // low clock -> effectively instant, nothing to count down
        return {ms: pace.ms, source: (config.mirror_mode && opp_spend != null) ? 'Mirror Time' : 'Clock Mode'};
    }
    const hz = humanize_presearch_ms(fen);
    if (hz != null) return {ms: hz, source: 'Humanize'};
    return null;
}

// The four think/move timing values, read fresh from localStorage (options page + quick settings
// both write here). Falls back to the loaded config value when a key is unset. JSON.parse(null)
// is null, so `!= null` keeps a legitimate 0.
function fresh_timing() {
    const num = (key, fallback) => {
        const v = JSON.parse(MephistoConfig.get(key));
        return (v != null) ? v : fallback;
    };
    return {
        think_time: num('think_time', config.think_time),
        think_variance: num('think_variance', config.think_variance),
        move_time: num('move_time', config.move_time),
        move_variance: num('move_variance', config.move_variance),
    };
}

// ---- Self-test: a one-tap health check shown in the status line for a few seconds. Scrape = a
// position is currently detected; Engine = it has produced analysis for it; Native = for a native
// engine, the host actually answered a ping (the real active check -- a missing host is the usual
// "nothing happens" cause). Restores the status line after ~6s.
async function run_self_test() {
    const el = PANEL_ROOT.getElementById('game-detection');
    if (!el) return;
    const prev = el.innerText, wasUnsupported = el.classList.contains('unsupported');
    el.classList.remove('unsupported');
    el.innerText = 'Self-test: running…';
    const scrapeOK = !!last_eval.fen;
    const engineOK = !!(last_eval.lines && last_eval.lines[0] && last_eval.lines[0].pv);
    let nativePart = '', nativeOK = true;
    if (NATIVE_ENGINES.includes(config.engine)) {
        nativeOK = await native_host_available(native_port_name());
        nativePart = nativeOK ? ' · Native ✓' : ' · Native ✗ (run native-host/install.sh)';
    }
    const mark = (b) => b ? '✓' : '✗';
    const allOK = scrapeOK && engineOK && nativeOK;
    el.innerText = `Self-test — Scrape ${mark(scrapeOK)} · Engine ${mark(engineOK)}${nativePart}`;
    el.classList.toggle('unsupported', !allOK);
    setTimeout(() => { el.innerText = prev; el.classList.toggle('unsupported', wasUnsupported); }, 6000);
}

// ---- Lichess win% + accuracy (win-percent model, PR #11148 + AccuracyPercent.scala). cp is
// white/side-relative centipawns. Used by the opponent-mistake alert and mirrored in the options
// page's threshold readout, so both label a move exactly as a Lichess game review would.
function win_percent(cp) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
// judgement label from a win% DROP (before - after), matching Lichess's 30/20/10 thresholds.
function win_drop_label(drop) {
    if (drop >= 30) return 'blunder';
    if (drop >= 20) return 'mistake';
    if (drop >= 10) return 'inaccuracy';
    return null;
}

// ---- Opponent-mistake alert. Flag when the opponent plays an inaccuracy/mistake/blunder, judged by
// the same Lichess win% method. Only when BOTH the position they moved from and the one they moved to
// were searched to a trustworthy depth -- a shallow eval swings wildly and would invent blunders.
const OPP_ALERT_MIN_DEPTH = 14;
let last_pos_eval = null; // {fen, cpWhite, depth, sideToMove} of the position currently on the board
let opp_alert_armed = null; // {beforeCpWhite, oppColor} set when the opponent just moved; cleared on fire

// Called when a NEW position arrives (on_new_pos), BEFORE last_eval is reset. If the position we were
// just analysing was the opponent's turn and reached depth, its eval is the "before their move" value.
function opp_alert_on_new_pos(newFen) {
    opp_alert_armed = null;
    if (!config.opp_alert || !last_pos_eval || last_pos_eval.fen === newFen) return;
    if (last_pos_eval.depth < OPP_ALERT_MIN_DEPTH) return; // shallow "before" -> don't trust it
    const our = (our_side() === 'white') ? 'w' : 'b';
    if (last_pos_eval.sideToMove !== our) { // it was the OPPONENT to move -> they just made this move
        // keep the "before" fen too, so we can render their move in SAN at fire time
        opp_alert_armed = {beforeCpWhite: last_pos_eval.cpWhite, oppColor: last_pos_eval.sideToMove,
                           beforeFen: last_pos_eval.fen};
    }
}

// UCI -> SAN in the position it was played from; falls back to the raw UCI if chess.js can't parse.
function uci_to_san(fen, uci) {
    if (!fen || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return uci || '';
    try {
        return new Chess(config.variant, fen).move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]}).san;
    } catch (e) { return uci; }
}

// Called when the CURRENT position's eval updates (on_engine_evaluation). Fires once the new position
// is also deep enough, comparing the opponent's win% before vs after their move.
function opp_alert_maybe_fire() {
    if (!config.opp_alert || !opp_alert_armed || !last_pos_eval) return;
    if (last_pos_eval.fen !== last_eval.fen || last_pos_eval.depth < OPP_ALERT_MIN_DEPTH) return;
    const sign = (opp_alert_armed.oppColor === 'w') ? 1 : -1; // opponent-relative eval
    const drop = win_percent(sign * opp_alert_armed.beforeCpWhite) - win_percent(sign * last_pos_eval.cpWhite);
    const label = win_drop_label(drop);
    const uci = last_eval.lastMove || ''; // the opponent's move that produced this position
    const san = uci_to_san(opp_alert_armed.beforeFen, uci);
    opp_alert_armed = null; // fire at most once per opponent move
    if (label) send_to_active_tab({oppAlert: true, label, drop: Math.round(drop), san, uci});
}

// ---- Manual Mode: play the engine's current best move on YOUR keypress (the play-move hotkey).
// The search runs `go infinite` in Manual Mode, so it never fires on its own; this is the trigger.
// Returns whether it CONSUMED the key: true whenever Manual Mode is on (so the play-move key -- e.g.
// Space -- is swallowed during a game), false otherwise (so Space still scrolls the page when Manual
// Mode is off). Actually plays only on our turn with a legal, ours move.
function manual_play() {
    if (!config.manual_mode) return false; // not our concern -> let the key through (Space scrolls)
    // only on OUR turn, and only a move that's actually ours + legal right now (same guard autoplay
    // uses). last_eval.bestmove is set only on our turn, so a stale opponent-turn value can't leak.
    const our = (our_side() === 'white') ? 'w' : 'b';
    if (last_eval.fen?.split(' ')[1] === our) {
        const best = last_eval.bestmove || last_eval.lines?.[0]?.move;
        if (best && premove_reply_playable(last_eval.fen, best)) {
            request_automove(best, null, true); // manual:true bypasses the content-script's autoplay gate
        }
    }
    return true; // Manual Mode is on: swallow the key even if there was nothing to play this instant
}

// ---- Hotkeys. The content script owns the keydown listener (keys land on the game page) and calls
// this with an action name; here we perform it. Toggles flip the quick-settings checkbox and fire
// its change event, so they reuse ALL the existing wiring (config write, push, engine re-init).
const HOTKEY_TOGGLES = { // action -> the quick-settings checkbox it flips
    autoplay: 'qs_autoplay', premove: 'qs_premove', help_mode: 'qs_help', humanize: 'qs_humanize',
    clock_mode: 'qs_clock', mirror_mode: 'qs_mirror', manual_mode: 'qs_manual',
    eval_bar: 'qs_evalbar', eval_history: 'qs_evalhist', tablebase: 'qs_tablebase', puzzle_mode: 'qs_puzzle',
    explorer: 'qs_explorer', book_play: 'qs_book',
};
// Returns true if it handled the action (the content-script listener only swallows the key then, so
// an inert binding -- e.g. Space while Manual Mode is off -- doesn't block the page's own use of it).
// "Alt+a" -> "Alt+A", " " -> "Space" (for the little "(A)" hint on each toggle)
function hotkey_pretty(k) {
    if (!k) return '';
    return k.split('+').map(p => p === ' ' ? 'Space' : (p.length === 1 ? p.toUpperCase() : p)).join('+');
}
// Append the bound key to each quick-settings toggle label, e.g. "Autoplay (A)", so the shortcut is
// visible where you use it. Reads the live bindings; run once after the toggles are wired.
function annotate_hotkey_labels() {
    const keys = MephistoConfig.hotkeys();
    for (const action in HOTKEY_TOGGLES) {
        const input = PANEL_ROOT.getElementById(HOTKEY_TOGGLES[action]);
        const label = input?.closest('.qs-row')?.querySelector('.qs-label');
        if (!label || !keys[action] || label.querySelector('.qs-hk')) continue;
        const s = document.createElement('span');
        s.className = 'qs-hk';
        s.style.cssText = 'opacity:0.5;font-size:0.82em;margin-left:3px';
        s.textContent = `(${hotkey_pretty(keys[action])})`;
        label.appendChild(s);
    }
}

function do_hotkey(action) {
    if (action === 'manual_play') return manual_play();
    if (action === 'copy_fen') { copy_to_button('copyfen', last_eval.fen); return true; }
    if (action === 'copy_pgn') { copy_to_button('copypgn', current_pgn()); return true; }
    if (action === 'redetect') { PANEL_ROOT.getElementById('recheck')?.click(); return true; }
    const box = HOTKEY_TOGGLES[action] && PANEL_ROOT.getElementById(HOTKEY_TOGGLES[action]);
    if (!box) return false;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    return true;
}

// Follow the page in and out of Puzzle Mode, the way the variant detector follows a variants page
// onto Fairy-Stockfish. Arriving at lichess/training or chess.com/puzzles switches it on; leaving
// switches it back off.
//
// The off half matters more than the on half. Puzzle Mode changes how the panel plays quite a lot --
// one move at a time, the opponent's turn not analysed, Premove disabled -- so leaving it latched on
// when you go back to a real game would be a worse bug than never having offered this. It is only
// undone if WE were the one who turned it on: a manual choice is never overridden.
let auto_puzzle_mode = false; // did this panel switch Puzzle Mode on for a puzzle page?

function sync_puzzle_mode_to_page(onPuzzlePage) {
    if (onPuzzlePage == null) return;              // site the content-script does not classify
    if (onPuzzlePage === !!config.puzzle_mode) {   // already where it should be
        if (!onPuzzlePage) auto_puzzle_mode = false;
        return;
    }
    if (!onPuzzlePage && !auto_puzzle_mode) return; // you turned it on yourself -- leave it alone
    const box = PANEL_ROOT.getElementById('qs_puzzle');
    if (!box) return;
    auto_puzzle_mode = onPuzzlePage;
    // Flip the checkbox and fire its change event rather than writing config directly: that is the
    // one path that also saves, pushes to the content-script and re-renders, and it is what the
    // hotkeys use for the same reason.
    box.checked = onPuzzlePage;
    box.dispatchEvent(new Event('change'));
    console.log(`Puzzle Mode ${onPuzzlePage ? 'on' : 'off'} — following the page`);
}

// ==================================================================================================
// FOUR-PLAYER BYPASS LANE
//
// 4PC is 14x14 with four seats and a FEN4 position. chess.js cannot represent ANY of that, so this
// lane deliberately skips the whole normal pipeline: no chess.js parse, no legality check, no
// premove, no arrows, no eval bar, no panel board. Scrape in, engine move out, two clicks.
//
// It is entered only when BOTH hold -- the scrape came back as a 4PC payload AND the selected engine
// is a four-player one -- so nothing about the ordinary path changes shape when this file is loaded.
// ==================================================================================================
let board4pc = null;           // the 14x14 renderer, non-null only while it OWNS the #board host
let fourpc_last = '';          // last FEN4 we analysed, to skip re-analysing an unchanged board
let fourpc_busy = false;       // one search at a time: Tetrarch is single-threaded and ignores `stop`
let fourpc_pending = null;     // newest position that arrived while a search was in flight

function is_fourpc_engine() {
    return FOURPC_ENGINES.includes(config.engine);
}

// `4PC:<ourSeat>:<fen4>` -- the content script tags the payload with the seat we are sitting in,
// because "our turn" cannot be derived from a FEN4 alone (it names the side to move, not us).
// The four-player engine follows the page, the way Puzzle Mode does: 4PC needs Tetrarch and Tetrarch
// is useless anywhere else, so selecting it by hand on every game (and remembering to put it back)
// is a chore the page can do for us.
//
// `fourpc_prev_engine` holds what to go back to AND doubles as "we are the ones who switched" -- so a
// deliberate choice is never overridden, matching auto_puzzle_mode. Changing engine reloads the
// panel, which is why every path here returns unless something actually has to change: a switch that
// re-fires on each poll would reload the panel once a second.
let fourpc_prev_engine = null;

function sync_fourpc_engine_to_page(onFourPCPage) {
    if (onFourPCPage == null) return;                 // a site the content-script does not classify
    const sel = PANEL_ROOT.getElementById('qs_engine');
    if (!sel) return;
    const isFourPC = is_fourpc_engine();
    if (onFourPCPage) {
        if (isFourPC) return;                         // already on a four-player engine
        if (fourpc_prev_engine) {
            // We switched, and you have since picked something else WHILE STILL on a 4PC page. That
            // is a deliberate choice, so stop managing the engine rather than switching back on the
            // next poll and fighting you once a second. (Puzzle Mode's version of this does fight
            // you; it should not, but that is its bug to fix, not one to copy.)
            fourpc_prev_engine = null;
            return;
        }
        fourpc_prev_engine = config.engine;            // remember what to restore
        sel.value = FOURPC_ENGINES[0];
        sel.dispatchEvent(new Event('change'));        // the one path that saves, pushes and reloads
        console.log(`Engine -> ${FOURPC_ENGINES[0]} — following the page (was ${fourpc_prev_engine})`);
        return;
    }
    // LEFT THE 4PC PAGES. Unlike Puzzle Mode this is not a preference to respect: Tetrarch plays
    // 14x14 four-player chess and nothing else, so leaving it selected on a normal game is simply a
    // broken panel. Switch away whether we chose it or you did.
    if (!isFourPC) { fourpc_prev_engine = null; return; }  // already on something else
    // back to what you had, unless that was also a 4PC engine (or there was nothing to remember)
    const back = (fourpc_prev_engine && !FOURPC_ENGINES.includes(fourpc_prev_engine))
        ? fourpc_prev_engine : FOURPC_FALLBACK_ENGINE;
    fourpc_prev_engine = null;
    sel.value = back;
    sel.dispatchEvent(new Event('change'));
    console.log(`Engine -> ${back} — restored on leaving 4-player chess`);
}

// 4PC does NOT go through request_automove. That function is two-player to its bones: it asks
// our_side() for white/black, computes `verify` from last_eval.fen (which this lane never sets), runs
// safe_deselect_square through chess.js -- and, the one that actually bit, it ships the move as
// `pv: [move]` whenever Puzzle Mode is on, because the content-script's puzzle branch takes that
// shape. The content script tests `response.pv` BEFORE the 4PC branch, so a 4PC move arrived at the
// 8x8 simulator and was refused by its [a-h][1-8] regex. Nothing clicked, and Puzzle Mode being on is
// not a state anyone would think to mention.
//
// An explicit `fourpc: true` flag, checked first, makes the routing independent of any other setting.
function request_automove_4pc(move) {
    send_to_active_tab({automove: true, fourpc: true, move, timing: fresh_timing(),
                        deselect: null, verify: false, manual: false});
}

// The eval bar in 4PC. Two teams, not two colours: R+Y against B+G (RULES.md 2), so the bar is Team
// Red against Team Blue and YOUR team always grows from the bottom -- the same "bottom belongs to
// you" convention the two-player bar uses for board orientation.
//
// The normal update_eval_bar cannot be reused: it reads `turn` and board.orientation(), both of which
// are two-player state this lane never sets, and its share is white-relative. This takes the score
// already normalised to your team, so positive is always your side.
const FOURPC_SEAT_NAME = {R: 'Red', B: 'Blue', Y: 'Yellow', G: 'Green'};
const FOURPC_TEAM_COLOR = ['#c33c3c', '#3f72c4'];   // team Red (R+Y), team Blue (B+G)
function update_eval_bar_4pc(line, flip, ourSeat) {
    const wrap = PANEL_ROOT.getElementById('eval-bar');
    const fill = PANEL_ROOT.getElementById('eval-bar-white');
    if (!wrap || !fill || !line) return;
    // The host falls back to a bare {move, pv} when a search returns no `info` line at all. Without
    // this, `score` is undefined, the exp() below is NaN, and `height: NaN%` silently freezes the bar
    // wherever it happened to be -- which reads as "the eval bar does not move".
    if (!('mate' in line) && !Number.isFinite(line.score)) return;
    const ourTeam = (ourSeat === 'R' || ourSeat === 'Y') ? 0 : 1;
    let frac;                                       // OUR team's share of the bar
    if ('mate' in line) {
        frac = (flip * line.mate >= 0) ? 1 : 0;
    } else {
        const wc = 2 / (1 + Math.exp(-0.00368 * flip * line.score)) - 1;  // same lichess curve
        frac = Math.max(0.03, Math.min(0.97, 0.5 + wc / 2));
    }
    wrap.style.background = FOURPC_TEAM_COLOR[1 - ourTeam];   // the other team fills the rest
    fill.style.background = FOURPC_TEAM_COLOR[ourTeam];
    fill.style.top = 'auto';                        // your team is ALWAYS the bottom of the bar
    fill.style.bottom = '0';
    fill.style.height = `${frac * 100}%`;
}

// The 8x8 and 14x14 renderers share the single #board host, so swapping is just "whoever renders
// last owns it". Both are synchronous and cheap, so there is nothing to tear down.
function show_4pc_board(fen4, ourSeat) {
    try {
        // The header switch is White-vs-Black. With four seats it is not merely useless but
        // actively wrong -- the panel says "Red to move" directly under a control reading
        // "White to move". Hidden the same way the Elo and Variant rows hide themselves.
        const ts = PANEL_ROOT.getElementById('qs_turn_switch');
        if (ts) ts.style.display = 'none';
        if (!board4pc) board4pc = MephistoBoard4PC('board', {root: PANEL_ROOT});
        board4pc.orientation((ourSeat || 'r').toLowerCase());   // you are always at the bottom
        board4pc.position(fen4);
    } catch (e) { /* host not built yet; the next position paints it */ }
}

function hide_4pc_board() {
    if (!board4pc) return;
    board4pc = null;
    const ts = PANEL_ROOT.getElementById('qs_turn_switch');
    if (ts) ts.style.display = '';
    request_clear_hint();          // 4PC arrows must not survive onto an 8x8 board
    try { board.position(board.position()); } catch (e) { /* 8x8 board not built yet */ }
}

function fourpc_drain() {
    const next = fourpc_pending;
    fourpc_pending = null;
    if (next) on_new_pos_4pc(next);
}

function on_new_pos_4pc(payload) {
    // `<seat>:<mode>:<fen4>` -- the mode decides the promotion rank AND whether Tetrarch can search
    // this game at all, so it travels with the position rather than being assumed.
    const i = payload.indexOf(':');
    const j = payload.indexOf(':', i + 1);
    const ourSeat = payload.slice(0, i);
    const mode = payload.slice(i + 1, j);
    const fen4 = payload.slice(j + 1);
    if (!fen4) return;

    // A position arriving mid-search used to be DROPPED, and `fourpc_last` had already been set to
    // the in-flight one -- so once the board settled on a position we skipped, nothing re-triggered
    // it and the panel sat there until the page was reloaded. Hold the newest instead and pick it up
    // when the current search returns. (Tetrarch is single-threaded and ignores `stop`, so the search
    // in flight genuinely cannot be cancelled -- queueing is the only correct answer.)
    // PAINT FIRST, ahead of both early returns. The dedupe below exists to avoid re-SEARCHING an
    // unchanged position, not to avoid redrawing it -- and anything that repaints the shared host
    // behind our back (a panel rebuild on the engine auto-switch, most obviously) leaves the 8x8
    // board showing with no way back, because the position it would need to react to is already the
    // one in `fourpc_last`. Rendering is synchronous and cheap; there is no reason to gate it.
    show_4pc_board(fen4, ourSeat);
    if (fourpc_busy) { fourpc_pending = payload; return; }
    if (fen4 === fourpc_last) return;
    fourpc_last = fen4;
    const turn = fen4[0];
    const ours = (turn === ourSeat);
    const seatName = FOURPC_SEAT_NAME[turn] || turn;
    // SCORE PERSPECTIVE, hoisted: Tetrarch reports from the side-to-move's TEAM (PROTOCOL.md) and the
    // seat rotates every ply, so the raw number flips sign each move and the same evaluation reads as
    // +3.06 then -3.06. Normalised to YOUR team it means one thing all game. Standard pairing is
    // R+Y against B+G (RULES.md 2). Needed BEFORE the search so the streamed info can use it too.
    const team = (seat) => (seat === 'R' || seat === 'Y') ? 0 : 1;
    const flip = (ourSeat !== '?' && team(turn) !== team(ourSeat)) ? -1 : 1;
    set_detection_status(i18n('panel.fourpc_detected', '4-player chess — {seat} to move',
        {seat: FOURPC_SEAT_NAME[turn] || turn}));
    if (!is_fourpc_engine()) {
        update_best_move(i18n('panel.fourpc_needs_engine',
            'Select the Tetrarch engine to analyse 4-player chess (Teams mode only)'));
        return;
    }
    fourpc_busy = true;
    // Mode is the one option that changes the RULES (promotion is the 8th rank in FFA, the 11th in
    // Teams), so it is pushed before the first search. Setup is deliberately NOT sent: every position
    // arrives as a full FEN4, which makes all five starting setups the same code path.
    // FFA IS NOT SEARCHABLE. Tetrarch implements Teams only (PROTOCOL.md), so on a free-for-all board
    // the honest answer is to say so rather than hand back a move scored against the wrong rules.
    if (mode === 'ffa') {
        fourpc_busy = false;
        update_best_move(i18n('panel.fourpc_ffa',
            'Free-for-all — Tetrarch searches Teams mode only'));
        return;
    }
    request_remote_configure({Mode: mode || 'teams'}).catch(() => {});
    toggle_calculating(true);
    native_send('analyse', {fen4, time: Math.max(200, config.compute_time || 1000)}, (info) => {
        // The host emits one frame per depth exactly like the two-player hosts, and the panel has
        // always had the rows for them -- 4PC simply never asked. Same NPS box, same score line.
        if (!info || fen4 !== fourpc_last) return;
        const npsEl = PANEL_ROOT.getElementById('nps');
        if (npsEl && Number.isFinite(info.nps) && info.nps > 0) npsEl.textContent = format_nps(info.nps);
        if ('mate' in info) {
            update_evaluation(i18n('panel.msg.mate_in', 'Checkmate in {n}', {n: flip * info.mate}));
        } else if (Number.isFinite(info.score) && Number.isFinite(info.depth)) {
            update_evaluation(i18n('panel.msg.score_at_depth', 'Score: {score} at depth {depth}',
                {score: (flip * info.score / 100).toFixed(2), depth: info.depth}));
        }
        if (info.move) {
            update_best_move(i18n('panel.msg.fourpc_to_play', '{seat} to play, best move is {move}',
                {seat: seatName, move: info.move}));
        }
    })
        .then((res) => {
            fourpc_busy = false;
            fourpc_drain();
            if (fen4 !== fourpc_last) return;          // the board moved on while we searched
            const best = res && res.bestmove;
            // `0000` is UCI's null move -- Tetrarch returns it when the position has no move to make
            // (game over). It is not a move to play, and passing it on got it as far as the clicker.
            if (!best || best === '(none)' || best === '0000') {
                update_best_move(i18n('panel.no_move', 'No move'));
                return;
            }
            const line = res.lines && res.lines[0];
            // SCORE PERSPECTIVE. Tetrarch reports from the side-to-move's TEAM (PROTOCOL.md), and the
            // seat to move rotates every ply -- so the raw number flips sign each move and the same
            // evaluation reads as +3.06 then -3.06. Normalise to YOUR team so it means one thing all
            // game: positive is good for you. Standard pairing is R+Y against B+G (RULES.md 2).
            toggle_calculating(false);
            update_best_move(i18n('panel.msg.fourpc_to_play', '{seat} to play, best move is {move}',
                {seat: seatName, move: best}));
            if (line && 'mate' in line) {
                update_evaluation(i18n('panel.msg.mate_in', 'Checkmate in {n}', {n: flip * line.mate}));
            } else if (line && Number.isFinite(line.score)) {
                update_evaluation(i18n('panel.msg.score_at_depth', 'Score: {score} at depth {depth}',
                    {score: (flip * line.score / 100).toFixed(2), depth: line.depth ?? 0}));
            }
            try { board4pc?.highlight(best); } catch (e) { /* board swapped away mid-search */ }
            if (line) update_eval_bar_4pc(line, flip, ourSeat);
            // Help Mode draws the move instead of playing it, exactly as on an 8x8 board. The
            // renderer understands 14x14 now, so this is just a matter of asking for it.
            if (config.help_mode) request_draw_hint([{move: best, color: '#14b8a6', width: 0.22}]);
            else request_clear_hint();
            if (ours && config.autoplay && !config.help_mode) request_automove_4pc(best);
        })
        .catch((e) => {
            fourpc_busy = false;
            fourpc_drain();
            // Tetrarch is the ONE engine with nothing bundled behind it -- every other entry in the
            // dropdown either ships as WASM or degrades to one. So "host not found" here almost
            // always means it was never installed, and "Engine error" sent people looking for a bug
            // instead of the installer. Say what to do.
            update_best_move(native_host_missing(e)
                ? i18n('panel.tetrarch_setup', 'Tetrarch is not installed yet — see the README section '
                       + '"Four-player chess" for macOS, Linux and Windows setup')
                : i18n('panel.engine_error', 'Engine error'));
            console.warn('Mephisto: 4PC analyse failed', e);
        });
}

// Did this failure mean "the native host is not installed"? The worker phrases a missing host as
// "<label> native host unavailable (Specified native messaging host ... not found.)", and a port that
// dies before the first reply comes through as a closed port. Neither is distinguishable from a
// crashed host, which is fine: both answers are "run the installer".
function native_host_missing(e) {
    return /not found|unavailable|port closed|no such file/i.test(String((e && e.message) || e || ''));
}

// PUZZLE MODE PACING, and the rule that matters most: DO NOT MOVE TWICE INTO THE SAME POSITION.
//
// After our move the puzzle scripts the opponent's reply, and until that reply lands the board still
// shows the position we just moved from. A second move issued into it answers a question already
// answered -- on a graded puzzle that is a wrong answer, not a no-op. So the board CHANGING is the
// proof that the opponent moved, and it is the only proof accepted here. No time window: a timeout
// would just make the mistake take longer to arrive.
//
// Two independent flags, because they mean different things and conflating them broke this once:
//   paused  -- this call has already waited out the pre-move pause (the database path had its own)
//   checked -- this call has already passed the guard; the delayed continuation must not re-run it
//              and find the record it wrote itself.
// `retry` is the one legitimate repeat: watch_puzzle_move re-issues into an unchanged board because
// the puzzle click path is unverified and the first click may simply have missed.
let puzzle_last_sent = {key: null, at: 0};

function request_automove(move, think = null, manual = false, opts = {}) {
    if (config.puzzle_mode && !manual) {
        if (!opts.checked) {
            const key = puzzle_key(last_eval.fen || '');
            if (key && key === puzzle_last_sent.key && !opts.retry) {
                console.log('Puzzle: already moved from this position -- waiting for the reply');
                return;
            }
            puzzle_last_sent = {key, at: Date.now()};
        }
        if (!opts.paused) {
            clearTimeout(puzzle_move_timer);
            puzzle_move_timer = setTimeout(
                () => request_automove(move, think, manual, {...opts, paused: true, checked: true}),
                PUZZLE_MOVE_DELAY_MS);
            return;
        }
    }
    bgTrace('request_automove', {move, think, puzzle: config.puzzle_mode});
    // Is this a REAL move on our own turn, or a BLIND premove during the opponent's turn? The site
    // queues a blind premove (it won't appear in the move list until they move), so it must NOT be
    // verified/retried; an on-turn move must be. The popup is authoritative here -- decide from the
    // position's side-to-move (== our colour) rather than letting the content-script re-derive the
    // turn from fragile DOM highlights (which throws on e.g. the lichess analysis board, silently
    // skipping verification). last_eval.fen is the current position (on_new_pos ran before this).
    // Is this a REAL move on our own turn, or a BLIND premove during the opponent's turn? The site
    // queues a blind premove (it won't appear in the move list until they move), so it must NOT be
    // verified/retried; an on-turn move must be. The popup is authoritative here -- decide from the
    // position's side-to-move (== our colour) rather than letting the content-script re-derive the
    // turn from fragile DOM highlights (which throws on e.g. the lichess analysis board, silently
    // skipping verification). last_eval.fen is the current position (on_new_pos ran before this).
    const our = (our_side() === 'white') ? 'w' : 'b';
    const verify = (last_eval.fen?.split(' ')[1] === our);
    const deselect = safe_deselect_square(last_eval.fen, move);
    // Read the think/move timing FRESH from storage on every move (the options page shares this
    // localStorage), so editing the sliders mid-game applies to the next move -- not the snapshot
    // taken when the panel/config first loaded. `?? config.x` keeps the loaded value if unset.
    const timing = fresh_timing();
    const message = (config.puzzle_mode)
        // Puzzle Mode ships the move as a one-element `pv` purely because the content-script's
        // puzzle branch takes that shape. It is ONE move: Puzzle Mode used to auto-play the engine's
        // whole line without going back to the engine, and every move after the first was the tail of
        // a single short search -- unsearched moves that threw away won puzzles. Every move it plays
        // is now a move it actually searched.
        ? {automove: true, pv: [move], deselect, verify, timing, manual}
        : {automove: true, move: move, deselect, verify, think, timing, manual};
    send_to_active_tab(message);
}

// Queue two forced premoves back-to-back in ONE click session. Both are blind (opponent to move), so
// verify=false; they must ship in a single message because the content-script's `moving` guard drops a
// second automove that arrives while the first is still clicking.
function request_double_premove(moves) {
    send_to_active_tab({automove: true, premoves: moves, deselect: null, verify: false,
        timing: fresh_timing(), manual: false});
}

function request_console_log(message) {
    send_to_active_tab({consoleMessage: message});
}

function request_draw_hint(arrows) {
    send_to_active_tab({drawHint: true, arrows: arrows});
}

function request_clear_hint() {
    send_to_active_tab({clearHint: true});
}

// One white-share value per ply of the current game, for the history strip beside the eval bar.
// Indexed by ply so the constant re-analysis of a single position overwrites its own slot instead of
// appending -- without that the strip would grow by a band per engine info line.
let eval_history = [];
let eval_history_game = null; // the startFen this history belongs to; a new game resets it

// --- Game phases (lichess's Divider, ported) ----------------------------------------------------
// Opening / middlegame / endgame boundaries for the eval graph, computed exactly the way lichess
// does it so the dividers land where a lichess user expects. Ported from scalachess Divider.scala:
//
//   midgame = first position where  majorsAndMinors <= 10  OR  backrankSparse  OR  mixedness > 150
//   endgame = first position where  majorsAndMinors <= 6   (only looked for once a midgame exists)
//   the midgame marker is dropped if it does not actually precede the endgame one
//
// `mixedness` sums a positional score over the 49 overlapping 2x2 regions of the board (a 7x7 grid
// of them). Worth stating because the obvious reading is 3x3: the source builds them from the
// bitboard constant 0x0303, which is a 2x2 block, and the score table below bottoms out at 4 pieces
// per region -- which only makes sense for 4 squares.
const PHASE_MIXEDNESS_THRESHOLD = 150;
const PHASE_MIDGAME_PIECES = 10;
const PHASE_ENDGAME_PIECES = 6;

// score(y, white, black) verbatim from Divider.scala. y is the region's rank index, 1..7.
function phase_region_score(y, white, black) {
    switch (white) {
        case 0: switch (black) {
            case 1: return 1 + y;
            case 2: return y < 6 ? 2 + (6 - y) : 0;
            case 3: return y < 7 ? 3 + (7 - y) : 0;
            case 4: return y < 7 ? 3 + (7 - y) : 0;
            default: return 0;
        }
        case 1: switch (black) {
            case 0: return 1 + (8 - y);
            case 1: return 5 + Math.abs(4 - y);
            case 2: return 4 + (7 - y);
            case 3: return 5 + (7 - y);
            default: return 0;
        }
        case 2: switch (black) {
            case 0: return y > 2 ? 2 + (y - 2) : 0;
            case 1: return 4 + (y - 1);
            case 2: return 7;
            default: return 0;
        }
        case 3: switch (black) {
            case 0: return y > 1 ? 3 + (y - 1) : 0;
            case 1: return 5 + (y - 1);
            default: return 0;
        }
        case 4: return black === 0 ? (y > 1 ? 3 + (y - 1) : 0) : 0;
        default: return 0;
    }
}

const SQ_FILES = 'abcdefgh';

// one snapshot's three inputs, read off a chess.js position
function phase_metrics(c) {
    let majorsMinors = 0, whiteFirstRank = 0, blackLastRank = 0;
    const grid = []; // [file][rank] -> 'w' | 'b' | null, so the region scan is cheap
    for (let f = 0; f < 8; f++) {
        grid[f] = [];
        for (let r = 0; r < 8; r++) {
            const p = c.get(SQ_FILES[f] + (r + 1));
            grid[f][r] = p ? p.color : null;
            if (!p) continue;
            if (p.type !== 'k' && p.type !== 'p') majorsMinors++;
            if (r === 0 && p.color === 'w') whiteFirstRank++;
            if (r === 7 && p.color === 'b') blackLastRank++;
        }
    }
    let mixedness = 0;
    for (let ry = 0; ry <= 6; ry++) {
        for (let rx = 0; rx <= 6; rx++) {
            let w = 0, b = 0;
            for (let dx = 0; dx < 2; dx++) {
                for (let dy = 0; dy < 2; dy++) {
                    const col = grid[rx + dx][ry + dy];
                    if (col === 'w') w++; else if (col === 'b') b++;
                }
            }
            mixedness += phase_region_score(ry + 1, w, b);
        }
    }
    return {majorsMinors, backrankSparse: whiteFirstRank < 4 || blackLastRank < 4, mixedness};
}

let phase_cache = {key: null, value: {mid: null, end: null}};

// {mid, end} as ply indices into the eval history, either possibly null.
function game_phases(startFen, movesStr) {
    const key = `${startFen}|${movesStr}`;
    if (phase_cache.key === key) return phase_cache.value;
    const out = {mid: null, end: null};
    try {
        const c = new Chess(config.variant, startFen || undefined);
        const moves = (movesStr || '').trim().split(/\s+/).filter(Boolean);
        for (let i = 0; i <= moves.length; i++) {
            if (i > 0) {
                const m = moves[i - 1];
                c.move({from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4]});
            }
            const {majorsMinors, backrankSparse, mixedness} = phase_metrics(c);
            if (out.mid === null
                && (majorsMinors <= PHASE_MIDGAME_PIECES || backrankSparse
                    || mixedness > PHASE_MIXEDNESS_THRESHOLD)) {
                out.mid = i;
            }
            // lichess only starts looking for the endgame once a midgame was found
            if (out.mid !== null && out.end === null && majorsMinors <= PHASE_ENDGAME_PIECES) {
                out.end = i;
            }
        }
        // a midgame marker that doesn't precede the endgame one is dropped, as in Divider.apply
        if (out.mid !== null && out.end !== null && !(out.mid < out.end)) out.mid = null;
    } catch (e) {
        return {mid: null, end: null}; // variant fen chess.js can't replay -- no dividers, no error
    }
    phase_cache = {key, value: out};
    return out;
}

function record_eval_history(frac) {
    if (!config.eval_history || typeof frac !== 'number') return;
    // premove_tracker is the one place the CURRENT position's startFen + move list are kept
    // (on_new_pos sets it unconditionally, whether or not Premove is on). last_eval carries neither.
    const startFen = premove_tracker.startFen || '';
    if (eval_history_game !== startFen) { eval_history_game = startFen; eval_history = []; }
    const moves = premove_tracker.moves || '';
    const ply = moves ? moves.trim().split(/\s+/).filter(Boolean).length : 0;
    if (ply > 512) return;                        // absurd move list -- don't grow without bound
    while (eval_history.length < ply) eval_history.push(eval_history[eval_history.length - 1] ?? 0.5);
    eval_history[ply] = frac;
    if (eval_history.length > ply + 1) eval_history.length = ply + 1; // a takeback truncates
}

function request_draw_eval_bar(data) {
    send_to_active_tab({drawEvalBar: true, ...data});
}

function request_clear_eval_bar() {
    send_to_active_tab({clearEvalBar: true});
}

// Board turn badge: driven by the panel's authoritative side-to-move (the parsed FEN's turn field),
// NOT the raw scrape -- so it shows the same side the engine is actually analysing. Always on while
// a position is detected (no config gate); cleared when detection is lost or the panel closes.
function update_turn_badge(fen) {
    const t = (typeof fen === 'string') ? fen.split(' ')[1] : null;
    if (t === 'w' || t === 'b') set_turn_switch(t); // header king switch (the on-board pill was removed)
}

// Reflect the current side to move on the header king-switch (thumb left = White, right = Black).
function set_turn_switch(turn) {
    const el = PANEL_ROOT.getElementById('qs_turn_switch');
    if (!el) return;
    const black = turn === 'b';
    el.classList.toggle('black', black);
    const thumb = el.querySelector('.turn-thumb');
    if (thumb) thumb.innerHTML = black ? '&#9818;' : '&#9812;'; // ♚ / ♔
    const side = PANEL_ROOT.getElementById('qs_turn_side');
    if (side) {
        side.textContent = black
            ? i18n('panel.black_to_move', 'Black to move')
            : i18n('panel.white_to_move', 'White to move');
    }
}


// ask the content-script to read the variant off the current game page; cb(variant | null)
function request_detect_variant(cb) {
    if (IS_CONTENT_SCRIPT) { // same realm -> ask content-script.js straight out
        try {
            const r = self.MephistoContent?.detectVariant();
            return cb((r && r.variant) || null, (r && r.href) || null);
        } catch (e) { return cb(null, null); }
    }
    const ask = tabId => chrome.tabs.sendMessage(tabId, {detectVariant: true}, resp => {
        if (chrome.runtime.lastError) return cb(null, null);
        cb((resp && resp.variant) || null, (resp && resp.href) || null);
    });
    if (MY_TAB_ID) return ask(MY_TAB_ID);
    chrome.tabs.query({active: true, currentWindow: true}, tabs => (tabs[0] && tabs[0].id) && ask(tabs[0].id));
}

// fairy-only variants -- everything a mainline engine can't play. Chess960 is NOT here (mainline
// Stockfish plays it via UCI_Chess960), so detecting it must not force the Fairy engine.
function needs_fairy_engine(v) {
    return v && v !== 'chess' && v !== 'fischerandom';
}

// Is a native host actually installed? Open a throwaway port to it and `ping` (the host answers that
// WITHOUT launching the engine); any reply means installed, a 'fatal'/disconnect means not. ~1s cap.
function native_host_available(portName) {
    return new Promise(resolve => {
        let done = false, port;
        const finish = (ok) => { if (done) return; done = true; try { port.disconnect(); } catch (e) { /* */ } resolve(ok); };
        try { port = chrome.runtime.connect({name: portName}); } catch (e) { return resolve(false); }
        port.onMessage.addListener(frame => finish(!frame.fatal)); // a non-fatal frame = the host answered
        port.onDisconnect.addListener(() => finish(false));
        try { port.postMessage({id: -1, cmd: 'ping'}); } catch (e) { return finish(false); }
        setTimeout(() => finish(false), 1000);
    });
}

// Which Fairy engine to switch to on variant detect: the LOCAL (native) full-power Fairy whenever its
// host is installed (probed directly, so it's preferred even from a WASM engine), else the bundled
// WASM Fairy so variant detection still works with zero setup.
async function preferred_fairy_engine() {
    return (await native_host_available('fairy-native')) ? 'fairy-native' : 'fairy-stockfish-14-nnue';
}

// apply a detected variant: set it AND switch to the Fairy engine when the variant requires it.
// Without the engine switch, detection was a no-op on a mainline Stockfish -- the variant was saved
// but the engine analysed the board as standard chess.
async function apply_detected_variant(v) {
    MephistoConfig.set('variant', JSON.stringify(v));
    // switch to Fairy only if not already on one (native or WASM) -- don't downgrade native->WASM
    if (needs_fairy_engine(v) && !FAIRY_ENGINES.includes(config.engine)) {
        MephistoConfig.set('engine', JSON.stringify(await preferred_fairy_engine()));
    }
    panel_reload();
}

// Auto-detect the variant on a chess.com / lichess variant GAME page so it just works -- apply the
// detected variant (switching to Fairy when needed) without the user picking engine + variant by
// hand. Runs at most once per game URL (sessionStorage guard) so a manual change afterwards is
// respected and there's no reload loop.
function maybe_autodetect_variant() {
    request_detect_variant((v, href) => {
        if (!v || !href) return;
        // only AUTO-apply where detection is URL-definitive: chess.com /variants/ game pages. The
        // lichess detector is DOM-heuristic and could false-positive on a standard game, so lichess
        // stays on the explicit Detect button (which now switches to Fairy too).
        if (!/\/variants\//.test(href)) return;
        // already correct: right variant AND (no Fairy needed, or already on some Fairy engine).
        // (Which Fairy engine — native vs WASM — is resolved by an async probe inside apply.)
        if (config.variant === v && (!needs_fairy_engine(v) || FAIRY_ENGINES.includes(config.engine))) return;
        const key = 'mephisto.autodetected:' + href;
        try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* */ }
        console.log('Mephisto: auto-detected variant', v, '-> applying (was', config.variant + '/' + config.engine + ')');
        apply_detected_variant(v);
    });
}

// Options-page changes reaching a LIVE panel.
//
// MephistoConfig keeps its own cache fresh via chrome.storage.onChanged, but `config` here is a
// SNAPSHOT taken once at init, and push_config() ships that snapshot to the content script. So a
// setting flipped on the options page updated storage, and nothing else: the panel kept its old
// value and the content script kept being told the old value. Background Play was the visible
// casualty -- you turned it on and moves carried on deferring -- but every options-page setting had
// it, including Endgame Tablebase and Search Time.
//
// Only settings that are safe to change mid-session are applied. Engine, variant, threads and memory
// need a full engine re-init, which is a panel rebuild; those are deliberately left to the existing
// reload path rather than half-applied under a running search.
const LIVE_CONFIG_KEYS = [
    'autoplay', 'premove', 'ponder', 'tablebase', 'background_play', 'hide_opponent',
    'explorer', 'book_play', 'explorer_db', 'help_mode', 'humanize', 'clock_mode', 'mirror_mode',
    'manual_mode', 'eval_bar', 'eval_history', 'puzzle_mode', 'simon_says_mode', 'threat_analysis',
    'computer_evaluation', 'multiple_lines', 'compute_time', 'move_time', 'move_variance', 'move_reason',
    'think_time', 'think_variance', 'elo', 'opp_alert', 'dark_mode',
];

function watch_config_changes() {
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !PANEL_BOOTED) return;
            let touched = false;
            for (const key of LIVE_CONFIG_KEYS) {
                if (!(key in changes)) continue;
                let value;
                try { value = JSON.parse(changes[key].newValue); } catch (e) { continue; }
                if (value === undefined || value === config[key]) continue;
                config[key] = value;
                touched = true;
                if (key === 'help_mode' && !value) request_clear_hint();
                if (key === 'eval_bar' && !value) request_clear_eval_bar();
                if (key === 'eval_history') request_clear_eval_bar(); // redrawn by the next eval
                if (key === 'tablebase') tablebase_data = null;       // a stale answer must not survive
                if (key === 'language') load_language(value).then(apply_language);
                // these change the go mode / search budget -- restart under the new setting
                if (['help_mode', 'autoplay', 'clock_mode', 'mirror_mode', 'manual_mode'].includes(key)) {
                    abandon_search();
                    last_eval.fen = '';
                }
            }
            if (!touched) return;
            sync_quick_settings();       // the panel's own switches must show the new state
            keep_alive(keep_alive_wanted(), false); // resume-only: no gesture here
            push_config();               // and the content script has to be told, or nothing changes
        });
    } catch (e) { /* no chrome.storage here -> options changes need a panel reload, as before */ }
}

// Mirror `config` back onto the quick-settings switches, so a change made on the options page shows
// up on the panel instead of leaving the two disagreeing about what is on.
function sync_quick_settings() {
    for (const key in HOTKEY_TOGGLES) {
        const box = PANEL_ROOT.getElementById(HOTKEY_TOGGLES[key]);
        if (box && typeof config[key] === 'boolean' && box.checked !== config[key]) {
            box.checked = config[key];
        }
    }
    for (const [id, key] of [['qs_search', 'compute_time'], ['qs_move', 'move_time'],
                             ['qs_move_var', 'move_variance']]) {
        const el = PANEL_ROOT.getElementById(id);
        if (el && String(el.value) !== String(config[key])) el.value = config[key];
    }
    mark_autoplay_overridden();
}

// Autoplay can be ON and still never play: on_engine_best_move refuses when Help Mode or Manual
// Mode is set, which is correct -- both mean "I will make the move myself". That used to be obvious
// with all the switches in one flat column. They live on separate tabs now, so an armed-looking
// Autoplay can sit beside a Help Mode you cannot see. Say so on the Autoplay row itself.
function mark_autoplay_overridden() {
    const row = PANEL_ROOT.getElementById('qs_autoplay')?.closest('.qs-toggle');
    if (!row) return;
    const by = config.help_mode ? 'Help Mode' : config.manual_mode ? 'Manual Mode' : null;
    row.classList.toggle('qs-overridden', !!(config.autoplay && by));
    row.title = by && config.autoplay
        ? `Autoplay is on but ${by} is playing the move instead — turn ${by} off to autoplay`
        : '';
}

function push_config() {
    send_to_active_tab({pushConfig: true, config: config});
}

function draw_moves() {
    // A known puzzle solution replaces the engine's arrow entirely -- and it is the only arrow there
    // is, since a database hit skips the search, so last_eval.lines is empty and the loop below would
    // draw nothing at all. Not gated on Autoplay the way playing the move is: Help Mode wants to be
    // SHOWN the answer, which is exactly when an arrow is the whole point.
    const solution = puzzle_pick(last_eval.fen);
    if (solution) {
        clear_annotations();
        draw_move(solution, line_color(0), PANEL_ROOT.getElementById('move-annotations'), 0.25);
        if (config.help_mode) {
            engine_hint_arrows = [{move: solution, width: 0.25, color: line_color(0)}];
            push_hint_arrows();
        }
        return;
    }
    if (last_eval.lines[0] == null) return;

    function strokeFunc(line) {
        const MATE_SCORE = 20;
        const WINNING_THRESHOLD = 4;
        const MAX_STROKE = 0.225, MIN_STROKE = 0.075;
        const STROKE_SHIM = 0.0125;

        const top_line = last_eval.lines[0];
        const top_score = (turn === 'w' ? 1 : -1) * top_line.score / 100;
        const score = (turn === 'w' ? 1 : -1) * line.score / 100;
        if (top_line.move === line.move) { // is best move?
            console.log(`0 => ${MAX_STROKE + 2 * STROKE_SHIM}`);
            return MAX_STROKE + 2 * STROKE_SHIM; // accentuate the best move
        } else if (isNaN(top_score) || top_score >= WINNING_THRESHOLD) { // is winning?
            if (isNaN(score)) {
                console.log(`winning: #${line.mate} => ${MAX_STROKE - STROKE_SHIM}`);
                return MAX_STROKE - STROKE_SHIM; // moves that checkmate are necessarily good
            } else if (score < WINNING_THRESHOLD) {
                console.log(`winning: ${score} => losing`);
                return 0; // hide moves that are not winning
            } else {
                const delta = (isNaN(top_score) ? MATE_SCORE : top_score) - score;
                console.log(`winning: ${score} => ok ${delta}`);
                if (delta <= 0) {
                    return MAX_STROKE - 2 * STROKE_SHIM; // moves that are still winning are good
                } else {
                    const stroke = MAX_STROKE - 2 * STROKE_SHIM - delta / 150;
                    return Math.min(MAX_STROKE, Math.max(MIN_STROKE, stroke));
                }
            }
        } else { // is roughly equal?
            const delta = top_score - score;
            if (isNaN(score) || delta >= WINNING_THRESHOLD) {
                console.log(`${delta} => 0`);
                return 0; // hide moves that are too losing or get us checkmated
            } else {
                const stroke = MAX_STROKE - delta / 15;
                console.log(`${delta} => ${stroke}`);
                return Math.min(MAX_STROKE, Math.max(MIN_STROKE, stroke))
            }
        }
    }

    clear_annotations();
    const hint_arrows = []; // help mode mirrors the popup's arrows onto the site's board
    for (let i = 0; i < last_eval.activeLines; i++) {
        if (!last_eval.lines[i]) continue;

        const arrow_color = line_color(i); // per-rank colour (was blue for #1, grey for all the rest)
        const stroke_width = strokeFunc(last_eval.lines[i]);
        draw_move(last_eval.lines[i].move, arrow_color, PANEL_ROOT.getElementById('move-annotations'), stroke_width);
        if (config.help_mode && stroke_width > 0 && last_eval.lines[i].move) {
            hint_arrows.push({move: last_eval.lines[i].move, width: stroke_width, color: arrow_color});
        }
    }
    if (config.help_mode) {
        if (config.threat_analysis && last_eval.threat && last_eval.threat !== '(none)') {
            hint_arrows.push({move: last_eval.threat, width: 0.2, color: '#bf0000'});
        }
        engine_hint_arrows = hint_arrows;
        push_hint_arrows(); // engine arrows + the book, in one replace
    }
}

// Book arrows, in their own layer so they COEXIST with the engine's: draw_moves() clears
// move+response on every depth update, and anything drawn there would flicker away with it.
// One colour (the panel's teal accent, distinct from the five LINE_COLORS and the red threat) with
// the width carrying popularity -- so the main line reads as the main line at a glance.
// One colour per book move, like the engine's per-rank line colours -- all five chosen to clash with
// neither LINE_COLORS nor the red threat arrow, so a book arrow is never mistaken for an engine line.
const BOOK_COLORS = ['#14b8a6', '#ec4899', '#22d3ee', '#a3e635', '#fb7185'];

let engine_hint_arrows = []; // last set draw_moves built, kept so a late book lookup can re-send both

// Book arrows as {move,width,color}. ONE builder for both boards so the panel and the site board can
// never drift apart. Offered whenever a lookup ran for THIS position -- so Help Mode shows the book
// whether you switched on the overlay or Book Moves.
function book_arrow_specs(fen) {
    const at = fen || last_eval.fen;
    if (explorer_data?.fen !== at) return [];
    const top = explorer_data.moves.slice(0, 5);
    const most = Math.max(...top.map(m => (m.white || 0) + (m.draws || 0) + (m.black || 0)), 1);
    return top.map((m, i) => ({
        move: m.uci,
        // the least-played stays a real arrow; the main line matches the engine's best-move stroke
        width: 0.13 + 0.13 * (((m.white || 0) + (m.draws || 0) + (m.black || 0)) / most),
        color: BOOK_COLORS[Math.min(i, BOOK_COLORS.length - 1)],
    }));
}

// Help Mode draws onto the SITE's board. request_draw_hint REPLACES the whole set, so the engine's
// arrows and the book's must go in a SINGLE call -- sending them separately would make whichever
// landed last erase the other, and the book lookup always lands after the first engine depth.
function push_hint_arrows() {
    if (!config.help_mode) return;
    request_draw_hint([...engine_hint_arrows, ...book_arrow_specs()]);
}

function clear_book_annotations() {
    const layer = PANEL_ROOT.getElementById('book-annotations');
    while (layer?.childElementCount) layer.lastElementChild.remove();
    return layer;
}

function draw_book_moves(fen) {
    push_hint_arrows(); // Help Mode: re-send the site-board set now the book is known
    const layer = clear_book_annotations();
    if (!layer || !config.explorer) return;
    // Draw only for the position actually on the board. The caller passes it explicitly: during
    // on_new_pos, last_eval still describes the PREVIOUS position (it isn't reassigned until the very
    // end), so comparing against it there matched the old fen and painted the previous position's
    // book onto the new one -- which is why the arrows went wrong the moment a move was played.
    const at = fen || last_eval.fen;
    if (explorer_data?.fen !== at) return;
    for (const a of book_arrow_specs(at)) draw_move(a.move, a.color, layer, a.width);
}

function draw_threat() {
    if (last_eval.threat) {
        draw_move(last_eval.threat, '#bf0000', PANEL_ROOT.getElementById('response-annotations'));
    }
}

function draw_move(move, color, overlay, stroke_width = 0.225) {
    if (!move || move === '(none)') {
        overlay.lastElementChild?.remove();
        return; // hide overlay on win/loss
    } else if (stroke_width === 0) {
        return; // hide losing moves
    }

    function get_coord(square) {
        const x = square[0].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
        const y = parseInt(square[1]);
        return (board.orientation() === 'white') ? {x, y} : {x: 9 - x, y: 9 - y};
    }

    function get_coords(move) {
        const {x: x0, y: y0} = get_coord(move.substring(0, 2));
        const {x: x1, y: y1} = get_coord(move.substring(2, 4));
        return {x0, y0, x1, y1}
    }

    if (move.includes('@')) {
        const coord = get_coord(move.substring(2, 4));
        const x = 0.5 + (coord.x - 1);
        const y = 8 - (0.5 + (coord.y - 1));
        const imgX = 43 * (coord.x - 1);
        const imgY = 43 * (8 - coord.y);

        const MAX_STROKE = 0.25;
        stroke_width = 0.1 * stroke_width / MAX_STROKE;
        const stroke_diff = (MAX_STROKE - stroke_width) / 10;
        console.log("STROKE_DIFF:", MAX_STROKE, "-", stroke_width, "=", stroke_diff);

        const pieceIdentifier = turn + move[0];
        const [pieceSet, ext] = config.pieces.split('.');
        const piecePath = `/res/chesspieces/${pieceSet}/${pieceIdentifier}.${ext}`
        overlay.innerHTML += `
            <img style='position: absolute; z-index: -1; left: ${imgX}px; top: ${imgY}px; opacity: 0.4;' width='43px'
                height='43px' src='${piecePath}' alt='${pieceIdentifier}'>
            <svg style='position: absolute; z-index: -1; left: 0; top: 0;' width='344px' height='344px' viewBox='0, 0, 8, 8'>
                <circle cx='${x}' cy='${y}' r='${0.45 + stroke_diff}' fill='transparent' opacity='0.4' stroke='${color}' stroke-width='${stroke_width}' />
            </svg>
        `;
    } else {
        const coords = get_coords(move);
        const x0 = 0.5 + (coords.x0 - 1);
        const y0 = 8 - (0.5 + (coords.y0 - 1));
        const x1 = 0.5 + (coords.x1 - 1);
        const y1 = 8 - (0.5 + (coords.y1 - 1));

        const dx = x1 - x0;
        const dy = y1 - y0;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ax0 = x0 + 0.1 * ((x1 - x0) / d);
        const ay0 = y0 + 0.1 * (dy / d);
        const ax1 = x1 - 0.4 * ((x1 - x0) / d);
        const ay1 = y1 - 0.4 * (dy / d);

        const marker_id = color.replace(/[ ,()]/g, '-');
        overlay.innerHTML += `
            <svg style='position: absolute; z-index: -1; left: 0; top: 0;' width='344px' height='344px' viewBox='0, 0, 8, 8'>
                <defs>
                    <marker id='arrow-${marker_id}' markerWidth='13' markerHeight='13' refX='1' refY='7' orient='auto'>
                        <path d='M1,5.75 L3,7 L1,8.25' fill='${color}' />
                    </marker>
                </defs>
                <line x1='${ax0}' y1='${ay0}' x2='${ax1}' y2='${ay1}' stroke='${color}' fill=${color}' opacity='0.4'
                    stroke-width='${stroke_width}' marker-end='url(#arrow-${marker_id})'/>
            </svg>
        `;

        if (move.length === 5) {
            const imgX = 43 * (coords.x1 - 1);
            const imgY = 43 * (8 - coords.y1);
            const pieceIdentifier = turn + move[4];
            const [pieceSet, ext] = config.pieces.split('.');
            const piecePath = `/res/chesspieces/${pieceSet}/${pieceIdentifier}.${ext}`;
            overlay.innerHTML += `
                <img style='position: absolute; z-index: -1; left: ${imgX}px; top: ${imgY}px; opacity: 0.4;' width='43px'
                    height='43px' src='${piecePath}' alt='${pieceIdentifier}'>
            `;
        }
    }
}

function clear_annotations() {
    let move_annotation = PANEL_ROOT.getElementById('move-annotations');
    while (move_annotation.childElementCount) {
        move_annotation.lastElementChild.remove();
    }
    let response_annotation = PANEL_ROOT.getElementById('response-annotations');
    while (response_annotation.childElementCount) {
        response_annotation.lastElementChild.remove();
    }
}

function toggle_calculating(on) {
    prog = 0;
    is_calculating = on;
    if (is_calculating) {
        // Depth-1 streams in a few ms and replaces this line with the real eval + move (see the
        // `info depth` branch: `on_engine_best_move(arr[0], arr[1]); on_engine_evaluation(...)`).
        // Show ONLY the progress bar in the gap -- the old "Calculating..." placeholder made the
        // panel look frozen for a moment when in fact it was already searching. Anything remembered
        // from the previous position is stale, so we clear the text rather than leave it there.
        update_best_move(`<progress id='progBar' value='2' max='100'>`);
    }
}

async function dispatch_click_event(x, y, tabId, travelMs) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        // NaN/undefined coords (e.g. a crazyhouse drop move) serialize badly and the debugger rejects them
        console.warn(`Ignoring click with invalid coordinates: (${x}, ${y})`);
        return;
    }
    if (config.python_autoplay_backend) {
        await request_backend_click(x, y); // the python clicker moves the real mouse itself
    } else {
        await request_debugger_click(x, y, tabId, travelMs);
    }
}

function resolve_click_tab(tabId) {
    // prefer the game tab (content-script sender); fall back to the active tab if unknown
    if (tabId) return Promise.resolve(tabId);
    if (MY_TAB_ID) return Promise.resolve(MY_TAB_ID);
    if (IS_CONTENT_SCRIPT) return Promise.resolve(null); // chrome.tabs doesn't exist here
    return new Promise(res => chrome.tabs.query({active: true, currentWindow: true}, t => res(t[0]?.id)));
}

async function request_debugger_click(x, y, tabId, travelMs) {
    // chrome.debugger is NOT available to a content script (which is what this file is once the panel
    // lives in-page), so the background owns the attach + Input.dispatchMouseEvent. Still a TRUSTED
    // click -- isTrusted can't tell it from a human one (issue #35 §2). The background traces a
    // mouseMoved cursor path over travelMs before the click (M2); awaiting it paces the move.
    const id = await resolve_click_tab(tabId);
    if (!id) { console.warn('[Mephisto/bg] click dropped: no tab id resolved'); return; }
    // A click MUST settle. The caller awaits it inside the move sequence, and that sequence is what
    // clears the content-script's `moving` guard when it finishes -- so a round-trip that never
    // returns wedges every subsequent move until the 15s stale-latch budget expires. In a hidden tab
    // that is the difference between playing and stopping. Resolve either way and let the move's own
    // verification decide whether it worked; a click we cannot confirm is not worse than no click.
    const settled = await Promise.race([
        do_debugger_click(id, x, y, travelMs).then(() => 'ok'),
        new Promise((r) => setTimeout(() => r('timeout'), CLICK_TIMEOUT_MS)),
    ]);
    if (settled === 'timeout') {
        bgTrace('click TIMED OUT', {x: Math.round(x), y: Math.round(y), ms: CLICK_TIMEOUT_MS});
        console.warn('Mephisto: CDP click did not return in time -- continuing');
    }
}

// How long a single click round-trip may take before the move gives up waiting on it. Generous
// against a woken service worker, far below the stale-`moving` budget it exists to keep us out of.
const CLICK_TIMEOUT_MS = 3000;

async function do_debugger_click(id, x, y, travelMs) {
    if (document.hidden) console.log('[Mephisto/bg] CDP click ->', {tab: id, x: Math.round(x), y: Math.round(y)});
    try {
        const r = await chrome.runtime.sendMessage({cdpClick: true, tabId: id, x, y, travelMs});
        if (r && r.error) console.warn('CDP click failed:', r.error);
    } catch (e) {
        console.warn('CDP click failed:', e);
    }
}


async function request_backend_click(x, y) {
    return call_backend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function request_backend_move(x0, y0, x1, y1) {
    return call_backend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

// Both the HTTP "Remote Engine" and the serverless native engines speak the same request/response
// shape and reuse the same on_engine_response remote branch.
// Compare the newest published release against the running build and, only if it is actually newer,
// reveal the notice. Everything here fails silent: no network, a rate-limited API, a malformed reply
// or a missing element all end with the notice staying hidden. Version compare is numeric per part,
// so 3.1.9 -> 3.1.10 reads as an upgrade (a string compare would call it a downgrade).
// --- Machine calibration ------------------------------------------------------------------------
// The shipped defaults (300ms search) are a number, not a measurement: the same 300ms is a shallow
// search on a laptop and a deep one on a 24-core desktop, so "the defaults" mean different playing
// strengths on different machines. Equal NODES is the thing that travels; equal milliseconds is not.
//
// So: measure the NPS this machine actually reaches during normal play -- no separate benchmark, the
// engine already reports nps on every info line -- and work out the search time that would hit a
// reference node count. Then SUGGEST it. Silently rewriting someone's setting because a heuristic
// had an opinion is exactly the kind of surprise the house rules exist to prevent, so this offers
// the number and applies it only on a click, and only ever offers once per install.
const CALIBRATION_TARGET_NODES = 1_500_000; // ~ what 300ms buys on the reference machine
const CALIBRATION_SAMPLES = 8;              // completed searches to median before saying anything
const CALIBRATION_MIN_MS = 200, CALIBRATION_MAX_MS = 2000;
let nps_samples = [];

function record_nps_sample(nps) {
    if (nps_samples === null) return;                 // already suggested (or dismissed) this install
    if (!Number.isFinite(nps) || nps <= 0) return;
    nps_samples.push(nps);
    if (nps_samples.length >= CALIBRATION_SAMPLES) maybe_suggest_calibration();
}

function suggested_compute_time(npsMedian) {
    const ms = Math.round((CALIBRATION_TARGET_NODES / npsMedian) * 1000);
    return Math.max(CALIBRATION_MIN_MS, Math.min(CALIBRATION_MAX_MS, Math.round(ms / 50) * 50));
}

function maybe_suggest_calibration() {
    const samples = nps_samples;
    nps_samples = null;                               // one offer per install, whatever happens next
    try {
        // ONLY on a genuinely fresh install. The background sets this from chrome.runtime.onInstalled
        // with reason 'install'; a reload or an upgrade does not arm it. Without this the prompt
        // turned up mid-game on an install that had been running for months.
        if (MephistoConfig.get('calibrate_pending') !== 'true') return;
        if (MephistoConfig.get('calibrated') === 'true') return; // already answered
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const want = suggested_compute_time(median);
        // only worth mentioning if it is a real difference, not a rounding nudge.
        // NOTE the two shapes: `calibrate_pending` / `calibrated` are RAW strings -- that is how the
        // service worker writes the flag (background-script.js `{calibrate_pending: 'true'}`) and how
        // both guards above read it -- while every ordinary config key is JSON. `save` (JSON) is also
        // not in scope here: it is local to init_quick_settings, so calling it threw a ReferenceError
        // straight into the catch below and this notice has never once been shown.
        MephistoConfig.set('calibrate_pending', 'false'); // spent: offered once, taken or not
        if (Math.abs(want - config.compute_time) < Math.max(100, config.compute_time * 0.25)) return;
        const el = PANEL_ROOT.getElementById('calibrate-notice');
        if (!el) return;
        el.textContent = i18n('panel.calibrated', 'This machine measures {nps}M nps — ', {nps: (median / 1e6).toFixed(1)}) +
            `Search Time ${want}ms matches the reference strength (now ${config.compute_time}ms). Tap to apply.`;
        el.hidden = false;
        el.onclick = (e) => {
            e.preventDefault();
            config.compute_time = want;
            MephistoConfig.set('compute_time', JSON.stringify(want)); // ordinary config key -> JSON
            MephistoConfig.set('calibrated', 'true');                 // raw flag, read as === 'true'
            const box = PANEL_ROOT.getElementById('qs_search');
            if (box) box.value = want;
            el.hidden = true;
            push_config();
            console.log(`Mephisto: search time calibrated to ${want}ms from ${(median / 1e6).toFixed(2)}M nps`);
        };
    } catch (e) { /* a suggestion is a nicety -- never let it break the panel */ }
}

function check_for_update() {
    const el = PANEL_ROOT.getElementById('update-notice');
    if (!el) return;
    // AN INCOMPLETE INSTALL OUTRANKS AN AVAILABLE UPDATE. If the engines are missing there is no
    // point telling someone a newer version exists -- the build they have cannot run at all, and the
    // fix is the FULL archive rather than whatever is newest. Checked first, and it short-circuits.
    try {
        chrome.runtime.sendMessage({assetsCheck: true}, (res) => {
            if (chrome.runtime.lastError || !res || res.ok) return check_for_update_version(el);
            el.textContent = i18n('panel.incomplete_install',
                'Engines missing — you have the update-only download. Get the full zip.');
            el.href = 'https://github.com/IchNukeDichWeg/Mephisto/releases/latest';
            el.hidden = false;
            el.onclick = (e) => {
                e.preventDefault();
                chrome.runtime.sendMessage({openUrl: el.href});
            };
        });
    } catch (e) { /* extension context gone */ }
}

function check_for_update_version(el) {
    try {
        chrome.runtime.sendMessage({updateCheck: true}, (res) => {
            // the version compare lives in the SW (isNewer) -- one implementation, not two
            if (chrome.runtime.lastError || !res || res.error || !res.latest || !res.newer) return;
            el.textContent = i18n('panel.update_available', 'Update available — v{latest} (you have v{current})',
      {latest: res.latest, current: res.current});
            el.hidden = false;
            // Set the REAL destination on the anchor. Belt and braces: in the toolbar popup a plain
            // target="_blank" works on its own, and if the handler below ever fails to run, the link
            // still goes to the release rather than to whatever page the panel is sitting on.
            const url = res.url || 'https://github.com/IchNukeDichWeg/Mephisto/releases/latest';
            el.href = url;
            el.onclick = (e) => {
                e.preventDefault();   // in-page, target="_blank" is unreliable -- let the worker open it
                chrome.runtime.sendMessage({openUrl: url});
            };
        });
    } catch (e) { /* extension context gone -- nothing to notify about */ }
}

function is_remote() {
    // "remote" = anything that isn't an in-browser WASM engine: HTTP remote-engine.py, or a native
    // messaging host. The HTTP-vs-native split happens in request_remote_* below.
    return config.engine === 'remote' || uses_native();
}

// --- Native messaging over a persistent Port to the BACKGROUND worker (connectNative from a
// content script is torn down by Chrome). The Port lets the host STREAM per-depth 'info' frames
// (live depth like Stockfish), ending with a 'done' frame. Each request's onInfo gets the
// intermediate frames; the promise resolves on 'done'.
let native_bg_port = null;
let native_bg_port_name = null; // which engine that port was opened for
// Panel-local, and only ever panel-local: the service worker renumbers every request onto its own
// sequence before it reaches the shared host and renumbers the reply back on the way in. So two panels
// both counting from 1 is fine now -- which it was NOT before, when replies were broadcast and matched
// on this number at the far end, and each tab happily took the other's evaluation.
let native_seq = 0;
const native_pending = new Map(); // id -> {resolve, reject, onInfo}

// engines that speak native messaging (Chrome auto-launches the host, no server) and the port
// name that selects the host in the background worker (see NATIVE_HOSTS there)
function uses_native() {
    return NATIVE_ENGINES.includes(config.engine);
}
function native_port_name() {
    return config.engine; // sf-native / fairy-native == the host key in NATIVE_HOSTS
}

// Shut down whatever engine is running right now. Used when SELECTING a different engine: the
// offscreen WASM engine is disposed and the native host's port is closed (the background shuts the
// host down when its last port goes), so the engine you just left stops instead of idling loaded.
function stop_current_engine() {
    try { abandon_search(); } catch (e) { /* */ }
    try {
        chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'dispose'});
    } catch (e) { /* SW/offscreen already gone */ }
    if (native_bg_port) {
        try { native_bg_port.disconnect(); } catch (e) { /* */ }
        native_bg_port = null;
        native_bg_port_name = null;
    }
    engine_ready = false;
    last_init_fp = null; // never let a warm-reuse fingerprint match across an engine change
}

function native_bg() {
    // The port is per ENGINE. Switching engines re-opens the panel but does not reload this script,
    // so a cached port would still be wired to the engine you switched AWAY from -- the old host
    // kept running (burning cores on a stale search) and, worse, the new engine's requests went to
    // it. Drop the port whenever the selected engine no longer matches the one it was opened for;
    // the background kills a host once its last port closes.
    const want = native_port_name();
    if (native_bg_port && native_bg_port_name !== want) {
        try { native_bg_port.disconnect(); } catch (e) { /* already gone */ }
        native_bg_port = null;
        for (const pend of native_pending.values()) pend.reject(new Error('engine switched'));
        native_pending.clear();
    }
    if (native_bg_port) return native_bg_port;
    native_bg_port_name = want;
    native_bg_port = chrome.runtime.connect({name: want});
    native_bg_port.onMessage.addListener(frame => {
        if (frame.fatal) {
            for (const p of native_pending.values()) p.reject(new Error(frame.fatal));
            native_pending.clear();
            return;
        }
        const p = native_pending.get(frame.id);
        if (!p) return;
        if (frame.error) { native_pending.delete(frame.id); p.reject(new Error(`Native engine: ${frame.error}`)); return; }
        if (frame.info) { if (p.onInfo) p.onInfo(frame.info); return; } // streamed per-depth update
        native_pending.delete(frame.id); // terminal frame (analyse 'done', or configure 'ok')
        p.resolve(frame);
    });
    native_bg_port.onDisconnect.addListener(() => {
        native_bg_port = null;
        for (const p of native_pending.values()) p.reject(new Error('Native engine background port closed'));
        native_pending.clear();
    });
    return native_bg_port;
}

function native_send(cmd, data, onInfo) {
    const id = ++native_seq;
    return new Promise((resolve, reject) => {
        native_pending.set(id, {resolve, reject, onInfo});
        try {
            native_bg().postMessage({id, cmd, ...data});
        } catch (e) {
            native_pending.delete(id);
            reject(e);
        }
    });
}

// A streamed per-depth update from a native host (already in the panel's line shape). Mirrors the
// WASM `info depth` handling: refresh the eval/best-move display live AND feed premove_tracker.
// Bound to the fen it was requested for, so late frames from a superseded search are ignored.
function on_native_info(info, fen) {
    if (premove_tracker.fen !== fen) return; // stale: position already moved on
    const pvIdx = (info.multipv || 1) - 1;
    // Premove certification for the native engines: track how stable each line's reply is across
    // depths 13 / 14 / latest, exactly like the WASM `info depth` parser -- without this they'd
    // never premove, since certification is what the premove path waits on.
    // Bound by premove_lines rather than a hardcoded 2, to match the WASM parser and
    // premove_instant_reply (which scans idx < premove_lines). NOTE this is currently the SAME
    // number: the ponder width (ponder_line_count, up to 5) is applied in the WASM branch of
    // on_new_pos only -- the remote/native branch never reassigns premove_lines and never pushes a
    // per-position MultiPV, so on native engines Pondering does NOT widen the candidate list and
    // premove still certifies at most 2 lines. Widening it there needs a configure round-trip per
    // position; until that exists, this line is consistency, not a new capability.
    // `info.bound` marks an aspiration re-search: its pv is unresolved, so it must not reach the
    // depth-13/14 snapshots -- but it IS still displayed, which is why the host flags rather than
    // swallows it. Dropping them left the panel with no updates at all through those windows.
    if (config.premove && info.pv && info.pv[0] != null
            && !info.bound && pvIdx < premove_lines && Number.isInteger(info.depth)) {
        const pred = String(info.pv[0]), reply = (info.pv[1] != null) ? String(info.pv[1]) : '';
        const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
        if (info.depth === PREMOVE_DEPTH_PREV) line.dPrev = `${pred} ${reply}`;
        if (info.depth === PREMOVE_DEPTH_LAST) line.dLast = `${pred} ${reply}`;
        line.latest = `${pred} ${reply}`;
        line.pred = pred;
        line.reply = reply;
        line.depth = info.depth;
        if (pvIdx === 0) maybe_premove_forced_reply(line);
    }
    last_eval.activeLines = Math.max(last_eval.activeLines, info.multipv || 1);
    last_eval.lines[pvIdx] = info;
    if (pvIdx > 0 && !config.simon_says_mode) {
        render_alt_lines();
        draw_moves(); // same as the WASM path: without this only line 1 ever gets an arrow
    }
    if (pvIdx === 0) {
        on_engine_evaluation(last_eval);
        if (info.pv && info.pv[0]) {
            on_engine_best_move(info.pv[0], info.pv[1], false); // live arrow, non-terminal
        } else if (is_calculating) {
            // An info line with a score but NO pv (a dead-drawn or terminal position) left the
            // progress bar in the move line forever, so the panel looked like it was still loading
            // while the eval and depth were plainly updating. Say what's actually happening instead.
            is_calculating = false;
            update_best_move(Number.isInteger(info.depth)
        ? i18n('panel.msg.searching_depth', 'Searching (depth {depth})', {depth: info.depth})
        : i18n('panel.msg.searching', 'Searching'));
        }
    }
}

async function request_remote_configure(options) {
    if (uses_native()) return native_send('configure', {options});
    return call_backend('http://localhost:9090/configure', options).then(parse_backend_json);
}

async function request_remote_analysis(fen, time, moves = null) {
    if (uses_native()) {
        // guard streamed frames by the ACTUAL position (moves-mode passes startFen here, but
        // premove_tracker.fen holds the real current fen), so late frames don't leak across moves
        const posFen = premove_tracker.fen;
        return native_send('analyse', {fen, time, moves}, info => on_native_info(info, posFen));
    }
    return call_backend('http://localhost:9090/analyse', {
        fen: fen,
        moves: moves,
        time: time,
    }).then(parse_backend_json);
}

async function parse_backend_json(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        // an unrelated server on the port answers with HTML ("<!doctype ...") — surface that instead of a SyntaxError
        throw new Error(`Remote engine at ${res.url} did not return JSON — is remote-engine.py running on that port?`);
    }
}

function on_remote_error(err) {
    console.error(err);
    update_best_move(err.message);
    toggle_calculating(false);
}

async function call_backend(url, data) {
    return fetch(url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-cache',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
}

// the content-script calls this to boot the panel inside its closed shadow root
self.MephistoPanel = {
    initPanel,
    isBooted: () => PANEL_BOOTED,
    // the drag-select overlay (content-script) hands back a crop in image pixels; re-run the
    // recognise path with board detection skipped
    snapWithCrop: (crop) => { snap_position(crop).catch(e => console.warn('Mephisto: snap failed', e)); },
    // the floating panel's title bar owns the compact toggle; the panel owns the state
    toggleCompact: () => toggle_compact(),
    // the content-script's keydown listener dispatches hotkey actions here; returns whether it was
    // handled, so the listener only swallows the key then (see do_hotkey / the keydown listener).
    hotkey: (action) => { try { return do_hotkey(action); } catch (e) { console.warn('Mephisto: hotkey failed', e); return false; } },
    // content-script.js pushes positions/clocks straight in (same realm, no messaging)
    // returns the handler's value so a click can be awaited (the click branch returns its dispatch promise)
    onContentMessage: (msg) => { try { return PANEL_MSG_HANDLER && PANEL_MSG_HANDLER(msg, {}); } catch (e) { console.warn('Mephisto: content->panel failed', e); } },
    // Called by the content-script when the panel closes (X button, panel-style change, page unload).
    // Closing means CLOSED. abandon_search() stops the search, PANEL_BOOTED=false makes every
    // incoming position push inert, the engine is shut down, and the held position is forgotten.
    //
    // The engine used to be kept warm here so reopening skipped the net reload / host relaunch --
    // USER CALL: that is not the trade they want. A closed panel now costs nothing at all, and
    // reopening pays a normal engine init.
    //
    // The captured/typed position used to survive too, restored on the next open. Same call: closing
    // is how you say you are done with it. The stash still carries a position across a same-session
    // panel REBUILD (changing Engine or Variant tears the panel down and puts it straight back), which
    // is a different thing and was a real bug when it lost your board -- that behaviour stays.
    suspend: () => {
        try { abandon_search(); } catch (e) { /* ignore */ }
        setup_fen = null; snap_crop = null; setup_view = null;
        try { snap_follow_stop(); } catch (e) { /* ignore */ }
        try { stash_setup_state(); } catch (e) { /* ignore */ } // setup_fen is null -> clears the stash
        try { stop_current_engine(); } catch (e) { /* ignore */ }
        // Drop any manual turn override so reopening auto-adjusts to the current position's real side.
        turn_override = null;
        turn_detected_prev = null;
        PANEL_BOOTED = false;
    },
    // Header king-switch tap: flip the manual side-to-move override from whatever's currently shown.
    // Sticky per position (held across re-scrapes of the same board so you can toggle back and forth),
    // auto-cleared when a real move changes the side or on close. Re-analyses immediately.
    flipTurn: () => {
        // A manually held position (screenshot capture, pasted FEN, or a move played on the panel
        // board) never goes through the scrape path -- that's where turn_override is applied, and it
        // returns early while setup_fen is set. So flip THIS position's turn directly and re-analyse,
        // or the switch is dead exactly when you most need it: a captured board is assumed white to
        // move, and without this you could never move the black pieces.
        if (setup_fen) {
            const flipped = flip_fen_turn(setup_fen);
            if (!is_legal_position(flipped)) return; // handing the move over would be illegal
            setup_fen = flipped;
            const input = PANEL_ROOT.getElementById('setup_fen_input');
            if (input) input.value = flipped;
            turn = flipped.split(' ')[1];
            set_turn_switch(turn);
            try { abandon_search(); } catch (e) { /* */ }
            last_eval.fen = '';
            on_new_pos(flipped, flipped, '');
            return;
        }
        const cur = (last_eval.fen && last_eval.fen.split(' ')[1]) === 'b' ? 'b' : 'w';
        turn_override = (cur === 'w') ? 'b' : 'w';
        set_turn_switch(turn_override); // instant feedback; the re-analysis repaints it from the FEN
        try { abandon_search(); } catch (e) { /* */ }
        last_eval.fen = '';
        push_config();
    },
};
})();
