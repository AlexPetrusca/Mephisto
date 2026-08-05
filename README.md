![Mephisto](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

**Real-time chess analysis and automated play on Chess.com, Lichess, BlitzTactics, TakeTakeTake and ChessBase
Tactics.** Mephisto reads the position straight off the page, runs **Stockfish** (NNUE), **Fairy-Stockfish** or
**Maia** entirely in your browser — no server, no account — and draws the best move on the board, or plays it for you
with timing and move choices tuned to look human.

Click the toolbar icon to toggle a floating panel over the board. Unlike a normal extension popup it stays open while
you click and play, so analysis and autoplay keep running for the whole game.

![Analysis with five candidate lines drawn on the board](docs/analysis-lines.png)

[Fair play](#fair-play--read-this-first) · [Install](#install) · [Engines](#engines) · [Features](#features) ·
[Sites](#supported-sites) · [Settings](#settings-reference) · [Footprint](#page-footprint) · [Roadmap](#roadmap)

---

## Fair play — read this first

**Using this in a live game against another person violates the Terms of Service of every chess site.** Account
closures are typically permanent, applied at the device and payment level (so your other accounts go too), and
ratings, prizes and tournament results get rolled back.

**This extension cannot make you undetectable.** What catches engine users is server-side and behavioural: move
agreement measured over many games, think-time distributions that look nothing like a person's, accuracy that doesn't
fit your rating history. Those are statistical and aggregated across your account — they don't care what your DOM
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
Petrusca](https://github.com/AlexPetrusca/Mephisto). Installed from upstream today it detects nothing — the 2026
Chess.com and Lichess redesigns broke every scraper. This fork revives it and goes well past it. Everything the
original did still works.

New here:

- **Engines** — modern **Stockfish dev / 18**, the human-like **Maia** and **Maia-3** nets, and an **Elo cap**.
- **Playing like a person** — **Humanize**, **Clock Mode** and **Mirror Time**.
- **Automation** — **Safe Premove**, **Pondering**, **Help Mode**, **Manual Mode** and rebindable **hotkeys**.
- **Beyond the engine** — the **Opening Explorer**, an **endgame tablebase** and the **puzzle database**.
- **On screen** — the **eval bar**, the **eval history graph**, **screen reading** and a **playable panel board**.
- **Coverage** — **Chess.com variants**, **TakeTakeTake**, **Chess960** and **fourteen languages**.
- **Under the hood** — a **zero-iframe panel** with no page-visible extension URLs, move-correctness guards,
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
| `mephisto-<version>-update.zip` | **~6 MB** | **Already have it.** Code only — extract *over* your existing folder. |

Nearly all of the full archive is bundled engines: 874 MB of neural nets and WASM under `lib/engine`, plus 13 MB of
onnxruntime under `lib/ort`. Those change on almost no release, so the update archive leaves them alone and carries
only the ~1 MB of extension code — about a hundredth the download.

> ⚠️ **Extract the update over your existing install, never into an empty folder.** Without the engines it cannot
> run. If you do it anyway the panel says so rather than failing obscurely — it checks for the bundled engines at
> startup and tells you to fetch the full archive.

**Extract in place.** Chrome derives an unpacked extension's id from its folder path, so replacing files in the
folder you already loaded keeps the same id — and native engines, which are registered against that id, keep
working. Unpacking into a *new* folder changes the id and means re-running the native-host installer.

To pick up a change: reload on `chrome://extensions`, then reload the game tab. The panel checks this repository for
a newer release at most once every 12 hours, from the service worker, so the chess page never makes the request.

---

## Engines

Everything runs locally via WebAssembly — no server, no account, nothing leaves your machine.

| Engine | Notes |
| --- | --- |
| **Stockfish dev NNUE** | Latest development build. Default. |
| **Stockfish 18 / 18 Small NNUE** | Full dual-net build (large net ships split and is stitched at load), or the lighter net. |
| **Stockfish 11 HCE** | Classical eval, no NNUE — light and fast. |
| **Fairy-Stockfish 14 NNUE** | Required for [variants](#variants); each variant has its own bundled net. |
| **Maia-3** | Human-*like*, not throttled: a transformer conditioned on a rating you set live, **600–2600**. |
| **Maia** | The original Maia-1 nets, one per band (**1100–1900**, plus a **2200**). |
| **Tetrarch (4-player)** | Four-player chess only — see [four-player chess](#four-player-chess). Needs a one-time install. |
| **Remote / native** | A real engine binary outside the browser — see [full-power engines](#full-power-native-engines-optional). |

<img src="docs/maia3.png" alt="Maia-3 with the 600-2600 rating slider" width="49%"> <img src="docs/variants.png" alt="Atomic on Lichess, analysed by Fairy-Stockfish" width="49%">

*Maia-3's live rating slider · Atomic analysed by Fairy-Stockfish*

Illegal scraped positions (missing king, wrong side in check, back-rank pawns) are blocked before they can crash the
engine, and a crashed engine auto-restarts, capped at 3 attempts.

**Strength cap** — limit any Stockfish/Fairy engine to a target Elo with an engine-aware slider whose stops follow
that engine's real `UCI_Elo` range. Both ends mean full strength.

### Variants

**Chess960** works on every mainline Stockfish via `UCI_Chess960`, including every castling case. Fairy-Stockfish
adds all of Lichess's variants (Crazyhouse, King of the Hill, Three-Check, Antichess, Atomic, Horde, Racing Kings)
plus Chess.com's **Duck, Minihouse, Seirawan and Chaturanga**. The ↻ button beside the variant selector detects the
variant and switches engine for you.

Duck, Minihouse, Seirawan and Chaturanga have nets but the bundled chess.js can't replay them — the panel says so
instead of analysing the wrong position.

---

## Features

### Analysis

- **Multiple lines** — top 1–5 candidates (MultiPV), each drawn with its evaluation.
- **Eval bar** — vertical bar beside the board, from your perspective, plus an **eval history graph** shaped like
  Lichess's, marking where the opening, middlegame and endgame begin (ported from scalachess's `Divider`).
- **Threat analysis** — the opponent's strongest reply, so you see what they're threatening.
- **Move confidence** — how much better the best move is than the second: `clearly best (+3.7)`, `+0.35 over #2`,
  `several equal`, `only move`. Read off the MultiPV lines already on screen, so it costs no extra search.
- **Explain moves** — names the tactic behind the choice (fork, promotion, winning capture, mate). Deliberately
  conservative: pins, skewers and discovered attacks can't be established from the position alone, so it stays quiet
  rather than guessing.
- **Opening Explorer** — how humans played this opening (Lichess database): the name, the most-played replies with
  their win/draw/loss split, and coloured arrows. Masters, all Lichess, or a club band.
- **Read a position off the screen** — the camera button captures the tab, finds the board and loads it. Any site: a
  video, a diagram, an image. Nothing is uploaded. **Follow screen** re-reads twice a second so a board playing
  elsewhere keeps the panel in step.
- **Playable panel board** — click or drag to walk a line, with underpromotion. Every move is kept as a line you can
  click back into.

<img src="docs/multiple-lines.png" alt="Three candidate lines, each with its own coloured arrow" width="49%"> <img src="docs/opening-explorer.png" alt="The opening explorer, with each book move drawn on the board" width="49%">

*Three candidate lines, each its own arrow · the explorer's book moves on the board*

![Reading a position straight off a YouTube video](docs/read-from-screen.png)

*Reading a position straight off a YouTube video — a board reading is a guess and says so, naming its least-confident
squares (`least sure: e4 pawn 62%`).*

### Automated play

- **Autoplay** — plays the engine's move for you. **Help Mode** draws the arrows instead and overrides it.
- **Safe Premove** — while the opponent thinks, certifies a reply to their *predicted* move: the same move at
  depth 13, depth 14 and the latest depth. An exact match fires instantly; anything else searches normally, so a
  wrong guess costs nothing.
  Forced moves and true recaptures queue as a real site premove, and an illegal one auto-cancels. On Chess.com, a
  line forced *two* moves deep queues both replies at once.
- **Pondering** — searches the opponent's whole think at full threads over their top 5 replies. Off, their turn is
  capped at two threads (not one: premove certification needs depth 14).
- **Play Book Moves** — plays the opening from the Explorer, weighted-random among popular replies. Needs 20+ games
  and within 40cp of the engine's best, so variety never costs you a worse move.
- **Endgame tablebase** — at 7 pieces or fewer the position is *solved*, so it asks Lichess's Syzygy tables for the
  perfect move and outranks both engine and book. Off by default: it sends the position to a third party.
- **Manual Mode** — thinks indefinitely and plays nothing until you press the play key.
- **Background Play** (off by default) — moves fire only while the tab is focused and visible; a move that comes due
  while you're away is deferred and re-issued when you return.

### Humanize

![The move mix and move-quality thresholds, with live accuracy estimates](docs/humanize.png)

Seven shares set how often it plays the **top move**, a **2nd/3rd/4th line**, an **inaccuracy**, a **mistake** or a
**blunder**; separate thresholds set how far each may stray in centipawns, with a live [Lichess
accuracy](https://lichess.org/page/accuracy) estimate of the win-chance drop. Defaults sit on Lichess's own
boundaries — 110cp inaccuracy, 230cp mistake, 377cp blunder. Nothing past the blunder threshold is played, and
blunders never fire in a decided game.

Timing follows: quick on obvious moves and openings, long thinks in critical positions, and an instant reflex *only*
for true recaptures and forced moves — snapping off a piece that merely moved in to attack looked suspiciously fast.
A countdown shows what kind of move is coming.

**Clock Mode** budgets each move off the page clock (~time/30 + 60% of the increment); **Mirror Time** paces to the
opponent's last spend −10%. Both size the search to the time they'll spend, so the wait becomes a deeper move.

> **Priority** — *Time:* Mirror ▸ Clock ▸ Humanize ▸ Search Time. *Move:* Book ▸ Humanize ▸ engine best.

### Puzzles

<img src="docs/puzzle-database.png" alt="3999 — as high as the Lichess puzzle rating goes" width="49%"> <img src="docs/hotkeys.png" alt="The hotkeys page, each action rebindable" width="49%">

*3999 is the ceiling — there is no higher number Lichess will show you · every action rebindable*

![Hardest (+600) puzzles solved back to back, from the database rather than searched](docs/puzzle-database.gif)

*Hardest (+600) puzzles back to back, from the database rather than searched.
[The full clip](docs/puzzle-database.mp4) runs a minute and a half at higher quality.*

**Puzzle Mode** optimises for solving speed — every move is one it actually searched, and the opponent's scripted
reply is never analysed. A puzzle page ships no move list, so the position is rebuilt from the pieces alone: en
passant is recovered from the last-move highlight and castling rights from the king and rook still at home, because
without them an ep capture is illegal and nobody can castle in *any* puzzle.

**Puzzle database** — a searched move is not always the puzzle's answer; a puzzle has one line that scores, and an
objectively stronger move still fails it. Import Lichess's database and the panel looks the position up instead: on a
hit the whole solution is known, so it plays it with **no search at all**. Works on Training, Storm and Racer.

Lichess only for now, and it doesn't even ask elsewhere — that file is built from Lichess games, so a Chess.com
position would be a guaranteed miss.

**Chess.com puzzles are coming.** Once [the upstream pull request](https://github.com/AlexPetrusca/Mephisto/pull/37)
is merged, a database of **620,000+ Chess.com puzzles with their solutions** will be published for import the same
way — same settings page, same import button, same behaviour: on a hit the panel plays the known line with no search
at all. It covers rated tactics and the daily archive, and carries each puzzle's rating, pass rate and average solve
time alongside the solution.

<details>
<summary><b>Importing the puzzle database</b> — about a gigabyte, roughly half an hour, once</summary>

Not bundled: the release zip is large enough already. Download `lichess_db_puzzle.csv.zst` from
[database.lichess.org](https://database.lichess.org/#puzzles), decompress it (`unzstd lichess_db_puzzle.csv.zst` —
browsers have no zstd decoder, which is why this step is yours), then pick the `.csv` under **Settings → General →
Puzzle Database**. About six million positions, with a live count as it goes. Nothing is sent anywhere; it lives in
the extension's own IndexedDB. If the import is interrupted nothing is lost — run it again and it fills in the rest.
</details>

### The panel

Drag by the title bar, close with ✕. **Compact (▣)** collapses it to the status line, move and score; **minimize
(–)** hides it entirely behind a badge while autoplay keeps running. Quick Settings edits every setting inline.
**Re-detect (↻)** rescans the page. **Copy FEN / PGN** — a game that began from a custom start exports with
`SetUp`/`FEN` tags, so it reads back as the same game. A **grid button** takes a pasted FEN to analyse any position;
**⧉** opens the position on Lichess. An **engine health dot** shows whether a native host answered, because a missing
host otherwise just looks like a panel that never evaluates.

---

## Supported sites

![TakeTakeTake, whose board is a WebGPU canvas with no DOM to scrape](docs/taketaketake.png)

*TakeTakeTake, whose board is a WebGPU canvas with no DOM to scrape.*

| Site | Analysis | Autoplay | Premove | Puzzles | Online | Variants |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **Chess.com** | ✅ | ✅ incl. Play Bots | ✅ | ✅ Rush / Storm | ✅ | 3-Check, KotH, Crazyhouse, Antichess, Atomic, Horde, Racing Kings, **Duck, Minihouse, Seirawan, Chaturanga** + Chess960, **4-player** |
| **Lichess** | ✅ | ✅ incl. AI & From Position | ✅ | ✅ Storm · Racer · Training | ✅ live & correspondence | All Lichess variants + Chess960 |
| **TakeTakeTake** | ✅ | ✅ bot games | ✅ | — | ✅ Lichess-backed | — |
| **BlitzTactics** | ✅ | ✅ | — | ✅ puzzle streams | — | — |
| **ChessBase Tactics** | ✅ | — | — | ✅ Solve / Sprint | — | — |

---

## Full-power native engines (optional)

**You don't need this.** The bundled WASM engines work with zero setup. But WASM is sandboxed — it can't use all your
cores or much RAM, so it runs **5–70× slower** than a native binary. Point Mephisto at a native Stockfish and Chrome
**auto-launches** it; there is no server to run. Two extra engines appear in the dropdown, running at all cores and
up to 2 GB hash.

<details>
<summary><b>Setup</b> — macOS, Linux, Windows</summary>

You need a native **Stockfish** binary (optionally **Fairy-Stockfish** for variants), **Python 3** with
`python-chess`, and your **extension ID** — open `chrome://extensions` with Developer mode on and copy the long id
under *Mephisto*.

> ⚠️ An unpacked extension's id **changes when you reload it**. If native engines stop working after a reload, re-run
> the install command with the new id.

**macOS**
```bash
brew install stockfish fairy-stockfish
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
A binary downloaded from the web is quarantined by Gatekeeper — the installer clears that for its own copy.

**Linux**
```bash
sudo apt install stockfish
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
For Fairy-Stockfish, install it or pass `--fairy /path/to/binary`.

**Windows** — the shell installer is macOS/Linux only; native messaging needs a registry key, so this is manual:
install Python and `pip install chess`, download `stockfish.exe`, copy `native-host/uci-native-host.py` somewhere
stable with a `sf-native.path` file next to it holding the full path to the exe, write a host manifest
`com.sf_native.host.json` (underscores — Chrome rejects hyphens) pointing at a `.bat` that runs the host script with
`"allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]`, and add registry key
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sf_native.host` = the manifest path. Prefer the bundled WASM
engines unless you're comfortable with the registry.

The installer registers the host for **Chrome, Brave, Edge, Chromium and Vivaldi**. Firefox isn't supported for
native engines. Any native build unlocks full speed — pick the one matching your CPU (Apple Silicon, AVX2, BMI2);
the gap between native builds is small, the jump from WASM to any of them is huge.
</details>

---

## Four-player chess

Chess.com's **4-player chess** (`/variants/4-player-chess`), analysed by
[Tetrarch](https://github.com/IchNukeDichWeg/Tetrarch) — a purpose-built engine for 14×14 four-seat boards, because
no two-player engine can be bent into one. Pick **Tetrarch (4-player)** in the engine dropdown; the panel switches to
it on a four-player board and back to Stockfish when you leave.

The panel swaps its own board for a 14×14 one with the corners cut, rotated so **you** sit at the bottom whichever
seat you drew, and draws the suggested move as an arrow. The evaluation is normalised to **your team** (Red+Yellow
against Blue+Green), so it means one thing all game instead of flipping sign every seat. Autoplay works.

> **Teams mode only, for now.** Tetrarch does not search free-for-all, so FFA games are detected and shown but
> not analysed. Promotion plays the move and leaves the piece picker to you.

<details>
<summary><b>Setup</b> — macOS, Linux, Windows</summary>

Tetrarch is the one engine with nothing bundled behind it: it needs a checkout and one run of the installer. Until
then the panel says so under the board rather than pretending to analyse.

You need **Python 3**, a C compiler, and your **extension ID** — `chrome://extensions` with Developer mode on, copy
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

Drop `--tetrarch` if the Tetrarch checkout sits beside Mephisto's parent folder — that's where the installer looks by
default. It prints `-> tetrarch: <path>` when it found it and `-- tetrarch: no uci.py at <path>` when it didn't.

**Windows**

Two differences from the above: the C core has to be built as a DLL, and Chrome finds native-messaging hosts through
the **registry** rather than a folder of manifests — so there's a PowerShell installer instead of the shell one.

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
host into `%LOCALAPPDATA%\Mephisto` and registers it for Chrome, Chromium, Edge, Brave and Vivaldi under `HKCU` — no
administrator rights needed. Python 3 must be on `PATH`.

> The Windows path is **built and symbol-checked but not yet run on a real Windows machine** — the DLL is
> cross-compiled and verified in CI-style by `win-crosscheck.sh` in the Tetrarch repo, which is not the same as
> someone having played a game on it. If something misbehaves,
> [please open an issue](https://github.com/IchNukeDichWeg/Mephisto/issues/new/choose) — see
> [Contributing](#contributing) for the four stages worth reporting. **WSL** works today with no
> extra steps, since it's the Linux path above.
</details>

---

## Languages

**Settings → Appearance → Language**, applied immediately without a reload.

English, Deutsch, Español, Français, Português, Italiano, Nederlands, Polski, Türkçe, Русский, 中文, हिन्दी, 日本語,
한국어 — each listed in its own language, because a list written in English doesn't help someone looking for theirs.

Deliberately **not** Chrome's `chrome.i18n`, which follows the browser's UI locale with no way to override it. One
flat JSON per language under `src/i18n/locales/`, English underneath every other as the fallback. Every string is
translated including the long settings tooltips — the ones explaining what a setting actually does are the ones worth
having in your own language. Engine names, board and piece themes, and chess notation are left alone on purpose.

---

## Settings reference

The options page — right-click the toolbar icon → **Options**, or the gear in the panel. Quick Settings in the panel
is a subset writing to the same storage. Everything applies to the next move without a reload unless noted.

<details>
<summary><b>Engine</b></summary>

| Setting | What it does |
| --- | --- |
| **Engine** | Which engine analyses the position. The WASM builds need nothing installed; "(local, full power)" entries talk to a real binary and only appear once the native host is installed. Switching reloads the panel — the net and UCI options have to be rebuilt. |
| **Elo** | Caps strength via `UCI_LimitStrength` + `UCI_Elo`. The range follows the engine; out-of-range values are ignored rather than clamped. `0` means no cap. |
| **Variant** | How the position is read and analysed. Auto-detected on variant pages. Chess960 is the exception: every mainline Stockfish plays it, so it survives an engine switch. |
| **Search Time** | How long the engine thinks when nothing else sets the pace. Clock Mode, Mirror Time and Humanize all override it; recaptures and forced moves ignore it entirely. |
| **Fallback Poll Interval** | Position changes are event-driven and instant; this is only a slow safety net that repairs a missed update. Lowering it buys nothing. |
| **Multiple Lines** | How many candidates the engine reports. The search splits across them, so depth drops — 1 is strongest. Humanize raises it automatically when it needs alternatives. |
| **Threads** | The default leaves one core for the browser. Capped at 2 on the opponent's turn unless Pondering is on. |
| **Memory** | Transposition-table size. In-browser engines are clamped to 512 MB whatever the slider says — that's the WebAssembly heap limit, not a choice. Native engines get the full value. |
| **Panel Style** | **Floating panel** is the draggable window; it lives in the page, so a site can detect it more easily, and Autoplay and Premove need it. **Toolbar popup** renders in the browser's chrome and leaves no trace in the page, but closes when you click the board — analysis only. |
</details>

<details>
<summary><b>Analysis and display</b></summary>

| Setting | What it does |
| --- | --- |
| **Show Computer Evaluation** | Score, depth, nps and the win/draw/loss split under the panel board. |
| **Show Threat Analysis** | A red arrow for the opponent's best reply. Costs a second search per position. |
| **"Hand & Brain" Mode** | Mephisto plays the *Brain* — names only the piece type. It deliberately withholds the move, so Autoplay does nothing while it's on. |
| **Explain Moves** | Names the tactic behind the choice; silent when nothing is certain. |
| **Hide Opponent Name** | Blurs their username and avatar so a screenshot doesn't expose a real person. Local and cosmetic — but it's the one option that adds a style element to the page, which is why it's off by default. |
| **Opponent Mistake Alert** | A toast when the opponent plays an inaccuracy, mistake or blunder, by the same Lichess win% method the move mix uses. Only fires when both positions were searched deep enough to trust. |
</details>

<details>
<summary><b>Automated play</b></summary>

| Setting | What it does |
| --- | --- |
| **Autoplay** | Plays the engine's move on the site's board by clicking. Everything else that plays a move needs this on. |
| **Premove** | Certifies a reply to the opponent's predicted move; an exact hit is instant. A reply that could never be legal after some other move is queued as a real site premove. |
| **Pondering** | Full threads during the opponent's turn across their top five replies. Costs CPU continuously — it pairs best with Premove. |
| **Endgame Tablebase** | Perfect play at ≤7 pieces, outranking engine and book. Off by default: it leaves your machine. Never delays a move. |
| **Opening Explorer** / **Opening Database** | Human opening data and which games it comes from. *Masters* is the cleanest play; the Lichess sets look more like a normal opponent. Read-out only. |
| **Play Book Moves** | Plays from the book instead of the engine's pick — an engine that always opens the same way is itself a tell. 20-game floor, 40cp check. If the lookup is late the engine's move is played. |
| **Background Play** | Off, moves fire only while the tab is focused. On keeps everything running hidden — Chrome throttles silent background tabs, so the tab is marked as playing audio and shows a speaker icon. |
| **Help Mode** | Arrows on the site's board, plays nothing. Overrides Autoplay. |
| **Humanize** / **Clock Mode** / **Mirror Time** | Which move is played, and how long it takes. See [Humanize](#humanize). |
| **Manual Mode** | Thinks indefinitely; plays only when you press the play key. Overrides Clock/Mirror/Humanize. |
| **Puzzle Mode** / **Puzzle Database** | See [Puzzles](#puzzles). Puzzle Mode turns itself on when you open a puzzle page and off when you leave — unless you set it yourself, which is never overridden. |
| **Python Backend** | Moves the real pointer via a local Python helper instead of synthetic clicks. Needs `mephisto-clicker.py` and PyAutoGUI permissions. Almost nobody needs this. |
</details>

<details>
<summary><b>Humanize tuning, hotkeys, appearance</b></summary>

| Setting | What it does |
| --- | --- |
| **Move Mix (%)** | Seven categories, must total 100. Giving any share to *Third line* or worse forces a wider search so a move that bad exists to pick — which costs depth. A pure Top + Second mix stays cheaper. |
| **Thresholds (cp)** | How much worse than best each category may be. Each value is the top of its band and the one above is the bottom, so bands tile without gaps. |
| **Think Time / Variance** | The minimum delay after the position is evaluated, plus a random extra. Constant identical timing is itself a tell. |
| **Move Time / Variance** | The *total* wall clock for one move, first click to last — promotions get a third leg and are budgeted for. |
| **Hotkeys** | One rebindable key per action, live on the game page while the panel is open. Click a key and the next press becomes the binding; **Esc** cancels, **Backspace** clears. Defaults are single letters, play-move is Space. Clashes with a site shortcut can be rebound to any Ctrl/Alt/Shift/Meta combination. |
| **Pieces / Board / Coordinates** | The panel's own board only — the site's board is never restyled. |
| **Dark Mode / Language** | Theme and language for the panel and the settings page. |
| **Restore Defaults · Export · Import** | Reset everything on the page (not the puzzle database or hotkeys); write every setting including hotkeys and tuning to JSON, and read one back. Values that no longer exist are ignored. |
</details>

---

## Page footprint

**Toolbar popup** leaves **zero page footprint** — it renders in the browser's own chrome, so the page has no handle
to it at all. It closes when you click the board, so it's analysis only; Autoplay and Premove need the floating
panel. Switch under **Settings → General → Panel Style**.

While the **floating panel** is in use, its footprint is minimised:

- **No iframe.** An iframe is a *browsing context* — counted by `window.length`, throwing on cross-origin access,
  which a closed shadow root cannot hide. The panel renders directly in the page's isolated world, and the WASM
  engine moved to an **offscreen document** that still gets the cross-origin isolation the pthread builds need but
  that the page cannot see or count.
- **No extension URLs reach the page.** `web_accessible_resources` is gone from the manifest. Markup, CSS, board
  textures and piece images are fetched extension-side and injected as inlined bytes or `data:` URIs, so no
  `chrome-extension://` URL appears in the DOM **or in Resource Timing**, and the id can't be read back.
- **Closed shadow root** under one attribute-less host node — `document.querySelector('[id^="mephisto-"]')` finds
  nothing and `host.shadowRoot` is `null`.
- **No branded page globals** — MAIN-world probes for canvas boards set no `window.*` flag and talk over
  per-session random event channels, so there's no fixed name to fingerprint.
- **Human-shaped clicks** — a bare *from → to*, no lead click on an empty square, randomised timings, landing on a
  center-weighted distribution within each square, preceded by an eased jittered cursor path inside the Move Time
  budget.
- **No config in the site's storage** — settings live in `chrome.storage.local`. Two values do sit in page storage
  because they're read while the panel is built (panel geometry, a start-position cache); neither is named after the
  extension nor holds a setting.

These reduce *passive* fingerprinting only. See the [disclaimer](#fair-play--read-this-first).

---

## Roadmap

No schedule — added whenever I feel like it. Checked means shipped.

### Planned

- [ ] **More engines** — the lineup covers *strong* and *human-like* and not much between. Variety of character, not
  more strength. **lc0 (Leela)** in WASM would be for comparing styles, not for strength.
- [ ] **Duck Chess autoplay** — detection and analysis work; the duck-placement step doesn't.
- [ ] **Four-player chess, the rest of it** — Teams mode works; free-for-all needs engine support, the promotion
  picker isn't wired, and elimination hasn't been seen in a real game. Chaturaji, 4P Giveaway and Self Partnering
  are untouched.
- [ ] **Four-player chess on Windows, confirmed** — built and symbol-checked, never run on a real Windows machine.
  See [Contributing](#contributing) for the four stages worth reporting.
- [ ] **Short videos and more screenshots** — a premove firing, Humanize pacing a move, the screen reader following a
  board. Some of this only makes sense in motion.
- [ ] **Translate the README** — the interface speaks fourteen languages; the documentation still speaks one.
- [ ] **Shrink the footprint further** — what's left is hardening the one rendezvous the MAIN-world probes need and
  tightening how scraped positions are sanitised. Being straight about the ceiling: the client side is nearly
  exhausted, and it was never the thing that catches people.
- [ ] **ChessBase Tactics arrows + autoplay** — analysis works; drawing and clicking don't. ChessBase renders its own
  board with no class to match, and finding it by shape was slow and unreliable.
- [ ] **Bug fixes**, open-ended. Several of the sharpest bugs so far were invisible rather than loud: autoplay that
  skipped a move with nothing logged, an engine that never loaded, a veto inverted only for Black. Reports of *"it
  did nothing"* are worth more than they sound.
- [ ] **Whatever you want it to do** — most of what's here arrived because something was annoying in a real game.

**Blocked upstream** — no engine supports these, so there's nothing to build against: Fog of War (imperfect
information), Setup Chess, Spell Chess, Bughouse and Chess-with-Checkers.

**Looked at and dropped** — *Lichess cloud evaluation.* It's a crowdsourced cache of positions other people's
browsers have already analysed, not a server-side engine, and its coverage is the problem: deep on openings and
popular lines, absent on ordinary middlegames. That's the inverse of where extra depth would change a move, and the
openings are already covered by the [Opening Explorer](#analysis) and book play. Might be worth revisiting for
post-game review, where the hit rate is higher and the eval is context rather than a move to play.

### Shipped

- [x] **[Four-player chess](#four-player-chess)** (v3.1.199) — chess.com's 4-player variant, driven by
  [Tetrarch](https://github.com/IchNukeDichWeg/Tetrarch); 14×14 panel board, team-relative eval, autoplay.
  Teams mode only.
- [x] **Panel and settings rework** (v3.1.199) — two tabs instead of a wall of rows, the game and engine status
  moved into the title bar, `−`/`+` steppers for threads, lines and move time, uniform control heights, one
  typeface per column, and a settings page grouped into sections.
- [x] **Four-player chess on Windows** (v3.1.200) — DLL build, `.bat` host shim and a PowerShell installer that
  registers under `HKCU`. Unconfirmed on real hardware, hence the open item above.
- [x] **Fourteen languages** (v3.1.160) — every string, switchable live in Settings → Appearance.
- [x] **Puzzle database** (v3.1.140) — the Lichess puzzle CSV in IndexedDB; known solutions play with no search.
- [x] **Endgame tablebase**, **move confidence**, **eval history graph** (v3.1.135).
- [x] **Read a position off the screen** and the **playable panel board** (v3.1.124).
- [x] **From-Position capture** and **on-demand nets** (v3.1.125) — an unbundled net downloads on first use; a full
  install still works offline.
- [x] **Opening Explorer + book play**, **set up a position**, **auto-recover on DOM changes** (v3.1.119) — if a
  site renames its move-list tags, the list is found structurally.
- [x] **Pondering** and **double premove** (v3.1.107).
- [x] **Maia-3** (v3.1.95) — 600–2600 slider, one transformer conditioned on rating; reproduces the
  [CSSLab reference](https://github.com/CSSLab/maia3) exactly (~60% move-match to human play).
- [x] **Maia** (v3.1.93) — the original nets, 1100–1900 plus a community-trained 2200. Matches the lc0 reference.
- [x] **Instant reopen with a warm engine**, the **turn switch** (v3.1.92), **human cursor travel** (v3.1.90).
- [x] **Manual mode**, **configurable hotkeys**, **opponent mistake alert**, **self-test button** (v3.1.84).
- [x] **Copy FEN/PGN, compact panel, export/import** (v3.1.73); **native health badge, smart default threads**
  (v3.1.55).

---

## Contributing

**[Open an issue](https://github.com/IchNukeDichWeg/Mephisto/issues/new/choose) for anything** — a bug, a site that
stopped being scraped correctly, an engine that misbehaves, a feature you want, or just an idea. You don't need a
diagnosis or a reproduction; "it stopped playing moves on lichess this morning" is a perfectly good issue. PRs are
welcome too.

**If the Windows four-player setup fails, an issue is especially useful** — it is built and symbol-checked but has
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
Petrusca) is **MIT** ([`LICENSE`](LICENSE)). It **bundles copyleft components** — GPL-3.0 engines and nets, and the
**AGPL-3.0** Maia-3 model — so the **combined distribution is governed by AGPL-3.0**. Before redistributing, read
[`LICENSING.md`](LICENSING.md) and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md); full texts in
[`licenses/`](licenses/).

Built on the work of others, with thanks:

- **[Stockfish](https://github.com/official-stockfish/Stockfish)** & **[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish)** (GPL-3.0), run in the browser via the [Lichess Stockfish-web](https://github.com/lichess-org) builds.
- **[Maia](https://github.com/CSSLab/maia-chess) / [Maia-3](https://github.com/CSSLab/maia3)** (CSSLab, University of Toronto; GPL-3.0 / AGPL-3.0) and the **[Maia 2200](https://github.com/CallOn84/LeelaNets)** net (CallOn84; GPL-3.0); **[Leela Chess Zero](https://github.com/LeelaChessZero/lc0)** (GPL-3.0) for the input/policy encoding.
- **Board recognition** — two models from [Chess_diagram_to_FEN](https://github.com/tsoj/Chess_diagram_to_FEN) by Jost Triller (MIT), converted to ONNX; see `lib/engine/vision/`.
- **[ONNX Runtime Web](https://github.com/microsoft/onnxruntime)** (Microsoft; MIT) — in-browser inference.
- **[chess.js](https://github.com/jhlywa/chess.js)** (BSD-2), **[chessboard.js](https://github.com/oakmac/chessboardjs)**, **[jQuery](https://jquery.com)**, **[Materialize](https://materializecss.com)** and `lru` (all MIT).
