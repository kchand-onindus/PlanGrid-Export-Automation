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
6. Generate a fresh As-built for every enabled project, fill configured dates, check and verify every Include checkbox present, wait for completion, and download ZIP files. When previous builds exist, click Generate a new As-built first; never reuse an old download.
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
- `src/unzip.ts` and `src/unzip-main.ts`: separate CSV-driven, local ZIP extraction into each project's download folder.
- `src/sync/`: CSV-driven local Documents/Photos copying into configurable sync staging, plus temporary-folder tests.
- `src/drawings/`: separate CSV-driven local copying of everything except project-level Documents/Photos, reusing the safeguards in `src/sync/prepare.ts`, plus temporary-folder tests.
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
- `sync_ups/`: default local sync staging output; preserve `.gitkeep` and do not commit copied contents.
- `drawings/`: default local staging for other project contents; preserve `.gitkeep` and do not commit copied contents.
- `logs/`: generated run logs; preserve `.gitkeep` and do not treat logs as source code.

## Commands and validation

The main workflow is Chrome export → unzip → local sync preparation. Complete the shared setup and input/environment configuration first. Keep these three commands in this order in the README and npm script listing. Put the other workflows and validation commands under Miscellaneous in the README; do not add a duplicate Chrome command banner at the top. Show each workflow's command immediately after its heading.

### Chrome export — main workflow

```bash
npm run export:chrome
```

Sign in to PlanGrid in regular Chrome, paste `chrome://inspect/#remote-debugging` into Chrome's address bar, and enable remote debugging before running. Accept Chrome's **Allow** prompt when shown, wait for the projects page and search box, then click **Resume ▶** in Playwright Inspector. Preserve the final Inspector pause and leave Chrome open and signed in after disconnecting.

### Extract downloaded ZIPs

```bash
npm run unzip
```

Run after exports complete. This local step does not launch a browser.

### Prepare local Documents/Photos staging

```bash
npm run sync:prepare
```

Run after successful extraction. Read from `DOWNLOAD_DIR` and copy Documents/Photos into already-existing project folders under `SYNC_UP_DIR`; this does not perform an external sync or upload.

### Miscellaneous commands

Prepare local Drawings and all other project contents except Documents/Photos after successful extraction:

```bash
npm run drawings:prepare
```

This separate local command reads from `DOWNLOAD_DIR` and copies into `DRAWINGS_DIR`, defaulting to `drawings`. It does not upload files.

Install dependencies and Chromium:

```bash
npm install
npm run install:browsers
```

Alternative automated-login modes:

```bash
npm run export
npm run headless
```

Part A supports automated login and existing Chrome sessions. Do not reintroduce the removed standalone manual-login mode. CAPTCHA and OTP verification remain manual when requested by Autodesk. Headless mode uses automated login and does not reuse an attached Chrome session; use it only when manual authentication is not needed.

All three npm export commands work on macOS/Linux and Windows Command Prompt or PowerShell. They use `src/run-export.ts` to set `HEADLESS` inside Node.js before loading the application. Keep the README's instructions for all three modes explicit and self-contained: include prerequisites, applicable macOS/Linux and Windows Command Prompt/PowerShell commands, required user actions, and the end-of-run browser behavior. Distinguish Chrome's Allow prompt from Inspector's Resume button, and retain the macOS Files & Folders permission steps. Do not replace these setup instructions with command names alone.

Run the current Part B local preparation or visible Kahua login flow:

```bash
npm run import:prepare
npm run kahua
```

Validate changes with the TypeScript check and smallest relevant test set:

```bash
npm exec tsc -- --noEmit
npm run test:export
npm run test:unzip
npm run test:sync
npm run test:drawings
npm run test:import
```

The tests cover project CSV validation, simulated fresh export requests and checkbox verification, projects-page reuse/readiness and failure recovery, download naming and transfer-status scheduling/cleanup, temporary ZIP extraction, both local copy workflows, and Part B local preparation. Transfer-status tests use a simulated clock rather than real waits. There is no automated test suite for the real Part A or Kahua browser flow. Do not launch a real login/export run unless requested or clearly part of the task. Do not run unzip or either copy command on real downloads merely to validate changes.

## Configuration and sensitive data

Automated PlanGrid login requires these repository `.env` credentials:

- `PLANGRID_EMAIL`
- `PLANGRID_PASSWORD`

Document `DOWNLOAD_DIR`, `SYNC_UP_DIR`, and `DRAWINGS_DIR` together in the README's environment setup, with repository-relative defaults and Windows/macOS absolute-path examples. `.env.example` is the sample; local `.env` values may be customized and must not be replaced with sample credentials or defaults during updates. Check for missing keys without printing secrets.

Shared optional configuration:

- `PLATFORM_URL` (defaults to `https://app.plangrid.com`; initial navigation for automated login only)
- `DOWNLOAD_DIR` (defaults to `downloads`)
- `SYNC_UP_DIR` (defaults to `sync_ups`; local Documents/Photos staging root, with relative paths resolved from the repository)
- `DRAWINGS_DIR` (defaults to `drawings`; separate local staging root for everything except project-level Documents/Photos, with relative paths resolved from the repository)
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

After successful authentication, the first enabled project may reuse the current projects landing page instead of navigating to it again. Reuse is permitted only for the matching PlanGrid origin and landing-page path (including its optional trailing slash/query); a project-detail page is not the landing page. Disabled rows do not consume first-project reuse. Always retain page-readiness, visible-search, settle, and matching-row waits, even when reusing the page. Subsequent enabled projects must navigate to the landing page once, including after a previous project fails or is skipped.

For hosted execution, Chrome and the script should run together in a persistent interactive desktop session. Authentication must be established on that machine, and session expiration requires user reauthentication. The current connection approval and Inspector pauses mean this mode is not an unattended scheduled workflow. Never read or copy browser cookies or credentials to establish the connection.

### Part A — Project readiness, continuation, and download status

Keep projects-page timings separate from authentication and Kahua timings. Projects-page navigation or reused-page readiness allows 45 seconds; search visibility, search entry, matching-row visibility, and opening the row each allow 30 seconds. Preserve the additional fixed 5-second settle before searching. These maximum waits finish as soon as their conditions are met; do not replace element-driven waits with fixed delays alone.

Per-project navigation/readiness and export errors must return a FAILED result without throwing out of the project loop. A matching row that does not become visible within the search wait is logged as SKIPPED. Log project name, CSV position/total, outcome, and continuation after a failed/skipped enabled project when another CSV entry remains. The next enabled project navigates afresh and repeats readiness checks. Process all remaining entries before returning a nonzero exit status for any FAILED project. Authentication/startup verification failures still stop the run before project processing. Do not automatically retry whole exports and risk requesting duplicate builds.

Log whether the As-built form/table is visible and whether the request is first-time or recurring. Use Option B: generate immediately without waiting for previous processing builds. On recurring requests, snapshot the build IDs from every table row before opening Generate a new As-built, including IDs in hidden download links on processing rows. First-time forms start with an empty previous-ID set. Both form paths must fill configured dates (leave platform defaults when blank) and check/verify all form checkboxes before clicking Zip File. Fail clearly if the form has no Include checkboxes or one cannot be checked.

After submission, compare all current build IDs with the snapshot. Zero new IDs means wait without an overall generation timeout; never download an old build or repeat submission. Exactly one new ID permits tracking it. Multiple unseen IDs during identification must immediately fail that project without attempting a download, even if one appears first. Missing, unreadable, mismatched, or duplicated identifiers must also fail safely. Validate build links against the captured PlanGrid project page, derive the build ID from the asbuilts path, and keep selectors in utils/constants.ts. Once identified, bind progress, status, and the download click to that ID rather than the top row. Later unrelated rows must not change the selected identity. Require both 100% and the tracked build's visible Download link. Keep identifiers in memory only; restarting processes the enabled CSV entries normally, without checkpoints, partial-download resumption, or automatic skipping.

Keep failure detection simple and deterministic. Only the tracked build's visible status exactly matching Failed, Error, Cancelled, or Canceled (case-insensitive, allowing one trailing period/exclamation mark) is an explicit terminal failure. Use innerText so hidden Processing text in completed rows is excluded. Unknown/blank status text alone is not terminal: warn and continue polling until the 100%/visible-Download pair is met, without inferring failure from unfamiliar text. Missing/duplicated tracked rows or unreadable controls fail through normal control-readiness checks; report the affected project and continue the CSV loop. Older failed/cancelled/processing builds do not block a new request. Do not add overall generation/transfer deadlines, progress-stall heuristics, automatic submission retries, or unverified failure-state guesses.

Once a fresh build reaches 100%, log clicking Download and the transfer start/save destination, then retain the completion log only after `saveAs` succeeds. During transfer/saving, report elapsed status at 10, 20, 40, 80... elapsed minutes from the click, with gaps capped at 24 hours. This timer is informational only: never alter build polling, navigation, retries, cancellation, or transfer timeout behavior to produce updates. Clear timers on success and failure, and do not keep Node alive solely for a status timer. Do not log download URLs or sensitive session data.

### Part B — Kahua

The separate Kahua login flow starts in `src/kahua/main.ts`. Its initial `page.goto` waits for navigation to commit, with a 60-second limit on receiving the server response. Do not change this to `domcontentloaded` or `networkidle`: Kahua's Uno application may take several minutes to initialize after the response has arrived.

After navigation commits, readiness must be determined from the Uno canvas and semantic accessibility controls in `src/kahua/uno.ts` and `src/kahua/auth.ts`. Keep those waits element-driven and do not add a fixed sleep as proof that the email, password, notice, or authenticated landing screen is ready. A failure to receive the initial response within 60 seconds is a navigation failure; slow rendering after that point remains under the user's control.

## Input and output conventions

`input/projects.csv` uses `project_uid,project_name,project_clean_name,enabled,start_date,end_date`. The first four columns are required; UID values and dates may be blank. `enabled` must be `true` or `false`; optional dates must use `YYYY-MM-DD`. `project_name` is used for PlanGrid search. `project_clean_name` is a required, validated folder/file base name used directly for `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>.zip`; do not derive names from `project_name` or use the platform-suggested ZIP filename. Reject unsafe names and duplicate clean names among enabled projects before browser startup.

`npm run unzip` reads that same CSV, skips disabled projects, and extracts each matching ZIP into a parent named `project_clean_name` next to the source ZIP: `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/`. If all entries share a single project wrapper containing Documents, Photos, or Drawings, omit only that wrapper. Preserve deeper hierarchy and files, and retain the source ZIP. Do not strip meaningful top-level Documents/Photos/Drawings folders or flatten archives with multiple top-level items. Re-runs automatically refresh the entire inner extraction parent, overwriting old extracted files and removing stale output or the legacy wrapper layout. The user has authorized refreshing this generated output; do not require manual folder moves or stop because previous extracted files exist. Extract and verify into temporary staging first, then copy its contents into the final clean-name directory without any directory renames. If previous extraction contents exist, copy them to a backup before clearing the final directory's contents, keeping that directory itself in place. Restore failed publication by copying the backup contents back; retain and report the backup on a restore failure. Use the same copy-based flow across platforms to avoid Windows stage-to-final rename errors. Report persistent lock/permission failures rather than claiming copying cannot fail. Preserve the ZIP, sibling files, and sync staging. Reject unsafe archive paths, archive links, linked extraction parents, and collisions within the ZIP. Report per-project failures, continue with other projects, and exit nonzero if any project fails. Local Documents/Photos staging is a separate command described below.

Use `project_clean_name` to locate the project folder/source ZIP and name the extraction parent. Apart from omitting the single project wrapper as described above, preserve internal archive names and structure exactly, including trailing spaces and periods; do not add filename cleanup or renaming. Validate original archive paths and file types before omitting a wrapper. Report retained names unsupported by the host filesystem as failures. Detect filename case sensitivity using the existing ZIP; preserve case-distinct entries on capable filesystems and report both conflicting paths on case-insensitive filesystems. Retain path-containment, link, collision, and overwrite protections.

Unzip refresh is a complete replacement of the extraction parent's contents: clear everything old, including files whose paths also occur in the new ZIP, before copying verified staging contents. Keep the parent directory and existing hierarchy/wrapper rules. Retain `.unzip-stage-*` validation and `.unzip-backup-*` recovery despite their extra disk I/O and space use; they prevent an invalid archive from clearing previous output and support restoration after publication failures. Do not optimize them away or weaken case-collision protection such as `9C.pdf` versus `9c.pdf` on a case-insensitive filesystem.

`npm run sync:prepare` uses the same CSV and extraction parent. For each enabled row, copy Documents and/or Photos (when present) with their full subtrees into the already-existing `<SYNC_UP_DIR>/<project_clean_name>/`. Require that destination to be a real directory, not a file or link; never create the staging root or project parent. Only create or update Documents/Photos and their contents inside that parent; leave other project folders, loose files, and other projects untouched. Check `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/` directly first, matching the refreshed unzip layout; if neither folder exists there, support a legacy project wrapper one level below, rejecting multiple matching wrappers. Skip projects with neither folder; missing extraction roots or destination project folders fail that project. Preserve sources, unrelated destination files (including those inside Documents/Photos), and folder hierarchy. Warn when an incoming Documents/Photos folder already exists at the destination, listing those folders and the overwrite count even when zero. When matching destination files exist, preview the project, destination, count, and example paths, then ask once per project `Overwrite these existing files? [y/N]:` in an interactive terminal before copying any files. Only y/yes approves; n/no, Enter, or closed input skips that project unchanged. Never assume approval, reuse it for later projects/runs, or bypass it in a noninteractive run. Fail noninteractive conflicts without copying. Recheck the destination project directory and destination files after approval and stage each approved file copy before replacing its destination. Reject links/special files, type conflicts, and overlapping source/destination trees; continue with other projects after failures. Keep copying compatible with Windows Command Prompt/PowerShell, macOS, and Linux using Node.js filesystem operations. This is local staging only; actual syncing/uploading is not implemented. Test with `npm run test:sync`; do not copy real downloads merely to validate changes.

`npm run drawings:prepare` uses the same CSV and extraction parent, copying all project-level entries except `Documents` and `Photos` into `<DRAWINGS_DIR>/<project_clean_name>/`. Preserve all included hierarchy, filenames, loose files, and empty folders; nested Documents/Photos inside included trees remain. Support a sole legacy wrapper containing Documents, Photos, or Drawings, reject multiple matching wrappers, and retain sibling files when there is more than one top-level item. Reuse sync preparation's overwrite preview, per-project interactive approval, destination rechecks, staged replacements, link/type/overlap protections, and continuation/exit-status behavior. Skip disabled or empty/excluded-only projects; missing extraction roots fail. This is local copying, separate from Part B, with no upload. Test only temporary fixtures with `npm run test:drawings`.

Both staging commands retain merge behavior. The shared overwrite preview must prominently say EXISTING FILES FOUND — REVIEW BEFORE MERGING and explain that new files are added, listed matching files are replaced, and destination-only files/folders remain even if absent from the latest export. Keep the exact `Overwrite these existing files? [y/N]:` question and all per-project consent safeguards; declining skips the entire project unchanged. Never turn staging into a deletion/mirroring workflow.

Part B reads `input/version_sets.csv` and currently prepares only the project pinned in `src/import/config.ts`. Preparation output belongs under `<DOWNLOAD_DIR>/import-preparation/`; Kahua upload output does not exist yet because upload automation is still in development.

Generated exports and Part B preparation files belong under the configured download directory; local Documents/Photos staging belongs under `SYNC_UP_DIR`, and the other copied project contents belong under `DRAWINGS_DIR`. Run logs are written under `logs/` with UTC timestamps. Avoid committing generated downloads, either staging folder's contents, logs, browser profiles, or local `.env` files.

## Change expectations

- Preserve unrelated user changes and inspect `git status` before editing.
- Use `apply_patch` for source and documentation edits.
- Prefer small, targeted changes that preserve the current login/export flow.
- Update `README.md` when user-facing behavior, setup, or manual steps change.
- Validate TypeScript and whitespace after edits.
- Do not make destructive changes to input data, downloads, logs, credentials, or browser state without explicit user direction.

## API tooling

Postman CLI is installed and may be used for API engineering work when a task specifically requires it. This project’s current workflow is browser-based Playwright automation; do not introduce API calls merely to replace the existing browser login flow.
