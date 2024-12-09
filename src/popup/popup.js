import {Chess} from "../../lib/chess.min.js";

let engine;
let board;
let fenCache;
let config;

let isCalculating = false;
let prog = 0;
let lastFen = '';
let lastPv = '';
let lastScore = '';
let lastBestMove = '';
let turn = '';

const pieceNameMap = {
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
        compute_time: JSON.parse(localStorage.getItem('compute_time')) || 500,
        fen_refresh: JSON.parse(localStorage.getItem('fen_refresh')) || 100,
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
    fenCache = new LRU(1000);

    // init engine webworker
    await initialize_engine();

    // listen to messages from content-script
    chrome.runtime.onMessage.addListener(function (response) {
        if (response.fenresponse && response.dom !== 'no') {
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            let fen = parse_fen_from_response(response.dom);
            if (lastFen !== fen) {
                new_pos(fen);
            }
        } else if (response.pullConfig) {
            push_config();
        } else if (response.click) {
            console.log(response);
            dispatchClickEvent(response.x, response.y);
        }
    });

    // query fen periodically from content-script
    request_fen();
    setInterval(function () {
        request_fen();
    }, config.fen_refresh);

    // register button click listeners
    document.getElementById('analyze').addEventListener('click', () => {
        window.open(`https://lichess.org/analysis?fen=${lastFen}`, '_blank');
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
            const nnues = [];
            for (let i = 0; ; i++) {
                let nnue = engine.getRecommendedNnue(i);
                if (!nnue || nnues.includes(nnue)) break;
                nnues.push(nnue);
            }
            const nnue_responses = await Promise.all(nnues.map(nnue => fetch(`${engineBasePath}/${nnue}`)));
            const nnue_models = await Promise.all(nnue_responses.map(res => res.arrayBuffer()));
            nnue_models.forEach((model, i) => engine.setNnueBuffer(new Uint8Array(model), i));
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
            await promiseTimeout(100);
        }

        window.onmessage = event => on_engine_response(event.data);
        let weights = await fetch(`${engineBasePath}/weights/weights_32195.dat.gz`).then(res => res.arrayBuffer());
        engine.postMessage({type: "weights", data: {name: "weights_32195.dat.gz", weights: weights}}, "*");
    }
    send_engine_uci('ucinewgame');
    send_engine_uci('isready');
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
            update_best_move(pieceNameMap[startPieceType]);
        }
    } else {
        if (best === '(none)') {
            update_best_move(`${next} Wins`, '');
        } else if (threat && threat !== '(none)') {
            update_best_move(`${toplay} to play, best move is ${best}`, `Best response for ${next} is ${threat}`);
        } else {
            update_best_move(`${toplay} to play, best move is ${best}`, '');
        }
    }
    if (toplay.toLowerCase() === board.orientation()) {
        lastBestMove = best;
        if (config.simon_says_mode) {
            const startSquare = best.substring(0, 2);
            const startPiece = board.position()[startSquare].substring(1);
            request_console_log(`${pieceNameMap[startPiece]} ==> ${lastScore}`);
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
            const mateNum = Math.abs(parseInt(mateArr[0]));
            on_engine_mate(mateNum);
        } else if (info.includes('score')) {
            const infoArr = info.split(" ");
            const depth = infoArr[2];
            const score = ((turn === 'w') ? 1 : -1) * (config.engine === "lc0") ? infoArr[11] : infoArr[9];
            on_engine_score(score, depth);
            lastScore = score / 100.0;
        }
        lastPv = pvSplit[1];
    }
    if (isCalculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        document.getElementById('progBar').setAttribute('value', `${Math.round(progMapping)}`);
    }
}

function new_pos(fen) {
    document.getElementById('chess_line_1').innerHTML = `
        <div>Calculating...<div>
        <progress id="progBar" value="2" max="100">
    `;
    document.getElementById('chess_line_2').innerText = '';
    if (config.engine === "remote") {
        requestAnalyseFen(fen, config.compute_time).then(on_engine_response);
    } else {
        send_engine_uci(`position fen ${fen}`);
        send_engine_uci(`go movetime ${config.compute_time}`);
    }
    board.position(fen);
    lastFen = fen;
    if (config.simon_says_mode) {
        draw_arrow(lastBestMove, 'blue', document.getElementById('move-arrow'));
        request_console_log(`Best Move: ${lastBestMove}`);
    } else {
        clear_arrows();
    }
    toggle_calculating(true);
}

function parse_fen_from_response(txt) {
    const prefixMap = {
        li: 'Game detected on Lichess.org',
        cc: 'Game detected on Chess.com',
        bt: 'Game detected on BlitzTactics.com'
    };
    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    document.getElementById('game-detection').innerText = prefixMap[prefix];
    txt = txt.substring(11);

    const chess = new Chess();
    if (metaTag.includes("puz")) { // chess.com & blitztactics.com puzzle pages
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
    } else { // chess.com and lichess.org pages
        const directHit = fenCache.get(txt);
        if (directHit) { // avoid recalculating same position
            console.log('DIRECT');
            turn = directHit.charAt(directHit.indexOf(' ') + 1);
            return directHit;
        }
        const lastMoveRegex = /([\w-+=#]+[*]+)$/;
        const cacheKey = txt.replace(lastMoveRegex, "");
        const indirectHit = fenCache.get(cacheKey);
        if (indirectHit) { // calculate fen by appending newest move
            console.log('INDIRECT');
            const lastMove = txt.match(lastMoveRegex)[0].split('*****')[0];
            chess.load(indirectHit);
            chess.move(lastMove);
        } else { // calculate fen by performing all moves
            console.log('FULL');
            const moves = txt.split("*****");
            for (const move of moves) {
                chess.move(move);
            }
        }
        turn = chess.turn();
        const fen = chess.fen();
        fenCache.set(txt, fen);
        return fen;
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
        ? {automove: true, pv: lastPv || move}
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

function getCoords(move) {
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

    const coords = getCoords(move);
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
    isCalculating = on;
}

async function dispatchClickEvent(x, y) {
    if (config.python_autoplay_backend) {
        await requestPythonBackendClick(x, y);
    } else {
        await requestDebuggerClick(x, y);
    }
}

async function requestDebuggerClick(x, y) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        const debugee = {tabId: tabs[0].id};
        chrome.debugger.attach(debugee, "1.3", async () => {
            await dispatchMouseEvent(debugee, "Input.dispatchMouseEvent", {
                type: 'mousePressed',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
            await dispatchMouseEvent(debugee, "Input.dispatchMouseEvent", {
                type: 'mouseReleased',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
        });
    });
}

async function dispatchMouseEvent(debugee, mouseEvent, mouseEventOpts) {
    return new Promise(resolve => {
        chrome.debugger.sendCommand(debugee, mouseEvent, mouseEventOpts, resolve);
    });
}

async function requestPythonBackendClick(x, y) {
    return callBackend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function requestPythonBackendMove(x0, y0, x1, y1) {
    return callBackend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

async function requestAnalyseFen(fen, time) {
    return callBackend('http://localhost:9090/analyse', {fen: fen, time: time})
        .then(res => res.json());
}

async function callBackend(url, data) {
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

function promiseTimeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(time), time);
    });
}
