# Repository guidance for agents

## Scope and excluded material

This repository contains the active PlanGrid/Autodesk export automation. The `reference-scripts/` directory is personal reference material and is completely outside the repository code.

Agents must ignore `reference-scripts/` at all times during repository analysis, implementation, testing, and workflow design. Do not read, execute, modify, move, delete, or include anything from that directory, and do not use it to infer requirements or implementation details.

## Project purpose

This repository contains two related automation parts.

### Part A — PlanGrid export (available)

The working export application uses Playwright to:

1. Launch a fresh browser for automated login, or attach to an already-running authenticated Chrome session.
2. In automated mode, open PlanGrid, hand off authentication to Autodesk, and complete the email/password steps.
3. Pause for manual Autodesk CAPTCHA, OTP, or other verification when required.
4. Verify the authenticated PlanGrid projects page before continuing.
5. Find enabled projects from `input/projects.csv`.
6. Create or locate As-built exports, wait for completion, and download ZIP files.
7. Preserve a final visible-browser verification pause. Automated mode attempts logout and closes its browser; Chrome session mode skips logout and disconnects while leaving Chrome open and signed in.

### Part B — Kahua import (in development)

Part B currently:

1. Reads `input/version_sets.csv` for one configured project.
2. Validates and extracts ordered drawing versions from the downloaded ZIP.
3. Writes an `import-plan.json` for later upload automation.
4. Opens Kahua, enables Uno accessibility semantics, completes the email/password steps, handles the known DevProduction notice, and verifies the authenticated landing page.

Kahua project selection, upload navigation, file upload, portal processing, and multiple-project iteration are not implemented yet. Keep Part B clearly marked as in development in user-facing documentation until those stages are complete.

CAPTCHA and OTP solving must remain manual in either workflow. Do not add CAPTCHA bypassing, credential scraping, or other authentication circumvention.

## Active repository layout

- `src/main.ts`: application orchestration, browser lifecycle, project loop, cleanup, and exit status.
- `src/auth.ts`: PlanGrid/Autodesk login, manual verification pause, authenticated-projects validation, and logout.
- `src/chrome-session.ts`: CDP attachment to existing Chrome using debugging connection metadata or an explicit endpoint; does not launch Chrome or read credentials/cookies.
- `src/project-exporter.ts`: project search, project navigation, As-built export handling, progress polling, and ZIP download.
- `src/csv.ts`: project CSV parsing and validation.
- `src/logger.ts`: timestamped console/file logging and duplicate-error tracking.
- `src/config.ts`: repository-relative paths and environment-derived configuration.
- `src/types.ts`: project and export result types.
- `src/import/`: Part B local ZIP validation, extraction, import-plan generation, configuration, and tests.
- `src/kahua/`: Part B Kahua browser startup, login, Uno accessibility helpers, and configuration.
- `utils/constants.ts`: URLs, environment variable names, timeouts, and DOM selectors.
- `utils/env.ts`: repository `.env` loading and required credential validation.
- `playwright.config.ts`: browser visibility and Playwright timeout settings.
- `input/projects.csv`: project input data.
- `input/version_sets.csv`: Part B drawing-version metadata and upload ordering.
- `downloads/`: downloaded ZIP output; preserve `.gitkeep` and do not commit generated exports.
- `logs/`: generated run logs; preserve `.gitkeep` and do not treat logs as source code.

## Commands and validation

Install dependencies and Chromium:

```bash
npm install
npm run install:browsers
```

Run the normal visible flow:

```bash
npm run export
```

Attach to already-running Chrome after signing in to PlanGrid and enabling remote debugging:

```bash
npm run export:chrome
```

Part A supports automated login and existing Chrome sessions. Do not reintroduce the removed standalone manual-login mode. CAPTCHA and OTP verification remain manual when requested by Autodesk.

Run headless mode only when no manual authentication is needed:

```bash
npm run headless
```

Headless mode uses the automated login flow and does not reuse an attached Chrome session. All three npm export commands work on macOS/Linux and Windows Command Prompt or PowerShell. They use `src/run-export.ts` to set `HEADLESS` inside Node.js before loading the application. See `README.md` for setup and platform-specific commands.

Keep the README's instructions for all three modes explicit and self-contained: include prerequisites, macOS/Linux and Windows PowerShell commands, required user actions, and the end-of-run browser behavior. Chrome instructions must tell the user to paste `chrome://inspect/#remote-debugging` into Chrome's address bar, enable remote debugging, accept the Allow prompt, and click Resume in Playwright Inspector after the projects page and search box appear. Distinguish the Chrome Allow prompt from the Inspector Resume button, and retain the macOS Files & Folders permission steps. Do not replace these setup instructions with command names alone.

Run the current Part B local preparation and its tests:

```bash
npm run import:prepare
npm run test:import
```

Run the current visible Kahua login flow:

```bash
npm run kahua
```

Type-check changes with:

```bash
npm exec tsc -- --noEmit
```

There is no automated test suite for Part A or the Kahua browser flow. Part B's local preparation tests run with `npm run test:import`. For code changes, run the TypeScript check and use the smallest relevant validation available; do not launch a real login/export run unless the user requests it or it is clearly part of the task.

## Configuration and sensitive data

Automated PlanGrid login requires these repository `.env` credentials:

- `PLANGRID_EMAIL`
- `PLANGRID_PASSWORD`

Shared optional configuration:

- `PLATFORM_URL` (defaults to `https://app.plangrid.com`; initial navigation for automated login only)
- `DOWNLOAD_DIR` (defaults to `downloads`)
- `PLANGRID_CHROME_USER_DATA_DIR` (Chrome mode only; overrides the directory used to locate `DevToolsActivePort`)
- `PLANGRID_CDP_URL` (Chrome mode only; overrides automatic discovery with an existing CDP endpoint)

Chrome session mode does not read or require PlanGrid credentials from `.env`. Debugging WebSocket endpoints are sensitive connection data and must not be logged or committed.

The Part B Kahua browser command additionally requires:

- `KAHUA_USERNAME`
- `KAHUA_PASSWORD`
- `KAHUA_URL` (defaults to `https://devproductionlaunch.kahua.com/`)

Never print, commit, or include passwords, OTPs, cookies, session data, or other secrets in logs, source, patches, or responses. The logger intentionally records whether a password was loaded, not its value.

## Authentication behavior

### Part A — Automated PlanGrid and Autodesk login

The visible flow may navigate from PlanGrid to `signin.autodesk.com`. After Autodesk password submission, the script may wait for:

- direct return to PlanGrid, or
- manual CAPTCHA/OTP/additional verification.

After manual verification, the user must complete the challenge, submit it, wait until the PlanGrid projects page and `input[name="project_search"]` are visible, then click Resume in the Playwright window. `src/auth.ts` validates both the URL and search field before the export loop starts. If Resume is clicked too early, the run should fail with an authentication error rather than attempting project work.

Keep selectors in `utils/constants.ts`; keep authentication state checks in `src/auth.ts`. Do not rely on a fixed delay as proof that login succeeded.

### Part A — Existing Chrome session

`npm run export:chrome` attaches through CDP to regular Chrome that the user has already opened and authenticated. On Chrome 144 or newer, the user enables remote debugging at `chrome://inspect/#remote-debugging` and accepts Chrome's connection prompt. Run the script as the same OS user as Chrome. On macOS, accessing the connection metadata may require Google Chrome access for the terminal or host app under Privacy & Security > Files & Folders.

The script opens a new export tab in the existing default browser context and navigates to the projects page; an existing PlanGrid tab does not need to remain open. `verifyAttachedChromeSession` in `src/auth.ts` pauses for Resume, then validates the projects URL and visible search field before exports. Preserve this verification and the final visible pause. Skip automatic logout both after exports and during failure cleanup. Closing the CDP connection must disconnect without closing the user's Chrome or its tabs.

For hosted execution, Chrome and the script should run together in a persistent interactive desktop session. Authentication must be established on that machine, and session expiration requires user reauthentication. The current connection approval and Inspector pauses mean this mode is not an unattended scheduled workflow. Never read or copy browser cookies or credentials to establish the connection.

### Part B — Kahua

The separate Kahua login flow starts in `src/kahua/main.ts`. Its initial `page.goto` waits for navigation to commit, with a 60-second limit on receiving the server response. Do not change this to `domcontentloaded` or `networkidle`: Kahua's Uno application may take several minutes to initialize after the response has arrived.

After navigation commits, readiness must be determined from the Uno canvas and semantic accessibility controls in `src/kahua/uno.ts` and `src/kahua/auth.ts`. Keep those waits element-driven and do not add a fixed sleep as proof that the email, password, notice, or authenticated landing screen is ready. A failure to receive the initial response within 60 seconds is a navigation failure; slow rendering after that point remains under the user's control.

## Input and output conventions

`input/projects.csv` requires `project_name` and `enabled`. `enabled` must be `true` or `false`; optional dates must use `YYYY-MM-DD`. Project names are also used to derive sanitized download directory names.

Part B reads `input/version_sets.csv` and currently prepares only the project pinned in `src/import/config.ts`. Preparation output belongs under `<DOWNLOAD_DIR>/import-preparation/`; Kahua upload output does not exist yet because upload automation is still in development.

Generated files belong under the configured download directory. Run logs are written under `logs/` with UTC timestamps. Avoid committing generated downloads, logs, browser profiles, or local `.env` files.

## Change expectations

- Preserve unrelated user changes and inspect `git status` before editing.
- Use `apply_patch` for source and documentation edits.
- Prefer small, targeted changes that preserve the current login/export flow.
- Update `README.md` when user-facing behavior, setup, or manual steps change.
- Validate TypeScript and whitespace after edits.
- Do not make destructive changes to input data, downloads, logs, credentials, or browser state without explicit user direction.

## API tooling

Postman CLI is installed and may be used for API engineering work when a task specifically requires it. This project’s current workflow is browser-based Playwright automation; do not introduce API calls merely to replace the existing browser login flow.
