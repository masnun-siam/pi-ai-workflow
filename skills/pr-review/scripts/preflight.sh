#!/usr/bin/env bash
# Preflight for pr-review. Verifies the gh CLI is present and authenticated,
# resolves a PR reference in any of the three common forms, and reports whether
# the user can actually post a review. Prints shell-eval-able KEY=VALUE lines.
#
# Usage: bash preflight.sh <pr-ref>
#   pr-ref: 482 | https://github.com/owner/repo/pull/482 | owner/repo#482

set -uo pipefail

fail() { printf 'PREFLIGHT=fail\nERROR=%s\n' "$1" >&2; exit 1; }

PR_REF="${1:-}"
[ -n "$PR_REF" ] || fail "No PR reference given. Pass a number, URL, or owner/repo#number."

# --- gh presence and auth: the hard gate ------------------------------------
command -v gh >/dev/null 2>&1 || fail "gh CLI not installed. Install from https://cli.github.com then run 'gh auth login'."

if ! gh auth status >/dev/null 2>&1; then
  fail "gh is not authenticated. Run 'gh auth login' and retry. This skill cannot review a PR without it."
fi

command -v git >/dev/null 2>&1 || fail "git not installed."

# --- parse the reference ----------------------------------------------------
OWNER=""; REPO=""; NUMBER=""

if [[ "$PR_REF" =~ ^https?://[^/]+/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
  OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"; NUMBER="${BASH_REMATCH[3]}"
elif [[ "$PR_REF" =~ ^([^/]+)/([^#]+)#([0-9]+)$ ]]; then
  OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"; NUMBER="${BASH_REMATCH[3]}"
elif [[ "$PR_REF" =~ ^#?([0-9]+)$ ]]; then
  NUMBER="${BASH_REMATCH[1]}"
  SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) \
    || fail "Got PR number $NUMBER but no repo context. Run from inside the repo, or pass a full URL."
  OWNER="${SLUG%%/*}"; REPO="${SLUG##*/}"
else
  fail "Could not parse PR reference '$PR_REF'."
fi

SLUG="$OWNER/$REPO"

# --- resolve the PR itself --------------------------------------------------
PR_JSON=$(gh pr view "$NUMBER" --repo "$SLUG" \
  --json number,state,isDraft,headRefOid,headRefName,baseRefName,url,author,mergedAt 2>/dev/null) \
  || fail "PR #$NUMBER not found in $SLUG, or no access to that repo."

get() { printf '%s' "$PR_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);v=d.get('$1');print(v if not isinstance(v,dict) else v.get('login',''))"; }

STATE=$(get state); HEAD_SHA=$(get headRefOid); URL=$(get url)
IS_DRAFT=$(get isDraft); MERGED_AT=$(get mergedAt)
HEAD_REF=$(get headRefName); BASE_REF=$(get baseRefName); AUTHOR=$(get author)

# --- can the user post a review? -------------------------------------------
PERM=$(gh api "repos/$SLUG" -q .permissions.push 2>/dev/null || echo "unknown")
CAN_REVIEW="yes"
[ "$PERM" = "false" ] && CAN_REVIEW="no"

cat <<EOF
PREFLIGHT=ok
OWNER=$OWNER
REPO=$REPO
SLUG=$SLUG
NUMBER=$NUMBER
STATE=$STATE
IS_DRAFT=$IS_DRAFT
MERGED_AT=$MERGED_AT
HEAD_SHA=$HEAD_SHA
HEAD_REF=$HEAD_REF
BASE_REF=$BASE_REF
AUTHOR=$AUTHOR
CAN_POST_REVIEW=$CAN_REVIEW
URL=$URL
EOF

# Advisory notes: these are the cases worth pausing on before auto-posting.
[ "$STATE" != "OPEN" ] && echo "NOTE=PR state is $STATE — confirm with the user before posting." >&2
[ "$CAN_REVIEW" = "no" ] && echo "NOTE=No push access to $SLUG; a review may be rejected. Confirm with the user." >&2
exit 0
