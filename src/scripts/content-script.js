let site; // the site that the content-script was loaded on (lichess, chess.com,)
let config; // localhost configuration pulled from popup
let moving = false; // whether the content-script is performing a move

const siteMap = {
    'lichess.org': 'lichess',
    'www.chess.com': 'chesscom',
    'blitztactics.com': 'blitztactics'
}

const pieceMap = {
    pawn: 'p',
    rook: 'r',
    knight: 'n',
    bishop: 'b',
    queen: 'q',
    king: 'k'
}

const colorMap = {
    white: 'w',
    black: 'b'
}

window.onload = () => {
    console.log('Mephisto is listening!');
    site = siteMap[window.location.hostname];
    pullConfig();
};

chrome.runtime.onMessage.addListener(response => {
    if (moving) return;
    if (response.queryfen) {
        const res = getMoves(config.simon_says_mode);
        const orient = getOrientation();
        chrome.runtime.sendMessage({ dom: res, orient: orient, fenresponse: true });
    } else if (response.automove) {
        toggleMoving();
        if (config.puzzle_mode) {
            console.log(response.pv);
            simulatePvMoves(response.pv.split(' ')).finally(toggleMoving);
        } else {
            console.log(response.move);
            simulateMove(response.move).finally(toggleMoving);
        }
    } else if (response.pushConfig) {
        console.log(response.config);
        config = response.config;
    } else if (response.consoleMessage) {
        console.log(response.consoleMessage);
    }
});

function getMoves(getAllMoves) {
    let prefix = '';
    let res = '';
    if (site === 'chesscom') {
        const moves = getMoveRecords();
        if (moves.length && moves[0].innerText.match(/^[\w-+=#]+$/g)) {
            prefix = '***ccfen***';
            const figurineRegex = /<span.*data-figurine="(\w)".*span>/;
            const selectedMove = getSelectedMoveRecord();
            for (const move of moves) {
                if (move.childElementCount) {
                    const [figurineHTML, figurinePiece] = move.innerHTML.match(figurineRegex);
                    res += move.innerHTML.replace(figurineHTML, figurinePiece) + '*****';
                } else {
                    res += move.innerText + '*****';
                }
                if (!getAllMoves && move === selectedMove) {
                    break;
                }
            }
        } else {
            prefix = '***ccpuz***';
            res += getTurn() + '*****';
            for (const piece of document.querySelectorAll('.piece')) {
                let color, type, coordsStr;
                if (document.querySelector('chess-board')) {
                    let [colorTypeClass, coordsClass] = [piece.classList[1], piece.classList[2]];
                    if (!coordsClass.includes('square')) {
                        [colorTypeClass, coordsClass] = [coordsClass, colorTypeClass];
                    }
                    [color, type] = colorTypeClass;
                    coordsStr = coordsClass.split('-')[1];
                } else {
                    [color, type] = piece.style.backgroundImage.match(/(\w+)\.png/)[1];
                    coordsStr = piece.classList[1].split('-')[1].replaceAll('0', '');
                }
                const coords = String.fromCharCode('a'.charCodeAt(0) + parseInt(coordsStr[0]) - 1) + coordsStr[1];
                res += `${color}-${type}-${coords}*****`;
            }
        }
    } else if (site === 'lichess') {
        const moves = getMoveRecords();
        if (moves.length && moves[0].innerText.match(/^[\w-+=#]+$/g)) {
            prefix = '***lifen***';
            const evalRegex = /<span.*data-figurine="(\w)".*span>/;
            const selectedMove = getSelectedMoveRecord();
            for (const move of moves) {
                res += move.innerHTML.match(/^[\w-+=#]+/)[0] + '*****';
                if (!getAllMoves && move === selectedMove) {
                    break;
                }
            }
        } else {
            prefix = '***lipuz***';
            res += getTurn() + '*****';
            const pieces = Array.from(document.querySelectorAll('.main-board piece'))
                .filter(piece => !!piece.classList[1]);
            for (const piece of pieces) {
                const transform = piece.style.transform;
                const xyCoords = transform.substring(transform.indexOf('(') + 1, transform.length - 1)
                    .replaceAll('px', '').replace(' ', '').split(",")
                    .map(num => Number(num) / piece.getBoundingClientRect().width + 1);
                const coords = (getOrientation() === 'black')
                    ? String.fromCharCode('h'.charCodeAt(0) - xyCoords[0] + 1) + xyCoords[1]
                    : String.fromCharCode('a'.charCodeAt(0) + xyCoords[0] - 1) + (9 - xyCoords[1]);
                if (piece.classList[0] !== "ghost") {
                    res += `${colorMap[piece.classList[0]]}-${pieceMap[piece.classList[1]]}-${coords}*****`;
                } else if (piece.style.visibility === "visible") {
                    res += `${colorMap[piece.classList[1]]}-${pieceMap[piece.classList[2]]}-${coords}*****`;
                }
            }
        }
    } else if (site === 'blitztactics') {
        prefix = '***btpuz***';
        res += getTurn() + '*****';
        const pieces = Array.from(document.querySelectorAll('.board-area piece'))
            .filter(piece => !!piece.classList[1]);
        for (const piece of pieces) {
            const transform = piece.style.transform;
            const xyCoords = transform.substring(transform.indexOf('(') + 1, transform.length - 1)
                .replaceAll('px', '').replace(' ', '').split(",")
                .map(num => Number(num) / piece.getBoundingClientRect().width + 1);
            const coords = (getOrientation() === 'black')
                ? String.fromCharCode('h'.charCodeAt(0) - xyCoords[0] + 1) + xyCoords[1]
                : String.fromCharCode('a'.charCodeAt(0) + xyCoords[0] - 1) + (9 - xyCoords[1]);
            if (piece.classList[0] !== "ghost") {
                res += `${colorMap[piece.classList[0]]}-${pieceMap[piece.classList[1]]}-${coords}*****`;
            } else if (piece.style.visibility === "visible") {
                res += `${colorMap[piece.classList[1]]}-${pieceMap[piece.classList[2]]}-${coords}*****`;
            }
        }
    }
    console.log((res) ? prefix + res.replace(/[^\w-+#*]/g, '') : 'no');
    return (res) ? prefix + res.replace(/[^\w-+=#*]/g, '') : 'no';
}

function getOrientation() {
    let orientedBlack = true;
    if (site === 'chesscom') {
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

function toggleMoving() {
    moving = !moving;
}

function pullConfig() {
    chrome.runtime.sendMessage({ pullConfig: true });
}

// -------------------------------------------------------------------------------------------

function getSelectedMoveRecord() {
    let selectedMove;
    if (site === 'chesscom') {
        selectedMove = document.querySelector('.node.selected') // vs player + computer (new)
            || document.querySelector('.move-node-highlighted .move-text-component') // vs player + computer (old)
            || document.querySelector('.move-node.selected .move-text'); // analysis
    } else if (site === 'lichess') {
        selectedMove = document.querySelector('u8t.a1t')
            || document.querySelector('move.active');
    }
    return selectedMove;
}

function getMoveRecords() {
    let moves;
    if (site === 'chesscom') {
        moves = document.querySelectorAll('.node'); // vs player + computer (new)
        if (moves.length === 0) {
            moves = document.querySelectorAll('.move-text-component'); // vs player + computer (old)
        }
        if (moves.length === 0) {
            moves = document.querySelectorAll('.move-text'); // analysis
        }
    } else if (site === 'lichess') {
        moves = document.querySelectorAll('u8t'); // vs player + computer
        if (moves.length === 0) {
            moves = document.querySelectorAll('move'); // vs training
        }
    }
    return moves;
}

function getLastMoveHighlights() {
    let fromSquare, toSquare;
    if (site === 'chesscom') {
        let highlights = document.querySelectorAll('.highlight');
        if (highlights.length === 0) {
            highlights = document.querySelectorAll('.move-square');
        }
        [fromSquare, toSquare] = Array.from(highlights);
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
    }  else if (site === 'blitztactics') {
        [fromSquare, toSquare] = [document.querySelector('.move-from'), document.querySelector('.move-to')];
    }
    return [fromSquare, toSquare];
}

function getTurn() {
    let turn;
    const [_, toSquare] = getLastMoveHighlights();
    if (site === 'chesscom') {
        const hlPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        const hlColorType = (document.querySelector('chess-board'))
            ? Array.from(hlPiece.classList).find(c => c.match(/[wb][prnbkq]/))
            : hlPiece.style.backgroundImage.match(/(\w+)\.png/)[1];
        turn = (hlColorType[0] === 'w') ? 'b' : 'w';
    } else if (site === 'lichess') {
        const toPiece = Array.from(document.querySelectorAll('.main-board piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = (toPiece.classList.contains('white')) ? 'b' : 'w';
    } else if (site === 'blitztactics') {
        const toPiece = Array.from(document.querySelectorAll('.board-area piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = (toPiece.classList.contains('white')) ? 'b' : 'w';
    }
    return turn;
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
    }  else if (site === 'blitztactics') {
        fileCoords = Array.from(document.querySelector('.files').children);
        rankCoords = Array.from(document.querySelector('.ranks').children);
    }
    return [rankCoords, fileCoords];
}

function getBoard() {
    let board;
    if (site === 'chesscom') {
        board = document.querySelector('.board');
    } else if (site === 'lichess') {
        board = document.querySelector('cg-board');
    } else if (site === 'blitztactics') {
        board = document.querySelector('cg-board');
    }
    return board;
}

function getPromotionSelection(promotion) {
    let promotions;
    if (site === 'chesscom') {
        const promotionElems = document.querySelectorAll('.promotion-piece');
        if (promotionElems.length) promotions = promotionElems;
    } else if (site === 'lichess') {
        const promotionModal = document.querySelector('#promotion-choice');
        if (promotionModal) promotions = promotionModal.children;
    }  else if (site === 'blitztactics') {
        promotions = document.querySelector('.pieces').children;
    }

    const promoteMap = (site === 'blitztactics')
        ? { 'q': 0, 'r': 1, 'n': 2, 'b': 3 }
        : { 'q': 0, 'n': 1, 'r': 2, 'b': 3 };
    const idx = promoteMap[promotion];
    return (promotions) ? promotions[idx] : undefined;
}

// -------------------------------------------------------------------------------------------

function promiseTimeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(time), time);
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
    const x = bounds.x + (range * Math.random() + margin) * bounds.width;
    const y = bounds.y + (range * Math.random() + margin) * bounds.height;
    const [correctX, correctY] = getOffsetCorrectionXY();
    return [x + correctX, y + correctY];
}

// -------------------------------------------------------------------------------------------

function dispatchSimulateClick(x, y) {
    console.log([x, y]);
    chrome.runtime.sendMessage({
        click: true,
        x: x,
        y: y
    });
}

function simulateClickSquare(bounds, range = 0.8) {
    const [x, y] = getRandomSampledXY(bounds, range);
    dispatchSimulateClick(x, y);
}

function simulateMove(move) {
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
        return config.think_time + Math.random() * config.think_variance;
    }

    function getMoveTime() {
        return config.move_time + Math.random() * config.move_variance;
    }

    async function performSimulatedMoveClicks() {
        simulateClickSquare(getBoundsFromCoords(move.substring(0, 2)));
        await promiseTimeout(getMoveTime());
        simulateClickSquare(getBoundsFromCoords(move.substring(2)));
    }

    async function performSimulatedMoveSequence() {
        await promiseTimeout(getThinkTime());
        await performSimulatedMoveClicks();
        if (move[4]) {
            await promiseTimeout(getMoveTime());
            await simulatePromotionClicks(move[4]); // conditional promotion click
        }
    }

    return performSimulatedMoveSequence();
}

function simulatePvMoves(pv) {
    const boardBounds = getBoard().getBoundingClientRect();

    function deriveLastMove() {
        function deriveCoords(square) {
            if (!square) return "no";
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
            runtime += await promiseTimeout(config.fen_refresh);
            const observedLastMove = deriveLastMove();
            if (observedLastMove !== lastMove) {
                return observedLastMove === move;
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

// todo: needs to be rewritten to work with debugger click and python backend
async function simulatePromotionClicks(promotion) {
    const promotionChoice = getPromotionSelection(promotion);
    if (promotionChoice) {
        simulateClickSquare(promotionChoice.getBoundingClientRect())
    }
}
