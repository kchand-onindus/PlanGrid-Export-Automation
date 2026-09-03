# PlanGrid Export Automation

Minimal Playwright automation for exporting project documents.

## Setup

```bash
npm install
npx playwright install chromium
```

Fill in `PLANGRID_EMAIL` and `PLANGRID_PASSWORD` in `.env` before running the export. The password is never written to the logs.

## Run the export flow

The browser is visible by default. Run the export flow with:

```bash
npm run export
```

This currently opens PlanGrid and pauses so you can complete the login/OTP manually. Each run creates a separate timestamped file such as `logs/export-2026-09-03_18-36-40.log`. The login and project selectors will be automated after the platform is inspected.

For a non-visible run:

```bash
npm run headless
```

## Project export flow

The project input is read from `input/projects.csv`. Enabled projects will eventually be searched, checked for completion, and downloaded into `downloads/<project-number>/`.

Shared constants and environment helpers live in the root-level `utils/` folder, separate from the executable workflow code in `src/`.

Each row contains a date range in `YYYY-MM-DD` format:

```csv
project_number,project_name,enabled,from_date,to_date
demo-001,Demo Project,true,2026-01-01,2026-08-31
```

The login and OTP flow is intentionally isolated in `src/auth.ts` so it can be filled in after the platform's exact login behavior is confirmed.
