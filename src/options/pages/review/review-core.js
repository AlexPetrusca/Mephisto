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

// PGN dates are YYYY.MM.DD (and use `??` for the parts nobody recorded). Shown as DD.MM.YYYY, with
// whatever is actually known: a date of "2026.??.??" is a year, not a broken string.
function formatDate(pgnDate) {
    const m = /^(\d{4}|\?{4})[.\-](\d{2}|\?{2})[.\-](\d{2}|\?{2})/.exec(String(pgnDate || '').trim());
    if (!m) return String(pgnDate || '');
    const [, y, mo, d] = m;
    const known = (x) => !/\?/.test(x);
    if (known(d) && known(mo) && known(y)) return `${d}.${mo}.${y}`;
    if (known(mo) && known(y)) return `${mo}.${y}`;
    return known(y) ? y : '';
}

// ---- game phases (lichess's Divider, ported) -----------------------------------------------------
// The same boundaries the panel's eval-history graph uses, so opening/middlegame/endgame land where
// a lichess user expects. Ported from scalachess Divider.scala; the panel has its own copy that
// walks chess.js, this one reads the FEN placement directly so the core stays dependency-free.
//
//   midgame = first position with  majorsAndMinors <= 10  OR  backrankSparse  OR  mixedness > 150
//   endgame = first position with  majorsAndMinors <= 6   (only looked for once a midgame exists)
//   a midgame marker that does not precede the endgame one is dropped
const PHASE_MIXEDNESS_THRESHOLD = 150;
const PHASE_MIDGAME_PIECES = 10;
const PHASE_ENDGAME_PIECES = 6;

// score(y, white, black) verbatim from Divider.scala. y is the region's rank index, 1..7.
function phaseRegionScore(y, white, black) {
    switch (white) {
        case 0: switch (black) {
            case 1: return 1 + y;
            case 2: return y < 6 ? 2 + (6 - y) : 0;
            case 3: return y < 7 ? 3 + (7 - y) : 0;
            case 4: return y < 7 ? 3 + (7 - y) : 0;
            default: return 0;
        }
        case 1: switch (black) {
            case 0: return 1 + (8 - y);
            case 1: return 5 + Math.abs(4 - y);
            case 2: return 4 + (7 - y);
            case 3: return 5 + (7 - y);
            default: return 0;
        }
        case 2: switch (black) {
            case 0: return y > 2 ? 2 + (y - 2) : 0;
            case 1: return 4 + (y - 1);
            case 2: return 7;
            default: return 0;
        }
        case 3: switch (black) {
            case 0: return y > 1 ? 3 + (y - 1) : 0;
            case 1: return 5 + (y - 1);
            default: return 0;
        }
        case 4: return black === 0 ? (y > 1 ? 3 + (y - 1) : 0) : 0;
        default: return 0;
    }
}

// grid[file][rank] -> 'w' | 'b' | null, straight off the FEN's placement field
function fenGrid(fen) {
    const grid = Array.from({length: 8}, () => new Array(8).fill(null));
    const rows = String(fen || '').split(' ')[0].split('/');
    for (let r = 0; r < 8 && r < rows.length; r++) {
        let f = 0;
        for (const ch of rows[r]) {
            if (ch >= '1' && ch <= '8') { f += ch.charCodeAt(0) - 48; continue; }
            if (f < 8) grid[f][7 - r] = (ch === ch.toUpperCase()) ? 'w' : 'b';
            f++;
        }
    }
    return grid;
}

function phaseMetrics(fen) {
    const grid = fenGrid(fen);
    const rows = String(fen || '').split(' ')[0];
    let majorsMinors = 0;
    for (const ch of rows) {
        const l = ch.toLowerCase();
        if (l >= 'a' && l <= 'z' && l !== 'k' && l !== 'p') majorsMinors++;
    }
    let whiteFirstRank = 0, blackLastRank = 0;
    for (let f = 0; f < 8; f++) {
        if (grid[f][0] === 'w') whiteFirstRank++;
        if (grid[f][7] === 'b') blackLastRank++;
    }
    let mixedness = 0;
    for (let ry = 0; ry <= 6; ry++) {
        for (let rx = 0; rx <= 6; rx++) {
            let w = 0, b = 0;
            for (let dx = 0; dx < 2; dx++) {
                for (let dy = 0; dy < 2; dy++) {
                    const col = grid[rx + dx][ry + dy];
                    if (col === 'w') w++; else if (col === 'b') b++;
                }
            }
            mixedness += phaseRegionScore(ry + 1, w, b);
        }
    }
    return {majorsMinors, backrankSparse: whiteFirstRank < 4 || blackLastRank < 4, mixedness};
}

// {mid, end} as ply indices into the position list, either possibly null.
function gamePhases(fens) {
    const out = {mid: null, end: null};
    for (let i = 0; i < fens.length; i++) {
        const {majorsMinors, backrankSparse, mixedness} = phaseMetrics(fens[i]);
        if (out.mid === null && (majorsMinors <= PHASE_MIDGAME_PIECES || backrankSparse
                || mixedness > PHASE_MIXEDNESS_THRESHOLD)) {
            out.mid = i;
        }
        if (out.mid !== null && out.end === null && majorsMinors <= PHASE_ENDGAME_PIECES) out.end = i;
    }
    if (out.mid !== null && out.end !== null && !(out.mid < out.end)) out.mid = null;
    return out;
}

// which phase a ply sits in
function phaseOf(ply, phases) {
    if (phases.end != null && ply >= phases.end) return 'endgame';
    if (phases.mid != null && ply >= phases.mid) return 'middlegame';
    return 'opening';
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
//
// Two rules the whole section obeys. First, book moves and forced moves are excluded from the
// engine-match numbers wherever it matters: memorising an opening and finding the only legal recapture
// are not evidence of anything, and leaving them in is what makes a naive match rate useless. Second,
// nothing is reported from a sample too small to mean anything -- an 8-move game does not get a
// verdict-shaped number attached to it.
function indicators(moves, color, multipv, phases, tags) {
    const mine = moves.filter(m => m.color === color);
    // The denominator is every move the engine had an opinion about -- NOT only the moves that
    // made its list. A move outside the top N is emphatically not the engine's first choice, and
    // dropping those was reporting 100% for a player who had just been told they hung a queen.
    const rated = mine.filter(m => m.best != null);
    // The moves where being right is a CHOICE: out of book, more than one legal move, and not a
    // recapture that any club player finds. This is the population that carries the signal.
    const real = rated.filter(m => !m.isBook && !m.onlyMove && !m.isRecapture);
    const sharp = real.filter(m => m.complexity != null && m.complexity >= 100); // >=1 pawn between
                                                                                // best and second
    const timed = mine.filter(m => Number.isFinite(m.seconds));
    const secs = timed.map(m => m.seconds);
    const fastCut = secs.length ? Math.max(1, median(secs) / 3) : 0;
    const fast = timed.filter(m => m.seconds <= fastCut);
    const maia = mine.filter(m => m.maiaRank != null);
    const cpls = mine.filter(m => m.cpLoss != null).map(m => m.cpLoss);
    const accs = mine.filter(m => m.acc != null).map(m => m.acc);
    const rate = (list, pred) => list.length ? list.filter(pred).length / list.length : null;
    const isTop = (m) => m.rank === 1;

    // Longest unbroken run of engine-first-choice moves, over the moves that were a real choice.
    let streak = 0, run = 0;
    for (const m of real) { run = isTop(m) ? run + 1 : 0; if (run > streak) streak = run; }

    // Per phase. The middlegame is where the question lives: the opening is memory and the endgame
    // is technique, and both inflate a match rate on their own.
    const byPhase = {};
    if (phases) {
        for (const key of ['opening', 'middlegame', 'endgame']) {
            const set = real.filter(m => phaseOf(m.ply, phases) === key);
            byPhase[key] = {n: set.length, top1: rate(set, isTop)};
        }
    }

    // Elo the tags claim, so accuracy can be read against something rather than in a vacuum.
    const eloTag = color === 'w' ? tags?.WhiteElo : tags?.BlackElo;
    const elo = /^\d{3,4}$/.test(String(eloTag || '').trim()) ? +eloTag : null;

    return {
        moves: mine.length,
        acpl: cpls.length ? Math.round(mean(cpls)) : null,
        // Median as well: one blunder in an otherwise perfect game moves the mean a long way, and
        // which of the two is the more honest summary depends on the game.
        mcpl: cpls.length ? Math.round(median(cpls)) : null,
        elo,
        top1: rate(rated, isTop),
        // Only meaningful once the engine was asked for at least three lines: with fewer, a move
        // that is not the first choice has no rank at all and "in the top 3" cannot be answered.
        top3: (rated.length && multipv >= 3) ? rate(rated, m => m.rank != null && m.rank <= 3) : null,
        // The same rate over the moves that were actually a choice. This is the headline number.
        realN: real.length,
        realTop1: rate(real, isTop),
        // Where it is HARD to be right: the engine's move was at least a pawn better than its
        // second choice, so finding it is a real result rather than an obvious recapture.
        sharpN: sharp.length,
        sharpTop1: rate(sharp, isTop),
        streak,
        byPhase,
        // Consistency. A strong human is streaky -- brilliant, then human. An engine is uniform, so
        // a LOW spread of per-move accuracy across a long game is its own kind of odd.
        accMean: accs.length ? mean(accs) : null,
        accStdev: accs.length > 6 ? stdev(accs) : null,
        // Time. A human's think time varies with the position; a relayed engine move often does not.
        secMean: secs.length ? mean(secs) : null,
        secMedian: secs.length ? median(secs) : null,
        // Coefficient of variation: stdev over mean, so it can be compared between a bullet game and
        // a classical one. Low means every move took about the same time.
        secCv: secs.length > 2 && mean(secs) > 0 ? stdev(secs) / mean(secs) : null,
        fastN: fast.length,
        fastTop1: rate(fast.filter(m => m.rank != null || m.best != null), isTop),
        // Did the hard moves get more time than the easy ones? Humans slow down for complexity;
        // a relayed move takes as long as it takes to read it off another screen.
        timeVsComplexity: correlation(
            timed.filter(m => m.complexity != null).map(m => m.complexity),
            timed.filter(m => m.complexity != null).map(m => m.seconds)),
        // The human model, when one was run: where the played move sat in Maia's OWN ranking.
        maiaN: maia.length,
        maiaTop1: rate(maia, m => m.maiaRank === 1),
        maiaTop3: rate(maia, m => m.maiaRank <= 3),
        // The combination that is actually interesting: the engine loves it, the human model did
        // not see it coming.
        engineNotHuman: maia.length
            ? maia.filter(m => m.rank === 1 && m.maiaRank > 3 && !m.isBook && !m.onlyMove).length
            : null,
    };
}

// Pearson's r. Used for one question only -- did longer thinks go to harder positions -- and
// returns null rather than a number when there is not enough to say.
function correlation(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 6) return null;
    const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const d = Math.sqrt(sxx * syy);
    return d > 0 ? sxy / d : null;
}

// The four levels, in order. Named here once because the page prints a key from this list and the
// evidence lines below assign from it -- a key that disagrees with the labels is worse than no key.
const LEVELS = [
    {key: 'normal', label: 'Normal',
     what: 'Within what ordinary play produces. Most lines in most games sit here.'},
    {key: 'notable', label: 'Notable',
     what: 'Higher than usual, and routinely reached by strong players, short games and forced sequences.'},
    {key: 'high', label: 'High',
     what: 'Unusual for a human at any strength over this many moves. Worth a second look, not a conclusion.'},
    {key: 'strong', label: 'Strong',
     what: 'What engine assistance looks like. It is also what a memorised line, a blitz scramble or a tiny sample looks like.'},
];

// A threshold ladder: the first band the value clears, walking down from the strongest.
function band(value, strong, high, notable) {
    if (value == null) return 'normal';
    if (value >= strong) return 'strong';
    if (value >= high) return 'high';
    if (value >= notable) return 'notable';
    return 'normal';
}

// Turn the indicators into short evidence lines. Deliberately NOT a score: a number between 0 and
// 100 reads as a probability and this cannot produce one. Each line says what was measured and what
// it is worth, and the caller shows them under a heading that says so too.
function evidence(ind, opts) {
    const out = [];
    const pct = (x) => (x * 100).toFixed(0) + '%';
    const add = (key, level, text, note) => out.push({key, level, text, note});

    if (ind.realTop1 != null && ind.realN >= 8) {
        add('real', band(ind.realTop1, 0.9, 0.8, 0.65),
            `Played the engine's first choice on ${pct(ind.realTop1)} of ${ind.realN} moves that were a real choice.`,
            'Book moves, forced moves and recaptures are excluded, which is what makes this different '
            + 'from the raw match rate. Strong club players land around 45-60% here; grandmasters 60-70%.');
    }
    if (ind.top1 != null) {
        add('top1', band(ind.top1, 0.92, 0.85, 0.75),
            `Raw match rate ${pct(ind.top1)} over all ${ind.moves} moves`
            + (ind.top3 != null ? `, and ${pct(ind.top3)} in the engine's top three.` : '.'),
            'Shown for completeness. It counts openings and forced sequences, so it flatters everyone '
            + 'and flatters short games most.');
    }
    if (ind.sharpTop1 != null && ind.sharpN >= 4) {
        add('sharp', band(ind.sharpTop1, 0.85, 0.7, 0.55),
            `Found the engine's move in ${pct(ind.sharpTop1)} of ${ind.sharpN} positions where it was at least a pawn better than the second-best.`,
            'This is the number that separates a strong player from a strong engine: these are the '
            + 'positions where a human is expected to slip.');
    }
    if (ind.streak >= 6) {
        add('streak', band(ind.streak, 18, 12, 8),
            `A run of ${ind.streak} consecutive engine-first-choice moves, out of book and out of forced lines.`,
            'Long unbroken runs happen in one-sided or forcing positions. They are still the shape '
            + 'assistance leaves.');
    }
    for (const key of ['middlegame', 'endgame']) {
        const p = ind.byPhase?.[key];
        if (!p || p.n < 8 || p.top1 == null) continue;
        add(`phase-${key}`, band(p.top1, 0.88, 0.78, 0.65),
            `${key === 'middlegame' ? 'Middlegame' : 'Endgame'} match rate ${pct(p.top1)} over ${p.n} moves.`,
            key === 'middlegame'
                ? 'The middlegame is where this question lives: the opening is memory and the endgame is technique.'
                : 'Endgames are technique and tablebase-like knowledge, so a high rate here is much weaker evidence.');
    }
    if (ind.accStdev != null) {
        // INVERTED: uniformity is the odd thing here, so the band is built from its complement.
        add('uniform', band(1 - Math.min(1, ind.accStdev / 30), 0.9, 0.82, 0.72),
            `Per-move accuracy varies by ±${ind.accStdev.toFixed(1)} points around ${ind.accMean.toFixed(0)}%.`,
            'Humans are streaky: brilliant, then ordinary, then careless. A very even game is what a '
            + 'machine looks like, and also what a short, quiet game looks like.');
    }
    if (ind.secCv != null) {
        add('time', band(1 - Math.min(1, ind.secCv / 1.2), 0.75, 0.62, 0.5),
            `Think time varied by ${(ind.secCv * 100).toFixed(0)}% of its own average (median ${ind.secMedian.toFixed(1)}s per move).`,
            'Humans spend very different amounts of time on easy and hard moves. A flat profile is '
            + 'what a relayed move looks like; it is also what a pre-move scramble and a bullet game look like.');
    }
    if (ind.timeVsComplexity != null) {
        // Negative or near-zero is the suspicious direction: no extra time for the hard positions.
        add('effort', band(0.5 - ind.timeVsComplexity / 2, 0.72, 0.62, 0.55),
            `Correlation between how hard a position was and how long it got: ${ind.timeVsComplexity.toFixed(2)}.`,
            'A human thinks longer when the position is sharper, which shows up as a positive number. '
            + 'Around zero means the clock was spent without reference to the board.');
    }
    if (ind.fastTop1 != null && ind.fastN >= 4) {
        add('fast', band(ind.fastTop1, 0.9, 0.8, 0.65),
            `Of the ${ind.fastN} quickest moves, ${pct(ind.fastTop1)} were the engine's first choice.`,
            'Fast and right together is normal in forced positions and unusual outside them.');
    }
    if (ind.maiaTop1 != null && ind.maiaN >= 8) {
        add('maia', band(1 - ind.maiaTop1, 0.85, 0.75, 0.6),
            `The human model expected ${pct(ind.maiaTop1)} of these moves as its first choice, ${pct(ind.maiaTop3)} within its top three.`,
            'Maia predicts what a human of the chosen rating plays, not what is best. A game the '
            + 'engine recognises and the human model does not is the interesting combination.');
    }
    if (ind.engineNotHuman != null && ind.maiaN >= 8) {
        add('divergent', band(ind.engineNotHuman / Math.max(1, ind.maiaN), 0.35, 0.25, 0.15),
            `${ind.engineNotHuman} move${ind.engineNotHuman === 1 ? '' : 's'} the engine ranked first and the human model did not rank in its top three.`,
            'The clearest single shape in this whole section: an engine move a player of this rating '
            + 'was not expected to find. Small counts mean very little.');
    }
    if (ind.acpl != null) {
        add('acpl', 'normal',
            `Average centipawn loss ${ind.acpl} (median ${ind.mcpl})`
            + (ind.elo ? `, at a stated rating of ${ind.elo}.` : '.'),
            'Shown for context. It falls with the length of the game and rises with sharp positions, '
            + 'so it compares badly between games.');
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
    parsePgn, clockToSeconds, formatDate, gamePhases, phaseOf, LEVELS,
    toWhiteCp, isMateScore, winPercent, moveAccuracy, classify, CLASS_ORDER, MATE_CP,
    accuracyFor, indicators, evidence, parseInfo, clamp,
};

})(typeof self !== 'undefined' ? self : globalThis);
