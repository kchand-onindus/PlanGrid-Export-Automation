# PlanGrid Export and Kahua Import Automation

This repository contains a two-part automation workflow. Part A downloads project exports from PlanGrid. Part B prepares those exports and will upload them to Kahua, but that workflow is still under development.

## Workflow overview

| Part | Status | Current capabilities | Commands |
| --- | --- | --- | --- |
| Part A — PlanGrid export | Available | Uses automated login or an existing Chrome session; processes enabled projects; creates or finds As-built exports; and downloads ZIP files. Chrome mode retains authentication; automated mode logs out. | `npm run export`, `npm run export:chrome`, `npm run headless` |
| Part B — Kahua import | **In development** | Prepares one configured project's drawing files, validates the preparation plan, and automates Kahua login through landing-page verification. Project selection and file upload are not implemented yet. | `npm run import:prepare`, `npm run test:import`, `npm run kahua` |

## Shared setup

Use Node.js 22.2 or newer (the import preparation verifies ZIP checksums using Node's built-in CRC32 support).

From the repository folder, run:

```bash
npm install
npm run install:browsers
```

## Repository note: reference scripts

The `reference-scripts/` directory is personal reference material and is unrelated to the repository code. Agents and workflows must ignore it completely during repository analysis, implementation, testing, and workflow design. Its files must not be read, executed, modified, moved, deleted, or included in repository work.

## Part A — PlanGrid export (available)

Part A is the working export workflow. It logs into PlanGrid, finds each enabled project, creates or locates its As-built export, waits for completion, and downloads the ZIP file.

### Configure the environment

Fill in `.env` before running the script:

```env
PLANGRID_EMAIL=your_email
PLANGRID_PASSWORD=your_password
PLATFORM_URL=https://app.plangrid.com
DOWNLOAD_DIR=downloads
```

`DOWNLOAD_DIR` may be a relative path, which is resolved inside this repository, or an absolute path. The password is never written to the logs.

`PLANGRID_EMAIL` and `PLANGRID_PASSWORD` are required for automated login. Chrome session mode uses the browser's existing authentication and does not read or require those credentials. `PLATFORM_URL` controls the initial navigation in automated mode; Chrome mode opens the PlanGrid projects URL directly.

### Prepare the project input

Update `input/projects.csv` with one project per row:

```csv
project_number,project_name,enabled,start_date,end_date
,Example Project,true,,
12345,Another Project,true,2026-01-01,2026-08-31
12346,Disabled Project,false,,
```

`project_name` and `enabled` are required. `enabled` must be `true` or `false`. Project number, start date, and end date may be blank. Any dates provided must use `YYYY-MM-DD` format.

### Run commands

Complete the shared setup, configure `.env`, and prepare `input/projects.csv` first. Open a terminal in this repository's folder, then choose one mode below. Use the command for your operating system.

| Mode | Authentication | Browser at the end |
| --- | --- | --- |
| [Normal automated login](#normal-automated-login) | Script enters email/password; you complete CAPTCHA/OTP when requested. | Attempts logout, pauses for your final check, then closes. |
| [Existing Chrome session](#existing-chrome-session) | You sign in through regular Chrome before running the script. | Pauses for your final check, then disconnects; Chrome stays open and signed in. |
| [Headless automated login](#headless-automated-login) | Uses the automated login flow without a visible browser. | Attempts logout and closes; no Inspector pauses. |

#### Normal automated login

**Before running:** Set `PLANGRID_EMAIL` and `PLANGRID_PASSWORD` in `.env`. Install Playwright's Chromium with `npm run install:browsers` during shared setup. You do not need to open Chrome or enable remote debugging for this mode.

macOS/Linux:

```bash
npm run export
```

Windows PowerShell:

```powershell
$env:HEADLESS = "false"
npx tsx src/main.ts
```

1. The script opens a visible browser, navigates to `PLATFORM_URL`, and enters the email/password automatically.
2. If Playwright Inspector pauses for Autodesk verification, complete the CAPTCHA/OTP in the browser and submit it. Wait for the PlanGrid projects page and project search box, then click Inspector's **Resume ▶** button.
3. The script verifies authentication and exports the enabled projects.
4. After exports, it attempts logout and pauses again. Check the browser, log out manually if necessary, then click **Resume ▶** to close it.

#### Existing Chrome session

**Before running:** Install regular Google Chrome 144 or newer separately. `npm run install:browsers` installs Playwright's Chromium, not the regular Chrome used by this mode. PlanGrid credentials in `.env` are not required for this mode.

Set up Chrome on the machine that will run the script:

1. Open **regular Chrome**, using the same OS user account that will run the script. Use a normal browser profile, rather than an Incognito window.
2. Open `https://app.plangrid.com` and sign in manually. Complete any Autodesk CAPTCHA/OTP and reach the PlanGrid projects page.
3. Open another Chrome tab. Paste **`chrome://inspect/#remote-debugging` into Chrome's address bar**, then press Enter.
4. **Enable remote debugging on that page.** Keep Chrome running with this setting enabled.
5. On macOS, if access to Chrome's connection metadata is denied, open **System Settings → Privacy & Security → Files & Folders**. Enable **Google Chrome** access for the terminal or host app running the script, then retry.

Start the script from a terminal in the repository folder, choosing one command:

macOS/Linux:

```bash
npm run export:chrome
```

Windows PowerShell:

```powershell
$env:HEADLESS = "false"
npx tsx src/main.ts --connect-chrome
```

Then complete these steps for each run:

1. Click **Allow** if Chrome asks to share its debugging session.
2. The script opens a new export tab and navigates to `https://app.plangrid.com/projects`. Wait for the projects page and visible project search box.
3. Click **Resume ▶** in **Playwright Inspector**, the separate window opened by the script. The script verifies the projects URL and search box before starting exports. If authentication is incomplete, no exports start.
4. After exports, review the browser at the final pause and click **Resume ▶** again to disconnect. Chrome and its tabs remain open and signed in. The script also skips logout during failure cleanup.

For later runs, keep Chrome running, keep remote debugging enabled, and reuse the same profile. You do not need to keep a PlanGrid tab open: the script opens the projects page itself. If the session expires, sign in through Chrome again before running. See [Chrome's connection instructions](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session).

#### Headless automated login

**Before running:** Configure the same credentials and Playwright Chromium as normal automated login. This retained mode uses a fresh browser and does not reuse your signed-in Chrome session. It cannot handle manual CAPTCHA/OTP, and the current Autodesk handoff requires a visible browser. Use a visible mode when authentication requires interaction.

macOS/Linux:

```bash
npm run headless
```

Windows PowerShell:

```powershell
$env:HEADLESS = "true"
npx tsx src/main.ts
```

The script attempts automated login and exports without showing a browser or Inspector. If manual verification is required, it stops with an error. After processing, it attempts logout and closes the browser without a final manual pause.

The npm wrappers use macOS/Linux environment-variable syntax, so use the explicit PowerShell commands above on native Windows.

### Chrome connection notes

For the standard [Chrome setup above](#existing-chrome-session):

- Leave `PLANGRID_CHROME_USER_DATA_DIR` and `PLANGRID_CDP_URL` unset in `.env`; the script finds the connection automatically.
- Run only one export script against the Chrome session at a time.
- Chrome stays open and signed in after the run, including when an export fails.

#### Troubleshooting macOS permissions

If the script cannot read Chrome's connection information, open **System Settings → Privacy & Security → Files & Folders**. Enable **Google Chrome** access for the terminal or host app running the script, then retry.

#### Advanced connection settings

Use these optional `.env` settings only for a custom Chrome data directory or an existing debugging endpoint:

```env
PLANGRID_CHROME_USER_DATA_DIR=/absolute/path/to/chrome/user-data-directory
# Alternatively, supply an existing local CDP endpoint for a browser with a debugging port:
PLANGRID_CDP_URL=http://127.0.0.1:9222
```

The directory setting only tells the script where to find the connection information. The script does not launch Chrome or copy or modify its profile. Keep debugging WebSocket endpoints private.

Older Chrome versions require an already-enabled debugging endpoint in a separate user data directory. The script does not restart Chrome or enable debugging automatically.

#### Running on a hosted or remote machine

Use this setup only if the script runs on another computer or server:

1. Use a persistent desktop session accessible through Remote Desktop or VNC.
2. Run Chrome and the script on that machine under the same OS user, and sign in to PlanGrid there. Deploying the repository does not transfer your laptop's signed-in session.
3. Keep the Chrome profile, downloads, and logs on persistent storage.
4. Complete Chrome's **Allow** prompt when shown and both **Resume ▶** steps in Playwright Inspector, as described above.

This mode still requires manual interaction and cannot currently run as an unattended scheduled job.

#### How the connection works (technical background)

The script reads Chrome's `DevToolsActivePort` connection metadata and connects through the Chrome DevTools Protocol (CDP). It opens the export tab in Chrome's existing default browser context, which shares your signed-in session.

### Export flow

When `npm run export` starts, it opens the configured `PLATFORM_URL` in a visible browser. The flow is:

1. PlanGrid opens and the email address is submitted.
2. The browser moves to Autodesk, where the email address is filled and submitted again.
3. If Autodesk skips the password step, the script waits for the PlanGrid projects landing page.
4. If Autodesk shows a password field, the script fills the password and clicks **Sign in**.
5. **[Manual action — see “Autodesk OTP and CAPTCHA” below](#autodesk-otp-and-captcha):** If CAPTCHA, OTP, or verification appears, the script pauses. Complete it in the browser, submit it, wait for the PlanGrid projects page and project search box, and click **Resume** in the Playwright window.
6. The script searches `input/projects.csv` by project name and processes each enabled project.
7. For each project, it opens Settings → Download and Export As-Builts, uses the provided dates when present, waits for `100%`, and downloads the ZIP.
8. After the project loop, it returns to the projects page, attempts to log out, and verifies the login page.
9. The script pauses one final time for manual verification. Use the same **Resume** play button after checking the session and logging out if necessary; the browser then closes.

If an error occurs during processing or automatic logout, the final verification pause still appears so the session can be reviewed and closed manually.

### Autodesk OTP and CAPTCHA

After the email and password steps, Autodesk may request a CAPTCHA, OTP, or additional verification.

When this happens, the automation does not try to solve or bypass the challenge:

1. Complete the CAPTCHA or verification in the browser.
2. If Autodesk requests an OTP, enter it.
3. Click Autodesk’s Submit, Next, or equivalent button.
4. Wait until the browser reaches the PlanGrid projects landing page and the project search box is visible.
5. Click the **Resume** button in the Playwright window that opened with the browser.

The script verifies the projects page and search box after Resume. If Autodesk is still showing CAPTCHA or verification, it stops with a clear authentication error instead of starting the export and failing later during project search.

The automation will then continue with the project exports. If Autodesk signs in directly without OTP, it continues automatically.

### Part A output

- Input data: `input/projects.csv`
- Downloaded ZIP files: the configured `DOWNLOAD_DIR`, inside a folder named after each project
- Run logs: `logs/export-<timestamp>.log`

Project names are cleaned when folder names are created. Special characters are replaced with underscores so names containing slashes, asterisks, punctuation, or other filesystem-sensitive characters can be used safely.

## Part B — Kahua import (in development)

> **Status:** Part B is actively being developed. It currently prepares local drawing files for one configured project and completes Kahua login. It does not yet select the destination project, navigate to the upload tool, upload files, or process multiple projects end to end.

Current Part B commands:

```bash
npm run import:prepare
npm run test:import
npm run kahua
```

### Prepare a single-project import

This stage prepares local drawing files for a later upload workflow. Run it with:

```bash
npm run import:prepare
```

It does not open a browser or require PlanGrid credentials. `DOWNLOAD_DIR` from `.env` still determines the download root. The export commands above continue to work independently.

The initial project is pinned in `src/import/config.ts` to Bradley Co / SR74 Drainage Improvements (ARPA), UID `b87288f1-1b8a-42e4-a0de-0d1467fdbf8c`, and its known ZIP `7b2bed72-478d-4bca-87ad-d8d6ebdb921f.zip`. The source remains in the existing project-named folder; this step does not rename or reorganize previous downloads. If its location changes, update `zipFile` in that configuration.

Input is `input/version_sets.csv`. Required columns are:

```csv
project_uid,project_name,project_kahua_entity_id,version_set_uid,version_name,published_at,upload_sequence
```

`curvo_entity_id` is also accepted in place of `project_kahua_entity_id`; the supplied header and value are preserved in the plan. If both columns are present, their values must agree. Quoted fields, commas inside names, and UTF-8 BOMs are supported. Required values are checked for the selected project. `published_at` must be a real `YYYY-MM-DD` date, and `upload_sequence` must be a unique positive integer. Duplicate version UIDs and inconsistent project metadata stop preparation.

The preparation flow:

1. Selects only rows for the pinned project UID and sorts by numeric `upload_sequence`.
2. Logs date reversals and sequence gaps as warnings, retaining `upload_sequence` order.
3. Reads the ZIP directly and locates `Drawings`, optionally inside one project wrapper folder.
4. Excludes `Current` regardless of letter case, along with macOS metadata files. Documents and export logs are ignored.
5. Maps each version by UID or version name. Filesystem-sensitive characters in names are normalized to hyphens, so `Bid Set - 7/22/2025` matches `Bid Set - 7-22-2025`. Missing, ambiguous, empty, reused, or unlisted version folders stop preparation.
6. Extracts only mapped drawing versions into a fresh run directory and verifies readable files, sizes, and CRC32 checksums.
7. Writes `import-plan.json` only after all versions pass verification. It contains the original version names and publication dates, entity IDs, ordered versions, archive paths, local file paths, and warnings for later portal automation.

Each run creates:

```text
<DOWNLOAD_DIR>/import-preparation/import-<UTC timestamp>-<unique suffix>/
  import-plan.json
  drawings/
    1/  # Files for upload_sequence 1, preserving nested subfolders
    2/
    3/
```

Run logs are written to `logs/import-preparation-<timestamp>.log`. Failed runs exit with a nonzero status and may leave a partial preparation directory for inspection, without an `import-plan.json`. Each run creates a new copy of the selected drawings, so it needs additional disk space. Existing ZIPs, manually extracted files, and earlier preparation runs are preserved.

Portal login, uploads, portal processing, and multiple-project iteration will be added in later steps.

Validate this stage locally without logging into either platform:

```bash
npm exec tsc -- --noEmit
npm run test:import
```

### Kahua browser workflow: login

The Kahua browser workflow runs separately from PlanGrid export and local import preparation:

```bash
npm run kahua
```

It opens `https://devproductionlaunch.kahua.com/` in visible Chromium. The initial navigation allows up to 60 seconds for the browser to receive the server response, but it does not wait for the page's `DOMContentLoaded` event. This prevents Kahua's slow Uno initialization from being mistaken for a navigation failure. After the response arrives, the workflow waits for the actual Uno canvas and accessibility controls without fixed sleeps or a fixed rendering deadline.

The workflow enables Uno accessibility, fills the email field from `KAHUA_USERNAME`, activates the semantic Next button, waits for the password field, fills it from `KAHUA_PASSWORD`, and activates the final Sign In button. Direct semantic activation avoids coordinates that can briefly lag behind the canvas layout.

Separate entries have been added to `.env.example`. Set the same entries in your local `.env` when credentials are needed:

```env
KAHUA_URL=https://devproductionlaunch.kahua.com/
KAHUA_USERNAME=
KAHUA_PASSWORD=
```

Both Kahua credential values must be set before running this stage. `KAHUA_URL` must use HTTPS and is independent of PlanGrid's `PLATFORM_URL`. Credential values are not written to logs.

After the password step, the workflow waits for either the authenticated navigation controls, an explicit credential error, or the known notice. It recognizes the DevProduction staging-data usage notice by its message text. Kahua exposes duplicate `CmdOk` semantic buttons, so the workflow focuses the enabled button with the largest live bounding area and presses Enter, matching Uno's keyboard-accessible dialog action. Login is verified only after both `TasksNavigationItem` and `MessagesNavigationItem` appear in the semantic tree. Unknown or partially rendered dialogs remain untouched. It does not depend on the old password element disappearing because Uno may retain stale semantic elements while changing screens.

The workflow then pauses with Playwright Inspector on the authenticated landing page. Turn on **Record**, perform the next actions manually, and copy the generated code before clicking **Resume**. Because the visible application is canvas-rendered, the recorder may emit `#uno-canvas` coordinate clicks. Those lines still document the interaction sequence; replace coordinates with stable semantic controls such as `xamlautomationid` attributes as each step is implemented.

Logs use `logs/kahua-import-<timestamp>.log`. Later project navigation and upload actions will be added on top of this verified login flow.
