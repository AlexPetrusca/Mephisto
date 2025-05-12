let site; // the site that the content-script was loaded on (lichess, chess.com, blitztactics.com)
let config; // configuration pulled from popup
let startPosCache; // cache of non-standard starting positions as puzzle strings (to support chess960)
let moving = false; // whether the content-script is performing a move

const LOCAL_CACHE = 'mephisto.startPosCache';
const DEFAULT_POSITION = 'w*****b-r-a8*****b-n-b8*****b-b-c8*****b-q-d8*****b-k-e8*****b-b-f8*****b-n-g8*****' +
    'b-r-h8*****b-p-a7*****b-p-b7*****b-p-c7*****b-p-d7*****b-p-e7*****b-p-f7*****b-p-g7*****b-p-h7*****' +
    'w-p-a2*****w-p-b2*****w-p-c2*****w-p-d2*****w-p-e2*****w-p-f2*****w-p-g2*****w-p-h2*****w-r-a1*****' +
    'w-n-b1*****w-b-c1*****w-q-d1*****w-k-e1*****w-b-f1*****w-n-g1*****w-r-h1*****';

window.onload = () => {
    console.log('Mephisto is listening!');
    const siteMap = {
        'lichess.org': 'lichess',
        'www.chess.com': 'chesscom',
        'blitztactics.com': 'blitztactics'
    };
    site = siteMap[window.location.hostname];
    pullConfig();
    determineStartPosition();
};

chrome.runtime.onMessage.addListener(response => {
    if (moving) return;
    if (response.queryfen) {
        if (!config) return;
        const res = scrapePosition();
        const orient = getOrientation();
        chrome.runtime.sendMessage({ dom: res, orient: orient, fenresponse: true });
    } else if (response.automove) {
        toggleMoving();
        if (config.puzzle_mode) {
            console.log(response.pv);
            simulatePvMoves(response.pv).finally(toggleMoving);
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

function scrapePosition() {
    if (!getBoard()) return;

    let prefix = '';
    if (site === 'chesscom') {
        prefix += '***cc'
    } else if (site === 'lichess') {
        prefix += '***li'
    } else if (site === 'blitztactics') {
        prefix += '***bt'
    }

    let res;
    if (config.variant === 'chess') {
        if (getMoveContainer()) {
            prefix += 'fen***';
            res = scrapePositionFen(getMoveRecords());
        } else {
            prefix += 'puz***';
            res = scrapePositionPuz();
        }
    } else {
        prefix += 'var***';
        if (config.variant === 'fischerandom') {
            const startPos = readStartPos(location.href)?.position || DEFAULT_POSITION;
            res = startPos + '&*****';
        }
        const moves = getMoveRecords();
        res += (moves?.length) ? scrapePositionFen(moves) : '?';
    }

    if (res != null) {
        console.log(prefix + res.replace(/[^\w-+#*@&]/g, ''), getBoard().getAttributeNames().join(" "));
        return prefix + res.replace(/[^\w-+=#*@&]/g, '');
    } else {
        return 'no';
    }
}

function scrapePositionFen(moves) {
    let res = '';
    const selectedMove = getSelectedMoveRecord();
    if (!selectedMove) {
        return res;
    }
    if (site === 'chesscom') {
        for (const moveWrapper of moves) {
            const move = moveWrapper.lastElementChild
            if (move.lastElementChild?.classList.contains('icon-font-chess')) {
                res += move.lastElementChild.getAttribute('data-figurine') + move.innerText + '*****';
            } else {
                res += move.innerText + '*****';
            }
            if (!config.simon_says_mode && move === selectedMove) {
                break;
            }
        }
    } else if (site === 'lichess') {
        for (const move of moves) {
            res += move.innerText.replace(/\n.*/, '') + '*****';
            if (!config.simon_says_mode && move === selectedMove) {
                break;
            }
        }
    }
    return res;
}

function scrapePositionPuz() {
    if (isAnimating()) {
        throw Error("Board is animating. Can't scrape.")
    }
    let res = getTurn() + '*****';
    if (site === 'chesscom') {
        for (const piece of getPieces()) {
            let [colorTypeClass, coordsClass] = [piece.classList[1], piece.classList[2]];
            if (!coordsClass.includes('square')) {
                [colorTypeClass, coordsClass] = [coordsClass, colorTypeClass];
            }
            const [color, type] = colorTypeClass;
            const coordsStr = coordsClass.split('-')[1];
            const coords = String.fromCharCode('a'.charCodeAt(0) + parseInt(coordsStr[0]) - 1) + coordsStr[1];
            res += `${color}-${type}-${coords}*****`;
        }
    } else {
        const pieceMap = {pawn: 'p', rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k'};
        const colorMap = {white: 'w', black: 'b'};
        for (const piece of getPieces()) {
            let transform;
            if (piece.classList.contains('dragging')) {
                transform = document.querySelector('.ghost').style.transform;
            } else {
                transform = piece.style.transform;
            }
            const xyCoords = transform.substring(transform.indexOf('(') + 1, transform.length - 1)
                .replaceAll('px', '').replace(' ', '').split(',')
                .map(num => Number(num) / piece.getBoundingClientRect().width + 1);
            const coords = (getOrientation() === 'black')
                ? String.fromCharCode('h'.charCodeAt(0) - xyCoords[0] + 1) + xyCoords[1]
                : String.fromCharCode('a'.charCodeAt(0) + xyCoords[0] - 1) + (9 - xyCoords[1]);
            if (piece.classList[0] !== 'ghost') {
                res += `${colorMap[piece.classList[0]]}-${pieceMap[piece.classList[1]]}-${coords}*****`;
            }
        }
    }
    return res;
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
        selectedMove = document.querySelector('.node .selected') // vs player + computer (new)
            || document.querySelector('.move-node-highlighted .move-text-component') // vs player + computer (old)
            || document.querySelector('.move-node.selected .move-text'); // analysis
    } else if (site === 'lichess') {
        selectedMove = document.querySelector('kwdb.a1t')
            || document.querySelector('move.active');
    }
    return selectedMove;
}

function getMoveRecords() {
    let moves;
    if (site === 'chesscom') {  // wc-chess-board
        moves = document.querySelectorAll('.node'); // vs player + computer (new)
        if (moves.length === 0) {
            moves = document.querySelectorAll('.move-text-component'); // vs player + computer (old)
        }
        if (moves.length === 0) {
            moves = document.querySelectorAll('.move-text'); // analysis
        }
    } else if (site === 'lichess') { // cg-board
        moves = document.querySelectorAll('kwdb'); // vs player + computer
        if (moves.length === 0) {
            moves = document.querySelectorAll('move'); // vs training
        }
    }
    return moves;
}

function getMoveContainer() {
    let moveContainer;
    if (site === 'chesscom') {
        moveContainer = document.querySelector('wc-simple-move-list');
    } else if (site === 'lichess') {
        moveContainer = document.querySelector('l4x'); // vs player + computer
        if (!moveContainer) {
            moveContainer = document.querySelector('.tview2'); // vs training
        }
    }
    return moveContainer;
}

function getLastMoveHighlights() {
    let fromSquare, toSquare;
    if (site === 'chesscom') {
        const highlights = [];
        for (const elem of getBoard().children) {
            if (elem.classList.contains('coordinates')) continue;
            if (elem.classList.contains('element-pool')) continue;
            if (elem.classList.contains('hover-square')) break;
            highlights.push(elem);
        }
        if (highlights.length === 2) {
            [fromSquare, toSquare] = [highlights[0], highlights[1]];
        } else {
            [fromSquare, toSquare] = [highlights[1], highlights[2]];
        }
        if (!fromSquare.classList.contains('highlight') || !toSquare.classList.contains('highlight')) {
            throw Error('Invalid last move highlights');
        }
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
    } else if (site === 'blitztactics') {
        [fromSquare, toSquare] = [document.querySelector('.move-from'), document.querySelector('.move-to')];
    }

    if (!fromSquare || !toSquare) {
        throw Error('Last move highlights not found');
    }
    return [fromSquare, toSquare];
}

function getTurn() {
    let toSquare;
    try {
        toSquare = getLastMoveHighlights()[1];
    } catch (e) {
        if (getMoveContainer()) {
            console.log("getMoveContainer():", getMoveContainer());
            return 'w'; // if starting position, white goes first
        } else {
            return (getOrientation() === 'black') ? 'w' : 'b'; // if puzzle, the opposite player moves first
        }
    }

    let turn;
    if (site === 'chesscom') {
        const hlPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        const hlColorType = Array.from(hlPiece.classList).find(c => c.match(/[wb][prnbkq]/));
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
    } else if (site === 'blitztactics') {
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
        board = document.querySelector('.main-board');
    } else if (site === 'blitztactics') {
        board = document.querySelector('.chessground-board');
    }
    return board;
}

function getPieces() {
    if (site === 'chesscom') {
        return document.querySelectorAll('.piece');
    } else {
        let pieceSelector;
        if (site === 'lichess') {
            pieceSelector = '.main-board piece';
        } else if (site === 'blitztactics') {
            pieceSelector = '.board-area piece';
        }
        return Array.from(document.querySelectorAll(pieceSelector)).filter(piece => !!piece.classList[1]);
    }
}

function getPromotionSelection(promotion) {
    let promotions;
    if (site === 'chesscom') {
        const promotionElems = document.querySelectorAll('.promotion-piece');
        if (promotionElems.length) promotions = promotionElems;
    } else if (site === 'lichess') {
        const promotionModal = document.querySelector('#promotion-choice');
        if (promotionModal) promotions = promotionModal.children;
    } else if (site === 'blitztactics') {
        promotions = document.querySelector('.pieces').children;
    }

    const promoteMap = (site === 'chesscom')
        ? { 'b': 0, 'n': 1, 'q': 2, 'r': 3 }
        : (site === 'lichess')
            ? { 'q': 0, 'n': 1, 'r': 2, 'b': 3 }
            : { 'q': 0, 'r': 1, 'n': 2, 'b': 3 };
    const idx = promoteMap[promotion];
    return (promotions) ? promotions[idx] : undefined;
}

function isAnimating() {
    let anim;
    if (site === 'chesscom') {
        anim = getBoard().getAttribute('data-test-animating');
    } else if (site === 'lichess' || site === 'blitztactics') {
        anim = getBoard().querySelector('piece.anim');
    }
    return !!anim;
}

// -------------------------------------------------------------------------------------------

function loadStartPosCache() {
    const cache = new LRU(10);
    const entries = JSON.parse(localStorage.getItem(LOCAL_CACHE)) || [];
    for (const entry of entries.reverse()) {
        cache.set(entry.key, entry.value);
    }
    return cache;
}

function saveStartPosCache() {
    localStorage.setItem(LOCAL_CACHE, JSON.stringify(startPosCache.toJSON()));
}

function readStartPos(url) {
    const startPos = startPosCache.get(url);
    saveStartPosCache();
    return startPos;
}

function writeStartPos(url, startPos) {
    startPosCache.set(url, startPos);
    saveStartPosCache();
}

function determineStartPosition() {
    startPosCache = loadStartPosCache();
    // scrape the position when the board and pieces are present
    let retryCount = 0;
    const intervalId = setInterval(() => {
        if (getBoard() && getPieces()?.length) { // board and pieces are present?
            clearInterval(intervalId);
            onPositionLoad();
        }
        if (++retryCount >= 10) { // give up after 1s
            console.error('Unable to determine starting position (timeout after 1s)');
            clearInterval(intervalId);
        }
    }, 100); // check every 100ms
}


function onPositionLoad() {
    // cache position, if it's a non-standard starting position
    if (!getMoveRecords()?.length) { // is stating position?
        const position = scrapePositionPuz();
        if (position !== DEFAULT_POSITION) { // is non-standard?
            writeStartPos(location.href, {
                position: position,
                timestamp: Date.now()
            })
        }
    }
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
            if (!square) return 'no';
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

async function simulatePromotionClicks(promotion) {
    const promotionChoice = getPromotionSelection(promotion);
    if (promotionChoice) {
        await simulateClickSquare(promotionChoice.getBoundingClientRect())
    }
}
