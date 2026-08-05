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
// ONE STORE PER PUBLISHER, not one pooled store. A Lichess-derived position is a guaranteed miss on
// chess.com and vice versa, so pooling them would mean every lookup reads records that cannot ever
// match -- and on a 6.6M-record store that is disk work per position, per move. Separate stores let
// the lookup ask only where an answer can exist. It also keeps `Remove` meaningful: dropping one
// database no longer takes the other with it.
const STORE = 'p';           // lichess (the original store name -- kept, so existing imports survive)
const STORE_CC = 'c';        // chess.com
const STORES = {li: STORE, cc: STORE_CC};
const DB_VERSION = 2;
const BATCH = 20000; // records per transaction -- see importCsv

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            // v1 had only STORE. Adding STORE_CC is purely additive: an existing Lichess import is
            // left exactly where it is and does not need re-running.
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            if (!db.objectStoreNames.contains(STORE_CC)) db.createObjectStore(STORE_CC);
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

// --- chess.com puzzles ---------------------------------------------------------------------------
// A different publisher, a different encoding, and one structural difference that decides the whole
// parsing strategy: the `pgn` column holds a full PGN with LITERAL NEWLINES inside its quotes. The
// Lichess path below splits the stream on '\n' and is right to -- six million rows, no quoting to
// honour. That would shred every chess.com row. So this format gets a real CSV reader and Lichess
// keeps its fast path.
//
// Columns: fen3,id,rating,initialFen,tcnMoveList,colorOfUser,pgn,passRate,averageSeconds,
//          gameLiveId,gameId
const CC_COLS = {fen3: 0, id: 1, rating: 2, initialFen: 3, tcn: 4, color: 5};

// chess.com's TCN: two characters per move over a fixed 64+ character alphabet. Index 0 is a1 and
// index 63 is h8 -- the opposite vertical order to `expand()` above, which is FEN reading order, so
// the two never share a square index.
const TCN_ALPHABET =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';

function tcnSquare(i) {
    return String.fromCharCode(97 + (i % 8)) + (Math.floor(i / 8) + 1);
}

// Returns a UCI list, or null if anything about the string is not a clean pair sequence. A promotion
// is encoded by pushing the DESTINATION index past 63: the excess names the piece and the file shift.
function tcnToUci(tcn) {
    if (typeof tcn !== 'string' || !tcn.length || tcn.length % 2) return null;
    const out = [];
    for (let i = 0; i < tcn.length; i += 2) {
        let from = TCN_ALPHABET.indexOf(tcn[i]);
        let to = TCN_ALPHABET.indexOf(tcn[i + 1]);
        if (from < 0 || to < 0) return null;
        if (from > 63) return null;          // a piece DROP (crazyhouse); not a puzzle move here
        let promo = '';
        if (to > 63) {
            promo = 'qnrbkp'[Math.floor((to - 64) / 3)] || '';
            // the promotion also carries the file change: -1 capture left, 0 straight, +1 right
            to = from + (from < 16 ? -8 : 8) + ((to - 64) % 3) - 1;
            if (to < 0 || to > 63) return null;
        }
        out.push(tcnSquare(from) + tcnSquare(to) + promo);
    }
    return out;
}

// One parsed chess.com row -> [key, solution] or null.
//
// WHOSE MOVE COMES FIRST DIFFERS BY ROW TYPE, and getting it wrong shifts every solution by a ply.
// A rated tactic stores the position BEFORE the opponent's setup move, exactly like Lichess: `fen3`
// is the opponent to move and `colorOfUser` is the solver. A `daily-` row has no setup move and no
// colorOfUser -- the side to move in `fen3` IS the solver, and the line starts immediately. So the
// setup move is skipped only when the solver is NOT the side to move.
function ccRowToRecord(cols, sanToUci) {
    const fen3 = cols[CC_COLS.fen3];
    const id = cols[CC_COLS.id] || '';
    if (!fen3) return null;
    const [placement, stm] = String(fen3).trim().split(/\s+/);
    if (!placement || (stm !== 'w' && stm !== 'b')) return null;

    // Daily rows carry SAN, not TCN (`Rg3 hxg3 Rxg3 ...`). Turning SAN into UCI needs a rules
    // engine, and this module deliberately has none -- it also runs in the service worker, where
    // chess.js is not loaded. The IMPORTER injects one (the options page has chess.js); without it
    // daily rows are skipped rather than guessed at.
    const raw = String(cols[CC_COLS.tcn] || '').trim();
    const moves = id.startsWith('daily-')
        ? (sanToUci ? sanToUci(String(cols[CC_COLS.initialFen] || fen3), raw.split(/\s+/).filter(Boolean)) : null)
        : tcnToUci(raw);
    if (!moves || !moves.length) return null;

    const color = String(cols[CC_COLS.color] || '').trim().toLowerCase();
    const solverIsSideToMove = !color || color[0] === stm;
    if (solverIsSideToMove) return [`${placement} ${stm}`, moves.join(' ')];

    if (moves.length < 2) return null;               // a setup move and nothing left to solve
    const after = applyUci(placement, moves[0]);
    if (!after) return null;
    return [`${after} ${stm === 'w' ? 'b' : 'w'}`, moves.slice(1).join(' ')];
}

// Streaming CSV reader. Feed it chunks, get back complete records. Handles quoted fields, doubled
// quotes inside them, and the newlines the pgn column contains -- which is the entire reason it
// exists rather than another split('\n').
function makeCsvReader() {
    let field = '', row = [], inQuotes = false, pendingQuote = false;
    return {
        push(chunk) {
            const done = [];
            for (const ch of chunk) {
                if (pendingQuote) {                  // saw a quote while inside quotes
                    pendingQuote = false;
                    if (ch === '"') { field += '"'; continue; }   // "" -> a literal quote
                    inQuotes = false;                            // the field ended
                }
                if (inQuotes) {
                    if (ch === '"') pendingQuote = true; else field += ch;
                    continue;
                }
                if (ch === '"' && field === '') { inQuotes = true; continue; }
                if (ch === ',') { row.push(field); field = ''; continue; }
                if (ch === '\n') { row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
                                   done.push(row); row = []; field = ''; continue; }
                field += ch;
            }
            return done;
        },
        end() {
            if (pendingQuote) inQuotes = false;
            if (field !== '' || row.length) { row.push(field); const r = row; row = []; field = ''; return [r]; }
            return [];
        },
    };
}

// --- import -------------------------------------------------------------------------------------
// Streamed, never read whole: the file is about a gigabyte and File.stream() costs nothing to use.
// Writes go in batches inside one transaction each, and the batch is AWAITED before the next chunk
// is parsed -- six million individual put()s queued from a tight loop is how you get a tab that has
// consumed a gigabyte of heap holding requests IndexedDB has not caught up with yet.
//
// onProgress({rows, kept}) is called per batch, so the settings page can show it moving; an import of
// this size takes minutes and a UI that says nothing for minutes reads as a hang.
async function importCsv(file, onProgress, opts = {}) {
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
        // WHICH PUBLISHER? Decided once, from the header, and it picks the whole parsing strategy:
        // Lichess rows are split on newlines (fast, and nothing in the columns we read can be
        // quoted), chess.com rows must go through a real CSV reader because the pgn column contains
        // literal newlines. Guessing per row would be both slower and wrong.
        let csv = null;                    // non-null once we know it is the chess.com format
        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            const pending = batch;
            batch = [];
            await new Promise((resolve, reject) => {
                // Which database this file belongs to is known by the time anything is flushed:
                // the header decided it on the first chunk.
                const tx = db.transaction(csv ? STORE_CC : STORE, 'readwrite');
                const store = tx.objectStore(csv ? STORE_CC : STORE);
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
        const takeCc = (cols) => {
            if (!cols.length || (cols.length === 1 && cols[0] === '')) return;
            rows++;
            const rec = ccRowToRecord(cols, opts.sanToUci);
            if (rec) { kept++; batch.push(rec); }
        };
        for (;;) {
            const {value, done} = await reader.read();
            if (done) break;
            if (csv) { for (const cols of csv.push(value)) takeCc(cols); }
            else {
                const lines = (tail + value).split('\n');
                tail = lines.pop(); // the last piece is a partial line until the next chunk arrives
                for (let i = 0; i < lines.length; i++) {
                    const l = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
                    // The header is the only place the format is stated. Once it says chess.com,
                    // everything still unread in this chunk has to be REJOINED and handed to the CSV
                    // reader -- splitting it here already destroyed nothing yet, but dropping the
                    // rows after the header would silently lose the first chunk's worth of puzzles.
                    if (first && l.startsWith('fen3')) {
                        first = false;
                        csv = makeCsvReader();
                        const rest = lines.slice(i + 1).concat([tail]).join('\n');
                        tail = '';
                        for (const cols of csv.push(rest)) takeCc(cols);
                        break;
                    }
                    take(l);
                }
            }
            if (batch.length >= BATCH) await flush();
        }
        if (csv) { for (const cols of csv.end()) takeCc(cols); }
        else take(tail.endsWith('\r') ? tail.slice(0, -1) : tail); // final line, if no trailing newline
        await flush();
        onProgress?.({rows, kept});
        return {rows, kept, site: csv ? 'cc' : 'li'};
    } finally {
        db.close();
    }
}

// The solution line for one position, or null. One IndexedDB read; no network, ever.
async function lookup(fen, site = 'li') {
    const store = STORES[site];
    if (!store) return null;          // a site with no database of its own -- ask nothing
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(store, 'readonly').objectStore(store).get(keyOf(fen));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

async function count(site) {
    const db = await open();
    const one = (store) => new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
    });
    try {
        if (site) return await one(STORES[site] || STORE);
        // no site asked -> both, so the settings page can show which databases are loaded
        const [li, cc] = await Promise.all([one(STORE), one(STORE_CC)]);
        return {li, cc, total: li + cc};
    } finally {
        db.close();
    }
}

async function clear(site) {
    const db = await open();
    // `site` omitted removes BOTH -- that is what the Remove button has always meant. Naming one
    // removes only that database, so re-importing a 30-minute Lichess file is not the price of
    // dropping a chess.com one.
    const stores = site ? [STORES[site] || STORE] : [STORE, STORE_CC];
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(stores, 'readwrite');
            for (const st of stores) tx.objectStore(st).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

root.PuzzleDB = {keyOf, applyUci, rowToRecord, tcnToUci, ccRowToRecord, makeCsvReader,
                 importCsv, lookup, count, clear};

})(typeof self !== 'undefined' ? self : this);
