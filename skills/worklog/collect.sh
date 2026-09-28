#!/usr/bin/env bash
# Fetch a day's GitHub commit/PR/issue activity for the worklog skill.
# Usage: collect.sh [today|yesterday|YYYY-MM-DD]
#
# PRs are the entry point, because `gh search commits` only indexes the
# DEFAULT BRANCH and therefore cannot see feature-branch work at all. Each
# candidate PR is kept only if it carries a non-merge commit you authored
# inside the target day's window, so a stale merge or someone else's review
# comment never resurfaces old work as today's. Commit search is retained
# solely for direct-to-default-branch pushes; anything it finds that has no
# issue reference is surfaced as an "unlinked commit" for the caller to ask
# the user about, rather than being silently dropped.
#
# Emits one JSON object on stdout:
#   { "date", "window", "issues": {...}, "orphanPrs": [...],
#     "unlinkedCommits": [...], "needsConfirm": [...] }
# where each kept PR also carries `commits`: the in-window commits you
# authored on it, so the caller can describe what actually changed.
# or, when nothing happened that day:
#   { "date": "...", "empty": true }
#
# Merged PRs are only included if they have at least one non-merge commit
# authored on the target date — a merge alone is not work. The same test is
# applied to open PRs, whose `updated` timestamp other people can move.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECTS_FILE="$SCRIPT_DIR/projects.json"
TZ_OFFSET="+06:00"   # local timezone this skill assumes (Dhaka, UTC+6)

command -v gh >/dev/null 2>&1 || { echo "gh CLI not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated (run: gh auth login)" >&2; exit 1; }

# Auto-detect the authenticated GitHub username
AUTHOR="$(gh api user --jq '.login' 2>/dev/null)"
[ -z "$AUTHOR" ] && { echo "Could not determine GitHub username" >&2; exit 1; }

# --- resolve target local date ---------------------------------------------
arg="${1:-today}"
case "$arg" in
  today)     target_date="$(date +%Y-%m-%d)" ;;
  yesterday) target_date="$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)" ;;
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) target_date="$arg" ;;
  *) echo "Unrecognized date arg: $arg (use today|yesterday|YYYY-MM-DD)" >&2; exit 1 ;;
esac

# local YYYY-MM-DDT00:00:00+06:00 .. next day 00:00:00+06:00, expressed for gh's
# --updated/--created/--author-date range filters (they accept ISO8601 with offset)
window_start="${target_date}T00:00:00${TZ_OFFSET}"
next_date="$(date -j -v+1d -f "%Y-%m-%d" "$target_date" +%Y-%m-%d 2>/dev/null || date -d "$target_date + 1 day" +%Y-%m-%d)"
window_end="${next_date}T00:00:00${TZ_OFFSET}"
window="${window_start}..${window_end}"
# `authoredDate` from `gh pr view --json commits` is UTC (…Z), so the local
# window above can't be string-compared against it directly. Convert once.
to_utc() { date -u -j -f '%Y-%m-%d %H:%M:%S %z' "$1 00:00:00 ${TZ_OFFSET//:/}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "${1}T00:00:00${TZ_OFFSET}" +%Y-%m-%dT%H:%M:%SZ; }
utc_start="$(to_utc "$target_date")"
utc_end="$(to_utc "$next_date")"

# --- helpers -----------------------------------------------------------------
project_for_repo() {
  local repo="$1"
  jq -r --arg r "$repo" '.[$r] // ($r | split("/")[1])' "$PROJECTS_FILE"
}

# extract #N issue refs from arbitrary text; prints one number per line
extract_issue_nums() {
  grep -oE '#[0-9]+' <<<"${1:-}" | tr -d '#' | sort -un || true
}

refs_file="$(mktemp)"
trap 'rm -f "$refs_file"' EXIT

# --- 1. PRs with commits you authored on this date — the primary signal ------
# `gh search commits` CANNOT be the ground truth here: GitHub's commit search
# indexes only the DEFAULT BRANCH. Work done on a feature branch is invisible
# to it until a squash/release merge lands days later, so an ordinary workday
# of branch commits reads as zero. PRs are the reliable entry point instead —
# every PR carries its own full commit list with authoritative authoredDate
# and authors, which `gh search commits` never sees.
#
# Candidates come from three searches (union, deduped): PRs updated in the
# window, and PRs merged in the window (a second search, because GitHub's
# search index lags on `updated`). Candidacy is not evidence of work — an
# `updated` bump happens on someone else's review comment, and a merge can
# land a branch written last week. Every candidate is then hydrated ONCE and
# kept only if it has >=1 non-merge commit authored by AUTHOR inside the
# window. That single filter replaces the old open/merged special-casing.

pr_search() {  # $1 = search flag (--updated | --merged)
  gh search prs --author "$AUTHOR" "$1" "$window" --limit 100 \
    --json repository,number 2>/dev/null || echo '[]'
}

candidates="$(printf '%s\n%s\n' "$(pr_search --updated)" "$(pr_search --merged)" | jq -sc '
  add | unique_by(.repository.nameWithOwner + "#" + (.number | tostring))
')"

# Commits authored by AUTHOR, in-window, that are not administrative merges.
# A co-authored commit lists several authors, so match with `index` over all
# of them rather than only the first.
TODAYS_COMMITS_FILTER='
  [ .commits[]?
    | select(.authoredDate >= $s and .authoredDate < $e)
    | select(.messageHeadline | startswith("Merge ") | not)
    | select([.authors[]?.login] | index($a) != null) ]'

prs="$(echo "$candidates" | jq -c '.[]' | while read -r c; do
  repo="$(echo "$c" | jq -r '.repository.nameWithOwner')"
  num="$(echo "$c" | jq -r '.number')"
  detail="$(gh pr view "$num" -R "$repo" \
    --json number,title,url,state,body,closingIssuesReferences,commits 2>/dev/null || echo '')"
  [ -z "$detail" ] && continue
  echo "$detail" | jq -c --arg repo "$repo" --arg a "$AUTHOR" \
    --arg s "$utc_start" --arg e "$utc_end" \
    --argjson _ null "
      ($TODAYS_COMMITS_FILTER) as \$mine
      | select(\$mine | length > 0)
      | { repository: {nameWithOwner: \$repo}, number, title, url,
          state: (.state | ascii_downcase), body,
          closingIssues: [.closingIssuesReferences[]?.number],
          commits: [ \$mine[] | {sha: .oid[0:7], message: .messageHeadline} ] }"
done | jq -sc '.')"
[ -z "$prs" ] && prs='[]'

pr_count="$(echo "$prs" | jq 'length')"
commit_count="$(echo "$prs" | jq '[.[].commits | length] | add // 0')"

# --- 2. default-branch commits not already covered by a PR -------------------
# Commit search still earns its keep for one case it CAN see: a commit pushed
# straight to the default branch, with no PR. Anything whose sha or squash-PR
# number is already accounted for above is dropped, so this only ever adds.
pr_numbers="$(echo "$prs" | jq -c '[.[].number]')"
known_shas="$(echo "$prs" | jq -r '.[].commits[].sha')"
unlinked_commits='[]'

commits_raw="$(gh search commits --author "$AUTHOR" --author-date "$target_date" --limit 100 \
  --json repository,sha,commit 2>/dev/null \
  | jq -c '[.[] | select((.commit.message | split("\n")[0]) | test("^Merge (pull request|branch|remote-tracking branch) ") | not)]' \
  || echo '[]')"

while read -r c; do
  [ -z "${c:-}" ] && continue
  # `gh search commits` shapes repository as {fullName}, unlike PR/issue
  # search which uses {nameWithOwner} — the wrong key silently yields null.
  repo="$(echo "$c" | jq -r '.repository.fullName')"
  sha="$(echo "$c" | jq -r '.sha')"
  msg="$(echo "$c" | jq -r '.commit.message')"
  first_line="$(head -1 <<<"$msg")"

  grep -qxF "${sha:0:7}" <<<"$known_shas" && continue

  # squash-merge subject ends in "... (#123)" — that PR is already handled
  squash_n="$(grep -oE '\(#[0-9]+\)[[:space:]]*$' <<<"$first_line" | grep -oE '[0-9]+' || true)"
  if [ -n "$squash_n" ]; then
    [ "$(echo "$pr_numbers" | jq --argjson n "$squash_n" 'index($n) != null')" = "true" ] && continue
  fi

  refs="$(extract_issue_nums "$msg")"
  if [ -n "$refs" ]; then
    for n in $refs; do echo "$repo #$n" >> "$refs_file"; done
    commit_count=$((commit_count + 1))
  else
    entry="$(jq -nc --arg repo "$repo" --arg sha "${sha:0:7}" --arg message "$first_line" \
      --arg url "https://github.com/${repo}/commit/${sha}" --arg project "$(project_for_repo "$repo")" \
      '{repo: $repo, sha: $sha, message: $message, url: $url, project: $project}')"
    unlinked_commits="$(echo "$unlinked_commits" | jq -c --argjson e "$entry" '. + [$e]')"
    commit_count=$((commit_count + 1))
  fi
done < <(echo "$commits_raw" | jq -c '.[]')

# --- 3. issues authored in window (candidates for needsConfirm) -------------
authored_issues="$(gh search issues --author "$AUTHOR" --created "$window" --limit 100 \
  --json repository,number,title,url,state 2>/dev/null || echo '[]')"

# --- 4. refs from the final PR set (title / closingIssues) ------------------
# Body text is prose, not a resolution record — it routinely name-drops other
# issues for context ("written for #5724", "since PR #1415") without the PR
# actually addressing them. Only the title and GitHub's own
# closingIssuesReferences are authoritative signals of what a PR resolves.
echo "$prs" | jq -c '.[]' | while read -r pr; do
  repo="$(echo "$pr" | jq -r '.repository.nameWithOwner')"
  title="$(echo "$pr" | jq -r '.title')"
  closing="$(echo "$pr" | jq -r '.closingIssues[]?')"
  for n in $closing; do echo "$repo #$n"; done
  for n in $(extract_issue_nums "$title"); do echo "$repo #$n"; done
done >> "$refs_file"

sort -u "$refs_file" -o "$refs_file"

# --- 5. hydrate every referenced issue (repo#n), cached, once ----------------
issues_json='{}'
while read -r repo n; do
  [ -z "${repo:-}" ] && continue
  n="${n#\#}"
  key="${repo}#${n}"
  detail="$(gh issue view "$n" -R "$repo" --json number,title,url,state 2>/dev/null || echo '')"
  [ -z "$detail" ] && continue
  project="$(project_for_repo "$repo")"
  # Attach the PRs that resolve this issue, each with the commits you
  # authored in-window. Without this the issue title is all the caller has
  # to describe the day, which says what was WANTED, not what was DONE.
  issue_prs="$(echo "$prs" | jq -c --arg repo "$repo" --argjson n "$n" '
    [ .[]
      | select(.repository.nameWithOwner == $repo)
      | select((.closingIssues | index($n)) != null
               or (.title | test("#" + ($n | tostring) + "(\\D|$)")))
      | {number, title, url, state, commits} ]')"
  issues_json="$(echo "$issues_json" | jq -c --arg k "$key" --arg repo "$repo" --arg project "$project" \
    --argjson d "$detail" --argjson prs "$issue_prs" \
    '.[$k] = ($d + {repo: $repo, project: $project, prs: $prs})')"
done < "$refs_file"

# --- 6. orphan PRs: PRs with zero issue refs of their own -------------------
orphan_prs='[]'
while read -r pr; do
  repo="$(echo "$pr" | jq -r '.repository.nameWithOwner')"
  title="$(echo "$pr" | jq -r '.title')"
  closing="$(echo "$pr" | jq -r '.closingIssues[]?')"
  refcount=0
  [ -n "$closing" ] && refcount=$((refcount + $(echo "$closing" | wc -l)))
  refcount=$((refcount + $(extract_issue_nums "$title" | wc -l)))
  if [ "$refcount" -eq 0 ]; then
    project="$(project_for_repo "$repo")"
    entry="$(echo "$pr" | jq -c --arg project "$project" \
      '{repository: .repository.nameWithOwner, number, title, url, state,
        commits, project: $project}')"
    orphan_prs="$(echo "$orphan_prs" | jq -c --argjson e "$entry" '. + [$e]')"
  fi
done < <(echo "$prs" | jq -c '.[]')

# --- 7. needsConfirm: authored issues not already covered by a ref ----------
covered_keys="$(echo "$issues_json" | jq -r 'keys[]')"
needs_confirm="$(echo "$authored_issues" | jq -c '.[]' | while read -r iss; do
  repo="$(echo "$iss" | jq -r '.repository.nameWithOwner')"
  num="$(echo "$iss" | jq -r '.number')"
  key="${repo}#${num}"
  if ! grep -qxF "$key" <<<"$covered_keys"; then
    project="$(project_for_repo "$repo")"
    echo "$iss" | jq -c --arg project "$project" '. + {project: $project}'
  fi
done | jq -sc '.')"
[ -z "$needs_confirm" ] && needs_confirm='[]'

# --- 8. empty-day short circuit ----------------------------------------------
# A day is empty only when NONE of the three independent signals fired. The
# PR count has to be in here: `commit_count` alone let a day with seven live
# PRs report empty, because commit search can't see feature-branch commits.
confirm_count="$(echo "$needs_confirm" | jq 'length')"

if [ "$pr_count" -eq 0 ] && [ "$commit_count" -eq 0 ] && [ "$confirm_count" -eq 0 ]; then
  jq -nc --arg date "$target_date" '{date: $date, empty: true}'
  exit 0
fi

jq -nc \
  --arg date "$target_date" \
  --arg window "$window" \
  --argjson issues "$issues_json" \
  --argjson orphanPrs "$orphan_prs" \
  --argjson unlinkedCommits "$unlinked_commits" \
  --argjson needsConfirm "$needs_confirm" \
  '{date: $date, window: $window, issues: $issues, orphanPrs: $orphanPrs,
    unlinkedCommits: $unlinkedCommits, needsConfirm: $needsConfirm}'
