# Financial Exam (Mantu Financial Assessment)

> Recovered into git as **financial-exam** (2026-11-23). See [RECOVERY.md](./RECOVERY.md) for provenance, gaps, and Tony Project requirements (15‑min timer, 100–200 Q bank, end-only scoring, luxurious UI, uncheatable, stress/Rust, perfection bar). Live Worker untouched.

# Mantu financial assessment

The [public site](https://mantu-financial-assessment.tony-walteur.workers.dev/) offers a 15-question practice paper for self-study. Practice uses its own question bank and encrypted 30-minute challenge. The Worker returns aggregate score information; it does not create a candidate record or hiring result. Cloudflare still processes network requests and short-term rate-limit metadata.

Recruitment is a separate, gated mode. A candidate uses a single-use invitation, sees the approved notice for the recruiting country, and takes a 15-question assessment. The Worker grades submitted answers, and a recruiter reviews the result. Countries without a complete approved notice profile remain closed to scored invitations and assessment starts. The app makes no hiring decision.

## Public practice

Choose **Start practice assessment** on the public homepage. The guide includes an optional gross-margin warm-up. Choose **Start 30-minute practice** when ready. The question navigator lets you jump between items and filter by answer status. The scrolling paper restores the supplied Amaris test's eight foundation questions and seven applied questions, with the original answer choices, monthly portfolio P&L, consultant comparison and manager comparison. The Worker shuffles question order within each section and answer positions. Retakes preserve the original financial figures. Answers stay in page memory and are sent to the Worker only when submitted. The challenge is encrypted with `PRACTICE_KEY` and expires 30 minutes after issue. A valid paper can be scored again before expiry; the response contains only an aggregate score, total, answered count and timestamp. The result remains in page memory for up to 30 minutes after submission. Select **Retake practice assessment** for a fresh paper. Practice scores and answers are not available to recruiters and cannot be used as a recruitment invitation or session.

The results panel shows the score out of 15 with the original Excellent, Good, Average and Insufficient bands. The motion treatment honors the operating system’s reduced-motion setting.

The practice page needs no invitation, account, staff sign-in, or recruitment privacy profile. It sets no assessment cookie and creates no stored attempt. That does not mean the service sees no technical metadata: Cloudflare processes network requests, and the Worker applies short-term rate limiting. See [Privacy handoff](docs/PRIVACY.md).

## Operate the app

Open the homepage for the public sample. Authorized reviewers use `/review/` on the same host. Select an approved recruiting country, optionally adjust the time allowance (5 to 55 minutes), and create an invitation when the candidate is ready. Copy the private link and keep the reference in the approved recruitment system. The app does not send messages. A lost private link cannot be recovered from the operator record. Check notice configuration after every deployment: an invitation carries its assigned notice version, and a country without a complete profile is rejected.

Review an attempt using its 32-character reference. Submitters see a receipt; the reviewer sees the selections, expected answers, status and score. Expired, incomplete attempts have no final score. If the candidate needs another attempt, erase the original and issue a new invitation. A trusted operator can also issue, retrieve or erase a reference with the CLI. Downloading persistent copies defeats the in-app retention policy. Limit exceptional exports to approved rights-request handling.

The invitation is normally available to start for up to 30 minutes. A longer time allowance shortens its start window so the candidate always gets the promised duration. An unused invitation is purged when its start-by expiry passes. Answer edits stop at the assessment deadline. An incomplete attempt's staff record is retained until the earlier of 30 minutes after its deadline or 60 minutes after invitation creation. A submitted record is retained until the earlier of 30 minutes after submission or 60 minutes after invitation creation. Each record has a read-time cutoff, an erasure alarm, and a periodic cleanup sweep. The private EU R2 bucket holds assessment records; Durable Object SQLite holds alarm state only. The application cutoffs do not promise physical-media erasure or deletion of separate provider metadata within those windows. Read the privacy handoff for details. [Privacy handoff](docs/PRIVACY.md)

The secure session cookie and temporary recovery claim are limited to the attempt's cutoff. Answers are stored by the service, not as a browser results ledger. Candidates using a shared device should submit or stop, close the browser session, and avoid leaving the invitation open. Refresh recovery is intended for the same browser session.

## Enable recruitment in an approved account

1. Use a private EU R2 bucket dedicated to this app. The shipped configuration names `mantu-financial-assessment-records`. For a fresh account create it with `npx wrangler r2 bucket create mantu-financial-assessment-records --jurisdiction eu`. Keep public access, custom domains, external replication and bucket locks disabled.
2. Configure a Cloudflare Access self-hosted application covering both `/review` and its subpaths, and `/api/ops/*` on the same hostname, using one application audience. Allow only the designated recruiter group via the organization's IdP. Require MFA and a suitable session lifetime. Leave the candidate paths outside the staff policy. Set `ACCESS_ISSUER` to the exact HTTPS team origin and `ACCESS_AUD` to the application's audience tag. The Worker verifies the signed assertion and rejects missing or invalid tokens. Set `RATE_KEY` as a high-entropy Worker secret. [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
3. Put `NOTICE_PROFILES` in the Worker vars as a JSON object keyed by each approved uppercase two-letter country. Each profile needs `controller`, `contact`, `basis`, `recipients`, `transfers`, `rights`, `purpose`, `supervisoryAuthority`, `version` and the number `retentionMinutes: 30`. Include application-specific and locally understandable wording approved for that recruiting country. Reviewers can select only configured profiles; a country without a complete profile cannot receive or start scored invitations. Update the version whenever the notice changes. The interface and scored bank are in English.
4. Record the controller's authorization of the processor/account, recruitment purpose, retention, notices, genuine human review and accommodations. Verify named reviewer SSO/IdP access for the designated recruiter group. A real Mantu reviewer identity and company processor authorization have not been verified by the synthetic hosted run. Use a controlled interpreter or alternative assessment if needed. Confirm the required availability, incident and access auditing arrangements. The authenticated personal account used for the preview has not been established as a company-contracted processor for real candidates.
5. Set `LIVE_ENABLED` to the string `true` in your reviewed configuration and deploy. Inspect `/api/config`, sign in to the reviewer workspace, and run a complete synthetic test with early erasure before inviting anyone. Keep the source of configuration aligned with the deployed vars; a redeploy uses the values in the local configuration. Return `LIVE_ENABLED` to `false` to close scoring, then handle any active candidates with the recruiting team. Cleanup continues when scoring is closed.

For a controlled command-line workflow, configure a high-entropy `OPS_TOKEN` Worker secret only if required. Retrieve it from the approved secret store into `ASSESSMENT_OPS_TOKEN` for the process; set `ASSESSMENT_URL` to the HTTPS origin. Never put credentials in a URL or paste them into the reviewer page. Use `npm run ops -- invite FR 30`, `npm run ops -- get <reference>` or `npm run ops -- delete <reference> --confirm`. An upstream Access policy may also govern machine access. Production staff should use individual Access identities.

## Development and verification

Use Node 22.12 or later. From this folder run:

```sh
npm ci
npm test
npm run test:integration
npm run test:candidate-ui
npm run test:practice-ui
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npm run test:reviewer
npm run build
npm run dev
```

### Practice secret

`PRACTICE_KEY` must be 64 hexadecimal characters representing 32 random bytes. For Cloudflare, provision it as a Worker secret named `PRACTICE_KEY` with `npx wrangler secret put PRACTICE_KEY`, retrieving the value from the approved secret store entry `MANTU_FINANCIAL_PRACTICE_KEY`. Keep the value out of source, configuration vars, chat and command history. Do not rotate the secret casually: existing practice challenges stop working when it changes.

For loopback development, create an ignored `.dev.vars` file containing `PRACTICE_KEY=<64-hex-character throwaway key>`. Use a development-only value; never copy the production key. The repository ignores `.dev.vars*`. Remove the local file when finished.

Local Wrangler serves the app on loopback. The development and integration entrypoints adapt the EU namespace call for the emulator. Only the deployed entrypoint requests actual EU placement. The integration suite supplies temporary fictional notices and secrets and exercises the scored path in isolated local R2 storage. The checked-in deploy configuration ships with recruitment scoring closed. Use `npm run deploy` only from the intended authenticated Cloudflare account. Keep bundle output, development state and dependency trees out of public assets. Read `docs/VERIFICATION.md` for hosted practice and synthetic recruitment evidence and its limits; hosted practice does not authorize live recruitment.

## Integrity and fairness

Recruitment candidates receive the same coverage: eight foundation and seven applied competencies. The hiring Worker uses the 15 original question scenarios. At the first accepted start it generates the daily-rate case, team figures, monthly portfolio and comparisons. Each table, numerical choice and grading key comes from that paper. Questions shuffle within each section and the choices shuffle within each question. Returning to the same attempt restores the same figures and option IDs. Only the assigned hiring paper is sent to the authorized session. Answer keys, hiring bank, grading, invitation use, deadlines and accepted revisions remain server-side. Retrying a successful hiring submission returns its existing receipt. Rate limiting supplements the one-attempt rule.

Practice uses the supplied financial test in a separate bank. Each attempt shuffles questions within sections and shuffles the answer choices. Both modes teach or assess the original scenarios. Public practice uses the original figures, so its numerical answer key does not apply to every private paper. Practice does not import the hiring bank or retain answers. The app uses no webcam, screen capture or fingerprinting. Remote candidates can use another device, share a link before redemption, or photograph a hiring question. A recruiter can use an oral follow-up when independent reasoning matters. The recruitment owner should pilot hiring variants for comparable difficulty and job relevance.

A versioned country profile with `integrityReview: true` enables four distinct-question counts on a scored invitation. The browser can report a native copy with question text selected, a context menu opened on question content, or a transition to a hidden assessment page while a question is active. The server separately counts a rejected answer when the current session submits a well-formed choice that was never issued for that question at the current revision. It discards that value. An issued choice that earns zero points is an ordinary answer.

The Worker deduplicates each category per assigned question. Authorized reviewers can see the four counts after closure. Categories can overlap. Zero means no observations were received for that category. A browser can omit reports. These counts can reflect ordinary research tools, accessibility software, a calculator or a client error. They cannot identify Cluely, establish outside assistance or change the grade. The candidate sees the enabled scope before starting. Practice and default profiles collect none of these signals. Existing `copyShortcutReview: true` profiles retain their original selected-text keyboard-shortcut behavior. Expanded mode takes precedence when both flags are enabled. Each attempt keeps its original notice and deletion deadline.

The original bench-cost question has been corrected. If a consultant stops billing and remains on payroll, removing the billing reduces gross margin by the full lost revenue. Salary continues to be counted exactly once.

[Implementation plan](docs/PLAN.md) · [Revised build prompt](docs/BUILD-PROMPT.md)
