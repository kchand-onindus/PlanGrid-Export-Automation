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
5. Validate `input/projects.csv`, select enabled projects using global skip/limit settings or explicit failed-report retry selection, and save a timestamped run report before browser startup.
6. Generate a fresh As-built for every selected project, fill configured dates, uncheck Current Set, Drawing Log, and Current Set Log when present, check every other Include option, verify all final checkbox states, wait for completion, and download ZIP files. Persist each outcome before the next project. When previous builds exist, click Generate a new As-built first; never reuse an old download.
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
- `src/export-selection.ts`: export CLI/environment validation, enabled-only skip/limit selection, and explicit failure retry matching against the current CSV.
- `src/export-run.ts`: timestamped execution reports, per-project persistence, retry-source validation, parent/root run links, and retry command formatting.
- `src/export-batch.test.ts`: temporary-fixture batch selection, report persistence, and retry-chain tests.
- `src/auth.ts`: PlanGrid/Autodesk login, manual verification pause, authenticated-projects validation, and logout.
- `src/chrome-session.ts`: CDP attachment to existing Chrome using debugging connection metadata or an explicit endpoint; does not launch Chrome or read credentials/cookies.
- `src/project-exporter.ts`: project search, project navigation, As-built export handling, progress polling, and ZIP download.
- `src/csv.ts`: project CSV parsing and validation.
- `src/unzip.ts` and `src/unzip-main.ts`: separate CSV-driven, local ZIP extraction into each project's download folder.
- `src/sync/`: CSV-driven local Documents/Photos copying into configurable sync staging, plus temporary-folder tests.
- `src/drawings/`: full refresh of local staging for everything except project-level Documents/Photos, with staged copying, backup/restore, and temporary-folder tests; source selection shares `src/sync/prepare.ts`.
- `src/logger.ts`: timestamped console/file logging and duplicate-error tracking.
- `src/config.ts`: repository-relative paths and environment-derived configuration.
- `src/types.ts`: project and export result types.
- `src/local-results.ts`: shared local-command result types, skip reasons, and summaries for unzip and both preparation commands.
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
- `runs/`: generated export execution reports; ignored by Git and independent of `DOWNLOAD_DIR`.

## Commands and validation

The main workflow is Chrome export → unzip → local sync preparation. Complete the shared setup and input/environment configuration first. Keep these three commands in this order in the README and npm script listing. Put the other workflows and validation commands under Miscellaneous in the README; do not add a duplicate Chrome command banner at the top. Show each workflow's command immediately after its heading.

### Chrome export — main workflow

```bash
npm run export:chrome
```

Sign in to PlanGrid in regular Chrome, paste `chrome://inspect/#remote-debugging` into Chrome's address bar, and enable remote debugging before running. Accept Chrome's **Allow** prompt when shown, wait for the projects page and search box, then click **Resume ▶** in Playwright Inspector. Preserve the final Inspector pause and leave Chrome open and signed in after disconnecting.

Export batching uses optional `.env` settings `BATCH_SKIP=0` and `BATCH_LIMIT=` (blank/unset means all remaining enabled projects). Command-line values override their respective defaults. For example, run enabled projects 1–50, then 51–100, separately:

```bash
npm run export:chrome -- --skip 0 --limit 50
npm run export:chrome -- --skip 50 --limit 50
```

`--offset` is an alias for `--skip`. Filter to enabled projects before slicing; disabled rows consume no slots. A limit counts attempted projects including failures, not successes. Skip must be a non-negative safe integer; a specified limit must be a positive safe integer. Reject invalid, duplicate, conflicting, or unknown arguments before browser startup. Keep CSV order and enabled flags stable when advancing offsets. Never rewrite the CSV, flip flags, automatically advance offsets, or skip projects based on earlier successes.

Explicit failure retries use a chosen report:

```bash
npm run export:chrome -- --retry-failed "runs/<run-id>/results.json"
```

Retry mode ignores both batch environment settings, including invalid values, and rejects explicit skip/offset/limit arguments. Validate the report format/version and unique identities; select only explicit FAILED records in report order. Match their unchanged `project_clean_name` against current enabled CSV projects and use current CSV details, preserving `project_name` exactly. Missing, renamed, or disabled clean names fail selection before browser startup rather than silently choosing another row or enabling it. Blank/nonunique UIDs and CSV row numbers are not retry identities. Each retry requests a fresh export, never a resumed build or transfer. Keep retries explicit and leave the source report unchanged. Use the newly generated report for a subsequent retry; older reports retain their original failed set.

The same arguments work with `npm run export -- ...` and `npm run headless -- ...` under their existing login and cleanup rules. `npm run export:chrome -- --help` (also supported by the other export modes) lists arguments without opening a browser. All examples must remain compatible with macOS/Linux and Windows Command Prompt/PowerShell. Batch and retry controls apply only to exports; unzip, sync, drawings, and Part B retain their existing selection and consent rules.

Every valid selection creates `runs/<run-id>/results.json` and `failed-projects.csv`, including empty selections and explicit retries. IDs contain a Windows-compatible UTC timestamp, run type, batch settings when applicable, and a uniqueness suffix. Reports record parentRunId for the chosen source run and rootRunId for the original batch, project snapshots, timestamps, selection settings, and counts. Startup logs also show IST. Save the initial pending selection before browser startup, IN_PROGRESS before each project, and final results before starting another project. Report writing failures stop execution before another export; publish JSON atomically and treat it as authoritative if CSV publication fails. The CSV lists only FAILED records and preserves exact project names through proper quoting. Do not store credentials, session data, or download URLs in reports, or use reports to persist resumable build/transfer state.

COMPLETED means project processing finished, even when individual projects failed; later browser/logout cleanup issues remain in the run log. Caught run-level failures mark the run ABORTED, keep completed outcomes, mark active projects INTERRUPTED, and leave untouched projects PENDING. A hard process termination may leave RUNNING/IN_PROGRESS on disk. Unfinished states are for manual review and must never be automatically included in `--retry-failed`. Empty selections create a completed empty report and exit successfully without a browser. Log report paths, parent/root IDs, selected counts/range, and the exact mode-appropriate retry command when failures exist. Run summaries count only selected projects; disabled and out-of-range entries are excluded, not fabricated outcomes.

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
npm run drawing:prepare
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

The tests cover batch option validation/precedence, enabled-only offsets, report persistence and failure handling, explicit retry chains, unfinished states, source-report preservation, project CSV validation and exact name preservation, exact-name selection among similar search results, missing/duplicate exact-match failures, simulated fresh export requests and checkbox verification, projects-page reuse/readiness and failure recovery, download naming and transfer-status scheduling/cleanup, temporary ZIP extraction, both local copy workflows, and Part B local preparation. Transfer-status tests use a simulated clock rather than real waits. There is no automated test suite for the real Part A or Kahua browser flow. Do not launch a real login/export run unless requested or clearly part of the task. Do not run unzip or either copy command on real downloads merely to validate changes.

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
- `BATCH_SKIP` (export commands only; defaults to `0`, counting enabled projects before the selected range; CLI `--skip` or `--offset` overrides it)
- `BATCH_LIMIT` (export commands only; unset/blank means all remaining enabled projects; CLI `--limit` overrides it; explicit retry mode ignores both batch settings)
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

After successful authentication, the first selected enabled project may reuse the current projects landing page instead of navigating to it again. Reuse is permitted only for the matching PlanGrid origin and landing-page path (including its optional trailing slash/query); a project-detail page is not the landing page. Disabled and out-of-range rows do not consume first-project reuse. Always retain page-readiness, visible-search, settle, and matching-row waits, even when reusing the page. Subsequent selected projects must navigate to the landing page once, including after a previous project fails or is skipped.

For hosted execution, Chrome and the script should run together in a persistent interactive desktop session. Authentication must be established on that machine, and session expiration requires user reauthentication. The current connection approval and Inspector pauses mean this mode is not an unattended scheduled workflow. Never read or copy browser cookies or credentials to establish the connection.

### Part A — Project readiness, continuation, and download status

Keep projects-page timings separate from authentication and Kahua timings. Projects-page navigation or reused-page readiness allows 45 seconds; search visibility, search entry, matching-row visibility, and opening the row each allow 30 seconds. Preserve the additional fixed 5-second settle before searching. These maximum waits finish as soon as their conditions are met; do not replace element-driven waits with fixed delays alone.

Use the CSV's unchanged `project_name` for both search entry and exact selection against the project link's `title` attribute. Preserve capitalization and every whitespace character, including leading/trailing spaces; never trim or normalize this field. Multiple search results alone are not ambiguous: open the one row whose full name matches exactly. If no exact match becomes visible within 30 seconds, or multiple rows have the exact same name, return FAILED without clicking a row. Keep the final click strict so a newly appearing duplicate cannot select an arbitrary row. Do not fall back to partial names, `project_clean_name`, or `project_uid` for selection.

Per-project navigation/readiness, project-selection, and export errors must return a FAILED result without throwing out of the project loop. Export selection excludes disabled and out-of-range CSV rows from run counts; direct calls to exportProject still return SKIPPED for disabled projects. Log project name, run position/total, CSV position/total, enabled-list position, and outcome. Log continuation after a failed/skipped selected project when another selected entry remains. The next selected project navigates afresh and repeats readiness checks. Process all remaining selected entries before returning a nonzero exit status for any FAILED project. Authentication/startup verification failures still stop the run before project processing. Do not automatically retry whole exports and risk requesting duplicate builds.

Log whether the As-built form/table is visible and whether the request is first-time or recurring. Use Option B: generate immediately without waiting for previous processing builds. On recurring requests, snapshot the build IDs from every table row before opening Generate a new As-built, including IDs in hidden download links on processing rows. First-time forms start with an empty previous-ID set. Both form paths must fill configured dates (leave platform defaults when blank), uncheck Current Set (`inc_conformed`), Drawing Log (`inc_drawing_log`), and Current Set Log (`inc_curr_set_log`) when present, and check every other Include checkbox. Verify all final states before clicking Zip File and log one confirmation with the checked and unchecked options. Fail clearly if the form has no Include checkboxes or any required state cannot be set or verified.

After submission, compare all current build IDs with the snapshot. Zero new IDs means wait without an overall generation timeout; never download an old build or repeat submission. Exactly one new ID permits tracking it. Multiple unseen IDs during identification must immediately fail that project without attempting a download, even if one appears first. Missing, unreadable, mismatched, or duplicated identifiers must also fail safely. Validate build links against the captured PlanGrid project page, derive the build ID from the asbuilts path, and keep selectors in utils/constants.ts. Once identified, bind progress, status, and the download click to that ID rather than the top row. Later unrelated rows must not change the selected identity. Require both 100% and the tracked build's visible Download link. Keep build identifiers in memory only; reports select projects for explicit fresh retries, without build checkpoints, partial-download resumption, or automatic skipping.

Keep failure detection simple and deterministic. Only the tracked build's visible status exactly matching Failed, Error, Cancelled, or Canceled (case-insensitive, allowing one trailing period/exclamation mark) is an explicit terminal failure. Use innerText so hidden Processing text in completed rows is excluded. Unknown/blank status text alone is not terminal: warn and continue polling until the 100%/visible-Download pair is met, without inferring failure from unfamiliar text. Missing/duplicated tracked rows or unreadable controls fail through normal control-readiness checks; report the affected project and continue the CSV loop. Older failed/cancelled/processing builds do not block a new request. Do not add overall generation/transfer deadlines, progress-stall heuristics, automatic submission retries, or unverified failure-state guesses.

Build-polling start, progress/status, and download-readiness logs must include both `projectUid` and the actual `projectName` from CSV `project_name`. Keep the raw name in logging context; `src/logger.ts` encloses `projectName` in double quotes and escapes embedded quotes/control characters for console and file output. This display formatting must not change the name used for search or matching.

Once a fresh build reaches 100%, log clicking Download and the transfer start/save destination, then retain the completion log only after `saveAs` succeeds. During transfer/saving, report elapsed status at 10, 20, 40, 80... elapsed minutes from the click, with gaps capped at 24 hours. This timer is informational only: never alter build polling, navigation, retries, cancellation, or transfer timeout behavior to produce updates. Clear timers on success and failure, and do not keep Node alive solely for a status timer. Do not log download URLs or sensitive session data.

### Part B — Kahua

The separate Kahua login flow starts in `src/kahua/main.ts`. Its initial `page.goto` waits for navigation to commit, with a 60-second limit on receiving the server response. Do not change this to `domcontentloaded` or `networkidle`: Kahua's Uno application may take several minutes to initialize after the response has arrived.

After navigation commits, readiness must be determined from the Uno canvas and semantic accessibility controls in `src/kahua/uno.ts` and `src/kahua/auth.ts`. Keep those waits element-driven and do not add a fixed sleep as proof that the email, password, notice, or authenticated landing screen is ready. A failure to receive the initial response within 60 seconds is a navigation failure; slow rendering after that point remains under the user's control.

## Input and output conventions

`input/projects.csv` recognizes `project_uid,project_name,project_clean_name,enabled,start_date,end_date`. The first four columns are required; UID values and dates may be blank. Column order may vary, and extra columns such as `action` are accepted and ignored. Header names must be unique, and every row must contain the same number of fields as the header, including blank fields. Quote fields containing commas; CSV quotes are syntax and are not part of the decoded name. `enabled` must be `true` or `false`; optional dates must use `YYYY-MM-DD`.

Treat `project_name` as the source of truth: preserve its decoded CSV value exactly for PlanGrid search, exact selection, and logging. Reject empty or whitespace-only names, but never trim or normalize valid names. Continue trimming the other configuration fields. `project_clean_name` is the separately supplied, required, validated folder/file base name used directly for `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>.zip` and by unzip, sync, and drawings staging; do not derive it from `project_name`, automatically sanitize it, or use the platform-suggested ZIP filename. Reject unsafe names and duplicate clean names among enabled projects before browser startup. Workflows read the project CSV without rewriting it or automatically changing `enabled` after success or failure.

`npm run unzip` reads that same CSV, skips disabled projects, and extracts each matching ZIP into a parent named `project_clean_name` next to the source ZIP: `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/`. If all entries share a single project wrapper containing Documents, Photos, or Drawings, omit only that wrapper. Preserve deeper hierarchy and files, and retain the source ZIP. Do not strip meaningful top-level Documents/Photos/Drawings folders or flatten archives with multiple top-level items. Re-runs automatically refresh the entire inner extraction parent, overwriting old extracted files and removing stale output or the legacy wrapper layout. The user has authorized refreshing this generated output; do not require manual folder moves or stop because previous extracted files exist. Extract and verify into temporary staging first, then copy its contents into the final clean-name directory without any directory renames. If previous extraction contents exist, copy them to a backup before clearing the final directory's contents, keeping that directory itself in place. Restore failed publication by copying the backup contents back; retain and report the backup on a restore failure. Use the same copy-based flow across platforms to avoid Windows stage-to-final rename errors. Report persistent lock/permission failures rather than claiming copying cannot fail. Preserve the ZIP, sibling files, and sync staging. Reject unsafe archive paths, archive links, linked extraction parents, and collisions within the ZIP. Report per-project failures, continue with other projects, and exit nonzero if any project fails. Local Documents/Photos staging is a separate command described below.

Use `project_clean_name` to locate the project folder/source ZIP and name the extraction parent. Apart from omitting the single project wrapper as described above, preserve internal archive names and structure exactly, including trailing spaces and periods; do not add filename cleanup or renaming. Validate original archive paths and file types before omitting a wrapper. Report retained names unsupported by the host filesystem as failures. Detect filename case sensitivity using the existing ZIP; preserve case-distinct entries on capable filesystems and report both conflicting paths on case-insensitive filesystems. Retain path-containment, link, collision, and overwrite protections.

Unzip refresh is a complete replacement of the extraction parent's contents: clear everything old, including files whose paths also occur in the new ZIP, before copying verified staging contents. Keep the parent directory and existing hierarchy/wrapper rules. Retain `.unzip-stage-*` validation and `.unzip-backup-*` recovery despite their extra disk I/O and space use; they prevent an invalid archive from clearing previous output and support restoration after publication failures. Do not optimize them away or weaken case-collision protection such as `9C.pdf` versus `9c.pdf` on a case-insensitive filesystem.

The three local commands summarize only their own work using `total`, `success`, `skipped`, `failed`, `skippedByReason`, and `failedProjects`. For unzip, missing download folders or ZIPs are SKIPPED with `MISSING_DOWNLOAD`; for either preparation command, missing source project/extraction folders are SKIPPED with `MISSING_EXTRACTION`. Disabled rows, absent applicable contents, and declined overwrites are also skips with distinct reasons. Skips alone do not cause a nonzero exit status, including runs where all projects are skipped. Invalid existing inputs, unsafe paths or links, permissions, failed destination setup, and errors during extraction/copying remain failures. Never broadly classify an ENOENT during ongoing extraction or copying as a skip.

For sync preparation, absent Documents/Photos folders use the skip reason `NO_MATCHING_FOLDER`. Drawings preparation retains `NO_MATCHING_CONTENT` because its eligible source entries include files as well as folders. Neither skip belongs in `failedProjects`; that list includes only FAILED results.

`npm run sync:prepare` uses the same CSV and extraction parent. For each enabled row, copy Documents and/or Photos (when present) with their full subtrees into the already-existing `<SYNC_UP_DIR>/<project_clean_name>/`. Require that destination to be a real directory, not a file or link; never create the staging root or project parent. Only create or update Documents/Photos and their contents inside that parent; leave other project folders, loose files, and other projects untouched. Check `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/` directly first, matching the refreshed unzip layout; if neither folder exists there, support a legacy project wrapper one level below, rejecting multiple matching wrappers. Skip projects with missing extraction roots or neither applicable folder. When source contents are available, missing destination project folders fail that project as a setup error. Preserve sources, unrelated destination files (including those inside Documents/Photos), and folder hierarchy. Warn when an incoming Documents/Photos folder already exists at the destination, listing those folders and the overwrite count even when zero. When matching destination files exist, preview the project, destination, count, and example paths, then ask once per project `Overwrite these existing files? [y/N]:` in an interactive terminal before copying any files. Only y/yes approves; n/no, Enter, or closed input skips that project unchanged. Never assume approval, reuse it for later projects/runs, or bypass it in a noninteractive run. Fail noninteractive conflicts without copying. Recheck the destination project directory and destination files after approval and stage each approved file copy before replacing its destination. Reject links/special files, type conflicts, and overlapping source/destination trees; continue with other projects after failures. Keep copying compatible with Windows Command Prompt/PowerShell, macOS, and Linux using Node.js filesystem operations. This is local staging only; actual syncing/uploading is not implemented. Test with `npm run test:sync`; do not copy real downloads merely to validate changes.

`npm run drawing:prepare` uses the same CSV and extraction parent, fully refreshing `<DRAWINGS_DIR>/<project_clean_name>/` with all project-level entries except source `Documents` and `Photos`. The user has authorized creating missing project folders and removing every old destination entry, including destination-only files/folders and stale Documents/Photos, without a per-project overwrite prompt. Preserve all included hierarchy, filenames, loose files, and empty folders; nested Documents/Photos inside included source trees remain. Support a sole legacy wrapper containing Documents, Photos, or Drawings, reject multiple matching wrappers, and retain source sibling files when there is more than one top-level item. Validate and copy new contents to `.drawings-stage-*` before changing previous output. Copy existing output to `.drawings-backup-*`, recheck destination state, clear its contents while keeping the project directory in place, then copy staged contents into it without directory renames. Restore failed publication from the backup; retain and report the backup if restoration fails. Reject links/special files and overlapping source/destination trees. An old regular-file/directory layout may be replaced with the current source layout. Any failed required step, including temporary cleanup, marks that project FAILED; continue other projects and exit nonzero for failures. Preserve sources, other destination projects, and destination-root files such as `.gitkeep`. Skip disabled projects, missing extraction roots, and empty/excluded-only projects without changing their previous output. This is local copying, separate from Part B, with no upload. Test only temporary fixtures with `npm run test:drawings`.

Sync preparation retains merge behavior. Its overwrite preview must prominently say EXISTING FILES FOUND — REVIEW BEFORE MERGING and explain that new files are added, listed matching files are replaced, and destination-only files/folders remain even if absent from the latest export. Keep the exact `Overwrite these existing files? [y/N]:` question and all sync per-project consent safeguards; declining skips the entire project unchanged. Never turn sync preparation into a deletion/mirroring workflow. Drawings preparation uses the separately authorized full-refresh behavior above.

Part B reads `input/version_sets.csv` and currently prepares only the project pinned in `src/import/config.ts`. Preparation output belongs under `<DOWNLOAD_DIR>/import-preparation/`; Kahua upload output does not exist yet because upload automation is still in development.

Generated exports and Part B preparation files belong under the configured download directory; local Documents/Photos staging belongs under `SYNC_UP_DIR`, and the other copied project contents belong under `DRAWINGS_DIR`. Run logs are written under `logs/` with UTC timestamps. Export execution reports belong under repository-root `runs/`, independently of `DOWNLOAD_DIR`. Avoid committing generated reports, downloads, either staging folder's contents, logs, browser profiles, or local `.env` files.

## Change expectations

- Preserve unrelated user changes and inspect `git status` before editing.
- Use `apply_patch` for source and documentation edits.
- Prefer small, targeted changes that preserve the current login/export flow.
- Update `README.md` when user-facing behavior, setup, or manual steps change.
- Validate TypeScript and whitespace after edits.
- Do not make destructive changes to input data, downloads, logs, credentials, or browser state without explicit user direction.

## API tooling

Postman CLI is installed and may be used for API engineering work when a task specifically requires it. This project’s current workflow is browser-based Playwright automation; do not introduce API calls merely to replace the existing browser login flow.
