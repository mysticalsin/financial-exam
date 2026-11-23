<p align="center">
  <img src="public/mantu-wordmark.svg" alt="Mantu" width="214" />
</p>

# Financial Test

<p align="center">
  <a href="https://mantu-financial-assessment.tony-walteur.workers.dev">Open the live practice</a>
</p>

<p align="center">
  <img src="docs/assets/home-to-practice.gif" alt="Homepage, practice guide, then the paper" width="960" />
  <br />Homepage, guide, then the paper
</p>

<p align="center">
  <img src="docs/assets/question-answer.gif" alt="A question enters and an answer is selected" width="960" />
  <br />Question entrance and an answer select
</p>

<p align="center">
  <img src="docs/assets/score-receipt.gif" alt="Submit the paper and the private score receipt arrives" width="960" />
  <br />Submit, then the private score receipt
</p>

<table>
  <tr>
    <td colspan="2">
      <img src="docs/screenshots/desktop.png" alt="Desktop homepage" width="100%" />
      <br />Desktop homepage
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="docs/screenshots/mobile.png" alt="Phone homepage" width="280" />
      <br />Phone homepage
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/result.png" alt="Practice result" width="100%" />
      <br />Practice result
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/warm-up.png" alt="Gross-margin warm-up" width="100%" />
      <br />Gross-margin warm-up
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/studio-case-1.png" alt="Applied case with an integrity notice" width="100%" />
      <br />Applied case, integrity notice
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/studio-case-2.png" alt="The same applied case with a second set of figures" width="100%" />
      <br />Same case, second set of figures
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <img src="docs/screenshots/studio-reviewer.png" alt="Reviewer record" width="100%" />
      <br />Reviewer record
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <img src="docs/screenshots/social-card.png" alt="Social card cropped from the desktop homepage" width="100%" />
      <br />Social card, 1280×640
    </td>
  </tr>
</table>

<details>
<summary>Run it</summary>

A 15-question practice paper on gross margin and portfolio P&L. Recruitment stays closed unless Tony sets `LIVE_ENABLED`. The checked-in value is `false`.

Names only. Values stay out of the repo: `PRACTICE_KEY` (64 hexadecimal characters; local dev reads a throwaway from ignored `.dev.vars`), `ACCESS_ISSUER`, `ACCESS_AUD`, `RATE_KEY`, `OPS_TOKEN` (the process reads it as `ASSESSMENT_OPS_TOKEN`).

Node 22.12 or later.

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

`npm run dev` serves the app on loopback. [Privacy](docs/PRIVACY.md)

</details>
