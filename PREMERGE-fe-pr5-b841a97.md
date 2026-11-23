# PREMERGE financial-exam PR #5

verdict: **PASS**
scope: exact-head CODE+BODY gate for stress + hot path. Wasm stays gated. Scoring stays in JavaScript.
merged: **no**
draft: **yes** (left as draft)

This receipt certifies draft PR #5 at the owner freeze. It does not merge that PR, does not push to `cursor/pack-stress-hot-path-4481`, and does not deploy. It is not a different-model-family pass: the author run and this gate are both Grok. Codex CLI was not used.

Bound from GitHub after the suites, before this verdict: 2026-11-23T18:31:52Z. The tip, tree, and body were the same as the pre-suite read at 2026-11-23T18:29:59Z.

## a. Live tip

| Field | Value |
| --- | --- |
| PR | https://github.com/mysticalsin/financial-exam/pull/5 |
| State | open, draft, `merged: false`, `merged_at: null` |
| Head ref | `cursor/pack-stress-hot-path-4481` |
| Owner freeze | `b841a97` |
| Live `head.sha` | `b841a9760f74401d836ece784d588fc97c370bab` |
| Parent | `c7f58f91cb34c4faf57cf4602fe98ce62fb766ab` (`main`) |
| Match | live tip starts with `b841a97` and equals the owner freeze. Gate continued. |
| Local checkout | detached `HEAD` at that SHA for the suites. No commit was added to the PR branch. |

## b. Live tree

GitHub commit object at the tip, re-read with the body bind. The tree listing was not truncated.

`tree` `5916b0624f3f9e0f792ca2055e531a371d9c172e`

`git rev-parse HEAD^{tree}` on the detached checkout was the same tree. One commit, 10 files, +931 / −84.

| Path | Change |
| --- | --- |
| `README.md` | points `npm test` at the stress file and `profile:hot-path` at the note |
| `RECOVERY.md` | stress coverage is in tree; Rust/Wasm stays gated |
| `docs/HOT-PATH.md` | new note |
| `package.json` | `test:stress` and `profile:hot-path` |
| `scripts/hot-path-profile.mjs` | local wall-time split |
| `src/bank.js` | recruitment papers draw from `createPaperRng()` |
| `src/practice.js` | practice papers draw from `createPaperRng()` |
| `src/random.js` | new batched rejection sampler |
| `tests/random.test.js` | sampler lock |
| `tests/stress.test.js` | both packs |

`wrangler.jsonc` is not in the diff. `git diff --exit-code c7f58f9 -- wrangler.jsonc` was empty. No `.wasm`, `.rs`, or `Cargo.toml` is in the tree.

## c. Live body

Title: Add pack stress tests and keep scoring in JavaScript

`updated_at`: 2026-11-23T17:48:31Z (unchanged across the pre-suite and post-suite reads)

| Hash | SHA-256 |
| --- | --- |
| Full GitHub `body` string (2235 bytes) | `bd612e19d3fdf7625bc6700aff635457e16d6182d9cf6202990dc0b056113fee` |
| Author text between the Cursor body markers (1172 bytes) | `df8d7ebdc340ac65649c9b12736cf071545a4f2f81d18ef14ed9aff68c197eab` |

CODE+BODY, each author claim checked on that tree:

| Claim | Result | Where |
| --- | --- | --- |
| CI-friendly stress coverage for both packs: practice and recruitment flows | PASS | `tests/stress.test.js` `PACKS` is practice and recruitment. One hundred iterations each check 8 Foundations and 7 Applied Reading, four distinct choices, and scores 15 / 8 / 7 / 0. |
| Numeric and request bounds | PASS | Portfolio edges and the revenue/margin/overhead domain, including non-integers and out-of-range rejects. Practice body cap 32 KiB with 413 over the cap. Invite body cap 2048. Duration rejects 4, 56, 5.5, `"30"`, null, −1, and 0, and accepts 5 and 55. A two-choice answer is 422. |
| Shipped 120-per-60-second limiter, separate keys, and a minute rollover | PASS | `wrangler.jsonc` `limit` 120 and `period` 60. `throttle` folds `Date.now()` into a 60-second bucket and hashes salt, minute, IP, and operation. The stress test reads those two numbers from the file, accepts 120 and rejects the 121st on one key, separates practice from operator, separates two IPs, and changes the key across `period` seconds. In-process fixture, as the body says. |
| Concurrent starts | PASS | Sixteen parallel practice starts, all 200, distinct challenges, no cookie, no stored record. Eight claims of one invite: one 200 and seven 403. Six replays of one claim: one write and one paper. |
| `npm test` runs that suite with in-process fixtures. No network and no Wrangler on that path | PASS | `package.json` `test` is `node --test tests/*.test.js`. The stress file header says no network and no Wrangler. Both unit runs below stayed in process. |
| Scoring stays in JavaScript. Grading is identifier comparison | PASS | `grade` counts `selected[0] === paper.key[id][0]`. `scorePractice` counts `ticket.key[questionId] === optionId`. Neither function is in the diff. No `WebAssembly` reference under `src/`. |
| `docs/HOT-PATH.md` records a local Node wall-time split, and integer case math is a tiny share of paper assembly | PASS | The note's one Node v22.23.4 sample puts the integer model at 0.07% of `makePaper` and grading at 0.38% of build-plus-grade. This gate's two reprints on Node v22.23.4 were 0.07% and about 0.48% / 0.40%. See the residual for the millisecond sample. |
| A Workers-compatible Rust/Wasm plan is written and stays gated on a real Workers CPU profile | PASS | `docs/HOT-PATH.md` "When a Wasm port would be justified" and "Workers-compatible plan". The gate is a Workers CPU profile attributing at least 10% of start-handler CPU to the numeric kernel. The note says not to move identifier scoring into Wasm. |
| This change does not rewrite any hot path to Wasm | PASS | No Wasm or Rust source in the tree. `package-lock.json` is unchanged. `grade` and `scorePractice` stay in JavaScript. |
| Each paper batches CSPRNG draws in `src/random.js` with the same rejection sampling and no shared cursor | PASS | `createRandomBelow` rejects `word >= RANGE - (RANGE % limit)` and fills a 64-word buffer. `makePaper` and `makePracticePaper` each call `createPaperRng()`. The buffer lives in that closure. |
| `tests/random.test.js` locks the sampler | PASS | Scripted tail `0xffffffff` for limit 3, default batch of 64, fixed-seed histogram `[986, 947, 1009, 976, 996, 1086]`, and a source lock that `bank.js` / `practice.js` call `createPaperRng()` and do not keep a one-word `Uint32Array`. |
| `wrangler.jsonc` unchanged and `LIVE_ENABLED` stays `"false"` | PASS | Diff empty against `c7f58f9`. The file still has `"LIVE_ENABLED": "false"`. The stress test also rejects `"TRUE"`, `"1"`, and `"yes"`. |
| Nothing here deploys the Worker | PASS | This gate did not run `wrangler deploy`. Live `GET /api/config` at 2026-11-23T18:31:03Z returned `enabled: false`, `durationMinutes: 30`, `inviteTtlMinutes: 30`, `countries: []`, `notice: null`. |
| Based on `c7f58f9` | PASS | Parent `c7f58f91cb34c4faf57cf4602fe98ce62fb766ab`. |
| `npm test` — 44 passing, including the new stress and sampler tests | PASS | Reproduced twice below. `tests 44`, `pass 44`, `fail 0`, `skipped 0`, `todo 0`. |
| `npm run profile:hot-path` reprints the local timing split cited in `docs/HOT-PATH.md`. Those numbers are not a Workers CPU profile | PASS | Both runs printed the same JSON shape on Node v22.23.4 and exited 0 with `scored: 120000` (400 papers × 20 repeats × 15). Recruitment stayed at 2 `getRandomValues` calls and 512 bytes per paper. Practice stayed at 1 call. The script's own note says the shares are local wall time, not Workers CPU samples. |

## d. Suite run 1

Checkout `b841a9760f74401d836ece784d588fc97c370bab`. Unit pass started 2026-11-23T18:31:11Z. No production secrets. `npm ci` before the suite (43 packages added, 44 audited, 0 vulnerabilities).

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm test` | 0 | 0.42s | tests 44, pass 44, fail 0, cancelled 0, skipped 0, todo 0 |
| `npm run profile:hot-path` | 0 | 0.27s | Node v22.23.4. `makePaper` 55.71 ms / 400 papers. Grade 0.27 ms. Integer model 0.04 ms (share 0.0007). Calls 2 × 512 bytes. Practice build 27.21 ms, score 2.30 ms, 1 call. `scored` 120000 |
| verifier properties | 0 | 0.08s | PASS line below |
| `npm run test:integration` | 0 | 5.53s | PASS local Worker claim races, retries, scope, persisted restart, concurrent edits, authoritative grading, export, R2 erasure, simulated time cutoffs and scheduled cleanup |

The integration process is local `wrangler dev --local` inside a temp copy. It is not a deploy. Its first pass started 2026-11-23T18:31:33Z, after both unit passes, on the same detached checkout.

Log SHA-256: unit `b139dcc6bdb68faf84a6ea33f292adf399ad2b7f89331bc936f6a45f947bda3e`, profile `131f858288aeb1c9d730311cd1f5f2b34b7b8e749e734aed3c701aed8e3a850e`, verifier `b26b2b5fb1e23ace1b418b32121f7c2490493845d5754d9cda09db752078780d`, integration `07dbb6f07fe979c54a69e8a607e3d11fc5e1db93cc2959a1ea4e9239fbec56da`.

## e. Suite run 2

Same commands, same checkout. Unit pass started 2026-11-23T18:31:12Z. Integration second pass started 2026-11-23T18:31:39Z and finished 2026-11-23T18:31:44Z. No failures.

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm test` | 0 | 0.41s | tests 44, pass 44, fail 0, cancelled 0, skipped 0, todo 0 |
| `npm run profile:hot-path` | 0 | 0.29s | `makePaper` 64.76 ms. Grade 0.26 ms. Integer model 0.04 ms (share 0.0007). Calls 2 × 512 bytes. Practice build 31.92 ms, score 2.29 ms, 1 call. `scored` 120000 |
| verifier properties | 0 | 0.08s | same PASS line |
| `npm run test:integration` | 0 | 5.33s | same PASS line |

Unit log SHA-256 differs (`12448a84a6cf8142551fd61193e80b4f2abcbe075c13811ab63bca450ccd10fa`) because the TAP log includes timings. Profile SHA-256 differs (`a199571724aa781d6759bc8bb789a0cf25bfcedf07ce099e45256deb80754f75`) because wall times moved. Verifier and integration hashes matched run 1.

## f. Substitute CI

GitHub Actions is not evidence for this tip. Codex CLI was not required and was not run.

| Check | Result |
| --- | --- |
| Workflows in `mysticalsin/financial-exam` | 0 |
| Check runs on `b841a9760f74401d836ece784d588fc97c370bab` | 0 |
| Billing error observed | none. There is no workflow to start. |

SUBSTITUTE CI: the local suite in sections d and e. This is not a green Actions check.

Timeout rule armed on every command: 540 seconds, one retry, a second timeout recorded as infra and not as a product pass. No command timed out, so the retry did not run.

## Standing Forge checks

1. **Verifier-owned properties.** `/tmp/verifier-properties.mjs` (not part of the PR) checked the frozen tree. No `.wasm`, `.rs`, or `Cargo.toml` outside dependencies. `grade` and `scorePractice` still compare issued identifiers, and `src/` does not mention `WebAssembly`. `wrangler.jsonc` is `LIVE_ENABLED` `"false"` with limit 120 and period 60. The sampler rejects `0xffffffff` for limit 3 and then returns 0, 1, 2. Forty recruitment papers and forty practice papers scored 15, 14 after one swapped choice, and 0 with an empty answer map. Question objects carried no `correct` or `explanation` field. Both runs exited 0.
2. **Skip / xfail.** No `test.skip`, `it.skip`, `describe.skip`, `.only`, or `xfail` in the test files. Both unit runs reported skipped 0 and todo 0.
3. **Spec boundaries.** Both packs are 15 questions (8 + 7). Duration integers 5 through 55. Rate limit 120 per 60 seconds, with the key bucket moving when the clock advances 60 seconds. Practice body 32 KiB and invite body 2048. Portfolio domain rejects a fractional margin. Identifier scoring stays in JavaScript. The Wasm plan stays behind a Workers CPU profile and does not take the graders.
4. **Timeout is infra.** Harness above. Not triggered.

## Residuals (do not change the verdict)

- The millisecond rows in `docs/HOT-PATH.md` are one labeled Node v22.23.4 sample (`makePaper` 71.32 ms, integer model 0.05 ms, practice build 31.82 ms). `profile:hot-path` measures again. It does not print those constants. On this machine the two samples were 55.71 ms and 64.76 ms for `makePaper`. The reproducible rows matched the note: 2 calls / 512 bytes for recruitment and 1 call for practice. Integer-model share was 0.07% both times. That is the same conclusion the note uses to keep the Wasm plan gated. Neither sample is a Workers CPU profile.
- The 120/60 behavior is the Worker calling its limiter binding. The stress fixture supplies the binding in process. It does not call Cloudflare's edge limiter.
- `npm run test:candidate-ui`, `npm run test:practice-ui`, and `npm run test:reviewer` were not part of this order. This commit does not change `public/`. The author did not claim those scripts.
- `npm run build` was not part of this order and was not run.
- This branch is still the `main` baseline for the exam clock: practice tickets and `DURATION_MINUTES` are 30. The 15-minute change is a different draft. This receipt does not certify that draft.
- `docs/VERIFICATION.md` still describes earlier hosted releases. The live Worker was read, not redeployed, and still reports scoring closed and a 30-minute duration.

## Not done

PR #5 was not merged, not marked ready, and its branch was not updated. No production deploy. No force push. Visibility was not changed.
