#!/usr/bin/env bash
# Lung tumour measurement tool (research use only): ./lung.sh setup | start | fetch --all
# setup installs what is missing, then starts. fetch --all adds the other 20 practice patients (28 in all). Each phase is skipped when already done. Log: runs/setup-<UTC>.jsonl
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUNG_DATA_DIR="${LUNG_DATA_DIR:-$ROOT/data/rider}"
RUNS="${LUNG_RUNS_DIR:-$ROOT/runs}"
WEIGHTS="${NNINTERACTIVE_MODEL_DIR:-$HOME/.nninteractive}"
LOG="${LUNG_SETUP_LOG:-$RUNS/setup-$(date -u +%Y%m%dT%H%M%SZ).jsonl}"
PORT="${LUNG_PORT:-8000}"
export PATH="$HOME/.local/bin:$PATH"  # where Astral's installer puts uv

iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
bytes() { [ -e "$1" ] && echo $(( $(du -sk "$1" | cut -f1) * 1024 )) || echo 0; }

log_machine() {
  local cpu mem os
  if [ "$(uname)" = Darwin ]; then
    cpu=$(sysctl -n machdep.cpu.brand_string); mem=$(( $(sysctl -n hw.memsize) / 1073741824 )); os="macOS $(sw_vers -productVersion)"
  else
    cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//' || true)
    mem=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 )); os=$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}")
  fi
  local free; free=$(( $(df -Pk "$ROOT" | awk 'NR==2 {print $4}') / 1048576 ))
  printf '{"type":"machine","cpu":"%s","machine":"%s","memory_gb":%s,"os":"%s","free_disk_gb":%s}\n' "${cpu//\"/}" "$(uname -m)" "$mem" "${os//\"/}" "$free" >> "$LOG"
}

# phase NAME SKIPPED BYTES START_EPOCH START_ISO
log_phase() {
  local end; end=$(date +%s)
  printf '{"type":"phase","phase":"%s","start":"%s","end":"%s","seconds":%s,"bytes_downloaded":%s,"skipped":%s}\n' \
    "$1" "$5" "$(iso)" "$(( end - $4 ))" "$3" "$2" >> "$LOG"
}

node_ok() {
  command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a==22&&b>=12)?0:1)'
}

api_up() { curl -fs "http://localhost:$PORT/api/scans" >/dev/null 2>&1; }

phase_prerequisites() {
  local t0 s0 skipped=true; t0=$(date +%s); s0=$(iso)
  if ! command -v uv >/dev/null; then
    skipped=false; echo "Installing uv (Astral's installer)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  if page_stale; then
    skipped=false
    if node_ok; then
      build_page
    else
      download_page
    fi
  fi
  log_phase prerequisites $skipped "$PAGE_BYTES" "$t0" "$s0"
}

# The local page carries the version it was built or downloaded for (web/dist/.page-version), so an update to a new
# version builds or downloads it again; a page with no stamp (an install before 0.1.3) counts as old.
page_stale() {
  [ -f "$ROOT/web/dist/index.html" ] || return 0
  [ -f "$ROOT/VERSION" ] || return 1
  [ "$(cat "$ROOT/web/dist/.page-version" 2>/dev/null)" != "$(cat "$ROOT/VERSION")" ]
}
stamp_page() {
  if [ -f "$ROOT/VERSION" ] && [ -d "$ROOT/web/dist" ]; then cp "$ROOT/VERSION" "$ROOT/web/dist/.page-version"; fi
}

# With Node: the page is built here. A page already here (an update) is set aside first, so a failed build (npm down for a
# while) keeps it and the tool still starts; on a first install a failed build stops setup, as before.
build_page() {
  local old="$ROOT/web/dist.old"
  rm -rf "$old"
  if [ -f "$ROOT/web/dist/index.html" ]; then mv "$ROOT/web/dist" "$old"; fi
  if (cd "$ROOT/web" && npm ci && npm run build); then  # npm_config_registry, if set, is passed through
    stamp_page
    rm -rf "$old"
  elif [ -d "$old" ]; then
    rm -rf "$ROOT/web/dist"; mv "$old" "$ROOT/web/dist"
    echo "Could not rebuild the local page; the old one stays. Run the same command again later."
  else
    echo "Could not build the local page (the error is above). Run ./lung.sh setup again." >&2
    exit 1
  fi
}

# Without Node: the built page from the release of this version. A failed download is not fatal: the hosted page still works.
PAGE_BYTES=0
download_page() {
  local url="${BASELINE_PAGE_URL:-https://github.com/hillel-base/baseline/releases/download/v$(cat "$ROOT/VERSION" 2>/dev/null)/baseline-page.zip}" tmp
  tmp=$(mktemp -d)
  echo "Node 22.12 or newer was not found, so the local page is downloaded instead: $url"
  if curl -fsSL "$url" -o "$tmp/page.zip" \
    && { unzip -q "$tmp/page.zip" -d "$tmp/x" 2>/dev/null || uv run --no-project python -I -m zipfile -e "$tmp/page.zip" "$tmp/x"; } \
    && [ -f "$tmp/x/dist/index.html" ]; then
    local old="$ROOT/web/dist.old"  # the old page is set aside, not deleted, until the new one is in place
    rm -rf "$old"
    if [ -d "$ROOT/web/dist" ]; then mv "$ROOT/web/dist" "$old"; fi
    if mv "$tmp/x/dist" "$ROOT/web/dist"; then
      rm -rf "$old"
      stamp_page
      PAGE_BYTES=$(wc -c < "$tmp/page.zip" | tr -d ' ')
      echo "Local page: downloaded (commit $(cat "$tmp/x/COMMIT" 2>/dev/null || echo unknown))."
    else
      rm -rf "$ROOT/web/dist"
      if [ -d "$old" ]; then mv "$old" "$ROOT/web/dist"; fi
      echo "Could not put the downloaded page in place, so the old one stays. Run ./lung.sh setup again later."
    fi
  elif [ -f "$ROOT/web/dist/index.html" ]; then
    echo "Could not download the new local page, so the old one stays. The hosted page works without it. Run ./lung.sh setup again later, or install Node 22.12 or newer from https://nodejs.org (or: brew install node)."
  else
    echo "Could not download the local page, so http://localhost:$PORT shows no page. The hosted page works without it. Run ./lung.sh setup again later, or install Node 22.12 or newer from https://nodejs.org (or: brew install node)."
  fi
  rm -rf "$tmp"
}

phase_python_engine() {
  local t0 s0 skipped=true v0; t0=$(date +%s); s0=$(iso)
  [ -f "$ROOT/engine/.venv/pyvenv.cfg" ] || skipped=false
  v0=$(bytes "$ROOT/engine/.venv")
  uv sync --directory "$ROOT/engine"  # a no-op when up to date; uv fetches Python 3.11 itself
  # bytes = size added to engine/.venv (installed size, not the download size)
  log_phase python_engine $skipped $(( $(bytes "$ROOT/engine/.venv") - v0 )) "$t0" "$s0"
}

# The nodule finder (AGPL-3.0, finder/), on by default: its own packages in finder/.venv. start turns it on only when the marker
# says they installed and load here; without it the tool works, with no finder.
FINDER_OK="$ROOT/finder/.venv/lung-finder-ok"
FINDER_NOTE=""  # setup's line when the finder is off, repeated after "Tool is running" so it does not scroll away
phase_finder() {
  local t0 s0 skipped=true v0; t0=$(date +%s); s0=$(iso)
  [ -f "$FINDER_OK" ] || skipped=false
  v0=$(bytes "$ROOT/finder/.venv")
  rm -f "$FINDER_OK"
  if ! uv sync --directory "$ROOT/finder"; then
    FINDER_NOTE="The nodule finder is off: it could not be installed (no internet, or a full disk?). The tool works without it. Run ./lung.sh setup again later to add it."
  elif ! YOLO_OFFLINE=1 "$ROOT/finder/.venv/bin/python" -c "import cv2, ultralytics"; then  # as space/start.sh: a missing system library shows here
    FINDER_NOTE="The nodule finder is off: its packages installed but do not load (the error is above). On Linux this is usually a missing system library such as libxcb or libGL (Debian and Ubuntu: sudo apt install libxcb1 libx11-6 libxext6 libsm6 libice6 libgl1 libglib2.0-0). The tool works without it. See \"Nodule finder\" in README.md, then run ./lung.sh setup again."
  else
    : > "$FINDER_OK"
  fi
  if [ -n "$FINDER_NOTE" ]; then echo "$FINDER_NOTE"; fi
  log_phase finder $skipped $(( $(bytes "$ROOT/finder/.venv") - v0 )) "$t0" "$s0"
}

phase_model_weights() {
  local t0 s0 skipped=true b0; t0=$(date +%s); s0=$(iso)
  b0=$(bytes "$WEIGHTS")
  if [ ! -d "$WEIGHTS/models" ] || [ -z "$(ls -A "$WEIGHTS/models" 2>/dev/null)" ]; then
    skipped=false; echo "Fetching the model weights (about 400 MB)..."
    uv run --directory "$ROOT/engine" python -m lung_engine.fetch --weights
  fi
  log_phase model_weights $skipped $(( $(bytes "$WEIGHTS") - b0 )) "$t0" "$s0"
}

phase_scans() {
  local t0 s0 b0 out; t0=$(date +%s); s0=$(iso)
  b0=$(bytes "$LUNG_DATA_DIR")
  out=$(uv run --directory "$ROOT/engine" python -m lung_engine.fetch --data "$LUNG_DATA_DIR" | tee /dev/stderr)
  local skipped=false; [[ $out == *"nothing to download"* ]] && skipped=true
  log_phase scans $skipped $(( $(bytes "$LUNG_DATA_DIR") - b0 )) "$t0" "$s0"
}

start_engine() {
  local t0 s0 skipped=true; t0=$(date +%s); s0=$(iso)
  if ! api_up; then
    skipped=false
    (cd "$ROOT/engine" && exec uv run uvicorn lung_engine.app:create_app --factory --port $PORT --no-access-log) &
    ENGINE_PID=$!
    trap '[ -n "${ENGINE_PID:-}" ] && kill "$ENGINE_PID" 2>/dev/null' INT TERM EXIT  # own PID only
    until api_up; do
      kill -0 "$ENGINE_PID" 2>/dev/null || { echo "The engine stopped before it was ready; see the messages above." >&2; exit 1; }
      sleep 1
    done
  fi
  log_phase engine_start $skipped 0 "$t0" "$s0"
}

# Safari blocks an https page from reaching http://localhost, so a Mac without Chrome gets the local page (Safari can use it).
has_chrome() { [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; }
mac_without_chrome() { [ "$(uname)" = Darwin ] && ! has_chrome; }

# LUNG_PAGE_URL if set; a Mac without Chrome: the local page (when it exists); else the hosted page, which uses this engine by itself.
page_url() {
  if [ -n "${LUNG_PAGE_URL:-}" ]; then echo "$LUNG_PAGE_URL"
  elif mac_without_chrome && [ -f "$ROOT/web/dist/index.html" ]; then echo "http://localhost:$PORT"
  else echo "https://lung-measure.base44.app/?engine=local"; fi
}

open_page() {
  local t0 s0 skipped=true url mac_hosted=false; t0=$(date +%s); s0=$(iso); url=$(page_url)
  if [ "$(uname)" = Darwin ] && [[ $url == https://lung-measure.base44.app/* ]]; then mac_hosted=true; fi
  if [ "${LUNG_NO_OPEN:-}" != 1 ]; then
    skipped=false; echo "Opening $url"
    { { $mac_hosted && has_chrome && open -a "Google Chrome" "$url"; } || open "$url" || xdg-open "$url"; } >/dev/null 2>&1 || echo "Open $url in your browser."
  else
    echo "The page: $url"
  fi
  if $mac_hosted; then
    if [ -f "$ROOT/web/dist/index.html" ]; then
      echo "Safari: the Base44 page cannot reach the engine on your computer (Safari blocks it). Use Chrome or Firefox, open http://localhost:$PORT, or use the practice server."
    else
      echo "Safari: the Base44 page cannot reach the engine on your computer (Safari blocks it). Use Chrome or Firefox, or use the practice server."
    fi
  fi
  log_phase page_open $skipped 0 "$t0" "$s0"
}

start() {
  mkdir -p "$RUNS"; [ -f "$LOG" ] || : > "$LOG"
  ENGINE_PID=""
  if [ -f "$FINDER_OK" ]; then export LUNG_FINDER="${LUNG_FINDER-subprocess}"; fi  # the nodule finder, once setup checked it; LUNG_FINDER= keeps it off
  start_engine
  echo "Tool is running at http://localhost:$PORT"
  if [ -n "$FINDER_NOTE" ]; then echo "$FINDER_NOTE"; fi
  open_page
  echo "Setup log: $LOG"
  if [ -n "$ENGINE_PID" ]; then echo "The engine runs until you press Ctrl+C or close this window."; wait "$ENGINE_PID"; fi
}

case "${1:-}" in
  setup)
    mkdir -p "$RUNS"; : > "$LOG"; log_machine
    phase_prerequisites; phase_python_engine; phase_finder; phase_model_weights; phase_scans
    start ;;
  start) start ;;
  fetch) shift; uv run --directory "$ROOT/engine" python -m lung_engine.fetch --data "$LUNG_DATA_DIR" "$@" ;;
  *) echo "Usage: ./lung.sh setup | start | fetch --all" >&2; exit 2 ;;
esac
