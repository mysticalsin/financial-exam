# Draft stacks

Inventory as of 2026-11-25. `main` is `d83dae23`, which includes merged pull request [#13](https://github.com/mysticalsin/financial-exam/pull/13) (the practice timer is 15 minutes). Every draft below still forks from `c7f58f9` and is eight commits behind `main`.

This file does not merge or deploy anything. Branch tips were not moved.

## Canonical set

Keep these four open drafts. Each one uses base ref `main`. They are separate branches, and they overlap, so rebase them onto current `main` one at a time before any merge.

| PR | Role | Branch | Tip |
| --- | --- | --- | --- |
| [#3](https://github.com/mysticalsin/financial-exam/pull/3) | PASS. 15-minute exams, explanations only after submit. Supersedes #1. | `cursor/fifteen-minute-end-review-d2e9` | `6ba73e8b` |
| [#4](https://github.com/mysticalsin/financial-exam/pull/4) | UI. Studio motion. | `cursor/luxurious-studio-motion-6a04` | `ba4975a1` |
| [#5](https://github.com/mysticalsin/financial-exam/pull/5) | Stress tests. Scoring stays in JavaScript. | `cursor/pack-stress-hot-path-4481` | `b841a976` |
| [#7](https://github.com/mysticalsin/financial-exam/pull/7) | Bank. Each attempt draws 15 questions from a 200+ bank. | `cursor/question-bank-rotation-b13c` | `2c16c0dd` |

[#13](https://github.com/mysticalsin/financial-exam/pull/13) already landed the shorter practice clock. #3 still holds the end-of-paper review. Against today's `main`, #4 merges cleanly, #3 conflicts in `README.md` and `public/practice.js`, and #5 and #7 conflict in `README.md`.

#3 also overlaps #4 in the public studio files, and #3, #5, and #7 overlap in the bank and practice sources. A merge of one will not carry the others.

## Alternate stack

Leave these unmerged. [#6](https://github.com/mysticalsin/financial-exam/pull/6), [#9](https://github.com/mysticalsin/financial-exam/pull/9), and [#10](https://github.com/mysticalsin/financial-exam/pull/10) stay drafts until they are restacked onto the canonical branches, or until they are closed after #3, #4, #5, and #7 land.

| PR | Base | Branch | Tip | State |
| --- | --- | --- | --- | --- |
| [#1](https://github.com/mysticalsin/financial-exam/pull/1) | `main` | `cursor/fifteen-minute-end-explanations-f472` | `ba89d5ef` | Closed draft, not merged. Superseded by #3. |
| [#6](https://github.com/mysticalsin/financial-exam/pull/6) | #1 at `ba89d5ef` | `cursor/rotating-question-bank-d907` | `467b1f3f` | Open draft. Hiring question bank. |
| [#9](https://github.com/mysticalsin/financial-exam/pull/9) | #6 at `467b1f3f` | `cursor/premium-fluid-ui-bb77` | `2afad820` | Open draft. Fluid candidate UI. |
| [#10](https://github.com/mysticalsin/financial-exam/pull/10) | #9 at `2afad820` | `cursor/pack-stress-hotpath-4c67` | `6a616f2f` | Open draft. Pack stress tests. |

#6 still targets #1's branch. That parent pull request is closed, so this chain has no open path into `main`.
