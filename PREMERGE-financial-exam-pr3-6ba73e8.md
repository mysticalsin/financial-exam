# PREMERGE financial-exam PR #3

verdict: **PASS**
scope: exact-head CODE+BODY gate
merged: **no**
draft: **yes** (left as draft)

This receipt certifies draft PR #3 at the owner freeze. It does not merge that PR, does not push to `cursor/fifteen-minute-end-review-d2e9`, and does not deploy. It is not a different-model-family Vera pass: the author run and this gate are both Grok.

Bound from GitHub after the suites, before this verdict: 2026-11-23T18:05:37Z. The tip was the same SHA as the pre-suite read.

## a. Live tip

| Field | Value |
| --- | --- |
| PR | https://github.com/mysticalsin/financial-exam/pull/3 |
| State | open, draft, `merged: false`, `merged_at: null` |
| Head ref | `cursor/fifteen-minute-end-review-d2e9` |
| Owner freeze | `6ba73e8` |
| Live `head.sha` | `6ba73e8b725879d7abe370e0f756abf53a851300` |
| Parent | `c7f58f91cb34c4faf57cf4602fe98ce62fb766ab` (`main`) |
| Match | live tip equals the owner freeze. Gate continued. |
| Local checkout | detached `HEAD` at that SHA for the suites. No commit was added to the PR branch. |

## b. Live tree

GitHub commit object at the tip, re-read with the body bind:

`tree` `dbefa2b0e750c0ffaa65d2f6d4e91e36ea9bcc9b`

`git rev-parse HEAD^{tree}` on the detached checkout was the same tree. One commit, 23 files, +394 / −94.

## c. Live body

Title: Shorten exams to 15 minutes and explain answers only after submit

`updated_at`: 2026-11-23T17:36:23Z (unchanged across the pre-suite and post-suite reads)

| Hash | SHA-256 |
| --- | --- |
| Full GitHub `body` string (3143 bytes) | `1ed4745a9f5be7d5f9ee5fa615f2e39c2a22e0178f528f3f813fe6e74493bf7e` |
| Author text between the Cursor body markers (2150 bytes) | `f0936ab3a2d8fa6eb4c919313b43f417f1a83eb8787a36740169d2b8707b39ef` |

CODE+BODY, each author claim checked on that tree:

| Claim | Result | Where |
| --- | --- | --- |
| Practice and recruitment papers last 15 minutes | PASS | `wrangler.jsonc` `DURATION_MINUTES` `15`; `src/worker.js` default `env.DURATION_MINUTES ?? 15`; start sets `deadline = now + durationMinutes * MINUTE` |
| Correct answers stay hidden while an attempt is open | PASS | Practice start returns questions, challenge, `serverNow`, `deadline` only. Hiring `candidateState` sends `paper.questions` while `active` and omits `score` and `review`. Question objects have no explanation field. |
| After a completed submission, score plus good answer and why the others are not | PASS | Practice `scorePractice` adds `review` from the sealed ticket. Hiring `reviewPaper` / `candidateState` add `score` and `review` only when `status === "submitted"`. Both explanation strings start `Good answer:` and include `Why the others are not:`. |
| `LIVE_ENABLED` remains false; source-only; nothing deployed | PASS | `wrangler.jsonc` `"LIVE_ENABLED": "false"`. This gate did not deploy. Live `GET /api/config` on the hosted Worker still returned `enabled: false`, `durationMinutes: 30`, `inviteTtlMinutes: 30` (2026-11-23T18:03Z). |
| Practice `TICKET_LIFETIME` is 15 minutes after issue | PASS | `src/practice.js` `15 * 60 * 1000`. Verifier submit at `deadline` returned HTTP 410 and no `score` or `review`. |
| Public copy uses 15 minutes, including “Start 15-minute practice” and `15:00` | PASS | `public/practice.js`, `public/index.html`, `public/app.js` practice copy. |
| Reviewer allowance stays 5 to 55 minutes | PASS | `demand(bounded(durationMinutes, 5, 55))`. Extracted `bounded` accepts 5, 15, and 55 and rejects 4, 56, 15.5, and `"15"`. Author `tests/worker.test.js` also rejects 56 and accepts 55. |
| `INVITE_TTL_MINUTES` stays 30 (start window, not the exam clock) | PASS | `wrangler.jsonc` and Worker default `?? 30`. `bounded(inviteTtlMinutes, 1, 30)`. |
| Retention stays 30 minutes after submission or the deadline, capped at 60 minutes from issue | PASS | `POST_ATTEMPT_WINDOW = 30 * MINUTE`, `HARD_LIFETIME = 60 * MINUTE`, `purgeAt` is `Math.min(window, hardEnd)`. |
| Keys were already server-side; start and in-progress payloads omit key, score, and explanations | PASS | Practice key is inside the AES-GCM ticket. Hiring key and `paper.notes` stay off the question objects. Active candidate JSON has no `Why the others are not:`. |
| Practice submit returns `review` built from that ticket | PASS | `handlePractice` submit decrypts, `validateTicket`, then `scorePractice`. |
| Recruitment explanations live in `paper.notes`, not on the question objects | PASS | `src/bank.js` `makePaper`. |
| Candidate receipt has `score` and `review` only when `submitted` | PASS | `candidateState` spread is conditional on `submitted`. |
| Expired incomplete attempt has no score and no explanations | PASS | Verifier `candidateState` on `status: "expired"` even when a score was stored: `score` and `review` absent, questions empty, no `Good answer:`. |
| Reviewers see expected answers only after close, and now the same explanation | PASS | `operatorRecord` returns selections only while `active`. After close it includes `expected` and `explanation` from `paper.notes`. |
| Calculator stays allowed; answers stay editable until submit or the deadline | PASS | Copy still allows a calculator. `Permissions-Policy` does not disable one. `answer` updates while `active`. A passed deadline flips the record to `expired` and further edits hit “This assessment has closed.” |
| Unscored warm-up (€100 − €60) explains itself before the timer and is not one of the 15 | PASS | `public/practice.js` preflight example. Generated practice questions do not contain that prompt. |
| Author suite claim: `npm test` (34) plus integration, practice UI, candidate UI, reviewer | PASS | Reproduced twice below. |
| 100–200 bank, Rust hot paths, and a live deploy remain undone; repo stays private | PASS | This commit does not add a rotating bank or Rust. GitHub `private: true`. Live duration is still 30. |

## d. Suite run 1

Checkout `6ba73e8b725879d7abe370e0f756abf53a851300`. Started 2026-11-23T18:03:20Z. No production secrets. `npm ci` before the suite (44 packages, 0 known advisories).

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm test` | 0 | 1s | tests 34, pass 34, fail 0, skipped 0, todo 0 |
| `npm run test:integration` | 0 | 5s | PASS local Worker claim races, retries, scope, persisted restart, concurrent edits, authoritative grading, export, R2 erasure, simulated time cutoffs and scheduled cleanup |
| `npm run test:practice-ui` | 0 | 17s | PASS Chrome practice studio |
| `npm run test:candidate-ui` | 0 | 17s | PASS Chrome candidate UI |
| `npm run test:reviewer` | 0 | 3s | PASS reviewer browser |
| verifier properties | 0 | <1s | 40 practice papers and 40 hiring papers |

Log SHA-256: unit `a996e67aed13b236307e7a7aa276bf82d46a13b774316bbdadb76af5348eb7a7`, integration `07dbb6f07fe979c54a69e8a607e3d11fc5e1db93cc2959a1ea4e9239fbec56da`, practice-ui `130273a967a2a762698b4eb757e49433dfe7b98c2c00918591c76696158d45a0`, candidate-ui `b785cf47b920d0d943b09a9aee7e41d8eda80af365f2ea176172e888e8e7b752`, reviewer `6adf31356cb87cf016592749a0cdeb8d362db1611c5bb9e21bb62e4eb331a95c`, properties `1895ce6fb7e6536ad5a933b89d084b5e819c636ed7938de2b9e90883623cb95c`.

## e. Suite run 2

Same commands, same checkout, started 2026-11-23T18:04:03Z. Finished 2026-11-23T18:04:45Z. `SUITE_FAIL=0`.

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm test` | 0 | 1s | tests 34, pass 34, fail 0, skipped 0, todo 0 |
| `npm run test:integration` | 0 | 5s | same PASS line |
| `npm run test:practice-ui` | 0 | 17s | same PASS line |
| `npm run test:candidate-ui` | 0 | 17s | same PASS line |
| `npm run test:reviewer` | 0 | 2s | same PASS line |
| verifier properties | 0 | <1s | same PASS line |

Unit log SHA-256 differs from run 1 (`f60d221e1410353a1d79e5b77f9f1992c4d9cb920380877c754ad8ff6365623b`) because the TAP log includes timings. Integration, both UI suites, reviewer, and properties hashes matched run 1.

## f. Substitute CI

GitHub Actions is not evidence for this tip.

| Check | Result |
| --- | --- |
| Workflows in `mysticalsin/financial-exam` | 0 |
| Workflow runs for `6ba73e8b725879d7abe370e0f756abf53a851300` | 0 |
| Check runs on that SHA | 0 |
| Billing error observed | none. There is no workflow to start. |

SUBSTITUTE CI: the local suite in sections d and e. This is not a green Actions check.

Timeout rule armed on every command: 540 seconds, one retry, a second timeout recorded as infra and not as a product pass. No command timed out, so the retry did not run.

## Standing Forge checks

These are the four checks from the factory verify rule (verifier-owned properties, skip/xfail, spec boundaries, timeout as infra).

1. **Verifier-owned properties.** `/tmp/verifier-properties.mjs` (not part of the PR) generated 40 practice papers and 40 hiring papers. Question objects carried no key, score, or explanation. A swapped choice moved the score from 15 to 14. `candidateState` hid score and review while active and when expired, and returned both only when submitted. A real practice start/submit through `handlePractice` hid explanations at start and returned 410 with no review at the 15-minute deadline. Both runs exited 0.
2. **Skip / xfail.** No `test.skip`, `it.skip`, `describe.skip`, `.only`, or `xfail` in the eight test files. Both unit runs reported skipped 0 and todo 0.
3. **Spec boundaries.** 15-minute ticket, allowance integers 5 through 55, invite TTL 30 with 31 rejected, retention 30 minutes inside a 60-minute hard end, expired incomplete receipt empty of explanations, warm-up outside the 15 questions.
4. **Timeout is infra.** Harness above. Not triggered.

## Residuals (do not change the verdict)

- The Playwright doubles still answer `/api/config` with `durationMinutes: 30` in `tests/practice-ui.mjs`, `tests/candidate-ui.mjs`, and `tests/reviewer-ui.mjs`. The shipped Worker default, `wrangler.jsonc`, and `tests/worker.test.js` lock the exam clock at 15. Public copy is 15 minutes.
- `npm run build` (Wrangler dry-run) was not part of this order and was not run.
- `docs/VERIFICATION.md` still describes earlier hosted releases. The practice-challenge sentence on this tree says 15 minutes. The live Worker was read, not redeployed, and still reports 30.

## Not done

PR #3 was not merged, not marked ready, and its branch was not updated. No production deploy. No force push. Visibility was not changed.
