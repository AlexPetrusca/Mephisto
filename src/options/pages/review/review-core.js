// Game Review: the parts with no DOM in them.
//
// Split out from review.js so every rule in here can be run under node -- PGN parsing, the eval
// bookkeeping, the accuracy maths and the cheat indicators are all pure functions of their input,
// and those are exactly the parts where a quiet mistake would be invisible on screen. review.js
// owns the page; this file owns the arithmetic. Loaded as a plain script (it assigns to `self`),
// the same way panel-board.js and chess.js are, so node can `eval` it with a `self` of its own.
(function (root) {
'use strict';

// ---- PGN --------------------------------------------------------------------------------------
// Not a general PGN library: what chess.com and lichess export, which is a tag pair block, SAN with
// move numbers, `{...}` comments (chess.com puts the clock in one as `[%clk 0:02:31.4]`), NAGs, and
// recursive variations in parentheses. Variations are SKIPPED rather than parsed -- a review is of
// the game that was played. `lib/chess.js` here has no PGN loader (it was stripped for the panel),
// so this is the only reader in the extension.

// One `[Tag "value"]` per line, quotes escaped with a backslash.
function parseTags(block) {
    const tags = {};
    const re = /\[\s*(\w+)\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
    let m;
    while ((m = re.exec(block))) tags[m[1]] = m[2].replace(/\\(.)/g, '$1');
    return tags;
}

// "0:02:31.4" / "2:31" / "31.4" -> seconds. chess.com writes h:mm:ss(.d), lichess m:ss.
function clockToSeconds(text) {
    if (!text) return null;
    const parts = String(text).trim().split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Split a multi-game PGN into per-game text. A blank line inside a game is legal (between the tag
// block and the moves), so games are split on a tag block that FOLLOWS movetext, not on blank lines.
function splitGames(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const games = [];
    let cur = [], sawMoves = false;
    for (const line of lines) {
        const isTag = /^\s*\[\s*\w+\s+"/.test(line);
        if (isTag && sawMoves) {
            games.push(cur.join('\n'));
            cur = []; sawMoves = false;
        }
        if (!isTag && line.trim()) sawMoves = true;
        cur.push(line);
    }
    if (cur.join('').trim()) games.push(cur.join('\n'));
    return games.filter(g => g.trim());
}

// Strip variations, keeping the mainline. Parentheses nest; a `)` at depth 0 is a malformed file
// rather than something to guess about, so it is simply dropped.
function stripVariations(movetext) {
    let out = '', depth = 0;
    for (const ch of movetext) {
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
        if (!depth) out += ch;
    }
    return out;
}

// One game: {tags, startFen, moves: [{san, clk, comment}], result}
function parseGame(text) {
    const firstMove = text.search(/^\s*(?!\[)\S/m);
    const tagBlock = firstMove < 0 ? text : text.slice(0, firstMove);
    const tags = parseTags(tagBlock);
    let movetext = firstMove < 0 ? '' : text.slice(firstMove);

    // comments are pulled out BEFORE variations are stripped: a `(` inside a comment is text
    const comments = [];
    movetext = movetext.replace(/\{([^}]*)\}/g, (m, body) => {
        comments.push(body);
        return ` ${comments.length - 1} `;
    });
    movetext = stripVariations(movetext);
    movetext = movetext.replace(/;[^\n]*/g, ' ');          // rest-of-line comment
    movetext = movetext.replace(/\$\d+/g, ' ');            // NAGs
    movetext = movetext.replace(/\d+\s*\.(\.\.)?/g, ' ');  // move numbers, incl. black's "12..."

    const moves = [];
    for (const tok of movetext.split(/\s+/)) {
        if (!tok) continue;
        const cm = /^(\d+)$/.exec(tok);
        if (cm) {                                          // a comment belongs to the move BEFORE it
            const body = comments[+cm[1]];
            if (moves.length) applyComment(moves[moves.length - 1], body);
            continue; // a comment before the first move is the game's, not a move's -- dropped

        }
        if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
        moves.push({san: tok.replace(/[?!]+$/, ''), clk: null, eval: null, comment: ''});
    }
    return {
        tags,
        // Chess960 and set-up positions: SetUp/FEN is the game's real start
        startFen: tags.FEN || null,
        result: tags.Result || '*',
        moves,
    };
}

function applyComment(move, body) {
    const clk = /\[%(?:clk|emt)\s+([0-9:.]+)]/.exec(body);
    if (clk) move.clk = clockToSeconds(clk[1]);
    const ev = /\[%eval\s+(#?-?[\d.]+)]/.exec(body);
    if (ev) move.eval = ev[1];
    const text = body.replace(/\[%[^\]]*]/g, '').trim();
    if (text) move.comment = (move.comment ? move.comment + ' ' : '') + text;
}

function parsePgn(text) {
    return splitGames(text).map(parseGame).filter(g => g.moves.length);
}

// ---- eval bookkeeping --------------------------------------------------------------------------
// Every score below is WHITE-POSITIVE centipawns unless it says otherwise. UCI reports from the side
// to move, which is the single easiest thing in this whole file to get backwards, so it is converted
// once, here, and never again.

const MATE_CP = 100000;   // a mate score, kept far outside any real eval so ordering still works

// A UCI line's score -> white-positive centipawns. `turn` is whose move it was in that position.
function toWhiteCp(score, mate, turn) {
    const stm = (mate != null && mate !== undefined)
        ? (mate > 0 ? MATE_CP - Math.abs(mate) : -(MATE_CP - Math.abs(mate)))
        : score;
    return turn === 'w' ? stm : -stm;
}

function isMateScore(cp) { return Math.abs(cp) > MATE_CP - 1000; }

// Lichess's win percentage (lila, WinPercent.scala). The panel has the same function; both are the
// published formula rather than a house rule, and test_popup_logic.js pins the two copies together.
function winPercent(cp) {
    if (isMateScore(cp)) return cp > 0 ? 100 : 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -2000, 2000))) - 1);
}

// Lichess's per-move accuracy (lila, AccuracyPercent.scala), from the win% the move gave away.
function moveAccuracy(before, after) {
    const drop = Math.max(0, before - after);
    if (drop <= 0) return 100;
    const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
    return clamp(acc, 0, 100);
}

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// The panel's bands, in win% lost, so a review agrees with what the panel called the move live.
const BLUNDER = 30, MISTAKE = 20, INACCURACY = 10;

// Classify one played move. `rank` is where it sat in the engine's own list (1 = the engine's move),
// or null when the list did not reach it.
function classify({winBefore, winAfter, rank, onlyMove, isBook}) {
    const lost = Math.max(0, winBefore - winAfter);
    if (isBook) return 'book';
    if (lost >= BLUNDER) return 'blunder';
    if (lost >= MISTAKE) return 'mistake';
    if (lost >= INACCURACY) return 'inaccuracy';
    if (rank === 1) return onlyMove ? 'forced' : 'best';
    if (lost < 2) return 'excellent';
    return 'good';
}

const CLASS_ORDER = ['best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'mistake', 'blunder'];

// ---- per-game statistics -----------------------------------------------------------------------
// `moves` is the analysed move list review.js builds: one entry per played move, each with
// {color, cpLoss, winBefore, winAfter, rank, klass, seconds, complexity, maiaMatch}.

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function median(xs) {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const i = s.length >> 1;
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function stdev(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

// Lichess weights each move's accuracy by how much was at stake around it (a volatility window), so
// a dead-drawn shuffle cannot inflate the number. Same idea here: the weight is the standard
// deviation of the win% over a window centred on the move, floored so every move still counts.
function accuracyFor(moves, color) {
    const mine = moves.filter(m => m.color === color && m.acc != null);
    if (!mine.length) return null;
    const wins = moves.map(m => m.winBefore);
    const weights = mine.map(m => {
        const i = m.ply;
        const w = Math.max(2, Math.round(moves.length / 10));
        // Only the moves that were actually analysed. A position the engine returned nothing for
        // leaves winBefore undefined, and one of those in the window made stdev NaN, which then
        // spread through the weighted sum and rendered the whole game's accuracy as "NaN%".
        const win = wins.slice(Math.max(0, i - w), i + w + 1).filter(Number.isFinite);
        return clamp(stdev(win), 0.5, 12);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const weighted = mine.reduce((a, m, i) => a + m.acc * weights[i], 0) / (total || 1);
    // Lichess reports the mean of the weighted mean and the harmonic mean -- the harmonic one is
    // what stops a single 100% streak from hiding a blunder.
    const harmonic = mine.length / mine.reduce((a, m) => a + 1 / Math.max(m.acc, 1), 0);
    const out = (weighted + harmonic) / 2;
    return Number.isFinite(out) ? clamp(out, 0, 100) : null;
}

// The measurements the "is this engine-assisted?" question actually rests on. Every field is a
// COUNT or a RATE that anyone can re-derive from the move table; nothing here decides anything.
function indicators(moves, color, multipv) {
    const mine = moves.filter(m => m.color === color);
    // The denominator is every move the engine had an opinion about -- NOT only the moves that
    // made its list. A move outside the top N is emphatically not the engine's first choice, and
    // dropping those was reporting 100% for a player who had just been told they hung a queen.
    const rated = mine.filter(m => m.best != null);
    const timed = mine.filter(m => Number.isFinite(m.seconds));
    const sharp = mine.filter(m => m.complexity != null && m.complexity >= 100); // >=1 pawn between
                                                                                // best and second
    const fast = timed.filter(m => m.seconds <= Math.max(1, median(timed.map(t => t.seconds)) / 3));
    const maia = mine.filter(m => m.maiaMatch != null);
    const cpls = mine.filter(m => m.cpLoss != null).map(m => m.cpLoss);
    const secs = timed.map(m => m.seconds);
    return {
        moves: mine.length,
        acpl: cpls.length ? Math.round(mean(cpls)) : null,
        // Median as well: one blunder in an otherwise perfect game moves the mean a long way, and
        // which of the two is the more honest summary depends on the game.
        mcpl: cpls.length ? Math.round(median(cpls)) : null,
        top1: rated.length ? rated.filter(m => m.rank === 1).length / rated.length : null,
        // Only meaningful once the engine was asked for at least three lines: with fewer, a move
        // that is not the first choice has no rank at all and "in the top 3" cannot be answered.
        top3: (rated.length && multipv >= 3)
            ? rated.filter(m => m.rank != null && m.rank <= 3).length / rated.length : null,
        // Where it is HARD to be right: the engine's move was at least a pawn better than its
        // second choice, so finding it is a real result rather than an obvious recapture.
        sharpN: sharp.length,
        sharpTop1: sharp.length ? sharp.filter(m => m.rank === 1).length / sharp.length : null,
        // Time. A human's think time varies with the position; a relayed engine move often does not.
        secMean: secs.length ? mean(secs) : null,
        secMedian: secs.length ? median(secs) : null,
        // Coefficient of variation: stdev over mean, so it can be compared between a bullet game and
        // a classical one. Low means every move took about the same time.
        secCv: secs.length > 2 && mean(secs) > 0 ? stdev(secs) / mean(secs) : null,
        fastN: fast.length,
        fastTop1: fast.length ? fast.filter(m => m.rank === 1).length / fast.length : null,
        // The human model, when one was run: how often the played move was what Maia expected.
        maiaN: maia.length,
        maiaMatch: maia.length ? maia.filter(m => m.maiaMatch).length / maia.length : null,
    };
}

// Turn the indicators into short evidence lines. Deliberately NOT a score: a number between 0 and
// 100 reads as a probability and this cannot produce one. Each line says what was measured and what
// it is worth, and the caller shows them under a heading that says so too.
function evidence(ind, opts) {
    const out = [];
    const pct = (x) => (x * 100).toFixed(0) + '%';
    const phase = (opts && opts.phase) || 'the whole game';
    if (ind.top1 != null) {
        out.push({
            key: 'top1',
            level: ind.top1 >= 0.9 ? 'high' : ind.top1 >= 0.75 ? 'notable' : 'normal',
            text: `Played the engine's first choice on ${pct(ind.top1)} of ${ind.moves} moves over ${phase}.`,
            note: 'Strong players reach 55-70% in ordinary games; short games and forced sequences push this up on their own.',
        });
    }
    if (ind.sharpTop1 != null && ind.sharpN >= 4) {
        out.push({
            key: 'sharp',
            level: ind.sharpTop1 >= 0.85 ? 'high' : ind.sharpTop1 >= 0.7 ? 'notable' : 'normal',
            text: `Found the engine's move in ${pct(ind.sharpTop1)} of ${ind.sharpN} positions where it was at least a pawn better than the second-best.`,
            note: 'This is the number that separates a strong player from a strong engine: these are the positions where a human is expected to slip.',
        });
    }
    if (ind.secCv != null) {
        out.push({
            key: 'time',
            level: ind.secCv <= 0.35 ? 'high' : ind.secCv <= 0.55 ? 'notable' : 'normal',
            text: `Think time varied by ${(ind.secCv * 100).toFixed(0)}% of its own average (median ${ind.secMedian.toFixed(1)}s per move).`,
            note: 'Humans spend very different amounts of time on easy and hard moves. A flat profile is what a relayed move looks like; it is also what a pre-move scramble and a bullet game look like.',
        });
    }
    if (ind.fastTop1 != null && ind.fastN >= 4) {
        out.push({
            key: 'fast',
            level: ind.fastTop1 >= 0.85 ? 'high' : ind.fastTop1 >= 0.7 ? 'notable' : 'normal',
            text: `Of the ${ind.fastN} quickest moves, ${pct(ind.fastTop1)} were the engine's first choice.`,
            note: 'Fast and right together is normal in forced positions and unusual outside them.',
        });
    }
    if (ind.maiaMatch != null && ind.maiaN >= 8) {
        out.push({
            key: 'maia',
            level: ind.maiaMatch <= 0.25 && ind.top1 >= 0.8 ? 'notable' : 'normal',
            text: `The human model expected ${pct(ind.maiaMatch)} of these moves.`,
            note: 'Maia is trained on human games at a rating band. Moves that the engine loves and the human model does not expect are the interesting combination.',
        });
    }
    if (ind.acpl != null) {
        out.push({
            key: 'acpl',
            level: 'normal',
            text: `Average centipawn loss ${ind.acpl} (median ${ind.mcpl}).`,
            note: 'Shown for context. It falls with the length of the game and rises with sharp positions, so it compares badly between games.',
        });
    }
    return out;
}

// ---- UCI line reading ---------------------------------------------------------------------------
// `info depth 20 seldepth 27 multipv 1 score cp 34 nodes ... pv e2e4 e7e5`
function parseInfo(line) {
    if (!/^info /.test(line)) return null;
    const out = {};
    const num = (k) => { const m = new RegExp(`\\b${k} (-?\\d+)`).exec(line); return m ? +m[1] : null; };
    out.depth = num('depth');
    out.multipv = num('multipv') ?? 1;
    out.nodes = num('nodes');
    out.nps = num('nps');
    const cp = /\bscore cp (-?\d+)/.exec(line);
    const mate = /\bscore mate (-?\d+)/.exec(line);
    if (cp) out.score = +cp[1];
    if (mate) out.mate = +mate[1];
    const pv = /\bpv (.+)$/.exec(line);
    out.pv = pv ? pv[1].trim().split(/\s+/) : [];
    // A `lowerbound`/`upperbound` score is a partial result of an aspiration re-search: the real
    // score is only known to be beyond it. Reading one as a score makes an eval graph jump.
    out.bound = /\b(lowerbound|upperbound)\b/.test(line);
    if (out.depth == null || (!cp && !mate) || !out.pv.length) return null;
    return out;
}

// What the page and the test ladder actually call. parseGame/splitGames/parseTags/stripVariations
// and the three statistics helpers stay internal: they are steps of the functions below, and an
// export with no caller is surface that has to keep working for nobody.
root.MephistoReviewCore = {
    parsePgn, clockToSeconds,
    toWhiteCp, isMateScore, winPercent, moveAccuracy, classify, CLASS_ORDER, MATE_CP,
    accuracyFor, indicators, evidence, parseInfo, clamp,
};

})(typeof self !== 'undefined' ? self : globalThis);
