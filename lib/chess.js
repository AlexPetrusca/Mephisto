/**
 * @license
 * Copyright (c) 2023, Jeff Hlywa (jhlywa@gmail.com)
 * All rights reserved.
 *
 * Modified by Alexandru Petruscq, 2024.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

export const WHITE = 'w';
export const BLACK = 'b';

export const PAWN = 'p';
export const KNIGHT = 'n';
export const BISHOP = 'b';
export const ROOK = 'r';
export const QUEEN = 'q';
export const KING = 'k';

// ✅ move gen is implemented correctly
export const CHESS = 'chess';
// ❌ todo: special move gen (castling)
export const CHESS960 = 'fischerandom';
// ❌ todo: special move gen
export const CRAZYHOUSE = 'crazyhouse';
// ✅ same move gen as chess
export const KING_OF_THE_HILL = 'kingofthehill';
// ✅ same move gen as chess
export const THREE_CHECK = '3check';
// ✅ special move gen handled
// todo: switch winner to the opposite of whoever makes the last move
export const ANTICHESS = 'antichess';
// ❌ todo: special move gen
export const ATOMIC = 'atomic';
// ✅ special move gen handled
export const HORDE = 'horde';
// ✅ special move gen handled
export const RACING_KINGS = 'racingkings';

export const DEFAULT_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const EMPTY = -1;

const FLAGS = {
    NORMAL: 'n',
    CAPTURE: 'c',
    BIG_PAWN: 'b',
    EP_CAPTURE: 'e',
    PROMOTION: 'p',
    KSIDE_CASTLE: 'k',
    QSIDE_CASTLE: 'q',
};

export const SQUARES = [
    'a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8',
    'a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7',
    'a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6',
    'a5', 'b5', 'c5', 'd5', 'e5', 'f5', 'g5', 'h5',
    'a4', 'b4', 'c4', 'd4', 'e4', 'f4', 'g4', 'h4',
    'a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3',
    'a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2',
    'a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1'
];

const BITS = {
    NORMAL: 1,
    CAPTURE: 2,
    BIG_PAWN: 4,
    EP_CAPTURE: 8,
    PROMOTION: 16,
    KSIDE_CASTLE: 32,
    QSIDE_CASTLE: 64,
};

/*
 * NOTES ABOUT 0x88 MOVE GENERATION ALGORITHM
 * ----------------------------------------------------------------------------
 * From https://github.com/jhlywa/chess.js/issues/230
 *
 * A lot of people are confused when they first see the internal representation
 * of chess.js. It uses the 0x88 Move Generation Algorithm which internally
 * stores the board as an 8x16 array. This is purely for efficiency but has a
 * couple of interesting benefits:
 *
 * 1. 0x88 offers a very inexpensive "off the board" check. Bitwise AND (&) any
 *    square with 0x88, if the result is non-zero then the square is off the
 *    board. For example, assuming a knight square A8 (0 in 0x88 notation),
 *    there are 8 possible directions in which the knight can move. These
 *    directions are relative to the 8x16 board and are stored in the
 *    PIECE_OFFSETS map. One possible move is A8 - 18 (up one square, and two
 *    squares to the left - which is off the board). 0 - 18 = -18 & 0x88 = 0x88
 *    (because of two-complement representation of -18). The non-zero result
 *    means the square is off the board and the move is illegal. Take the
 *    opposite move (from A8 to C7), 0 + 18 = 18 & 0x88 = 0. A result of zero
 *    means the square is on the board.
 *
 * 2. The relative distance (or difference) between two squares on a 8x16 board
 *    is unique and can be used to inexpensively determine if a piece on a
 *    square can attack any other arbitrary square. For example, let's see if a
 *    pawn on E7 can attack E2. The difference between E7 (20) - E2 (100) is
 *    -80. We add 119 to make the ATTACKS array index non-negative (because the
 *    worst case difference is A8 - H1 = -119). The ATTACKS array contains a
 *    bitmask of pieces that can attack from that distance and direction.
 *    ATTACKS[-80 + 119=39] gives us 24 or 0b11000 in binary. Look at the
 *    PIECE_MASKS map to determine the mask for a given piece type. In our pawn
 *    example, we would check to see if 24 & 0x1 is non-zero, which it is
 *    not. So, naturally, a pawn on E7 can't attack a piece on E2. However, a
 *    rook can since 24 & 0x8 is non-zero. The only thing left to check is that
 *    there are no blocking pieces between E7 and E2. That's where the RAYS
 *    array comes in. It provides an offset (in this case 16) to add to E7 (20)
 *    to check for blocking pieces. E7 (20) + 16 = E6 (36) + 16 = E5 (52) etc.
 */

const Ox88 = {
    a8: 0, b8: 1, c8: 2, d8: 3, e8: 4, f8: 5, g8: 6, h8: 7,
    a7: 16, b7: 17, c7: 18, d7: 19, e7: 20, f7: 21, g7: 22, h7: 23,
    a6: 32, b6: 33, c6: 34, d6: 35, e6: 36, f6: 37, g6: 38, h6: 39,
    a5: 48, b5: 49, c5: 50, d5: 51, e5: 52, f5: 53, g5: 54, h5: 55,
    a4: 64, b4: 65, c4: 66, d4: 67, e4: 68, f4: 69, g4: 70, h4: 71,
    a3: 80, b3: 81, c3: 82, d3: 83, e3: 84, f3: 85, g3: 86, h3: 87,
    a2: 96, b2: 97, c2: 98, d2: 99, e2: 100, f2: 101, g2: 102, h2: 103,
    a1: 112, b1: 113, c1: 114, d1: 115, e1: 116, f1: 117, g1: 118, h1: 119
};

const PAWN_OFFSETS = {
    b: [16, 32, 17, 15],
    w: [-16, -32, -17, -15],
};

const PIECE_OFFSETS = {
    n: [-18, -33, -31, -14, 18, 33, 31, 14],
    b: [-17, -15, 17, 15],
    r: [-16, 1, 16, -1],
    q: [-17, -16, -15, 1, 17, 16, 15, -1],
    k: [-17, -16, -15, 1, 17, 16, 15, -1],
};

const ATTACKS = [
    20, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 20, 0,
    0, 20, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 20, 0, 0,
    0, 0, 20, 0, 0, 0, 0, 24, 0, 0, 0, 0, 20, 0, 0, 0,
    0, 0, 0, 20, 0, 0, 0, 24, 0, 0, 0, 20, 0, 0, 0, 0,
    0, 0, 0, 0, 20, 0, 0, 24, 0, 0, 20, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 20, 2, 24, 2, 20, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 2, 53, 56, 53, 2, 0, 0, 0, 0, 0, 0,
    24, 24, 24, 24, 24, 24, 56, 0, 56, 24, 24, 24, 24, 24, 24, 0,
    0, 0, 0, 0, 0, 2, 53, 56, 53, 2, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 20, 2, 24, 2, 20, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 20, 0, 0, 24, 0, 0, 20, 0, 0, 0, 0, 0,
    0, 0, 0, 20, 0, 0, 0, 24, 0, 0, 0, 20, 0, 0, 0, 0,
    0, 0, 20, 0, 0, 0, 0, 24, 0, 0, 0, 0, 20, 0, 0, 0,
    0, 20, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 20, 0, 0,
    20, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 20
];

const RAYS = [
    17, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 15, 0,
    0, 17, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 15, 0, 0,
    0, 0, 17, 0, 0, 0, 0, 16, 0, 0, 0, 0, 15, 0, 0, 0,
    0, 0, 0, 17, 0, 0, 0, 16, 0, 0, 0, 15, 0, 0, 0, 0,
    0, 0, 0, 0, 17, 0, 0, 16, 0, 0, 15, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 17, 0, 16, 0, 15, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 17, 16, 15, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1, 0, -1, -1, -1, -1, -1, -1, -1, 0,
    0, 0, 0, 0, 0, 0, -15, -16, -17, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, -15, 0, -16, 0, -17, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, -15, 0, 0, -16, 0, 0, -17, 0, 0, 0, 0, 0,
    0, 0, 0, -15, 0, 0, 0, -16, 0, 0, 0, -17, 0, 0, 0, 0,
    0, 0, -15, 0, 0, 0, 0, -16, 0, 0, 0, 0, -17, 0, 0, 0,
    0, -15, 0, 0, 0, 0, 0, -16, 0, 0, 0, 0, 0, -17, 0, 0,
    -15, 0, 0, 0, 0, 0, 0, -16, 0, 0, 0, 0, 0, 0, -17
];

const PIECE_MASKS = {p: 0x1, n: 0x2, b: 0x4, r: 0x8, q: 0x10, k: 0x20};

const SYMBOLS = 'pnbrqkPNBRQK';

const PROMOTIONS = [KNIGHT, BISHOP, ROOK, QUEEN];

const RANK_1 = 7;
const RANK_2 = 6;
const RANK_7 = 1;
const RANK_8 = 0;

const FIRST_RANK = {b: RANK_8, w: RANK_1};
const SECOND_RANK = {b: RANK_7, w: RANK_2};

const SIDES = {
    [KING]: BITS.KSIDE_CASTLE,
    [QUEEN]: BITS.QSIDE_CASTLE,
};

const ROOKS = {
    w: [
        {square: Ox88.a1, flag: BITS.QSIDE_CASTLE},
        {square: Ox88.h1, flag: BITS.KSIDE_CASTLE},
    ],
    b: [
        {square: Ox88.a8, flag: BITS.QSIDE_CASTLE},
        {square: Ox88.h8, flag: BITS.KSIDE_CASTLE},
    ],
};

// Extracts the zero-based rank of an 0x88 square.
function rank(square) {
    return square >> 4;
}

// Extracts the zero-based file of an 0x88 square.
function file(square) {
    return square & 0xf;
}

function isDigit(c) {
    return '0123456789'.indexOf(c) !== -1;
}

// Converts a 0x88 square to algebraic notation.
function algebraic(square) {
    const f = file(square);
    const r = rank(square);
    return ('abcdefgh'.substring(f, f + 1) +
        '87654321'.substring(r, r + 1));
}

function swapColor(color) {
    return color === WHITE ? BLACK : WHITE;
}

// this function is used to uniquely identify ambiguous moves
function getDisambiguator(move, moves) {
    const from = move.from;
    const to = move.to;
    const piece = move.piece;

    let ambiguities = 0;
    let sameRank = 0;
    let sameFile = 0;

    for (let i = 0, len = moves.length; i < len; i++) {
        const ambigFrom = moves[i].from;
        const ambigTo = moves[i].to;
        const ambigPiece = moves[i].piece;

        /*
         * if a move of the same piece type ends on the same to square, we'll need
         * to add a disambiguator to the algebraic notation
         */
        if (piece === ambigPiece && from !== ambigFrom && to === ambigTo) {
            ambiguities++;
            if (rank(from) === rank(ambigFrom)) {
                sameRank++;
            }
            if (file(from) === file(ambigFrom)) {
                sameFile++;
            }
        }
    }

    if (ambiguities > 0) {
        if (sameRank > 0 && sameFile > 0) {
            /*
             * if there exists a similar moving piece on the same rank and file as
             * the move in question, use the square as the disambiguator
             */
            return algebraic(from);
        } else if (sameFile > 0) {
            /*
             * if the moving piece rests on the same file, use the rank symbol as the
             * disambiguator
             */
            return algebraic(from).charAt(1);
        } else {
            // else use the file symbol
            return algebraic(from).charAt(0);
        }
    }

    return '';
}

function inferPieceType(san) {
    let pieceType = san.charAt(0);
    if (pieceType >= 'a' && pieceType <= 'h') {
        const matches = san.match(/[a-h]\d.*[a-h]\d/);
        if (matches) {
            return undefined;
        }
        return PAWN;
    }
    pieceType = pieceType.toLowerCase();
    if (pieceType === 'o') {
        return KING;
    }
    return pieceType;
}

// parses all of the decorators out of a SAN string
function strippedSan(move) {
    return move.replace(/=/, '').replace(/[+#]?[?!]*$/, '');
}

// remove last two fields in FEN string as they're not needed when checking for repetition
function trimFen(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

export class Chess {
    _board = new Array(128);
    _turn = WHITE;
    _kings = {w: EMPTY, b: EMPTY};
    _epSquare = -1;
    _halfMoves = 0;
    _moveNumber = 0;
    _history = [];
    _castling = {w: 0, b: 0};
    _variant;
    _positionCount = {}; // tracks number of times a position has been seen for repetition checking

    constructor(variant = CHESS, fen = DEFAULT_POSITION) {
        this._variant = variant;
        // In Antichess, pawns may be promoted to kings.
        if (this._variant === ANTICHESS) {
            PROMOTIONS.push(KING);
        }
        this.load(fen);
    }

    clear() {
        this._board = new Array(128);
        this._kings = {w: EMPTY, b: EMPTY};
        this._turn = WHITE;
        this._castling = {w: 0, b: 0};
        this._epSquare = EMPTY;
        this._halfMoves = 0;
        this._moveNumber = 1;
        this._history = [];
        this._positionCount = {};
    }

    load(fen) {
        let tokens = fen.split(/\s+/);

        // append commonly omitted fen tokens
        if (tokens.length >= 2 && tokens.length < 6) {
            const adjustments = ['-', '-', '0', '1'];
            fen = tokens.concat(adjustments.slice(-(6 - tokens.length))).join(' ');
        }

        tokens = fen.split(/\s+/);

        const position = tokens[0];
        let square = 0;

        this.clear();
        for (let i = 0; i < position.length; i++) {
            const piece = position.charAt(i);
            if (piece === '/') {
                square += 8;
            } else if (isDigit(piece)) {
                square += parseInt(piece, 10);
            } else {
                const color = piece < 'a' ? WHITE : BLACK;
                this._put({type: piece.toLowerCase(), color}, algebraic(square));
                square++;
            }
        }

        this._turn = tokens[1];

        if (tokens[2].indexOf('K') > -1) {
            this._castling.w |= BITS.KSIDE_CASTLE;
        }
        if (tokens[2].indexOf('Q') > -1) {
            this._castling.w |= BITS.QSIDE_CASTLE;
        }
        if (tokens[2].indexOf('k') > -1) {
            this._castling.b |= BITS.KSIDE_CASTLE;
        }
        if (tokens[2].indexOf('q') > -1) {
            this._castling.b |= BITS.QSIDE_CASTLE;
        }

        this._epSquare = tokens[3] === '-' ? EMPTY : Ox88[tokens[3]];
        this._halfMoves = parseInt(tokens[4], 10);
        this._moveNumber = parseInt(tokens[5], 10);

        this._incPositionCount(fen);
    }

    fen() {
        let empty = 0;
        let fen = '';

        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
            if (this._board[i]) {
                if (empty > 0) {
                    fen += empty;
                    empty = 0;
                }
                const {color, type: piece} = this._board[i];
                fen += color === WHITE ? piece.toUpperCase() : piece.toLowerCase();
            } else {
                empty++;
            }
            if ((i + 1) & 0x88) {
                if (empty > 0) {
                    fen += empty;
                }
                if (i !== Ox88.h1) {
                    fen += '/';
                }
                empty = 0;
                i += 8;
            }
        }

        let castling = '';
        if (this._castling[WHITE] & BITS.KSIDE_CASTLE) {
            castling += 'K';
        }
        if (this._castling[WHITE] & BITS.QSIDE_CASTLE) {
            castling += 'Q';
        }
        if (this._castling[BLACK] & BITS.KSIDE_CASTLE) {
            castling += 'k';
        }
        if (this._castling[BLACK] & BITS.QSIDE_CASTLE) {
            castling += 'q';
        }

        // do we have an empty castling flag?
        castling = castling || '-';

        let epSquare = '-';
        /*
         * only print the ep square if en passant is a valid move (pawn is present
         * and ep capture is not pinned)
         */
        if (this._epSquare !== EMPTY) {
            const bigPawnSquare = this._epSquare + (this._turn === WHITE ? 16 : -16);
            const squares = [bigPawnSquare + 1, bigPawnSquare - 1];

            for (const square of squares) {
                // is the square off the board?
                if (square & 0x88) {
                    continue;
                }

                const color = this._turn;

                // is there a pawn that can capture the epSquare?
                if (this._board[square]?.color === color && this._board[square]?.type === PAWN) {
                    // if the pawn makes an ep capture, does it leave it's king in check?
                    this._makeMove({
                        color,
                        from: square,
                        to: this._epSquare,
                        piece: PAWN,
                        captured: PAWN,
                        flags: BITS.EP_CAPTURE,
                    });
                    const isLegal = !this._isKingAttacked(color);
                    this._undoMove();

                    // if ep is legal, break and set the ep square in the FEN output
                    if (isLegal) {
                        epSquare = algebraic(this._epSquare);
                        break;
                    }
                }
            }
        }

        return [fen, this._turn, castling, epSquare, this._halfMoves, this._moveNumber].join(' ');
    }

    reset() {
        this.load(DEFAULT_POSITION);
    }

    get(square) {
        return this._board[Ox88[square]];
    }

    put({type, color}, square) {
        if (this._put({type, color}, square)) {
            this._updateCastlingRights();
            this._updateEnPassantSquare();
            return true;
        }
        return false;
    }

    _put({type, color}, square) {
        // check for piece
        if (SYMBOLS.indexOf(type.toLowerCase()) === -1) {
            return false;
        }

        // check for valid square
        if (!(square in Ox88)) {
            return false;
        }

        const sq = Ox88[square];

        // don't let the user place more than one king (unless the variant allows for it)
        if (
            type === KING &&
            !(this._kings[color] === EMPTY || this._kings[color] === sq) &&
            !(this._variant === ANTICHESS)
        ) {
            return false;
        }

        const currentPieceOnSquare = this._board[sq];

        // if one of the kings will be replaced by the piece from args, set the `_kings` respective entry to `EMPTY`
        if (currentPieceOnSquare && currentPieceOnSquare.type === KING) {
            this._kings[currentPieceOnSquare.color] = EMPTY;
        }

        this._board[sq] = {type: type, color: color};

        if (type === KING) {
            this._kings[color] = sq;
        }

        return true;
    }

    remove(square) {
        const piece = this.get(square);
        delete this._board[Ox88[square]];
        if (piece && piece.type === KING) {
            this._kings[piece.color] = EMPTY;
        }

        this._updateCastlingRights();
        this._updateEnPassantSquare();

        return piece;
    }

    _updateCastlingRights() {
        const whiteKingInPlace =
            this._board[Ox88.e1]?.type === KING &&
            this._board[Ox88.e1]?.color === WHITE;
        const blackKingInPlace =
            this._board[Ox88.e8]?.type === KING &&
            this._board[Ox88.e8]?.color === BLACK;

        if (
            !whiteKingInPlace ||
            this._board[Ox88.a1]?.type !== ROOK ||
            this._board[Ox88.a1]?.color !== WHITE
        ) {
            this._castling.w &= ~BITS.QSIDE_CASTLE;
        }

        if (
            !whiteKingInPlace ||
            this._board[Ox88.h1]?.type !== ROOK ||
            this._board[Ox88.h1]?.color !== WHITE
        ) {
            this._castling.w &= ~BITS.KSIDE_CASTLE;
        }

        if (
            !blackKingInPlace ||
            this._board[Ox88.a8]?.type !== ROOK ||
            this._board[Ox88.a8]?.color !== BLACK
        ) {
            this._castling.b &= ~BITS.QSIDE_CASTLE;
        }

        if (
            !blackKingInPlace ||
            this._board[Ox88.h8]?.type !== ROOK ||
            this._board[Ox88.h8]?.color !== BLACK
        ) {
            this._castling.b &= ~BITS.KSIDE_CASTLE;
        }
    }

    _updateEnPassantSquare() {
        if (this._epSquare === EMPTY) {
            return;
        }

        const startSquare = this._epSquare + (this._turn === WHITE ? -16 : 16);
        const currentSquare = this._epSquare + (this._turn === WHITE ? 16 : -16);
        const attackers = [currentSquare + 1, currentSquare - 1];

        if (
            this._board[startSquare] !== null ||
            this._board[this._epSquare] !== null ||
            this._board[currentSquare]?.color !== swapColor(this._turn) ||
            this._board[currentSquare]?.type !== PAWN
        ) {
            this._epSquare = EMPTY;
            return;
        }

        const canCapture = (square) =>
            !(square & 0x88) &&
            this._board[square]?.color === this._turn &&
            this._board[square]?.type === PAWN;

        if (!attackers.some(canCapture)) {
            this._epSquare = EMPTY;
        }
    }

    _attacked(color, square, verbose) {
        const attackers = [];
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
            // did we run off the end of the board
            if (i & 0x88) {
                i += 7;
                continue;
            }

            // if empty square or wrong color
            if (this._board[i] === undefined || this._board[i].color !== color) {
                continue;
            }

            const piece = this._board[i];
            const difference = i - square;

            // skip - to/from square are the same
            if (difference === 0) {
                continue;
            }

            const index = difference + 119;

            if (ATTACKS[index] & PIECE_MASKS[piece.type]) {
                if (piece.type === PAWN) {
                    if (
                        (difference > 0 && piece.color === WHITE) ||
                        (difference <= 0 && piece.color === BLACK)
                    ) {
                        if (!verbose) {
                            return true;
                        } else {
                            attackers.push(algebraic(i));
                        }
                    }
                    continue;
                }

                // if the piece is a knight or a king
                if (piece.type === 'n' || piece.type === 'k') {
                    if (!verbose) {
                        return true;
                    } else {
                        attackers.push(algebraic(i));
                        continue;
                    }
                }

                const offset = RAYS[index];
                let j = i + offset;

                let blocked = false;
                while (j !== square) {
                    if (this._board[j] != null) {
                        blocked = true;
                        break;
                    }
                    j += offset;
                }

                if (!blocked) {
                    if (!verbose) {
                        return true;
                    } else {
                        attackers.push(algebraic(i));
                    }
                }
            }
        }

        if (verbose) {
            return attackers;
        } else {
            return false;
        }
    }

    attackers(square, attackedBy) {
        if (!attackedBy) {
            return this._attacked(this._turn, Ox88[square], true);
        } else {
            return this._attacked(attackedBy, Ox88[square], true);
        }
    }

    _isKingAttacked(color) {
        const square = this._kings[color];
        return square === -1 ? false : this._attacked(swapColor(color), square);
    }

    isAttacked(square, attackedBy) {
        return this._attacked(attackedBy, Ox88[square]);
    }

    isCheck() {
        return this._isKingAttacked(this._turn);
    }

    inCheck() {
        return this.isCheck();
    }

    isCheckmate() {
        return this.isCheck() && this._moves().length === 0;
    }

    isStalemate() {
        return !this.isCheck() && this._moves().length === 0;
    }

    isInsufficientMaterial() {
        /*
         * k.b. vs k.b. (of opposite colors) with mate in 1:
         * 8/8/8/8/1b6/8/B1k5/K7 b - - 0 1
         *
         * k.b. vs k.n. with mate in 1:
         * 8/8/8/8/1n6/8/B7/K1k5 b - - 2 1
         */
        const pieces = {b: 0, n: 0, r: 0, q: 0, k: 0, p: 0};
        const bishops = [];
        let numPieces = 0;
        let squareColor = 0;

        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
            squareColor = (squareColor + 1) % 2;
            if (i & 0x88) {
                i += 7;
                continue;
            }

            const piece = this._board[i];
            if (piece) {
                pieces[piece.type] = piece.type in pieces ? pieces[piece.type] + 1 : 1;
                if (piece.type === BISHOP) {
                    bishops.push(squareColor);
                }
                numPieces++;
            }
        }

        // k vs. k
        if (numPieces === 2) {
            return true;
        } else if (
            // k vs. kn .... or .... k vs. kb
            numPieces === 3 &&
            (pieces[BISHOP] === 1 || pieces[KNIGHT] === 1)
        ) {
            return true;
        } else if (numPieces === pieces[BISHOP] + 2) {
            // kb vs. kb where any number of bishops are all on the same color
            let sum = 0;
            const len = bishops.length;
            for (let i = 0; i < len; i++) {
                sum += bishops[i];
            }
            if (sum === 0 || sum === len) {
                return true;
            }
        }

        return false;
    }

    isThreefoldRepetition() {
        return this._getPositionCount(this.fen()) >= 3;
    }

    isDraw() {
        return (this._halfMoves >= 100 || // 50 moves per side = 100 half moves
            this.isStalemate() ||
            this.isInsufficientMaterial() ||
            this.isThreefoldRepetition());
    }

    isGameOver() {
        return this.isCheckmate() || this.isStalemate() || this.isDraw();
    }

    moves({verbose = false, square = undefined, piece = undefined,} = {}) {
        const moves = this._moves({square, piece});
        if (verbose) {
            return moves.map((move) => this._makePretty(move));
        } else {
            return moves.map((move) => this._moveToSan(move, moves));
        }
    }

    _moves({legal = true, piece = undefined, square = undefined,} = {}) {
        const addMove = (moves, from, to, flags = BITS.NORMAL) => {
            const us = this._turn;
            const piece = this._board[from].type;
            let captured;
            if (flags & BITS.CAPTURE) {
                if (flags & BITS.EP_CAPTURE) {
                    captured = PAWN;
                } else {
                    captured = this._board[to].type;
                }
            }

            const r = rank(to);
            if (piece === PAWN && (r === RANK_1 || r === RANK_8)) {
                for (let i = 0; i < PROMOTIONS.length; i++) {
                    const promotion = PROMOTIONS[i];
                    moves.push({us, from, to, piece, captured, promotion, flags: flags | BITS.PROMOTION});
                }
            } else {
                moves.push({us, from, to, piece, captured, flags});
            }
        }

        const forSquare = square ? square.toLowerCase() : undefined;
        const forPiece = piece?.toLowerCase();

        const moves = [];
        const us = this._turn;
        const them = swapColor(us);

        let firstSquare = Ox88.a8;
        let lastSquare = Ox88.h1;
        let singleSquare = false;

        // are we generating moves for a single square?
        if (forSquare) {
            // illegal square, return empty moves
            if (!(forSquare in Ox88)) {
                return [];
            } else {
                firstSquare = lastSquare = Ox88[forSquare];
                singleSquare = true;
            }
        }

        for (let from = firstSquare; from <= lastSquare; from++) {
            // did we run off the end of the board
            if (from & 0x88) {
                from += 7;
                continue;
            }

            // empty square or opponent, skip
            if (!this._board[from] || this._board[from].color === them) continue;

            const {type} = this._board[from];

            let to;
            if (type === PAWN) {
                if (forPiece && forPiece !== type) continue;

                // single square, non-capturing
                to = from + PAWN_OFFSETS[us][0];
                if (!this._board[to]) {
                    addMove(moves, from, to);

                    // double square
                    to = from + PAWN_OFFSETS[us][1];
                    if (SECOND_RANK[us] === rank(from) && !this._board[to]) {
                        addMove(moves, from, to, BITS.BIG_PAWN);
                    } else if (this._variant === HORDE && FIRST_RANK[us] === rank(from) && !this._board[to]) {
                        /*
                         * In Horde, pawns on the first rank may move two squares.
                         * Pawns on the first rank that move two squares cannot be captured en-passant.
                         */
                        addMove(moves, from, to);
                    }
                }

                // pawn captures
                for (let j = 2; j < 4; j++) {
                    to = from + PAWN_OFFSETS[us][j];
                    if (to & 0x88) continue;
                    if (this._board[to]?.color === them) {
                        addMove(moves, from, to, BITS.CAPTURE);
                    } else if (to === this._epSquare) {
                        addMove(moves, from, to, BITS.CAPTURE | BITS.EP_CAPTURE);
                    }
                }
            } else {
                if (forPiece && forPiece !== type) continue;

                for (let j = 0, len = PIECE_OFFSETS[type].length; j < len; j++) {
                    const offset = PIECE_OFFSETS[type][j];
                    to = from;

                    while (true) {
                        to += offset;
                        if (to & 0x88) break;

                        if (!this._board[to]) {
                            addMove(moves, from, to);
                        } else {
                            // own color, stop loop
                            if (this._board[to].color === us) break;
                            addMove(moves, from, to, BITS.CAPTURE);
                            break;
                        }

                        // break, if knight or king
                        if (type === KNIGHT || type === KING) break;
                    }
                }
            }
        }

        /*
         * check for castling if we're:
         *   a) generating all moves, or
         *   b) doing single square move generation on the king's square
         */
        if (forPiece === undefined || forPiece === KING) {
            if (!singleSquare || lastSquare === this._kings[us]) {
                // king-side castling
                if (this._castling[us] & BITS.KSIDE_CASTLE) {
                    const castlingFrom = this._kings[us];
                    const castlingTo = castlingFrom + 2;
                    if (
                        !this._board[castlingFrom + 1] &&
                        !this._board[castlingTo] &&
                        !this._attacked(them, this._kings[us]) &&
                        !this._attacked(them, castlingFrom + 1) &&
                        !this._attacked(them, castlingTo)
                    ) {
                        addMove(moves, this._kings[us], castlingTo, BITS.KSIDE_CASTLE);
                    }
                }
                // queen-side castling
                if (this._castling[us] & BITS.QSIDE_CASTLE) {
                    const castlingFrom = this._kings[us];
                    const castlingTo = castlingFrom - 2;
                    if (
                        !this._board[castlingFrom - 1] &&
                        !this._board[castlingFrom - 2] &&
                        !this._board[castlingFrom - 3] &&
                        !this._attacked(them, this._kings[us]) &&
                        !this._attacked(them, castlingFrom - 1) &&
                        !this._attacked(them, castlingTo)
                    ) {
                        addMove(moves, this._kings[us], castlingTo, BITS.QSIDE_CASTLE);
                    }
                }
            }
        }

        /*
         * return all pseudo-legal moves (this includes moves that allow the king
         * to be captured)
         */
        if (!legal || this._kings[us] === -1) {
            return moves;
        }

        // filter out illegal moves
        const legalMoves = [];
        if (this._variant === ANTICHESS) {
            /*
             * In Antichess, capturing is forced. If you can take a piece, you must.
             * Kings lose their royal powers - they cannot castle and checks are no longer a threat.
             * Pawns may be promoted to kings
            */
            const captures = [];
            for (let i = 0, len = moves.length; i < len; i++) {
                if (moves[i].captured) {
                    captures.push(moves[i]);
                }
            }
            legalMoves.push(...(captures.length ? captures : moves));
        } else if (this._variant === RACING_KINGS) {
            // In Racing Kings, moves that put our King or the enemy King in check are illegal.
            for (let i = 0, len = moves.length; i < len; i++) {
                this._makeMove(moves[i]);
                if (!this._isKingAttacked(us) && !this._isKingAttacked(them)) {
                    legalMoves.push(moves[i]);
                }
                this._undoMove();
            }
        } else {
            // In variants with standard Chess rules, moves that put our King in check are illegal.
            for (let i = 0, len = moves.length; i < len; i++) {
                this._makeMove(moves[i]);
                if (!this._isKingAttacked(us)) {
                    legalMoves.push(moves[i]);
                }
                this._undoMove();
            }
        }
        return legalMoves;
    }

    /*
     * The move function can be called with in the following parameters:
     *
     * .move('Nxb7')       <- argument is a case-sensitive SAN string
     *
     * .move({ from: 'h7', <- argument is a move object
     *         to :'h8',
     *         promotion: 'q' })
     *
     *
     * An optional strict argument may be supplied to tell chess.js to
     * strictly follow the SAN specification.
     */
    move(move, {strict = false} = {}) {
        let moveObj = null;

        if (typeof move === 'string') {
            moveObj = this._moveFromSan(move, strict);
        } else if (typeof move === 'object') {
            const moves = this._moves();
            // convert the pretty move object to an ugly move object
            for (let i = 0, len = moves.length; i < len; i++) {
                if (
                    move.from === algebraic(moves[i].from) &&
                    move.to === algebraic(moves[i].to) &&
                    (!('promotion' in moves[i]) || move.promotion === moves[i].promotion)
                ) {
                    moveObj = moves[i];
                    break;
                }
            }
        }

        // failed to find move
        if (!moveObj) {
            if (typeof move === 'string') {
                throw new Error(`Invalid move: ${move}`);
            } else {
                throw new Error(`Invalid move: ${JSON.stringify(move)}`);
            }
        }

        // need to make a copy of move because we can't generate SAN after the move is made
        const prettyMove = this._makePretty(moveObj);

        this._makeMove(moveObj);
        this._incPositionCount(prettyMove.after);
        return prettyMove;
    }

    _push(move) {
        this._history.push({
            move,
            kings: {b: this._kings.b, w: this._kings.w},
            turn: this._turn,
            castling: {b: this._castling.b, w: this._castling.w},
            epSquare: this._epSquare,
            halfMoves: this._halfMoves,
            moveNumber: this._moveNumber,
        });
    }

    _makeMove(move) {
        const us = this._turn;
        const them = swapColor(us);
        this._push(move);

        this._board[move.to] = this._board[move.from];
        delete this._board[move.from];

        // /*
        //  * In Atomic, all captures result in an "explosion" through which the
        //  * capturing piece, captured piece, and all surrounding pieces of both
        //  * colors other than pawns are removed from play.
        //  */
        // if (this._variant === ATOMIC && (move.flags & BITS.CAPTURE)) {
        //   delete this._board[move.to];
        //   for (const offset of PIECE_OFFSETS.k) {
        //     const to = move.to + offset;
        //     if (to & 0x88) continue; // off-board check
        //     if (this._board[to]?.type !== 'p') {
        //       delete this._board[to];
        //     }
        //   }
        // }

        // if ep capture, remove the captured pawn
        if (move.flags & BITS.EP_CAPTURE) {
            if (this._turn === BLACK) {
                delete this._board[move.to - 16];
            } else {
                delete this._board[move.to + 16];
            }
        }

        // if pawn promotion, replace with new piece
        if (move.promotion) {
            this._board[move.to] = {type: move.promotion, color: us};
        }

        // if we moved the king
        if (this._board[move.to].type === KING) {
            this._kings[us] = move.to;

            // if we castled, move the rook next to the king
            if (move.flags & BITS.KSIDE_CASTLE) {
                const castlingTo = move.to - 1;
                const castlingFrom = move.to + 1;
                this._board[castlingTo] = this._board[castlingFrom];
                delete this._board[castlingFrom];
            } else if (move.flags & BITS.QSIDE_CASTLE) {
                const castlingTo = move.to + 1;
                const castlingFrom = move.to - 2;
                this._board[castlingTo] = this._board[castlingFrom];
                delete this._board[castlingFrom];
            }

            // turn off castling
            this._castling[us] = 0;
        }

        // turn off castling if we move a rook
        if (this._castling[us]) {
            for (let i = 0, len = ROOKS[us].length; i < len; i++) {
                if (
                    move.from === ROOKS[us][i].square &&
                    this._castling[us] & ROOKS[us][i].flag
                ) {
                    this._castling[us] ^= ROOKS[us][i].flag;
                    break;
                }
            }
        }

        // turn off castling if we capture a rook
        if (this._castling[them]) {
            for (let i = 0, len = ROOKS[them].length; i < len; i++) {
                if (
                    move.to === ROOKS[them][i].square &&
                    this._castling[them] & ROOKS[them][i].flag
                ) {
                    this._castling[them] ^= ROOKS[them][i].flag;
                    break;
                }
            }
        }

        // if big pawn move, update the en passant square
        if (move.flags & BITS.BIG_PAWN) {
            if (us === BLACK) {
                this._epSquare = move.to - 16;
            } else {
                this._epSquare = move.to + 16;
            }
        } else {
            this._epSquare = EMPTY;
        }

        // reset the 50 move counter if a pawn is moved or a piece is captured
        if (move.piece === PAWN) {
            this._halfMoves = 0;
        } else if (move.flags & BITS.CAPTURE) {
            this._halfMoves = 0;
        } else {
            this._halfMoves++;
        }

        if (us === BLACK) {
            this._moveNumber++;
        }

        this._turn = them;
    }

    undo() {
        const move = this._undoMove();
        if (move) {
            const prettyMove = this._makePretty(move);
            this._decPositionCount(prettyMove.after);
            return prettyMove;
        }
        return null;
    }

    _undoMove() {
        const old = this._history.pop();
        if (old === undefined) {
            return null;
        }

        const move = old.move;

        this._kings = old.kings;
        this._turn = old.turn;
        this._castling = old.castling;
        this._epSquare = old.epSquare;
        this._halfMoves = old.halfMoves;
        this._moveNumber = old.moveNumber;

        const us = this._turn;
        const them = swapColor(us);

        this._board[move.from] = this._board[move.to];
        this._board[move.from].type = move.piece; // to undo any promotions
        delete this._board[move.to];

        if (move.captured) {
            if (move.flags & BITS.EP_CAPTURE) {
                // en passant capture
                let index;
                if (us === BLACK) {
                    index = move.to - 16;
                } else {
                    index = move.to + 16;
                }
                this._board[index] = {type: PAWN, color: them};
            } else {
                // regular capture
                this._board[move.to] = {type: move.captured, color: them};
            }
        }

        if (move.flags & (BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE)) {
            let castlingTo, castlingFrom;
            if (move.flags & BITS.KSIDE_CASTLE) {
                castlingTo = move.to + 1;
                castlingFrom = move.to - 1;
            } else {
                castlingTo = move.to - 2;
                castlingFrom = move.to + 1;
            }

            this._board[castlingTo] = this._board[castlingFrom];
            delete this._board[castlingFrom];
        }

        return move;
    }

    /*
     * Convert a move from 0x88 coordinates to Standard Algebraic Notation
     * (SAN)
     *
     * @param {boolean} strict Use the strict SAN parser. It will throw errors
     * on overly disambiguated moves (see below):
     *
     * r1bqkbnr/ppp2ppp/2n5/1B1pP3/4P3/8/PPPP2PP/RNBQK1NR b KQkq - 2 4
     * 4. ... Nge7 is overly disambiguated because the knight on c6 is pinned
     * 4. ... Ne7 is technically the valid SAN
     */
    _moveToSan(move, moves) {
        let output = '';

        if (move.flags & BITS.KSIDE_CASTLE) {
            output = 'O-O';
        } else if (move.flags & BITS.QSIDE_CASTLE) {
            output = 'O-O-O';
        } else {
            if (move.piece !== PAWN) {
                const disambiguator = getDisambiguator(move, moves);
                output += move.piece.toUpperCase() + disambiguator;
            }

            if (move.flags & BITS.CAPTURE) {
                if (move.piece === PAWN) {
                    output += algebraic(move.from)[0];
                }
                output += 'x';
            }

            output += algebraic(move.to);

            if (move.promotion) {
                output += '=' + move.promotion.toUpperCase();
            }
        }

        this._makeMove(move);
        if (this.isCheck()) {
            if (this.isCheckmate()) {
                output += '#';
            } else {
                output += '+';
            }
        }
        this._undoMove();

        return output;
    }

    // convert a move from Standard Algebraic Notation (SAN) to 0x88 coordinates
    _moveFromSan(move, strict = false) {
        // strip off any move decorations: e.g Nf3+?! becomes Nf3
        const cleanMove = strippedSan(move);

        let pieceType = inferPieceType(cleanMove);
        let moves = this._moves({legal: true, piece: pieceType});

        // strict parser
        for (let i = 0, len = moves.length; i < len; i++) {
            if (cleanMove === strippedSan(this._moveToSan(moves[i], moves))) {
                return moves[i];
            }
        }

        // the strict parser failed
        if (strict) {
            return null;
        }

        let piece = undefined;
        let matches = undefined;
        let from = undefined;
        let to = undefined;
        let promotion = undefined;

        /*
         * The default permissive (non-strict) parser allows the user to parse
         * non-standard chess notations. This parser is only run after the strict
         * Standard Algebraic Notation (SAN) parser has failed.
         *
         * When running the permissive parser, we'll run a regex to grab the piece, the
         * to/from square, and an optional promotion piece. This regex will
         * parse common non-standard notation like: Pe2-e4, Rc1c4, Qf3xf7,
         * f7f8q, b1c3
         *
         * NOTE: Some positions and moves may be ambiguous when using the permissive
         * parser. For example, in this position: 6k1/8/8/B7/8/8/8/BN4K1 w - - 0 1,
         * the move b1c3 may be interpreted as Nc3 or B1c3 (a disambiguated bishop
         * move). In these cases, the permissive parser will default to the most
         * basic interpretation (which is b1c3 parsing to Nc3).
         */

        let overlyDisambiguated = false;

        matches = cleanMove.match(/([pnbrqkPNBRQK])?([a-h][1-8])x?-?([a-h][1-8])([qrbnQRBN])?/);
        if (matches) {
            piece = matches[1];
            from = matches[2];
            to = matches[3];
            promotion = matches[4];
            if (from.length === 1) {
                overlyDisambiguated = true;
            }
        } else {
            /*
             * The [a-h]?[1-8]? portion of the regex below handles moves that may be
             * overly disambiguated (e.g. Nge7 is unnecessary and non-standard when
             * there is one legal knight move to e7). In this case, the value of
             * 'from' variable will be a rank or file, not a square.
             */
            matches = cleanMove.match(/([pnbrqkPNBRQK])?([a-h]?[1-8]?)x?-?([a-h][1-8])([qrbnQRBN])?/);
            if (matches) {
                piece = matches[1];
                from = matches[2];
                to = matches[3];
                promotion = matches[4];
                if (from.length === 1) {
                    overlyDisambiguated = true;
                }
            }
        }

        pieceType = inferPieceType(cleanMove);
        moves = this._moves({legal: true, piece: piece ? piece : pieceType});

        if (!to) {
            return null;
        }

        for (let i = 0, len = moves.length; i < len; i++) {
            if (!from) {
                // if there is no from square, it could be just 'x' missing from a capture
                if (cleanMove === strippedSan(this._moveToSan(moves[i], moves)).replace('x', '')) {
                    return moves[i];
                }
                // hand-compare move properties with the results from our permissive regex
            } else if (
                (!piece || piece.toLowerCase() === moves[i].piece) &&
                Ox88[from] === moves[i].from &&
                Ox88[to] === moves[i].to &&
                (!promotion || promotion.toLowerCase() === moves[i].promotion)
            ) {
                return moves[i];
            } else if (overlyDisambiguated) {
                /*
                 * SPECIAL CASE: we parsed a move string that may have an unneeded
                 * rank/file disambiguator (e.g. Nge7).  The 'from' variable will
                 */
                const square = algebraic(moves[i].from);
                if (
                    (!piece || piece.toLowerCase() === moves[i].piece) &&
                    Ox88[to] === moves[i].to &&
                    (from === square[0] || from === square[1]) &&
                    (!promotion || promotion.toLowerCase() === moves[i].promotion)
                ) {
                    return moves[i];
                }
            }
        }

        return null;
    }

    ascii() {
        let s = '   +------------------------+\n';
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
            // display the rank
            if (file(i) === 0) {
                s += ' ' + '87654321'[rank(i)] + ' |';
            }

            if (this._board[i]) {
                const piece = this._board[i].type;
                const color = this._board[i].color;
                const symbol = color === WHITE ? piece.toUpperCase() : piece.toLowerCase();
                s += ' ' + symbol + ' ';
            } else {
                s += ' . ';
            }

            if ((i + 1) & 0x88) {
                s += '|\n';
                i += 8;
            }
        }
        s += '   +------------------------+\n';
        s += '     a  b  c  d  e  f  g  h';
        return s;
    }

    perft(depth) {
        const moves = this._moves({legal: false});
        let nodes = 0;
        const color = this._turn;

        for (let i = 0, len = moves.length; i < len; i++) {
            this._makeMove(moves[i]);
            if (!this._isKingAttacked(color)) {
                if (depth - 1 > 0) {
                    nodes += this.perft(depth - 1);
                } else {
                    nodes++;
                }
            }
            this._undoMove();
        }

        return nodes;
    }

    // pretty = external move object
    _makePretty(uglyMove) {
        const {color, piece, from, to, flags, captured, promotion} = uglyMove;

        let prettyFlags = '';

        for (const flag in BITS) {
            if (BITS[flag] & flags) {
                prettyFlags += FLAGS[flag];
            }
        }

        const fromAlgebraic = algebraic(from);
        const toAlgebraic = algebraic(to);


        const move = {
            color,
            piece,
            from: fromAlgebraic,
            to: toAlgebraic,
            san: this._moveToSan(uglyMove, this._moves({legal: true})),
            flags: prettyFlags,
            lan: fromAlgebraic + toAlgebraic,
            before: this.fen(),
            after: '',
        };

        // generate the FEN for the 'after' key
        this._makeMove(uglyMove);
        move.after = this.fen();
        this._undoMove();

        if (captured) {
            move.captured = captured;
        }
        if (promotion) {
            move.promotion = promotion;
            move.lan += promotion;
        }

        return move;
    }

    turn() {
        return this._turn;
    }

    setTurn(turn) {
        this._turn = turn;
    }

    variant() {
        return this._variant;
    }

    setVariant(variant) {
        this._variant = variant;
    }

    board() {
        const output = [];
        let row = [];

        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
            if (this._board[i] == null) {
                row.push(null);
            } else {
                row.push({
                    square: algebraic(i),
                    type: this._board[i].type,
                    color: this._board[i].color,
                });
            }
            if ((i + 1) & 0x88) {
                output.push(row);
                row = [];
                i += 8;
            }
        }

        return output;
    }

    squareColor(square) {
        if (square in Ox88) {
            const sq = Ox88[square];
            return (rank(sq) + file(sq)) % 2 === 0 ? 'light' : 'dark';
        }
        return null;
    }

    history({verbose = false} = {}) {
        const reversedHistory = [];
        const moveHistory = [];

        while (this._history.length > 0) {
            reversedHistory.push(this._undoMove());
        }

        while (true) {
            const move = reversedHistory.pop();
            if (!move) break;

            if (verbose) {
                moveHistory.push(this._makePretty(move));
            } else {
                moveHistory.push(this._moveToSan(move, this._moves()));
            }
            this._makeMove(move);
        }

        return moveHistory;
    }

    /*
     * Keeps track of position occurrence counts for the purpose of repetition
     * checking. All three methods (`_inc`, `_dec`, and `_get`) trim the
     * irrelevent information from the fen, initialising new positions, and
     * removing old positions from the record if their counts are reduced to 0.
     */
    _getPositionCount(fen) {
        const trimmedFen = trimFen(fen);
        return this._positionCount[trimmedFen] || 0;
    }

    _incPositionCount(fen) {
        const trimmedFen = trimFen(fen);
        if (this._positionCount[trimmedFen] === undefined) {
            this._positionCount[trimmedFen] = 0;
        }
        this._positionCount[trimmedFen] += 1;
    }

    _decPositionCount(fen) {
        const trimmedFen = trimFen(fen);
        if (this._positionCount[trimmedFen] === 1) {
            delete this._positionCount[trimmedFen];
        } else {
            this._positionCount[trimmedFen] -= 1;
        }
    }

    setCastlingRights(color, rights) {
        for (const side of [KING, QUEEN]) {
            if (rights[side] !== undefined) {
                if (rights[side]) {
                    this._castling[color] |= SIDES[side];
                } else {
                    this._castling[color] &= ~SIDES[side];
                }
            }
        }

        this._updateCastlingRights();
        const result = this.getCastlingRights(color);

        return (
            (rights[KING] === undefined || rights[KING] === result[KING]) &&
            (rights[QUEEN] === undefined || rights[QUEEN] === result[QUEEN])
        );
    }

    getCastlingRights(color) {
        return {
            [KING]: (this._castling[color] & SIDES[KING]) !== 0,
            [QUEEN]: (this._castling[color] & SIDES[QUEEN]) !== 0,
        };
    }

    moveNumber() {
        return this._moveNumber;
    }
}
