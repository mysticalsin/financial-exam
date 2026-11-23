# Recovery

This repository's first product commit imports the Mantu financial assessment from Tony Walteur's OneDrive Codex tree. The seeded Origin README (`New repo`) was replaced by the recovered README. No Worker was deployed, and the live site was not changed.

## Source

- OneDrive path: `Documents/Codex/2026-11-09/i-ne/outputs/Mantu-Financial-Assessment.zip`
- Unpacked folder inside that zip: `financial-assessment/`
- Matching folder on the same drive: `Documents/Codex/2026-11-09/i-ne/outputs/financial-assessment/`
- Package timestamp in the zip: 2026-11-09. 47 files. Layout: `src/`, `public/`, `tests/`, `scripts/`, `docs/`, `wrangler.jsonc`, `package.json`, `package-lock.json`, `README.md`, `DESIGN.md`, `.gitignore`.

The import assignment named a local tarball, `/agent/uploads/mantu-financial-assessment-source.tar_7fbc.gz`. That path was not on this machine, `/agent/uploads/` did not exist, and no similarly named archive was present. This commit uses the Codex outputs zip above, which is the packaged form of that tree. Provenance is OneDrive Codex outputs tree to this repository. See this file rather than a tarball that was not available here.

## Live Worker

The public Worker `mantu-financial-assessment` at `https://mantu-financial-assessment.tony-walteur.workers.dev/` was left as it is. `docs/VERIFICATION.md` records a 2026-11-09 hosted check of version `7936d669-9a5c-41d2-bef8-f4fec03a3061` against this package's hashes. This import does not re-fetch the Worker that is serving now, so byte-for-byte identity with the current deployment is not proven here. Recruitment scoring in the imported `wrangler.jsonc` stays closed (`LIVE_ENABLED` is `false`).

## Secrets

No secret values were in the archive, and none were committed. `PRACTICE_KEY`, `OPS_TOKEN`, `RATE_KEY`, and Access settings appear only as names and instructions. `.dev.vars*` and `.env*` stay gitignored. Tests generate throwaway values at runtime.
