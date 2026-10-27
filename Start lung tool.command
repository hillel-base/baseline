#!/usr/bin/env bash
# Double-click on a Mac: installs what is missing (skipped when already done), then starts the tool. Research use only.
cd "$(dirname "$0")" || exit 1
if ! bash ./lung.sh setup; then
  echo
  echo "Something went wrong. Read the message above (the README has the fixes), then close this window."
  read -r -p "Press Return to close. " _
  exit 1
fi
