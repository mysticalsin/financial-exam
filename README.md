# Mantu Financial Test

<p align="center">
  <img src="docs/screenshots/studio-tour.gif" alt="Studio tour of the practice paper: homepage, guide, and portfolio question" width="960" />
</p>

## What this is / how to run

A 15-question practice paper on gross margin and portfolio P&L. [Open the live practice](https://mantu-financial-assessment.tony-walteur.workers.dev).

Recruitment stays closed unless Tony sets `LIVE_ENABLED`. The checked-in value is `false`.

Names only. Values stay out of the repo.

| Name | Role |
| --- | --- |
| `PRACTICE_KEY` | 64 hexadecimal characters. Local dev reads a throwaway value from ignored `.dev.vars`. |
| `ACCESS_ISSUER` | Access team origin. |
| `ACCESS_AUD` | Access audience tag. |
| `RATE_KEY` | Rate-limit secret. |
| `OPS_TOKEN` | Operator secret. The process reads it as `ASSESSMENT_OPS_TOKEN`. |

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

`npm run dev` serves the app on loopback.

## Desktop and mobile

<table>
  <tr>
    <td valign="top" width="72%">
      <img src="docs/screenshots/desktop.png" alt="Desktop homepage" />
    </td>
    <td valign="top" width="28%">
      <img src="docs/screenshots/mobile.png" alt="Mobile homepage" />
    </td>
  </tr>
</table>

Social card: [`docs/screenshots/social-card.png`](docs/screenshots/social-card.png) (1280×640).

[Privacy](docs/PRIVACY.md)
