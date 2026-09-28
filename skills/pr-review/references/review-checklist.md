# Review checklist

Detailed criteria for the six passes in SKILL.md. Read the pass you're working on; you don't need all of it in context at once.

- [1. Intent vs. implementation](#1-intent-vs-implementation)
- [2. Commit hygiene](#2-commit-hygiene)
- [3. Comments: WHY not WHAT](#3-comments-why-not-what)
- [4. DRY across the whole codebase](#4-dry-across-the-whole-codebase)
- [5. SOLID and design](#5-solid-and-design)
- [6. Security](#6-security)
- [7. Things that are not your job](#7-things-that-are-not-your-job)
- [8. When to escalate to a human](#8-when-to-escalate-to-a-human)

---

## 1. Intent vs. implementation

The linked issues are the specification. Build a table before reading the diff closely:

| Criterion (from issue #N) | Where satisfied | Verdict |
|---|---|---|

Extract criteria from the issue body — acceptance criteria lists, bullet requirements, "should" statements, reproduction steps for a bug — and from issue comments, where scope is frequently renegotiated after the description was written. An issue whose comments say "let's skip the email part for now" has different criteria than its body suggests.

What to look for:

- **Unmet criterion.** The single most valuable finding available. Issue asks for rate limiting per-account; diff implements it per-IP. That's not a nit, that's the feature not existing.
- **Partially met.** Handles the happy path described in the issue but not the error case the issue also described.
- **Bug fix without a regression test.** If the issue is a bug report with reproduction steps, look for a test encoding those steps. Its absence is a should-fix: nothing stops the bug returning.
- **Unrequested scope.** Code in the diff that no issue or PR description asked for. A refactor smuggled into a bug fix makes the PR hard to review and hard to revert. Worth a comment, phrased as a question — sometimes it was genuinely necessary, and the fix is to say so in the PR description.
- **Dangling issue references.** A commit says `Fixes #204` and #204 doesn't exist or is unrelated. Usually a typo, occasionally a sign of a cherry-pick from another repo.
- **Stale PR description.** Body describes an approach the code no longer takes. Cheap to fix, and it's what the next person reads in six months.

When the PR has no linked issue at all, review against the PR description and say in the summary that intent couldn't be verified against a tracked requirement. Don't invent requirements from the code's shape — that just launders your assumptions into authoritative-sounding review comments.

---

## 2. Commit hygiene

Commit messages are the only durable record of *why*. Judge them on whether a maintainer bisecting to this commit in a year would understand the reasoning.

Flag:

- **Subjects that restate the diff.** `update user.py`, `fix bug`, `changes`, `wip`, `asdf`. The diff already says what changed.
- **Body-less commits for non-obvious changes.** A one-line subject is fine for a typo fix. A change to retry semantics needs a body explaining what went wrong before.
- **Review-churn commits.** `address review comments`, `fix lint`, `oops` — these belong squashed. Say so once in the summary, not once per commit.
- **Missing issue linkage** when the repo's other commits consistently include it. Match the repo's existing convention rather than imposing one; check `git log --oneline -50` for the house style before commenting.
- **Mixed concerns in one commit.** A commit doing a rename *and* a logic change can't be reverted cleanly.

Conversely, notice good history and don't comment on it. If the messages are solid, one clause in the summary is enough.

Commit findings go in the **summary body**, never inline: they're properties of the history, and there's no diff line to attach them to.

---

## 3. Comments: WHY not WHAT

The rule: a comment should tell the reader something the code cannot. Code says what it does; comments explain why it does it that way.

### Flag these

**Narration.** Restates the adjacent line.
```python
# increment the counter
counter += 1
# loop over users
for user in users:
```

**Redundant docstrings.** Repeats the signature with no added information.
```python
def get_user_by_id(user_id: int) -> User:
    """Gets a user by id.

    Args:
        user_id: The user id.
    Returns:
        The user.
    """
```
The types already say this. A docstring earns its place by documenting raised exceptions, side effects, units, or valid ranges.

**Commented-out code.** Version control remembers; the file shouldn't. Always flag, always safe to delete.

**Ownerless TODOs.** `# TODO: fix this properly` with no name, date, or issue link becomes permanent. Ask for `# TODO(#412): ...`.

**Section-divider ASCII art** and `# ---- helpers ----` banners in a file that has no need of them — usually a sign the file should be split instead.

**Long-form rationale essays in the source.** This is the subtle one and worth flagging clearly. A twenty-line comment block narrating design history, alternatives considered, benchmark results, or migration steps does not belong in a source file:

- it drifts out of date silently, because nothing tests a comment;
- it displaces the code, so readers scroll past it;
- it's invisible to anyone browsing the PR or the changelog, which is where people actually look for reasoning.

That content has better homes: the **commit message** for why this change, the **PR description** for how the pieces fit together, a **doc or ADR** for a decision with long-term consequences. Suggest the specific destination in your comment — "this rationale would serve better in the commit message; a one-line pointer here is enough" — because "delete this" reads as dismissing the author's thinking when the actual problem is location.

**Stale comments** that contradict the code they sit above. These are worse than no comment: readers trust them.

### Leave these alone

- A non-obvious constraint: `# must run before cache warm-up or the first request 500s`
- A workaround with a link: `# works around upstream bug: github.com/lib/repo#88`
- A magic number's provenance: `# 4096 = max payload the gateway accepts, per infra runbook`
- Ordering dependencies, thread-safety notes, deliberate deviations from an obvious approach
- Legally or contractually required notices, licence headers, `# noqa` with a reason
- Any comment explaining why the *obvious* implementation was rejected — this is the highest-value comment type there is

Deduplicate before posting. Six narration comments in one file is one summary line pointing at the line numbers, not six inline nits.

---

## 4. DRY across the whole codebase

This pass is what separates this review from a linter, and it's the one that requires the local checkout. The question is not "does this diff repeat itself" — it's **"did this repo already have one of these?"** A new `parse_iso_date` in `handlers/orders.py` is invisible in the diff and obvious to anyone who knows `utils/dates.py` already has one.

### Procedure

For every added function, method, class, constant, type, or config block:

1. **Search by name and by synonym.** The duplicate rarely shares a name.
   ```bash
   git grep -n "def parse_duration" ; git grep -in "duration"
   git grep -rn "to_snake\|snake_case\|camel_to"
   ```
   Build a synonym list per concept: `validate/check/verify/assert`, `parse/decode/deserialize/from_`, `format/render/serialize/to_`, `fetch/get/load/retrieve`, `slugify/normalize/canonicalize`.

2. **Search by distinctive literal.** Regexes, format strings, magic numbers, and error messages are near-unique fingerprints. If the new code contains `r'^\+?[0-9]{7,15}$'`, grep that pattern — a second phone validator almost certainly exists.

3. **Search by call signature and shape.** Same parameter names in the same order, same return type, same three-step body.

4. **Look where such things live in this repo.** `utils/`, `lib/`, `common/`, `helpers/`, `shared/`, `core/`. Read the module index of those packages before accepting any new helper as novel.

5. **Check the dependencies.** A hand-rolled `deep_merge`, `retry_with_backoff`, `chunk_list`, or date parser when `lodash`, `tenacity`, `more-itertools`, or `dateutil` is already in the lockfile. Check the manifest before suggesting a new dependency, and never suggest adding one just to remove five lines.

6. **Copy-paste between new files in the diff.** The plainer case: two handlers with identical validation blocks.

### Reporting

Cite the existing implementation by **file and line** — that's what makes the comment actionable and what proves you actually looked:

> `parse_duration` here duplicates `utils/time.py:31`, which also handles the `1h30m` form this version doesn't. Worth calling that instead so the two don't drift.

If the existing version is subtly different, say how — the author may have written a new one deliberately because the old one was wrong for their case. Ask rather than assert when the difference could be intentional.

### Restraint

Not every similarity is a violation, and over-eager DRY advice does real damage. Two things that look alike but change for different reasons should stay separate; coupling them creates a helper with a boolean flag and two callers that fight over it. Test fixtures and generated code repeat legitimately. Three lines of similar-looking setup is not worth a comment. The cost you're arguing against is *divergence over time* — if two copies drifting apart wouldn't actually be a bug, let them be.

---

## 5. SOLID and design

Report consequences, not principle names. "Violates SRP" tells the author nothing; "this class can't be tested without a live DB connection now" tells them exactly what they broke.

**Single responsibility.** Does the changed unit have more than one reason to change? Practical tests: can you describe it without "and"? Did the diff add a fourth unrelated concern to a class that had three? Consequence to cite: what's now untestable, or what unrelated change will force this file open next.

**Open/closed.** New behaviour added by editing a growing `if/elif` type-switch, when the repo has an established registry or strategy pattern for exactly this. Cite the existing pattern's location — this overlaps with the DRY pass.

**Liskov.** A subclass or interface implementation that narrows accepted input, widens thrown exceptions, or throws `NotImplementedError` for a method callers legitimately use. Anything that makes a caller check the concrete type is a signal.

**Interface segregation.** A new method added to a widely-implemented interface, forcing every implementer to stub it. Count the implementers before commenting — it makes the case concrete.

**Dependency inversion.** Does policy now depend on detail? A domain module importing the HTTP client, the ORM session, or the concrete cache class. Consequence: swapping the detail or testing the policy now requires the whole stack.

Beyond SOLID, worth flagging when the cost is concrete:

- **Error handling:** swallowed exceptions (`except: pass`), catching broad `Exception` where a specific one is meant, errors that lose context on re-raise, retries around non-idempotent operations.
- **Resource lifetime:** files, connections, locks acquired without a `with`/`defer`/`finally`.
- **Concurrency:** shared mutable state added without synchronisation, check-then-act races, blocking I/O inside an async function.
- **API compatibility:** a changed public signature, response field, or DB column with no migration, deprecation, or version bump. Ask who else calls it.
- **Test coverage of the actual change:** not a coverage percentage — does a test exercise the new branch and the failure mode?
- **Performance with a real mechanism:** an N+1 query, an unbounded fetch, a loop that grew a network call. Only comment when you can name the mechanism; speculative "this might be slow" is noise.

---

## 6. Security

The one pass where a lower confidence bar is right. A missed authorization check costs far more than an awkward question, so raise uncertain security findings **as questions**, and mark real ones as blockers — or `critical` if they meet the escalation bar in §8.

**Injection and interpolation.** User-controlled data reaching a SQL string, shell command, template, `eval`, deserializer, file path, or redirect target. Trace the taint from the entry point rather than pattern-matching one line: `f"SELECT * FROM t WHERE id={x}"` is only a finding if `x` can be attacker-influenced — but assume it can unless you can see otherwise.

**Authentication and authorization.** The most common real bug in application PRs, and the easiest to miss because it's an *absence*. For every new endpoint, handler, route, or GraphQL resolver: which decorator, middleware, or guard enforces auth, and where is the check that this *particular* user may touch this *particular* record? Compare against the sibling handlers in the same file — if the other five routes have `@require_role` and the new one doesn't, that's your finding. Watch for IDOR: an ID taken from the request and used to fetch without an ownership check.

**Secrets.** Keys, tokens, passwords, connection strings, private keys, or internal hostnames added to source, tests, fixtures, CI config, or committed `.env` files. Also flag secrets appearing in log statements or error responses. When you find one, say plainly that rotation is needed — removing it from the branch doesn't unpublish it if it was ever pushed. Committed secrets are always `critical` (§8): only someone with infrastructure access can actually resolve one.

**Input validation and output encoding.** Unvalidated size, type, range, or encoding on anything crossing a trust boundary; missing output escaping in templates; `dangerouslySetInnerHTML`, `innerHTML`, `v-html`, `mark_safe` with non-constant input.

**Crypto and randomness.** `random` where `secrets`/`crypto` is required, MD5/SHA1 for passwords or signatures, hand-rolled crypto, hardcoded IVs, ECB mode, non-constant-time comparison of secrets, disabled TLS verification.

**Weakened existing controls.** Diffs that *remove* protection deserve extra scrutiny: a deleted validation, a widened CORS origin, a permission check turned into a warning, a rate limit raised, `verify=False` added, an auth middleware dropped from a route list, a security test skipped. Always ask why; sometimes the answer is good, and when it isn't this is the highest-severity finding in the review. Removal of an existing control is `critical` (§8) rather than a blocker, because a person chose to remove it and a person should confirm that choice.

**Data exposure.** New API response fields or log lines carrying PII, tokens, full card numbers, or internal IDs. Check serializers for `fields = '__all__'`-style blanket exposure.

**Dependencies.** New packages: unfamiliar name, typo-squat resemblance to a popular package, unpinned version, install scripts. Flag the addition for review rather than asserting it's malicious.

**Web and infra specifics.** Missing CSRF protection on state-changing form endpoints, cookies without `HttpOnly`/`Secure`/`SameSite`, SSRF where a user-supplied URL is fetched server-side, path traversal in upload or download handlers, zip-slip in archive extraction, overly permissive IAM or bucket policies in IaC.

---

## 7. Things that are not your job

Skipping these is what makes the rest credible:

- **Formatting the repo's own tooling handles.** Line length, quote style, import order — if there's a Prettier, Black, gofmt, or ESLint config, say nothing. If the code violates it, the CI will say so more cheaply.
- **Rewriting to your stylistic taste.** A different but equivalent structure is not a finding.
- **Broad architectural rewrites.** A PR review is the wrong venue for "this whole module should be event-driven." If it's genuinely important, raise it once in the summary as a suggestion to discuss elsewhere.
- **Anything already flagged** by another reviewer or a CI bot — check `existing_comments.json`.
- **Praise padding.** "Great work overall!" before ten blockers reads as insincere. If something is genuinely well done — a clever test, a tricky edge case handled — say that one specific thing and move on.
- **Speculation dressed as fact.** If you're not sure the code path is reachable, ask whether it is.

---

## 8. When to escalate to a human

Marking a finding `critical` @-mentions the escalation reviewers (**kazi-shahin** and **amims71** by default) at the top of the review and asks them to confirm before merge.

The test is **not** "how bad is this bug." It's: *if I'm wrong about this, or if this ships unnoticed, how hard is it to undo?* A serious logic error that ships and gets reverted an hour later costs an hour. A migration that drops a column costs whatever wasn't backed up. The second one escalates; the first is a blocker.

A second, equally valid trigger: **the judgment isn't yours to make.** Some changes are legitimate but only a person with business context can confirm — a deliberate loosening of a permission, an intentional behaviour change for a customer commitment. Escalating those isn't crying wolf even when the code is correct; it's routing a decision to someone entitled to make it.

### Escalate

- **Irreversible data operations.** Destructive migrations (dropped columns or tables, type narrowing that truncates), backfills or bulk updates with no dry-run or reversal path, deletions without a soft-delete, changes to retention or purge jobs.
- **A security control being weakened or removed.** Deleted auth guard, widened CORS or IAM policy, `verify=False`, a permission check downgraded to a log line, rate limit lifted, security test skipped, auth middleware dropped from a route list. Weakening is different from missing: a route that never had a guard is a blocker; a route that *had* one and now doesn't is critical, because someone chose that.
- **A committed secret.** Always critical, even if the diff also removes it, because the value needs rotating by someone with infrastructure access — a review comment alone doesn't fix it.
- **Money.** Payment flows, billing calculation, pricing, refunds, currency handling, invoicing, anything touching a payment processor. Rounding bugs here are not recoverable by redeploying.
- **Personal data and compliance.** New collection, storage, export, or third-party transmission of PII; changes to consent handling, audit logging, encryption of data at rest, or anything the repo marks as regulated (GDPR/HIPAA/PCI/SOC2).
- **Authentication and session logic.** Token issuance or validation, password handling, session lifetime, MFA, SSO, or the authorization model itself — not merely a route that uses it.
- **Cryptographic changes.** Key handling, algorithm or mode changes, signature verification, anything replacing a vetted library with hand-rolled code.
- **Contracts other people depend on.** A breaking change to a public API, webhook payload, published schema, or event format with no version bump or deprecation path. The blast radius sits outside this repo, where you can't see it.
- **Infrastructure with production reach.** IaC changes to networking, secrets management, or public exposure of a resource; CI/CD changes that alter what gets deployed or who can deploy.
- **Genuine ambiguity with expensive downside.** The issue doesn't settle what the code should do, and both readings are plausible, and guessing wrong is costly. Say plainly what's ambiguous rather than picking a side.

### Don't escalate

- An ordinary bug, however annoying — that's a blocker.
- Missing tests, DRY violations, SOLID smells, comment problems. Never critical, no matter how many there are.
- An unmet acceptance criterion. Blocker: the author fixes it and pushes again.
- Anything you're flagging as a question because you're unsure. Uncertainty is a reason to ask in a normal comment, not to pull two people in. The exception is the ambiguity case above, where the uncertainty is itself the finding *and* the downside is expensive.
- A large or complex PR. Size isn't risk.
- Volume of findings. Twelve blockers is a bad PR, not an escalation.

### Writing the escalation

The reviewers will read the banner and nothing else, so each line has to carry its own weight: what changed, where, and what specifically to confirm. `security: auth.py:88 — removes the @require_role guard added in #310; the linked issue doesn't mention this` tells them what to do. `Critical security issue found` tells them to go read the diff themselves, which is the work you were supposed to save them.

If the author may have had a good reason, say so — "if this is intentional, worth noting why in the PR description." The banner's job is to route a decision, not to accuse.
