# PREMERGE financial-exam PR #4

verdict: **PASS WITH NOTES**
scope: exact-head CODE+BODY
merged: **no**
draft: **yes** (left as draft)

This receipt certifies draft PR #4 at `ba4975a`. It does not merge that PR, does not push to `cursor/luxurious-studio-motion-6a04`, and does not deploy. Codex CLI was not used. The author run and this gate are both Grok, so this is not a different-model-family pass.

Bound from GitHub after the suites at 2026-11-23T18:31:57Z, and again immediately before this receipt at 2026-11-23T18:32:56Z. Both reads returned the same tip as the pre-suite read. `updated_at` stayed `2026-11-23T17:48:17Z`.

## a. Live tip

| Field | Value |
| --- | --- |
| PR | https://github.com/mysticalsin/financial-exam/pull/4 |
| State | open, draft, `merged: false`, `mergeable_state: clean` |
| Head ref | `cursor/luxurious-studio-motion-6a04` |
| Owner freeze | `ba4975a` |
| Live `head.sha` | `ba4975a1c2b36b05c5e5043abd2e4eb814fb633f` |
| Parent | `c7f58f91cb34c4faf57cf4602fe98ce62fb766ab` (`main`) |
| Commit signature | verified (`reason: valid`) |
| Match | live tip starts with `ba4975a` and equals the owner freeze. Gate continued. |
| Local checkout | detached `HEAD` at that SHA for the suites. No commit was added to the PR branch. |

## b. Live tree

GitHub commit object at the tip, re-read with the body bind:

`tree` `a1db5db95b52b54be2184b486b4835a4b698b6d5`

`git rev-parse HEAD^{tree}` on the detached checkout was the same tree. GitHub's recursive tree was `truncated: false`. `git ls-tree -r` lists 41 blobs. One commit, 5 files, +106 / −88.

Changed blobs:

| Path | Blob |
| --- | --- |
| `public/app.js` | `f20cfbcf6fb7bc52f1b0f7c43a15f46b461dc6ab` |
| `public/index.html` | `942469700ecb9411db2d740f3880356f76a283bd` |
| `public/practice.js` | `86846d9b59eeefbd396eef02839f5cd2178bf43e` |
| `public/review/review.css` | `2c2b5fb3b6713cb43c76260acf4a31c26f492bab` |
| `public/styles.css` | `a2bb761273a793579d3aeb729b533a5bfc7a6a8f` |

`src/`, `tests/`, `wrangler.jsonc`, `package.json`, and `package-lock.json` are byte-identical to the parent (`git diff --exit-code` passed).

## c. Live body

Title: Polish the Mantu studio with fluid, purposeful motion

`updated_at`: 2026-11-23T17:48:17Z (unchanged across the pre-suite and post-suite reads)

| Hash | SHA-256 |
| --- | --- |
| Full GitHub `body` string (3310 bytes) | `14f2d0d6e243d3da38a3267f3f3a51d7278d202e35ffe2412f80aac3013ee9cb` |
| Author text between the Cursor body markers (2249 bytes) | `599728a995c78c396506494aa5a1a25732471dfd4a412613accef0529dd6106e` |

The author slice is the exact UTF-8 between `<!-- CURSOR_AGENT_PR_BODY_BEGIN -->` and `<!-- CURSOR_AGENT_PR_BODY_END -->`, including the newlines that sit against those markers.

CODE+BODY, each author claim checked on that tree:

| Claim | Result | Where |
| --- | --- | --- |
| Draft visual pass on `public/` only | PASS | Diff is the five blobs above. `src/`, tests, and Wrangler are identical to `c7f58f9`. |
| Exam timing and scoring are unchanged | PASS | `wrangler.jsonc` `DURATION_MINUTES` `30`, `INVITE_TTL_MINUTES` `30`. Worker defaults stay `?? 30`. `src/practice.js` `TICKET_LIFETIME` stays `30 * 60 * 1000`. `public/practice.js` still starts the clock from `data.deadline` and still renders `result.score` from the API. The practice diff only adds the progress fill and the score-ring DOM. |
| `LIVE_ENABLED` stays `false` | PASS | `wrangler.jsonc` `"LIVE_ENABLED": "false"`. Live `GET /api/config` at 2026-11-23T18:31:57Z returned `enabled: false`, `durationMinutes: 30`, `inviteTtlMinutes: 30`. |
| No deploy | PASS | This gate did not deploy. The live Worker still reports a 30-minute clock. |
| Head `ba4975a1c2b36b05c5e5043abd2e4eb814fb633f` off `c7f58f9` | PASS | Live tip and parent match. |
| Studio keeps the plum ground, ledger hero, and score circle | PASS | Landing ledger background computes to `rgb(43, 0, 88)`. The five-row ledger and `.score-circle` remain. |
| Arrow badge, fact checkmarks, ledger orbit, and ledger grid are gone | PASS | Landing button text is `Start practice assessment`. Fact `::before` content is `none`. `index.html` has no `ledger-orbit`. The ledger grid `::before` is gone. |
| Hover lift is gone | PASS | `.start-practice:hover` changes background only. It no longer translates on hover. |
| Accent stripes that did not mark a state are gone | PASS | Paper instructions, result reflection, integrity summary, copy-shortcut context, and the welcome kicker rule no longer draw a decorative side stripe. A selected choice still uses an inset bar. The pressed reviewer filter still uses the yellow outline. |
| Practice facts, “Before you start”, and the five portfolio rows stay | PASS | Verifier and `test:practice-ui` both read those strings and the five ledger rows (`€120,000` through `€24,000`). |
| Ledger bars draw once on `ledger-settle` at 640ms when the hero appears | PASS | `IntersectionObserver` adds `is-visible` once, then disconnects. CSS is `ledger-settle 640ms`. With motion allowed, all five bars compute `animation-name: ledger-settle`. |
| Paper mark fades in, and a 2px yellow line crosses the banner once | PASS | `.paper-brand img` uses `mark-in` (opacity, 420ms). `::after` is `height: 2px`, `#f8f060`, `brand-glint` once (no iteration count). |
| Progress fill scales in 180ms when the answered count changes | PASS | `updateProgress` sets `--progress-ratio`. Computed transition is `transform` / `0.18s`. The native `<progress>` value still updates. |
| Score ring draws to the earned share; number and band are text immediately | PASS | SVG circles `r=54`, dash array `339.292` (`2π×54` to three decimals), `score-draw` 700ms. `.score-value` and `.result-band` have no animation. `--score-ratio` is `score/total`, or `0` when `total` is 0. |
| Motion is only those four moments, and all of them are transform or an SVG stroke | NOTE | The four moments above are the ones that run. `mark-in` is opacity, not transform or stroke. Extra motion remains: a press `scale(0.98)` on `.start-practice:active`, and 150ms color or border transitions on options, the start button, question cards, and reviewer controls. See residuals. |
| Reduced motion skips those animations and shows the finished frame | PASS | With `prefers-reduced-motion: reduce`, ledger bars compute `animation-name: none` and an identity transform. The glint is `visibility: hidden`. The universal reduced-motion rule sets `transition: none !important`. `test:practice-ui` also requires the ledger duration to collapse. |
| Question cards do not fade in | PASS | The later `.practice-question-card` rule sets `animation: none`. Computed `animation-name` is `none`. |
| Nothing in the timer or scoring path changed | PASS | Same as the timing row. `public/app.js` only replaces the landing button's arrow span with `textContent`. |
| `npm test`, Chrome `test:practice-ui`, `test:candidate-ui`, and `test:reviewer` | PASS | Reproduced twice below. Integration was also run twice. |
| No page overflow at 320, 390, and 1440. On a phone the start button stays above the ledger | PASS | `test:practice-ui` and `test:candidate-ui` assert `scrollWidth <= innerWidth` at those widths. Both the suite and the verifier require `#landing-action` to sit above `.studio-ledger` at 320 and 390. |

## d. Suite run 1

Checkout `ba4975a1c2b36b05c5e5043abd2e4eb814fb633f`. Product commands started 2026-11-23T18:29:37Z. No production secrets. `npm ci` before the suite (44 packages audited, 0 known vulnerabilities). Browser launch used the system Chrome channel (`PLAYWRIGHT_CHROMIUM_CHANNEL=chrome`).

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm test` | 0 | 1s | tests 34, pass 34, fail 0, skipped 0, todo 0 |
| `npm run test:integration` | 0 | 6s | PASS local Worker claim races, retries, scope, persisted restart, concurrent edits, authoritative grading, export, R2 erasure, simulated time cutoffs and scheduled cleanup |
| `npm run test:practice-ui` | 0 | 18s | PASS Chrome practice studio, including 320/390/1440 layouts and reduced motion |
| `npm run test:candidate-ui` | 0 | 24s | PASS Chrome candidate UI, including 320/390/1440 overflow checks |
| `npm run test:reviewer` | 0 | 3s | PASS reviewer browser |
| verifier properties | 0 | <1s | PASS public chrome, four motion rules, reduced-motion finished frame, unchanged timing files |

The verifier's first two launches were harness faults (a missing `/usr/bin/time`, then a Playwright ESM import) and executed no assertion. The command above is the rerun that actually checked the tree. It is not a product failure.

Log SHA-256: unit `963b0bf56c687fbd6beed6298522e061301247330540bbb198035f58f8eec0a9`, integration `07dbb6f07fe979c54a69e8a607e3d11fc5e1db93cc2959a1ea4e9239fbec56da`, practice-ui `130273a967a2a762698b4eb757e49433dfe7b98c2c00918591c76696158d45a0`, candidate-ui `b785cf47b920d0d943b09a9aee7e41d8eda80af365f2ea176172e888e8e7b752`, reviewer `6adf31356cb87cf016592749a0cdeb8d362db1611c5bb9e21bb62e4eb331a95c`, properties `69375ef1b5ac065624210d231643832bed1f787fc55ffca5679ce13824a8035f`.

## e. Suite run 2

Same commands, same checkout, started 2026-11-23T18:30:47Z. Finished 2026-11-23T18:31:37Z. `SUITE_FAIL=0`.

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm test` | 0 | 1s | tests 34, pass 34, fail 0, skipped 0, todo 0 |
| `npm run test:integration` | 0 | 5s | same PASS line |
| `npm run test:practice-ui` | 0 | 16s | same PASS line |
| `npm run test:candidate-ui` | 0 | 25s | same PASS line |
| `npm run test:reviewer` | 0 | 2s | same PASS line |
| verifier properties | 0 | 1s | same PASS line |

Unit log SHA-256 differs from run 1 (`999161f9bd2ad8686b8ee512ab77449d9e917cd7e0811e97fecf36b8d7b037ee`) because the TAP log includes `duration_ms`. Integration, both UI suites, reviewer, and properties hashes matched run 1.

## f. Substitute CI

GitHub Actions is not evidence for this tip. Codex CLI was not called.

| Check | Result |
| --- | --- |
| Workflows in `mysticalsin/financial-exam` | 0 |
| Check runs for `ba4975a1c2b36b05c5e5043abd2e4eb814fb633f` | 0 |
| Billing error observed | none. There is no workflow to start. |

SUBSTITUTE CI: the local suite in sections d and e. This is not a green Actions check.

Timeout rule armed on every command: 540 seconds, one retry, a second timeout recorded as infra and not as a product pass. No command timed out, so the retry did not run.

## Standing Forge checks

1. **Verifier-owned properties.** `/tmp/verifier-pr4.mjs` (not part of PR #4) checked the public-only diff, `LIVE_ENABLED` false, 30-minute duration and ticket, the four motion rules, removed landing chrome, plum ledger ground, overflow at 320/390/1440, the start control above the ledger on those phone widths, question-card `animation-name: none`, and a reduced-motion ledger that is fully drawn. Both successful runs exited 0.
2. **Skip / xfail.** No `test.skip`, `it.skip`, `describe.skip`, `.only(`, or `xfail` in the eight test files. Both unit runs reported skipped 0 and todo 0.
3. **Spec boundaries.** Timing and scoring files match the parent. The live Worker still reports `enabled: false` and `durationMinutes: 30`. The five portfolio rows and the “Before you start” copy are still on the landing.
4. **Timeout is infra.** Harness above. Not triggered.

## Residuals (do not flip the safety verdict)

- The sentence “all on transform or an SVG stroke” does not cover `mark-in`, which fades opacity. The commit message says the same thing. The fade is one of the four moments the body names, and it does run.
- `.start-practice:active` applies `scale(0.98)` with no transform transition, so the press snaps. Color and border transitions of 150ms remain on `.option`, `.practice-option`, `.start-practice`, `.practice-question-card`, and the reviewer buttons and inputs. Reduced motion cancels transitions with `transition: none !important`.
- Stylesheet keyframes `welcome-in`, `banner-sweep`, `mark-arrive`, `mark-arrive-mobile`, `brand-stroke`, `card-rise`, and `bar-reveal` are still defined. `welcome-banner`, `welcome-glint`, `banner-mark-art`, and `register-card` occur only in CSS, not in HTML or JS. The later question-card rule overrides `card-rise`. The portfolio bar no longer uses `bar-reveal`.
- `public/app.js` still has the recruitment label `Next question →`. That is the in-paper control, not the landing arrow badge this PR removed.
- `.notice` still has a purple left border. It is the existing notice style, not the decorative stripes removed from the studio.
- `docs/VERIFICATION.md` still describes earlier hosted releases. It is not in this diff.
- `npm run build` (Wrangler dry-run) was not part of this order and was not run.
- Chrome was the system `google-chrome` channel. A Playwright-managed browser download was not required.

## Not done

PR #4 was not merged, not marked ready, and its branch was not updated. No production deploy. No force push. Visibility was not changed.
