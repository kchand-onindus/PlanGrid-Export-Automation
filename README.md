# PlanGrid Export Automation

This automation logs into PlanGrid, searches for each enabled project, creates or finds the requested As-built export, waits for it to finish, downloads the ZIP file, and logs out when the run is complete.

## One-time setup

Use Node.js 22.2 or newer (the import preparation verifies ZIP checksums using Node's built-in CRC32 support).

From the repository folder, run:

```bash
npm install
npm run install:browsers
```

## Configure the environment

Fill in `.env` before running the script:

```env
PLANGRID_EMAIL=your_email
PLANGRID_PASSWORD=your_password
PLATFORM_URL=https://app.plangrid.com
DOWNLOAD_DIR=downloads
```

`DOWNLOAD_DIR` may be a relative path, which is resolved inside this repository, or an absolute path. The password is never written to the logs.

## Prepare the project input

Update `input/projects.csv` with one project per row:

```csv
project_number,project_name,enabled,start_date,end_date
,Example Project,true,,
12345,Another Project,true,2026-01-01,2026-08-31
12346,Disabled Project,false,,
```

`project_name` and `enabled` are required. `enabled` must be `true` or `false`. Project number, start date, and end date may be blank. Any dates provided must use `YYYY-MM-DD` format.

## Reference scripts

The `reference-scripts/` directory is personal reference material and is unrelated to the repository code. Agents and workflows must ignore it completely during repository analysis, implementation, testing, and workflow design. Its files must not be read, executed, modified, moved, deleted, or included in repository work.

## Run the automation

Run the visible browser flow with:

```bash
npm run export
```

The browser is visible by default. An optional non-visible run is available with:

```bash
npm run headless
```

## Run flow

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

## Autodesk OTP and CAPTCHA

After the email and password steps, Autodesk may request a CAPTCHA, OTP, or additional verification.

When this happens, the automation does not try to solve or bypass the challenge:

1. Complete the CAPTCHA or verification in the browser.
2. If Autodesk requests an OTP, enter it.
3. Click Autodesk’s Submit, Next, or equivalent button.
4. Wait until the browser reaches the PlanGrid projects landing page and the project search box is visible.
5. Click the **Resume** button in the Playwright window that opened with the browser.

The script verifies the projects page and search box after Resume. If Autodesk is still showing CAPTCHA or verification, it stops with a clear authentication error instead of starting the export and failing later during project search.

The automation will then continue with the project exports. If Autodesk signs in directly without OTP, it continues automatically.

## Output

- Input data: `input/projects.csv`
- Downloaded ZIP files: the configured `DOWNLOAD_DIR`, inside a folder named after each project
- Run logs: `logs/export-<timestamp>.log`

Project names are cleaned when folder names are created. Special characters are replaced with underscores so names containing slashes, asterisks, punctuation, or other filesystem-sensitive characters can be used safely.

## Part two: prepare a single-project import

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

## Kahua browser workflow: login

The Kahua browser workflow runs separately from PlanGrid export and local import preparation:

```bash
npm run kahua
```

It opens `https://devproductionlaunch.kahua.com/` in visible Chromium. Kahua may take a long time to update each login screen, so the workflow waits for the actual Uno controls without fixed sleeps. It enables Uno accessibility, fills the email field from `KAHUA_USERNAME`, activates the semantic Next button, waits for the password field, fills it from `KAHUA_PASSWORD`, and activates the final Sign In button. Direct semantic activation avoids coordinates that can briefly lag behind the canvas layout.

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
