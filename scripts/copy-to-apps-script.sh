#!/usr/bin/env bash
# Copies apps-script/Code.gs to the clipboard, ready to paste over everything in the Apps Script
# editor. First it prints where the copy comes from (the branch and the last commit) and how to
# recognize it (CODE_VERSION, its line count, and the first 12 characters of its SHA-256
# fingerprint). It never prints the code itself.
#
#   scripts/copy-to-apps-script.sh
set -euo pipefail

cd "$(dirname "$0")/.."
FILE="apps-script/Code.gs"
# Tests can set COPY_CMD to something else (for example COPY_CMD=true) to leave the clipboard alone.
COPY_CMD=${COPY_CMD:-pbcopy}

if [ ! -f "$FILE" ]; then
  echo "Can't find $FILE. Run this from inside the case-b-music-studio repo." >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
commit=$(git log -1 --format='%h %s')
version=$(sed -n 's/^var CODE_VERSION = "\(.*\)";.*$/\1/p' "$FILE")
lines=$(wc -l < "$FILE" | tr -d ' ')
sha=$(shasum -a 256 "$FILE" | cut -c1-12)

echo "Branch:        $branch"
echo "Last commit:   $commit"
echo "CODE_VERSION:  ${version:-(not found in Code.gs)}"
echo "Code.gs:       $lines lines, SHA-256 starts $sha"
if ! git diff --quiet HEAD -- "$FILE"; then
  echo "Note:          Code.gs has changes that aren't committed, so it isn't the same as the last commit."
fi

$COPY_CMD < "$FILE"
echo
echo "Code.gs is on your clipboard. In the Apps Script editor: click Code.gs, click inside the code,"
echo "press Cmd+A, then Cmd+V, then Cmd+S. Then run authorize: its first log line should say"
echo "  Code version: $version"
