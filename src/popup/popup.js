import {Chess} from "../../lib/chess.js";

let engine;
let board;
let fen_cache;
let config;

let is_calculating = false;
let prog = 0;
let last_fen = '';
let last_pv = '';
let last_score = '';
let last_best_move = '';
let turn = '';

const piece_name_map = {
    'P': 'Pawn',
    'R': 'Rook',
    'N': 'Knight',
    'B': 'Bishop',
    'Q': 'Queen',
    'K': 'King',
};

document.addEventListener('DOMContentLoaded', async function () {
    // load extension configurations from localStorage
    config = {
        // general settings
        engine: JSON.parse(localStorage.getItem('engine')) || 'stockfish-16-nnue-7',
        variant: JSON.parse(localStorage.getItem('variant')) || 'chess',
        compute_time: JSON.parse(localStorage.getItem('compute_time')) || 500,
        fen_refresh: JSON.parse(localStorage.getItem('fen_refresh')) || 100,
        multiple_lines: JSON.parse(localStorage.getItem('multiple_lines')) || 1,
        threads: JSON.parse(localStorage.getItem('threads')) || 1,
        memory: JSON.parse(localStorage.getItem('memory')) || 32,
        think_time: JSON.parse(localStorage.getItem('think_time')) || 1000,
        think_variance: JSON.parse(localStorage.getItem('think_variance')) || 500,
        move_time: JSON.parse(localStorage.getItem('move_time')) || 500,
        move_variance: JSON.parse(localStorage.getItem('move_variance')) || 250,
        computer_evaluation: JSON.parse(localStorage.getItem('computer_evaluation')) || false,
        threat_analysis: JSON.parse(localStorage.getItem('threat_analysis')) || false,
        simon_says_mode: JSON.parse(localStorage.getItem('simon_says_mode')) || false,
        autoplay: JSON.parse(localStorage.getItem('autoplay')) || false,
        puzzle_mode: JSON.parse(localStorage.getItem('puzzle_mode')) || false,
        python_autoplay_backend: JSON.parse(localStorage.getItem('python_autoplay_backend')) || false,
        // appearance settings
        pieces: JSON.parse(localStorage.getItem('pieces')) || 'wikipedia.svg',
        board: JSON.parse(localStorage.getItem('board')) || 'brown',
        coordinates: JSON.parse(localStorage.getItem('coordinates')) || false,
    };
    push_config();

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
    fen_cache = new LRU(1000);

    // init engine webworker
    await initialize_engine();

    // listen to messages from content-script
    chrome.runtime.onMessage.addListener(function (response) {
        if (response.fenresponse && response.dom !== 'no') {
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            const {fen, startFen, moves} = parse_position_from_response(response.dom);
            if (last_fen !== fen) {
                on_new_pos(fen, startFen, moves);
            }
        } else if (response.pullConfig) {
            push_config();
        } else if (response.click) {
            console.log(response);
            dispatch_click_event(response.x, response.y);
        }
    });

    // query fen periodically from content-script
    request_fen();
    setInterval(function () {
        request_fen();
    }, config.fen_refresh);

    // register button click listeners
    document.getElementById('analyze').addEventListener('click', () => {
        window.open(`https://lichess.org/analysis?fen=${last_fen}`, '_blank');
    });
    document.getElementById('config').addEventListener('click', () => {
        window.open('/src/options/options.html', '_blank');
    });

    // initialize materialize
    M.Tooltip.init(document.querySelectorAll('.tooltipped'), {});
});

async function initialize_engine() {
    if (config.engine === "remote") {
        return;
    }

    const engineMap = {
        "stockfish-17-nnue-79": "stockfish-17-79/sf17-79.js",
        "stockfish-16-nnue-40": "stockfish-16-40/stockfish.js",
        "stockfish-16-nnue-7": "stockfish-16-7/sf16-7.js",
        "stockfish-11-hce": "stockfish-11-hce/sfhce.js",
        "stockfish-11": "stockfish-11/stockfish.js",
        "stockfish-6": "stockfish-6/stockfish.js",
        "fairy-stockfish-14-nnue": "fairy-stockfish-14/fsf14.js",
        "lc0": "lc0/lc0.js",
    }
    const enginePath = `/lib/engine/${engineMap[config.engine]}`;
    const engineBasePath = enginePath.substring(0, enginePath.lastIndexOf('/'));
    if (["stockfish-16-nnue-40", "stockfish-11", "stockfish-6"].includes(config.engine)) {
        engine = new Worker(enginePath);
        engine.onmessage = (event) => on_engine_response(event.data);
    } else if (["stockfish-17-nnue-79", "stockfish-16-nnue-7", "fairy-stockfish-14-nnue", "stockfish-hce"].includes(config.engine)) {
        const module = await import(enginePath);
        engine = await module.default();
        if (config.engine.includes("nnue")) {
            async function fetchNnueModels(engine, engineBasePath) {
                if (config.engine !== "fairy-stockfish-14-nnue") {
                    const nnues = [];
                    for (let i = 0; ; i++) {
                        let nnue = engine.getRecommendedNnue(i);
                        if (!nnue || nnues.includes(nnue)) break;
                        nnues.push(nnue);
                    }
                    const nnue_responses = await Promise.all(nnues.map(nnue => fetch(`${engineBasePath}/${nnue}`)));
                    return await Promise.all(nnue_responses.map(res => res.arrayBuffer()));
                } else {
                    // todo: try using https://github.com/fairy-stockfish/fairy-stockfish.wasm
                    const variantNnueMap = {
                        'chess': 'nn-46832cfbead3.nnue',
                        'fischerandom': 'nn-46832cfbead3.nnue',
                        'crazyhouse': 'crazyhouse-8ebf84784ad2.nnue',
                        'kingofthehill': 'kingofthehill-978b86d0e6a4.nnue',
                        '3check': '3check-cb5f517c228b.nnue',
                        'antichess': 'antichess-dd3cbe53cd4e.nnue', // BAD_NNUE
                        'atomic': 'atomic-2cf13ff256cc.nnue',
                        'horde': 'horde-28173ddccabe.nnue', // BAD_NNUE
                        'racingkings': 'racingkings-636b95f085e3.nnue',
                    };
                    const variantNnue = variantNnueMap[config.variant];
                    console.log("Attempting fetch: ", `${engineBasePath}/nnue/${variantNnue}`)
                    const nnue_response = await fetch(`${engineBasePath}/nnue/${variantNnue}`);
                    const buffer = await nnue_response.arrayBuffer()
                    console.log("Buffer", buffer);
                    return [buffer];
                }
            }
            const nnues = await fetchNnueModels(engine, engineBasePath);
            nnues.forEach((model, i) => engine.setNnueBuffer(new Uint8Array(model), i))
        }
        engine.listen = (message) => on_engine_response(message);
    } else if (["lc0"].includes(config.engine)) {
        const lc0Frame = document.createElement('iframe');
        lc0Frame.src = `${engineBasePath}/lc0.html`;
        lc0Frame.style.display = 'none';
        document.body.appendChild(lc0Frame);
        engine = lc0Frame.contentWindow;

        let poll_startup = true
        window.onmessage = () => poll_startup = false;
        while (poll_startup) {
            await promise_timeout(100);
        }

        window.onmessage = event => on_engine_response(event.data);
        let weights = await fetch(`${engineBasePath}/weights/weights_32195.dat.gz`).then(res => res.arrayBuffer());
        engine.postMessage({type: "weights", data: {name: "weights_32195.dat.gz", weights: weights}}, "*");
    }
    send_engine_uci('ucinewgame');
    send_engine_uci('isready');
    send_engine_uci(`setoption name Hash value ${config.memory}`);
    send_engine_uci(`setoption name Threads value ${config.threads}`);
    send_engine_uci(`setoption name MultiPV value ${config.multiple_lines}`);
    if (config.engine === 'fairy-stockfish-14-nnue') {
        send_engine_uci(`setoption name UCI_Variant value ${config.variant}`);
    }
    console.log("Engine ready!", engine);
}

function send_engine_uci(message) {
    if (config.engine === "lc0") {
        engine.postMessage(message, '*');
    } else if (engine instanceof Worker) {
        engine.postMessage(message);
    } else if (engine.hasOwnProperty('uci')) {
        engine.uci(message);
    }
}

function on_engine_best_move(best, threat) {
    const toplay = (turn === 'w') ? 'White' : 'Black';
    const next = (turn === 'w') ? 'Black' : 'White';
    if (config.simon_says_mode) {
        const startSquare = best.substring(0, 2);
        const startPiece = board.position()[startSquare];
        const startPieceType = (startPiece) ? startPiece.substring(1) : null;
        if (startPieceType) {
            update_best_move(piece_name_map[startPieceType]);
        }
    } else {
        if (best === '(none)') {
            // todo: add stalemate detection here
            update_best_move(`${next} Wins`, '');
        } else if (threat && threat !== '(none)') {
            update_best_move(`${toplay} to play, best move is ${best}`, `Best response for ${next} is ${threat}`);
        } else {
            update_best_move(`${toplay} to play, best move is ${best}`, '');
        }
    }
    if (toplay.toLowerCase() === board.orientation()) {
        last_best_move = best;
        if (config.simon_says_mode) {
            const startSquare = best.substring(0, 2);
            const startPiece = board.position()[startSquare].substring(1);
            request_console_log(`${piece_name_map[startPiece]} ==> ${last_score}`);
            if (config.threat_analysis) {
                draw_arrow(threat, 'red', document.getElementById('response-arrow'));
            }
        }
        if (config.autoplay) {
            request_automove(best);
        }
    }
    if (!config.simon_says_mode) {
        draw_arrow(best, 'blue', document.getElementById('move-arrow'));
        if (config.threat_analysis) {
            draw_arrow(threat, 'red', document.getElementById('response-arrow'));
        }
    }
    toggle_calculating(false);
}

function on_engine_mate(mateNum) {
    if (mateNum === 0) {
        update_evaluation('Checkmate!');
        update_best_move('', '');
        document.getElementById('chess_line_2').innerText = '';
    } else {
        update_evaluation(`Checkmate in ${mateNum}`);
    }
    toggle_calculating(false);
}

function on_engine_score(score, depth) {
    update_evaluation(`Score: ${score / 100.0} at depth ${depth}`)
}

function on_engine_response(message) {
    console.log('on_engine_response', message);
    if (config.engine === "remote") {
        on_engine_best_move(message['move'], message['ponder']);
        if (message['score']['is_mate']) {
            on_engine_mate(message['score'].value)
        } else {
            on_engine_score(message['score'].value, message['score'].depth)
        }
    } else if (message.includes('bestmove')) {
        const arr = message.split(' ');
        const best = arr[1];
        const threat = arr[3];
        on_engine_best_move(best, threat);
    } else if (message.includes('info depth')) {
        const pvSplit = message.split(" pv ");
        const info = pvSplit[0];
        if (info.includes('score mate')) {
            const arr = message.split('score mate ');
            const mateArr = arr[1].split(' ');
            const mateNum = parseInt(mateArr[0]);
            on_engine_mate(mateNum);
        } else if (info.includes('score')) {
            const infoArr = info.split(" ");
            const depth = infoArr[2];
            const score = ((turn === 'w') ? 1 : -1) * (config.engine === "lc0") ? infoArr[11] : infoArr[9];
            on_engine_score(score, depth);
            last_score = score / 100.0;
        }
        last_pv = pvSplit[1];
    }
    if (is_calculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        document.getElementById('progBar').setAttribute('value', `${Math.round(progMapping)}`);
    }
}

function on_new_pos(fen, startFen, moves) {
    document.getElementById('chess_line_1').innerHTML = `
        <div>Calculating...<div>
        <progress id="progBar" value="2" max="100">
    `;
    document.getElementById('chess_line_2').innerText = '';
    if (config.engine === "remote") {
        // todo: need a way to pass startFen+moves directive to remote engine
        request_analyse_fen(fen, config.compute_time).then(on_engine_response);
    } else {
        if (moves) {
            send_engine_uci(`position fen ${startFen} moves ${moves}`);
        } else {
            send_engine_uci(`position fen ${fen}`);
        }
        send_engine_uci(`go movetime ${config.compute_time}`);
    }
    board.position(fen);
    last_fen = fen;
    if (config.simon_says_mode) {
        draw_arrow(last_best_move, 'blue', document.getElementById('move-arrow'));
        request_console_log(`Best Move: ${last_best_move}`);
    } else {
        clear_arrows();
    }
    toggle_calculating(true);
}

function parse_position_from_response(txt) {
    const prefixMap = {
        li: 'Game detected on Lichess.org',
        cc: 'Game detected on Chess.com',
        bt: 'Game detected on BlitzTactics.com'
    };

    function parse_position_from_moves(chess, txt) {
        const directHit = fen_cache.get(txt);
        if (directHit) { // reuse position
            console.log('DIRECT');
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        let record;
        const lastMoveRegex = /([\w-+=#]+[*]+)$/;
        const cacheKey = txt.replace(lastMoveRegex, "");
        const indirectHit = fen_cache.get(cacheKey);
        if (indirectHit) { // append newest move
            console.log('INDIRECT');
            chess.load(indirectHit.fen);
            const moveReceipt = chess.move(txt.match(lastMoveRegex)[0].split('*****')[0]);
            record = {fen: chess.fen(), startFen: indirectHit.startFen, moves: indirectHit.moves + ' ' + moveReceipt.lan}
        } else { // perform all moves
            console.log('FULL');
            let startFen = getStartingPosition();
            chess.load(startFen);
            let moves = '';
            for (const san of txt.split("*****").slice(0, -1)) {
                const moveReceipt = chess.move(san);
                moves += moveReceipt.lan + ' ';
            }
            record = {fen: chess.fen(), startFen, moves: moves.trim()};
        }

        turn = chess.turn();
        fen_cache.set(txt, record);
        return record;
    }

    function parse_position_from_pieces(chess, txt) {
        // todo: use fen cache here as well?
        chess.clear(); // clear the board so we can place our pieces
        const [playerTurn, ...pieces] = txt.split("*****").slice(0, -1);
        console.log(txt);
        for (const piece of pieces) {
            const attributes = piece.split("-");
            chess.put({type: attributes[1], color: attributes[0]}, attributes[2]);
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();
        return chess.fen();
    }

    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    document.getElementById('game-detection').innerText = prefixMap[prefix];
    txt = txt.substring(11);

    const chess = new Chess(config.variant);
    if (metaTag.includes("var")) {
        // todo: incomplete - finish me
        const puzTxt = txt.substring(0, txt.indexOf('&') - 5);
        const fenTxt = txt.substring(txt.indexOf('&') + 6);
        return parse_position_from_moves(chess, fenTxt);
    } else if (metaTag.includes("puz")) { // chess.com & blitztactics.com puzzle pages
        return {fen: parse_position_from_pieces(chess, txt)};
    } else { // chess.com and lichess.org pages
        return parse_position_from_moves(chess, txt);
    }
}

function update_evaluation(eval_string) {
    if (eval_string && config.computer_evaluation) {
        document.getElementById('evaluation').innerText = eval_string;
    }
}

function update_best_move(line1, line2) {
    if (line1 != null) {
        document.getElementById('chess_line_1').innerText = line1;
    }
    if (line2 != null) {
        document.getElementById('chess_line_2').innerText = line2;
    }
}

function request_fen() {
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, {queryfen: true});
    });
}

function request_automove(move) {
    const message = (config.puzzle_mode)
        ? {automove: true, pv: last_pv || move}
        : {automove: true, move: move};
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, message);
    });
}

function request_console_log(message) {
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, {consoleMessage: message});
    });
}

function push_config() {
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, {pushConfig: true, config: config});
    });
}

function get_coords(move) {
    const x0 = move[0].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
    const y0 = parseInt(move.substring(1, 2));
    const x1 = move[2].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
    const y1 = parseInt(move.substring(3, 4));
    return (board.orientation() === 'white')
        ? {x0: x0, y0: y0, x1: x1, y1: y1}
        : {x0: 9 - x0, y0: 9 - y0, x1: 9 - x1, y1: 9 - y1};
}

function draw_arrow(move, color, overlay) {
    if (!move || move === '(none)') {
        overlay.lastElementChild?.remove();
        return;
    }

    const bodyWidth = document.body.clientWidth;
    const boardSide = document.querySelector('#board .board-b72b1').clientWidth;
    const marginLeft = (bodyWidth - boardSide) / 2;

    const coords = get_coords(move);
    let x0 = 0.5 + (coords.x0 - 1);
    let y0 = 8 - (0.5 + (coords.y0 - 1));
    let x1 = 0.5 + (coords.x1 - 1);
    let y1 = 8 - (0.5 + (coords.y1 - 1));

    const dx = x1 - x0;
    const dy = y1 - y0;
    const d = Math.sqrt(dx * dx + dy * dy);
    x0 = x0 + 0.1 * ((x1 - x0) / d);
    y0 = y0 + 0.1 * (dy / d);
    x1 = x1 - 0.4 * ((x1 - x0) / d);
    y1 = y1 - 0.4 * (dy / d);

    overlay.innerHTML = `
        <svg width="${boardSide}" height="${boardSide}" viewBox="0, 0, 8, 8" style="margin-left: ${marginLeft}px">
            <defs>
                <marker id="arrow-${color}" markerWidth="13" markerHeight="13" refX="1" refY="7" orient="auto">
                    <path d="M1,5.75 L3,7 L1,8.25" fill="${color}" />
                </marker>
            </defs>
            <line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${color}" fill=${color}" stroke-width="0.225" 
                marker-end="url(#arrow-${color})"/>
        </svg>
    `;
}

function clear_arrows() {
    if (!config.simon_says_mode) {
        document.getElementById('move-arrow').lastElementChild?.remove();
        document.getElementById('response-arrow').lastElementChild?.remove();
    }
}

function toggle_calculating(on) {
    prog = 0;
    is_calculating = on;
}

async function dispatch_click_event(x, y) {
    if (config.python_autoplay_backend) {
        await request_backend_click(x, y);
    } else {
        await request_debugger_click(x, y);
    }
}

async function request_debugger_click(x, y) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        const debugee = {tabId: tabs[0].id};
        chrome.debugger.attach(debugee, "1.3", async () => {
            await dispatch_mouse_event(debugee, "Input.dispatchMouseEvent", {
                type: 'mousePressed',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
            await dispatch_mouse_event(debugee, "Input.dispatchMouseEvent", {
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
        chrome.debugger.sendCommand(debugee, mouseEvent, mouseEventOpts, resolve);
    });
}

async function request_backend_click(x, y) {
    return call_backend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function request_backend_move(x0, y0, x1, y1) {
    return call_backend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

async function request_analyse_fen(fen, time) {
    return call_backend('http://localhost:9090/analyse', {fen: fen, time: time}).then(res => res.json());
}

async function call_backend(url, data) {
    return fetch(url, {
        method: "POST",
        credentials: "include",
        cache: "no-cache",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
}

function promise_timeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(time), time);
    });
}

function getStartingPosition(chess960id) {
    if (config.variant === 'horde') {
        return 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1';
    } else if (config.variant === '3check') {
        return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 +0+0';
    } else if (config.variant === 'racingkings') {
        return '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1';
    } else if (config.variant === 'fischerandom') {
        function placeAtEmptyIndex(arr, i, val) {
            for (let j = 0; j < arr.length; j++) {
                if (arr[j]) continue;
                if (i === 0) {
                    arr[j] = val;
                    break;
                }
                i--;
            }
        }

        function generateFile(n) {
            const file = Array(8);

            const n2 = Math.floor(n / 4);
            const b1 = n % 4;
            file[2 * b1 + 1] = 'b';

            const n3 = Math.floor(n2 / 4);
            const b2 = n2 % 4;
            file[2 * b2] = 'b';

            const n4 = Math.floor(n3 / 6);
            let q = n3 % 6;
            placeAtEmptyIndex(file, q, 'q');

            let n5 = n4;
            let d = 4;
            while (n5 >= d) {
                n5 -= d;
                d--;
            }

            let k1 = 4 - d;
            placeAtEmptyIndex(file, k1, 'n');

            let k2 = k1 + n5;
            placeAtEmptyIndex(file, k2, 'n');

            placeAtEmptyIndex(file, 0, 'r');
            placeAtEmptyIndex(file, 0, 'k');
            placeAtEmptyIndex(file, 0, 'r');

            return file.join('');
        }

        const black_file = generateFile(chess960id);
        const white_file = black_file.toUpperCase();
        return `${black_file}/pppppppp/8/8/8/8/PPPPPPPP/${white_file} w KQkq - 0 1`;
    } else {
        return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    }
}
