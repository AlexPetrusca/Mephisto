#!/usr/bin/env bash
# OPTIONAL: enable full-power NATIVE Stockfish / Fairy-Stockfish in Mephisto.
#
# The bundled WASM engines work with NO setup. This script is only for users who want native
# full-strength engines (all CPU cores, real RAM). It registers a Chrome native-messaging host so
# the browser AUTO-LAUNCHES a local Stockfish -- there is NO server to run.
#
#   ./install-native.sh --ext-id <EXTENSION_ID> [--stockfish /path] [--fairy /path] [--tetrarch /path]
#
# --ext-id : your Mephisto extension ID from chrome://extensions (Developer mode on). It changes
#            when an unpacked extension is reloaded -- re-run this script if native engines stop working.
# --stockfish / --fairy : engine binaries. Auto-detected from PATH if omitted. Install one via:
#            macOS: brew install stockfish fairy-stockfish   |   Linux: apt/pacman, or download from
#            stockfishchess.org and fairy-stockfish releases. Pick the build matching your CPU.
#
# --tetrarch : path to a Tetrarch checkout, for four-player chess (see the README). Looked for
#            beside this repo's parent folder if omitted, and skipped entirely if not found.
#
# Requires python3 with python-chess for the Stockfish/Fairy hosts:  python3 -m pip install chess
# (Tetrarch needs neither -- it speaks raw UCI over a pipe.)
set -euo pipefail
cd "$(dirname "$0")"
SRC_DIR="$(pwd)"

EXT_ID=""; SF_BIN=""; FAIRY_BIN=""; TETRARCH_DIR=""   # set -u: must exist before the flag can skip it
while [ $# -gt 0 ]; do
  case "$1" in
    --ext-id) EXT_ID="$2"; shift 2 ;;
    --stockfish) SF_BIN="$2"; shift 2 ;;
    --fairy) FAIRY_BIN="$2"; shift 2 ;;
    --tetrarch) TETRARCH_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done
[ -n "$EXT_ID" ] || { echo "!! --ext-id is required (copy it from chrome://extensions)"; exit 1; }

# a python3 that can import chess (Chrome launches hosts with a minimal PATH -> pin an absolute one)
PYBIN=""
for cand in "$(command -v python3 || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if "$cand" -c "import chess.engine" 2>/dev/null; then PYBIN="$cand"; break; fi
done
PYBIN_ANY="$(command -v python3 2>/dev/null || true)"
# python-chess is a 64-square library, so the four-player host deliberately does not use it. A
# Tetrarch-only install must therefore not be blocked by a dependency it never needed.
[ -n "$PYBIN" ] || [ -n "$PYBIN_ANY" ] || { echo "!! no python3 found"; exit 1; }
[ -n "$PYBIN" ] || echo "-- no python-chess: skipping native Stockfish/Fairy (python3 -m pip install chess)"

# auto-detect engine binaries if not given
[ -n "$SF_BIN" ]    || SF_BIN="$(command -v stockfish 2>/dev/null || true)"
[ -n "$FAIRY_BIN" ] || FAIRY_BIN="$(command -v fairy-stockfish 2>/dev/null || true)"

# runtime dir OUTSIDE TCC-protected folders (macOS blocks a Chrome-spawned host from reading
# ~/Desktop, ~/Documents, ~/Downloads); binaries + nets are copied here so Chrome can launch them.
case "$(uname -s)" in
  Darwin) RUNTIME_DIR="$HOME/Library/Application Support/Mephisto"
    BASE="$HOME/Library/Application Support"
    DIRS=(
      "$BASE/Google/Chrome/NativeMessagingHosts"
      "$BASE/Google/Chrome Canary/NativeMessagingHosts"
      "$BASE/Chromium/NativeMessagingHosts"
      "$BASE/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$BASE/Microsoft Edge/NativeMessagingHosts"
      "$BASE/Vivaldi/NativeMessagingHosts"
    ) ;;
  Linux) RUNTIME_DIR="$HOME/.local/share/mephisto"
    DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/vivaldi/NativeMessagingHosts"
    ) ;;
  *) echo "!! this installer supports macOS/Linux. On Windows, see the README (registry setup)."; exit 1 ;;
esac
mkdir -p "$RUNTIME_DIR/engines"

pin_shebang() { local f="$1" tmp; tmp="$(mktemp)"; { printf '#!%s\n' "$PYBIN"; tail -n +2 "$f"; } > "$tmp"; cat "$tmp" > "$f"; rm -f "$tmp"; }

# slug | binary | nnue-dir ("" = none). Fairy switches EvalFile per variant from the bundled nets.
NNUE_SRC="$SRC_DIR/../lib/engine/fairy-stockfish-14/nnue"
SPECS=("sf-native|$SF_BIN|" "fairy-native|$FAIRY_BIN|$NNUE_SRC")
[ -n "$PYBIN" ] || SPECS=()   # no python-chess -> no UCI hosts, but Tetrarch below still installs

installed=0
for spec in "${SPECS[@]}"; do
  slug="${spec%%|*}"; rest="${spec#*|}"; bin="${rest%%|*}"; nnue="${rest#*|}"
  if [ -z "$bin" ] || [ ! -x "$bin" ]; then
    echo "-- skipping $slug (no binary; pass --${slug%-native} /path or install it)"; continue
  fi
  runbin="$RUNTIME_DIR/engines/$slug.bin"; rm -f "$runbin"; cp "$bin" "$runbin"; chmod +x "$runbin"
  host="$RUNTIME_DIR/$slug-host.py"; rm -f "$host"; cp "$SRC_DIR/uci-native-host.py" "$host"; pin_shebang "$host"; chmod +x "$host"
  echo "$runbin" > "$RUNTIME_DIR/$slug.path"
  if [ -n "$nnue" ] && [ -d "$nnue" ]; then
    runnnue="$RUNTIME_DIR/engines/$slug-nnue"; rm -rf "$runnnue"; mkdir -p "$runnnue"
    cp "$nnue"/*.nnue "$runnnue"/ 2>/dev/null || true
    echo "$runnnue" > "$RUNTIME_DIR/$slug.nnue-dir"
  fi
  host_id="com.${slug//-/_}.host"   # host names allow only [a-z0-9._] -- no hyphens
  for d in "${DIRS[@]}"; do
    parent="$(dirname "$d")"; [ -d "$parent" ] || continue; mkdir -p "$d"
    cat > "$d/$host_id.json" <<JSON
{
  "name": "$host_id",
  "description": "Mephisto native UCI engine ($slug)",
  "path": "$host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  done
  echo "-> enabled native engine: $slug  (binary: $(basename "$bin"))"
  installed=$((installed + 1))
done
# --- Tetrarch, the four-player engine (optional) -------------------------------------------
# Not a binary but a CHECKOUT: the host launches its uci.py with cwd set to the repo root, which
# is what makes the net path in its default options resolve.
[ -n "$TETRARCH_DIR" ] || TETRARCH_DIR="$(cd "$SRC_DIR/../.." 2>/dev/null && pwd)/Tetrarch"
if [ -f "$TETRARCH_DIR/uci.py" ]; then
  TT_HOST="$RUNTIME_DIR/tetrarch-host.py"
  rm -f "$TT_HOST"; cp "$SRC_DIR/tetrarch-host.py" "$TT_HOST"
  { printf '#!%s\n' "${PYBIN:-$PYBIN_ANY}"; tail -n +2 "$TT_HOST"; } > "$TT_HOST.tmp"
  mv "$TT_HOST.tmp" "$TT_HOST"; chmod +x "$TT_HOST"
  printf '%s\n' "$TETRARCH_DIR" > "$RUNTIME_DIR/tetrarch-path"
  TT_MANIFEST="$(sed -e "s|__HOST_PATH__|$TT_HOST|" -e "s|__EXTENSION_ID__|$EXT_ID|" \
                     "$SRC_DIR/com.tetrarch.host.json.template")"
  for d in "${DIRS[@]}"; do
    parent="$(dirname "$d")"; [ -d "$parent" ] || continue; mkdir -p "$d"
    printf '%s\n' "$TT_MANIFEST" > "$d/com.tetrarch.host.json"
  done
  echo "-> enabled four-player chess: $TETRARCH_DIR"
  installed=$((installed + 1))
else
  echo "-- skipping tetrarch (no uci.py at $TETRARCH_DIR; pass --tetrarch /path -- see the README)"
fi

xattr -cr "$RUNTIME_DIR" 2>/dev/null || true  # strip web-download quarantine (macOS) so Chrome can launch

[ "$installed" -gt 0 ] || { echo "!! nothing enabled -- install stockfish/fairy-stockfish, or pass --stockfish/--fairy/--tetrarch"; exit 1; }
echo
echo "Done. Reload the extension + the page, then pick a '(native)' engine. Chrome launches it -- no server."
echo "If native engines stop working after reloading the unpacked extension, re-run this with the new --ext-id."
