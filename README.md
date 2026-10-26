# PlanGrid Export Automation

This automation logs into PlanGrid, searches for each enabled project, creates or finds the requested As-built export, waits for it to finish, downloads the ZIP file, and logs out when the run is complete.

## One-time setup

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
