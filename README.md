![Mephisto](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

**Mephisto** is a browser extension for real‑time **chess analysis** and **automated play** on **Chess.com**,
**Lichess**, **BlitzTactics**, **TakeTakeTake**, and **ChessBase Tactics**. It reads the position straight off the page, runs a local
**Stockfish** (NNUE) or **Fairy‑Stockfish** engine entirely in your browser — no server, no account — and draws the
**best move** on the board, or plays it for you with timing and move choices that can be tuned to look completely
human.

> Chess bot · best‑move finder · Stockfish in the browser · auto‑move · board scanner · eval bar · Chess960 &
> variants · move analysis for Chess.com, Lichess, BlitzTactics, TakeTakeTake and ChessBase Tactics.

Click Mephisto's toolbar icon to toggle its floating analysis panel directly on the page. The panel drags anywhere
by its title bar, closes with the ✕, and — unlike a classic extension popup — stays open while you click and play,
so analysis and autoplay keep running for the whole game.

---

![Analysis with five candidate lines drawn on the board](docs/analysis-lines.png)

## ⚠️ Read this first — disclaimer & fair play

**Using this in a live game against another person violates the Terms of Service of Chess.com, Lichess,
TakeTakeTake, and effectively every chess site.** Not a grey area — every one of them prohibits outside
assistance in rated or casual games against humans. Read this section before you install.

### What actually happens if you do it

- **Account closure.** Chess.com's Fair Play closures are typically permanent and rarely reversed. Lichess marks
  accounts publicly ("this account violated the Terms of Service") — the mark is visible on your profile forever.
- **It follows you.** Bans are applied at the device/network/payment level too, so alt accounts and your *other*
  legitimate accounts commonly get caught in the same closure.
- **Rollbacks.** Ratings, prizes, titles and tournament results get reverted; opponents get their points back.
- **Your opponents report you.** Suspicious games get flagged by real people, which is what opens a case.

### The honest part: this extension cannot make you undetectable

**The detection that catches engine users is server-side and behavioural. Nothing in this extension defeats it:**

- **Move agreement** — how often you play the engine's top choice, measured over many games.
- **Think-time distribution** — humans think longer on hard moves and vary wildly; engines are eerily consistent.
- **Premoving the exact predicted reply**, repeatedly.
- **Accuracy spikes** — play that doesn't fit your own rating history, or that's too good in exactly the positions
  where it's hardest to be good.

These are **statistical, aggregated across your account**. They don't care what your DOM looks like. Hiding the
extension's page footprint does **nothing** against them. Anyone telling you a setting makes you safe is wrong.

The anti-detection work in this fork addresses one narrow thing: **passive client-side fingerprinting** — a site
noticing the extension is *installed*. Even the people writing detection for it
([see this write-up](https://github.com/AlexPetrusca/Mephisto/issues/35)) call that a *corroborating* signal that
should never trigger a sanction on its own, and say plainly that the robust signal is server-side. Reducing your
footprint changes a footnote in a case file. It does not change the case.

### If you want a smaller footprint anyway

These reduce *client-side* fingerprinting and make automated play look less mechanical. They do not make it safe.

| Setting | What it does |
|---|---|
| **Maia-3 (human-like play)** | The transformer Maia model conditioned on a **target rating you set (600–2600, fine steps)** — one model, slide the strength live. Plays the actual moves a human of that rating would; the most human-looking option here. |
| **Maia (human-like play)** | The original Maia-1 nets, one per rating (**1100–1900**, plus a **2200**) — real human mistakes and move distribution, not a strong engine throttled down. |
| **Panel Style → Toolbar popup** | No in-page panel at all — **zero page footprint**. The safest mode; analysis only (Autoplay/Premove need the floating panel). |
| **Humanize** | Don't play engine-perfect: mixes in 2nd/3rd/4th lines, inaccuracies, mistakes and blunders at rates and centipawn thresholds you set (with a Lichess accuracy readout), and varies think time by how critical the position is. |
| **Clock Mode / Mirror Time** | Paces moves against the real clock, or mirrors your opponent's time use, instead of answering instantly. |
| **Elo cap** | Cap engine strength. Playing 3200 in a 1400 pool is the loudest signal there is. |
| **Background Play → Off** (default) | Only moves while the tab is focused and visible — humans don't play while tabbed away. |
| **Move/Think Time** | Slower, varianced timing beats instant robotic replies. **Move Time** is now the *total* wall-clock for a move (piece-click + cursor travel + any promotion picker); whatever number you set is how long a move takes, no hidden extras. |
| **Cursor travel before every click** (automatic since v3.1.90) | The synthetic mouse now traces an eased, slightly bowed, jittered path from its last position to the target before each click, spread across your Move Time budget — instead of teleporting straight to `(x, y)`. Removes the "click with no preceding mousemove" tell, the loudest client-side behavioural signal after the 3-click deselect fingerprint (which was fixed earlier). |
| **Turn switch** (♔/♚) | A king-glyph toggle at the top of the panel shows whose turn it is and lets you flip it when the scraper guesses wrong (puzzles / custom "From Position" starts). Tap to switch back and forth; it auto-tracks each move and resets on close. |

The single most effective thing on this list is **not using it in rated games against people.**

### What this is genuinely good for

Reviewing your own finished games · studying openings and endgames · puzzles and tactics training · benchmarking
and developing engines · testing this extension · analysis boards and offline/vs-computer play · unrated games
where your opponent knows.

**You are responsible for how you use this.** It's provided for analysis, engine development, research and
education. If you use it to cheat people out of fair games, that's on you — and you will probably lose the account.

---

## ⭐ Why this fork?

This is an **actively maintained** continuation of the original
[Mephisto by Alex Petrusca](https://github.com/AlexPetrusca/Mephisto). Installed from upstream today it detects
nothing — the 2026 Chess.com and Lichess redesigns broke every scraper. This fork **revives it on today's sites and
goes far beyond.** Everything the original did still works here; the table shows what's new.

| Capability | Original | **This fork** |
|---|:---:|:---:|
| Best‑move analysis + board arrows (Chess.com, Lichess) | ✅ | ✅ |
| Local Stockfish engine in the browser, no server | ✅ | ✅ |
| Autoplay · Multiple lines · "Hand & Brain" · Remote engine | ✅ | ✅ |
| **Works on the 2026 Chess.com / Lichess sites** | ❌ broken | ✅ |
| **Modern engines** — Stockfish dev / 18 / 18‑Small NNUE | ❌ | ✅ |
| **Elo strength cap** (engine‑aware slider) | ❌ | ✅ |
| **Maia-3** — human-like transformer, one model, live 600–2600 rating slider | ❌ | ✅ |
| **Maia** — human-like neural nets (1100–1900 + 2200), in-browser, no server | ❌ | ✅ |
| **Humanize** — human move mix, timing & reflex recaptures | ❌ | ✅ |
| **Clock Mode & Mirror Time** management | ❌ | ✅ |
| **Manual Mode · rebindable hotkeys · opponent-mistake alert** | ❌ | ✅ |
| **Safe Premove** (+ human‑reflex gate, + double premove) | ❌ | ✅ |
| **Opening Explorer** — human opening data + optional weighted-random book play | ❌ | ✅ |
| **Pondering** — think on the opponent's clock | ❌ | ✅ |
| **Help Mode** — draw arrows on the real board | ❌ | ✅ |
| **On‑board eval bar** with live search depth | ❌ | ✅ |
| **Chess.com variants** (11) — detect · analyze · autoplay | ❌ | ✅ |
| **TakeTakeTake** (WebGPU canvas board, incl. online games) | ❌ | ✅ |
| **Chess960** on every mainline Stockfish | ❌ | ✅ |
| **Zero‑iframe panel** — no page‑visible browsing context or extension URLs | ❌ | ✅ |
| **Background Play gating** — only moves while the tab is focused | ❌ | ✅ |
| **Move‑correctness guards** — never plays a superseded search's move; no freeze or double‑move on long thinks | ❌ | ✅ |
| **Scrape & settings robustness** — one stray move‑list node can't kill detection; settings survive an engine being removed | ❌ | ✅ |
| **Copy FEN / PGN · compact panel · engine‑health dot · export/import settings** | ❌ | ✅ |
| Event‑driven detection · floating resizable panel · engine crash‑recovery | ❌ | ✅ |

Issues and pull requests are watched and fixed — this fork is **updated and maintained**.

---

## Install (load unpacked)

This build is distributed as an unpacked extension, not through the Chrome/Firefox stores.

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top‑right).
4. Click **Load unpacked** and select the repository folder.
5. Pin Mephisto for quick access: click the puzzle icon right of the address bar and pin "Mephisto Chess Extension".

To pick up a code change: reload the extension on `chrome://extensions`, then reload the game tab.

The panel checks this repository for a newer release (at most once every 12 hours) and shows a small
notice when one exists. The check runs in the extension's service worker, so the chess page never
makes the request, and it stays silent if it fails.

---

## The panel

- **Floating & draggable** — drag by the title bar, place it anywhere over the board; it never blocks the game.
- **Evaluation & lines** — the score (White‑relative) plus the best line and, optionally, alternative lines and a
  threat line, all as arrows on the board.
- **Quick Settings** — every setting is editable inline: engine, Elo cap, variant, search time, threads, memory,
  number of lines, and all timing/mode toggles. Changes apply on the next move (engine changes reload the panel).
- **Re‑detect (↻)** — rescan the page and restart analysis, e.g. after a new game loads without a full page reload.
- **Analysis board (⧉)** — open the current position on Lichess's analysis board in one click.
- **Set up a position (grid button)** — paste a **FEN** to analyse any position instead of the board on the page.
  The panel stops following the page while one is set; click again (or Re-detect) to return to the live game.
- **Copy FEN / Copy PGN** (two labelled buttons) — the position, or the whole game so far. A game that began from a custom start
  (Chess960, "From Position") exports with `SetUp`/`FEN` tags, so it reads back as the same game rather than as a
  standard one.
- **Compact (▣, in the title bar)** — collapse the panel to just the status line, move and score; press again to
  restore. Remembered between sessions. Different from **minimize (–)**, which hides the panel entirely behind a
  badge while autoplay keeps running.
- **Engine health dot** — top corner, native engines only: green if the native host answered, red if it isn't
  installed. Without it, a missing host just looks like a panel that never evaluates.
- **Unsupported variants are named, not faked** — Duck, Minihouse, Seirawan and Chaturanga have engine nets, but the
  bundled chess.js can't replay them; the panel says so instead of analysing the wrong position.

---

## Engines

Everything runs locally in your browser via WebAssembly — no server, no account, nothing leaves your machine.

![Maia-3 with the 600-2600 rating slider](docs/maia3.png)

| Engine | Notes |
| --- | --- |
| **Stockfish dev NNUE** | Latest development build, neural‑net eval. Default. |
| **Stockfish 18 NNUE** | Full dual‑net build (the large net ships split into chunks and is stitched at load). |
| **Stockfish 18 Small NNUE** | Smaller net — lighter download, still very strong. |
| **Stockfish 11 HCE** | Classical hand‑crafted eval (no NNUE); light and fast. |
| **Fairy‑Stockfish 14 NNUE** | Required for the chess **variants** below (each variant has its own net). |
| **Remote Engine** | Talk to an engine running outside the browser over a small local bridge, for when you want more power than WASM allows. |

Illegal scraped positions (missing king, wrong side in check, back‑rank pawns) are blocked before they can crash the
engine, and a crashed engine auto‑restarts (capped at 3 attempts).

### Strength cap (Elo)

Limit any Stockfish/Fairy engine to a target **Elo** with an engine‑aware slider. The stops follow each engine's
real `UCI_Elo` range (Stockfish dev/18: 1320–3190, Stockfish 11: 1350–2850, Fairy: 500–2850). Both ends of the
slider mean **full strength** (no cap): *Off* on the far left, *"max+"* on the far right. Sent as
`UCI_LimitStrength` + `UCI_Elo`; values outside an engine's range are ignored by the engine, so the slider stays
within bounds automatically.

### Variants

![Atomic on Lichess, analysed by Fairy-Stockfish](docs/variants.png)

Standard chess and **Chess960 / Fischer Random** work on every mainline Stockfish (via `UCI_Chess960`) — including every castling case (king‑takes‑rook UCI, the king already standing on its castled square, and rooks on non‑standard files).
Fairy‑Stockfish ships its own NNUE net per variant and additionally plays:

- **Lichess** — Crazyhouse, King of the Hill, Three‑Check, Antichess, Atomic, Horde, Racing Kings (all of Lichess's variants).
- **Chess.com** — the above plus **Duck, Minihouse, Seirawan (S‑Chess), and Chaturanga** (Giveaway maps to Antichess).

The **↻** button next to the variant selector detects the variant from the current game and switches to the right
engine automatically. Each variant's net is bundled, so nothing extra to download.

---

## ⚡ Full-power native engines (optional)

**You don't need this.** The bundled WASM engines above work out of the box with zero setup. But WASM
is sandboxed — it can't use all your CPU cores or much RAM, so it runs maybe **5–70× slower** than a
native engine. If you want *maximum* strength and speed, you can point Mephisto at a **native**
Stockfish / Fairy-Stockfish installed on your machine. Chrome then **auto-launches** it for you — there
is **no server to run**. This is entirely opt-in and doesn't affect the default WASM engines.

When set up, two extra engines appear in the dropdown — **Stockfish (local)** and
**Fairy-Stockfish (local)** — sitting next to their **WASM** counterparts so you can switch freely.
They run at all cores + up to 2 GB hash (both follow your Threads/Hash sliders). Switching engines
shuts the previous local engine down so the one you pick gets the whole CPU.

### What you need
1. A native **Stockfish** binary (and optionally **Fairy-Stockfish** for variants).
2. **Python 3** with `python-chess`:  `python3 -m pip install chess`
3. Your **extension ID** (see below).

> **Extension ID:** open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`),
> turn on **Developer mode**, and copy the long id shown under *Mephisto*.
> ⚠️ An unpacked extension's id **changes when you reload it** — if native engines stop working after a
> reload, just re-run the install command with the new id.

### macOS
```bash
brew install stockfish fairy-stockfish        # or download the Apple-Silicon build from stockfishchess.org
python3 -m pip install chess
native-host/install.sh --ext-id YOUR_EXTENSION_ID
```
(A binary downloaded from the web is quarantined by Gatekeeper — the installer clears that for its copy.
If you point at one yourself, `chmod +x` it and, if macOS blocks it, `xattr -d com.apple.quarantine <path>`.)

### Linux
```bash
sudo apt install stockfish          # Debian/Ubuntu; or your distro's package / a release binary
python3 -m pip install chess
native-host/install.sh --ext-id YOUR_EXTENSION_ID
```
(Fairy-Stockfish: install `fairy-stockfish`, build it, or pass `--fairy /path/to/binary`.)

### Windows
The shell installer is macOS/Linux only; Windows native messaging needs a registry key, so it's a
manual (advanced) setup:
1. Install [Python](https://python.org) and run `pip install chess`; download `stockfish.exe`.
2. Copy `native-host/uci-native-host.py` somewhere stable and create `sf-native.path` next to it
   containing the full path to `stockfish.exe`.
3. Write a host manifest `com.sf_native.host.json` (underscores — Chrome rejects hyphens in host
   names) with `"path"` pointing at a `.bat` that runs `python <path>\uci-native-host.py`, and
   `"allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]`.
4. Add registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sf_native.host` = the manifest path.

(Prefer the bundled WASM engines on Windows unless you're comfortable with the registry.)

### Which binary?
Any native build unlocks full speed — the choice only matters at the margin. Pick the one matching your
CPU: **Apple Silicon** build on M-series Macs; **AVX2** or **BMI2** on modern Intel/AMD. Difference
between native builds is small; the jump from WASM to *any* native build is huge.

### Browsers
The installer registers the host for every Chromium-family browser it finds — **Chrome, Brave, Edge,
Chromium, Vivaldi**. Use the matching `…://extensions` page to get the id. (Firefox isn't supported for
native engines.)

If a native engine ever shows *"native host unavailable"*, the binary or `python-chess` is missing, or the
id changed — re-run the install command.

---

## Analysis features

- **Multiple lines** — the top 1–5 candidate moves (MultiPV), each drawn on the board with its evaluation.

  ![Three candidate lines, each with its own coloured arrow](docs/multiple-lines.png)

- **Eval bar** — a chess.com-style vertical bar beside the board, from your perspective, score inside it.
- **Threat analysis** — also shows the opponent's strongest reply, so you can see what they're threatening.
- **Search time · Threads · Memory** — how long the engine thinks per move, and what it may use to do it.
- **"Hand & Brain"** — Mephisto plays the *Brain* (names the piece type); you play the *Hand*.
- **Continuous analysis** — with Autoplay off, the engine keeps going instead of stopping at the search time.
- **Move confidence** — how much better the best move is than the second: `· clearly best (+3.7)`, `· +0.35 over #2`,
  `· several equal`, `· only move`. "Only move" and "six moves are all fine" used to render identically. Read off the
  MultiPV lines already on screen, so it costs no extra search.
- **Read a position off the screen** — the camera button captures the tab, finds the board and loads it. Any site — a
  video, a diagram, an image — and nothing is uploaded. Drag a box around the board if auto-detection misses.

  ![Reading a position straight off a YouTube video](docs/read-from-screen.png)

- **Playable panel board** — click or drag pieces to walk a line (with underpromotion); click a piece to see its legal
  moves. Every move is kept as a line you can click back into, and playing a different move truncates the rest.
  Re-detect returns to the live game.

  ![The opening explorer, with each book move drawn on the board](docs/opening-explorer.png)

- **Opening Explorer** — how humans played the opening (Lichess database): the name, the most-played replies with
  their win/draw/loss split, and coloured arrows. Pick Masters, all Lichess, or a club rating band. Read-out only;
  see **Play Book Moves** to play from it.

## Automated play

- **Autoplay** — Mephisto plays the engine's move for you automatically.
- **Help Mode** — mirrors the analysis arrows onto the site's board and keeps evaluating; you play the move yourself.
  Overrides Autoplay while on.
- **Puzzle Mode** — optimizes for solving speed (Puzzle Rush, Storm, Racer). Every move is one it actually searched,
  and it never analyses the opponent's turn. A puzzle page ships no move list, so the position is rebuilt from the
  pieces alone — **en passant** is recovered from the last-move highlight and **castling rights** from the king and
  rook still on their home squares, because without them an ep capture is illegal and nobody can castle in *any*
  puzzle.
- **Play Book Moves** — plays the opening from the Explorer instead of the engine's pick: *weighted-random* among the
  popular replies, so you don't repeat the same line every game. A move needs 20+ games and must rate within 40cp of
  the engine's best, so variety never costs you a worse move. Never delays a move; out of book the engine takes over.
- **Background Play** (off by default) — with it off, moves fire only while the game tab is focused and visible, and a
  move that comes due while you're away is deferred and re-issued when you return. Humans don't play while looking at
  another tab. Turn it on to keep autoplay, premove, the book and the tablebase running in a hidden tab — Chrome
  throttles silent background tabs, so the tab is marked as playing audio and shows a **speaker icon** while this is on.

### Safe Premove

- While the opponent thinks, certifies a reply to their **predicted** move (identical at depth 13, depth 14 and the latest depth).
- Exact predicted move → fires **instantly**; anything else → normal search, so a wrong guess costs nothing.
- Forced moves and true recaptures → queued as a real site premove; an illegal one auto-cancels, so it never fires in the wrong position.
- **Double premove** (chess.com, standard) — when the line is forced *two* moves deep, both replies queue at once. Every branch is forced, so neither can misfire; less than fully forced → a single premove.

### Endgame tablebase

Off by default — **Tablebase** in Quick Settings (hotkey **T**), or **Settings → General → Endgame Tablebase**. With
**7 or fewer pieces** the position is *solved*, so Mephisto asks lichess's Syzygy tables for the perfect move instead
of trusting the search. It outranks both the engine and the book — a solved position has an answer, not a preference —
and the readout says what it found (`— tablebase: win in 13`). Off by default because it sends the position to a third
party; it runs in the service worker, so the page itself makes no request, and it's never awaited.

### Eval history graph

The whole game as a curve under the board, shaped like Lichess's computer-analysis graph: white's advantage above the
midline, black's below, a cursor on the move you're at. It also marks where the **opening ends and the middlegame and
endgame begin**, using Lichess's own division rules (ported from scalachess's `Divider`). A phase is only marked when
it actually happened, so a game that never leaves the opening is labelled once rather than carved into three.

Own toggle under **Eval Bar**, hotkey **Y**. Needs Eval Bar on, since it's drawn alongside it.

### Explain moves

Opt in under **Settings → General → Explain Moves**. Names the tactic behind the engine's choice — a fork, a
promotion, a capture that wins material, mate — on its own line under the evaluation.

Deliberately conservative: only motifs establishable from the position itself. Pins, skewers and discovered attacks
need a judgement this can't make reliably, so they aren't guessed at. When nothing is certain it says nothing — a
confidently wrong explanation teaches the wrong thing.

### Smaller things, and why they're there

- **A board reading is a guess, and says so.** The screen reader maps the image's top-left to a8, so a board shown
  from Black's side comes out rotated — and a rotated position is usually still *legal*, so nothing downstream can
  object. **Flip board** fixes it in one click. It also names its least-confident squares (`least sure: e4 pawn 62%`),
  which is the only warning a misread would otherwise give you.
- **Follow the screen.** After a capture, a **Follow screen** button re-reads the same area twice a second, so a board
  playing there — a video, a stream, another app — keeps the panel in step. An unchanged position never restarts the
  search, and a frame caught mid-animation is skipped rather than analysed.
- **Board/engine mismatch guard.** The board is re-read immediately before every click and the move dropped if the
  position moved on: board and analysis come from independent bits of DOM that a site doesn't update in one paint. A
  scrape that can't be taken at all counts as a mismatch too — unverifiable is not the same as unchanged.
- **Settings apply immediately.** A change on the options page reaches an open panel straight away, and the panel's own
  switches follow. Engine, variant, threads and memory are the exceptions — those need the engine rebuilt.
- **Threads and Hash don't interrupt a search.** UCI forbids changing them mid-search and both tear down engine state,
  so they're applied at the *next* search instead of restarting the panel.
- **Quieter about other people's servers.** The explorer and the tablebase share one rate-limit gate: if either is told
  to back off, both go quiet for as long as lichess asks. A cooldown is invisible — you just don't get a book or
  tablebase answer for that move.
- **Machine calibration.** The shipped defaults are a number, not a measurement: the same 300 ms is a shallow search on
  a laptop and a deep one on a 24-core desktop. Mephisto measures the NPS your machine actually reaches during normal
  play and offers the search time that would hit the reference node count. It suggests; it applies only on a click.

### Pondering

Off by default (**Settings → General → Pondering**). Uses the opponent's think time.

- **Off** — opponent's turn is capped at **two threads** (never more than your Threads setting), so idle waiting isn't a full-core burn. Two rather than one because Premove certification needs depth 14, which a single thread often didn't reach. Your move and analysis-only work always get full threads.
- **On** — opponent's turn searched at **full threads** for their whole think, over their **top 5 candidate replies** (1–2 when forced or a recapture). Pairs with Premove for an instant answer to any of them.
- Abandoned and discarded the moment the position changes, so it never leaks out as your move. Readout shows `Pondering — <side> to play`.

### Humanize

Make automated play look like a real person instead of a flawless engine:

![The move mix and move-quality thresholds, with live accuracy estimates](docs/humanize.png)

- **Move mix** — seven sliders set how often it plays the **top move**, a **2nd / 3rd / 4th line**, an **inaccuracy**, a **mistake**, or a **blunder**.
- **Thresholds** — a separate section sets, in centipawns, how far each may stray, with a **live Lichess accuracy estimate** ([win-% model](https://lichess.org/page/accuracy)) of the win-chance drop. Defaults match Lichess's labels: **110cp = Inaccuracy, 230cp = Mistake, 377cp = Blunder**.
- Sharing to a deep category widens the engine's search so it has such a move to pick; nothing past the blunder threshold is played, and blunders never fire in a decided game. Edits apply next move.
- **Human timing** — quick on obvious moves and openings, long thinks in critical positions, and an **instant
  reflex** *only* for true recaptures (the opponent actually captured, and you take back on that square) and forced
  moves. Snapping off a piece that merely moved in to attack is **not** treated as a reflex — that used to look
  suspiciously fast.
- **Reflex‑aware premove** — with Humanize on, premoves fire instantly only for those same true recaptures / forced
  replies; everything else waits for a natural think time. (With Humanize off, premove keeps full speed.)
- **Coming‑move countdown** — the panel shows what kind of move is coming (top / 2nd / 3rd / 4th / inaccuracy /
  mistake / blunder / instant) and counts down until it's played.

### Clock Mode & Mirror Time

Both also size the engine's search to the time they'll spend, so the wait becomes a deeper move.

- **Clock Mode** — budgets each move off the page clock (~time/30 + 60% of the increment); near-instant when low.
- **Mirror Time** — paces to the *opponent*: their last spend −10%, staying just ahead (haste when behind); falls back to Clock Mode when unknown.
- **Priority** — *Time:* Mirror ▸ Clock ▸ Humanize ▸ Search Time. *Move:* Humanize else engine best. (Also in each tooltip.)

---

### Puzzle database

![3999 — as high as the Lichess puzzle rating goes](docs/puzzle-database.png)

*3999 is the ceiling: there is no higher number Lichess will show you.*

![Hardest (+600) puzzles solved back to back, from the database rather than searched](docs/puzzle-database.gif)

*[The full clip](docs/puzzle-database.mp4) runs a minute and a half at higher quality.*

Puzzle Mode plays a searched move, and a searched move is not always the puzzle's answer — a puzzle has exactly one
line that scores, and an objectively stronger move still fails it. Import Lichess's puzzle database and the panel
looks the position up instead: on a hit the whole solution is known, so it plays it with **no search at all**, move
by move, and the board arrow shows that move rather than an engine guess.

Works on Training, **Storm and Racer**. Lichess only, and it does not even ask anywhere else. The database is built from Lichess games, so a Chess.com or
BlitzTactics position is not in it and never will be — looking one up there would be a guaranteed miss per position,
so those sites skip the lookup entirely and Puzzle Mode falls back to the engine exactly as before.

The file is not bundled — it is about a gigabyte, and the release zip is already large enough. Download
`lichess_db_puzzle.csv.zst` from [database.lichess.org](https://database.lichess.org/#puzzles), decompress it
(`unzstd lichess_db_puzzle.csv.zst` — browsers have no zstd decoder, which is why this one step is yours), then pick
the `.csv` under **Settings → General → Puzzle Database**. It is about six million positions and takes roughly half
an hour to import, once, with a live count as it goes. Nothing is sent anywhere; it is stored in the extension's own
IndexedDB on your machine. If the import is interrupted nothing is lost — run it again and it fills in the rest.

---

## Languages

**Settings → Appearance → Language**, English by default, applied immediately without a reload.

English, Deutsch, Español, Français, Português, Italiano, Nederlands, Polski, Türkçe, Русский, 中文, हिन्दी, 日本語,
한국어 — each listed in its own language, because a list written in English doesn't help someone looking for theirs.

Deliberately **not** Chrome's `chrome.i18n`, which follows the browser's UI locale and gives you no way to override it;
the point here is a language you choose. One flat JSON per language under `src/i18n/locales/`, with English underneath
every other as the fallback, so an untranslated string renders in English rather than blank.

Engine names, board and piece themes, and chess notation are left alone on purpose. The long explanatory tooltips on
the settings page are still English for now.

## Supported sites & modes

![TakeTakeTake, whose board is a WebGPU canvas with no DOM to scrape](docs/taketaketake.png)

| Site | Analysis | Bot play / Autoplay | Premove | Puzzles | Online play | Variants |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Chess.com** | ✅ | ✅ incl. Play Bots | ✅ | ✅ Puzzle Rush / Storm | ✅ | ✅ 3‑Check, King of the Hill, Crazyhouse, Antichess (Giveaway), Atomic, Horde, Racing Kings, **Duck, Minihouse, Seirawan (S‑Chess), Chaturanga** — plus Chess960 |
| **Lichess** | ✅ | ✅ incl. AI & "From Position" | ✅ | ✅ Storm · Racer · Training | ✅ live & correspondence | ✅ Crazyhouse, King of the Hill, Three‑Check, Antichess, Atomic, Horde, Racing Kings — plus Chess960 |
| **TakeTakeTake** | ✅ | ✅ bot games | ✅ | — | ✅ Lichess‑backed | — |
| **BlitzTactics** | ✅ | ✅ | — | ✅ puzzle streams | — | — |
| **ChessBase Tactics** | ✅ | — | — | ✅ Solve / Sprint | — | — |

- **Analysis** — best move(s) drawn on the board, with the eval bar and (optionally) alternative & threat lines.
- **Bot play / Autoplay** — Mephisto plays the engine's move for you, including against the site's computer bots.
- **Online play** — live games against other people; **Puzzles** — Puzzle Mode optimizes for solving speed.
- **Variants** — variant games auto‑detect and switch to Fairy‑Stockfish; Chess960 runs on any mainline Stockfish.

---

## Every setting explained

Everything on the options page (the extension's own tab — right‑click the toolbar icon → **Options**, or the gear in
the panel). The quick‑settings column inside the floating panel is a subset of these and writes to the same storage,
so changing one changes the other. Everything applies to the **next move** without a reload unless noted.

### Settings → General → Engine

| Setting | What it does |
| --- | --- |
| **Engine** | Which engine analyses the position. The in‑browser WebAssembly builds need nothing installed; the "(local, full power)" entries talk to a real engine binary on your machine and only appear once their native host is installed. Switching engine reloads the panel, because the net and the UCI options have to be rebuilt. |
| **Elo** | Caps the engine's playing strength, sent as `UCI_LimitStrength` + `UCI_Elo`. The usable range follows the selected engine (Stockfish dev/18: 1320–3190, Stockfish 11: 1350–2850, Fairy: 500–2850) and out‑of‑range values are ignored rather than clamped. `0` means no cap — full strength. |
| **Variant** | Which chess variant the position is read and analysed as. Variant games are auto‑detected on the page and switch to Fairy‑Stockfish by themselves, so you rarely set this by hand. Chess960 is the exception: every mainline Stockfish plays it via `UCI_Chess960`, so it survives an engine switch. |
| **Search Time (ms)** | How long the engine thinks per move when nothing else is setting the pace. Clock Mode, Mirror Time and Humanize all override it — whichever is enabled first decides the duration. Recaptures and forced moves ignore it entirely and play immediately. |
| **Fallback Poll Interval (ms)** | Position changes are detected instantly and event‑driven; this is only a slow safety net that repairs a missed update. 1000 ms is fine and lowering it buys nothing. |
| **Multiple Lines** | How many candidate lines the engine reports (MultiPV), each drawn as its own coloured arrow. More lines means the search is split across them, so depth drops — 1 is strongest. Humanize raises this automatically when it needs alternatives to choose from. |
| **Threads** | CPU threads the search may use. The default leaves one core for the browser. On the opponent's turn this is capped at 2 unless Pondering is on, so idle time is not a full‑core burn. |
| **Memory** | Transposition‑table size in MB. In‑browser engines are clamped to 512 MB whatever the slider says — that is the WebAssembly heap limit, not a choice — while native engines get the full value. More memory helps long searches and analysis far more than blitz. |
| **Panel Style** | **Floating panel** is the draggable window over the board; it lives in the page, so a site can detect it more easily, and Autoplay and Premove need it. **Toolbar popup** renders in the browser's own chrome and leaves no trace in the page, but it closes when you click the board — analysis only. |

### Settings → General → Analysis

| Setting | What it does |
| --- | --- |
| **Show Computer Evaluation** | Shows the numeric score, depth, nps and the win/draw/loss split under the panel board. Turn it off for a smaller, quieter panel. |
| **Show Threat Analysis** | Draws a red arrow for the opponent's best reply — what they are threatening if you pass. Costs a second search per position. |
| **"Hand & Brain" Mode** | Mephisto plays the *Brain*: it names only the piece **type** to move and you pick the actual move. A training mode — it deliberately withholds the move itself, so Autoplay does nothing while it is on. |

### Settings → General → Autoplay

| Setting | What it does |
| --- | --- |
| **Autoplay** | Plays the engine's move on the site's board for you, by clicking. Everything else in this section that plays a move needs this on. Off means the panel only ever shows you things. |
| **Premove** | While the opponent thinks, the engine certifies a reply to their *predicted* move; if they play exactly that, the answer is instant. Anything else searches normally, and a reply that could never be legal after some other opponent move is queued as a real site premove. On Chess.com, when the line is forced two deep, both of your replies are queued at once. |
| **Pondering** | Keeps searching at full threads during the opponent's turn, across their top five candidate replies, so a deeper answer is ready the moment they move. Off, their turn is still analysed for premove and threat, but capped at 2 threads. Costs CPU continuously — it pairs best with Premove. |
| **Endgame Tablebase** | At 7 pieces or fewer the position is *solved*, so Mephisto asks Lichess's Syzygy tablebase for the perfect move instead of trusting the search. It outranks the engine and the opening book. Off by default because it sends the position to a third party; the lookup never delays a move. |
| **Explain Moves** | Names the tactic behind the engine's move — a fork, a promotion, a capture that wins material, mate — on its own line. Deliberately conservative: pins, skewers and discovered attacks cannot be established from the position alone, so it stays quiet rather than guessing. A confidently wrong explanation teaches the wrong thing. |
| **Hide Opponent Name** | Blurs your opponent's username and avatar so a screenshot or screen share does not expose a real person. Purely cosmetic and local — the site sees nothing different. This is the one option that adds a style element to the page, which is why it is off by default. |
| **Opening Explorer** | Shows how humans actually played this opening (Lichess database): the opening name, the most‑played replies and their win/draw/loss split, plus coloured arrows on the board. Read‑out only — it never changes which move is played. Standard chess only, and it stops once the game leaves book. |
| **Play Book Moves** | Plays the opening from the database instead of the engine's pick, weighted‑random among the popular replies — an engine that always plays the same first move is itself a tell. A candidate needs at least 20 games and must rate within 40 cp of the engine's best, so variety never costs you a worse move. If the lookup is late the engine's move is played; it never delays a move. |
| **Opening Database** | Which games the book data comes from. *Masters* is the cleanest opening play; the Lichess sets are ordinary online games and look more like a normal opponent. Pick the club band to match a typical rating pool. |
| **Background Play** | Off, moves only fire while the tab is focused and visible — a human does not play while tabbed away, and a move that comes due meanwhile is re‑issued when you return. On keeps Autoplay and Premove running in a hidden tab. Chrome throttles silent background tabs, so keeping one alive marks it as playing audio and the tab shows a speaker icon. |
| **Help Mode** | Draws the analysis arrows on the site's own board and plays nothing — you make the move yourself. Overrides Autoplay while it is on. This is the mode to use if you want the engine's opinion without it touching the board. |
| **Humanize** | Plays like a person rather than an engine: instant recaptures, quick obvious moves, long thinks in critical positions, and occasionally a second‑best move, a mistake or a blunder. The mix and the thresholds are yours to set below. It changes both *which* move is played and *how long* it takes. |
| **Clock Mode** | Reads the game clock off the page and budgets each move to it — roughly time/30 plus 60% of the increment, shrinking the engine search to match, and near‑instant when short on time. It sets the pace, not the move. |
| **Mirror Time** | Paces to the opponent instead: spend what they spent on their last move minus 10%, so you stay just ahead on the clock, with 30% extra haste when behind. Falls back to the Clock Mode budget when their spend is unknown. Outranks Clock Mode when both are on. |
| **Manual Mode** | The engine thinks indefinitely and plays nothing until *you* press the play‑move hotkey (Spacebar by default). Your own timing — it overrides Clock/Mirror/Humanize and never fires on its own. |
| **Opponent Mistake Alert** | Flashes a small toast over the board when your **opponent** plays an inaccuracy, mistake or blunder, judged by the same Lichess win% method the move mix uses. It only fires when both positions were searched deep enough to trust, so it will not invent blunders from shallow evals. |
| **Puzzle Mode** | Optimizes for solving puzzles fast rather than perfectly: one searched move at a time, and the opponent's scripted reply is not analysed at all. Turns itself on when you open a puzzle page on Lichess or Chess.com and back off when you leave — unless you set it yourself, which is never overridden. |
| **Puzzle Database** | Loads Lichess's puzzle database so Puzzle Mode plays the *known* solution instead of the engine's guess — the engine's best move and the puzzle's intended move are not always the same, and only one of them scores. Lichess only; Chess.com's Puzzle Rush positions are not in that file. It is not bundled (about a gigabyte), so you download and import it yourself, and it never leaves your machine — see [Puzzle database](#puzzle-database) below. |
| **Python Backend** | Moves the mouse pointer for real via a local Python helper instead of synthesising clicks in the page. Needs `mephisto-clicker.py` running and PyAutoGUI permissions granted. Almost nobody needs this — the built‑in click path is better in every way that matters. |

### Settings → General → Humanize tuning

Only relevant when **Humanize** is on. All of it applies to the very next move — no reload.

| Setting | What it does |
| --- | --- |
| **Humanize Move Mix (%)** | How often each quality of move is played, across seven categories from *Top move* down to *Blunders*. They must add up to 100; the Total row tells you what to add or remove. Giving any share to *Third line* or worse forces a wider search so a move that bad exists to pick — which costs depth, so a pure Top + Second mix stays cheaper. |
| **Move‑Quality Thresholds (cp)** | How much worse than the best move each category may be, in centipawns (100 cp = 1 pawn). Each value is the *top* of its band and the category above it is the bottom, so the bands tile without gaps. The defaults sit exactly on Lichess's own win‑drop boundaries — ~10% inaccuracy, ~20% mistake, ~30% blunder. |
| **Simulated Think Time (ms)** | The minimum wall‑clock delay after the position is fully evaluated before the move is played. This is the floor, not the total. |
| **Simulated Think Time Variance (ms)** | A random extra delay on top of Simulated Think Time, up to this much. Constant, identical timing is itself a tell — this is what breaks it up. |
| **Simulated Move Time (ms)** | How long the mouse actions of a single move take, from the first click to the last. Promotions get a third leg and are budgeted accordingly. |
| **Simulated Move Time Variance (ms)** | A random extra amount on top of Simulated Move Time, same idea as the think‑time variance. |

### Settings → General → Hotkeys

| Setting | What it does |
| --- | --- |
| **Hotkeys** | One rebindable key per action, live while you are on the game page and the floating panel is open. Click a key and the next key you press becomes the binding — **Esc** cancels, **Backspace/Delete** clears it. Defaults are single letters (the play‑move key is Spacebar); if one clashes with a shortcut the site itself uses, rebind it with any Ctrl/Alt/Shift/Meta combination. |

### Settings → General → buttons

| Button | What it does |
| --- | --- |
| **Restore Defaults** | Resets every setting on this page to its shipped default. It does not touch the puzzle database or your hotkeys. |
| **Export Settings** | Writes every setting, including hotkeys and the humanize tuning, to a JSON file. |
| **Import Settings** | Reads one back. Values that no longer exist are ignored rather than restored. |

### Settings → Appearance

| Setting | What it does |
| --- | --- |
| **Pieces** | The piece set drawn on the panel's own board. Purely cosmetic and panel‑only — the site's board is never restyled. |
| **Board** | The board colours for the panel's board, same idea. Both are previewed in the dropdown. |
| **Coordinates** | Shows file letters and rank numbers around the panel board. |
| **Dark Mode** | Dark theme for the panel and for this settings page. |
| **Language** | The language of the panel and these settings. English is the default; fourteen languages ship, each listed in its own language, and switching applies immediately without a reload. Engine names, board themes and chess notation deliberately stay as they are — see [Languages](#languages). |

---

## Page footprint

### Panel Style — pick your footprint (Settings → General → **Panel Style**)

Two ways to show the panel:

- **Floating panel** (default) — the draggable window over the board. Richer UX, but it's injected into the web
  page, so a chess site can detect it more easily.
- **Toolbar popup** — the classic bubble anchored to the browser toolbar. It renders in the browser's own chrome,
  so the page has **no handle to it at all — zero page footprint**. This is the **safer** mode.

**To switch to the safe mode:** open **Settings** (the extension's options page) → **General** → **Panel Style** →
choose **"Toolbar popup (safer — no page footprint)"**. It takes effect immediately (any open floating panel is
closed for you).

> **Note:** the toolbar popup closes the moment you click the board, so it's best for **analysis** (glance at the best
> move). **Autoplay and Premove work only with the Floating panel**, which stays open during the game.

### While the floating panel is in use, its footprint is minimized:

- **No iframe.** The floating panel used to be an extension‑page `<iframe>`, and an iframe is a *browsing context* — it
  is counted by `window.length` and throws on cross‑origin access, which a closed shadow root cannot hide. **The panel
  no longer uses one at all:** it renders directly in the page's isolated world, and the WASM engine moved to an
  **offscreen document** (an invisible extension page that still gets the cross‑origin isolation / SharedArrayBuffer
  the pthread engine builds need, but that the page cannot see or count).
- **No extension URLs reach the page.** `web_accessible_resources` is gone from the manifest, so nothing can probe for
  a known file. The panel's markup, CSS, board textures and piece images are fetched extension‑side and injected as
  inlined bytes / `data:` URIs — so no `chrome-extension://` URL appears in the DOM **or in the page's Resource
  Timing**, and the extension id can't be read back.
- **Panel in a closed shadow root** — the panel lives inside a `mode: "closed"` shadow root under one attribute‑less
  host node. The page can't enumerate it: `document.querySelector('[id^="mephisto-"]')` finds nothing and
  `host.shadowRoot` is `null`.
- **No branded page globals** — the MAIN‑world probes used on canvas/proprietary boards (TakeTakeTake, ChessBase) set
  **no** `window.*` flag and talk over **per‑session random** event channels, so a page has no fixed global or event
  name to fingerprint (just a single rendezvous).
- **Human‑shaped clicks** — a move is a bare *from → to*, exactly like a human plays it: no lead click on an empty
  square, and the timings are randomized. Clicks land on a center‑weighted distribution within each square, via
  trusted input (`isTrusted` cannot distinguish them from real clicks).
- **No config in the site's storage** — settings live in `chrome.storage.local`, never the page's `localStorage`.
  Two values do sit in the page's storage, because they're read while the panel is being built: the panel's
  position/size and a cache of game start positions. Neither is named after the extension and neither holds a
  setting, so there's no key to grep for.
- **Background Play → Off** (default) — moves only fire while the tab is focused and visible, so there's no
  "moved while tabbed away" anomaly.

(These reduce passive fingerprinting; engine use in a live game still breaks most sites' fair‑play rules — use
responsibly. Note that the signal that actually catches engine use is server‑side behavioural analysis, not DOM
footprint. See the [disclaimer](#️-read-this-first--disclaimer--fair-play).)

---

## Roadmap

No schedule — added whenever I feel like it. Everything shipped is under **Implemented** below.

**Engines & analysis**
- [ ] **Cloud evaluation** — ask Lichess's cloud-eval API for a position instead of searching it. Instant deep
  evaluations for positions already analysed (most openings), nothing for the rest. Would slot in beside the tablebase:
  optional, outranks the local search when it has an answer, never delays a move. Off by default — it leaves your machine.
- [ ] **More engines** — the lineup is Stockfish, Fairy and the two Maia families, which covers *strong* and
  *human-like* and not much between. Variety of character, not more strength.
- [ ] **lc0 (Leela) in the browser** — a WASM alternative to Stockfish. Large download, not stronger; for comparing styles.

**Variants & packaging**
- [ ] **Duck Chess autoplay polish** — make the duck-placement step work end to end (detection and analysis already do).

**Interface & docs**
- [ ] **Rework the UI** — the panel grew a control at a time and it shows: twenty-odd quick-settings rows in one
  scrolling column, no grouping, no sense of which matter most. Wants a layout pass, not another row bolted on.
- [ ] **Rewrite the README** — still organised around the order things were built rather than around the reader. Should
  come before the translation, or the translation multiplies the problem by fourteen.
- [ ] **More screenshots** — most features here are visual and described in prose. The eval graph, the explorer
  overlay, the board reader and the settings page would each be clearer as a picture.
- [ ] **Explain things better** — lead with *what problem this solves* before the mechanism, especially for the options
  that sound alike (Clock Mode vs Mirror Time vs Humanize, Premove vs Pondering).
- [ ] **A few short videos** — some of this only makes sense in motion: a premove firing, Humanize pacing a move, the
  screen reader following a board. Thirty seconds each.
- [ ] **Translate the README** — the interface speaks fourteen languages ([Languages](#languages)); the documentation
  speaks one. The long help tooltips are in the same position.

**Footprint**
- [ ] **Shrink the page footprint further** — keep reducing what a site can passively detect. The list under
  [Page footprint](#page-footprint) is most of the way there; what's left is hardening the one rendezvous the
  MAIN-world probes still need, and tightening how scraped positions are sanitised.
  **Being straight about the ceiling:** this is passive fingerprinting only, and the client side is nearly exhausted.
  What actually catches engine use is server-side behavioural analysis — move-match rates and timing distributions that
  look nothing like a person's. Humanize, Clock Mode and Mirror Time are the levers that touch *that*. Nothing here
  makes the extension undetectable; see the [disclaimer](#️-read-this-first--disclaimer--fair-play).

**Robustness**
- [ ] **Bug fixes** — open-ended, deliberately. Several of the sharpest bugs so far were invisible rather than loud:
  autoplay that skipped a move with nothing logged, an engine that never loaded, a veto inverted only for Black.
  Reports of *"it did nothing"* are worth more than they sound.
- [ ] **ChessBase Tactics: on-board arrows + autoplay** — analysis works; drawing and clicking do not. ChessBase renders
  its own board with no class to match, and finding it by shape was slow and unreliable. Needs the real markup.

**Anything else**
- [ ] **Whatever you want it to do** — most of what's here arrived because something was annoying in a real game, not
  because it was planned. Open an issue; small ideas are usually the ones that land.

More to come.

### Blocked upstream

Not waiting on work here — no engine supports these, so there is nothing to build against yet.

- [ ] **Fog of War** — imperfect information; a normal engine cannot play it at all.
- [ ] **Setup Chess · Spell Chess** — need engine support that doesn't exist.
- [ ] **4-player** (4PC, Chaturaji, 4P Giveaway, Self Partnering) — no engine supports four-player boards.
- [ ] **Bughouse / Doubles · Chess with Checkers** — two-board and hybrid variants; no engine support.

---

## Implemented

Shipped and in the current build.

- [x] **Maia-3** (v3.1.95, 23M model in v3.1.96) — **Engine → Maia-3** plus a **600–2600** Elo slider. A
  [transformer trained on human games](https://github.com/CSSLab/maia3) and conditioned on rating, so one model covers
  the whole range and sliding changes strength instantly. One in-browser ONNX pass per move; reproduces the CSSLab
  reference exactly (~60% move-match to real human play).
- [x] **Maia** (v3.1.93) — **Engine → Maia** and a rating band (**1100–1900**, plus a community-trained **2200**).
  The [Maia](https://maiachess.com/) nets, trained on human games — human-like mistakes, not a strong engine told to
  play badly. In-browser ONNX; matches the lc0 reference.
- [x] **Pondering** (v3.1.107) — think on the opponent's clock, at full threads over their top 5 replies. With it off,
  the opponent's turn is capped at two threads, so idle waiting costs *less* than it used to.
- [x] **Opening Explorer + book play** (v3.1.119) — human opening data, coloured arrows, and optional weighted-random
  book moves with a 20-game floor and a 40cp engine check.
- [x] **Read a position off the screen** (v3.1.124) — camera button; any site, two ONNX models, entirely local.
- [x] **Playable panel board** (v3.1.124) — click or drag to walk a line, with underpromotion.
- [x] **Set up a position** (v3.1.119) — paste a FEN to analyse anything instead of the page.
- [x] **Setup / From-Position capture** (v3.1.125) — a custom-start game reads correctly even when loaded mid-game.
- [x] **On-demand nets** (v3.1.125) — an unbundled net downloads on first use and caches; a full install still works offline.
- [x] **Auto-recover on DOM changes** (v3.1.119) — if a site renames its move-list tags, the move list is found structurally.
- [x] **Double premove** (v3.1.107) — chess.com, standard chess: when the line is forced two moves deep, both replies queue at once.
- [x] **Instant reopen, warm engine** (v3.1.92) — closing the panel stops the search but keeps the engine loaded; an
  unchanged reopen skips all setup.
- [x] **Turn switch** (v3.1.92) — king-glyph toggle at the top of the panel; sticky per position, auto-tracks each move.
- [x] **Human cursor travel** (v3.1.90) — every synthetic click is preceded by an eased, jittered pointer path, inside
  the Move Time budget.
- [x] **Manual mode** (v3.1.84) — the engine thinks until you press **Space**.
- [x] **Configurable hotkeys** (v3.1.84) — **Settings → Hotkeys**; each toggle shows its key, carried in export/import.

  ![The hotkeys page, each action rebindable](docs/hotkeys.png)

- [x] **Opponent Mistake Alert** (v3.1.84) — opt-in toast for the opponent's inaccuracy/mistake/blunder (Lichess win%, depth-gated).
- [x] **Self-test button** (v3.1.84) — checks scraping, the engine and the native host.
- [x] **Copy FEN / Copy PGN · compact panel · export/import settings** (v3.1.73) — position or whole game to the
  clipboard; **▣** collapses the panel; the whole config as a JSON file.
- [x] **Native-engine health badge · smart default threads** (v3.1.55) — a dot showing whether the native host
  answered; new installs default to cores − 1 (capped at 24).
- [x] **Faster response** (v3.1.91) — no "Calculating…" placeholder; the real eval streams from depth 1.

## Contributing

Ideas, bug reports, and PRs are all welcome — open an issue or a pull request.

## License & credits

**Board recognition** uses two models from [Chess_diagram_to_FEN](https://github.com/tsoj/Chess_diagram_to_FEN)
by Jost Triller (MIT), converted to ONNX — see `lib/engine/vision/` for the licence and details.

This project's own source code (and the original [Mephisto](https://github.com/AlexPetrusca/Mephisto)
by Alexandru Petrusca) is under the **MIT License** ([`LICENSE`](LICENSE)). But it **bundles copyleft
components** — GPL-3.0 engines and nets, and the **AGPL-3.0** Maia-3 model — so the **combined
distribution is governed by AGPL-3.0**. Before redistributing, please read [`LICENSING.md`](LICENSING.md)
and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md); the full texts are in [`licenses/`](licenses/).

Built on the work of others, with thanks:

- **[Stockfish](https://github.com/official-stockfish/Stockfish)** & **[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish)** (GPL-3.0) — the analysis engines, run in the browser via the [Lichess Stockfish-web](https://github.com/lichess-org) builds.
- **[Maia](https://github.com/CSSLab/maia-chess) / [Maia-3](https://github.com/CSSLab/maia3)** (CSSLab, University of Toronto; GPL-3.0 / AGPL-3.0) and the **[Maia 2200](https://github.com/CallOn84/LeelaNets)** net (CallOn84; GPL-3.0) — the human-like networks; **[Leela Chess Zero](https://github.com/LeelaChessZero/lc0)** (GPL-3.0) for the input/policy encoding.
- **[ONNX Runtime Web](https://github.com/microsoft/onnxruntime)** (Microsoft; MIT) — in-browser neural-net inference.
- **[chess.js](https://github.com/jhlywa/chess.js)** (BSD-2), **[chessboard.js](https://github.com/oakmac/chessboardjs)**, **[jQuery](https://jquery.com)**, **[Materialize](https://materializecss.com)**, and `lru` (all MIT).
