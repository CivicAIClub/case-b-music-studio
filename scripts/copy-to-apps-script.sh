#!/usr/bin/env bash
# Copies one file to the clipboard, ready to paste over everything in the Apps Script editor.
# It never prints the file itself: only where it came from and fingerprints to check it by.
#
#   scripts/copy-to-apps-script.sh code   apps-script/Code.gs  → the editor's Code.gs
#                                          (also what it does with no word after it)
#   scripts/copy-to-apps-script.sh page   builds the website (npm run build:gas) and copies
#                                          dist-gas/Index.html  → the editor's HTML file "Index"
set -euo pipefail

cd "$(dirname "$0")/.."
# Tests can set COPY_CMD to something else (for example COPY_CMD=true) to leave the clipboard alone.
COPY_CMD=${COPY_CMD:-pbcopy}
WHAT=${1:-code}

branch=$(git rev-parse --abbrev-ref HEAD)
commit=$(git log -1 --format='%h %s')

case "$WHAT" in
  code)
    FILE="apps-script/Code.gs"
    if [ ! -f "$FILE" ]; then
      echo "Can't find $FILE. Run this from inside the case-b-music-studio repo." >&2
      exit 1
    fi
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
    ;;
  page)
    FILE="dist-gas/Index.html"
    echo "Building the website for Google hosting (npm run build:gas)..."
    npm run --silent build:gas > /dev/null
    bytes=$(wc -c < "$FILE" | tr -d ' ')
    sha=$(shasum -a 256 "$FILE" | cut -c1-12)
    echo "Branch:        $branch"
    echo "Last commit:   $commit"
    echo "Index.html:    $((bytes / 1024)) KB ($bytes bytes), SHA-256 starts $sha"
    if ! git diff --quiet HEAD -- src index.html vite.config.ts package.json; then
      echo "Note:          the website has changes that aren't committed, so this page isn't the same as the last commit."
    fi
    $COPY_CMD < "$FILE"
    echo
    echo "Index.html is on your clipboard. In the Apps Script editor: if there's no file named Index yet,"
    echo "click + next to Files, choose HTML, type Index (no .html) and press Enter. Then click inside it,"
    echo "press Cmd+A, then Cmd+V, then Cmd+S."
    ;;
  *)
    echo "Use: scripts/copy-to-apps-script.sh code   (Code.gs)" >&2
    echo "  or scripts/copy-to-apps-script.sh page   (the website, as the HTML file Index)" >&2
    exit 1
    ;;
esac
