# Candidate interface motion

This note is the spec for the candidate-facing surface. It does not change the server timer, the rotating bank, grading, or when explanations appear.

## Keep

- Practice and recruitment each run on a server deadline. Practice is 15 minutes. A recruitment invitation shows the allowance the server issued.
- The paper never shows an answer key or an explanation. Score, good/bad, and the short explanation for each question appear only after submit, or after a hiring attempt has ended.
- Practice stays anonymous and separate from recruitment. The landing ledger is the public portfolio (€120,000, €78,000, €42,000, €18,000, €24,000), not a hiring paper.
- Keyboard access, visible focus, 320px reflow, and table-only horizontal scrolling stay in place.

## Untangle

`public/styles.css` had three skins in one file: an unused portfolio hero, a 480px welcome card, and the studio landing that overrode both. Dead banner keyframes still described a screen the HTML no longer renders. Practice paper chrome and the recruitment question rail did not share a surface. The practice paper label still said 30 minutes.

One skin remains. Warm paper (`#f4f1f6`), ink (`#281335`), plum (`#2b0058`, `#6600ae`), and one yellow accent (`#f8f060`). System fonts. Tabular figures on money, countdowns, scores, and question numbers. Landing order stays brand, title, scope, facts, start, then the five-row ledger. Below 680px the start control stays above the ledger.

## Motion

Shared ease: `--ease-fluid: cubic-bezier(0.22, 1, 0.36, 1)`.

Every animation runs once. Nothing loops, and nothing shimmers while someone is reading.

| Moment | Name | What moves |
| --- | --- | --- |
| Landing ledger, first time it is on screen | `ledger-settle` | Each bar scales from the left, staggered. Widths stay 100 / 65 / 35 / 15 / 20. |
| Practice masthead | `banner-sweep`, `mark-in` | One yellow highlight crosses the plum bar. The mark fades in once. |
| Question cards, recruitment card, result, dialogs | `surface-in`, `fade-in` | Opacity, with an 8px rise on in-flow surfaces. Dialogs fade only, so centering stays put. |
| Score ring | `score-reveal` | `--score-turn` draws to the earned ratio and the ring settles scale. The score and the band are text at once. |
| Hiring receipt mark | `mark-in` | The mark scales in once. |
| Answer row, navigator, timer warning | short transitions | Border, background, and color. The progress fill is a measured bar whose width eases. The native progress element stays available to assistive tech; this Chrome paints that control green and ignores the accent. |

Keyframe properties are `transform`, `opacity`, and `--score-turn` only.

`prefers-reduced-motion: reduce` sets animation and transition duration to `0.01ms` and delay to `0s`, and turns smooth scrolling off. The script already uses an instant jump for that setting. Final bar widths, the full score ring, and the final masthead are what remain.

## Display

The practice paper eyebrow and the first paint of the practice clock show 15:00. After that, the clock follows the server deadline only.
