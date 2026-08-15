// Polyglot .bin opening books: the position key, the entry format, and the move decoding.
//
// A .bin is a flat array of 16-byte entries, big-endian, SORTED BY KEY:
//     key u64 | move u16 | weight u16 | learn u32
// so a lookup is a binary search rather than a scan -- which is what makes a 200MB book usable in
// a browser tab.
//
// The key is Zobrist over the position with the format's own fixed constants (lib/polyglot-random.js).
// Getting it wrong produces a book that simply never matches, which is indistinguishable from "this
// book has nothing here" -- so this file is verified against the FORMAT'S OWN published keys
// (test_popup_logic.js runs them), not against itself.
//
// Everything is BigInt: a key is a full 64 bits and a JS number is not.

const R = self.POLYGLOT_RANDOM;
const MASK64 = (1n << 64n) - 1n;

// the table's layout, straight from the format: 12 piece planes, then castling, en passant, turn
const RANDOM_PIECE = 0;        // 768 entries: kind * 64 + square
const RANDOM_CASTLE = 768;     // 4
const RANDOM_EN_PASSANT = 772; // 8, by FILE
const RANDOM_TURN = 780;       // 1, added when WHITE is to move

// Polyglot's piece order is black-first within each type: bp, wp, bn, wn, bb, wb, br, wr, bq, wq, bk, wk
const KIND = {p: 0, n: 2, b: 4, r: 6, q: 8, k: 10};

// `board` is chess.js-like: .get('e4') -> {type, color}, plus the fen fields we read directly.
export function polyglotKey(fen) {
    const [placement, turn, castling, ep] = String(fen).trim().split(/\s+/);
    let key = 0n;
    let rank = 7, file = 0;
    for (const ch of placement) {
        if (ch === '/') { rank--; file = 0; continue; }
        if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
        const lower = ch.toLowerCase();
        const kind = KIND[lower];
        if (kind === undefined) continue;
        const isWhite = ch !== lower;
        // the format numbers squares a1=0..h8=63, and the WHITE plane is the odd one
        const square = rank * 8 + file;
        key ^= R[RANDOM_PIECE + (kind + (isWhite ? 1 : 0)) * 64 + square];
        file++;
    }
    if (castling && castling !== '-') {
        if (castling.includes('K')) key ^= R[RANDOM_CASTLE + 0];
        if (castling.includes('Q')) key ^= R[RANDOM_CASTLE + 1];
        if (castling.includes('k')) key ^= R[RANDOM_CASTLE + 2];
        if (castling.includes('q')) key ^= R[RANDOM_CASTLE + 3];
    }
    // AN EN PASSANT SQUARE ONLY COUNTS IF A PAWN CAN ACTUALLY TAKE IT. Hashing it whenever the FEN
    // names one is the classic way to build a key that matches no book: most FENs after a double
    // step name the square even when nothing can capture there.
    if (ep && ep !== '-') {
        const epFile = ep.charCodeAt(0) - 97;
        const epRank = +ep[1];
        const rows = placement.split('/');           // rows[0] is rank 8
        const at = (f, r) => {
            const row = rows[8 - r];
            if (!row) return null;
            let i = 0;
            for (const ch of row) {
                if (ch >= '1' && ch <= '8') { i += ch.charCodeAt(0) - 48; continue; }
                if (i === f) return ch;
                i++;
            }
            return null;
        };
        const pawn = turn === 'w' ? 'P' : 'p';
        const fromRank = turn === 'w' ? epRank - 1 : epRank + 1;
        const canTake = (epFile > 0 && at(epFile - 1, fromRank) === pawn)
                     || (epFile < 7 && at(epFile + 1, fromRank) === pawn);
        if (canTake) key ^= R[RANDOM_EN_PASSANT + epFile];
    }
    if (turn === 'w') key ^= R[RANDOM_TURN];
    return key & MASK64;
}

// A book move is packed into 16 bits: to-file, to-rank, from-file, from-rank, promotion.
// Castling is stored as the KING TAKING ITS OWN ROOK (e1h1), which is not a legal move anywhere
// else, so it is translated to the king's two-square move.
export function decodeMove(raw) {
    const toFile = raw & 0x7, toRank = (raw >> 3) & 0x7;
    const fromFile = (raw >> 6) & 0x7, fromRank = (raw >> 9) & 0x7;
    const promo = (raw >> 12) & 0x7;
    const sq = (f, r) => String.fromCharCode(97 + f) + (r + 1);
    let from = sq(fromFile, fromRank), to = sq(toFile, toRank);
    const CASTLES = {e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8'};
    const uci = CASTLES[from + to] || (from + to);
    return uci + (promo ? ' nbrq'[promo] : '');
}

// The whole file as a lookup table. A book is read ONCE and kept as a Map, because a browser tab
// cannot seek a file it was handed as bytes anyway, and the alternative is a binary search per
// position over an ArrayBuffer -- which is what a bigger book would want, and is why the entries
// stay sorted here.
export function readBook(buffer) {
    const view = new DataView(buffer);
    const entries = new Map();   // key (string, base 16) -> [{uci, weight}]
    const count = Math.floor(buffer.byteLength / 16);
    for (let i = 0; i < count; i++) {
        const o = i * 16;
        const key = view.getBigUint64(o).toString(16);
        const move = view.getUint16(o + 8);
        const weight = view.getUint16(o + 10);
        const list = entries.get(key) || [];
        list.push({uci: decodeMove(move), weight});
        entries.set(key, list);
    }
    return entries;
}

export function lookup(entries, fen) {
    if (!entries) return [];
    return entries.get(polyglotKey(fen).toString(16)) || [];
}
