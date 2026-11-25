# Uncheatable and timer hunt

Hunt against current `main` after the client clock anchor and the server deadline check. Open drafts #3, #4, #5, and #7 already own the question bank, practice paper, and studio UI, so this pass stays in the Worker limiter and in new tests.

## Fixed

- Cookieless `PUT /api/answers`, `POST /api/submit`, and `PUT /api/integrity` returned 401 before `throttle`, so they never spent the limiter. A live `GET /api/session` with no cookie did the same and returned an empty session. Those calls now hit the limiter first. A denied limiter answers 429 and does not open a Durable Object. Closed mode with no cookie still returns an empty session, so a missing limiter cannot turn the public homepage into an error.
- The fallback limiter salt was a fresh random value per isolate. Isolates then did not share buckets. The fallback is a stable label. `RATE_KEY` or `OPS_TOKEN` still wins when it is set.
- The per-attempt limiter key was only the minute, the operation, and the public reference. It now includes the same salt as the network key.
- `CF-Connecting-IP` is reduced to one IP token. A comma-joined or non-IP value shares the `local` bucket instead of creating a new one per request. At the Cloudflare edge the platform overwrites this header; the collapse only matters if a junk value is still present.
- Answer, integrity, and first-submit checks read `Date.now()` again at the mutation. The earlier snapshot can be a few milliseconds older. An idempotent submit of an already submitted paper still returns the receipt after the deadline and does not move `purgeAt` or the score.

## Checked, already held

- Hiring answers live in the Durable Object record. `POST /api/submit` accepts only `revision` and `reference`. A client `deadline`, `score`, or `key` field is a 400 and does not move the stored deadline.
- At `deadline <= now` the record becomes `expired` before an answer, integrity signal, or first submit is applied. Replaying the saved choice does not change it. A later different choice does not bump the revision again. No score is written.
- Two different claims racing `POST /api/start` produce one 200 and one 403. The stored paper is the winner's paper. The same claim still resumes that paper. After expiry, the original claim sees the closed receipt and a new claim is 403. The invitation does not mint a second paper.
- Two concurrent submits both return the submitted receipt. The exported score does not change if the deadline is then moved into the past and submit or answer is retried.
- A session read racing an answer write returns a candidate payload with no `key`, `correct`, `explanation`, `expected`, `score`, `notes`, `paper`, or session secret. The following read matches the stored revision and answers.
- An active reviewer export has `score: null` and no `responses`. A candidate cookie plus a fake `Cf-Access-Jwt-Assertion` is 403. A late `pageHidden` signal is not added to the closed summary. The candidate session of that closed attempt still has no summary and no expected answers.
- Practice start returns questions, the reference table, the opaque `p1` challenge, `serverNow`, and `deadline`. It does not return the key or an explanation. A flipped challenge, a JSON lookalike, an extra `deadline` field, a ticket sealed under another key, and a ticket sealed under the real key with a 16-minute lifetime are 400. The practice challenge is not a hiring submit body and not a session cookie.
- `alg: none` reviewer assertions do not authorize.

## Residual

- Practice may be scored again until its server deadline. That is the build contract for the stateless paper: the aggregate score can be used as an oracle until expiry. The practice prompts are the public source paper. Making the ticket single-use would require storage, which practice is required not to touch. Draft #3 is the place that adds post-submit explanations.
- A stolen `PRACTICE_KEY` can decrypt a ticket or mint a new 15-minute one. Rejecting a longer lifetime does not help after the key is gone. Ticket integrity rests on that key and on `Date.now()`.
- Hiring and practice deadlines are absolute server timestamps. A backward step of the Worker clock lengthens them. A forward step closes them early. The candidate page anchors its display to `serverNow` plus `performance.now()` and cannot extend the server deadline by changing the system clock.
- Distinct real client IPs still have distinct network buckets. The per-attempt key caps authenticated hiring writes for one reference across those IPs. Practice and invitation routes have no per-ticket key; rotating real edge IPs spends a new network budget. Guessing an invitation remains impractical: the secret is 256 bits.
- Unknown `/api/*` paths return 404 before the limiter. They do not read or write an attempt.
- Reviewers see selected and expected text after the attempt is submitted or expired. They do not see it while the attempt is active. That closed-record view is the staff grade, not a candidate payload.
