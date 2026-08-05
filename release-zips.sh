#!/usr/bin/env bash
# Build the two release archives from a tag or branch.
#
#   ./release-zips.sh 3.1.204 [ref]        # ref defaults to master
#
# FULL     mephisto-<v>.zip          ~584 MB   everything. New installs use this.
# UPDATE   mephisto-<v>-update.zip   ~6 MB     everything EXCEPT the bundled engines.
#
# The update archive exists because 99% of the full one is `lib/engine` (874 MB of nets and WASM)
# plus `lib/ort` (13 MB of onnxruntime), and those change on almost no release. The extension's own
# code is about 1 MB. Extracting the update over an existing install replaces the code and leaves
# the engines alone.
#
# WHAT IS *NOT* EXCLUDED, and why it is spelled out rather than "exclude lib":
# lib/ also holds chess.js, lru.min.js, jquery, materialize and chessboard -- small, and the
# extension does not run without them. Dropping the whole directory would ship a broken update.
#
# The guard against applying the update to nothing is in the extension itself: the worker probes for
# a bundled engine file at startup and the panel says so if it is missing (see checkBundledAssets).
# This script also refuses to build an update archive that would be missing chess.js.
set -euo pipefail
cd "$(dirname "$0")"

V="${1:?usage: ./release-zips.sh <version> [ref]}"
REF="${2:-master}"
OUT="$(cd .. && pwd)"

# everything heavy, and nothing the extension needs to boot
EXCLUDE=(':(exclude)lib/engine/*' ':(exclude)lib/ort/*' ':(exclude)docs/*')

echo "full   -> $OUT/mephisto-$V.zip"
git archive --format=zip -9 --prefix="Mephisto-$V/" "$REF" -o "$OUT/mephisto-$V.zip"

echo "update -> $OUT/mephisto-$V-update.zip"
git archive --format=zip -9 --prefix="Mephisto-$V/" "$REF" -o "$OUT/mephisto-$V-update.zip" \
    -- . "${EXCLUDE[@]}"

# --- verify, because a silently wrong split is worse than no update archive at all ---------------
# List each archive ONCE into a file. Piping `unzip -l` straight into `grep -q` looks obvious and is
# wrong under `set -o pipefail`: grep exits at the first match, unzip takes SIGPIPE, and the pipeline
# reports failure even though the match succeeded -- which made this check claim the FULL archive had
# no engines in it.
listing_full="$(mktemp)"; listing_upd="$(mktemp)"
trap 'rm -f "$listing_full" "$listing_upd"' EXIT
unzip -l "$OUT/mephisto-$V.zip"        > "$listing_full"
unzip -l "$OUT/mephisto-$V-update.zip" > "$listing_upd"

need=(manifest.json src/popup/popup.js src/scripts/content-script.js lib/chess.js lib/lru.min.js)
for f in "${need[@]}"; do
    grep -Fq "Mephisto-$V/$f" "$listing_upd" \
        || { echo "!! update archive is missing $f -- refusing to ship it"; exit 1; }
done
! grep -Fq "lib/engine/" "$listing_upd" \
    || { echo "!! update archive still contains lib/engine -- the exclusion did not apply"; exit 1; }
grep -Fq "lib/engine/" "$listing_full" \
    || { echo "!! FULL archive has no lib/engine -- that cannot be right"; exit 1; }

printf '\n%-10s %s bytes\n' full   "$(stat -f%z "$OUT/mephisto-$V.zip" 2>/dev/null || stat -c%s "$OUT/mephisto-$V.zip")"
printf '%-10s %s bytes\n'   update "$(stat -f%z "$OUT/mephisto-$V-update.zip" 2>/dev/null || stat -c%s "$OUT/mephisto-$V-update.zip")"
echo "both archives verified"
