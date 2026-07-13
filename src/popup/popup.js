import {Chess} from '../../lib/chess.js';

// the tab this popup iframe was injected into (passed by the content-script). Everything this popup
// sends/receives is scoped to THIS tab, so a background tab's popup can't drive the foreground tab
// or turn on its modes. Null only if opened before the content-script learned its id (falls back).
const MY_TAB_ID = parseInt(new URLSearchParams(location.search).get('tab'), 10) || null;

let engine;
let board;
let fen_cache;
let config;

let is_calculating = false;
let discard_stale_search = false; // drop engine output (incl. the flushed bestmove) of a search we stopped
let search_active = false; // a 'go' was issued whose bestmove hasn't arrived yet (is_calculating can't be
                           // used for this: it flips false on the first info line, not on bestmove)
let premove_tracker = {fen: '', lines: {}}; // per-multipv reply stability while the opponent thinks
let mirror_prev_stm = null;    // side to move of the previous position (mirror mode timing)
let mirror_last_pos_ts = 0;    // wall time when the current position first appeared
let mirror_opp_move_ms = null; // how long the opponent spent on their last move
let prog = 0;
let last_eval = {fen: '', activeLines: 0, lines: []};
let turn = ''; // 'w' | 'b'

document.addEventListener('DOMContentLoaded', async function () {
    // load extension configurations from localStorage
    const computeTime = JSON.parse(localStorage.getItem('compute_time'));
    const fenRefresh = JSON.parse(localStorage.getItem('fen_refresh'));
    const thinkTime = JSON.parse(localStorage.getItem('think_time'));
    const thinkVariance = JSON.parse(localStorage.getItem('think_variance'));
    const moveTime = JSON.parse(localStorage.getItem('move_time'));
    const moveVariance = JSON.parse(localStorage.getItem('move_variance'));
    const autoplay = JSON.parse(localStorage.getItem('autoplay'));
    const computerEval = JSON.parse(localStorage.getItem('computer_evaluation'));
    const mirrorBase = JSON.parse(localStorage.getItem('mirror_base'));
    const mirrorPct = JSON.parse(localStorage.getItem('mirror_pct'));
    // engines dropped in this version — migrate stale selections to the current default
    const REMOVED_ENGINES = ['stockfish-6', 'stockfish-16-nnue-40', 'stockfish-16-nnue-7', 'lc0', 'stockfish-17-nnue-79'];
    let storedEngine = JSON.parse(localStorage.getItem('engine'));
    if (REMOVED_ENGINES.includes(storedEngine)) storedEngine = null;
    config = {
        // general settings
        engine: storedEngine || 'stockfish-dev-nnue',
        variant: JSON.parse(localStorage.getItem('variant')) || 'chess',
        compute_time: (computeTime != null) ? computeTime : 300,
        fen_refresh: (fenRefresh != null) ? fenRefresh : 1000, // fallback poll only; positions arrive as pushes
        multiple_lines: JSON.parse(localStorage.getItem('multiple_lines')) || 1,
        threads: JSON.parse(localStorage.getItem('threads')) || 8,
        memory: JSON.parse(localStorage.getItem('memory')) || 512,
        think_time: (thinkTime != null) ? thinkTime : 0,
        think_variance: (thinkVariance != null) ? thinkVariance : 0,
        move_time: (moveTime != null) ? moveTime : 200,
        move_variance: (moveVariance != null) ? moveVariance : 50,
        computer_evaluation: (computerEval != null) ? computerEval : true,
        threat_analysis: JSON.parse(localStorage.getItem('threat_analysis')) || false,
        simon_says_mode: JSON.parse(localStorage.getItem('simon_says_mode')) || false,
        autoplay: (autoplay != null) ? autoplay : false,
        premove: JSON.parse(localStorage.getItem('premove')) || false,
        puzzle_mode: JSON.parse(localStorage.getItem('puzzle_mode')) || false,
        help_mode: JSON.parse(localStorage.getItem('help_mode')) || false,
        eval_bar: JSON.parse(localStorage.getItem('eval_bar')) || false,
        // Mirror mode: search exactly as long as the opponent spent on their last move,
        // adjusted by mirror_pct (them 10s -> us 9s at -10%); mirror_base until they've moved
        mirror_mode: JSON.parse(localStorage.getItem('mirror_mode')) || false,
        mirror_base: (mirrorBase != null) ? mirrorBase : 1000,
        mirror_pct: (mirrorPct != null) ? mirrorPct : -10,
        python_autoplay_backend: JSON.parse(localStorage.getItem('python_autoplay_backend')) || false,
        // appearance settings
        pieces: JSON.parse(localStorage.getItem('pieces')) || 'wikipedia.svg',
        board: JSON.parse(localStorage.getItem('board')) || 'brown',
        coordinates: JSON.parse(localStorage.getItem('coordinates')) || false,
        dark_mode: JSON.parse(localStorage.getItem('dark_mode')) || false,
    };
    document.body.classList.toggle('mephisto-dark', config.dark_mode); // dark theme (set in Appearance)
    push_config();
    init_quick_settings();

    // init chess board
    document.getElementById('board').classList.add(config.board);
    const [pieceSet, ext] = config.pieces.split('.');
    board = ChessBoard('board', {
        position: 'start',
        pieceTheme: `/res/chesspieces/${pieceSet}/{piece}.${ext}`,
        appearSpeed: 'fast',
        moveSpeed: 'fast',
        showNotation: config.coordinates,
        draggable: false
    });

    // init fen LRU cache
    fen_cache = new LRU(100);

    // init engine webworker
    await initialize_engine();

    // listen to messages from content-script
    chrome.runtime.onMessage.addListener(function (response, sender) {
        // the content-script broadcasts (runtime.sendMessage) reach EVERY tab's popup -- ignore any
        // that came from a different tab's content-script so tabs never cross-talk. (Background
        // messages have no sender.tab and pass through.)
        if (MY_TAB_ID && sender.tab && sender.tab.id !== MY_TAB_ID) return;
        if (response.fenresponse) { // reply received -> the poll interval may fire the next request
            fen_request_inflight = false;
            clearTimeout(fen_request_timer);
        }
        if (response.fenresponse && response.dom && response.dom !== 'no') {
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
            const {fen, startFen, moves} = parsed;
            if (!is_legal_position(fen)) {
                // a corrupt/transient scrape (mid-animation, wrong turn guess) can yield an
                // illegal position; feeding one to the wasm engine crashes it (OOB). Skip it.
                console.warn('Mephisto: skipping illegal scraped position:', fen);
                return;
            }
            if (last_eval.fen !== fen) {
                // check BEFORE on_new_pos: chain/tracker belong to the position we were analysing.
                const instant = premove_instant_reply(fen, moves);
                on_new_pos(fen, startFen, moves);
                if (instant) {
                    // SAFETY: only play a certified reply if it moves OUR piece and (on our turn)
                    // is legal right now -- never click the opponent's move or an illegal move.
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
        } else if (response.click) {
            console.log(response);
            // click the GAME tab (the content-script's sender tab), not whatever tab is active --
            // otherwise a move firing while you're on another tab (e.g. chrome://extensions) dispatches
            // there and fails ("Cannot access a chrome:// URL").
            dispatch_click_event(response.x, response.y, sender?.tab?.id);
        }
    });

    // The content-script now PUSHES a scrape whenever the page actually changes (its
    // MutationObserver), so this poll is only a safety net for a missed push (observer edge
    // case, content-script from an older build). fen_refresh used to be the hot poll interval
    // (10ms default!) -- clamp it so old saved settings can't reinstate the 100Hz scrape loop
    // that starved the page and destabilized Chrome.
    request_fen();
    setInterval(function () {
        request_fen();
    }, Math.max(1000, config.fen_refresh));

    // register button click listeners
    document.getElementById('analyze').addEventListener('click', () => {
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
        window.open(`https://lichess.org/analysis/${variant}?fen=${last_eval.fen}`, '_blank');
    });
    document.getElementById('config').addEventListener('click', () => {
        window.open('/src/options/options.html', '_blank');
    });

    // initialize materialize
    M.Tooltip.init(document.querySelectorAll('.tooltipped'), {});
});

function init_quick_settings() {
    const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    // toggles apply live
    for (const [id, key] of [['qs_autoplay', 'autoplay'], ['qs_premove', 'premove'],
                             ['qs_puzzle', 'puzzle_mode'], ['qs_help', 'help_mode'],
                             ['qs_evalbar', 'eval_bar']]) {
        const elem = document.getElementById(id);
        if (!elem) continue; // stale cached popup.html mid-update; don't let one missing control kill the popup
        elem.checked = config[key];
        elem.addEventListener('change', () => {
            config[key] = elem.checked;
            save(key, elem.checked);
            if (key === 'help_mode' && !elem.checked) request_clear_hint();
            if (key === 'eval_bar' && !elem.checked) request_clear_eval_bar();
            if (key === 'help_mode' || key === 'autoplay') {
                // the go mode (infinite vs movetime) depends on these; abandon the current
                // search and re-analyse the position under the new mode on the next poll
                send_engine_uci('stop');
                last_eval.fen = '';
            }
            push_config();
        });
    }
    // timing settings apply live: compute_time is read at every 'go', think/move times are pushed to the page
    for (const [id, key] of [['qs_search', 'compute_time'], ['qs_think', 'think_time'],
                             ['qs_think_var', 'think_variance'], ['qs_move', 'move_time'], ['qs_move_var', 'move_variance']]) {
        const elem = document.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const value = Math.max((key === 'compute_time') ? 50 : 0, parseInt(elem.value) || 0);
            config[key] = value;
            save(key, value);
            push_config();
        });
    }
    // engine settings need a full engine re-init; reload the popup, it re-reads localStorage
    for (const [id, key, parse] of [
        ['qs_engine', 'engine', v => v],
        ['qs_variant', 'variant', v => v],
        ['qs_fen', 'fen_refresh', v => Math.max(1000, parseInt(v) || 1000)], // fallback poll; created once at startup
        ['qs_threads', 'threads', v => parseInt(v) || 8],
        ['qs_memory', 'memory', v => parseInt(v) || 512],
        ['qs_lines', 'multiple_lines', v => parseInt(v) || 1],
    ]) {
        const elem = document.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            // only Fairy-Stockfish plays variants; any other engine forces standard chess so the net
            // + legality checks stay correct (mirrors the options page's engine/variant coupling).
            if (key === 'engine' && parse(elem.value) !== 'fairy-stockfish-14-nnue') save('variant', 'chess');
            save(key, parse(elem.value));
            location.reload();
        });
    }
    // the Variant selector only matters for Fairy-Stockfish (the one engine that plays variants) --
    // show it only then. The "detect" button asks the content-script to read the variant off the page.
    const variantRow = document.getElementById('qs_variant_row');
    if (variantRow) variantRow.style.display = (config.engine === 'fairy-stockfish-14-nnue') ? '' : 'none';
    const detectBtn = document.getElementById('qs_variant_detect');
    if (detectBtn) {
        detectBtn.addEventListener('click', () => {
            detectBtn.disabled = true;
            request_detect_variant(v => {
                detectBtn.disabled = false;
                if (v) { save('variant', v); location.reload(); }        // detected -> reload into it
                else { detectBtn.textContent = '?'; setTimeout(() => { detectBtn.textContent = '↻'; }, 1200); }
            });
        });
    }
    // range sliders show their value in the label while dragging ('change' above still does the
    // save+reload when the thumb is released)
    for (const id of ['qs_lines', 'qs_threads', 'qs_memory']) {
        const slider = document.getElementById(id);
        const label = document.getElementById(`${id}_val`);
        if (!slider || !label) continue;
        label.textContent = slider.value;
        slider.addEventListener('input', () => { label.textContent = slider.value; });
    }
    // Mirror Mode: one button flips the panel into "play at the opponent's pace". It forces the
    // mode toggles above into the only configuration that makes sense for it (autoplay on;
    // premove/puzzle/help off -- instant premoves, puzzle sprints and help arrows all contradict
    // pacing), and search_movetime() takes over the engine's time budget.
    const mirrorBtn = document.getElementById('qs_mirror');
    const mirrorParams = document.getElementById('qs_mirror_params');
    const render_mirror = () => {
        const on = !!config.mirror_mode;
        if (mirrorBtn) mirrorBtn.classList.toggle('active', on);
        if (mirrorParams) mirrorParams.style.display = on ? '' : 'none';
        // active mirror collapses the panel to the essentials (see popup.css .mirror-on rules)
        document.getElementById('quick-settings')?.classList.toggle('mirror-on', on);
        const auto = document.getElementById('qs_autoplay');
        if (auto) {
            auto.disabled = on; // autoplay is forced ON while mirroring -- visible but locked
            if (on) auto.checked = true;
        }
    };
    render_mirror();
    if (mirrorBtn) {
        mirrorBtn.addEventListener('click', () => {
            config.mirror_mode = !config.mirror_mode;
            save('mirror_mode', config.mirror_mode);
            if (config.mirror_mode) {
                for (const [key, value, id] of [['autoplay', true, 'qs_autoplay'], ['premove', false, 'qs_premove'],
                                                ['puzzle_mode', false, 'qs_puzzle'], ['help_mode', false, 'qs_help']]) {
                    config[key] = value;
                    save(key, value);
                    const box = document.getElementById(id);
                    if (box) box.checked = value; // reflect the forced state on the switches above
                }
                request_clear_hint();
                mirror_opp_move_ms = null; // fresh activation: pace off mirror_base until they move
            }
            // the go mode (infinite vs movetime) and the movetime source both changed: abandon
            // the current search and re-analyse under the new mode on the next position push
            send_engine_uci('stop');
            last_eval.fen = '';
            render_mirror();
            push_config();
        });
    }
    for (const [id, key, def, clamp] of [
        ['qs_mirror_base', 'mirror_base', 1000, v => Math.max(100, Math.min(30000, v))],
        ['qs_mirror_pct', 'mirror_pct', -10, v => Math.max(-90, Math.min(100, v))],
    ]) {
        const elem = document.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const parsed = parseInt(elem.value);
            config[key] = clamp(Number.isFinite(parsed) ? parsed : def);
            elem.value = config[key];
            save(key, config[key]);
        });
    }
}

async function initialize_engine() {
    discard_stale_search = false; // a crashed engine never flushes its bestmove; don't eat the new engine's first result
    search_active = false;
    const engineMap = {
        'stockfish-dev-nnue': 'stockfish-dev/sf_dev.js',
        'stockfish-18-nnue': 'stockfish-18/sf_18.js',
        'stockfish-18-small-nnue': 'stockfish-18-small/sf_18_smallnet.js',
        'stockfish-11-hce': 'stockfish-11-hce/sfhce.js',
        'fairy-stockfish-14-nnue': 'fairy-stockfish-14/fsf14.js',
    }
    const enginePath = `/lib/engine/${engineMap[config.engine]}`;
    const engineBasePath = enginePath.substring(0, enginePath.lastIndexOf('/'));
    if (['stockfish-dev-nnue', 'stockfish-18-nnue', 'stockfish-18-small-nnue', 'fairy-stockfish-14-nnue', 'stockfish-11-hce'].includes(config.engine)) {
        if (typeof SharedArrayBuffer === 'undefined') {
            // the stockfish builds are pthread builds; without cross-origin isolation their
            // worker just dies with an opaque "worker sent an error! undefined:undefined"
            update_best_move('Engine blocked: this page does not provide SharedArrayBuffer '
                + '(cross-origin isolation). Try the Remote Engine, or report which site this happened on.', '');
            return;
        }
        const module = await import(enginePath);
        engine = await module.default();
        engine.listen = (message) => on_engine_response(message);
        engine.onError = (message) => on_engine_error(message);
        if (config.engine.includes('nnue')) {
            async function fetchNnueModels(engine, engineBasePath) {
                if (config.engine !== 'fairy-stockfish-14-nnue') {
                    const nnues = [];
                    for (let i = 0; ; i++) {
                        let nnue = engine.getRecommendedNnue(i);
                        if (!nnue || nnues.includes(nnue)) break;
                        nnues.push(nnue);
                    }
                    return await Promise.all(nnues.map(nnue => fetch_nnue(engineBasePath, nnue)));
                } else {
                    const variantNnueMap = {
                        'chess': 'nn-46832cfbead3.nnue',
                        'fischerandom': 'nn-46832cfbead3.nnue',
                        'crazyhouse': 'crazyhouse-8ebf84784ad2.nnue',
                        'kingofthehill': 'kingofthehill-978b86d0e6a4.nnue',
                        '3check': '3check-cb5f517c228b.nnue',
                        'antichess': 'antichess-dd3cbe53cd4e.nnue',
                        'atomic': 'atomic-2cf13ff256cc.nnue',
                        'horde': 'horde-28173ddccabe.nnue',
                        'racingkings': 'racingkings-636b95f085e3.nnue',
                    };
                    const variantNnue = variantNnueMap[config.variant];
                    const nnue_response = await fetch(`${engineBasePath}/nnue/${variantNnue}`);
                    return [await nnue_response.arrayBuffer()];
                }
            }

            if (config.engine === 'fairy-stockfish-14-nnue') {
                send_engine_uci(`setoption name UCI_Variant value ${config.variant}`);
            }
            const nnues = await fetchNnueModels(engine, engineBasePath);
            nnues.forEach((model, i) => engine.setNnueBuffer(new Uint8Array(model), i))
        }
    }

    if (is_remote()) {
        request_remote_configure({
            "Hash": config.memory,
            "Threads": config.threads,
            "MultiPV": config.multiple_lines,
        }).catch(on_remote_error);
    } else {
        send_engine_uci(`setoption name Hash value ${config.memory}`);
        send_engine_uci(`setoption name Threads value ${config.threads}`);
        send_engine_uci(`setoption name MultiPV value ${config.multiple_lines}`);
        // Chess960: a mainline Stockfish must be told, or it treats the game as standard chess and
        // mishandles castling whenever the king/rooks aren't on their normal files. (Fairy-Stockfish
        // already gets this from its 'fischerandom' UCI_Variant above, so only the SF engines need it.)
        if (config.variant === 'fischerandom' && config.engine !== 'fairy-stockfish-14-nnue') {
            send_engine_uci('setoption name UCI_Chess960 value true');
        }
        send_engine_uci('ucinewgame');
        send_engine_uci('isready');
    }
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

let engine_restarts = 0;
let engine_restarting = false;

function on_engine_error(message) {
    console.error(message);
    if (engine_restarting) return;
    if (!/RuntimeError|Aborted|worker sent an error/.test(String(message))) return;
    if (engine_restarts >= 3) {
        // ponytail: cap restarts — a build that keeps trapping (some wasm builds on some machines) shouldn't loop forever
        update_best_move('Engine keeps crashing — pick a different engine in Settings.', '');
        return;
    }
    engine_restarts++;
    engine_restarting = true;
    engine = null; // drop the dead instance; send_engine_uci becomes a no-op meanwhile
    update_best_move(`Engine crashed — restarting (attempt ${engine_restarts}/3)`, '');
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
    const piece_name_map = {P: 'Pawn', R: 'Rook', N: 'Knight', B: 'Bishop', Q: 'Queen', K: 'King'};
    const toplay = (turn === 'w') ? 'White' : 'Black';
    const next = (turn === 'w') ? 'Black' : 'White';
    if (!best || best === '(none)') { // game over (or crashed search) — there is no move to draw or play
        const pvLine = last_eval.lines[0] || {};
        if ('mate' in pvLine) {
            update_evaluation('Checkmate!');
            if (config.variant === 'antichess') {
                update_best_move(`${toplay} Wins`, '');
            } else {
                update_best_move(`${next} Wins`, '');
            }
        } else {
            update_evaluation('Stalemate!');
            if (config.variant === 'antichess') {
                update_best_move(`${toplay} Wins`, '');
            } else {
                update_best_move('Draw', '');
            }
        }
        toggle_calculating(false);
        return;
    } else if (config.simon_says_mode) {
        if (toplay.toLowerCase() === board.orientation()) {
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
        if (config.threat_analysis && threat && threat !== '(none)') {
            update_best_move(`${toplay} to play, best move is ${best}`, `Best response for ${next} is ${threat}`);
        } else {
            update_best_move(`${toplay} to play, best move is ${best}`, '');
        }
    }

    if (toplay.toLowerCase() === board.orientation()) {
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
        if (!config.help_mode && config.autoplay && isTerminal) {
            // SAFETY: only autoplay a move that actually moves OUR piece and is legal right now.
            // If the turn was mis-scraped we'd otherwise play the opponent's best move as ours.
            if (premove_reply_playable(last_eval.fen, best)) {
                request_automove(best); // in help mode draw_moves() mirrors all arrows onto the site board instead
            } else {
                console.warn('Mephisto: not autoplaying a move that is not ours/legal here:', best);
            }
        }
    }

    if (!config.simon_says_mode) {
        draw_moves();
        if (config.threat_analysis) {
            draw_threat()
        }
    }

    toggle_calculating(false);
}

function update_eval_bar(line) {
    const bar = document.getElementById('eval-bar-white');
    if (!bar || !line) return;
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

    // mirror the bar onto the site board (chess.com-style: score inside, on the winning side's end)
    if (config.eval_bar) {
        const text = ('mate' in line) ? `M${Math.abs(line.mate)}` : (Math.abs(line.score) / 100).toFixed(1);
        request_draw_eval_bar({frac, text, winningWhite: frac >= 0.5});
    }
}

function on_engine_evaluation(info) {
    if (!info.lines[0]) return;
    update_eval_bar(info.lines[0]);

    if ('mate' in info.lines[0]) {
        update_evaluation(`Checkmate in ${info.lines[0].mate}`);
    } else {
        update_evaluation(`Score: ${info.lines[0].score / 100.0} at depth ${info.lines[0].depth}`)
    }
}

function on_engine_response(message) {
    console.log('on_engine_response', message);
    if (is_remote()) {
        last_eval = Object.assign(last_eval, message);
        on_engine_evaluation(last_eval);
        on_engine_best_move(last_eval.bestmove, last_eval.threat, true);
        return;
    }

    if (discard_stale_search) {
        // output of the search we just stopped; UCI ordering ends it with its flushed bestmove
        if (message.startsWith('bestmove')) discard_stale_search = false;
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
        // (our reply to the predicted opponent move) is across depths 6 / 9 / latest
        if (config.premove && lineInfo.pv && pvIdx <= 1 && Number.isInteger(lineInfo.depth)) {
            const [pred, reply] = lineInfo.pv.split(' ');
            const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
            if (lineInfo.depth === 6) line.d6 = `${pred} ${reply}`;
            if (lineInfo.depth === 9) line.d9 = `${pred} ${reply}`;
            line.latest = `${pred} ${reply}`;
            line.pred = pred;
            line.reply = reply;
            line.depth = lineInfo.depth;
            if (pvIdx === 0) maybe_premove_forced_reply(line);
        }
        last_eval.activeLines = Math.max(last_eval.activeLines, lineInfo.multipv);
        if (pvIdx === 0) {
            // continuously show the best move for each depth
            if (last_eval.lines[0] != null) {
                const arr = last_eval.lines[0].pv.split(' ');
                const best = arr[0];
                const threat = arr[1];
                on_engine_best_move(best, threat);
            }
            // reset lines
            last_eval.lines = new Array(config.multiple_lines);
            // trigger an evaluation update
            last_eval.lines[pvIdx] = lineInfo;
            on_engine_evaluation(last_eval);
        } else {
            last_eval.lines[pvIdx] = lineInfo;
        }
    }

    if (is_calculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        document.getElementById('progBar')?.setAttribute('value', `${Math.round(progMapping)}`);
    }
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
    return true;
}

// "Premove" without the blunder risk: while the opponent thinks we certify a reply to their
// PREDICTED move (max 2 candidate lines). It only fires if the new position is EXACTLY the
// predicted one -- any other move discards the table and searches normally, so a wrong guess
// costs nothing. Certification = the reply is identical at depth 6, depth 9 and the latest
// depth (>= 10). Residual risk is only a marginally weaker (still certified) move, never a
// move meant for a different position.
// Final gate before ANY premove reply is clicked: it must move OUR piece, and when it is already
// our turn (an instant reply, not a premove queued during the opponent's turn) it must be fully
// legal right now. This rejects a stale/mismatched reply that would otherwise click the opponent's
// move or an illegal move.
function premove_reply_playable(fen, uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return false;
    try {
        const chess = new Chess(config.variant, fen);
        const our = (board.orientation() === 'white') ? 'w' : 'b';
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

// Don't wait for the opponent when waiting can't help: queue the certified reply as a REAL
// site premove (clicks during their turn) whenever premove_is_safe says it can't misfire.
function maybe_premove_forced_reply(line) {
    if (premove_tracker.premoved || !config.autoplay) return;
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return;
    if (line.depth < 10 || !line.d6 || line.d6 !== line.d9 || line.d6 !== line.latest) return;
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) return;
    const mover = (premove_tracker.fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover === board.orientation()) return; // only while the opponent is to move
    if (premove_tracker.safe === undefined) {
        // cached per position; certification pins (pred, reply) via the depth-6 snapshot,
        // so at most one pair can ever be checked here per position
        premove_tracker.safe = premove_is_safe(premove_tracker.fen, line.pred, line.reply);
    }
    if (!premove_tracker.safe) return;
    premove_tracker.premoved = true;
    console.log('Premove: reply cannot misfire (forced/bound to predicted move) -- premoving', line.reply);
    request_automove(line.reply);
}

function premove_instant_reply(new_fen, new_moves) {
    if (!config.premove || !config.autoplay) return null;
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return null;
    if (premove_tracker.premoved) return null; // already queued as a real site premove
    if (!premove_tracker.fen || premove_tracker.fen !== last_eval.fen) return null;
    const mover = (new_fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover !== board.orientation()) return null; // the certified reply must be OUR move
    let certified = 0;
    for (const idx of [0, 1]) {
        const line = premove_tracker.lines[idx];
        if (!line || line.depth < 10 || !line.d6 || line.d6 !== line.d9 || line.d6 !== line.latest) continue;
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) continue;
        certified++;
        // primary match: the exact MOVE, per the premove contract -- robust across sites
        // (fen-string reconstruction proved fragile on some site DOMs)
        if (premove_tracker.moves && new_moves
                && new_moves === `${premove_tracker.moves} ${line.pred}`) {
            return line.reply; // the opponent played exactly the predicted move
        }
        try { // fallback for moves-less contexts: apply the prediction and compare positions
            const chess = new Chess(config.variant, premove_tracker.fen);
            chess.move({from: line.pred.slice(0, 2), to: line.pred.slice(2, 4), promotion: line.pred[4]});
            if (chess.fen() === new_fen) {
                return line.reply;
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

// Mirror mode: our search budget mirrors the time the opponent spent on their LAST move,
// adjusted by mirror_pct (them 10s -> us 9s at -10%). Until they have moved (or after a board
// flip reset), mirror_base applies. Only OUR turn is paced this way -- background analysis of
// the opponent's turn keeps the normal compute_time budget. Clamped so a correspondence
// opponent thinking for an hour can't lock the engine into an hour-long search.
function search_movetime(fen) {
    if (!config.mirror_mode) return config.compute_time;
    const our = (board.orientation() === 'white') ? 'w' : 'b';
    if (fen.split(' ')[1] !== our) return config.compute_time;
    const raw = (mirror_opp_move_ms != null)
        ? mirror_opp_move_ms * (1 + config.mirror_pct / 100)
        : config.mirror_base;
    return Math.round(Math.max(50, Math.min(30000, raw)));
}

function on_new_pos(fen, startFen, moves) {
    console.log("on_new_pos", fen, startFen, moves);
    if (config.help_mode) request_clear_hint(); // position changed; last hint is stale
    premove_tracker = {fen: fen, startFen: startFen || fen, moves: moves || '', lines: {}}; // certifications belong to exactly one position
    // Mirror mode timing: a transition from "them to move" to "us to move" means the opponent
    // just completed a move; the wall time since the previous position appeared is (to within
    // a scrape debounce) how long they spent on it.
    const stm = fen.split(' ')[1];
    const now_ts = Date.now();
    const our_color = (board.orientation() === 'white') ? 'w' : 'b';
    if (mirror_prev_stm && mirror_prev_stm !== our_color && stm === our_color) {
        mirror_opp_move_ms = now_ts - mirror_last_pos_ts;
        if (config.mirror_mode) {
            console.log(`Mirror: opponent took ${mirror_opp_move_ms}ms -> our search budget ${search_movetime(fen)}ms`);
        }
    }
    mirror_prev_stm = stm;
    mirror_last_pos_ts = now_ts;
    const search_in_flight = search_active;
    toggle_calculating(true);
    if (is_remote()) {
        if (moves) {
            request_remote_analysis(startFen, search_movetime(fen), moves).then(on_engine_response).catch(on_remote_error);
        } else {
            request_remote_analysis(fen, search_movetime(fen)).then(on_engine_response).catch(on_remote_error);
        }
    } else {
        if (search_in_flight) {
            // 'stop' makes the engine flush a bestmove for the position it was searching. By the
            // time it arrives, `turn` already belongs to the NEW position -- if the old search was
            // for the opponent's side (they replied mid-search), that stale bestmove would be
            // automoved as OUR move. Discard everything up to and including that flushed bestmove.
            discard_stale_search = true;
        }
        send_engine_uci('stop');
        if (moves) {
            send_engine_uci(`position fen ${startFen} moves ${moves}`);
        } else {
            send_engine_uci(`position fen ${fen}`);
        }
        if (config.help_mode || !config.autoplay) {
            send_engine_uci('go infinite'); // pure analysis: keep deepening until the position changes
        } else {
            send_engine_uci(`go movetime ${search_movetime(fen)}`); // autoplay needs a final bestmove to act on
        }
        search_active = true;
    }

    board.position(fen);
    clear_annotations();
    if (config.simon_says_mode) {
        const toplay = (turn === 'w') ? 'White' : 'Black';
        if (toplay.toLowerCase() !== board.orientation()) {
            draw_moves();
            request_console_log('Best Move: ' + last_eval.bestmove);
        }
    }
    last_eval = {fen, activeLines: 0, lines: new Array(config.multiple_lines)}; // new evaluation
}

function parse_position_from_response(txt) {
    const prefixMap = {
        li: 'Game detected on Lichess.org',
        cc: 'Game detected on Chess.com',
        bt: 'Game detected on BlitzTactics.com'
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

    function parse_position_from_pieces(txt) {
        const directHit = fen_cache.get(txt);
        if (directHit) { // reuse position
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        const chess = new Chess(config.variant);
        chess.clear(); // clear the board so we can place our pieces
        const [playerTurn, ...pieces] = txt.split('*****').slice(0, -1);
        for (const piece of pieces) {
            const attributes = piece.split('-');
            chess.put({type: attributes[1], color: attributes[0]}, attributes[2]);
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();

        // a mid-animation scrape or wrong turn guess can yield a position where the side to move
        // could capture the king — searching such a position crashes the stockfish wasm (OOB)
        const opponent = (turn === 'w') ? 'b' : 'w';
        if (chess._isKingAttacked(opponent)) {
            throw Error('illegal position scraped (opponent king en prise)');
        }

        const record =  {fen: chess.fen()};
        fen_cache.set(txt, record);
        return record;
    }

    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    document.getElementById('game-detection').innerText = prefixMap[prefix];
    txt = txt.substring(11);

    if (metaTag.includes('var')) {
        if (txt.includes('&')) { // a custom start position is shipped along (chess960 / "From Position")
            const puzTxt = txt.substring(0, txt.indexOf('&'));
            const fenTxt = txt.substring(txt.indexOf('&') + 6);
            let startFen = parse_position_from_pieces(puzTxt).fen;
            if (config.variant === 'fischerandom') {
                startFen = startFen.replace('-', 'KQkq'); // chess960 always starts with full castling rights
            }
            return parse_position_from_moves(fenTxt, startFen);
        }
        return parse_position_from_moves(txt);
    } else if (metaTag.includes('puz')) { // chess.com & blitztactics.com puzzle pages
        return parse_position_from_pieces(txt);
    } else { // chess.com and lichess.org pages
        return parse_position_from_moves(txt);
    }
}

function update_evaluation(eval_string) {
    if (eval_string != null && config.computer_evaluation) {
        document.getElementById('evaluation').innerHTML = eval_string;
    }
}

function update_best_move(line1, line2) {
    if (line1 != null) {
        document.getElementById('chess_line_1').innerHTML = line1;
    }
    if (line2 != null) {
        document.getElementById('chess_line_2').innerHTML = line2;
    }
}

function send_to_active_tab(message) {
    // read lastError so "Receiving end does not exist" (no content-script on tab) stays unlogged
    if (MY_TAB_ID) { // normal path: talk to OUR tab only, even when it's in the background
        chrome.tabs.sendMessage(MY_TAB_ID, message, () => void chrome.runtime.lastError);
        return;
    }
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) { // fallback: no tab id yet
        if (!tabs[0]?.id) return;
        chrome.tabs.sendMessage(tabs[0].id, message, () => void chrome.runtime.lastError);
    });
}

let fen_request_inflight = false;
let fen_request_timer = null;

function request_fen() {
    // safety-net poll only -- positions normally arrive as pushes from the content-script's
    // MutationObserver. Don't pile up overlapping requests; the content-script skips replying
    // while it performs a move (or before config arrives), so a 500ms fallback clears the flag.
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

function request_automove(move) {
    // Is this a REAL move on our own turn, or a BLIND premove during the opponent's turn? The site
    // queues a blind premove (it won't appear in the move list until they move), so it must NOT be
    // verified/retried; an on-turn move must be. The popup is authoritative here -- decide from the
    // position's side-to-move (== our colour) rather than letting the content-script re-derive the
    // turn from fragile DOM highlights (which throws on e.g. the lichess analysis board, silently
    // skipping verification). last_eval.fen is the current position (on_new_pos ran before this).
    const our = (board.orientation() === 'white') ? 'w' : 'b';
    const verify = (last_eval.fen?.split(' ')[1] === our);
    const deselect = safe_deselect_square(last_eval.fen, move);
    const message = (config.puzzle_mode)
        ? {automove: true, pv: last_eval.lines[0]?.pv?.split(' ') || [move], deselect, verify}
        : {automove: true, move: move, deselect, verify};
    send_to_active_tab(message);
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

// ask the content-script to read the variant off the current game page; cb(variant | null)
function request_detect_variant(cb) {
    const ask = tabId => chrome.tabs.sendMessage(tabId, {detectVariant: true}, resp => {
        cb(chrome.runtime.lastError ? null : ((resp && resp.variant) || null));
    });
    if (MY_TAB_ID) return ask(MY_TAB_ID);
    chrome.tabs.query({active: true, currentWindow: true}, tabs => (tabs[0] && tabs[0].id) && ask(tabs[0].id));
}

function request_draw_eval_bar(data) {
    send_to_active_tab({drawEvalBar: true, ...data});
}

function request_clear_eval_bar() {
    send_to_active_tab({clearEvalBar: true});
}

function push_config() {
    send_to_active_tab({pushConfig: true, config: config});
}

function draw_moves() {
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

        const arrow_color = (i === 0) ? '#004db8' : '#4a4a4a';
        const stroke_width = strokeFunc(last_eval.lines[i]);
        draw_move(last_eval.lines[i].move, arrow_color, document.getElementById('move-annotations'), stroke_width);
        if (config.help_mode && stroke_width > 0 && last_eval.lines[i].move) {
            hint_arrows.push({move: last_eval.lines[i].move, width: stroke_width, color: arrow_color});
        }
    }
    if (config.help_mode) {
        if (config.threat_analysis && last_eval.threat && last_eval.threat !== '(none)') {
            hint_arrows.push({move: last_eval.threat, width: 0.2, color: '#bf0000'});
        }
        request_draw_hint(hint_arrows);
    }
}

function draw_threat() {
    if (last_eval.threat) {
        draw_move(last_eval.threat, '#bf0000', document.getElementById('response-annotations'));
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
    let move_annotation = document.getElementById('move-annotations');
    while (move_annotation.childElementCount) {
        move_annotation.lastElementChild.remove();
    }
    let response_annotation = document.getElementById('response-annotations');
    while (response_annotation.childElementCount) {
        response_annotation.lastElementChild.remove();
    }
}

function toggle_calculating(on) {
    prog = 0;
    is_calculating = on;
    if (is_calculating) {
        update_best_move(`<div>Calculating...<div><progress id='progBar' value='2' max='100'>`, '');
    }
}

async function dispatch_click_event(x, y, tabId) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        // NaN/undefined coords (e.g. a crazyhouse drop move) serialize badly and the debugger rejects them
        console.warn(`Ignoring click with invalid coordinates: (${x}, ${y})`);
        return;
    }
    if (config.python_autoplay_backend) {
        await request_backend_click(x, y);
    } else {
        await request_debugger_click(x, y, tabId);
    }
}

function resolve_click_tab(tabId) {
    // prefer the game tab (content-script sender); fall back to the active tab if unknown
    if (tabId) return Promise.resolve(tabId);
    return new Promise(res => chrome.tabs.query({active: true, currentWindow: true}, t => res(t[0]?.id)));
}

async function request_debugger_click(x, y, tabId) {
    resolve_click_tab(tabId).then((id) => {
        if (!id) return;
        const debugee = {tabId: id};
        chrome.debugger.attach(debugee, '1.3', async () => {
            // "Another debugger is already attached" is expected: we stay attached after the first click
            void chrome.runtime.lastError;
            await dispatch_mouse_event(debugee, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
            await dispatch_mouse_event(debugee, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
        });
    });
}

async function dispatch_mouse_event(debugee, mouseEvent, mouseEventOpts) {
    return new Promise(resolve => {
        chrome.debugger.sendCommand(debugee, mouseEvent, mouseEventOpts, (result) => {
            if (chrome.runtime.lastError) {
                console.warn(`${mouseEvent} failed: ${chrome.runtime.lastError.message}`);
            }
            resolve(result);
        });
    });
}

async function request_backend_click(x, y) {
    return call_backend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function request_backend_move(x0, y0, x1, y1) {
    return call_backend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

function is_remote() {
    return config.engine === 'remote';
}

async function request_remote_configure(options) {
    return call_backend('http://localhost:9090/configure', options).then(parse_backend_json);
}

async function request_remote_analysis(fen, time, moves = null) {
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
    update_best_move(err.message, '');
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
