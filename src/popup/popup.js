let stockfish;
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

$(window).on('load', function () {
    try {
        // load extension configurations from localStorage
        config = {
            compute_time: JSON.parse(localStorage.getItem('compute_time')),
            fen_refresh: JSON.parse(localStorage.getItem('fen_refresh')),
            think_time: JSON.parse(localStorage.getItem('think_time')),
            think_variance: JSON.parse(localStorage.getItem('think_variance')),
            move_time: JSON.parse(localStorage.getItem('move_time')),
            move_variance: JSON.parse(localStorage.getItem('move_variance')),
            simon_says_mode: JSON.parse(localStorage.getItem('simon_says_mode')),
            autoplay: JSON.parse(localStorage.getItem('autoplay')),
            puzzle_mode: JSON.parse(localStorage.getItem('puzzle_mode')),
            python_autoplay_backend: JSON.parse(localStorage.getItem('python_autoplay_backend'))
        };
    } catch {
        // resort to defaults if can't load
        config = {
            compute_time: 500,
            fen_refresh: 100,
            think_time: 1000,
            think_variance: 500,
            move_time: 1000,
            move_variance: 500,
            simon_says_mode: false,
            autoplay: false,
            puzzle_mode: false,
            python_autoplay_backend: false
        };
    }
    push_config();

    // init chess board
    board = ChessBoard('board', {
        draggable: false,
        moveSpeed: 'fast',
        position: 'start'
    });

    // init fen LRU cache
    fenCache = new LRU(100);

    // init stockfish webworker
    stockfish = new Worker('/lib/stockfish.js');
    stockfish.postMessage("ucinewgame");
    stockfish.postMessage("isready");
    stockfish.onmessage = on_stockfish_response;

    // listen to messages from content-script
    chrome.extension.onMessage.addListener(function (response) {
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
            dispatchClickEvent(response.x, response.y);
        }
    });

    // query fen periodically from content-script
    request_fen();
    setInterval(function () {
        request_fen();
    }, config.fen_refresh);

    // register button click listeners
    $('#analyze').on('click', () => {
        window.open('https://lichess.org/analysis?fen=' + lastFen, '_blank');
    });
    $('#config').on('click', () => {
        window.open('/src/options/options.html', '_blank');
    });

    // initialize materialize
    $('.tooltipped').tooltip();
});

function new_pos(fen) {
    $('#chess_line_1').html('<div>Calcu-stockfish-ating...<div><progress id="progBar" value="2" max="100">');
    stockfish.postMessage("position fen " + fen);
    stockfish.postMessage("go movetime " + config.compute_time);
    board.position(fen);
    lastFen = fen;
    if (config.simon_says_mode) {
        draw_arrow(lastBestMove, 'blue', 'overlay1');
        request_console_log(`Best Move: ${lastBestMove}`);
        // const bestMoveMessage = lastBestMove ? `Best Move: ${lastBestMove}` : '';
        // $('#chess_line_2').text(bestMoveMessage);
        // $('#chess_line_2').hide();
    }
    toggle_calculating(true);
}

function parse_fen_from_response(txt) {
    const prefixMap = {
        li: 'Game detected on Lichess.org',
        cc: 'Game detected on Chess.com',
        bt: 'Game detected on BlitzTactics.com'
    };
    const metaTag = txt.substr(3, 5);
    const prefix = metaTag.substr(0, 2);
    $('#gamedetected').text(prefixMap[prefix]);
    txt = txt.substr(11);

    const chess = new Chess();
    if (metaTag.includes("puz")) { // chess.com & blitztactics.com puzzle pages
        chess.clear(); // clear the board so we can place our pieces
        const [playerTurn, ...pieces] = txt.split("*****").slice(0, -1);
        console.log(txt);
        for (const piece of pieces) {
            const attributes = piece.split("-");
            chess.put({ type: attributes[1], color: attributes[0] }, attributes[2]);
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();
        return chess.fen();
    } else { // chess.com and lichess.org pages
        const directHit = fenCache.get(txt);
        if (directHit) { // avoid recalculating same position
            console.log('DIRECT');
            return directHit;
        }
        const regex = /([\w+!#]+[*]+)$/;
        const cacheKey = txt.replace(regex, "");
        const indirectHit = fenCache.get(cacheKey);
        if (indirectHit) { // calculate fen by appending newest move
            console.log('INDIRECT');
            const lastMove = txt.match(regex)[0].split('*****')[0];
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

function on_stockfish_response(event) {
    let message = event.data;
    console.log(message);
    if (message.includes('bestmove')) {
        const arr = message.split(' ');
        const best = arr[1];
        const threat = arr[3];
        const toplay = (turn === 'w') ? 'White' : 'Black';
        const next = (turn === 'w') ? 'Black' : 'White';
        if (config.simon_says_mode) {
            const startSquare = best.substr(0, 2);
            const startPiece = board.position()[startSquare];
            const startPieceType = (startPiece) ? startPiece.substr(1) : null;
            if (startPieceType) {
                const pieceNameMap = {
                    'P': 'Pawn',
                    'R': 'Rook',
                    'N': 'Knight',
                    'B': 'Bishop',
                    'Q': 'Queen',
                    'K': 'King',
                };
                $('#chess_line_1').text(pieceNameMap[startPieceType])
            }
        } else {
            if (message.includes('(none)')) {
                $('#chess_line_1').text(next + ' Wins');
            } else if (message.includes('ponder')) {
                $('#chess_line_1').text(toplay + ' to play, best move is ' + best);
                $('#chess_line_2').text('Best response for ' + next + ' is ' + threat);
            } else {
                $('#chess_line_1').text(toplay + ' to play, best move is ' + best);
            }
        }
        if (toplay.toLowerCase() === board.orientation()) {
            lastBestMove = best;
            if (config.simon_says_mode) {
                const startSquare = best.substr(0, 2);
                const startPiece = board.position()[startSquare].substr(1);
                const pieceNameMap = {
                    'P': 'Pawn',
                    'R': 'Rook',
                    'N': 'Knight',
                    'B': 'Bishop',
                    'Q': 'Queen',
                    'K': 'King',
                };
                request_console_log(`${pieceNameMap[startPiece]} ==> ${lastScore}`);
            }
            if (config.autoplay) {
                request_automove(best);
            }
        }
        if (!config.simon_says_mode) {
            draw_arrow(best, 'blue', 'overlay1');
            draw_arrow(threat, 'red', 'overlay2');
        }
        toggle_calculating(false);
    } else if (message.includes('info depth')) {
        const pvSplit = message.split(" pv ");
        const info = pvSplit[0];
        if (info.includes('score mate')) {
            const arr = message.split('score mate ');
            const mateArr = arr[1].split(' ');
            const mateNum = Math.abs(parseInt(mateArr[0]));
            if (mateNum === 0) {
                $('#evaluation').text("Checkmate!");
                $('#chess_line_2').empty();
                $('#progBar').empty();
                isCalculating = false;
                clear_arrows();
            } else {
                $('#evaluation').text("Checkmate in " + mateNum);
            }
            toggle_calculating(false);
        } else if (info.includes('score')) {
            const infoArr = info.split(" ");
            const depth = infoArr[2];
            const score = ((turn === 'w') ? 1 : -1) * infoArr[9];
            $('#evaluation').text("Score: " + score / 100.0 + " at depth " + depth);
            lastScore = score / 100.0;
        }
        lastPv = pvSplit[1];
    }
    if (isCalculating) {
        prog++;
        let progMapping = 100 - 100 * Math.exp(-prog / 30);
        $('#progBar').attr('value', Math.round(progMapping));
        $('#chess_line_2').hide();
        clear_arrows();
    } else {
        $('#chess_line_2').show();
    }
}

function request_fen() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { queryfen: true });
    });
}

function request_automove(move) {
    const message = (config.puzzle_mode)
        ? { automove: true, pv: lastPv || move }
        : { automove: true, move: move };
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, message);
    });
}

function request_console_log(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { consoleMessage: message });
    });
}

function push_config() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { pushConfig: true, config: config });
    });
}

function coord(move) {
    const lets = move.substring(0, 1);
    const lete = move.substring(2, 3);
    const nums = move.substring(1, 2) * 1.0;
    const nume = move.substring(3, 4) * 1.0;
    const slet = lets.charCodeAt(0) - 96; // 96 = 'a' - 1
    const elet = lete.charCodeAt(0) - 96; // 96 = 'a' - 1
    return (board.orientation() === 'white')
        ? { slet: slet, elet: elet, nums: nums, nume: nume }
        : { slet: 9 - slet, elet: 9 - elet, nums: 9 - nums, nume: 9 - nume };
}

function draw_arrow(move, color, div) {
    if (move && move !== '(none)') {
        const co = coord(move);
        const b = 344 / 8;
        let xs = 2 + b / 2 + b * (co.slet - 1);
        let ys = 350 - (b / 2 + b * (co.nums - 1)) - 1;
        let xe = 2 + b / 2 + b * (co.elet - 1);
        let ye = 350 - (b / 2 + b * (co.nume - 1)) - 1;
        const vx = xe - xs;
        const vy = ye - ys;
        const d = Math.sqrt(vx * vx + vy * vy);
        const vux = vx / d;
        const vuy = vy / d;
        xs = xs + 10 * vux;
        xe = xe - 10 * vux;
        ys = ys + 10 * vuy;
        ye = ye - 10 * vuy;
        let a = '<svg width="350" height="350">';
        a = a + '<defs>';
        a = a + '<marker id="arrow' + color + '" markerWidth="13" markerHeight="13" refX="2.5" refY="7" orient="auto" >';
        a = a + '<path d="M1,5.5 L3.5,7 L1,8.5 " style="fill: ' + color + ';" />';
        a = a + '</marker>';
        a = a + '</defs>';
        a = a + '<path d="M' + xs + ',' + ys + ' L' + xe + ',' + ye + '"';
        a = a + 'style="stroke:' + color + '; stroke-width: 8px; fill:' + color + ';';
        a = a + 'marker-end: url(#arrow' + color + ');"/> </svg>';
        $('#' + div).html(a)
    }
}

function clear_arrows() {
    if (!config.simon_says_mode) {
        $('#overlay1').empty();
        $('#overlay2').empty();
    }
}

function toggle_calculating(on) {
    prog = 0;
    isCalculating = on;
}

async function dispatchMouseEvent(debugee, mouseEvent, mouseEventOpts) {
    return new Promise(resolve => {
        chrome.debugger.sendCommand(debugee, mouseEvent, mouseEventOpts, resolve);
    });
}

async function dispatchClickEvent(x, y) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        const debugee = {tabId: tabs[0].id};
        chrome.debugger.attach(debugee, "1.3", async () => {
            await dispatchMouseEvent(debugee, "Input.dispatchMouseEvent", {
                type: 'mousePressed',
                button: 'left',
                x: x,
                y: y
            });
            await dispatchMouseEvent(debugee, "Input.dispatchMouseEvent", {
                type: 'mouseReleased',
                button: 'left',
                x: x,
                y: y
            });
            chrome.debugger.detach(debugee);
        });
    });
}
