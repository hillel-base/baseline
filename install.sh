#!/usr/bin/env bash
# Baseline installer for macOS and Linux. Research use only, not a medical device.
#   curl -fsSL https://raw.githubusercontent.com/hillel-base/baseline/main/install.sh | bash
# Gets the code, runs ./lung.sh setup (uv and Python 3.11, the local page, the packages, the nodule finder, the model weights,
# 8 practice patients; ./lung.sh fetch --all gets all 28), starts the engine on http://localhost:8000 and opens the page.
# lung.sh chooses it: the hosted page in Chrome on a Mac with Chrome, http://localhost:8000 on a Mac without (Safari cannot use
# the hosted page with this engine), the hosted page on Linux. Safe to run again: it updates the code and starts the engine;
# steps already done are skipped.
#   BASELINE_DIR      the folder (default: ~/Baseline)
#   BASELINE_NO_OPEN  1: do not open the browser
#   BASELINE_SOURCE   git address of the code (default: this repository on GitHub)
#   BASELINE_TARBALL  .tar.gz of the code, used when git is missing (default: the main branch on GitHub)
set -euo pipefail

main() {  # in a function, so a cut-off download runs nothing
  local dir="${BASELINE_DIR:-$HOME/Baseline}"
  local source="${BASELINE_SOURCE:-https://github.com/hillel-base/baseline}"
  local tarball="${BASELINE_TARBALL:-https://github.com/hillel-base/baseline/archive/refs/heads/main.tar.gz}"
  say() { printf '\n==> %s\n' "$*"; }
  download() { mkdir -p "$dir" && curl -fsSL "$tarball" | tar -xz -C "$dir" --strip-components 1; }  # data, runs and packages are not in it
  # A Mac without the developer tools has a git that only asks to install them: check without starting it.
  has_git() { command -v git >/dev/null && { [ "$(uname)" != Darwin ] || xcode-select -p >/dev/null 2>&1; }; }

  say "Baseline: lung nodule measurement on CT, a research aid. Folder: $dir"
  if [ -d "$dir/.git" ]; then
    say "Updating the code (git pull)"
    git -C "$dir" pull --ff-only || echo "Could not update the code. Going on with the copy you have."
  elif [ -f "$dir/lung.sh" ]; then
    say "Updating the code (download)"
    download
  else
    say "Getting the code"
    if ! { has_git && git clone --depth 1 "$source" "$dir"; }; then
      echo "git is missing or the clone failed, so the code is downloaded as an archive instead."
      download
    fi
  fi

  say "Installing what is missing, then starting the engine (./lung.sh setup). The first run downloads about 3.5 GB (about 6.5 GB on Linux); later runs download nothing."
  if [ "${BASELINE_NO_OPEN:-}" = 1 ]; then export LUNG_NO_OPEN=1; fi
  exec bash "$dir/lung.sh" setup </dev/null  # not the pipe this script came from
}

main "$@"
