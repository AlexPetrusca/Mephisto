![Mephisto](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

<div align="center">

![Version](https://img.shields.io/badge/version-3.1.276-3fb950)
![Engines](https://img.shields.io/badge/engines-9-58a6ff)
![Sites](https://img.shields.io/badge/sites-5-8b949e)
![Languages](https://img.shields.io/badge/languages-14-f0883e)
![Source](https://img.shields.io/badge/source-MIT-green)

</div>

**Real-time chess analysis, game review and automated play on Chess.com, Lichess, BlitzTactics, TakeTakeTake and
ChessBase Tactics.** Mephisto reads the position straight off the page, runs **Stockfish** (NNUE), **Fairy-Stockfish**
or **Maia** entirely in your browser - no server, no account - and draws the best move on the board, or plays it for
you with timing and move choices tuned to look human.

It also does a full **game review**: an **offline engine review** (accuracy, move quality, an eval graph and
fair-play indicators) that never leaves your machine, or **chess.com's own Game Review** - the real one from their
service, at their Fast/Standard/Deep/Maximum tiers, run from your own account - rendered right on the board.

Click the toolbar icon to toggle a floating panel over the board. Unlike a normal extension popup it stays open while
you click and play, so analysis and autoplay keep running for the whole game.

![Analysis with five candidate lines drawn on the board](docs/analysis-lines.png)

[Fair play](#fair-play--read-this-first) · [Install](#install) · [Engines](#engines) · [Features](#features) ·
[Sites](#supported-sites) · [Settings](#settings-reference) · [Footprint](#page-footprint) · [Roadmap](#roadmap)

---

## Fair play - read this first

**Using this in a live game against another person violates the Terms of Service of every chess site.** Account
closures are typically permanent, applied at the device and payment level (so your other accounts go too), and
ratings, prizes and tournament results get rolled back.

**This extension cannot make you undetectable.** What catches engine users is server-side and behavioural: move
agreement measured over many games, think-time distributions that look nothing like a person's, accuracy that doesn't
fit your rating history. Those are statistical and aggregated across your account - they don't care what your DOM
looks like. The anti-detection work here addresses one narrow thing, *passive client-side fingerprinting*: a site
noticing the extension is installed. Even [the people writing detection for
it](https://github.com/AlexPetrusca/Mephisto/issues/35) call that a corroborating signal that shouldn't trigger a
sanction alone. Reducing your footprint changes a footnote in a case file, not the case.

**Genuinely good for:** reviewing your own finished games · studying openings and endgames · puzzles and tactics ·
engine development and benchmarking · analysis boards and offline play · unrated games where your opponent knows.

You are responsible for how you use this.

---

## Why this fork

An **actively maintained** continuation of [Mephisto by Alex
Petrusca](https://github.com/AlexPetrusca/Mephisto). Installed from upstream today it detects nothing - the 2026
Chess.com and Lichess redesigns broke every scraper. This fork revives it and goes well past it. Everything the
original did still works.

New here:

- **Game Review** - a full **offline game review** (accuracy, move quality, an eval graph and fair-play
  indicators) that never leaves your machine, **and chess.com's own Game Review** rendered on the same
  board, run from your own account (unlimited with chess.com premium, the free-tier allowance without).
- **Engines** - modern **Stockfish dev / 18**, the human-like **Maia** and **Maia-3** nets, and an **Elo cap**.
- **Playing like a person** - **Humanize**, **Clock Mode** and **Mirror Time**.
- **Automation** - **Safe Premove**, **Pondering**, **Help Mode**, **Manual Mode** and rebindable **hotkeys**.
- **Beyond the engine** - the **Opening Explorer**, an **endgame tablebase** and the **puzzle database**.
- **On screen** - the **eval bar**, the **eval history graph**, **screen reading**, a **screenshot-to-FEN**
  reader and a **playable panel board**.
- **Coverage** - **Chess.com variants**, **four-player chess**, **TakeTakeTake**, **Chess960** and
  **fourteen languages**.
- **Under the hood** - a **zero-iframe panel** with no page-visible extension URLs, move-correctness guards,
  copy FEN/PGN and settings export/import.

---

## Install

Distributed as an unpacked extension, not through the stores.

1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. **Load unpacked** → select the repository folder.
4. Pin it: puzzle icon right of the address bar → pin "Mephisto Chess Extension".

### Which download?

Every [release](https://github.com/IchNukeDichWeg/Mephisto/releases) carries two archives:

| | | |
|---|---|---|
| `mephisto-<version>.zip` | **~585 MB** | **First install, always.** Everything, engines included. |
| `mephisto-<version>-update.zip` | **~6 MB** | **Already have it.** Code only - extract *over* your existing folder. |

Nearly all of the full archive is bundled engines: 874 MB of neural nets and WASM under `lib/engine`, plus 13 MB of
onnxruntime under `lib/ort`. Those change on almost no release, so the update archive leaves them alone and carries
only the ~1 MB of extension code - about a hundredth the download.

> ⚠️ **Extract the update over your existing install, never into an empty folder.** Without the engines it cannot
> run. If you do it anyway the panel says so rather than failing obscurely - it checks for the bundled engines at
> startup and tells you to fetch the full archive.
>
> **Both archives unpack into a `Mephisto-<version>/` folder**, so "over your install" means copying that folder's
> **contents** into the folder Chrome already has loaded, replacing what is there. Dropping the folder itself in
> leaves you with a `Mephisto-3.1.227/` sitting *inside* your install and nothing actually updated - the extension
> keeps running the old files and looks like the update did nothing. **[Automatic updates](#automatic-updates-opt-in)
> avoid this entirely**: they take the same archive and write the files in place for you.

**Extract in place.** Chrome derives an unpacked extension's id from its folder path, so replacing files in the
folder you already loaded keeps the same id - and native engines, which are registered against that id, keep
working. Unpacking into a *new* folder changes the id and means re-running the native-host installer.

To pick up a change: reload on `chrome://extensions`, then reload the game tab. The panel checks this repository for
a newer release at most once every 12 hours, from the service worker, so the chess page never makes the request.

### Automatic updates (opt-in)

Chrome never updates an extension you loaded yourself, so Mephisto can do it for you instead - **Settings → General →
Updates**. It is **off by default**, and nothing about it runs until you switch it on.

Set-up is three steps, once:

1. **Automatic Updates → On.** Chrome asks for permission to download from this repository's releases. Refusing
   leaves the switch off.
2. **Choose Extension Folder** → pick the folder you loaded as an unpacked extension. Chrome remembers it.
3. **Install Update** when one is offered.

After that it is one button. It downloads the ~6 MB update archive, writes it over that folder and reloads the
extension - the same *extract in place* described above, so your extension id survives and native engines keep
working. Reload any game tab you had open afterwards.

Once all three are in place you don't have to come back here at all: the panel's own update notice becomes the
button. It reads *"Update available - v… - click to install"* and does the whole thing. With anything missing it
stays what it always was, a link to the releases page, because there would be nothing to click that would work.

What it will not do:

| | |
|---|---|
| Install anything by itself | It checks and it tells you. Files are only written when you press **Install Update**. |
| Touch the bundled engines | The update archive doesn't contain them, so `lib/engine` and `lib/ort` are left alone. |
| Write into the wrong folder | A folder is rejected unless its `manifest.json` is this extension's. |
| Apply a broken download | The whole archive is unpacked and checked in memory first. If anything is off - a bad path, a version that disagrees with the release, a missing file the extension needs to boot - nothing is written at all. |
| Anything at all, while switched off | Every button is disabled, the panel stops offering one click, and the installer refuses outright. Switching off records that choice and keeps it, whether or not Chrome agrees to hand the permission back. |

> The permission is scoped to this repository's release downloads, not to github.com. You can see it, and take it
> back, on `chrome://extensions` - or just switch Automatic Updates off, which hands it back for you.

Updating by hand still works exactly as before, and is still the whole story if you'd rather not grant anything.

---

## Engines

Everything runs locally via WebAssembly - no server, no account, nothing leaves your machine. The two **Cloud** entries at the bottom of the table are the one exception, and they are opt-in: choosing one sends the position you are looking at to that provider on every move.

| Engine | Notes |
| --- | --- |
| **Stockfish dev NNUE** | Latest development build. Default. |
| **Stockfish 18 / 18 Small NNUE** | Full dual-net build (large net ships split and is stitched at load), or the lighter net. |
| **Stockfish 11 HCE** | Classical eval, no NNUE - light and fast. |
| **Fairy-Stockfish 14 NNUE** | Required for [variants](#variants); each variant has its own bundled net. |
| **Maia-3** | Human-*like*, not throttled: a transformer conditioned on a rating you set live, **600–2600**. |
| **Maia** | The original Maia-1 nets, one per band (**1100–1900**, plus a **2200**). |
| **Tetrarch (4-player)** | Four-player chess only - see [four-player chess](#four-player-chess). Needs a one-time install. |
| **Remote / native** | A real engine binary outside the browser - see [full-power engines](#full-power-native-engines-optional). |
| **Stockfish 18 (online) / Stockfish 17.1 (online)** | A real server-side Stockfish over HTTPS - nothing to install, for a machine that cannot run a strong engine locally. **The position leaves your machine on every move.** One line, no threads or hash to set, so a local engine is both faster and private; this is a fallback, not an upgrade. The version in each name is the engine that provider runs, from its own front page: chess-api.com serves Stockfish 18 NNUE, stockfish.online serves Stockfish 17.1. chess-api.com takes your Search Time as well as a depth ceiling (measured: 50ms reaches depth 14, 2s reaches 16); stockfish.online takes only a depth, so selecting it switches the search budget to Depth and switches it back when you leave. A stall or a rate limit is retried once, and a position already asked about inside the last 15 seconds is answered from memory rather than asked again - which is what was drawing the rate limits. chess-api.com refuses any position carrying an en-passant square, so that field is dropped for it; the one cost is that an en passant capture is invisible to that provider, and stockfish.online is the one to use if that matters. |

<img src="docs/maia3.png" alt="Maia-3 with the 600-2600 rating slider" width="49%"> <img src="docs/variants.png" alt="Atomic on Lichess, analysed by Fairy-Stockfish" width="49%">

*Maia-3's live rating slider · Atomic analysed by Fairy-Stockfish*

Illegal scraped positions (missing king, wrong side in check, back-rank pawns) are blocked before they can crash the
engine, and a crashed engine auto-restarts, capped at 3 attempts.

**Strength cap** - limit any Stockfish/Fairy engine to a target Elo with an engine-aware slider whose stops follow
that engine's real `UCI_Elo` range. Both ends mean full strength.

### Variants

**Chess960** works on every mainline Stockfish via `UCI_Chess960`, including every castling case. Fairy-Stockfish
adds all of Lichess's variants (Crazyhouse, King of the Hill, Three-Check, Antichess, Atomic, Horde, Racing Kings)
plus Chess.com's **Duck, Minihouse, Seirawan and Chaturanga**. The ↻ button beside the variant selector detects the
variant and switches engine for you.

Duck, Minihouse, Seirawan and Chaturanga have nets but the bundled chess.js can't replay them - the panel says so
instead of analysing the wrong position.

---

## Features

### Analysis in the panel

<details>
<summary>Opening Explorer, tablebase, eval bar and history, screen reading</summary>

- **Multiple lines** - top candidates (MultiPV) up to what the engine supports, each drawn with its evaluation, its rank and its own score. With a **human model** selected the column shows how likely each move is instead of the same position eval five times.
- **Eval bar** - vertical bar beside the board, from your perspective, plus an **eval history graph** shaped like
  Lichess's, marking where the opening, middlegame and endgame begin (ported from scalachess's `Divider`).
- **Threat analysis** - the opponent's strongest reply, so you see what they're threatening.
- **Move confidence** - how much better the best move is than the second: `clearly best (+3.7)`, `+0.35 over #2`,
  `several equal`, `only move`. Read off the MultiPV lines already on screen, so it costs no extra search.
- **Explain moves** - names the tactic behind the choice (fork, promotion, winning capture, mate). Deliberately
  conservative: pins, skewers and discovered attacks can't be established from the position alone, so it stays quiet
  rather than guessing.
- **Opening Explorer** - how humans played this opening (Lichess database): the name, the most-played replies with
  their win/draw/loss split, and coloured arrows. Masters, all Lichess, or a club band. Lichess requires a personal
  API token on this endpoint now - see the setting of that name; Game Review names openings without it, from its own
  bundled table.
- **Read a position off the screen** - the camera button captures the tab, finds the board and loads it. Any site: a
  video, a diagram, an image. Nothing is uploaded. **Follow screen** re-reads twice a second so a board playing
  elsewhere keeps the panel in step.
- **Playable panel board** - click or drag to walk a line, with underpromotion. Every move is kept as a line you can
  click back into.

<img src="docs/multiple-lines.png" alt="Three candidate lines, each with its own coloured arrow" width="49%"> <img src="docs/opening-explorer.png" alt="The opening explorer, with each book move drawn on the board" width="49%">

*Three candidate lines, each its own arrow · the explorer's book moves on the board*

![Reading a position straight off a YouTube video](docs/read-from-screen.png)

*Reading a position straight off a YouTube video - a board reading is a guess and says so, naming its least-confident
squares (`least sure: e4 pawn 62%`).*

</details>

### The Analysis page

<details>
<summary>a board you play on, both engines at once, and what a human of any rating would play here</summary>

A page of its own - **Settings → Analysis**. The panel is built for a live game: small, out of the way,
one engine at a time. Studying wants the opposite.

- **A board you play on.** Click or drag, with underpromotion. Playing a move truncates the line and
  continues from there, because the question a study board answers is *what if*. Arrow keys walk it,
  the move list jumps to any ply, and **Copy FEN** / **Copy PGN** take the position or the line with you
  (a line that did not start from the initial position carries its FEN tags, so it reads back as the
  same game).
- **Both answers side by side.** The engine's candidate lines, and next to them what a **human of a
  chosen rating** would actually play, with the net's own probability per move. That contrast is the
  point of the page, which is why the human model is a column rather than a toggle.
- **Search time, or none.** A slider from 1 to 60 seconds, and one notch past 60 that means exactly
  `go infinite`: the engine keeps thinking about the position in front of you until you move on.
- **Moves by rating.** Every candidate swept across the whole rating range - ten bands for Maia 1, 600
  to 2600 in hundreds for Maia 3 - drawn as one chart so the lines can be compared, each named at its
  own end, with a readout that follows the pointer and gives every move's probability at the band under
  it. This is where you can see e4 fall away and d4 climb as strength rises. The ply *after* the one you
  are looking at is swept in the background, so stepping through a game draws from cache (7ms) instead
  of sweeping again.
- **Export the position, not a picture of it.** One self-contained file: the board as it stands, the FEN,
  the line that got there, the chart, and the table of numbers behind the chart. Stylesheets inlined,
  pieces embedded, no scripts, nothing to fetch - so what you send can be read *and* loaded back.
- **Win / draw / loss** beside the board, each number named rather than three bare percentages, and an
  **eval bar** down the side.
- **Opening book** - load a Polyglot `.bin`, a PGN or a JSON table and its moves are listed for the
  position on the board.

</details>

### Game review (offline)

<details>
<summary>accuracy, move quality, alternate lines, fair-play measurements - all local</summary>

Analyse finished games on the extension's own page - **Settings → Game Review**. Paste a PGN, load a
`.pgn`, or fetch a player's recent games from Chess.com's or Lichess's public API - pick the site, type
the username, and their recent games land in the picker (standard chess only from Lichess, so a
crazyhouse game cannot come back as a silently broken review). **Nothing leaves your machine** during
the review itself: the text stays in the tab and the search runs in the extension's own engine, so the
review works fully offline once the games are in the box. (If you would rather have chess.com's own
review instead, see the next section.)

- **Any engine, at your budget** - the bundled WASM Stockfishes, or a native host at full power. A
  **depth** is reproducible (the same depth is the same answer on any machine) and is the default at 16;
  a **time per move** is a plain box in seconds (default 0.5s, steps of 0.5, type any value). Each mode
  remembers its own number, so switching between them does not reinterpret one in the other's units.
  Native hosts take either. 1–10 candidate lines, your own thread and hash counts.
- **What you actually gave up** - every position is searched once, so the score before a move and the
  score after it come from the same search at the same budget, and the played move's rank in the engine's
  own list is exact.
- **Accuracy and move quality** - Lichess's win% and accuracy formulas, and the same 30/20/10 bands the
  panel judges live moves by, so a review agrees with what the panel said at the time. Best, Excellent,
  Good, Book, Forced, Inaccuracy, Mistake, Blunder.
- **Eval graph** with the **opening / middlegame / endgame** boundaries marked on Lichess's own divider.
  Click anywhere on it to jump the board there; blunders and mistakes are dotted.
- **Openings named offline** from a bundled copy of [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
  (CC0) - 3,810 lines keyed by *position*, so a transposition is named correctly and nothing is fetched.
- **Think time** read from the `[%clk ...]` comments Chess.com and Lichess both write, and **titles and
  ratings** from the PGN's own tags: `GM Carlsen (2839)`.
- **Human model (optional)** - a second pass with Maia, which predicts what a *human* of a chosen rating
  plays rather than what is best. Maia 1 across the ten nets it ships (1100–1900, plus 2200) or Maia 3 on
  a rating dial. It
  reports where your move sat in Maia's **own ranking**, not a yes/no.
- **Strength estimate (optional, off)** - which rating best explains the moves that were played. The
  human model is asked at every rating it has, and the one least surprised by what actually happened is
  the estimate. It reports the ratings the game **cannot tell apart** alongside the peak, the number of
  decisions it is drawn from, and the likelihood curve - so a flat curve is visible as flat. Book and
  forced moves are left out: everyone plays those the same way. **A strength estimate, not a fair-play
  measurement** - a player using an engine reads as *stronger* here, and one game is a small sample.
  Three read-outs come off that one sweep, at no extra cost in engine time:
  - **Per phase** - the same estimate over the opening, the middlegame and the endgame separately,
    using the dividers the review already computes. "Opens like 1800, finishes like 1300" is a far more
    useful sentence than one number, and it is something a player can act on.
  - **The moves it is built on** - the handful that pushed the winning rating past its nearest rival,
    each with both ratings' probability for the move actually played, and what the winning rating would
    have played instead when it differs. A verdict with its working attached can be argued with; one
    without gets either ignored or over-trusted.
  - **Compare two ratings** - pick any two of the model's ratings and see the positions where they most
    disagree about what to play, with each one's move and how sure it was. "What does 2200 do
    differently here" is the question the curve makes people ask, answered from data already in hand.
    Every move in all three lists is clickable and takes the board there.
- **Human likeness (optional, off)** - the whole game read by that second judge instead: how expected each
  move was rather than how good, and the moves the engine ranked first that the human model never saw
  coming.
- **Across games** - switch **Review every game** on and the whole file is analysed against one engine
  load, with each player's numbers pooled over all of it. One game cannot answer a fair-play question; a
  season of them starts to.
- **Fair-play indicators** - an **overall estimate** per player, then the lines it is drawn from: the
  engine-match rate over the moves that were a real choice (book, forced and recapture moves excluded),
  the rate in sharp positions and per phase, the longest unbroken engine streak, how uniform the accuracy
  is, whether the longer thinks went to the harder positions, and how far the human model was from the
  played move. Four levels with a key that says what each means. **Measurements, never a verdict** - the
  page says so, and the estimate says what it is worth as well as what it says.
- **Export** - the report exactly as it looks on the page: same markup, same stylesheets inlined, board
  and pieces embedded, the full move table and the PGN. One file, no scripts, nothing to fetch, opens
  anywhere.

![The game review page](docs/game-review.png)

</details>

### chess.com Game Review

**chess.com's own Game Review, on Mephisto's board.** This is the real thing: it calls chess.com's actual
Game Review service and shows you *their* review, not a Mephisto imitation of it. Load a game, pick a
strength (**Fast**, **Standard**, **Deep** or **Maximum** - chess.com's own tiers), and press **Ask
Chess.com**. Every move comes back with chess.com's own verdict - brilliant, great, best, excellent,
good, book, forced, inaccuracy, mistake, miss or blunder - the coach's commentary, both accuracies and
the named opening, rendered on the same board and move list as the offline review, with the verdict icon
before each move.

It runs on **your own chess.com account**, the same way their site does, so you get exactly the reviews
your account gets: a **chess.com premium membership (Diamond) reviews without limit**, and a free account
is held to chess.com's normal free-tier allowance. Either way there is no token or password to hand over.
If a chess.com tab is open it uses that; otherwise it opens one in the background and closes it again -
all you need is to be signed in to chess.com in the browser. (Want no limit and no data leaving your
machine at all? The [offline Game review](#game-review-offline) above does that.)

This is the one part of Game Review that sends anything anywhere - the game (a PGN) goes to chess.com. If
you want a review that **never leaves your machine**, the [offline Game review](#game-review-offline)
above runs Stockfish or Maia entirely in your browser and uploads nothing.

<details>
<summary>how it works, what it needs</summary>

- **chess.com's real review** - the request goes to chess.com's own `game-review` endpoint and the reply
  is decoded as-is: the eleven move classes chess.com uses, its one-line commentary per move, the two
  game accuracies and the named opening. The strength tiers are chess.com's own.
- **On the shared board** - it drives the same board, move list and navigation as the offline review; the
  classification icon sits before each move and each summary-card label.
- **Your account, no credentials** - the request carries your first-party chess.com session, so being
  signed in is the requirement (a signed-out request is refused by chess.com). You get whatever your
  account gets: unlimited reviews with a **premium (Diamond)** membership, the free-tier allowance
  without one. Mephisto never sees or stores a password or token.
- **Any standard game** - castling and all four promotions encode correctly, each mapped from a real
  capture.
- **Copy / Save** keep chess.com's raw response; if a review errors, one button copies the message and
  opens a fresh issue.

A one-time heads-up before the first review explains that the game leaves your machine on your own
session. Signed out, it tells you so rather than failing silently. This uses chess.com's service on your
account - use it at your own discretion.

</details>

### Automated play

<details>
<summary>autoplay, premove, Help and Manual mode, hotkeys</summary>

- **Autoplay** - plays the engine's move for you. **Help Mode** draws the arrows instead and overrides it.
- **Safe Premove** - while the opponent thinks, certifies a reply to their *predicted* move: the same move at
  depth 13, depth 14 and the latest depth. An exact match fires instantly; anything else searches normally, so a
  wrong guess costs nothing.
  Forced moves and true recaptures queue as a real site premove, and an illegal one auto-cancels. On Chess.com, a
  line forced *two* moves deep queues both replies at once.
- **Pondering** - searches the opponent's whole think at full threads over their top 5 replies. Off, their turn is
  capped at two threads (not one: premove certification needs depth 14).
- **Play Book Moves** - plays the opening from the Explorer, weighted-random among popular replies. Needs 20+ games
  and within 40cp of the engine's best, so variety never costs you a worse move.
- **Endgame tablebase** - at 7 pieces or fewer the position is *solved*, so it asks Lichess's Syzygy tables for the
  perfect move and outranks both engine and book. Off by default: it sends the position to a third party.
- **Manual Mode** - thinks indefinitely and plays nothing until you press the play key.
- **Background Play** (off by default) - moves fire only while the tab is focused and visible; a move that comes due
  while you're away is deferred and re-issued when you return.

</details>

### Humanize

<details>
<summary>move mix, pacing, Clock Mode and Mirror Time</summary>

![The move mix and move-quality thresholds, with live accuracy estimates](docs/humanize.png)

Seven shares set how often it plays the **top move**, a **2nd/3rd/4th line**, an **inaccuracy**, a **mistake** or a
**blunder**; separate thresholds set how far each may stray in centipawns, with a live [Lichess
accuracy](https://lichess.org/page/accuracy) estimate of the win-chance drop. Defaults sit on Lichess's own
boundaries - 110cp inaccuracy, 230cp mistake, 377cp blunder. Nothing past the blunder threshold is played, and
blunders never fire in a decided game.

Timing follows: quick on obvious moves and openings, long thinks in critical positions, and an instant reflex *only*
for true recaptures and forced moves - snapping off a piece that merely moved in to attack looked suspiciously fast.
A countdown shows what kind of move is coming.

**Clock Mode** budgets each move off the page clock (~time/30 + 60% of the increment); **Mirror Time** paces to the
opponent's last spend −10%. Both size the search to the time they'll spend, so the wait becomes a deeper move.

**Pace to Clock** is separate and off by default. Clock Mode paces the *search*; this paces the *simulated* delay -
the think pause and the cursor travel - which is what actually costs you time in a scramble. With clock to spare
your settings are used exactly as they are: it only ever makes a move shorter, never slower, and never below the
point where the click stops looking like a hand moved it.

> **Priority** - *Time:* Mirror ▸ Clock ▸ Humanize ▸ Search Time. *Move:* Book ▸ Humanize ▸ engine best.

</details>

### Puzzles

<img src="docs/puzzle-database.png" alt="3999 - as high as the Lichess puzzle rating goes" width="49%"> <img src="docs/hotkeys.png" alt="The hotkeys page, each action rebindable" width="49%">

*3999 is the ceiling - there is no higher number Lichess will show you · every action rebindable*

![Hardest (+600) puzzles solved back to back, from the database rather than searched](docs/puzzle-database.gif)

*Hardest (+600) puzzles back to back, from the database rather than searched.
[The full clip](docs/puzzle-database.mp4) runs a minute and a half at higher quality.*

**Puzzle Mode** optimises for solving speed - every move is one it actually searched, and the opponent's scripted
reply is never analysed. A puzzle page ships no move list, so the position is rebuilt from the pieces alone: en
passant is recovered from the last-move highlight and castling rights from the king and rook still at home, because
without them an ep capture is illegal and nobody can castle in *any* puzzle.

**Puzzle database** - a searched move is not always the puzzle's answer; a puzzle has one line that scores, and an
objectively stronger move still fails it. Import Lichess's database and the panel looks the position up instead: on a
hit the whole solution is known, so it plays it with **no search at all**. Works on Training, Storm and Racer.

Lichess only for now, and it doesn't even ask elsewhere - that file is built from Lichess games, so a Chess.com
position would be a guaranteed miss.

**Chess.com puzzles.** The reader shipped in v3.1.207 - the same settings page, the same import button, and the
format is detected from the file, so there is nothing extra to choose. Importing both databases gives you both: they
key on the position, so neither overwrites the other. A database of **820,000+ Chess.com puzzles with their
solutions** will be published once [the upstream pull request](https://github.com/AlexPetrusca/Mephisto/pull/37) is
merged; it covers rated tactics and the daily archive.

**Read solutions from the page** (v3.1.276, off by default) - the puzzle sites hand their own client the answer so
it can score your moves locally, which means the solution is already sitting in the tab. With this on, Puzzle Mode
reads it there and plays it with **no search and no database**: Lichess Training, Storm, Racer and Streak, Chess.com
Rated, Rush and Learning, with the puzzle's own rating shown beside the move. Nothing is requested and nothing is
sent; a solution is only used if it replays legally *and* belongs to the position on the board, so a mismatch means
the engine simply plays as usual. Some Chess.com modes fetch their puzzles before the extension can watch - a second
opt-in, **Use the debugger to catch solutions**, reads them reliably through Chrome's debugger at the cost of the
yellow "being debugged" bar while a puzzle page is open. The database's Remove button is now three - **Remove all,
Remove Lichess, Remove Chess.com** - so one import can be dropped without the other.

<details>
<summary><b>Building your own Chess.com puzzle CSV</b> - the exact format the importer accepts</summary>

**The header row is required and must begin with `fen3`.** That is the only thing that tells the importer this is a
Chess.com file rather than a Lichess one - without it the rows are read as Lichess and every one is discarded.

```
fen3,id,rating,initialFen,tcnMoveList,colorOfUser,pgn,passRate,averageSeconds,gameLiveId,gameId
```

| # | column | required | meaning |
|---|---|---|---|
| 0 | `fen3` | **yes** | board + side to move + castling. Only the first two fields are used as the key. |
| 1 | `id` | **yes** | puzzle id, or `daily-N` for archive puzzles - the prefix switches the move format |
| 2 | `rating` | no | ignored on import |
| 3 | `initialFen` | daily only | full 6-field FEN; used to replay the SAN of a `daily-` row |
| 4 | `tcnMoveList` | **yes** | solution in Chess.com TCN - **or SAN for `daily-` rows** |
| 5 | `colorOfUser` | tactics | `white`/`black`, the side solving. Empty for daily. |
| 6+ | `pgn`, `passRate`, `averageSeconds`, `gameLiveId`, `gameId` | no | never read, but the columns must be in this order |

**Whose move comes first differs by row type**, and getting it wrong shifts every solution by a ply:

- **Rated tactic** - `fen3` is the *opponent* to move and `colorOfUser` is the solver, so the first move is the
  opponent's setup move. The importer applies it and keys on the position after it, exactly as it does for Lichess.
- **`daily-` row** - no setup move and no `colorOfUser`. The side to move in `fen3` **is** the solver and the line
  starts immediately.

**TCN** is two characters per move over this alphabet, index `0` = `a1` and `63` = `h8`:

```
abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=
```

A promotion pushes the destination past index 63: the piece is `"qnrbkp"[(to - 64) / 3]` and the real destination is
`from ± 8 + ((to - 64) % 3) - 1`, the remainder carrying the file shift (capture left, straight, capture right).

**Three rules your generator must respect:**

1. **Write real CSV.** The `pgn` column contains literal newlines and doubled `""` quotes. The importer reads these
   rows with a proper streaming parser, so quoting must be correct - but that also means a naive line-per-row
   generator will produce a file it cannot read.
2. **Key on the first three FEN fields only.** Halfmove and fullmove counters vary between sources for the same
   position; they are not part of what a puzzle *is*.
3. **Branch on `id` before choosing an encoding.** A `daily-` row holding TCN, or a rated row holding SAN, is
   silently dropped rather than mis-decoded.

Rows the importer cannot make sense of are skipped, not fatal - the status line reports how many of the rows read
were kept.
</details>

<details>
<summary><b>Importing the puzzle database</b> - about a gigabyte, roughly half an hour, once</summary>

Not bundled: the release zip is large enough already. Download `lichess_db_puzzle.csv.zst` from
[database.lichess.org](https://database.lichess.org/#puzzles), decompress it (`unzstd lichess_db_puzzle.csv.zst` -
browsers have no zstd decoder, which is why this step is yours), then pick the `.csv` under **Settings → General →
Puzzle Database**. About six million positions, with a live count as it goes. Nothing is sent anywhere; it lives in
the extension's own IndexedDB. If the import is interrupted nothing is lost - run it again and it fills in the rest.
</details>

### The panel

Drag by the title bar, close with ✕. **Compact (▣)** collapses it to the status line, move and score; **minimize
(–)** hides it entirely behind a badge while autoplay keeps running. Quick Settings edits every setting inline.
**Re-detect (↻)** rescans the page. **Copy FEN / PGN** - a game that began from a custom start exports with
`SetUp`/`FEN` tags, so it reads back as the same game. A **grid button** takes a pasted FEN to analyse any position;
**⧉** opens the position on Lichess. An **engine health dot** shows whether a native host answered, because a missing
host otherwise just looks like a panel that never evaluates.

---

## Supported sites

![TakeTakeTake, whose board is a WebGPU canvas with no DOM to scrape](docs/taketaketake.png)

*TakeTakeTake, whose board is a WebGPU canvas with no DOM to scrape.*

| Site | Analysis | Autoplay | Premove | Puzzles | Online | Variants |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **Chess.com** | ✅ | ✅ incl. Play Bots | ✅ | ✅ Rated · Rush · Learning + page-read solutions | ✅ | 3-Check, KotH, Crazyhouse, Antichess, Atomic, Horde, Racing Kings, **Duck, Minihouse, Seirawan, Chaturanga** + Chess960, **4-player** |
| **Lichess** | ✅ | ✅ incl. AI & From Position | ✅ | ✅ Training · Storm · Racer · Streak | ✅ live & correspondence | All Lichess variants + Chess960 |
| **TakeTakeTake** | ✅ | ✅ bot games | ✅ | - | ✅ Lichess-backed | - |
| **BlitzTactics** | ✅ | ✅ | - | ✅ puzzle streams | - | - |
| **ChessBase Tactics** | ✅ arrows on the canvas | ✅ v3.1.269 | - | ✅ Solve / Sprint | - | - |

---

## Full-power native engines (optional)

**You don't need this.** The bundled WASM engines work with zero setup. But WASM is sandboxed - it can't use all your
cores or much RAM, so it runs **5–70× slower** than a native binary. Point Mephisto at a native Stockfish and Chrome
**auto-launches** it; there is no server to run. Two extra engines appear in the dropdown, running at all cores and
up to 2 GB hash.

<details>
<summary><b>Setup</b> - macOS, Linux, Windows</summary>

You need a native **Stockfish** binary (optionally **Fairy-Stockfish** for variants), **Python 3** with
`python-chess`, and your **extension ID** - open `chrome://extensions` with Developer mode on and copy the long id
under *Mephisto*.

> ⚠️ An unpacked extension's id **changes when you reload it**. If native engines stop working after a reload, re-run
> the install command with the new id.

**macOS**
```bash
brew install stockfish fairy-stockfish
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
A binary downloaded from the web is quarantined by Gatekeeper - the installer clears that for its own copy.

**Linux**
```bash
sudo apt install stockfish
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
For Fairy-Stockfish, install it or pass `--fairy /path/to/binary`.

**Windows** - the shell installer is macOS/Linux only; native messaging needs a registry key, so this is manual:
install Python and `pip install chess`, download `stockfish.exe`, copy `native-host/uci-native-host.py` somewhere
stable with a `sf-native.path` file next to it holding the full path to the exe, write a host manifest
`com.sf_native.host.json` (underscores - Chrome rejects hyphens) pointing at a `.bat` that runs the host script with
`"allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]`, and add registry key
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sf_native.host` = the manifest path. Prefer the bundled WASM
engines unless you're comfortable with the registry.

The installer registers the host for **Chrome, Brave, Edge, Chromium and Vivaldi**. Firefox isn't supported for
native engines. Any native build unlocks full speed - pick the one matching your CPU (Apple Silicon, AVX2, BMI2);
the gap between native builds is small, the jump from WASM to any of them is huge.
</details>

---

## Four-player chess

<details>
<summary>chess.com 4PC, driven by a dedicated native engine</summary>

Chess.com's **4-player chess** (`/variants/4-player-chess`), analysed by
[Tetrarch](https://github.com/IchNukeDichWeg/Tetrarch) - a purpose-built engine for 14×14 four-seat boards, because
no two-player engine can be bent into one. Pick **Tetrarch (4-player)** in the engine dropdown; the panel switches to
it on a four-player board and back to Stockfish when you leave.

![Four-player chess on Chess.com, with the 14x14 panel board and the suggested move drawn on it](docs/four-player.png)

*Teams mode on Chess.com - the panel's own 14×14 board, rotated so you sit at the bottom, with the engine's move
drawn on it and the evaluation bar in team colours.*

The panel swaps its own board for a 14×14 one with the corners cut, rotated so **you** sit at the bottom whichever
seat you drew, and draws the suggested move as an arrow. The evaluation is normalised to **your team** (Red+Yellow
against Blue+Green), so it means one thing all game instead of flipping sign every seat. Autoplay works.

> **Teams mode only, for now.** Tetrarch does not search free-for-all, so FFA games are detected and shown but
> not analysed.

Promotions are played in full: the picker Chess.com opens over the board is found by its shape - a small
panel of four pieces in two rows - rather than by a class name, so a generated class changing cannot make
it click the wrong piece. If nothing matches that shape it plays the move and leaves the piece to you,
which is what it always did. Confirmed from every seat: unlike the board, the picker is *not* rotated per
player, so one reading order serves all four. With **Multiple Lines** above 1 you get an arrow per line on the page board
and on the panel's own 14×14 board, with a colour-matched list of scores beneath it.

The mode is read from Chess.com's own mode label, which is a guess about someone else's markup - and it decides the
rules the search runs under, since promotion is the 8th rank in free-for-all and the 11th in Teams. When that guess
is wrong, **Mode** in the panel (it takes the Variant row's place for Tetrarch) sets it by hand: *Auto-detect*,
*Teams* or *Free-for-all*. Changing it re-analyses the position already on screen rather than waiting for the next
move. Autoplay also works on the **analysis board**, not just in a game - it's your own board, so playing a line out
on it affects nobody. The lobby and setup pages stay excluded.

<details>
<summary><b>Setup</b> - macOS, Linux, Windows</summary>

Tetrarch is the one engine with nothing bundled behind it: it needs a checkout and one run of the installer. Until
then the panel says so under the board rather than pretending to analyse.

You need **Python 3**, a C compiler, and your **extension ID** - `chrome://extensions` with Developer mode on, copy
the long id under *Mephisto*.

**macOS and Linux**

```bash
git clone https://github.com/IchNukeDichWeg/Tetrarch
```

```bash
cd Tetrarch && ./setup.sh
```

`setup.sh` builds the C core and installs what it needs (Homebrew, apt, dnf or yum). Then, from the Mephisto folder:

```bash
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID --tetrarch /path/to/Tetrarch
```

Drop `--tetrarch` if the Tetrarch checkout sits beside Mephisto's parent folder - that's where the installer looks by
default. It prints `-> tetrarch: <path>` when it found it and `-- tetrarch: no uci.py at <path>` when it didn't.

**Windows**

Two differences from the above: the C core has to be built as a DLL, and Chrome finds native-messaging hosts through
the **registry** rather than a folder of manifests - so there's a PowerShell installer instead of the shell one.

Install [MSYS2](https://www.msys2.org), then from its **MINGW64** shell:

```bash
pacman -S --needed mingw-w64-x86_64-gcc
```

```bash
cd /c/path/to/Tetrarch && ./setup.sh
```

That produces `build\tetrarch.dll`. Then, from PowerShell in the Mephisto folder:

```powershell
powershell -ExecutionPolicy Bypass -File native-host\install-tetrarch.ps1 -ExtId YOUR_EXTENSION_ID
```

Add `-Tetrarch C:\path\to\Tetrarch` if the checkout isn't beside Mephisto's parent folder. The installer copies the
host into `%LOCALAPPDATA%\Mephisto` and registers it for Chrome, Chromium, Edge, Brave and Vivaldi under `HKCU` - no
administrator rights needed. Python 3 must be on `PATH`.

> The Windows path is **built and symbol-checked but not yet run on a real Windows machine** - the DLL is
> cross-compiled and verified in CI-style by `win-crosscheck.sh` in the Tetrarch repo, which is not the same as
> someone having played a game on it. If something misbehaves,
> [please open an issue](https://github.com/IchNukeDichWeg/Mephisto/issues/new/choose) - see
> [Contributing](#contributing) for the four stages worth reporting. **WSL** works today with no
> extra steps, since it's the Linux path above.
</details>

---

</details>

## Languages

**Settings → Appearance → Language**, applied immediately without a reload.

English, Deutsch, Español, Français, Português, Italiano, Nederlands, Polski, Türkçe, Русский, 中文, हिन्दी, 日本語,
한국어 - each listed in its own language, because a list written in English doesn't help someone looking for theirs.

Deliberately **not** Chrome's `chrome.i18n`, which follows the browser's UI locale with no way to override it. One
flat JSON per language under `src/i18n/locales/`, English underneath every other as the fallback. Every string is
translated including the long settings tooltips - the ones explaining what a setting actually does are the ones worth
having in your own language. Engine names, board and piece themes, and chess notation are left alone on purpose.

---

## Settings reference

<details>
<summary>every setting, one table</summary>

The options page - right-click the toolbar icon → **Options**, or the gear in the panel. Quick Settings in the panel
is a subset writing to the same storage. Everything applies to the next move without a reload unless noted.

<details>
<summary><b>Engine</b></summary>

| Setting | What it does |
| --- | --- |
| **Grind Mode** | Lichess and Chess.com, and only while Autoplay is on. When a game ends, clicks the control that starts the next one. Fails silently if that control is not where it was expected. |
| **Grind Delay (s)** | How long to wait after a game ends before starting the next one - your window to stop it. 0 starts immediately, 600 is the maximum. |
| **Engine** | Which engine analyses the position. The WASM builds need nothing installed; "(local, full power)" entries talk to a real binary and only appear once the native host is installed; the two "Cloud" entries need nothing installed either but send the position to somebody else's server on every move. Switching reloads the panel - the net and UCI options have to be rebuilt. The Maia rating band is the exception: it swaps the net live, panel and position untouched. |
| **Elo** | Caps strength via `UCI_LimitStrength` + `UCI_Elo`. The range follows the engine; out-of-range values are ignored rather than clamped. `0` means no cap. |
| **Variant** | How the position is read and analysed. Auto-detected on variant pages. Chess960 is the exception: every mainline Stockfish plays it, so it survives an engine switch. |
| **Search Budget** | Whether the search is bounded by **time** or by **depth**. A depth is reproducible - the same depth is the same answer on any machine, where a millisecond budget is a different search on every one. Each keeps its own number, so switching back does not lose it. |
| **Search Time** | How long the engine thinks when nothing else sets the pace. Clock Mode, Mirror Time and Humanize all override it; recaptures and forced moves ignore it entirely. |
| **Search Depth** | Plies, when the budget is a depth. Native engines still carry the time as a ceiling: an unreachable depth cannot be called back, so an unbounded one would not merely be slow. |
| **Fallback Poll Interval** | Position changes are event-driven and instant; this is only a slow safety net that repairs a missed update. Lowering it buys nothing. |
| **Multiple Lines** | How many candidates the engine reports, up to whatever the engine itself supports. The search splits across them, so depth drops - 1 is strongest. Humanize raises it automatically when it needs alternatives. |
| **Threads** | A fresh install takes **half** the cores, leaving the browser something to run on; a saved value always wins over that default. Capped at 2 on the opponent's turn unless Pondering is on. |
| **Memory** | Transposition-table size. In-browser engines are clamped to 512 MB whatever the slider says - that's the WebAssembly heap limit, not a choice. Native engines get the full value. |
| **Panel Style** | **Floating panel** is the draggable window; it lives in the page, so a site can detect it more easily, and Autoplay and Premove need it. **Toolbar popup** renders in the browser's chrome and leaves no trace in the page, but closes when you click the board - analysis only. |
</details>

<details>
<summary><b>Analysis and display</b></summary>

| Setting | What it does |
| --- | --- |
| **Show Computer Evaluation** | Score, depth, nps and the win/draw/loss split under the panel board. |
| **Show Threat Analysis** | A red arrow for the opponent's best reply. Costs a second search per position. |
| **"Hand & Brain" Mode** | Mephisto plays the *Brain* - names only the piece type. It deliberately withholds the move, so Autoplay does nothing while it's on. |
| **Explain Moves** | Names the tactic behind the choice; silent when nothing is certain. |
| **Hide Opponent Name** | Blurs their username and avatar so a screenshot doesn't expose a real person. Local and cosmetic - but it's the one option that adds a style element to the page, which is why it's off by default. It matches the sites' own class names, so a site rename can leave it blurring nothing; it reports what it matched in Copy Diagnostics rather than failing silently. |
| **Move Notation** | SAN (`Nf3`) or UCI (`g1f3`), everywhere a move is written: the readout, the alternative lines, the arrow labels. |
| **Label Arrows** | Print each arrow's own evaluation on the board. Off by default - useful information, and also more ink on the board. |
| **Forced Lines Ahead** | Draw your premove-able continuation, 0–5 plies: while every opponent reply is their only legal move, your next moves are drawn in magenta and their forced replies in teal - hues no engine line uses, so certainty never reads as suggestion. The chain ends where the opponent has a real choice. 0 is off. |
| **PV Arrows** | Draw the engine's whole line ahead on the board: every ply as a thin grey numbered arrow, so you see where the line is going, not just its first move. Grey because it is the current suggestion, not a certainty - forced continuations keep their own colours on top. Off by default. |
| **PV Arrows Length** | How many plies PV Arrows draws, 1–50 (default 5). |
| **Arrow Colours** (Appearance) | Every arrow family re-colourable: lines 1–5, forced (yours/theirs), PV Arrows, threat, book. A native colour picker and a hex field per row, kept in sync; an empty field means the shipped default, and junk can never draw an invisible arrow. Forced ramps derive their depth shades from your base colour. Applies live. |
| **Premove Confidence** | The certification depth: a (their move, our reply) pair must be identical at this depth, the one before it, and the latest reported. A rules-forced reply ignores the dial - it is certain at any depth. |
| **Premove Plies** | How many premoves a forced sequence may queue in one click session, 1–5 (default 2). Chess.com queues them all; lichess replaces a queued premove rather than queueing another, so past the first it is chess.com-only. Every queued move follows the forced-lines certainty rule. |
| **Number Arrows** | Number each arrow with where its line ranks: 1 for the engine's best, 2 upwards. On by default; with more than a couple of lines the colours alone stop distinguishing them. |
| **Arrow Opacity** | How strongly arrows are drawn, 1–100, on the panel board and the page board alike. Floored so the bottom of the slider cannot render an invisible arrow. |
| **Board Animation** | Animate the panel's board and its overlays. Off draws every change instantly. |
| **Live Stats** | A strip under the board: running accuracy for both sides and the tally of best moves, inaccuracies, mistakes and blunders. Derived from the same eval history the graph draws and judged by the same win% bands Game Review uses, so the strip and the review agree. Works with the graph switched off. |
| **Opponent Mistake Alert** | A toast when the opponent plays an inaccuracy, mistake or blunder, by the same Lichess win% method the move mix uses. Only fires when both positions were searched deep enough to trust. |
</details>

<details>
<summary><b>Automated play</b></summary>

| Setting | What it does |
| --- | --- |
| **Autoplay** | Plays the engine's move on the site's board by clicking. Everything else that plays a move needs this on. |
| **Premove** | Certifies a reply to the opponent's predicted move; an exact hit is instant. A reply that could never be legal after some other move is queued as a real site premove. |
| **Pondering** | Full threads during the opponent's turn across their top five replies. Costs CPU continuously - it pairs best with Premove. |
| **Endgame Tablebase** | Perfect play at ≤7 pieces, outranking engine and book. Off by default: it leaves your machine. Never delays a move. |
| **Lichess API token** | Lichess put the opening explorer behind OAuth - without a token it answers 401 and both Opening Explorer and Play Book Moves stop working. Make a personal token at [lichess.org/account/oauth/token/create](https://lichess.org/account/oauth/token/create) with **no scopes** ticked; the explorer only needs to know a request has an owner. Stored on your machine like any other setting, sent nowhere but lichess, and deliberately left out of Copy Diagnostics and of an exported settings file. |
| **Opening Explorer** / **Opening Database** | Human opening data and which games it comes from. *Masters* is the cleanest play; the Lichess sets look more like a normal opponent. Read-out only. |
| **Play Book Moves** | Plays from the book instead of the engine's pick - an engine that always opens the same way is itself a tell. 20-game floor, 40cp check. If the lookup is late the engine's move is played. |
| **Background Play** | Off, moves fire only while the tab is focused. On keeps everything running hidden - Chrome throttles silent background tabs, so the tab is marked as playing audio and shows a speaker icon. |
| **Help Mode** | Arrows on the site's board, plays nothing. Overrides Autoplay. |
| **Humanize** / **Clock Mode** / **Mirror Time** | Which move is played, and how long it takes. See [Humanize](#humanize). |
| **Pace to Clock** | Shrinks the simulated think pause and cursor travel when the clock gets short. Off by default; never lengthens a move. |
| **Manual Mode** | Thinks indefinitely; plays only when you press the play key. Overrides Clock/Mirror/Humanize. |
| **Puzzle Mode** / **Puzzle Database** | See [Puzzles](#puzzles). Puzzle Mode turns itself on when you open a puzzle page and off when you leave - unless you set it yourself, which is never overridden. |
| **Drag Pieces** | Play a move as a drag instead of two clicks. Off by default, and it needs a Move Time of at least 250ms - a snapped drag is the shape that drops captures silently. Chess.com's variants boards drag regardless, because a capture is not playable there any other way; a short Move Time is floored for them rather than honoured. |
| **Puzzle Move Delay** | How long to wait before playing a known puzzle answer. A database hit runs no search, so without a pause the move lands the instant the position appears. |
| **Read Solutions From The Page** | Puzzle pages hand their own client the answer; with this on, Puzzle Mode reads it off the page and plays it with no search. A solution is used only when it replays legally and matches the board - otherwise the engine plays as usual. Off by default. |
| **Use The Debugger To Catch Solutions** | Watches the page's own network traffic through Chrome's debugger, for the Chess.com modes that fetch puzzles before the extension can see them. Shows Chrome's yellow "being debugged" bar while a puzzle page is open. Needs Read Solutions From The Page. Off by default. |
| **Auto-Next Puzzle** | Click through to the next puzzle when one ends. Needs Puzzle Mode and Autoplay, and runs on `/puzzles/rated` and `/puzzles/learning` only - Rush and Streak advance themselves. |
| **Auto-Next Delay** | The pause before that click. |
| **Python Backend** | Moves the real pointer via a local Python helper instead of synthetic clicks. Needs `mephisto-clicker.py` and PyAutoGUI permissions. Almost nobody needs this. |
</details>

<details>
<summary><b>Humanize tuning, hotkeys, appearance</b></summary>

| Setting | What it does |
| --- | --- |
| **Move Mix (%)** | Seven categories, must total 100. Giving any share to *Third line* or worse forces a wider search so a move that bad exists to pick - which costs depth. A pure Top + Second mix stays cheaper. |
| **Thresholds (cp)** | How much worse than best each category may be. Each value is the top of its band and the one above is the bottom, so bands tile without gaps. |
| **Think Time / Variance** | The minimum delay after the position is evaluated, plus a random extra. Constant identical timing is itself a tell. |
| **Move Time / Variance** | The *total* wall clock for one move, first click to last - promotions get a third leg and are budgeted for. |
| **Hotkeys** | One rebindable key per action, live on the game page while the panel is open. Click a key and the next press becomes the binding; **Esc** cancels, **Backspace** clears. Defaults are single letters, play-move is Space. Clashes with a site shortcut can be rebound to any Ctrl/Alt/Shift/Meta combination. |
| **Pieces / Board / Coordinates** | The panel's own board only - the site's board is never restyled. |
| **Dark Mode / Language** | Theme and language for the panel and the settings page. |
| **Four-player Mode** | Tetrarch only, in the Variant row's place. Which rules a four-player board is played under - *Auto-detect* reads Chess.com's mode label, *Teams* and *Free-for-all* override it. See [Four-player chess](#four-player-chess). |
| **Automatic Updates** | See [Automatic updates](#automatic-updates-opt-in). Off by default. On, it asks Chrome for permission to download this repository's releases, then updates the extension in place at the press of a button - the bundled engines are never touched. |
| **Verbose Logging · Copy Diagnostics** | Diagnostics, not play. The trace is quiet while the game tab is focused; this turns it on. **Copy Diagnostics** (panel → Engine, or **D**) copies version, engine, what was detected, why the last move was or was not played, and the recent trace - with no addresses and nothing identifying, so it can go straight into a bug report. It also carries the last five **worker cold starts**, timed and written to storage rather than traced, because the trace lives in the worker and a worker that was slow to start is exactly the case where it has nothing to say. |
| **Game Review** | Its own page. Analyse a PGN, a `.pgn` file, or a player's recent Chess.com games; see [Game review](#game-review). |
| **Restore Defaults · Export · Import** | Reset everything on the page (not the puzzle database or hotkeys); write every setting including hotkeys and tuning to JSON, and read one back. Values that no longer exist are ignored. |
</details>

---

</details>

## Page footprint

**Toolbar popup** leaves **zero page footprint** - it renders in the browser's own chrome, so the page has no handle
to it at all. It closes when you click the board, so it's analysis only; Autoplay and Premove need the floating
panel. Switch under **Settings → General → Panel Style**.

While the **floating panel** is in use, its footprint is minimised:

- **No iframe.** An iframe is a *browsing context* - counted by `window.length`, throwing on cross-origin access,
  which a closed shadow root cannot hide. The panel renders directly in the page's isolated world, and the WASM
  engine moved to an **offscreen document** that still gets the cross-origin isolation the pthread builds need but
  that the page cannot see or count.
- **No extension URLs reach the page.** `web_accessible_resources` is gone from the manifest. Markup, CSS, board
  textures and piece images are fetched extension-side and injected as inlined bytes or `data:` URIs, so no
  `chrome-extension://` URL appears in the DOM **or in Resource Timing**, and the id can't be read back.
- **Closed shadow root** under one attribute-less host node - `document.querySelector('[id^="mephisto-"]')` finds
  nothing and `host.shadowRoot` is `null`.
- **No branded page globals** - MAIN-world probes for canvas boards set no `window.*` flag and talk over
  per-session random event channels, so there's no fixed name to fingerprint.
- **Human-shaped clicks** - a bare *from → to*, no lead click on an empty square, randomised timings, landing on a
  center-weighted distribution within each square, preceded by an eased jittered cursor path inside the Move Time
  budget.
- **No config in the site's storage** - settings live in `chrome.storage.local`. Two values do sit in page storage
  because they're read while the panel is built (panel geometry, a start-position cache); neither is named after the
  extension nor holds a setting.

These reduce *passive* fingerprinting only. See the [disclaimer](#fair-play--read-this-first).

---

## Roadmap

No schedule - added whenever I feel like it. Checked means shipped.

### Planned

<details>
<summary>32 items, sorted by upside and effort</summary>

**Quick wins.** Small changes with an obvious payoff. Empty once more as of v3.1.272 - all fourteen
that were here shipped in one release.

**Worth real work.** The ones that would change how this feels to use, and cost accordingly.

- [ ] **Variants on the Analysis page** - `variant: 'chess'` is hardcoded in three places, so the one page
  built for studying cannot open the Crazyhouse or Chess960 game the panel just played. Fairy-Stockfish and
  its per-variant nets already ship; the board, the drops and the castling rules are the work.

- [ ] **Two engines side by side** - the page contrasts an engine with a human model; contrasting two
  ENGINES answers a different question - does the 15MB net see what the 112MB one sees - which is the thing
  to settle before trusting the small one in a game. The rig already runs two engines at once for the
  review's two passes, so the plumbing exists.

- [ ] **Review the game you just finished, in one click** - when a game ends, the content script is holding
  the moves it scraped all game. Offering "review this" on the spot beats export, switch tab, paste - and
  the end of a game is exactly the moment a review is actually wanted.

- [ ] **Turn your own blunders into puzzles** - the review knows every position where the game was thrown
  away, and Puzzle Mode already serves positions with known answers. What is missing is the bridge: keep the
  blunders, re-serve them a week later, and count whether the second try goes better.

- [ ] **A command palette** - every action behind one key and a search box, the way editors do it. The
  hotkey system already names its actions; a palette is a searchable list over those names, and it beats
  memorising a keymap that has long outgrown what fits in one head.

- [ ] **Recommend an engine for this machine** - the dropdown offers every engine and no guidance. The core
  count is known, and one short fixed-depth benchmark per engine would measure what this machine can
  actually run - then say so once, instead of letting a two-core laptop default into the 112MB net.

- [ ] **A variation tree on the Analysis page** - playing a move truncates the line and continues from there,
  which is right for "what if" and wrong for studying: the branch you just left is gone. Keeping branches, and
  a way to walk back into them, is most of what separates a study board from a very good scratchpad.

- [ ] **What a human of that rating would REPLY** - Threat Analysis shows the engine's best answer to your
  move. The human model can answer the same question about the opponent you are actually facing, which is a
  different and usually more useful prediction than the strongest reply on the board.

- [ ] **A board reader that knows the rules** - the recogniser already keeps its runner-up for every square
  (that is what the one-click square fix is built on). Nothing yet uses those runners-up to reject a decode
  that cannot be a chess position: two white kings, nine pawns, a pawn on the back rank. Accuracy bought from
  the rules rather than from the model, and it needs no retraining.

- [ ] **A faster board recogniser** - partly answered in v3.1.255, and again in v3.1.269 by giving the model
  more threads: the cap of 4 was measured against 5, 6 and 8 on a 10-core Mac (754/635/610/589/704ms at
  2/4/5/6/8), so the rule is now 0.6 x cores capped at 6 - **589ms against 635ms**, and deliberately a no-op
  below ten cores. Measured per read: decode 25ms, board
  detection 84ms, position model 645ms. The position model is **already int8-quantised** (MatMulInteger /
  ConvInteger), so quantisation is spent; caching (frame, board box, crop) took repeat reads to **2-3ms**, but a
  board that genuinely changed still pays ~700ms. **WebGPU was tried and measured (v3.1.256): 774ms against the WASM build's 631ms on the same
  machine and model - 23% slower**, because the int8 operators have no WebGPU implementation and fall back to the
  CPU with transfer costs on top. It was not vendored (27MB of runtime for a loss). What is left is a genuinely
  smaller model, which means retraining rather than converting.
- [ ] **Grind Mode, the rest of it** - it starts the next game on Lichess and Chess.com and that is all it does.
  What it cannot do yet: stop after N games or after a losing streak, respect a daily limit, or pick a different
  time control than the one that just finished. It also has no idea whether *you* are still at the keyboard,
  which is the thing that would make an unattended session safe rather than merely possible.

- [ ] **Talking Mode** - the engine as a voice. Not a number and an arrow but a running commentary in plain
  language: what the position wants, what it is worried about, why the move it likes actually wins something.
  The pieces exist (eval, lines, the explanation work below); the hard part is saying it like a person and
  knowing when to shut up.

- [ ] **Playing with a net** - for when the moves are yours. Live feedback you opt into, and underneath it a
  quieter mode that says nothing at all unless you are about to throw the game away: not the best move, just
  the set of moves that keep the result. The win% bands the panel already judges moves by are the right ruler.

- [ ] **Drill mode** - the parts are all here: the puzzle database, the Opening Explorer's statistics, and Maia
  at a rating band. Put them together and a repertoire can be drilled against an opponent who plays like a human
  of the strength you pick, telling you the moment you leave your own lines.

- [ ] **Your history across games** - Live Stats answers *how am I doing right now*; this answers *how have I
  been doing*. Accuracy over time, which openings actually lose, whether the Humanize settings you chose still
  look like you. Game Review computes the per-game numbers already; this keeps them.

**Known problems.** Named faults rather than ideas: blocked on a diagnosis or on a site, not on wanting to.

- [ ] **Playing while the machine is busy** - measured 2026-08-15 on a 10-core Mac with every core saturated by
  other work: the panel's response to a position change went from a 323ms median to 1239ms, with one sample never
  arriving inside 12 seconds. The obvious fix was tried and REJECTED by its own measurement: handing the engine
  fewer threads under load made it worse, not better (interleaved A/B under sustained saturation, 14 samples each,
  999ms median on the full budget vs 1712ms on one thread). So the cost is not engine thread contention, and the
  next candidate is the page thread itself - the scrape, parse and draw path - which is where the measurement
  should go before any more code does.
- [ ] **The pause after a browser restart** - for several seconds after Chrome starts, the extension is
  unresponsive, and then it recovers on its own. Long-standing, instrumented, never explained. The worker's
  cold-start timings are recorded now, which is where to start looking.

- [ ] **Four-player chess, the rest of it** - Teams mode works, promotions are played and eliminations are
  handled. What is left: free-for-all needs engine support, and no real game has yet been seen past an
  elimination, so that path is pinned by synthetic positions rather than by having happened. Chaturaji,
  4P Giveaway and Self Partnering are untouched.

- [ ] **Four-player chess on Windows, confirmed** - built and symbol-checked, never run on a real Windows machine.
  See [Contributing](#contributing) for the four stages worth reporting.

- [ ] **Duck Chess autoplay** - blocked on the ENGINE, not on the clicking, and that was measured: this build's
  Fairy-Stockfish declares 84 variants and duck is not one of them, so `UCI_Variant duck` is ignored and it plays
  standard chess. Since v3.1.269 the panel at least says so instead of answering confidently. What it needs is a
  Fairy build that has the variant - a rebuild, not a wiring job.

- [ ] **Play from your own Polyglot book** - half done. Since v3.1.256 the **Analysis** page reads real `.bin`
  files (the format's own Zobrist table, verified against its published test keys) and shows their moves. What is
  left is the other half: the *panel* playing from a book you loaded, rather than from the Opening Explorer's
  statistics - which means the book has to live somewhere the panel can reach, not just the options page.

- [ ] **Better board reading from the screen** - two of its parts landed in v3.1.269: two boards on screen are
  told apart (the panel hides itself for the one frame a detection capture needs), and a misread square is one
  click from fixed. What is left is the reading itself - unusual piece sets, low resolution, boards at an angle -
  which is the model, and means retraining rather than tuning.

- [ ] **A speed and polish pass on the panel** - the crowding and the FEN box were answered in v3.1.269 (the box
  grows to its content; the input uses the palette). What is left is the pass itself: every control compared
  against the one beside it, the way the settings page was swept, rather than by eye.

- [ ] **Shrink the footprint further** - what's left is hardening the one rendezvous the MAIN-world probes need and
  tightening how scraped positions are sanitised. Being straight about the ceiling: the client side is nearly
  exhausted, and it was never the thing that catches people.

- [ ] **More engines** - the lineup covers *strong* and *human-like* and not much between. Variety of character, not
  more strength. **lc0 (Leela)** in WASM would be for comparing styles, not for strength.

- [ ] **Short videos and more screenshots** - a premove firing, Humanize pacing a move, the screen reader following a
  board. Some of this only makes sense in motion.

- [ ] **Translate the README** - the interface speaks fourteen languages; the documentation still speaks one.

**Speculative.** Kept because they might turn into something, not because they are planned.

- [ ] **Mirroring another bot** - run a second game in a background tab and relay its moves into yours, so what
  you play carries another bot's character instead of a raw engine line. Two caveats worth having up front: it
  doubles the footprint rather than halving it, and what actually catches people is the shape of the moves
  across many games, which does not change based on where they came from.

- [ ] **Streaming opponents** - kept because it might turn into something, but under-specified as it stands:
  notice when an opponent is streaming. It needs a decision about what the extension would *do* with that
  before there is anything to build.

- [ ] **An LLM at the board** *(barely serious)* - hand a model the FEN, the move history and the legal moves
  and let it choose. Language models play badly and propose illegal moves, so as a source of moves this is a
  curiosity. One step across it is genuinely interesting: the same model as the voice behind Talking Mode and
  the move explanations, which is where the effort belongs.

**Always open.**

- [ ] **Bug fixes**, open-ended. Several of the sharpest bugs so far were invisible rather than loud: autoplay that
  skipped a move with nothing logged, an engine that never loaded, a veto inverted only for Black. Reports of *"it
  did nothing"* are worth more than they sound.

- [ ] **Whatever you want it to do** - most of what's here arrived because something was annoying in a real game.

**Blocked upstream** - no engine supports these, so there's nothing to build against: Fog of War (imperfect
information), Spell Chess, Bughouse and Chess-with-Checkers. Setup Chess used to sit in this list; it turned out to
need no engine support at all - once the pieces are down it is ordinary chess - and shipped in v3.1.222.

**Looked at and dropped**

*Lichess cloud evaluation.* It's a crowdsourced cache of positions other people's browsers have already analysed, not a
server-side engine, and its coverage is the problem: deep on openings and popular lines, absent on ordinary middlegames.
That's the inverse of where extra depth would change a move, and the openings are already covered by the [Opening
Explorer](#analysis) and book play. Might be worth revisiting for post-game review, where the hit rate is higher and the
eval is context rather than a move to play.

*Training more Maia rating bands.* **Maia-3 already covers 600–2600 on one continuous slider**, so new discrete bands
above 2200 would mostly duplicate what ships today. Human move-matching data also thins out at the top, where strong
play converges on the moves an engine would pick anyway - so the expensive end of the range is precisely where a new
band is least distinctive. And it could not honestly be called an improvement without a held-out move-agreement
benchmark against Maia-3 at the same rating, which is a training campaign with a measurement plan attached, not an
afternoon. The cheaper route to the same goal is blending what is already here: Maia-3 at the band you want, a Stockfish
veto for real blunders, and the clock rules above.

</details>

### Shipped

<details>
<summary>68 features, newest first</summary>

- [x] **Puzzle solutions read off the page** (v3.1.276)
  - **Read solutions from the page** - opt-in; Puzzle Mode reads the answer the site already handed its own
    client and plays it with no search and no database: Lichess Training, Storm, Racer and Streak, Chess.com
    Rated, Rush and Learning, with the puzzle's own rating shown beside the move. A solution is used only if
    it replays legally and belongs to the position on the board, so a mismatch means the engine plays as usual.
  - **Use the debugger to catch solutions** - second opt-in for the Chess.com modes that fetch their puzzles
    before a page script can watch; reads them reliably through Chrome's debugger, at the cost of the yellow
    "being debugged" bar while a puzzle page is open.
  - **Remove Lichess / Remove Chess.com** - the puzzle database's Remove button split per site, so one import
    can be dropped without the other.
  - The open panel no longer swallows autoplay clicks aimed at the squares underneath it - the click passes
    through for exactly the moment of the click, on every site.

- [x] **One Maia per page, and games fetched from Lichess** (v3.1.275)
  - **One Maia engine per page** - the Game Review strength estimate now sweeps the human pass's own
    Maia 3 across its rating dial instead of loading a second 92MB copy, and the Analysis page's
    moves-by-rating chart borrows the Human column's engine the same way, serialised on the sweep
    queue so a request cannot land mid-dial. Both hand the engine back at five lines and the selected
    rating when they finish.
  - **One answer for (position, rating)** - the chart's sweep already prices every move at every
    rating, so the Human column is served from the sweep's cache whenever the position has been swept
    - stepping through a game no longer pays a second forward pass per ply for a column the sweep
    already knew.
  - **Fetch games from Lichess as well** - the review's fetch row gained a site picker: Chess.com's
    public archive or Lichess's public export API, both by username, no login. Lichess games arrive
    with the same clock comments the think-time cards read, standard chess only so a variant game
    cannot come back as a silently broken review.

- [x] **The strength estimate, with its working shown** (v3.1.274)
  - **Strength per phase of the game** - the opening, the middlegame and the endgame each get their own
    rating, off the dividers the review already computes. "Opens like 2000, finishes like 2400" is a
    sentence a player can act on; one number for a whole game is not.
  - **The moves the estimate is built on** - the handful that pushed the winning rating past its nearest
    rival, each showing both ratings' probability for the move that was played, and what the winning
    rating would have played when that differs. The number stops being a verdict with nothing behind it.
  - **Compare two ratings directly** - pick any two of the model's ratings and read the positions where
    they most disagree, each one's move and how sure it was. Answers "what does 2200 do differently
    here" from the sweep that already ran.
  - All three are arithmetic over the one sweep the estimate already performs, so they cost **no extra
    engine time**, and every move listed is clickable and takes the board there.
  - **The settings search box wears its own glyph** and keeps clear of the first section heading, so it
    reads as a search box without needing a label.

- [x] **chess.com Game Review, on your board** (v3.1.273)
  - **chess.com's own Game Review** - Ask Chess.com sends the game to chess.com's real game-review
    service and their review comes back on the same board and move list the offline review uses: the
    eleven verdicts, the coach's commentary, both accuracies and the named opening.
    Fast/Standard/Deep/Maximum are chess.com's own strength tiers, not a Mephisto imitation.
  - **Your account, no credentials** - it runs in a chess.com tab (borrowed, or opened in the background
    and closed again), using your first-party session with nothing to paste; you get what your account
    gets (unlimited with chess.com premium, the free-tier allowance without). Castling and all four
    promotions encode correctly, each mapped from a real capture.
  - **A one-time heads-up** before the first review (10s before Accept), and a copy-error / open-ticket
    button when a review fails.
  - **Classification icons** now sit before the notation in the move list and before each summary-card
    label, the same glyphs the board draws.
  - **The review budget is a plain box** - depth in plies, or time in seconds (default 0.5s, step 0.5,
    any value), replacing the slider.

- [x] **All fourteen quick wins** (v3.1.272)
  - **The panel's number column says what it is** - Eval from an engine, Probability from a human model - and a
    Maia line's arrow carries the move's probability instead of an eval label that is identical on every line.
  - **The rating chart draws everything above 1%** (up to eight moves): the five-line clamp was ours, not the
    model's - one forward pass already prices every legal move.
  - **The Analysis page names the opening** (the review's position-keyed table, so transpositions come out
    right) and **asks the tablebase** once seven or fewer men are left - "Tablebase: win in 43 - Kd2".
  - **Drop a .pgn anywhere** on Analysis or Game Review; one shared helper, the paste box lights up, a drag
    without files is left alone.
  - **Game Review**: the progress line carries a **time-remaining estimate**; the report **names the move the
    game turned on** (biggest win-percent swing, preferring one that crossed the 50 line - a game that slid
    rather than jumped correctly says nothing), clickable in its verdict's colour; and clocked PGNs get a
    **think-time card per player** - five buckets and the longest think.
  - **A panic key** - X by default, rebindable: hides the panel, clears every arrow, stops the search, changes
    no setting. Reopening brings everything back as configured.
  - **Amber warnings for numbers the machine cannot honour** - threads above the cores, hash beyond memory -
    on all three pages that take them, with the deviceMemory spec-cap honesty written into the module.
  - **A search box over the settings** - matches labels AND tooltips, folds empty sections away.
  - **A storage readout** - what the extension is using, with the puzzle database named.
  - **Every missing string translated** - the twenty-three keys the thirteen non-English locales lacked, tips
    included, placeholders verified intact, and locale completeness is now pinned by the test ladder.

- [x] **Four from the roadmap** (v3.1.271)
  - **Maia's probability in the panel.** It scores the position once and puts that one number on every line, so the
    panel's line list was five copies of it -- while the thing that actually differs between its lines, how often a
    human of that rating plays each move, was computed by the net and never shown. Measured at Maia 1500 on the
    starting position: 65.2% e4, 22.9% d4, 2.8% c4, 2.4% Nf3.
  - **The rating sweep runs one ply ahead of the cursor.** Moves-by-rating only started working once the position was
    already on screen, so walking a game paid the whole sweep at every step -- twenty-one forward passes per move with
    Maia 3. The ply after the cursor is now filled in half a second after the current chart is drawn: **7ms** to a
    drawn chart when you step onto it, against seconds for a sweep. One ply only; further is work for a position
    nobody may look at.
  - **Export the position, not a picture of it.** A screenshot of the chart cannot be read back. Export writes one
    self-contained file -- the board, the FEN, the line that got there, the chart, and the table of numbers behind
    the chart -- stylesheets inlined, pieces embedded as data URIs, no scripts, nothing to fetch, nothing pointing
    back at the extension.
  - **A strength estimate in Game Review** (opt-in, off by default). The human model gives, for every legal move, the
    chance a player of a given rating plays it; ask it at each rating over the moves someone actually played and one
    rating fits better than the rest. It reports the ratings the game **cannot tell apart** alongside the peak,
    because twenty-odd moves carry no more precision than that, and draws the likelihood curve so a flat one is
    visible as flat. Book and forced moves are left out -- everyone plays those the same way. Affordable because Maia
    costs ONE forward pass whatever MultiPV is set to, so the whole distribution costs nothing over five lines.
    **It is a strength estimate and not a fair-play measurement**: a player using an engine reads as *stronger*, and
    one game is a small sample. Both are said on the page.
  - Also: Game Review's own rating dropdown had a hand-written copy of the band list and still offered 2000 and 2100,
    which have no net on disk; and a puzzle answer said where it came from twice, on two lines.

- [x] **The Analysis page, swept** (v3.1.270)
  - **Maia's own probability reaches the screen.** Both adapters worked out, for every legal move, how likely a
    human of the chosen rating is to play it - and then emitted the same position eval on every line, so only the
    move ORDER survived and everything downstream had to invent percentages from the rank. The Human column printed
    60.0 / 24.4 / 9.9 for every position at every rating; the moves-by-rating chart drew flat lines, because a decay
    over the order is identical wherever the order is. The real number is carried through now, and never
    renormalised over the few lines on screen: it is the chance out of *every* legal move, so four of them summing
    to 95% is the truth.
  - **The Maia 3 sweep asked for its rating in a name it does not answer to.** Maia 3 takes `SelfElo` / `OppoElo`;
    the sweep sent `UCI_Elo`, and `setoption` ignores a name it does not know - so all twenty-one bands ran at one
    Elo. Measured after the fix, starting position: e4 62.4% at 600, 63.8% at 1600, 45.8% at 2600, while d4 climbs
    21.4% -> 25.0% -> 35.7%. The test meant to cover this asserted the *wrong* option name as its evidence and so
    passed throughout; it now checks every option the sweep sends against the ones the model answers to.
  - **The search stopped answering after a move, sometimes.** Two analyses could both get past `await stopSearch()`
    - the second sees no live search, because the first has not registered its own yet - and both then started a
    search on the same engine. An engine already searching IGNORES the next `position fen`, so it kept thinking
    about the old board and streamed those lines into the new callback, where every one is illegal and is filtered
    out: "thinking..." forever while the depth counter climbed 24, 27, 29 without ever restarting.
  - **A search budget**, 1 to 60 seconds with a notch past the end that means no limit at all, and **Copy FEN** /
    **Copy PGN** under the board.
  - **The chart rebuilt** - one plot, every move named at its own end, a dot per band, the leader's area shaded, and
    a readout that follows the pointer. It honours the Lines setting, which it never did: three was pinned in three
    separate places, one of them a hardcoded table of three probabilities that could not describe a fourth move.
  - **The setup strip is one line.** The number fields and selects were plain browser controls next to the
    extension's own framed toggles - three heights, three label baselines, and a row that read as broken. And
    **both toggles on the page were inert**: the framework binds a control by `<name>_<type>`, the markup called
    them `_check`, so neither ever received its default (Win / draw / loss showed Off while the code behaved as if
    it were on) and clicking them saved nothing.
  - **Two Maia bands that never existed** - 2000 and 2100 were offered everywhere a rating is picked, with no net
    on disk behind them.
  - **The board takes the width** the right column was wasting beside the notation, and the chart moved under it.
  - **Game Review**: time per move in tenths from 0.1s to 15s, each mode keeping its own number; smaller verdict
    badges and rank tags; an eval bar beside the board.

- [x] **Five roadmap items, in one release** (v3.1.269)
  - **The panel grows to its content.** With five lines, the eval history, live stats and the FEN row up, 648px of
    panel was being drawn inside a 540px frame with overflow hidden - the bottom rows, `next-move` among them, were
    not crowded but unreachable. The box follows its content now, floored at the old height and capped by the
    viewport, with the body scrolling if the cap bites. The FEN box also wore the browser's own form grey; it uses
    the panel palette.
  - **The screen reader can tell two boards apart.** Mephisto's own panel carries a chessboard, and with no crop
    given the detector picked it - measured, a box spanning both boards and an illegal position. Blanking the
    panel's rectangle was tried and is worse (it overlaps the board it is asked about, so it takes a strip of the
    real board with it); the panel steps aside for the one frame instead. Verified: with the panel open and no
    crop, the page's board is found and read exactly right. **And a misread square is one click from fixed** - the
    model's runner-up for each unsure square is now a button.
  - **Pacing depends on what the move is.** One distribution for every move is the tell. A recapture is near
    instant, a forced move almost so, the queen gets more thought than the king, a visible mate slows things down,
    and under a minute on the clock it stops deliberating. The click itself is never sped up.
  - **A variant the engine does not have is said out loud.** Duck Chess autoplay was the request; it is blocked one
    level down. This build's Fairy-Stockfish declares 84 variants and duck is not among them (asked, not assumed),
    and Fairy answers an unknown UCI_Variant by staying on the one it had - so asking for duck produced a
    confident STANDARD CHESS analysis of a duck position. That silence is fixed: the engine is asked what it
    supports and the panel says when the answer is no.
  - **ChessBase Tactics: arrows and clicking.** The blocker was never the drawing, it was the geometry - a canvas
    with no element to measure and no class to match. ChessBase's own model carries the numbers (`boardWin.x0/y0`,
    `nSqPix`, `blackIsBottom`), so arrows are drawn on the board and moves are clicked onto it. Verified live: the
    overlay covered the reported rectangle exactly, and a move clicked through the extension changed the position
    ChessBase itself reports.
  - Also: the recogniser gets more threads (635ms to 589ms, measured 2/4/5/6/8 on a ten-core Mac, and eight is
    worse than four).
- [x] **Grind Mode confirmed on Chess.com** (v3.1.268) - the click-through v3.1.267 could not verify is
  confirmed working in a real game by Sam. Chess.com renders that button two ways and both are handled: the
  labelled variant carries `new-game-buttons-label`, which says what the button is in any language and is matched
  first; the bare variant carries nothing but utility classes, so it falls through to the time control in the
  label ("New 1 min", "New 3 | 2"), which is now read from the `aria-label` as well so an icon-only button is
  still found.

- [x] **The Grind Delay stepper looks and works like every other one** (v3.1.268) - it was written by hand
  without `set-step-btn`, the class that both styles it and makes it work, so it rendered as a raw white browser
  button in a dark page and its plus and minus did nothing. Nothing about the theme changed: the row was simply
  missing the class. The test that checks every stepper has both buttons now checks they carry that class too,
  which is what would have caught it.
- [x] **Grind Mode on Chess.com too** (v3.1.267) - the game-over modal there gives its buttons nothing but
  utility classes (`cc-button-component cc-button-secondary cc-button-large`), so there is no name to match on.
  What the new-game button does carry is the TIME CONTROL: "New 1 min", "New 3 | 2". Digits survive translation
  where "New" does not, so that is the match, and Game Review, Rematch and New Bot carry no time control and are
  never taken for it. **Honest about the evidence:** the modal container and the button markup are both from real
  chess.com games (a bot game I played and resigned, and the button HTML from one of Sam's online games), and the
  chooser is executed against that exact markup in the test suite. The click-through was confirmed in a real
  game shortly afterwards (see v3.1.268). On Lichess it is verified end to end.
- [x] **Grind Mode picks its button by structure, not by language** (v3.1.266) - the first version matched the
  word "New", which works in the handful of languages someone thought to list and in none of the other ~120
  Lichess ships. The markup was captured from a real game against a person instead: the control carries its own
  class, `new-opponent`, and that is what is matched now. The fallback, for the day that class changes, is
  structural too - and it had to be, because the analysis link is not always recognisable as one: Lichess renders
  it as a bare `<a class="fbt" href="/GAMEID/white#2">`, which a live test caught being clicked. It is excluded by
  the game id in its href, not by the word. Verified end to end against a person: two moves, resign, and it
  clicked "Neuer Gegner" after the delay.
- [x] **Grind Mode** (v3.1.265) - Lichess only, opt-in, and only while Autoplay is on: when a game finishes,
  Mephisto clicks the control that starts the next one (the "New 1+1" of a pool game, "New opponent" elsewhere)
  so a session keeps going. **Grind Delay** is the window in which you can stop it - close the tab, navigate away
  or switch the mode off during it and no new game is searched for; 0 starts immediately, 600s is the maximum.
  Everything about it fails silently: the analysis link sitting in the same box is excluded by construction, a
  rematch is not a new opponent and is never taken for one, and if the button is not where it was expected
  nothing happens and the game simply stays finished. Verified on real finished games, including one where
  Lichess offered "Neuer Gegner" and it was clicked after the delay.
- [x] **Two faults in the online engines, both reported from real games** (v3.1.264) - chess-api.com refuses any
  FEN that carries an en-passant square, which is most positions right after a pawn's double step: "Cannot evaluate
  given position - wrong FEN" on the ordinary French after 1.e4 e6 2.d4 d5. Measured against the live API in both
  the capturable and the non-capturable case, so it is not a rule that can be satisfied - the field is dropped for
  that provider, and the cost is stated: an en passant capture is invisible to it. And stockfish.online began
  answering HTTP 429 during a normal game, because the same position was being asked about again and again; an
  answer is now remembered for 15 seconds and two simultaneous asks become one request. Measured: nine repeats of
  one position cost 13ms instead of 11 seconds of real requests.
- [x] **The online engines are named for the engine they reach** (v3.1.263) - "Cloud: chess-api.com" said who
  answers, not what answers. They are now **Stockfish 18 (online)** and **Stockfish 17.1 (online)**, the versions
  those services run according to their own front pages, with the provider still named in Settings. The stored
  engine ids did not change, so an existing setting keeps working. A request that stalls or is rate-limited is
  also retried once now - seen live, one request hung past its timeout while the same endpoint answered a curl in
  130ms, and losing a move to that is worse than waiting a moment; a refused position is not retried, and a 429
  says it is a rate limit rather than showing a bare number.
- [x] **Cloud engines analyse the position in front of you** (v3.1.262) - a bug fix for v3.1.260, reported
  with two screenshots. On a live game the panel asks its engine about the game's START position plus the
  moves played since, which is what the native hosts and remote-engine.py take. A cloud provider has nowhere
  to put a move list, and the moves were being dropped - so every cloud answer after the first move was an
  answer to the starting position ("best move is d2d4" beside a board that had left the opening). The moves
  are now replayed onto the position before it is sent, and if any move does not fit, nothing is sent at all:
  an answer to the wrong position is worse than no answer. Measured before and after on lichess with three
  moves played: the released build asked about the start position five times out of five, the fix asks about
  the board.
- [x] **The cloud engines use the budget you set** (v3.1.261) - chess-api.com takes a thinking time, so the
  panel's Search Time is now sent to it and means something (measured: 50ms reaches depth 14, 2s reaches 16),
  with the depth setting as the ceiling. stockfish.online takes a fen and a depth and nothing else, so choosing
  it switches the search budget to Depth - remembering what was there and putting it back when you pick another
  engine. One rule in the config layer, so the panel's dropdown and the settings page cannot disagree about it.
- [x] **Cloud evaluation, and arrows on the board you read off the screen** (v3.1.260) - two engines in the
  dropdown, `Cloud: chess-api.com` and `Cloud: stockfish.online`, are a real server-side Stockfish reached over
  HTTPS: nothing to install, which is the whole point on a machine that cannot run a strong engine locally.
  **The position leaves your machine on every move** - that is the cost, it is written where the engine is
  chosen, and a local engine stays both faster and private, so this is a fallback rather than an upgrade. The
  request is made by the service worker (a page's own Content-Security-Policy can block a fetch made from the
  panel), and both providers' conventions were measured rather than assumed: eval and mate are white-relative
  on both, and both return mate as the string "1" but the number -1. Alongside it, a position read off the
  screen now gets the engine's arrow drawn **onto the region it was read from** - screenshot, video, another
  window - instead of only in the panel. Verified live: a board screenshotted from lichess, read at 560px on a
  plain page, arrow landing on it to the pixel.
- [x] **A sweep of the shipped build** (v3.1.259) - every setting driven and read back after a reload,
  every site route executed, and the edge cases pushed on purpose. Five real faults came out of it and
  are fixed: the settings export could not be re-imported (the worker keeps bookkeeping in the same
  store that is not a setting, and import rightly refuses a file holding one); an options-page link
  with no page behind it left a blank screen instead of falling back; the search-time slider's last
  notch stopped searches by itself when it had been asked not to; the board hunt gave up for good
  after ten seconds, so a board that appeared later never had its start position captured; and the
  budget tooltip promised that depth is reproducible on any machine, which is only true on one thread
  (measured: three depth-14 searches agreed exactly on one thread and read 27/25/24cp on four).
- [x] **A search-time slider for Game Review** (v3.1.258) - how long the engine may think about each
  position is now one slider: 1 to 60 seconds, or the notch past 60, which is unbounded. Unbounded means
  `go infinite` and nothing else - no settle rule, no ceiling - so the engine keeps thinking about the
  position until you press Stop, which scores it at whatever depth it reached. Depth mode keeps the same
  slider, 1 to 40 plies.
- [x] **Screen reading, three layers of not-asking** (v3.1.257) - a read used to cost ~670ms every time. Now the
  captured frame is hashed **before it is decoded**, so an unchanged screen answers without decoding, detecting or
  running the model: **repeat reads are 2-3ms**. A board that genuinely changed still pays the full read, and each
  layer was verified to notice a real change rather than serve a stale position.
- [x] **Polyglot books** (v3.1.256) - Analysis reads real `.bin` opening books. The format keys positions by its
  own Zobrist hash, so the 781-constant table is vendored (it is the format's published data, from Polyglot via
  python-chess, both GPL - 20KB, credited in the file) and the implementation is verified against the **format's
  own published test keys**, including the en-passant cases that only count when a pawn can actually take. A real
  1.5MB book reads in 44ms; loading one lists its moves with weights, and clicking one plays it. PGN and JSON books
  still work as before.
- [x] **The Analysis page, as asked for** (v3.1.255) - the board is bigger and **you can play on it** (click or
  drag; a move continues from wherever you are). Clicking any engine or human line plays that move. The eval bar
  is wider with the **number inside it**, win/draw/loss sits beside the board, and hash, thread count, line count,
  the rating band and an opening-book toggle all live in one strip **above** the board. Every engine can be picked,
  the way Game Review does it. Switching the human model no longer resets the analysis - the two engines are
  independent now. The move-by-rating chart draws a **line per move across the bands** instead of a wall of blocks,
  the useless tallies counter is gone, and arrow rank numbers sit at the **head** of the arrow where they can be
  read. Opening books load from PGN or JSON (Polyglot `.bin` is recognised and refused with the reason: decoding
  one needs Zobrist constants this repo does not vendor).
- [x] **The screen reader stops asking twice** (v3.1.255) - measured on one machine: a read is decode 25ms +
  board detection 84ms + position model 645ms, and the shipped position model is **already int8-quantised**, so
  there was no quantisation left to win. What was left was not asking: the board box is cached while the image
  geometry holds (and re-detected if a read comes back unsure), and the 256x256 crop is hashed so an unchanged
  board skips the model entirely. Repeat reads went **670ms to 26ms**; a real board change was verified to
  invalidate both caches. Every stage is now timed in Copy Diagnostics.
- [x] **Analysis thinks until you move on** (v3.1.254) - no depth to choose: the engine keeps working on the
  position in front of you and the lines deepen while you look at them, exactly like an analysis board should,
  and moving to the next move stops that search and starts the next. The running depth shows beside the engine's
  lines rather than overwriting the page's messages. **Moves by rating** now sweeps every band in 100-Elo steps -
  Maia 1 across its twelve nets, Maia 3 across its whole 600-2600 dial from a single net.
- [x] **One control look everywhere** (v3.1.254) - inputs, selects and text boxes are declared once, in the shared
  stylesheet, so a field on Game Review or Analysis is the same height, frame and focus ring as the same field in
  Settings. They had drifted apart page by page (the Analysis toolbar was 45px next to 30px elsewhere, because
  Materialize's own rule was winning).
- [x] **A flat menu, and Analysis leads with the board** (v3.1.253) - the sidebar no longer hides Settings and
  Appearance behind a dropdown: every page is one click, listed plainly. The Analysis page now opens on the
  board rather than on a form, with a compact strip above it for the things you change while looking at a
  position (depth, lines, the human rating band, and paste a PGN or FEN straight from the clipboard); the load
  and engine sections moved below. Also fixed: coming back to the page rebuilt the board while its stylesheet
  was still off, so it kept a full-width size and pushed the move list underneath.
- [x] **A dedicated Analysis page** (v3.1.252) - the panel is the right shape for a live game and the wrong one
  for studying, so studying gets its own page: a large board with the move list beside it, and **both engines at
  once** - what a human of a chosen rating would most likely play, next to what the engine wants, each with its own
  numbered arrows on the board. Win% and evaluation bars flank the board, a per-move probability chart shows how
  the choice changes across the rating bands, and the best / mistake / blunder tallies sit above the moves. Depth
  12 by default, which is quick enough to step through a whole game. The engine drivers are now shared with Game
  Review rather than duplicated.
- [x] **Verdict badges, and a board that leads the page** (v3.1.252) - every classification now draws its own badge
  on the move's destination square, the way a review is read everywhere: **!!** for Brilliant, **!** for Great, a
  star for Best, a check for Excellent, a thumb for Good, a book for theory, **?!** **?** **??** down the other
  side and a cross for a Miss. The engine's candidate arrows carry their **rank number**, so the line it actually
  likes is the one marked 1. The Game Review board is larger and the move list narrows down its side. (The badges
  are our own artwork in the familiar visual language - the well-known set belongs to chess.com and is not
  redistributed here.)
- [x] **Every move gets a name** (v3.1.251) - Game Review classifies with the full published scheme:
  **Brilliant, Great, Best, Excellent, Good, Book, Forced, Inaccuracy, Mistake, Miss, Blunder**. The ordinary
  classes are win-probability bands (under 2% lost is Excellent, under 5 Good, under 10 an Inaccuracy, under 20 a
  Mistake, 20 or more a Blunder) and the three specifiers are earned: **Brilliant** needs real material offered
  (an exchange is replayed on the square to prove it), the move still near-best, the position not already won and
  not thrown away; **Great** is the only move that holds, measured against the engine's second choice; **Miss** is
  a winning position let go, which reads nothing like a slip. The panel's live stats moved to the same bands, so
  one move cannot get two verdicts on two screens. Verified on Morphy's Opera Game: 1 Brilliant, 6 Great.
- [x] **The panel answers while the engine is still loading** (v3.1.250) - opening the panel used to wait for the
  engine before it registered its message handler, so on a cold browser it was up but deaf for the whole
  service-worker-wake plus net-load window: no board, no scrape, no eval. Engine init now runs alongside the rest
  of the boot (the engine host already queues anything sent while it loads). Honest limit: a clean rig profile
  starts in well under a second, so the long stall could not be reproduced there and the size of the win on a
  loaded profile is unmeasured.
- [x] **Every setting says what it does** (v3.1.249) - hover any control on either settings page and a one-line
  description explains it. 59 controls, none mute; the ladder proves its own check discriminates before it scans,
  so a new row cannot ship silent. The Game Review section nav also stopped overlapping: Materialize hard-codes a
  fixed height on those links, so any entry that wrapped to a second line drew on top of the next one.
- [x] **The test rail clicks on its own** (v3.1.248) - the second half of v3.1.238: chess.com joined the
  fixtures (a real bot game mid-play), a lichess live-game fixture carries the player boxes so Hide Opponent
  Name is finally testable (the harness counts the real selector's matches, exactly like the extension does),
  and `test/run-harness.js` runs the whole suite in headless Chromium and fails the build - `release-zips.sh`
  refuses to cut archives while it is red. 19 checks across three captured pages.
- [x] **Castling obeys the rules it was skipping** (v3.1.248) - the bundled chess.js offered castling out of
  and through check (only the destination square was ever validated), so Maia - which plays the library's move
  list verbatim - would sometimes click an illegal O-O. Fixed in move generation with the full path rule;
  seven ladder pins now run the real library, and everything downstream (forced lines, premove safety, PV
  validation) inherits the fix.

- [x] **Arrow colours, yours** (v3.1.247) - an Appearance section that re-colours every arrow family the
  panel draws: engine lines 1–5, forced continuations (both sides), PV Arrows, the threat arrow and book
  arrows. Native colour picker + hex field per row, synced both ways; empty means default; validation at
  the drawing site means a junk value falls back instead of vanishing an arrow. Changes repaint live.
- [x] **Custom positions vs the computer, both sites** (v3.1.247) - chess.com's `/practice/custom` page is now
  a first-class board (its FEN travels in the URL, which the page strips after load - it is recovered from the
  navigation entry), and lichess **From Position** games with *black* to move first no longer fail detection:
  the start was captured from the pieces, which cannot carry the turn, and the off-by-a-tempo reconstruction
  failed the en-prise validator on every scrape. The page's own FEN (round JSON, or the variant-link editor
  href on vs-AI pages) now wins at move 0. Found by engineering a forced-mate test position; verified by a
  live 2-deep **premove chain with a queued promotion** (`f8g8 e7e8q`) on the practice board.
- [x] **PV Arrows: the whole line on the board** (v3.1.246) - opt-in: every ply of the engine's best line as a
  thin grey numbered arrow (length 1–50, default 5), validated move by move so a garbled line never draws a wrong
  arrow. Grey is deliberate - it is the engine's current suggestion, revisable at the next depth, so it must not
  wear the certainty colours: forced continuations draw on top in their own hues, and the live engine arrows on
  top of those. Forced lines also moved to magenta/teal in the same release, off the engine-line palette.
- [x] **Maia premoves: the second inference** (v3.1.244) - Maia predicts the opponent's move but never had a
  reply of yours to premove. Now a second, isolated inference on the same net asks what you would play after
  that prediction, and the answer rides the normal premove rails: if the opponent's most human move is taking
  your bishop, the recapture is premoved; mates and forced replies likewise. The safety gate is unchanged - a
  premove only queues when the reply is bound to the predicted move, so it cannot fire in a wrong position.
- [x] **Forced lines are your premoves** (v3.1.239) - reworked to what the feature was always for: while every
  opponent reply is their only legal move, YOUR next moves from the engine's line are drawn in blue (the ones you
  could premove) and their forced replies in violet. The first position where the opponent has a real choice ends
  the chain, so everything drawn is certain given only your own choices.
- [x] **A premove framework** (v3.1.239) - when to arm and how many are settings now: **Premove Confidence** is
  the certification depth (default the measured 13/14/latest window), **Premove Plies** caps how many a forced
  sequence queues. And a reply that is the opponent's only legal move is certified by the rules at any depth -
  the certification chess.js can do that a shallow search cannot.
- [x] **Forced lines, drawn ahead** (v3.1.234) - when the reply is the opponent's ONLY legal move, and so is the
  one after it, each is drawn as its own arrow -- **yours in magenta, the opponent's forced replies in teal** (recoloured in v3.1.246: the old blue/violet sat next to two engine-line hues), each
  ramp darkening with depth so the order reads inside a side. Up to five plies, off by default. Only genuinely forced moves are drawn: a position with one legal reply is a fact about the rules, where
  a move that is merely best is a judgement the search can revise. The walk FOLLOWS the engine line and draws only
  the plies that were forced, so an only-move three deep still gets an arrow even when the defender had a choice
  before it - and a judgement drawn as an arrow reads as a
  certainty exactly when the position is sharpest.
- [x] **Explain moves says what a move saves and threatens** (v3.1.234) - beyond naming the tactic, it now reports
  the piece a move rescues and the one it starts attacking, asked the only way that cannot be wrong: by playing the
  position out and comparing. An even trade is never called a threat.
- [x] **Screen reading is quicker** (v3.1.231) - the tab is captured as JPEG rather than PNG. The encode was
  the dominant cost and was paid three times: the browser losslessly encoded the whole visible tab, the result
  travelled to the recogniser as base64, and it was decoded again - for an image immediately downsampled to
  256×256. The position model was verified reading exact FENs at JPEG q20 when it was integrated, so this is well
  clear of the edge. Copy Diagnostics now reports the capture and the inference separately, since the two have
  entirely different fixes.
- [x] **Live stats** (v3.1.228, standalone in v3.1.229) - a strip under the board with a running accuracy for both
  sides and the tally of best moves, inaccuracies, mistakes and blunders. Derived from the same eval history the
  graph draws, judged by the same win% bands Game Review uses, so the strip and the review afterwards agree.
  Hotkey **L**.
- [x] **Overlay controls** (v3.1.228–230) - arrow opacity as a 1–100 slider with its value shown as you drag,
  a switch for the rank number on each arrow, a bigger evaluation on them, and board animation you can turn off.
- [x] **A health check** (v3.1.228) - Copy Diagnostics names the missing part in the panel as well as copying the
  report: site, board, position, settings, engine, native host. It reads in dependency order, so the first failure
  is the cause and the rest are symptoms. Press it any time.
- [x] **Following the screen keeps up** (v3.1.229) - the reader re-queues the instant a read returns instead of
  waiting out a fixed slot. There is no interval left to quote, so the readout that quoted one is gone too.
- [x] **The update notice tells the truth** (v3.1.229) - it stops offering a version already written to disk but
  not yet reloaded, and it sends you where you can act: the release page when self-updating is off, the install
  when it is ready, the Updates section when it is on but unfinished.
- [x] **Search by depth, and notation you can read** (v3.1.226) - the search budget is a choice: a millisecond
  budget is a different search on every machine, a depth is the same answer on all of them, and both keep their own
  number so switching back loses nothing. Moves are written in SAN or UCI wherever the extension writes one.
- [x] **Arrows that say which line they are** (v3.1.226) - each arrow carries a rank badge (1 for the engine's best,
  2 upwards for the rest) and its own evaluation, on the panel board and the page board alike. Multiple Lines is no
  longer capped at five.
- [x] **Setup Chess** (v3.1.222) - the board is read from the pieces themselves (there is no move list to replay
  and no fixed start position to replay it from), moves are dragged because a capture is not playable there any
  other way, and promotions work. Plays as ordinary chess once the setup phase ends.
- [x] **[Game review](#game-review)** (v3.1.218) - a finished game analysed on the extension's own page: accuracy,
  move quality, alternate lines, an eval graph, think time from the clock comments, an optional Maia pass, and
  fair-play measurements that deliberately stop short of a verdict. Exports as one self-contained HTML file.

- [x] **[Automatic updates](#automatic-updates-opt-in)** (v3.1.214, one-click from the panel v3.1.215) - opt-in:
  fetches the ~6 MB update archive from this repository and writes it into the extension's own folder in place, so
  the id and the native hosts survive. Once it is set up the panel's own update notice installs it. Off by default;
  nothing is installed without pressing the button.
- [x] **[Four-player chess](#four-player-chess)** (v3.1.199) - chess.com's 4-player variant, driven by
  [Tetrarch](https://github.com/IchNukeDichWeg/Tetrarch); 14×14 panel board, team-relative eval, autoplay.
  Teams mode only.
- [x] **Panel and settings rework** (v3.1.199) - two tabs instead of a wall of rows, the game and engine status
  moved into the title bar, `−`/`+` steppers for threads, lines and move time, uniform control heights, one
  typeface per column, and a settings page grouped into sections.
- [x] **Four-player chess on Windows** (v3.1.200) - DLL build, `.bat` host shim and a PowerShell installer that
  registers under `HKCU`. Unconfirmed on real hardware, hence the open item above.
- [x] **Fourteen languages** (v3.1.160) - every string, switchable live in Settings → Appearance.
- [x] **Puzzle database** (v3.1.140) - the Lichess puzzle CSV in IndexedDB; known solutions play with no search.
- [x] **Endgame tablebase**, **move confidence**, **eval history graph** (v3.1.135).
- [x] **Read a position off the screen** and the **playable panel board** (v3.1.124).
- [x] **From-Position capture** and **on-demand nets** (v3.1.125) - an unbundled net downloads on first use; a full
  install still works offline.
- [x] **Opening Explorer + book play**, **set up a position**, **auto-recover on DOM changes** (v3.1.119) - if a
  site renames its move-list tags, the list is found structurally.
- [x] **Pondering** and **double premove** (v3.1.107).
- [x] **Maia-3** (v3.1.95) - 600–2600 slider, one transformer conditioned on rating; reproduces the
  [CSSLab reference](https://github.com/CSSLab/maia3) exactly (~60% move-match to human play).
- [x] **Maia** (v3.1.93) - the original nets, 1100–1900 plus a community-trained 2200. Matches the lc0 reference.
- [x] **Instant reopen with a warm engine**, the **turn switch** (v3.1.92), **human cursor travel** (v3.1.90).
- [x] **Manual mode**, **configurable hotkeys**, **opponent mistake alert**, **self-test button** (v3.1.84).
- [x] **Copy FEN/PGN, compact panel, export/import** (v3.1.73); **native health badge, smart default threads**
  (v3.1.55).

---

</details>

## Contributing

**[Open an issue](https://github.com/IchNukeDichWeg/Mephisto/issues/new/choose) for anything** - a bug, a site that
stopped being scraped correctly, an engine that misbehaves, a feature you want, or just an idea. You don't need a
diagnosis or a reproduction; "it stopped playing moves on lichess this morning" is a perfectly good issue. PRs are
welcome too.

**Paste a diagnostics report into the issue.** Press **D** on the page, or open the panel's **Engine** tab and
click **Copy Diagnostics**, then paste. It is the single most useful thing you can attach: it carries the build,
the engine in use, what was detected and on which site, the state of the page script, whether the last move played
and why not if it didn't, the worker's load, where a click's time went, and the recent trace. It deliberately
carries **no addresses, no account, no API token and nothing identifying**, so it can go straight into a public
issue.

Two things make a report much sharper, both optional:

- **Turn on Verbose Logging first** (Settings → Engine) and reproduce the problem before copying. The trace is
  what turns *"it was slow"* into a line naming which part was slow - without it the report has the state but
  not the history.
- **Copy while it is broken.** The report is a snapshot: reloading the page or the extension to "get a clean
  one" throws away exactly the state that explains the fault.

*"It did nothing"* with a diagnostics dump attached is worth more than a careful description without one. The
quiet failures are the expensive ones here, and the report is what makes them visible.

**If the Windows four-player setup fails, an issue is especially useful** - it is built and symbol-checked but has
never been run on a real Windows machine, and native-messaging failures there are silent: Chrome reports the host as
unavailable and says nothing about why. Testing it in stages turns that into something actionable, so please say
which one broke:

1. `./setup.sh` under MSYS2 produces `build\tetrarch.dll`
2. `python -c "from tetrarch import core"` imports without raising
3. `python uci.py` answers `go` in a plain terminal
4. the panel finds the engine in Chrome

A report of "stage 3 hangs" is worth far more than "it doesn't work", because each stage has a different cause.

## License & credits

This project's own source (and the original [Mephisto](https://github.com/AlexPetrusca/Mephisto) by Alexandru
Petrusca) is **MIT** ([`LICENSE`](LICENSE)). It **bundles copyleft components** - GPL-3.0 engines and nets, and the
**AGPL-3.0** Maia-3 model - so the **combined distribution is governed by AGPL-3.0**. Before redistributing, read
[`LICENSING.md`](LICENSING.md) and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md); full texts in
[`licenses/`](licenses/).

Built on the work of others, with thanks:

- **[Stockfish](https://github.com/official-stockfish/Stockfish)** & **[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish)** (GPL-3.0), run in the browser via the [Lichess Stockfish-web](https://github.com/lichess-org) builds.
- **[Maia](https://github.com/CSSLab/maia-chess) / [Maia-3](https://github.com/CSSLab/maia3)** (CSSLab, University of Toronto; GPL-3.0 / AGPL-3.0) and the **[Maia 2200](https://github.com/CallOn84/LeelaNets)** net (CallOn84; GPL-3.0); **[Leela Chess Zero](https://github.com/LeelaChessZero/lc0)** (GPL-3.0) for the input/policy encoding.
- **Board recognition** - two models from [Chess_diagram_to_FEN](https://github.com/tsoj/Chess_diagram_to_FEN) by Jost Triller (MIT), converted to ONNX; see `lib/engine/vision/`.
- **[ONNX Runtime Web](https://github.com/microsoft/onnxruntime)** (Microsoft; MIT) - in-browser inference.
- **Polyglot book format** - the 781 Zobrist constants a `.bin` book is keyed by (`lib/polyglot-random.js`), from Polyglot via **[python-chess](https://github.com/niklasf/python-chess)** (Niklas Fiekas; **GPL-3.0**). They are the format's published data: a book cannot be read without exactly those values. The reader itself is this project's code.
- **[chess.js](https://github.com/jhlywa/chess.js)** (BSD-2), **[chessboard.js](https://github.com/oakmac/chessboardjs)**, **[jQuery](https://jquery.com)**, **[Materialize](https://materializecss.com)** and `lru` (all MIT).
