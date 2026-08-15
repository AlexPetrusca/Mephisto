# Licensing

This project bundles third-party engines, neural networks, and libraries under several
licenses. Because some of those components are copyleft, the licensing of the project as a
**whole distribution** is not simply the MIT license in [`LICENSE`](LICENSE). Please read this
file before redistributing.

## Short version

- The **original Mephisto source code** (by Alexandru Petrusca) and this fork's own source-code
  changes are made available under the **MIT License** — see [`LICENSE`](LICENSE).
- However, the project **bundles and distributes** components licensed under **GPL-3.0**
  (Stockfish, Fairy-Stockfish, and their NNUE nets; the Maia-1 nets and the Maia 2200 net; and the
  Polyglot book-format key table in `lib/polyglot-random.js`, transcribed from python-chess) and
  under **AGPL-3.0** (the Maia-3 model, and this project's Maia-3 encoder which is derived from
  the Maia-3 source).
- Because AGPL-3.0 is the strongest copyleft here and it is one-way compatible with GPL-3.0, the
  **combined work as distributed (the released .zip / the installed extension) is governed by the
  GNU Affero General Public License, version 3** — see [`licenses/AGPL-3.0.txt`](licenses/AGPL-3.0.txt).
  The GPL-3.0 text is included at [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt).

MIT-licensed code stays MIT-licensed (MIT is compatible with, and may be included in, an
AGPL/GPL work); the copyleft obligations attach to the combined distribution.

## What that means if you redistribute

If you distribute this project (or a modified version), the AGPL-3.0 / GPL-3.0 terms require you to:

1. **Keep the license texts and notices.** Ship `LICENSE`, `LICENSING.md`, `THIRD-PARTY-NOTICES.md`,
   and `licenses/` intact, and preserve the copyright/permission headers inside the bundled files.
2. **License your combined work under AGPL-3.0** and make **complete corresponding source** available
   to the people you distribute to (this repository is that source for the JavaScript; see
   `THIRD-PARTY-NOTICES.md` for where to obtain the source of the compiled engine binaries and of the
   neural-network models).
3. **Do not add further restrictions** beyond those the licenses allow.

## Corresponding source

- This Git repository **is** the corresponding source for all of the project's own JavaScript/HTML/CSS.
- The **Stockfish** and **Fairy-Stockfish** engines are shipped as pre-compiled WebAssembly. Their
  corresponding C++ source, and the source used to produce the WebAssembly builds, are available from
  the upstream projects listed in `THIRD-PARTY-NOTICES.md`.
- The **Maia** neural networks (Maia-1, Maia 2200, Maia-3) are trained models. Their training code,
  and where applicable the model weights in their original form, are available from the upstream
  projects listed in `THIRD-PARTY-NOTICES.md`.

## Note on AGPL-3.0 §13 (network use)

The Maia-3 component is AGPL-3.0, whose §13 requires that users **interacting with a modified version
over a network** be offered its source. In this project Maia-3 runs **locally in the user's own
browser** (an offscreen document); it is not offered as a network service. §13 is therefore not
expected to be triggered by ordinary use of this extension. The ordinary copyleft obligations above
(source-on-distribution, license text, no added restrictions) still apply because the model and its
derived code are distributed.

*This file is a good-faith summary, not legal advice. If in doubt, consult a lawyer or the individual
upstream licenses.*
