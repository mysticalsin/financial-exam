# Mantu financial assessment

## Delivered work

- [x] Inspect the supplied prototype, brand and workspace. Replace browser-side hiring grading, identity collection and local result persistence with a pseudonymous, server-graded recruitment assessment.
- [x] Preserve eight foundation and seven applied competencies in the hiring paper; check calculations and create private variants. Cover assembly, scoring and bounds in tests.
- [x] Build the recruitment Worker with EU-jurisdiction Durable Objects and private EU R2. Keep hiring answer keys, grading, invitation use, deadlines and revisions server-side. Provide protected reviewer and operator workflows.
- [x] Build branded, responsive candidate and reviewer screens with privacy notices, saved hiring answers, final review, submission receipt and same-browser recovery.
- [x] Enforce distinct hiring timelines: stop answer edits at the assessment deadline; purge unused invitations at start-by expiry; retain incomplete records until the earlier of deadline plus 30 minutes or issue plus 60 minutes; retain submitted records until the earlier of submission plus 30 minutes or issue plus 60 minutes. Use read-time cutoffs, per-record deletion alarms and a scheduled cleanup sweep.
- [x] Build a separate public practice mode with its own 15-question bank, `/api/practice/start` and `/api/practice/submit`, encrypted 15-minute challenge, no candidate records or cookies, and shuffled retakes.
- [x] Verify practice shape, calculations, the original 60 choices, the three source tables, encrypted ticket validation, expiry, request bounds, rate limits and separation from recruitment endpoints. The Node suite and practice suite passed repeatedly.
- [x] Verify hosted 15-question practice scoring and shuffled retakes. The release owner read back the public URL, deployed version and frozen manifest hash in `VERIFICATION.md`.
- [x] Prepare a deployment configuration that leaves recruitment closed unless required controller notices and staff access are approved.

## Restored public assessment

- [x] Restore the source test's 15 financial scenarios and 60 answers. Make the billing and cost inputs explicit in the margin-percentage question. In the bench scenario, keep the consultant on payroll when billing stops.
- [x] Render the original monthly portfolio P&L and the consultant and manager comparisons on the scrolling paper.
- [x] Add a branded entrance, answer feedback, an animated portfolio breakdown and a score ring. Respect the device's reduced-motion preference.

## Invited recruitment papers

The private Worker assigns the original 15 scenarios with linked, randomized cases. It keeps each generated paper through refresh, retries and submission. The reviewer can receive a count of distinct questions with reported keyboard copy shortcuts after closure for countries whose approved notice enables it. Grading is independent of this count. The release checks and example portfolios are in [the verification record](VERIFICATION.md).

## Remaining release checks

- [ ] Before recruiting candidates, confirm the company-approved Cloudflare account, named reviewer SSO/IdP identity, approved country notices, controller decisions and processor authorization.

## Review

Public practice is a separate self-study flow. It does not open or authorize recruitment. The deployed version is frozen and its identity is recorded. A pre-final submitted fixture spanning the release was observed through its EU R2 cutoff; it was not submitted on the frozen version. The remaining recruitment authorization gates are listed above. See `VERIFICATION.md` for evidence and limits.

## Studio revision

The expanded design adds a guided start, a five-line Mantu ledger, practice navigation, a focused review workspace and the optional four-category integrity profile described in [the privacy handoff](PRIVACY.md). See [the studio design](../DESIGN.md) for scope and acceptance checks.
