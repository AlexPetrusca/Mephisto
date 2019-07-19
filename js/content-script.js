function movefromdiv() {
    const thisurl = window.location.href;
    let res = "";
    if (thisurl.includes('chess.com')) {
        if (thisurl.includes('puzzles')) {
            const pieceRegex = /[\w]+\.png/;
            const coordsRegex = /0/g;

            const prevMove = document.getElementsByClassName('move-square');
            for (const highlight of prevMove) {
                const bounds = highlight.getBoundingClientRect();
                const x = bounds.x + bounds.width / 2;
                const y = bounds.y + bounds.height / 2;
                const elemImgSrc = document.elementFromPoint(x, y).style['backgroundImage'];
                if (elemImgSrc) {
                    const turn = (elemImgSrc.match(pieceRegex)[0][0] === 'w') ? 'b' : 'w';
                    console.log(turn);
                    res += turn + '*****';
                }
            }

            const pieces = document.getElementsByClassName("piece");
            for (const piece of pieces) {
                const pieceType = piece.style["backgroundImage"].match(pieceRegex)[0].replace(".png", "");
                const pieceCoords = piece.classList[1].substring(7).replace(coordsRegex, "-");
                res += pieceType + pieceCoords + '*****';
            }
            if (res !== "") {
                return '***ccpuz***' + res;
            }
        } else {
            // console.log(" trying chess.com");
            let moves = document.getElementsByClassName("move-text-component"); // vs player
            if (moves.length === 0) {
                moves = document.getElementsByClassName("gotomove"); // vs computer
            }
            for (const move of moves) {
                res = res + move.innerText + '*****';
                if (move.parentElement.classList.contains('mhl')) {
                    break;
                }
            }
            if (res !== "") {
                return '***ccfen***' + res;
            }
        }
    } else if (thisurl.includes('lichess.org')) {
        // console.log(" trying lichess.com");
        let moves = document.getElementsByTagName("m2"); // vs player + computer
        if (moves.length === 0) {
            moves = document.getElementsByTagName("move"); // vs training
        }
        for (const move of moves) {
            let innerText = move.innerText.split("\n")[0];
            res = res + innerText + '*****';
            if (move.classList.contains('active')) {
                break;
            }
        }
        if (res !== "") {
            return '***lifen***' + res;
        }
    }
    return res;
}

function orientfromdiv(txt) {
    let orient = 'white';
    if (txt.includes("***ccfen***") || txt.includes("***ccpuz***")) {
        let topLeftCoord = document.getElementsByClassName('coords-light')[0];
        if (topLeftCoord.innerText === '1') {
            orient = 'black'
        }
    } else if (txt.includes("***lifen***")) {
        let black = document.getElementsByClassName('orientation-black');
        if (black.length !== 0) {
            orient = 'black';
        }
    }
    return orient;
}

console.log("Mephisto is listening!");
chrome.extension.onMessage.addListener(response => {
    if (response.queryfen) {
        let res = movefromdiv();
        let orient = orientfromdiv(res);
        if (res.length < 5) {
            res = 'no';
        }
        chrome.runtime.sendMessage({dom: res, orient: orient, fenresponse: true});
    } else if (response.automove) {
        console.log(response.move);
        simulateMove(response.move);
    }
    return Promise.resolve("Dummy");
});


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
            metaKey: false, // I *think* 'meta' is 'Cmd/Apple' on Mac, and 'Windows key' on Win. Not sure, though!
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

function simulateElemClick(elem, x, y) {
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

function clickSquare(xBounds, yBounds) {
    const x = xBounds.x + (1 - 1 / 2 * Math.random()) * xBounds.width;
    const y = yBounds.y + (1 - 1 / 2 * Math.random()) * yBounds.height;
    simulateClick(x, y);
}


function simulateMove(move) {
    const thisurl = window.location.href;
    let letterCoords;
    let numberCoords;
    if (thisurl.includes("chess.com")) {
        letterCoords = Array.from(document.getElementsByClassName('letter'));
        numberCoords = Array.from(document.getElementsByClassName('number'));
    } else {
        letterCoords = Array.from(document.getElementsByClassName('files')[0].children);
        numberCoords = Array.from(document.getElementsByClassName('ranks')[0].children);
    }

    const x0Elem = letterCoords.find((coords) => {
        return coords.innerText.toLowerCase() === move[0];
    });
    const y0Elem = numberCoords.find((coords) => {
        return coords.innerText === move[1];
    });
    const x1Elem = letterCoords.find((coords) => {
        return coords.innerText.toLowerCase() === move[2];
    });
    const y1Elem = numberCoords.find((coords) => {
        return coords.innerText === move[3];
    });

    const x0Bounds = x0Elem.getBoundingClientRect();
    const y0Bounds = y0Elem.getBoundingClientRect();
    clickSquare(x0Bounds, y0Bounds);

    const x1Bounds = x1Elem.getBoundingClientRect();
    const y1Bounds = y1Elem.getBoundingClientRect();
    clickSquare(x1Bounds, y1Bounds);
}
