# Third-Party Notices

This project (a browser chess extension) redistributes the third-party software and neural-network
models listed below. Each is the property of its respective authors and is used under the license
shown. See [`LICENSING.md`](LICENSING.md) for how these licenses combine, and [`licenses/`](licenses/)
for the full GPL-3.0 and AGPL-3.0 texts.

For each entry: **Component — License — Copyright/authors — Source (corresponding source).**

---

## Base project

- **Mephisto (original)** — MIT — Copyright (c) 2022 Alexandru Petrusca —
  <https://github.com/AlexPetrusca/Mephisto>. This fork retains the original MIT license
  ([`LICENSE`](LICENSE)) for that code and this fork's own source changes.

## Chess engines (copyleft — GPL-3.0)

- **Stockfish** — used in the WebAssembly builds shipped under
  `lib/engine/stockfish-dev`, `stockfish-18`, `stockfish-18-small`, and `stockfish-11-hce` —
  **GPL-3.0-or-later** — Copyright (c) The Stockfish developers —
  <https://github.com/official-stockfish/Stockfish>.
  The WebAssembly builds are produced by / obtained via the Lichess Stockfish-in-the-browser work
  (`@lichess-org/stockfish-web`, <https://github.com/lichess-org/stockfish.wasm> and related repos).
  Corresponding source: the Stockfish C++ source at the URL above, plus the WebAssembly build tooling
  from the Lichess repositories.

- **Fairy-Stockfish** — `lib/engine/fairy-stockfish-14` — **GPL-3.0-or-later** —
  Copyright (c) Fabian Fichter and the Fairy-Stockfish contributors —
  <https://github.com/fairy-stockfish/Fairy-Stockfish>. Corresponding source at that URL.

## Neural networks — engine evaluation (GPL-3.0)

- **Stockfish NNUE networks** — the `.nnue` files under `lib/engine/stockfish-*/` — **GPL-3.0** as
  distributed with Stockfish — © the Stockfish project — <https://tests.stockfishchess.org/nns> and
  <https://github.com/official-stockfish/Stockfish>.

- **Fairy-Stockfish NNUE networks** (one per variant) — the `.nnue` files under
  `lib/engine/fairy-stockfish-14/nnue/` — **GPL-3.0** as distributed with Fairy-Stockfish —
  © the Fairy-Stockfish project — <https://github.com/fairy-stockfish/Fairy-Stockfish>.

## Neural networks — human-like play (Maia)

- **Maia (Maia-1) networks 1100–1900** — `lib/engine/maia/maia-1100.onnx … maia-1900.onnx` —
  **GPL-3.0** — Copyright (c) the Computational Social Science Lab (CSSLab), University of Toronto —
  <https://github.com/CSSLab/maia-chess>. Converted to ONNX from the upstream `.pb.gz` weights using
  `lc0 leela2onnx`; the original weights and training code are at that URL.

- **Maia 2200 network** — `lib/engine/maia/maia-2200.onnx` — **GPL-3.0** — © CallOn84 —
  <https://github.com/CallOn84/LeelaNets>. A Maia-architecture network extending the CSSLab rating
  range; converted to ONNX from the upstream `.pb.gz`.

- **Maia-3 model** — `lib/engine/maia3/maia3-23m.onnx` — **AGPL-3.0** — Copyright (c) the CSSLab,
  University of Toronto — <https://github.com/CSSLab/maia3> (weights also at
  <https://huggingface.co/UofTCSSLab>). Exported to ONNX from the upstream PyTorch model; the model
  code and weights are at those URLs.

## Code derived from Maia sources

- **Maia-3 input encoder / decoder** — `src/offscreen/maia3.js` — is a **derivative work of
  CSSLab/maia3** (its board tokenization, Elo conditioning, move vocabulary and output handling were
  reimplemented from that project's Python source) and is therefore distributed under **AGPL-3.0**.
  © the CSSLab (original) and this project's contributors (the JavaScript port) —
  <https://github.com/CSSLab/maia3>.

- **Maia-1 encoder / policy index** — `src/offscreen/maia.js` and
  `lib/engine/maia/lc0_policy_index.json` — implement the **Leela Chess Zero (lc0)** "classic" input
  planes and 1858-move policy ordering (the policy index was harvested from lc0's own output). These
  conventions originate with **Leela Chess Zero** (**GPL-3.0**) —
  <https://github.com/LeelaChessZero/lc0>.

## Runtime & libraries (permissive)

- **ONNX Runtime Web** (`lib/ort/`) — **MIT** — Copyright (c) Microsoft Corporation —
  <https://github.com/microsoft/onnxruntime>. The MIT license is included at
  [`lib/ort/LICENSE`](lib/ort/LICENSE), and ONNX Runtime's own notices for the components it bundles
  are included at [`lib/ort/ThirdPartyNotices.txt`](lib/ort/ThirdPartyNotices.txt).

- **Polyglot opening-book key table** (`lib/polyglot-random.js`) — **GPL-3.0** — the 781 fixed
  Zobrist constants the Polyglot `.bin` book format keys positions with. Originally from
  **Polyglot** (Fabien Letouzey and contributors); this copy transcribed from **python-chess**'s
  `POLYGLOT_RANDOM_ARRAY` (Copyright (c) Niklas Fiekas, GPL-3.0-or-later) —
  <https://github.com/niklasf/python-chess>. The values are the format's own published constants:
  a book cannot be read without exactly these numbers, which is why they are vendored as data
  rather than reimplemented. The reader built on them (`src/options/util/polyglot.js`) is this
  project's own code.

- **chess.js** (`lib/chess.js`) — **BSD-2-Clause** — Copyright (c) 2023 Jeff Hlywa
  (jhlywa@gmail.com) — <https://github.com/jhlywa/chess.js>. (License header retained in the file.)

- **chessboard.js** (`lib/chessboard/`) — **MIT** — Copyright (c) 2019 Chris Oakman —
  <https://github.com/oakmac/chessboardjs>. (Header retained.)

- **jQuery** (`lib/jquery.min.js`) — **MIT** — Copyright (c) OpenJS Foundation and other
  contributors — <https://jquery.org/license>. (Header retained.)

- **Materialize CSS** (`lib/materialize/`) — **MIT** — Copyright 2014-2017 Materialize —
  <https://materializecss.com>. (Header retained.)

- **lru** (`lib/lru.min.js`) — **MIT** — appears to be the `lru` package by Chris O'Hara
  (<https://github.com/chriso/lru>); attribution inferred from its API because the minified file
  carries no header. *(Please verify the exact source/license, or add the upstream header.)*

---

*If any attribution here is incomplete or incorrect, please open an issue. This notice is provided in
good faith to comply with the licenses above; it is not legal advice.*
