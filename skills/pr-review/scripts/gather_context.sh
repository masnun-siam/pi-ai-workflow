#!/usr/bin/env bash
# Collects everything needed to review a PR into one directory, so the review
# passes read files instead of re-deriving gh invocations.
#
# Usage: bash gather_context.sh <pr-ref> <outdir>

set -uo pipefail

PR_REF="${1:-}"; OUT="${2:-}"
[ -n "$PR_REF" ] && [ -n "$OUT" ] || { echo "usage: gather_context.sh <pr-ref> <outdir>" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRE=$(bash "$HERE/preflight.sh" "$PR_REF") || exit 1
eval "$PRE"

mkdir -p "$OUT/issues"
echo "$PRE" > "$OUT/preflight.env"

echo "Gathering $SLUG#$NUMBER into $OUT ..."

# --- PR metadata, commits, files, diff, existing review comments ------------
gh pr view "$NUMBER" --repo "$SLUG" \
  --json number,title,body,author,state,isDraft,url,baseRefName,headRefName,headRefOid,labels,additions,deletions,changedFiles,closingIssuesReferences,reviewDecision,createdAt \
  > "$OUT/pr.json"

gh api "repos/$SLUG/pulls/$NUMBER/commits" --paginate \
  -q '[.[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]' \
  > "$OUT/commits.json"

gh api "repos/$SLUG/pulls/$NUMBER/files" --paginate \
  -q '[.[] | {path: .filename, status: .status, additions: .additions, deletions: .deletions, previous: .previous_filename}]' \
  > "$OUT/files.json"

gh pr diff "$NUMBER" --repo "$SLUG" > "$OUT/diff.patch"

gh api "repos/$SLUG/pulls/$NUMBER/comments" --paginate \
  -q '[.[] | {user: .user.login, path: .path, line: .line, body: .body}]' \
  > "$OUT/existing_comments.json" 2>/dev/null || echo '[]' > "$OUT/existing_comments.json"

gh api "repos/$SLUG/issues/$NUMBER/comments" --paginate \
  -q '[.[] | {user: .user.login, body: .body}]' \
  > "$OUT/pr_discussion.json" 2>/dev/null || echo '[]' > "$OUT/pr_discussion.json"

# --- linked issues, from all three places teams put them --------------------
# 1) GitHub's linked-issues field  2) closing keywords in the PR body
# 3) bare references in commit messages
python3 - "$OUT" <<'PY' > "$OUT/issue_numbers.txt"
import json, re, sys
out = sys.argv[1]
nums = set()

pr = json.load(open(f"{out}/pr.json"))
for ref in (pr.get("closingIssuesReferences") or []):
    if ref.get("number"): nums.add(int(ref["number"]))

kw = re.compile(r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+#(\d+)', re.I)
plain = re.compile(r'(?:^|[\s(\[])(?:GH-|#)(\d+)\b')

for m in kw.finditer(pr.get("body") or ""): nums.add(int(m.group(1)))
for m in plain.finditer(pr.get("body") or ""): nums.add(int(m.group(1)))

for c in json.load(open(f"{out}/commits.json")):
    msg = c.get("message") or ""
    for m in kw.finditer(msg): nums.add(int(m.group(1)))
    for m in plain.finditer(msg): nums.add(int(m.group(1)))

nums.discard(int(pr["number"]))
print("\n".join(str(n) for n in sorted(nums)))
PY

FOUND=0; DANGLING=""
while read -r n; do
  [ -z "$n" ] && continue
  if gh api "repos/$SLUG/issues/$n" \
       -q '{number: .number, title: .title, body: .body, state: .state, labels: [.labels[].name], is_pr: (has("pull_request"))}' \
       > "$OUT/issues/$n.json" 2>/dev/null; then
    gh api "repos/$SLUG/issues/$n/comments" --paginate \
      -q '[.[] | {user: .user.login, body: .body}]' > "$OUT/issues/$n.comments.json" 2>/dev/null || true
    FOUND=$((FOUND+1))
  else
    rm -f "$OUT/issues/$n.json"
    DANGLING="$DANGLING $n"
  fi
done < "$OUT/issue_numbers.txt"

[ -n "$DANGLING" ] && echo "$DANGLING" > "$OUT/dangling_issue_refs.txt"

# --- local checkout of the head, needed for the DRY / SOLID passes ----------
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
CHECKOUT="none"
if [ -n "$REPO_ROOT" ] && git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | grep -qi "$REPO"; then
  git -C "$REPO_ROOT" fetch -q origin "pull/$NUMBER/head:pr-review-$NUMBER" 2>/dev/null \
    || git -C "$REPO_ROOT" fetch -q origin "pull/$NUMBER/head" 2>/dev/null || true
  CHECKOUT="$REPO_ROOT"
else
  CLONE="$OUT/repo"
  if [ ! -d "$CLONE/.git" ]; then
    gh repo clone "$SLUG" "$CLONE" -- -q 2>/dev/null || true
  fi
  if [ -d "$CLONE/.git" ]; then
    git -C "$CLONE" fetch -q origin "pull/$NUMBER/head" 2>/dev/null || true
    git -C "$CLONE" checkout -q FETCH_HEAD 2>/dev/null || true
    CHECKOUT="$CLONE"
  fi
fi
echo "CHECKOUT=$CHECKOUT" >> "$OUT/preflight.env"

cat <<EOF

Bundle ready: $OUT
  pr.json  commits.json  files.json  diff.patch  existing_comments.json
  linked issues fetched: $FOUND$([ -n "$DANGLING" ] && echo "   dangling refs:$DANGLING")
  local checkout for DRY/SOLID passes: $CHECKOUT

Read pr.json and every issues/*.json before forming an opinion.
$([ "$CHECKOUT" = "none" ] && echo "WARNING: no local checkout — the DRY pass cannot search outside the diff. Fix this before reviewing.")
EOF
