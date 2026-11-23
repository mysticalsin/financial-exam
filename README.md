<p align="center">
  <img src="public/mantu-wordmark.svg" alt="Mantu" width="214" />
</p>

# Financial Test

A 15-question practice paper on gross margin and portfolio P&L.

[Open the live practice](https://mantu-financial-assessment.tony-walteur.workers.dev)

Recruitment stays closed unless Tony sets `LIVE_ENABLED`.

<p align="center">
  <img src="docs/screenshots/studio-tour.gif" alt="Studio tour: homepage, the paper guide, and the portfolio question" width="960" />
</p>

## Desktop and mobile

<table>
  <tr>
    <td valign="top" width="72%">
      <img src="docs/screenshots/desktop.png" alt="Desktop homepage: Financial Test beside the example portfolio" />
    </td>
    <td valign="top" width="28%">
      <img src="docs/screenshots/mobile.png" alt="The same homepage on a phone, with the portfolio under the start button" />
    </td>
  </tr>
</table>

## Result and warm-up

<table>
  <tr>
    <td valign="top" width="50%">
      <img src="docs/screenshots/result.png" alt="Practice result shown in the browser: 15 of 15, Excellent" />
    </td>
    <td valign="top" width="50%">
      <img src="docs/screenshots/warm-up.png" alt="Optional gross-margin warm-up before the 30-minute practice" />
    </td>
  </tr>
</table>

## On the paper

<table>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/portfolio.png" alt="Monthly portfolio P&amp;L used on the applied questions" />
    </td>
    <td valign="top">
      <img src="docs/screenshots/studio-case-1.png" alt="Applied question 12 with portfolio figures and an integrity observations notice" />
    </td>
    <td valign="top">
      <img src="docs/screenshots/studio-case-2.png" alt="The same applied question with a second set of portfolio figures" />
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/recruitment-case-1.png" alt="Recruitment question 10 with a copy-shortcut notice" />
    </td>
    <td valign="top">
      <img src="docs/screenshots/recruitment-case-2.png" alt="Recruitment question 11 with a copy-shortcut notice" />
    </td>
    <td valign="top">
      <img src="docs/screenshots/studio-reviewer.png" alt="Reviewer record with observation counts after a synthetic submission" />
    </td>
  </tr>
</table>

## Social card

<a href="https://mantu-financial-assessment.tony-walteur.workers.dev">
  <img src="docs/screenshots/social-card.png" alt="Mantu Financial Test social card, cropped from the desktop homepage" width="1280" />
</a>

`docs/screenshots/social-card.png` is a 1280×640 crop of the desktop homepage.

## Practice

Choose **Start practice assessment** on the [live practice](https://mantu-financial-assessment.tony-walteur.workers.dev). The guide includes an optional gross-margin warm-up, then **Start 30-minute practice**. The paper has eight foundation questions and seven applied questions. The Worker shuffles question order within each section and shuffles answer positions. Answers stay in the page until submit. The challenge is encrypted with `PRACTICE_KEY` and expires 30 minutes after issue. The response contains an aggregate score, total, answered count, and timestamp. Bands are Excellent, Good, Average, and Insufficient. Practice scores are private to that browser session.

Use Node 22.12 or later.

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

`npm run dev` serves the app on loopback. `npm run deploy` is for the authenticated Cloudflare account only. The checked-in configuration ships with recruitment scoring closed.

## Secret names

These are names only. Values stay in the approved secret store and out of source, configuration vars, and chat.

| Name | Role |
| --- | --- |
| `PRACTICE_KEY` | 64 hexadecimal characters (32 bytes). Worker secret for practice challenges. Local development reads a throwaway value from an ignored `.dev.vars` file. |
| `ACCESS_ISSUER` | HTTPS team origin for the reviewer Access application. |
| `ACCESS_AUD` | Access application audience tag. |
| `RATE_KEY` | High-entropy Worker secret for rate limiting. |
| `OPS_TOKEN` | High-entropy Worker secret for the command-line operator flow, when that flow is required. The process reads it as `ASSESSMENT_OPS_TOKEN`. |

Recruitment stays closed unless Tony sets `LIVE_ENABLED`.

[Privacy handoff](docs/PRIVACY.md) · [Verification](docs/VERIFICATION.md) · [Recovery](RECOVERY.md)
