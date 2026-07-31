// Lichess puzzle database -> IndexedDB, so Puzzle Mode can play the KNOWN solution instead of an
// engine guess. Plain script, no module: the options page loads it with a <script> tag and the
// service worker with importScripts(), and both then share ONE definition of the key format and the
// store names -- which is the whole reason this is a file rather than fifteen lines duplicated twice.
//
// The database is NOT shipped. It is ~1 GB decompressed and the release zip is already 584 MB, so
// the user downloads it from https://database.lichess.org/ and hands over the file in Settings.
// **Hand over the DECOMPRESSED .csv**: lichess publishes .zst, and browsers have DecompressionStream
// for gzip and deflate but NOT for zstd. `unzstd lichess_db_puzzle.csv.zst` is one command on their
// side; bundling a zstd decoder for a once-ever import is not worth the megabyte.
//
// LICHESS ONLY, by construction. chess.com's Puzzle Rush positions are not in this file, so an
// exact-position lookup there will essentially never hit -- Puzzle Mode falls back to the engine,
// exactly as it behaves today.
//
// Only two columns are kept, FEN and Moves. Rating, RatingDeviation, Popularity, NbPlays, Themes,
// GameUrl and OpeningTags are all dropped: nothing here ranks or filters puzzles, it answers "what
// is the move in this exact position", so storing the rest would be ~4x the disk for no lookup.
(function (root) {
'use strict';

const DB_NAME = 'mephisto-puzzles';
const STORE = 'p';
const DB_VERSION = 1;
const BATCH = 20000; // records per transaction -- see importCsv

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// --- position key -------------------------------------------------------------------------------
// PLACEMENT + SIDE TO MOVE, and deliberately not the whole FEN. The panel's scraped FEN carries
// castling rights and an en-passant square that are inferred rather than read (there is no move list
// on a puzzle page), and the halfmove/fullmove counters are frequently wrong outright -- so keying on
// the full string would miss on positions that are, as far as anyone playing them is concerned, the
// same position. Placement + turn is what a puzzle IS.
function keyOf(fen) {
    const parts = String(fen).split(' ');
    return `${parts[0]} ${parts[1] || 'w'}`;
}

// --- applying one UCI move to a placement -------------------------------------------------------
// Squares index 0 = a8 .. 63 = h1, i.e. FEN reading order.
//
// This is here instead of chess.js because it runs six million times during an import and only ever
// has to apply a move that is already known to be legal (it came out of a real game). No move
// generation, no legality check -- just the three cases where a move touches a square its own
// notation does not name: promotion, castling, en passant.
const sqIndex = (sq) => (8 - Number(sq[1])) * 8 + (sq.charCodeAt(0) - 97);

function expand(placement) {
    const b = [];
    for (const ch of placement) {
        if (ch === '/') continue;
        if (ch >= '1' && ch <= '8') { for (let i = Number(ch); i > 0; i--) b.push(''); }
        else b.push(ch);
    }
    return b;
}

function compact(b) {
    let out = '';
    for (let r = 0; r < 8; r++) {
        let run = 0;
        for (let f = 0; f < 8; f++) {
            const p = b[r * 8 + f];
            if (p) { if (run) { out += run; run = 0; } out += p; }
            else run++;
        }
        if (run) out += run;
        if (r < 7) out += '/';
    }
    return out;
}

function applyUci(placement, uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(uci || '')) return null;
    const b = expand(placement);
    if (b.length !== 64) return null;
    const from = sqIndex(uci.slice(0, 2));
    const to = sqIndex(uci.slice(2, 4));
    const piece = b[from];
    if (!piece) return null; // the move doesn't belong to this position
    const white = piece === piece.toUpperCase();
    b[from] = '';
    // En passant: a pawn that changes file onto an EMPTY square took the pawn beside it -- which sits
    // on the capturing pawn's own rank, in the file it moved to.
    if ((piece === 'P' || piece === 'p') && !b[to] && (from % 8) !== (to % 8)) {
        b[from - (from % 8) + (to % 8)] = '';
    }
    b[to] = uci[4] ? (white ? uci[4].toUpperCase() : uci[4].toLowerCase()) : piece;
    // Castling: the king jumps two files and the rook has to come with it. Standard chess only --
    // which is all lichess's puzzle database holds.
    if ((piece === 'K' || piece === 'k') && Math.abs((from % 8) - (to % 8)) === 2) {
        const rank = to - (to % 8);
        if (to % 8 === 6) { b[rank + 5] = b[rank + 7]; b[rank + 7] = ''; } // O-O
        else { b[rank + 3] = b[rank + 0]; b[rank + 0] = ''; }              // O-O-O
    }
    return compact(b);
}

// --- one CSV row -> one record ------------------------------------------------------------------
// THE THING THAT SILENTLY BREAKS THIS IF YOU GET IT WRONG: lichess's `FEN` column is the position
// BEFORE the opponent's setup move, and `Moves[0]` IS that move. The position a solver is ever shown
// -- and the one the panel scrapes off the page -- is the one AFTER Moves[0], and the solution starts
// at Moves[1]. Index the FEN column as-is and every lookup misses while the code reads correctly.
//
// Returns [key, solution] or null. `solution` is the whole remaining line from that position, ours
// and theirs alternating, starting with ours.
function rowToRecord(line) {
    // Only the first three fields are touched and none of them can contain a comma or a quote (a FEN
    // and a UCI move list are spaces and alphanumerics). The columns that could -- Themes, GameUrl,
    // OpeningTags -- are dropped, so there is no CSV quoting to honour here.
    const cols = line.split(',');
    if (cols.length < 3) return null;
    const [placement, stm] = cols[1].split(' ');
    const moves = cols[2].split(' ').filter(Boolean);
    if (!placement || !stm || moves.length < 2) return null; // a 1-move `Moves` has no solution left
    const after = applyUci(placement, moves[0]);
    if (!after) return null;
    return [`${after} ${stm === 'w' ? 'b' : 'w'}`, moves.slice(1).join(' ')];
}

// --- import -------------------------------------------------------------------------------------
// Streamed, never read whole: the file is about a gigabyte and File.stream() costs nothing to use.
// Writes go in batches inside one transaction each, and the batch is AWAITED before the next chunk
// is parsed -- six million individual put()s queued from a tight loop is how you get a tab that has
// consumed a gigabyte of heap holding requests IndexedDB has not caught up with yet.
//
// onProgress({rows, kept}) is called per batch, so the settings page can show it moving; an import of
// this size takes minutes and a UI that says nothing for minutes reads as a hang.
async function importCsv(file, onProgress) {
    const db = await open();
    try {
        // NOT cleared first. The key IS the position, so a re-import of the same file overwrites the
        // same records and a newer file adds to them -- there is nothing to merge wrongly. Clearing
        // would buy nothing and cost the one thing that matters here: this takes half an hour, and a
        // clear-then-rebuild that fails at minute twenty leaves you with neither the new database nor
        // the old one. Without it a failed run leaves a partial but entirely usable database that a
        // re-run completes. "Remove" is there for a deliberate wipe.
        const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
        let tail = '';
        let rows = 0, kept = 0, first = true;
        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            const pending = batch;
            batch = [];
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                const store = tx.objectStore(STORE);
                for (const [k, v] of pending) store.put(v, k);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            onProgress?.({rows, kept});
        };
        const take = (line) => {
            if (!line) return;
            if (first) { // header row, if there is one -- the published file has one
                first = false;
                if (line.startsWith('PuzzleId')) return;
            }
            rows++;
            const rec = rowToRecord(line);
            if (rec) { kept++; batch.push(rec); }
        };
        for (;;) {
            const {value, done} = await reader.read();
            if (done) break;
            const lines = (tail + value).split('\n');
            tail = lines.pop(); // the last piece is a partial line until the next chunk arrives
            for (const line of lines) take(line.endsWith('\r') ? line.slice(0, -1) : line);
            if (batch.length >= BATCH) await flush();
        }
        take(tail.endsWith('\r') ? tail.slice(0, -1) : tail); // final line, if the file lacks a newline
        await flush();
        onProgress?.({rows, kept});
        return {rows, kept};
    } finally {
        db.close();
    }
}

// The solution line for one position, or null. One IndexedDB read; no network, ever.
async function lookup(fen) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(keyOf(fen));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

async function count() {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

async function clear() {
    const db = await open();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

root.PuzzleDB = {keyOf, applyUci, rowToRecord, importCsv, lookup, count, clear};

})(typeof self !== 'undefined' ? self : this);
