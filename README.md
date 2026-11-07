# PlanGrid Export and Kahua Import Automation

This repository contains a two-part automation workflow. Part A downloads project exports from PlanGrid. Part B prepares those exports and will upload them to Kahua, but that workflow is still under development.

## Workflow overview

| Part | Status | Current capabilities |
| --- | --- | --- |
| Part A — PlanGrid export and local preparation | Available | Downloads enabled projects, extracts their ZIPs, copies Documents/Photos into local sync staging, and separately copies all other project contents into drawings staging. Chrome mode retains authentication; automated mode logs out. |
| Part B — Kahua import | **In development** | Prepares one configured project's drawing files, validates the preparation plan, and automates Kahua login through landing-page verification. Project selection and file upload are not implemented yet. |

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

Part A is the working export workflow. It logs into PlanGrid, finds each enabled project, generates a fresh As-built export, waits for completion, and downloads the ZIP file.

### Configure the environment

Copy `.env.example` to `.env` in the repository folder if you do not already have one. When updating an existing installation, add any missing settings from `.env.example` while preserving your credentials and custom paths.

For the main Chrome → unzip → sync workflow and the separate drawings copy, configure these directories:

```env
DOWNLOAD_DIR=downloads
SYNC_UP_DIR=sync_ups
DRAWINGS_DIR=drawings
```

`DOWNLOAD_DIR` is the source/output root shared by Chrome export, unzip, and both copy commands. `SYNC_UP_DIR` is the destination root for copied Documents/Photos. `DRAWINGS_DIR` is a separate destination for everything else, including Drawings and other files/folders. Their defaults are `downloads`, `sync_ups`, and `drawings` inside the repository. Relative paths resolve from the repository folder; absolute paths can point to different folders or drives.

Windows example (forward slashes work with Node.js on Windows):

```env
DOWNLOAD_DIR=D:/PlanGrid/downloads
SYNC_UP_DIR=E:/Migration/sync_ups
DRAWINGS_DIR=E:/Migration/drawings
```

macOS example:

```env
DOWNLOAD_DIR=/Volumes/PlanGridData/downloads
SYNC_UP_DIR=/Users/kunalchand/Desktop/sync_ups
DRAWINGS_DIR=/Users/kunalchand/Desktop/drawings
```

If the ZIP contains case-distinct files in the same directory, use a case-sensitive download location to preserve both. Keep that volume mounted during download, extraction, and copying. Both copy destinations must also support the names being copied; the commands do not rename conflicting files.

For the miscellaneous automated-login modes, also configure:

```env
PLANGRID_EMAIL=your_email
PLANGRID_PASSWORD=your_password
PLATFORM_URL=https://app.plangrid.com
```

Passwords are never written to the logs. `PLANGRID_EMAIL` and `PLANGRID_PASSWORD` are required for automated login. Chrome session mode uses the browser's existing authentication and does not read or require those credentials. `PLATFORM_URL` controls the initial navigation in automated mode; Chrome mode opens the PlanGrid projects URL directly.

### Prepare the project input

Update `input/projects.csv` with one project per row:

```csv
project_uid,project_name,project_clean_name,enabled,start_date,end_date
,Example Project,Example_Project,true,,
project-12345,Another Project,Another_Project,true,2026-01-01,2026-08-31
project-12346,Disabled Project,Disabled_Project,false,,
```

The CSV must contain `project_uid`, `project_name`, `project_clean_name`, and `enabled` columns. Use the six-column header above; it replaces the old `project_number` header.

| Column | Purpose |
| --- | --- |
| `project_uid` | Project identifier used in logs. May be blank; project selection still uses `project_name`. |
| `project_name` | Required original PlanGrid project name, used to search for the project. |
| `project_clean_name` | Required folder name and ZIP base name, without the `.zip` extension. |
| `enabled` | Required `true` or `false`; disabled projects are skipped. |
| `start_date`, `end_date` | Optional dates in `YYYY-MM-DD` format. Blank values leave platform defaults unchanged. |

`project_clean_name` is used as entered after trimming surrounding whitespace; it is no longer generated from `project_name`. Spaces, hyphens, underscores, and periods within a name are preserved. Use a single folder/file base name: do not include paths, slashes, `<>:"\\|?*`, control characters, trailing periods, or Windows-reserved names such as `CON` or `NUL`. Invalid names stop the run before the browser starts. Clean names must be unique among enabled projects, ignoring case and equivalent Unicode forms, to prevent output collisions. Quote any CSV value containing commas.

### Run commands in order

Complete the shared setup, configure `.env`, and prepare `input/projects.csv` first. Run the following steps separately from the repository folder, continuing only after the previous step succeeds. All commands work on **Windows Command Prompt, Windows PowerShell, macOS, and Linux**.

| Step | Command | Result |
| --- | --- | --- |
| 1. [Download through Chrome](#step-1-existing-chrome-session) | **`npm run export:chrome`** | Downloads ZIPs for enabled projects. |
| 2. [Unzip](#step-2-extract-downloaded-zip-files) | **`npm run unzip`** | Extracts each ZIP into its clean-name parent folder. |
| 3. [Prepare local sync folders](#step-3-prepare-documents-and-photos-for-syncing) | **`npm run sync:prepare`** | Copies Documents/Photos into an existing `SYNC_UP_DIR/<project_clean_name>/` folder. |

**Before the Chrome step, enable remote debugging at `chrome://inspect/#remote-debugging` and keep Chrome signed in to PlanGrid.** The separate [drawings copy](#prepare-drawings-and-other-project-contents) can also run after successful extraction. Alternative login modes, validation, and Part B commands are under [Miscellaneous](#miscellaneous).

#### Step 1: Existing Chrome session

```bash
npm run export:chrome
```

**Main download command. Enable remote debugging before running.** The command above is the same on macOS/Linux and Windows Command Prompt or PowerShell.

**Before running:** Install regular Google Chrome 144 or newer separately. `npm run install:browsers` installs Playwright's Chromium, not the regular Chrome used by this mode. PlanGrid credentials in `.env` are not required for this mode.

Set up Chrome on the machine that will run the script:

1. Open **regular Chrome**, using the same OS user account that will run the script. Use a normal browser profile, rather than an Incognito window.
2. Open `https://app.plangrid.com` and sign in manually. Complete any Autodesk CAPTCHA/OTP and reach the PlanGrid projects page.
3. Open another Chrome tab. Paste **`chrome://inspect/#remote-debugging` into Chrome's address bar**, then press Enter.
4. **Enable remote debugging on that page.** Keep Chrome running with this setting enabled.
5. On macOS, if access to Chrome's connection metadata is denied, open **System Settings → Privacy & Security → Files & Folders**. Enable **Google Chrome** access for the terminal or host app running the script, then retry.

Run the highlighted command from the repository folder, then complete these steps for each run:

1. Click **Allow** if Chrome asks to share its debugging session.
2. The script opens a new export tab and navigates to `https://app.plangrid.com/projects`. Wait for the projects page and visible project search box.
3. Click **Resume ▶** in **Playwright Inspector**, the separate window opened by the script. The script verifies the projects URL and search box before starting exports. The first enabled project reuses this page and repeats readiness checks before searching, without an extra navigation. If authentication cannot be verified, no exports start.
4. After exports, review the browser at the final pause and click **Resume ▶** again to disconnect. Chrome and its tabs remain open and signed in. The script also skips logout during failure cleanup.

For every enabled project, the script opens **Settings → Download and Export As-Builts** and requests a fresh export. If previous builds exist, it captures every existing build ID from the table, including IDs in hidden links on processing rows, then immediately clicks **Generate a new As-built** to open the date form. It does not wait for older builds to finish. First-time projects open the form directly and start with no previous IDs. Both paths fill configured dates (blank CSV dates preserve platform defaults), check and verify every Include checkbox present, and click **Zip File**. This export behavior is shared by all three export commands.

After returning to the table, the script compares its build IDs with the snapshot. **Exactly one new ID is required before tracking or downloading.** If none has appeared yet, it waits without an overall time limit and does not reuse an older build or submit again. If multiple new IDs appear during identification, it logs the project as FAILED and attempts no download; it never guesses based on row position. Missing, malformed, mismatched, or duplicate identifiers also fail the affected project. Once identified, the script keeps tracking that specific build ID even if another build later appears above it. It downloads only when the tracked build reaches `100%` and its own Download link is visible, then reports success only after the ZIP has been saved. Logs identify the build ID, form/table page, first-time/recurring path, and confirmed checkbox options; download URLs are not logged.

Failure detection is deliberately limited: a tracked build whose visible status is exactly **Failed**, **Error**, **Cancelled**, or **Canceled** (ignoring case and an optional final period/exclamation mark) fails that project. Unknown or blank status text alone is not treated as terminal; until the `100%`/visible-Download pair is met, it produces a warning and continued polling. Unusable page controls or a missing/duplicated tracked row fail through the existing control-readiness checks. Older builds' statuses do not determine the new build's outcome. Build generation and transfer have no overall timeout, and restarting still processes the enabled CSV entries without saved checkpoints or automatic skipping.

After authentication, the first enabled project reuses the projects page when its URL still matches. It waits for the page and search field to be ready even if Resume was clicked while the screen was still rendering. Later enabled projects navigate to the landing page once before searching, including after a previous project fails or is not found. Each project is logged with its CSV position and total.

| Projects-page step | Wait |
|---|---|
| Navigation or initial page readiness | Up to 45 seconds |
| Visible search field | Up to 30 seconds |
| Extra settling before entering the project name | Fixed 5 seconds |
| Search entry, matching row, and opening that row | Up to 30 seconds per operation |

The maximum waits finish early when their condition is met. A navigation/readiness error fails that project; a project match that does not appear within the search wait is logged as skipped. The script logs the result and continues to the next CSV project, whose next enabled entry opens the landing page again. It does not automatically retry an entire export, which could request duplicate builds. Failed projects produce a nonzero exit status after all entries have been processed; authentication/startup failures still stop exports before the loop. These waits leave the authentication and Kahua timing rules unchanged.

Download logs show **Clicking Download**, then **ZIP download started; saving to destination**. **As-built ZIP saved** appears only after saving finishes. If transfer or saving takes longer, status messages report elapsed minutes at **10, 20, 40, 80… minutes since the download click**, with gaps eventually capped at 24 hours. These messages are informational: they do not change the download, retry it, impose a transfer timeout, or affect build-progress polling. Updates stop when saving succeeds or the download operation fails.

For later runs, keep Chrome running, keep remote debugging enabled, and reuse the same profile. You do not need to keep a PlanGrid tab open: the script opens the projects page itself. If the session expires, sign in through Chrome again before running. See [Chrome's connection instructions](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session).

##### Chrome connection notes

For the standard [Chrome setup above](#step-1-existing-chrome-session):

- Leave `PLANGRID_CHROME_USER_DATA_DIR` and `PLANGRID_CDP_URL` unset in `.env`; the script finds the connection automatically.
- Run only one export script against the Chrome session at a time.
- Chrome stays open and signed in after the run, including when an export fails.

###### Troubleshooting macOS permissions

If the script cannot read Chrome's connection information, open **System Settings → Privacy & Security → Files & Folders**. Enable **Google Chrome** access for the terminal or host app running the script, then retry.

###### Advanced connection settings

Use these optional `.env` settings only for a custom Chrome data directory or an existing debugging endpoint:

```env
PLANGRID_CHROME_USER_DATA_DIR=/absolute/path/to/chrome/user-data-directory
# Alternatively, supply an existing local CDP endpoint for a browser with a debugging port:
PLANGRID_CDP_URL=http://127.0.0.1:9222
```

The directory setting only tells the script where to find the connection information. The script does not launch Chrome or copy or modify its profile. Keep debugging WebSocket endpoints private.

Older Chrome versions require an already-enabled debugging endpoint in a separate user data directory. The script does not restart Chrome or enable debugging automatically.

###### Running on a hosted or remote machine

Use this setup only if the script runs on another computer or server:

1. Use a persistent desktop session accessible through Remote Desktop or VNC.
2. Run Chrome and the script on that machine under the same OS user, and sign in to PlanGrid there. Deploying the repository does not transfer your laptop's signed-in session.
3. Keep the Chrome profile, downloads, and logs on persistent storage.
4. Complete Chrome's **Allow** prompt when shown and both **Resume ▶** steps in Playwright Inspector, as described above.

This mode still requires manual interaction and cannot currently run as an unattended scheduled job.

###### How the connection works (technical background)

The script reads Chrome's `DevToolsActivePort` connection metadata and connects through the Chrome DevTools Protocol (CDP). It opens the export tab in Chrome's existing default browser context, which shares your signed-in session.

#### Step 2: Extract downloaded ZIP files

```bash
npm run unzip
```

**Extract after downloading.** Run from the repository folder on **Windows Command Prompt, Windows PowerShell, macOS, or Linux**.

Install dependencies with `npm install` first. This local step does not require a browser, Playwright Chromium, or login credentials. It reads the same `input/projects.csv` and uses the same `DOWNLOAD_DIR` configuration (default: `downloads`).

For each enabled row, it opens `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>.zip` and creates a parent folder named `project_clean_name` next to that ZIP. All contents are extracted into `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/`. If the ZIP has a single project wrapper containing Documents, Photos, or Drawings, extraction omits that wrapper and places its contents directly in the clean-name parent. All deeper folder paths and filenames are preserved, and the source ZIP is retained.

`project_clean_name` locates the project folder and ZIP and names the extraction parent; `project_name` is not used to name extracted contents. For example, PlanGrid's `DB2505 - I-24 at Epps Mill-Buchanan Road/Documents/...` becomes `Documents/...` inside the extraction parent named `DB2505 - I-24 at Epps Mill_Buchanan Road`. The wrapper's hyphen/underscore difference therefore creates no extra folder. This removes only the single project container; it does not flatten Documents, Photos, Drawings, or their nested subfolders. Archives already containing those folders at their root, or containing multiple top-level items, keep their layout.

Apart from the omitted project wrapper, internal names remain unchanged, including trailing spaces and periods. Names unsupported by the host filesystem cause a reported failure rather than being renamed.

For example, with `project_clean_name=Example_Project`, the result might be:

```text
downloads/
  Example_Project/
    Example_Project.zip
    Example_Project/
      Drawings/
      Documents/
```

Disabled rows are skipped. **Re-running unzip clears all previous contents of the inner extraction folder**, including files that also exist in the new ZIP, then copies in the verified new extraction. This also removes stale files or an older extra project wrapper. The extraction directory itself stays in place, and the folder-layout rules above still apply. No manual renaming or cleanup is required. Treat `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/` as generated output; only the contents of the current ZIP remain there after a successful refresh. The source ZIP, files beside the extraction parent, and sync staging output are not replaced.

Extraction first builds a temporary replacement and verifies file sizes and checksums. It then creates or reuses the final clean-name folder and **copies the verified contents into it, without renaming directories**. This avoids relying on the stage-to-final directory rename that Windows may block. On a refresh, the previous contents are copied to a temporary backup before the final folder's contents are cleared; the final directory itself stays in place. After a successful copy, temporary staging and backups are removed. This uses additional temporary disk space for staging and, when replacing an extraction, its backup.

The `.unzip-stage-*` and `.unzip-backup-*` steps are deliberate safeguards: invalid archives fail before previous output is cleared, and the backup supports recovery if publication fails. They add disk I/O and temporary space use, but preserve previous output when checksums, unsafe paths, or filesystem filename conflicts prevent a valid extraction.

A corrupt archive or extraction failure retains the previous output. If copying into the final folder fails, the command attempts to restore the previous contents by copying them back; if restoration also fails, it reports the retained backup location for recovery. Windows locks or permissions can still block copying or deletion, and these failures are reported. Temporary cleanup problems are logged. The final folder is populated progressively during copying, so start sync preparation only after unzip reports success. Missing folders/ZIPs, unsafe paths, archive links, and filename collisions within the ZIP still fail that project; the command continues with the remaining projects and exits with a nonzero status if any project fails.

Archives containing different files such as `9C.pdf` and `9c.pdf` in the same internal folder require a case-sensitive destination to retain both names. The command checks the filesystem through the existing ZIP's filename and reports both conflicting paths before extracting on a case-insensitive destination. Adding the extraction parent does not resolve such conflicts; use a case-sensitive download location and set `DOWNLOAD_DIR` accordingly to preserve these archives exactly.

The command logs per-project results and a final summary to the terminal and `logs/unzip-<timestamp>.log`. Temporary-fixture tests are listed under [Validation commands](#validation-commands).

#### Step 3: Prepare Documents and Photos for syncing

```bash
npm run sync:prepare
```

**Copy after successful extraction.** Run from the repository folder on **Windows Command Prompt, Windows PowerShell, macOS, or Linux**.

This command copies local files only. It does not unzip archives, open a browser, upload files, or connect to a sync service. Install dependencies with `npm install` and use the same `input/projects.csv` and `DOWNLOAD_DIR` as the export/unzip steps. The earlier filename-conflict limitation still applies to extraction; this command does not resolve or retry it.

For each enabled project, it opens `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/` and looks for `Documents` and `Photos` directly in that folder, matching the refreshed unzip layout. For older extractions, if neither is directly present, it also checks the immediate child directories to support a project wrapper included in the ZIP. If more than one wrapper contains those folders, it reports an ambiguous source instead of merging them. It does not search arbitrary nested drawing trees.

The destination project folder must already exist and be named exactly `project_clean_name` from the CSV. It copies whichever source folders exist, including all their nested files, subdirectories, and empty folders, into that existing parent:

```text
sync_ups/
  <project_clean_name>/  # must already exist
    Documents/      # when present in the extracted project
    Photos/         # when present in the extracted project
```

The source contents and folder names remain unchanged. Only `Documents/` and/or `Photos/` inside that destination project folder can be created or updated; other folders, loose files, and other projects in `sync_ups` remain untouched. Drawings and other source project folders are not copied. Disabled rows and projects with neither folder are skipped; missing extraction folders or destination project folders are reported as failures.

Configure the staging root in `.env` (relative paths resolve from this repository):

```env
SYNC_UP_DIR=sync_ups
```

For example, on Windows you can instead use:

```env
SYNC_UP_DIR=C:/Users/MigrationEngineer/Desktop/sync_ups
```

On macOS, an example absolute path is `SYNC_UP_DIR=/Users/kunalchand/Desktop/sync_ups`. Copy destinations must be separate from the extracted project tree. The configured root and each destination project directory must already exist; this command does not create them.

If a destination `Documents` or `Photos` folder being copied already exists, the command warns that its contents will be merged and reports how many files would be overwritten, including zero when all incoming files are new. Existing files absent from the source are retained. **If matching destination files already exist, the command asks once per project before copying anything:**

```text
EXISTING FILES FOUND — REVIEW BEFORE MERGING
Project: <project_clean_name>
Destination: <SYNC_UP_DIR>/<project_clean_name>
Existing files that will be overwritten: <count>
  Documents/example.pdf
MERGE: new files will be added, and the listed matching files will be replaced with extracted source files.
Destination-only files and folders will be kept, including files absent from the latest export.
Choose y/yes to approve this project, or n/Enter to skip the entire project without changes.
Overwrite these existing files? [y/N]:
```

The preview lists up to ten affected paths and the total count. Enter **`y` or `yes`** to overwrite the existing matching files and copy new files. Enter **`n` or `no`**, press **Enter**, or close input to skip that complete project without changing its destination. Approval applies to that project's listed existing files in this run; it is not saved for future runs or other projects. Unrelated destination files are retained, and sources remain unchanged. If every incoming file is new, copying proceeds without a prompt.

Run in an interactive terminal when approving overwrites. A noninteractive run encountering existing files fails that project without copying, rather than assuming approval. Links, special files, and file/directory type conflicts are rejected. If a destination file changes while confirmation is pending, the command stops that project so you can review it again. Approved replacements are copied to a temporary file before replacing the old file. A disk error or filesystem name conflict can still leave a partially completed project; inspect the staging folder before retrying. The command continues with the other projects, logs approval/decline decisions, and exits with a nonzero status if any project fails.

Logs are written to the terminal and `logs/sync-preparation-<timestamp>.log`. The default `sync_ups` contents are ignored by Git. Temporary-folder tests are listed under [Validation commands](#validation-commands).

### Part A output

- Input data: `input/projects.csv`
- Downloaded ZIP files: `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>.zip`
- Run logs: `logs/export-<timestamp>.log`

For example, `project_clean_name=Grainger_101410_01_ROW_Plans` produces `downloads/Grainger_101410_01_ROW_Plans/Grainger_101410_01_ROW_Plans.zip` with the default download directory. The ZIP filename supplied by PlanGrid is replaced with this configured name. Re-running the same project with the same clean name saves to the same path and can replace its previous ZIP.

## Miscellaneous

These commands cover the separate drawings copy, alternative login modes, validation, and the Part B workflow that is still in development. Use the three commands above for the regular download → unzip → local sync preparation workflow.

### Prepare Drawings and other project contents

```bash
npm run drawings:prepare
```

Run after successful `npm run unzip`, from the repository folder on **Windows Command Prompt, Windows PowerShell, macOS, or Linux**. Install dependencies with `npm install` first. This is a separate local copy command using the same `input/projects.csv` and `DOWNLOAD_DIR`; it does not open a browser or upload anything. It can run independently of `sync:prepare` once extraction succeeds.

For each enabled project, it reads `<DOWNLOAD_DIR>/<project_clean_name>/<project_clean_name>/`, creates `<DRAWINGS_DIR>/<project_clean_name>/`, and copies **everything except the project's top-level `Documents` and `Photos` entries**. This includes Drawings, all other folders, loose files such as export reports, nested contents, and empty folders. Folder hierarchy and internal names are preserved; nested folders named Documents or Photos inside an included tree are retained. Sources remain unchanged.

For an older extraction containing only one project wrapper with Documents, Photos, or Drawings, it copies from inside that wrapper. Multiple matching wrappers are rejected as ambiguous. When there are multiple top-level items, their hierarchy and sibling files are retained rather than omitting a wrapper.

With the default `DRAWINGS_DIR=drawings`, output looks like:

```text
drawings/
  <project_clean_name>/
    Drawings/
      <version folder>/
        <nested files and folders>
    <other project folders>/
    <other project files>
```

Set `DRAWINGS_DIR` in `.env` to change the destination; relative and absolute examples are in [Configure the environment](#configure-the-environment). The destination must be separate from the extracted project tree. Disabled projects and projects containing only Documents/Photos (or no contents) are skipped. Missing extraction folders fail that project.

The same merge behavior and overwrite safeguards as `sync:prepare` apply. Before copying any files for a project with existing matching destination files, the command displays **EXISTING FILES FOUND — REVIEW BEFORE MERGING**, previews the project, destination, count, and up to ten example paths, and explains that matching files will be replaced while destination-only files will be kept. It then asks once:

```text
Overwrite these existing files? [y/N]:
```

Only `y`/`yes` approves replacing the listed files in that project for that run. `n`/`no`, Enter, or closed input skips the entire project unchanged. Noninteractive conflicts fail without copying. New files need no prompt. Unrelated destination files remain, including any Documents/Photos already in the destination. Destinations are rechecked after approval, and approved replacements are staged before replacing existing files. Links, special files, overlapping source/destination trees, and file/directory type conflicts are rejected. A filesystem error can still leave a partially completed project; inspect the destination before retrying. Failures do not stop later projects, but cause a nonzero exit status.

Logs are written to `logs/drawings-preparation-<timestamp>.log` and the terminal. Generated contents in the default `drawings/` folder are ignored by Git. This copy is separate from Part B's drawing-version import preparation.

### Normal automated login

```bash
npm run export
```

Runs on macOS/Linux and Windows Command Prompt or PowerShell.

**Before running:** Set `PLANGRID_EMAIL` and `PLANGRID_PASSWORD` in `.env`. Install Playwright's Chromium with `npm run install:browsers` during shared setup. You do not need to open Chrome or enable remote debugging for this mode.

1. The script opens a visible browser, navigates to `PLATFORM_URL`, and enters the email/password automatically.
2. If Playwright Inspector pauses for Autodesk verification, complete the CAPTCHA/OTP in the browser and submit it. Wait for the PlanGrid projects page and project search box, then click Inspector's **Resume ▶** button.
3. The script verifies authentication and exports the enabled projects.
4. After exports, it attempts logout and pauses again. Check the browser, log out manually if necessary, then click **Resume ▶** to close it.

### Headless automated login

```bash
npm run headless
```

Runs on macOS/Linux and Windows Command Prompt or PowerShell.

**Before running:** Configure the same credentials and Playwright Chromium as normal automated login. This retained mode uses a fresh browser and does not reuse your signed-in Chrome session. It cannot handle manual CAPTCHA/OTP, and the current Autodesk handoff requires a visible browser. Use a visible mode when authentication requires interaction.

The script attempts automated login and exports without showing a browser or Inspector. If manual verification is required, it stops with an error. After processing, it attempts logout and closes the browser without a final manual pause.

The npm commands set `HEADLESS` inside Node.js before loading the application, so no shell-specific environment-variable commands are needed. You can keep using Windows Command Prompt. To switch that session to Windows PowerShell, type `powershell` and press Enter; type `exit` to return to Command Prompt.

### Automated export flow

When `npm run export` starts, it opens the configured `PLATFORM_URL` in a visible browser. The flow is:

1. PlanGrid opens and the email address is submitted.
2. The browser moves to Autodesk, where the email address is filled and submitted again.
3. If Autodesk skips the password step, the script waits for the PlanGrid projects landing page.
4. If Autodesk shows a password field, the script fills the password and clicks **Sign in**.
5. **[Manual action — see “Autodesk OTP and CAPTCHA” below](#autodesk-otp-and-captcha):** If CAPTCHA, OTP, or verification appears, the script pauses. Complete it in the browser, submit it, wait for the PlanGrid projects page and project search box, and click **Resume** in the Playwright window.
6. The script searches `input/projects.csv` by project name and processes each enabled project.
7. For each project, it opens Settings → Download and Export As-Builts, snapshots all previous build IDs, and generates a fresh export without waiting for older builds, clicking **Generate a new As-built** when previous builds exist. It uses the provided dates when present, checks and verifies every Include checkbox, and clicks **Zip File**. It requires exactly one new build ID, then polls that specific build until `100%` with a visible Download link and saves its ZIP. Ambiguous identities or explicit failure statuses fail that project and allow the loop to continue. Logs identify the build ID, each form/table page, and the first-time/recurring path.
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

### Validation commands

```bash
npm exec tsc -- --noEmit
npm run test:export
npm run test:unzip
npm run test:sync
npm run test:drawings
npm run test:import
```

These checks use local tests and temporary fixtures; they do not launch a real login/export run or copy your downloaded projects. Run the checks relevant to your changes. `test:export` checks CSV parsing and simulated first-time/recurring export requests, checkbox verification, whole-table ID snapshots (including processing builds), ambiguity rejection, stable-ID polling despite reordered rows, conservative status handling, rejection of older downloads, initial-page reuse and readiness waits, recovery after project failures, download naming, and transfer-status scheduling/cleanup with a simulated clock; `test:unzip` checks extraction; `test:sync` checks Documents/Photos copying; `test:drawings` checks copying everything else; `test:import` checks Part B local preparation.

### Part B — Kahua import (in development)

> **Status:** Part B is actively being developed. It currently prepares local drawing files for one configured project and completes Kahua login. It does not yet select the destination project, navigate to the upload tool, upload files, or process multiple projects end to end.

#### Prepare a single-project import

```bash
npm run import:prepare
```

This stage prepares local drawing files for a later upload workflow.

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

See [Validation commands](#validation-commands) to check this stage without logging into either platform.

#### Kahua browser workflow: login

```bash
npm run kahua
```

The Kahua browser workflow runs separately from PlanGrid export and local import preparation.

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
