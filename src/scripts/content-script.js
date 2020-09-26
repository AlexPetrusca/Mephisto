let thisUrl; // the url that the content-script was loaded on
let config; // localhost configuration pulled from popup
let moving = false; // whether the content-script is performing a move

function getMovesFromPage() {
    let prefix = '';
    let res = '';
    if (thisUrl.includes('chess.com')) {
        if (thisUrl.includes('puzzles')) {
            prefix = '***ccpuz***';
            const pieceRegex = /[\w]+\.png/;

            const [_, toSquare] = getLastMoveHighlights();
            const pieceColor = toSquare.style['backgroundImage'].match(pieceRegex)[0][0];
            const turn = (pieceColor === 'w') ? 'b' : 'w';
            res += turn + '*****';

            const pieces = document.getElementsByClassName('piece');
            for (const piece of pieces) {
                const [color, type] = piece.style['backgroundImage']
                    .match(pieceRegex)[0]
                    .replace('.png', '');
                const coordsStr = piece.classList[1].substring(7);
                const coords = String.fromCharCode(96 + parseInt(coordsStr[1])) + coordsStr[3]; // 96 = 'a' - 1;
                res += `${color}-${type}-${coords}*****`;
            }
        } else {
            prefix = '***ccfen***';
            let moves = (thisUrl.includes('computer'))
                ? document.getElementsByClassName('gotomove')
                : document.getElementsByClassName('move-text-component');
            for (const move of moves) {
                res = res + move.innerText + '*****';
                if (move.parentElement.classList.contains('mhl')) {
                    break;
                }
            }
        }
    } else if (thisUrl.includes('lichess.org')) {
        prefix = '***lifen***';
        let moves = document.getElementsByTagName('u8t'); // vs player + computer
        if (moves.length === 0) {
            moves = document.getElementsByTagName('move'); // vs training
        }
        for (const move of moves) {
            let innerText = move.innerText.split('\n')[0];
            res = res + innerText + '*****';
            if (move.classList.contains('a1t')) {
                break;
            }
        }
    } else if (thisUrl.includes('blitztactics.com')) {
        prefix = '***btpuz***';

        const [_, toSquare] = getLastMoveHighlights();
        if (toSquare) {
            const lastMoveColor = toSquare.querySelector('.piece').classList[2];
            const turn = (lastMoveColor === 'w') ? 'b' : 'w';
            res += turn + '*****';

            const pieces = Array.from(document.getElementsByClassName('piece')).slice(0, -4);
            for (const piece of pieces) {
                const [color, type] = piece.classList[1];
                const coords = piece.parentElement.id;
                res += `${color}-${type}-${coords}*****`;
            }
        }
    }
    return (res) ? prefix + res : 'no';
}

function getOrientation() {
    let orientedBlack = true;
    if (thisUrl.includes('chess.com')) {
        const topLeftCoord = document.getElementsByClassName('coords-light')[0];
        orientedBlack = topLeftCoord && topLeftCoord.innerText === '1';
    } else if (thisUrl.includes('lichess.org')) {
        const fileCoords = document.getElementsByClassName('files')[0];
        orientedBlack = fileCoords && fileCoords.classList.contains('black');
    } else if (thisUrl.includes('blitztactics.com')) {
        const topLeftCoord = document.getElementsByClassName('row')[0];
        orientedBlack = topLeftCoord && topLeftCoord.innerText === '1';
    }
    return (orientedBlack) ? 'black' : 'white';
}

chrome.extension.onMessage.addListener(response => {
    if (moving) return;

    if (response.queryfen) {
        const res = getMovesFromPage();
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

function toggleMoving() {
    moving = !moving;
}

function pullConfig() {
    chrome.runtime.sendMessage({ pullConfig: true });
}

window.onload = () => {
    console.log('Mephisto is listening!');
    thisUrl = window.location.href;
    pullConfig();
};

// -------------------------------------------------------------------------------------------

function promiseTimeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(time);
        }, time);
    });
}

function getBrowserOffsetXY() {
    const topBarHeight = window.outerHeight - window.innerHeight;
    const offsetX = window.screenX;
    const offsetY = window.screenY + topBarHeight;
    return [offsetX, offsetY];
}

function getRandomSampledXY(elem, range = 0.9) {
    const bounds = elem.getBoundingClientRect();
    const margin = (1 - range) / 2;
    const x = bounds.x + (range * Math.random() + margin) * bounds.width;
    const y = bounds.y + (range * Math.random() + margin) * bounds.height;
    return [x, y];
}

function getRandomSampledXY2(xBounds, yBounds, range = 0.9) {
    const margin = (1 - range) / 2;
    const x = xBounds.x + (range * Math.random() + margin) * xBounds.width;
    const y = yBounds.y + (range * Math.random() + margin) * yBounds.height;
    return [x, y];
}

function getScreenXY(elem) {
    const bounds = elem.getBoundingClientRect();
    const [offsetX, offsetY] = getBrowserOffsetXY();
    return [Math.floor(bounds.x + offsetX), Math.floor(bounds.y + offsetY)]
}

function getRandomSampledScreenXY(elem, range = 0.9) {
    const [x, y] = getRandomSampledXY(elem, range);
    const [offsetX, offsetY] = getBrowserOffsetXY();
    return [Math.floor(x + offsetX), Math.floor(y + offsetY)]
}

function getRandomSampledScreenXY2(xBounds, yBounds, range = 0.9) {
    const [x, y] = getRandomSampledXY2(xBounds, yBounds, range);
    const [offsetX, offsetY] = getBrowserOffsetXY();
    return [Math.floor(x + offsetX), Math.floor(y + offsetY)]
}

// -------------------------------------------------------------------------------------------

function getLastMoveHighlights() {
    let fromSquare, toSquare;
    if (thisUrl.includes('chess.com')) {
        [fromSquare, toSquare] = Array.from(document.getElementsByClassName('move-square'));
    } else if (thisUrl.includes('lichess.org')) {
        [toSquare, fromSquare] = Array.from(document.getElementsByClassName('last-move'));
    }  else if (thisUrl.includes('blitztactics.com')) {
        const board = getBoard();
        [fromSquare, toSquare] = [board.querySelector('[data-from]'), board.querySelector('[data-to]')];
    }
    return [fromSquare, toSquare];
}

function getRanksFiles() {
    let fileCoords, rankCoords;
    if (thisUrl.includes('chess.com')) {
        if (thisUrl.includes('computer')) {
            const coords = Array.from(document.getElementsByClassName('coords-item'));
            fileCoords = coords.slice(8);
            rankCoords = coords.slice(0, 8);
        } else {
            fileCoords = Array.from(document.getElementsByClassName('letter'));
            rankCoords = Array.from(document.getElementsByClassName('number'));
        }
    } else if (thisUrl.includes('lichess.org')) {
        fileCoords = Array.from(document.getElementsByClassName('files')[0].children);
        rankCoords = Array.from(document.getElementsByClassName('ranks')[0].children);
    }  else if (thisUrl.includes('blitztactics.com')) {
        fileCoords = Array.from(document.getElementsByClassName('col'));
        rankCoords = Array.from(document.getElementsByClassName('row'));
    }
    return [rankCoords, fileCoords];
}

function getBoard() {
    let board;
    if (thisUrl.includes('chess.com')) {
        if (thisUrl.includes('computer')) {
            board = document.getElementsByClassName('brd')[0];
        } else {
            board = document.getElementsByClassName('board')[0];
        }
    } else if (thisUrl.includes('lichess.org')) {
        board = document.getElementsByTagName('cg-board')[0];
    } else if (thisUrl.includes('blitztactics.com')) {
        board = document.getElementsByClassName('chessboard')[0];
    }
    return board;
}

function getPromotionSelection(promotion) {
    let promotions;
    if (thisUrl.includes('chess.com')) {
        if (thisUrl.includes('computer')) {
            const promotionModal = document.getElementById('chessboard_promotionarea_content');
            if (promotionModal) promotions = promotionModal.children;
        } else {
            const promotionElems = document.getElementsByClassName('promotion-piece');
            if (promotionElems.length) promotions = promotionElems;
        }
    } else if (thisUrl.includes('lichess.org')) {
        const promotionModal = document.getElementById('promotion-choice');
        if (promotionModal) promotions = promotionModal.children;
    }  else if (thisUrl.includes('blitztactics.com')) {
        promotions = document.getElementsByClassName('pieces')[0].children;
    }

    const promoteMap = thisUrl.includes('blitztactics.com')
        ? { 'q': 0, 'r': 1, 'n': 2, 'b': 3 }
        : { 'q': 0, 'n': 1, 'r': 2, 'b': 3 };
    const idx = promoteMap[promotion];
    return (promotions) ? promotions[idx] : undefined;
}

// -------------------------------------------------------------------------------------------

function callPythonBackend(url, data) {
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

function requestPythonBackendMove(x0, y0, x1, y1) {
    return callPythonBackend('http://localhost:8080/performMove', { x0: x0, y0: y0, x1: x1, y1: y1 });
}

function requestPythonBackendClick(x, y) {
    return callPythonBackend(`http://localhost:8080/performClick`, { x: x, y: y });
}

// -------------------------------------------------------------------------------------------

function simulateMouseEvent(target, mouseOpts) {
    let event = target.ownerDocument.createEvent('MouseEvents'),
        options = mouseOpts || {},
        opts = { // These are the default values, set up for un-modified left clicks
            type: 'click',
            canBubble: true,
            cancelable: true,
            view: target.ownerDocument.defaultView,
            detail: 1,
            screenX: 0, // The coordinates within the entire page
            screenY: 0,
            clientX: 0, // The coordinates within the viewport
            clientY: 0,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            metaKey: false, // I *think* 'meta' is 'Cmd/Apple' on Mac, and 'Windows key' on Win.
            button: 0, // 0 = left, 1 = middle, 2 = right
            relatedTarget: null,
        };

    // Merge the options with the defaults
    for (const key in options) {
        if (options.hasOwnProperty(key)) {
            opts[key] = options[key];
        }
    }

    // Pass in the options
    event.initMouseEvent(
        opts.type,
        opts.canBubble,
        opts.cancelable,
        opts.view,
        opts.detail,
        opts.screenX,
        opts.screenY,
        opts.clientX,
        opts.clientY,
        opts.ctrlKey,
        opts.altKey,
        opts.shiftKey,
        opts.metaKey,
        opts.button,
        opts.relatedTarget
    );

    // Fire the event
    target.dispatchEvent(event);
}

function simulateClick(x, y) {
    let elem = document.elementFromPoint(x, y);
    simulateMouseEvent(elem, {
        type: 'mousedown',
        clientX: x,
        clientY: y
    });
    simulateMouseEvent(elem, {
        type: 'mouseup',
        clientX: x,
        clientY: y
    });
}

function simulateClickSquare(xBounds, yBounds, range = 0.9) {
    const [x, y] = getRandomSampledXY2(xBounds, yBounds, range);
    simulateClick(x, y);
}

function simulateMove(move) {
    const [rankCoords, fileCoords] = getRanksFiles();
    // todo: rewrite below logic to use board based calculations
    const x0Bounds = fileCoords.find((coords) => {
        return coords.innerText.toLowerCase() === move[0];
    }).getBoundingClientRect();
    const y0Bounds = rankCoords.find((coords) => {
        return coords.innerText === move[1];
    }).getBoundingClientRect();
    const x1Bounds = fileCoords.find((coords) => {
        return coords.innerText.toLowerCase() === move[2];
    }).getBoundingClientRect();
    const y1Bounds = rankCoords.find((coords) => {
        return coords.innerText === move[3];
    }).getBoundingClientRect();

    function getThinkTime() {
        return config.think_time + Math.random() * config.think_variance;
    }

    function getMoveTime() {
        return config.move_time + Math.random() * config.move_variance;
    }

    async function performSimulatedMoveClicks() {
        if (config.python_autoplay_backend) {
            const [x0, y0] = getRandomSampledScreenXY2(x0Bounds, y0Bounds);
            const [x1, y1] = getRandomSampledScreenXY2(x1Bounds, y1Bounds);
            await requestPythonBackendMove(x0, y0, x1, y1);
        } else {
            simulateClickSquare(x0Bounds, y0Bounds);
            await promiseTimeout(getMoveTime());
            simulateClickSquare(x1Bounds, y1Bounds);
        }
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
                ? String.fromCharCode(97 + xIdx) + ((7 - yIdx) + 1)
                : String.fromCharCode(97 + (7 - xIdx)) + (yIdx + 1);
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
        if (config.python_autoplay_backend) {
            const [x, y] = getRandomSampledScreenXY(promotionChoice);
            await requestPythonBackendClick(x, y);
        } else {
            // todo: figure out for chess.com live mode / current solution is set true 'always promote to queen'
            setTimeout(() => {
                promotionChoice.click();
            }, 10);
        }
    }
}
