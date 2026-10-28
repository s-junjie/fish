#!/usr/bin/env bash
# Render a FISH document with nothing but a browser already on the machine.
# No npm, no Node, no Playwright: `chrome --headless` is part of the OS, and the
# page answers geometry questions through a URL parameter.
#
#   ./shot.sh design.fish.html out.png
#   ./shot.sh design.fish.html out.png --scale 2
#   ./shot.sh design.fish.html out.png --element hero-title
#   ./shot.sh design.fish.html out.png --debug        # print full browser command line
#   ./shot.sh design.fish.html out.png --watch      # re-render on every save
#
# Writes out.png plus a sibling out.report.json: the normalize repairs, the validate
# diagnostics, and for --element the box that element actually occupies. One run
# answers both "what does it look like" and "what did the engine change". The
# report never takes the bare .json name — a design authored as design.json
# beside the shell already owns it.
#
# The page computes the window size and the origin; this script only passes them
# through. Redoing that arithmetic here would be one more place for the two to
# disagree, and a crop of the wrong rectangle is a confident-looking wrong answer.
set -euo pipefail

ARGS=("$@")
DOC=""; OUT=""; SCALE=1; ELEMENT=""; WATCH=0; DEBUG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scale) SCALE="$2"; shift 2 ;;
    --element) ELEMENT="$2"; shift 2 ;;
    --watch) WATCH=1; shift ;;
    --debug) DEBUG=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) [ -z "$DOC" ] && DOC="$1" || OUT="$1"; shift ;;
  esac
done
[ -n "$DOC" ] && [ -n "$OUT" ] || { echo "usage: $0 <doc.fish.html> <out.png> [--scale N] [--element ID]" >&2; exit 2; }
[ -f "$DOC" ] || { echo "no such file: $DOC" >&2; exit 2; }

find_browser() {
  local playwright_candidates
  playwright_candidates=(
    "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell
    "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google\ Chrome\ for\ Testing.app/Contents/MacOS/Google\ Chrome\ for\ Testing
    "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell
    "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome
  )
  for c in \
    "${playwright_candidates[@]}" \
    "google-chrome" "google-chrome-stable" "chromium" "chromium-browser" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "microsoft-edge" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe"; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

BROWSER="${FISH_BROWSER:-$(find_browser || true)}"
if [ -z "$BROWSER" ]; then
  cat >&2 <<'MSG'
No Chrome / Chromium / Edge on this machine. Point FISH_BROWSER at one, or use
  npm install && npx playwright install --only-shell chromium
MSG
  exit 2
fi

ABS="$(cd "$(dirname "$DOC")" && pwd)/$(basename "$DOC")"
JSON="${OUT%.png}.report.json"
JSON_DIR="$(cd "$(dirname "$JSON")" 2>/dev/null && pwd || true)"
JSON_ABS="${JSON_DIR:-$(dirname "$JSON")}/$(basename "$JSON")"
if [ "$JSON_ABS" = "$ABS" ]; then
  echo "refusing to write the report over the input document: $JSON" >&2
  exit 2
fi
if [ -e "$JSON" ] && ! grep -q '"ok"[[:space:]]*:' "$JSON" 2>/dev/null; then
  echo "refusing to overwrite $JSON: it does not look like a shot report; choose a different output basename" >&2
  exit 2
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

CHROME_FLAGS=(
  --headless=new
  --disable-gpu
  --hide-scrollbars
)

# On Linux / containers, private user-data-dir and --no-sandbox are required.
#
# On macOS neither is passed up front. Chrome nests its own sandbox inside whichever
# one the caller already runs in, and a process tree that cannot spawn a second one
# — an AI agent's shell, a locked-down container — kills the GPU process instead of
# rendering: nothing on stdout, no exit code to read, everything in stderr. Measured
# in such a tree, where the two obvious fixes are not equivalent:
#
#   default flags                                → SIGTRAP, ~1s, 0 bytes on stdout
#   + --no-sandbox                               → works (~7s)
#   + --no-sandbox + a fresh --user-data-dir     → renders, then NEVER EXITS
#
# The last one is reproducible here and is the reason the rescue below never adds a
# profile: the DOM comes back at full size and the child just stays alive, so any
# synchronous caller blocks on a job that already finished.
#
# None of it reproduces from an ordinary terminal — the same default flags launch
# fine there — which is why the retry is a rescue rather than the default, and why a
# report that merely says "Command failed" costs the reader the whole diagnosis.
if [ "$(uname)" != "Darwin" ]; then
  PROFILE_DIR="$TMP/profile"
  mkdir -p "$PROFILE_DIR"
  CHROME_FLAGS+=(--user-data-dir="$PROFILE_DIR" --no-sandbox)
fi

# Allow external agents/environments to inject chrome flags (e.g. FISH_CHROME_FLAGS="--no-sandbox")
if [ -n "${FISH_CHROME_FLAGS:-}" ]; then
  # shellcheck disable=SC2206
  CHROME_FLAGS+=($FISH_CHROME_FLAGS)
fi

# Standard sandbox and macOS launchservicesd/ASN failure patterns
SANDBOX_FAILURE_RE="sandbox initialization failed|GPU process isn't usable|bootstrap_check_in|MachPortRendezvousServer|Operation not permitted|Permission denied|RegisterApplication|launchservicesd|ASN|Abort trap"

has_no_sandbox() {
  local f
  for f in "${CHROME_FLAGS[@]}"; do [ "$f" = "--no-sandbox" ] && return 0; done
  return 1
}

# True when $1 (a stderr file) shows a launch denied its own sandbox and nothing has
# already been given away to rescue it. An agent running inside a sandbox then needs
# to know nothing about Chromium flags to get a picture out.
should_retry_without_sandbox() {
  [ -s "$1" ] || return 1
  grep -qE "$SANDBOX_FAILURE_RE" "$1" || return 1
  ! has_no_sandbox
}

diagnose_failure() {
  local err_file="$1"
  if [ -s "$err_file" ]; then
    echo "browser execution failed:" >&2
    cat "$err_file" >&2
    if grep -qE "Permission denied|bootstrap_check_in|MachPortRendezvousServer|Operation not permitted|RegisterApplication|launchservicesd|ASN" "$err_file"; then
      cat >&2 <<'HINT'

[Note] The browser failed to launch due to sandbox or OS security restrictions (e.g. Mach port bootstrap, launchservicesd ASN registration, or unprivileged sandbox).
If running inside an AI coding agent or sandboxed container:
  1. Set FISH_CHROME_FLAGS="--no-sandbox"
  2. Or install a standalone headless shell (e.g. `npx playwright install --only-shell chromium`) and point FISH_BROWSER to it
  3. Or use `./fish check` for headless syntax/model verification without requiring a browser
HINT
    fi
  fi
}

shoot_once() { # <url-query> <dest.png> <window>
  local shoot_err="$TMP/shoot.err"
  if [ "$DEBUG" = "1" ]; then
    echo "[DEBUG] shoot cmd: $BROWSER ${CHROME_FLAGS[*]} --force-device-scale-factor=$SCALE --window-size=$3 --screenshot=$2 file://$ABS?$1" >&2
  fi
  "$BROWSER" "${CHROME_FLAGS[@]}" \
    --force-device-scale-factor="$SCALE" \
    --window-size="$3" --screenshot="$2" "file://$ABS?$1" 2>"$shoot_err" || true
}

shoot() { # <url-query> <dest.png> <window> — once, then once more without the sandbox
  shoot_once "$@"
  if [ ! -s "$2" ] && should_retry_without_sandbox "$TMP/shoot.err"; then
    echo "[retry] the browser was refused a sandbox of its own — relaunching with --no-sandbox" >&2
    CHROME_FLAGS+=(--no-sandbox)
    shoot_once "$@"
  fi
  [ -s "$2" ] || diagnose_failure "$TMP/shoot.err"
}

# Pass 1 — query the engine via dump-dom for element-specific geometry or fallback.
REPORT_QUERY="view=canvas&report=1&scale=$SCALE"
[ -n "$ELEMENT" ] && REPORT_QUERY="$REPORT_QUERY&element=$ELEMENT"
DUMP_ERR="$TMP/dump.err"

dump_once() {
  if [ "$DEBUG" = "1" ]; then
    echo "[DEBUG] dump-dom cmd: $BROWSER ${CHROME_FLAGS[*]} --virtual-time-budget=2000 --window-size=1440,900 --dump-dom file://$ABS?$REPORT_QUERY" >&2
  fi
  "$BROWSER" "${CHROME_FLAGS[@]}" \
    --virtual-time-budget=2000 \
    --window-size=1440,900 --dump-dom \
    "file://$ABS?$REPORT_QUERY" >"$TMP/dom.html" 2>"$DUMP_ERR" || true
}

dump_once
if [ ! -s "$TMP/dom.html" ] && should_retry_without_sandbox "$DUMP_ERR"; then
  echo "[retry] the browser was refused a sandbox of its own — relaunching with --no-sandbox" >&2
  CHROME_FLAGS+=(--no-sandbox)
  dump_once
fi

if [ ! -s "$TMP/dom.html" ]; then
  diagnose_failure "$DUMP_ERR"
  echo "browser exited without dumping DOM" >&2
  exit 1
fi

REPORT="$(tr -d '\n' <"$TMP/dom.html" | sed -n 's/.*<script id="fish-report" type="application\/json">\(.*\)<\/script>.*/\1/p')"
if [ -z "$REPORT" ]; then
  diagnose_failure "$DUMP_ERR"
  echo "this document's shell predates ?report — rebuild it from dist/index.html" >&2
  exit 1
fi
printf '%s' "$REPORT" > "$JSON"

if printf '%s' "$REPORT" | grep -q '"ok":false'; then
  echo "report failed:" >&2
  printf '%s\n' "$REPORT" >&2
  exit 1
fi

WINDOW="$(printf '%s' "$REPORT" | sed -n 's/.*"window":"\([0-9]*x[0-9]*\)".*/\1/p')"
[ -n "$WINDOW" ] || WINDOW="1440x900"
ORIGIN="$(printf '%s' "$REPORT" | sed -n 's/.*"origin":"\(-*[0-9.]*,-*[0-9.]*\)".*/\1/p')"
# The bitmap the screenshot comes back as: `window` is CSS pixels and the browser
# raises it by SCALE. Log those pixels, or the line reads as the output size and
# is off by the factor. A report without the field predates it — derive instead.
EXPECTED="$(printf '%s' "$REPORT" | sed -n 's/.*"expected":"\([0-9]*x[0-9]*\)".*/\1/p')"
[ -n "$EXPECTED" ] || EXPECTED="$(awk -v w="${WINDOW%x*}" -v h="${WINDOW#*x}" -v s="$SCALE" 'BEGIN { printf "%dx%d", int(w * s + 0.5), int(h * s + 0.5) }')"

# Hard guard: ensure WINDOW is valid NNNxNNN and non-zero to prevent Chromium hang on --window-size=0x0
case "$WINDOW" in
  [1-9]*x[1-9]*) ;;
  *) WINDOW="1440x900" ;;
esac

# Pass 2 — the picture. A screenshot is the one thing the headless CLI waits for
# correctly, so the pixels are the browser's job and only the aim is ours.
shoot "view=canvas${ORIGIN:+&origin=$ORIGIN}" "$OUT" "$WINDOW"
[ -s "$OUT" ] || { echo "no image produced (window $WINDOW)" >&2; exit 1; }

echo "$OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, ${EXPECTED} @${SCALE}x) + $JSON"

# Polling, not inotify: `fswatch` / `inotifywait` are exactly the kind of
# dependency this script exists to avoid, and a save is seconds apart at worst.
# Re-exec rather than loop, so every pass is the same code that just ran.
[ "$WATCH" = "1" ] || exit 0
if [ "$(uname)" = "Darwin" ]; then stamp() { stat -f "%m %z" "$DOC"; }; else stamp() { stat -c "%Y %s" "$DOC"; }; fi
echo "watching $DOC — ctrl-c to stop"
LAST="$(stamp)"
while true; do
  sleep 1
  NOW="$(stamp)"
  [ "$NOW" = "$LAST" ] && continue
  LAST="$NOW"
  exec "$0" "${ARGS[@]}"
done
