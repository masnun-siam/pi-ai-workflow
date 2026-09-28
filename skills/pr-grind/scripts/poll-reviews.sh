#!/usr/bin/env bash
# Monitor poll for /pr-grind: emit one line per NEW review by the reviewer account.
#
# Usage: poll-reviews.sh <owner> <repo> <number> <login> <last-iso> [mode] [interval]
#   login  the reviewer account, or the PR author when the reviewer is UNRESOLVED
#   mode   "reviewer" (default, login==) or "not-author" (login!=)
#
# Emits `<submitted_at> id=<id> state=<STATE>` and nothing else. That restraint is the
# whole point: piping a review `body` through a second jq pass fails on the control
# characters inside a fenced code block, and Monitor only turns STDOUT into
# notifications — a script that errors every tick looks exactly like "nothing new yet".
# So: scalar fields only, and stderr folded into stdout so a break is visible.

set -uo pipefail

OWNER="${1:?owner}"; REPO="${2:?repo}"; NUMBER="${3:?pr number}"
LOGIN="${4:?reviewer or author login}"; LAST="${5:?last seen ISO8601}"
MODE="${6:-reviewer}"; INTERVAL="${7:-60}"

if [ "$MODE" = "not-author" ]; then
  MATCH='select(.user.login != $ENV.LOGIN)'
else
  MATCH='select(.user.login == $ENV.LOGIN)'
fi

export LOGIN LAST

while true; do
  # `gh api --jq` takes one filter string and no jq flags of its own — `--arg name val`
  # is parsed as unknown gh flags and errors. Values reach the filter via $ENV.
  out=$(gh api "repos/$OWNER/$REPO/pulls/$NUMBER/reviews" --paginate --jq "
    .[] | $MATCH | select(.submitted_at > \$ENV.LAST) |
    \"\(.submitted_at) id=\(.id) state=\(.state)\"
  " 2>&1)

  if [ -n "$out" ]; then
    echo "$out"
    newest=$(echo "$out" | awk '{print $1}' | sort | tail -1)
    case "$newest" in
      20*) export LAST="$newest" ;;   # only advance on something that parses as a date;
      *) : ;;                          # an error line must not become the new cutoff
    esac
  fi
  sleep "$INTERVAL"
done
