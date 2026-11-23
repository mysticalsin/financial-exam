# Hot path

Scoring stays in JavaScript. This note is the evidence for that, plus a Workers-compatible Wasm plan that should not be built unless a real Workers CPU profile contradicts it.

`grade` in `src/bank.js` and `scorePractice` in `src/practice.js` compare issued answer identifiers. They do not run the daily, team, or portfolio arithmetic. That arithmetic runs once, while a paper is assembled, and it is a few multiplications, a percentage, and currency formatting. The expensive work on the start path is `crypto.randomUUID`, `crypto.getRandomValues`, and, for practice, AES-GCM around the challenge.

## What was measured

`npm run profile:hot-path` times 400 papers with `performance.now` on Node. It is wall time on whatever machine runs it. It is not Workers CPU time. Workers do not advance timers during CPU-only stretches, and this machine is not an edge CPU. One run on Node v22.23.4:

| Work for 400 papers | Wall time |
| --- | ---: |
| Recruitment `makePaper` | 71.32 ms |
| Recruitment `grade` of a perfect paper | 0.27 ms |
| Integer case model (daily, team, and portfolio arithmetic only) | 0.05 ms |
| 40 `en-GB` currency formats per paper | 5.15 ms |
| 75 `crypto.randomUUID` calls per paper | 6.26 ms |
| Practice `makePracticePaper` | 31.82 ms |
| Practice `scorePractice` of a perfect paper | 2.23 ms |

On that run, grading was 0.38% of recruitment build-plus-grade wall time. The integer model was 0.07% of `makePaper`. Currency formatting and UUID allocation were larger than the arithmetic and still a small part of building a paper. After the batching change below, recruitment paper assembly made 2 `getRandomValues` calls (512 bytes) per paper. Practice assembly made 1 call (256 bytes). The previous sampler requested one 4-byte word per index, and a recruitment paper draws on the order of 80–100 indexes.

A single recruitment paper was about 0.18 ms of local wall time. That does not say what the Worker spends. It does say integer case math is not the thing to rewrite first.

## When a Wasm port would be justified

Treat integer case math as a material share only if a Workers CPU profile of the start handler shows it, not from this Node table. Use one of:

- Local DevTools profile from `wrangler dev` (press `D`, Profiler). This is still the developer machine's CPU.
- A production CPU profile for the deployed version: Workers dashboard profiling, or `cf workers versions profile --profile-type cpu`. Trace events also carry CPU time separately from wall time.

Do not use `performance.now()` inside the Worker as the measurement. A port is worth proposing when the profile attributes at least 10% of start-handler CPU samples to the numeric case kernel and that handler's CPU time is large enough to matter for the request. Until then, leave `grade` and `scorePractice` in JavaScript.

## Workers-compatible plan, if that evidence shows up

Keep the JavaScript graders and `makePortfolioCase` as the oracle. Add a tiny Rust library compiled with `cargo build --target wasm32-unknown-unknown --release`. No WASI, no threads, and no `wasm-bindgen` glue. Workers import a `.wasm` file as a `WebAssembly.Module`, and the usual bindgen output expects an instance unless it is patched. Export plain `extern "C"` functions that take integer cents and rates and return integer cents. Wrangler bundles `.wasm` automatically. Instantiate once in module scope with `WebAssembly.instantiate`. Do not call `WebAssembly.instantiateStreaming` (Workers do not support it). Run `wasm-opt -Oz` and watch script size and the 1 second startup limit. Gate the module off unless the profile above is attached to the change. Property-test the module against `makePortfolioCase` on the supported revenue, margin, and overhead domain. Do not move identifier scoring into Wasm. SIMD is available and irrelevant at this size.

## Change in this tree

`src/random.js` fills a 64-word buffer and still rejects the incomplete tail of the 32-bit range, so small limits are not biased toward low residues. Each paper builds its own buffer and drops it when the function returns. A Workers isolate reuses module scope, so there is no process-wide cursor and no leftover words carried into the next request. `tests/random.test.js` locks the rejection examples, the default batch size, and a fixed-seed histogram. `tests/stress.test.js` covers both packs.

Recruitment scoring remains closed in `wrangler.jsonc` (`LIVE_ENABLED` is `"false"`). Nothing here deploys the Worker.
