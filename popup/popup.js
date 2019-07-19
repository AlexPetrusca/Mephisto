let stockfish;
let board;
let config;
let pr = 0;
let lastfen = '';
let calculating = 'no';
let turn = '';
let fenCache = new LRU(100);

function newpos(fen) {
    $('#chess').html('Calculstockfishating<br><progress id="progBar" value="2" max="100">');
    stockfish.postMessage("position fen " + fen);
    stockfish.postMessage("go movetime " + config.move_time);
    // board.position(fen);
    lastfen = fen;
    calculating = 'yes';
    pr = 0;
}

function fenfrommoves(txt, orient) {
    const prefixMap = {
        lifen: 'Game detected on Lichess.org',
        ccfen: 'Game detected on Chess.com',
        ccpuz: 'Game detected on Chess.com'
    };
    const prefix = txt.substr(3, 5);
    $('#gamedetected').text(prefixMap[prefix]);
    txt = txt.substr(11);

    const chess = new Chess();
    if (prefix.includes("puz")) {
        chess.clear(); // clear the board so we can place our pieces
        const alphanumeralMap = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const [playerTurn, ...pieces] = txt.split("*****");
        pieces.pop(); // remove empty string from split
        for (const piece of pieces) {
            const attributes = piece.split("-");
            const pieceColor = attributes[0][0];
            const pieceType = attributes[0][1];
            const pieceCoords = alphanumeralMap[attributes[1] - 1] + attributes[2];
            chess.put({ type: pieceType, color: pieceColor }, pieceCoords);
        }

        chess.setTurn(playerTurn);
        turn = chess.turn();
        return chess.fen();
    } else {
        const directHit = fenCache.get(txt);
        if (directHit) {
            console.log('DIRECT');
            return directHit;
        }

        const regex = /([\w+!#]+[*]+)$/;
        const lastMove = txt.match(regex)[0].split('*****')[0];
        const cacheKey = txt.replace(regex, "");
        const indirectHit = fenCache.get(cacheKey);
        if (indirectHit) {
            console.log('INDIRECT');
            chess.load(indirectHit);
            chess.move(lastMove);
        } else {
            console.log('FULL');
            const moves = txt.split("*****");
            for (let i = 0; i < moves.length; i++) {
                chess.move(moves[i]);
            }
        }

        turn = chess.turn();
        const fen = chess.fen();
        fenCache.set(txt, fen);
        return fen;
    }
}

function query_for_fen() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { queryfen: true });
    });
}

function query_for_automove(move) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { automove: true, move: move });
    });
}

$(window).on('load', function () {
    // load extension configurations
    config = {
        move_time: localStorage.getItem('move_time') || 1000,
        fen_refresh: localStorage.getItem('fen_refresh') || 100
    };

    // init chess board
    board = ChessBoard('board', {
        draggable: false,
        moveSpeed: 'fast',
        position: 'start'
    });

    // init stockfish webworker
    stockfish = new Worker('../js/stockfish.js');
    stockfish.postMessage("ucinewgame");
    stockfish.postMessage("isready");
    stockfish.onmessage = function (event) {
        let message = event.data;
        console.log(message);
        if (message.includes('bestmove')) {
            const arr = message.split(' ');
            const best = arr[1];
            const threat = arr[3];
            const toplay = (turn === 'w') ? 'White' : 'Black';
            const next = (turn === 'w') ? 'Black' : 'White';
            if (message.includes('(none)')) {
                $('#chess').text(next + ' Wins');
            } else if (message.includes('ponder')) {
                $('#chess').text(toplay + ' to play, best move is ' + best + '\n' + 'Best response for ' + next + ' is ' + threat)
            } else {
                $('#chess').text(toplay + ' to play, best move is ' + best)
            }
            if (toplay.toLowerCase() === board.orientation()) {
                query_for_automove(best);
            }
            calculating = 'no';
            // drawarrow(best, 'blue', 'overlay1');
            // drawarrow(threat, 'red', 'overlay2');
        } else if (message.includes('score mate')) {
            const arr = message.split('score mate ');
            const arr1 = arr[1].split(' ');
            const mateNum = Math.abs(parseInt(arr1[0]));
            if (mateNum === 0) {
                $('#evaluation').text("Checkmate!");
                clearArrows();
            } else {
                $('#evaluation').text("Checkmate in " + mateNum);
            }
            calculating = 'no';
        } else if (message.includes('info depth')) {
            const color = (turn === 'w') ? 1 : -1;
            const arr = message.split(" ");
            const depth = arr[2];
            const score = color * arr[9];
            $('#evaluation').text("Score: " + score / 100.0 + " at depth " + depth);
        }
        if (calculating === 'yes') {
            pr = pr + 1;
            let pro = 100 - 100 * Math.exp(-pr / 30);
            $('#progBar').attr('value', Math.round(pro));
            // clearArrows();
        }
    };

    // listen to messages from content-script
    chrome.extension.onMessage.addListener(response => {
        if (response.fenresponse === true && response.dom !== 'no') {
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            let fen = fenfrommoves(response.dom, response.orient);
            if (lastfen !== fen) {
                lastfen = fen;
                newpos(fen);
            }
        }
        return Promise.resolve("Dummy");
    });

    // query fen periodically from content-script
    query_for_fen();
    setInterval(function () {
        query_for_fen();
    }, config.fen_refresh);
    console.log(config.fen_refresh);

    // register button click listeners
    $('#analyze').on('click', () => {
        window.open('https://lichess.org/analysis?fen=' + lastfen, '_blank');
    });
    $('#config').on('click', () => {
        window.open('../options/options.html', '_blank');
    });
});

function coord(move) {
    const alphabet = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const lets = move.substring(0, 1);
    const lete = move.substring(2, 3);
    const nums = move.substring(1, 2) * 1.0;
    const nume = move.substring(3, 4) * 1.0;
    const slet = alphabet.indexOf(lets) + 1;
    const elet = alphabet.indexOf(lete) + 1;
    return (board.orientation() === 'white')
        ? {slet: slet, elet: elet, nums: nums, nume: nume}
        : {slet: 9 - slet, elet: 9 - elet, nums: 9 - nums, nume: 9 - nume};
}

function drawarrow(move, color, div) {
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

function clearArrows() {
    $('#overlay1').empty();
    $('#overlay2').empty();
}
