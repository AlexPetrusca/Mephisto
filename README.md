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
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
(A binary downloaded from the web is quarantined by Gatekeeper — the installer clears that for its copy.
If you point at one yourself, `chmod +x` it and, if macOS blocks it, `xattr -d com.apple.quarantine <path>`.)

### Linux
```bash
sudo apt install stockfish          # Debian/Ubuntu; or your distro's package / a release binary
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
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

- **Multiple lines** — show the top 1–5 candidate moves (MultiPV), each drawn on the board with its evaluation.

  ![Three candidate lines, each with its own coloured arrow](docs/multiple-lines.png)

- **Show computer evaluation** — display the numeric score / eval bar (turn off for a cleaner board).
- **Eval bar** — a chess.com‑style vertical bar beside the board, from your perspective, with the score inside it.
- **Threat analysis** — also show the opponent's strongest reply, so you can see what they're threatening.
- **Search time** — how long the engine thinks per move (also the ceiling for continuous analysis).
- **Threads / Memory** — tune engine strength vs. resource use.
- **"Hand & Brain" mode** — Mephisto plays the *Brain* (tells you which piece type to move); you play the *Hand*
  (choose the actual move).
- **Continuous analysis** — with Autoplay off, the engine keeps analyzing indefinitely instead of stopping after
  the search time.
- **Read a position off the screen** — the camera button captures the tab, finds the board and loads it. Works on any site (a video, a diagram, an image); drag a box around the board if auto-detection misses. Runs locally — nothing is uploaded.

  ![Reading a position straight off a YouTube video](docs/read-from-screen.png)

- **Playable panel board** — click or drag pieces on the panel's board to walk a line (with underpromotion). Re-detect goes back to the live game.
  ![The opening explorer, with each book move drawn on the board](docs/opening-explorer.png)

- **Opening Explorer** — shows how humans played the opening (Lichess database): the opening name, the most-played
  replies with their win/draw/loss split, and coloured arrows on the board. Pick the database — Masters, all
  Lichess games, or a club rating band. Read-out only; standard chess. See **Play Book Moves** below to actually
  play from it.

---

## Automated play

- **Autoplay** — Mephisto plays the engine's move for you automatically.
- **Help Mode** — instead of autoplaying, all analysis arrows are mirrored onto the site's board while the engine
  keeps evaluating; you play the move yourself when ready. Overrides Autoplay while on.
- **Puzzle Mode** — optimizes for solving puzzles as fast as possible (Puzzle Rush / Puzzle Storm).
  Every move it plays is a move it actually searched, and it never analyses the opponent's turn.
  A chess.com puzzle page ships no move list, so the position has to be rebuilt from the pieces alone
  — which loses everything that isn't a piece on a square. Both are recovered from the board:
  **en passant** from the last-move highlight, and **castling rights** from the king and rook still
  standing on their home squares. Without them an ep capture is illegal and neither side can castle in
  *any* puzzle, so the engine evaluates a position that isn't the one on screen.
- **Play Book Moves** — plays the opening from the Opening Explorer instead of the engine's pick: a
  *weighted-random* choice among the popular replies, so you don't repeat the same line every game. A move must
  appear in at least 20 games and rate within 40cp of the engine's best, so the variety never costs you a worse
  move. The lookup runs in the background and never delays a move; out of book, the engine takes over. Needs Autoplay.
- **Background Play** (off by default) — with it off, moves only fire while the game tab is **focused and visible**;
  a move that comes due while you're tabbed away is deferred until you come back — and is re-issued as soon as you
  do, rather than leaving the tab sitting there. Humans don't play while looking at another tab. Turn it on to keep
  autoplay, premove, the opening book and the tablebase probe running while the tab is hidden. One caveat worth
  knowing: Chrome throttles timers in a silent background tab after a few minutes, so keeping one alive means marking
  it as playing audio — the tab shows a **speaker icon** while this is on. That only happens when Background Play is
  actually enabled.

### Safe Premove

- While the opponent thinks, certifies a reply to their **predicted** move (stable at depth 6 / 9 / 10+).
- Exact predicted move → fires **instantly**; anything else → normal search, so a wrong guess costs nothing.
- Forced moves and true recaptures → queued as a real site premove; an illegal one auto-cancels, so it never fires in the wrong position.
- **Double premove** (chess.com, standard) — when the line is forced *two* moves deep, both replies queue at once. Every branch is forced, so neither can misfire; less than fully forced → a single premove.

### Settings apply immediately

A setting changed on the options page now reaches an open panel straight away — no reload. The panel's
own switches update to match, and the change reaches the page for the very next move. Engine, variant,
threads and memory are the exceptions: those need the engine rebuilt, so they still reload the panel.

### Endgame tablebase

Off by default — **Tablebase** in the panel's Quick Settings (hotkey **T**), or **Settings → General → Endgame Tablebase**. With **7 or fewer pieces** on the board the position is
*solved*, so Mephisto asks lichess's Syzygy tables for the perfect move rather than trusting the search.

- Outranks both the engine and the opening book — a solved position has an answer, not a preference.
- The readout says what it found: `— tablebase: win in 13`, `— tablebase: draw`.
- Off by default because it sends the position to a third party. The tables are hundreds of gigabytes, so a network
  probe is the only shippable form; it runs in the service worker, so the page itself makes no request.
- Never awaited — if the answer is late the engine's move is played and the probe is skipped for that move.

### Move confidence

The panel says how much better the best move is than the second, not just what it is — `· clearly best (+3.7)`,
`· +0.35 over #2`, `· several equal`, or `· only move` when there is genuinely one legal reply. "Only move" and
"six moves are all fine" are completely different situations that used to render identically. Read off the MultiPV
lines already on screen; it needs no extra search, and stays silent at **Multi Lines = 1** rather than widening one.

### Eval history graph

The **whole game so far** as a curve under the board, in the shape of Lichess's computer-analysis graph: white's
advantage above the midline, black's below, the area between filled, and a cursor on the move you're at. Swings and the
move it turned on are visible without scrubbing the move list.

It also marks where the **opening ends and the middlegame and endgame begin**, using Lichess's own division rules
(ported from scalachess's `Divider`): the middlegame starts at the first position with 10 or fewer major and minor
pieces, *or* a back rank down to fewer than four pieces, *or* a piece-mixing score above 150; the endgame starts at the
first position with 6 or fewer. A phase only gets a divider when it actually happened, so a game that never leaves the
opening is labelled once rather than carved into three.

Its own toggle directly under **Eval Bar** in Quick Settings, with hotkey **Y**. A takeback truncates it; a new game
clears it. Needs Eval Bar on, since it's drawn alongside it.

### Blunder guard

Autoplay refuses to click a move that drops a piece *while the engine reads the position as fine*. Those two statements
can't both be true of the same board — but they're routine when the panel has analysed a stale or mis-scraped position,
which is how every scraping bug so far has presented. Deliberately not a general blunder filter: real sacrifices go
through, and a already-losing position is exempt entirely. Tablebase moves are exempt too, being proven optimal.

The board is also re-read immediately before every click and the move dropped if the position changed since the search
started — the board and the analysis come from independent bits of DOM that a site doesn't update in one paint.

### Machine calibration

The shipped defaults are a number, not a measurement: the same 300 ms is a shallow search on a laptop and a deep one on
a 24-core desktop, so "the defaults" mean different playing strengths on different machines. Equal *nodes* travel; equal
milliseconds don't. Mephisto measures the NPS your machine actually reaches during normal play — no separate benchmark —
and once it has a stable reading offers the search time that would hit the reference node count. It **suggests**, and
applies only on a click, once per install.

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

## Supported sites & modes

![TakeTakeTake, whose board is a WebGPU canvas with no DOM to scrape](docs/taketaketake.png)

| Site | Analysis | Bot play / Autoplay | Premove | Puzzles | Online play | Variants |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Chess.com** | ✅ | ✅ incl. Play Bots | ✅ | ✅ Puzzle Rush / Storm | ✅ | ✅ 3‑Check, King of the Hill, Crazyhouse, Antichess (Giveaway), Atomic, Horde, Racing Kings, **Duck, Minihouse, Seirawan (S‑Chess), Chaturanga** — plus Chess960 |
| **Lichess** | ✅ | ✅ incl. AI & "From Position" | ✅ | ✅ Puzzle Storm | ✅ live & correspondence | ✅ Crazyhouse, King of the Hill, Three‑Check, Antichess, Atomic, Horde, Racing Kings — plus Chess960 |
| **TakeTakeTake** | ✅ | ✅ bot games | ✅ | — | ✅ Lichess‑backed | — |
| **BlitzTactics** | ✅ | ✅ | — | ✅ puzzle streams | — | — |
| **ChessBase Tactics** | ✅ | — | — | ✅ Solve / Sprint | — | — |

- **Analysis** — best move(s) drawn on the board, with the eval bar and (optionally) alternative & threat lines.
- **Bot play / Autoplay** — Mephisto plays the engine's move for you, including against the site's computer bots.
- **Online play** — live games against other people; **Puzzles** — Puzzle Mode optimizes for solving speed.
- **Variants** — variant games auto‑detect and switch to Fairy‑Stockfish; Chess960 runs on any mainline Stockfish.

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
- **No config in the site's storage** — settings live in `chrome.storage.local`, never the page's `localStorage`, so
  the site can't read the extension's keys.
- **Background Play → Off** (default) — moves only fire while the tab is focused and visible, so there's no
  "moved while tabbed away" anomaly.

(These reduce passive fingerprinting; engine use in a live game still breaks most sites' fair‑play rules — use
responsibly. Note that the signal that actually catches engine use is server‑side behavioural analysis, not DOM
footprint. See the [disclaimer](#️-read-this-first--disclaimer--fair-play).)

---

## Roadmap

No schedule — added whenever I feel like it. Only the not-yet-built items live here; everything shipped is under
**Implemented** below.

**Engines & analysis**
- [ ] **lc0 (Leela) in the browser** — Leela's neural-net engine as a WASM alternative to Stockfish. A large
  download for play that isn't stronger; mainly for comparing styles.

**Variants & packaging**
- [ ] **Duck Chess autoplay polish** — make the duck-placement step work end to end (detection and analysis already do).

**Robustness**
- [ ] **ChessBase Tactics: on-board arrows + autoplay** — analysis works; drawing on the board and clicking it
  do not. ChessBase renders its own board with no class to match, and finding it by shape was both slow (the
  search runs on hot paths) and unreliable. Needs the real markup to anchor on.

### Blocked upstream

Not waiting on work here — no engine supports these, so there is nothing to build against yet.

- [ ] **Fog of War** — imperfect information; a normal engine cannot play it at all.
- [ ] **Setup Chess · Spell Chess** — need engine support that doesn't exist.
- [ ] **4-player** (4PC, Chaturaji, 4P Giveaway, Self Partnering) — no engine supports four-player boards.
- [ ] **Bughouse / Doubles · Chess with Checkers** — two-board and hybrid variants; no engine support.

---

## Implemented

Shipped and in the current build.

- [x] **Maia-3 (human-like play)** (v3.1.95, upgraded to the 23M model in v3.1.96) — pick **Engine → Maia-3** and set a **target Elo (600–2600)** with the slider. This is [Maia-3](https://github.com/CSSLab/maia3), a transformer trained on human games and conditioned on rating — one model, so sliding the Elo changes strength instantly (no reload). Runs entirely in the browser as a single ONNX forward pass per move (onnxruntime-web, no server); its moves reproduce the CSSLab Maia-3 reference exactly. Ships the **23M-parameter** variant (~60% move-match to real human play, measured on rated games — a few points above the smaller 5M net). Multi Lines shows the top human-likely candidates.
- [x] **Maia (human-like play)** (v3.1.93) — pick **Engine → Maia** and a rating band (**1100–1900**, plus a community-trained **2200**). These are the [Maia](https://maiachess.com/) neural nets trained on real human games, so they play like a human of that rating — human-like mistakes, not a strong engine told to play badly. Runs entirely in the browser as a single ONNX forward pass per move (onnxruntime-web, no lc0, no server); moves match the lc0 reference implementation. Changing the band loads a different net. (The 2200 net is [@CallOn84](https://github.com/CallOn84/LeelaNets)'s Maia-architecture net; 1100–1900 are the original CSSLab Maia-1 nets.)
- [x] **Copy FEN / Copy PGN** (v3.1.73) — buttons that copy the position, or the whole game (with `SetUp`/`FEN` tags for a custom start).
- [x] **Compact / expanded panel** (v3.1.73) — the **▣** title-bar button collapses the panel to the move + score; remembered.
- [x] **Export / import settings** (v3.1.73) — **Settings → General** writes/loads the whole config as a JSON file.
- [x] **Native-engine health badge** (v3.1.55) — a dot showing whether the native host answered (hidden for WASM engines).
- [x] **Smart default threads** (v3.1.55) — new installs default to your CPU's cores − 1 (capped at 24).
- [x] **Graceful "unsupported variant" message** (v3.1.73) — says so instead of analysing the wrong position.
- [x] **Manual mode** (v3.1.84) — the engine thinks until you press the play-move key (**Space**), then plays its best move.
- [x] **Configurable hotkeys** (v3.1.84) — **Settings → Hotkeys**; single-letter defaults, each toggle shows its key, carried in export/import.

  ![The hotkeys page, each action rebindable](docs/hotkeys.png)

- [x] **Opponent Mistake Alert** (v3.1.84) (the roadmap's *Blunder alert*) — opt-in toast over the board for the opponent's inaccuracy/mistake/blunder (Lichess win%, depth-gated).
- [x] **Self-test button** (v3.1.84) — beside Re-detect; checks scraping, the engine, and the native host.
- [x] **Human cursor travel** (v3.1.90) — every synthetic click is preceded by an eased, jittered `mouseMoved` path from the cursor's last position; travel time consumes the Move Time budget so the whole click sequence fits inside whatever number you set.
- [x] **Faster response** (v3.1.91) — no "Calculating…" placeholder; the panel shows only the progress bar until the first `info depth 1` line arrives (~a few ms), then streams the real eval, move and best-line from depth 1 onward.
- [x] **Turn switch** (v3.1.92) — a small king-glyph toggle at the top of the panel (replacing the "Quick Settings" title) shows the side to move and flips it on tap. Sticky per position so you can switch back and forth, auto-tracks each move, and resets on close. Replaces the earlier on-board pill + Auto/White/Black dropdown.
- [x] **Pondering** (v3.1.107) — the roadmap's *Ponder / background analysis*. Opt in under **Settings → General → Pondering**: the opponent's turn is then searched at full threads for their *whole* think, across their **top 5 candidate replies** (narrowing to 1–2 when the position is forced or a recapture), so a deeper answer is ready the moment they move — and Premove can certify an instant reply to any of those five. The roadmap's CPU/battery cost is handled by the default rather than ignored: with Pondering **off**, the opponent's turn is capped at **two threads** (never above your Threads setting), so idle waiting now costs *less* than it used to, not more. Your own move always gets the full thread count, and analysis-only work is never throttled. Works with the in-browser and native Stockfish/Fairy builds and the remote engine; Maia is a single forward pass and can't deepen, so it's excluded.
- [x] **Opening Explorer** (v3.1.119) — **Settings → General → Opening Explorer**, or the **Explorer** toggle in the panel. Shows how humans played the opening: the opening name, the most-played replies with their win/draw/loss split, and coloured arrows on the board. Turn on **Play Book Moves** to play a *weighted-random* book move instead of the engine's pick — so you don't repeat the same line every game — with a 20-game floor and an engine check (within 40cp of best) so the variety never costs you a worse move. Pick the **Opening Database** (Masters / all Lichess / club 1600–2200). The lookup runs in the background and never delays a move; standard chess only.
- [x] **Set up a position** (v3.1.119) — grid button in the panel row: paste a **FEN** to analyse any position instead of the page. Stops following the page while set; click again (or Re-detect) to go back.
- [x] **Setup / From-Position capture** (v3.1.125) — a game that started from a custom position is read correctly even when you load it mid-game. The start is recovered from the page rather than only being captured at move 0, so a refresh no longer replays the game from the standard start.
- [x] **On-demand nets** (v3.1.125) — a net that isn't bundled is downloaded on first use from the Stockfish project's own net server and cached permanently, so a build can ship without the large nets. Anything already bundled is used as-is and never fetched: a full install behaves exactly as before and still works offline.
- [x] **Read a position off the screen** (v3.1.124) — the roadmap's *Board from a screenshot*. The camera button captures the tab, finds the board and loads it into the panel. Works on **any site** — a YouTube video, a diagram, a screenshot — not just chess sites. If auto-detection misses, drag a box around the board. Runs entirely on your machine (two ONNX models, no upload).
- [x] **Playable panel board** (v3.1.124) — click or drag pieces on the panel's own board to walk a line, with an underpromotion picker. The panel stops following the page while you do; Re-detect returns to the live game.
- [x] **Auto-recover on DOM changes** (v3.1.119) — if a site renames its move-list tags, Mephisto finds the move list structurally instead of silently seeing nothing.
- [x] **Double premove** (v3.1.107) — on chess.com (standard chess), when the line is forced two moves deep, both of your replies are queued at once instead of one at a time. Every branch in that chain is forced, so neither queued move can fire in a position it wasn't meant for; anything less falls back to a single premove.
- [x] **Instant reopen, warm engine** (v3.1.92) — closing the panel with X stops the search (frees CPU) but keeps the engine loaded, so reopening is instant instead of reloading the neural net. A fingerprint of the engine settings means an unchanged reopen skips *all* setup (no net reload, no `ucinewgame` hash clear); a settings change reconfigures without reloading. A real tab close still frees the engine.

---

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
