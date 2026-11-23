# Hot path

Keep the integer case math in JavaScript. Do not add a WASM build.

`makePortfolioCase` is the integer portfolio function. A hiring or practice request does not call it. The hiring catalog is built when the isolate loads, and a request only samples and shuffles that catalog. Practice uses the fixed 15-question pack and shuffles order only.

## What was measured

The profile is local workerd through Wrangler 4.159.0 (`wrangler dev --local` and `wrangler check startup`). It is a Workers CPU profile of this runtime, on this machine, not a production edge capture. Production profiling would mean deploying, which this change does not do. Inside workerd, `performance.now()` advances in 1 ms steps, so the microsecond figures below are averages over one bulk loop. DevTools CPU profiles used a 100 µs sample interval.

| Work | workerd bulk mean |
| --- | --- |
| `makePortfolioCase(120000, 35, 18000)`, 50,000 calls | 1.6–1.8 µs |
| In-range portfolio cases, 50,000 calls | 1.7 µs |
| Retired random portfolio draw, 20,000 calls | 2.8–3.0 µs |
| Retired daily, team, and portfolio trio, 20,000 calls | 4.9–5.2 µs |
| Current `makePaper`, 800 calls | 96–126 µs |
| `makePracticePaper`, 800 calls | 31–39 µs |

A profile that only called `makePortfolioCase` put about 27% of sampled time in that function and about 42% in the euro formatter beside it. The arithmetic is the small part of an already ~2 µs call.

A profile of 800 `makePaper` calls (mean 111 µs on that run) was shuffle 53%, `makePaper` 31%, garbage collection 6%, `getRandomValues` 2.5%, and the bank filter 0.8%. `makePortfolioCase` had no samples. A profile of 800 practice papers was shuffle and question assembly only, again with no portfolio-case samples.

Forty `POST /api/practice/start` requests on the local Worker had a client wall-clock median of 8.0 ms and a p95 of 10.1 ms, including the local dev proxy. Sampled worker CPU was about 6.7 ms per request. The visible shares were the local rate-limit binding, hashing, and `encryptTicket` (about 5–6% on a second 30-request profile). `makePracticePaper` was about 1.3% of those samples. `makePortfolioCase` and `makePaper` had zero samples. The earlier ~165 µs JavaScript median was not reproduced. The closest current assembly figures are ~100 µs for a hiring paper in workerd and, as a Node cross-check only, a 2.4 µs median for one portfolio case and a 329 µs median for `makePaper`.

`wrangler check startup` reported a 142.86 KiB bundle (37.34 KiB gzip). The startup window was 27.9 ms, with 19.5 ms active including 1.2 ms of garbage collection, across 16 samples. Bank validation caught about 1 ms of that. It runs once per isolate, not once per request.

## Decision

JavaScript stays. The integer case is not on the request path. Forced through the profiler, it is about 2 µs, which is under 2% of hiring-paper assembly and far under 1% of a practice start. A WASM port would not move request time. Shuffle dominates paper assembly and still finishes around a tenth of a millisecond, so the sampling code was left as it is. No production Worker was deployed, and `LIVE_ENABLED` stays false.
