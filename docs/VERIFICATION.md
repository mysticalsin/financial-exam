# Financial assessment verification

[Open the Cloudflare app](https://mantu-financial-assessment.tony-walteur.workers.dev/)

## Official Mantu artwork

Cloudflare deployed version `c6957662-e48f-431c-a51f-e1f1b34fd50e`. The welcome screen uses the eight paths and original ribbon opacities from [Mantu’s published wordmark](https://mantu.com/). The paper, reviewer header and browser icon use the [official square M](https://mantu.com/icon.svg). Both SVGs are served by the assessment. Chrome verified the hosted image bytes, intrinsic proportions, and header rendering at 320, 390 and 1440 CSS pixels. The reviewer browser suite and Worker build passed.

## Prior studio release

At 2026-11-09 20:26 EST Cloudflare assigned 100% of traffic to version `7936d669-9a5c-41d2-bef8-f4fec03a3061`. All 9 hosted static assets matched their local hashes. The public site served practice, the staff API returned 403 to an unsigned request, and the EU R2 bucket contained zero assessment objects. The account was configured with no live hiring country or staff identity. [Source manifest](SOURCE-SHA256.txt), SHA-256 `61f166da3384ef2ba50dafc30a2f5257e316cf8ae09e2633bf295a01c0f83f65`.

### Candidate experience

The hosted Chrome run completed the optional warm-up before starting the clock, navigated the answer-status filters, matched the 15 public questions and their correct choices against the original source, and submitted a 15/15 paper. The browser had no practice cookie or persistent answers. An automated axe scan found no tagged WCAG A/AA violations on the sampled welcome, guide, warm-up, paper and result screens. It does not constitute a full accessibility audit.

Motion checks measured the five rendered bars against revenue at widths of 320, 390, 720 and 1440 CSS pixels. Their final proportions were 100%, 65%, 35%, 15% and 20%. Chrome fired five one-time bar entrances with ordinary motion and none with reduced motion. The start control was in the initial viewport on the tested layouts. [Desktop](screenshots/desktop.png) · [Mobile](screenshots/mobile.png) · [Warm-up](screenshots/warm-up.png) · [P&L](screenshots/portfolio.png) · [Result](screenshots/result.png) · [Browser recording](screenshots/studio-tour.mp4).

### Private recruitment verification

Two synthetic candidates completed different private papers against the local Worker. An independent solver used only each question's assigned prompt, table and choices. Both sessions recovered the same paper after refresh and their candidate receipts concealed the grade. The test deleted both private records.

| Synthetic candidate | Revenue | Direct costs | Gross margin | Overhead | Contribution | Staff grade |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | €199,500 | €111,720 | €87,780 | €30,880 | €56,900 | 15/15 |
| 2 | €178,100 | €128,232 | €49,868 | €15,430 | €34,438 | 15/15 |

Each closed reviewer record showed native copy on two questions, a context menu on two, a hidden page on one and zero rejected answer choices. Chrome's trusted visibility change occurred during an ordinary refresh. This verifies browser navigation and illustrates a benign trigger. Local Worker tests covered a positive server-only rejected-choice count, deduplication, notice gating, deadlines, erasure and grading independence. The reviewer UI was exercised with a synthetic authorization response and actual generated report. Staff SSO and production invitations still require company configuration. [Synthetic reviewer detail](screenshots/studio-reviewer.png).

The frozen unit suite passed 34 tests. Local Worker integration, candidate, practice and reviewer browser suites passed. The dependency audit reported zero known advisories at the time of the build. The earlier monitored retention evidence below identifies its tested release.

## Prior release evidence

## Recruitment case variants and optional shortcut review

Cloudflare reported version `1e1fbf89-617e-4437-8fa6-1ed0684dcd5e` serving 100% at 2026-11-09 19:57 EST. All 9 hosted public assets matched the release files. The source, tests and configuration are listed in the [manifest](SOURCE-SHA256.txt), SHA-256 `a113acde4c041fb655618511a4fc3271c799aa785f3b92ccd628638c219f616b`. The public site offered anonymous practice and the operator route required authorization. Recruitment remained closed with zero configured country profiles and zero objects in the EU assessment bucket at verification.

Two synthetic candidates completed the private recruitment flow in separate Chrome sessions against the actual local Worker and private test storage. The browser restored each full paper on refresh. An independent calculation using visible question text, choices and tables selected all 30 answers. Each session reported a keyboard-copy shortcut on two different questions. The private reviewer record returned the figures below. The test erased both records. [First candidate question](screenshots/recruitment-case-1.png) · [Second candidate question](screenshots/recruitment-case-2.png)

| Candidate | Revenue | Direct costs | Gross margin | Overhead | Operating contribution | Financial score | Distinct questions with reported shortcuts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | €218,700 | €155,277 | €63,423 | €35,220 | €28,203 | 15/15 | 2 |
| 2 | €121,400 | €65,556 | €55,844 | €28,270 | €27,574 | 15/15 | 2 |

The current ranges allow more than 124 million distinct monthly portfolio tables. Question and option order are shuffled independently. The two comparison questions require the candidate to calculate the ratios from their table. Financial figures may recur across independently generated attempts.

The unit suite passed 30 tests, including recomputation from displayed figures across 1,500 generated papers, scoped saves, grading, deadlines, rate limits, disclosure, deduplication, expiry and erasure. Local Worker integration and candidate, reviewer and practice browser suites passed. The locked dependency audit returned zero known advisories. Chrome confirmed that the page policy denies clipboard reads while the normal copy shortcut still works. The hosted document policy also isolates the page from cross-origin openers. The production browser smoke test exercised the public original paper and graded a complete submission.

The shortcut count is advisory. The browser can report a supported copy shortcut in its focused assessment page. A server cannot independently verify those client observations, observe another application or distinguish benign copying from outside assistance. Missing reports do not establish independent work. Financial grading uses only submitted choices. The setting defaults off and requires an approved country notice with a matching pre-start acknowledgment. See the [privacy handoff](PRIVACY.md).

The private two-candidate check used a synthetic locally enabled profile. Real candidate access and a live positive Mantu reviewer SSO sign-in remain unverified.

## Earlier retention and public practice evidence

The following observations came from the earlier release on November 9. This visual update rechecked the live account and ran the local Worker retention suite.

| Scenario | Result | Boundary |
| --- | --- | --- |
| Public practice challenge | The Worker rejects a challenge at 15 minutes after issue. Practice answers and scores are not written to R2 or Durable Object storage, so no server-side practice deletion is required. The in-page result clears after up to 30 minutes, or on reload/page exit. | Application behavior; Cloudflare still processes network and rate-limit metadata. |
| Recruitment lifecycle boundaries | Answer edits stop at the assessment deadline. Unused invitations purge at start-by expiry. Incomplete attempt records cut off at the earlier of deadline plus 30 minutes or issue plus 60 minutes. Submitted records cut off at the earlier of submission plus 30 minutes or issue plus 60 minutes. | These are distinct application cutoffs; deadline stops editing but does not itself erase the incomplete staff record. |
| Earlier unused-invitation fixture | A one-minute synthetic unused invitation was absent from R2 before any application read. | This fixture was seeded before the final source freeze, so it is an earlier short-window check, not the final deployed-source observation. |
| Submitted fixture observed during the preceding release | The fixture was submitted 2026-11-09 15:36:33.754 America/Toronto. Its scheduled cutoff was 16:06:33.754. The last EU R2 listing with the object was 16:06:31.734; the first listing without it was 16:06:37.383, 3.629 seconds after cutoff. A separate Cloudflare account API listing confirmed zero objects at 16:07 America/Toronto. No application lookup or manual erase occurred between submission and the first absent listing. | The fixture began before the final source freeze and spanned the preceding release; it was not submitted against the frozen version. The observed deletion instant lies between the listings. This proves application-object removal in the observed R2 listing interval, not physical-media or all-replica erasure at cutoff. |
| Physical erasure and service metadata | Not verified within the application cutoff. | Cloudflare physical-media erasure and separate network, identity, security, billing and account logs can follow other retention limits. |

## Recruitment activation

Company processor authorization, country notices, a confirmed controller and a positive reviewer SSO sign-in remain open. See [the privacy handoff](PRIVACY.md) before accepting recruitment candidates.
