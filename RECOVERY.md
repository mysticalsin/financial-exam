# Source recovery — Financial Exam

Recovered 2026-11-23 (America/Sao_Paulo).

## Provenance

1. **Primary source tree** (preferred): Tony's OneDrive Codex outputs
   `Documents/Codex/2026-11-09/i-ne/outputs/financial-assessment`
   — modular `src/` (`bank.js`, `worker.js`, `practice.js`, `access.js`), `public/`, `tests/`, `wrangler.jsonc`, docs.
2. **Live Cloudflare Worker** `mantu-financial-assessment`
   URL: https://mantu-financial-assessment.tony-walteur.workers.dev/
   Downloaded `GET .../content/v2` multipart → `recovered-from-cloudflare/worker.bundle.js` (+ `.map`).
3. **Live public assets** re-fetched into comparison; byte-match existing `public/` for app/styles.

Live bindings at recovery (do **not** commit secrets):
- ASSETS, ATTEMPTS (DO), RECORDS (R2 EU), RATE_LIMITER
- `DURATION_MINUTES=15` in source (`INVITE_TTL_MINUTES` remains 30: it is the start-by window, not the exam clock). Live Worker was still 30 at recovery and has not been redeployed.
- `INVITE_TTL_MINUTES=30`, `LIVE_ENABLED=false`, `PRACTICE_KEY` (secret)

Screenshots / studio mp4 under docs/screenshots were omitted (large binaries).

## Recovered vs still missing / gaps

| Area | Status |
|------|--------|
| Modular Worker + bank + practice + access | Recovered in `src/` |
| Public UI (candidate + practice + review) | Recovered |
| Unit/UI/integration tests | Recovered under `tests/` |
| Bundled live Worker + source map | `recovered-from-cloudflare/` |
| Live `/api/config` snapshot | `recovered-from-cloudflare/api-config.json` |
| `robots.txt` | Recovered from live |
| Durable Object class source | **Partial** — DO logic lives inside modular `src/worker.js` (Assessment namespace via `env.ATTEMPTS`); no separate DO file |
| Question bank size | **Generative** templates in `src/bank.js` (~dozen item factories + random params), **not** a static 100–200 curated bank yet |
| 15-minute timer | Source default is 15 minutes for practice and recruitment. Not deployed. |
| End-only score + good/bad explanations | Implemented in source for practice and recruitment. Explanations are withheld until submit. Not deployed. |
| Luxurious UI + Rust hot paths + stress/perfection bar + 100–200 question bank | **Project backlog** |

## Tony requirements (Project backlog — do not treat as done)

- 15-minute exam timer — done in source; not deployed
- 100–200 question rotation bank (anti-memorization)
- Score + right/wrong explanations **only at the end** (no per-question drip) — done in source for practice and recruitment; not deployed
- Rich / luxurious UI + animations
- Uncheatable (server-side keys, no answer leakage)
- Full stress tests every pack; refactor for efficiency; Rust on hot paths where it helps UX
- Perfection bar: bug-free, hyperfluid, E2E, deep QA, enterprise-ready security
- No live Worker deploy from recovery alone
