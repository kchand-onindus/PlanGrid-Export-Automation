"""
ebuilder_bulk_grant_import.py

Logs into e-Builder, then for each project number in PROJECT_NUMBERS:
    1. Searches for and opens the project (reusing the same exact-match
       search logic proven in ebuilder_bulk_field_update.py)
    2. Clicks into the "Processes" module
    3. Filters process instances to "APP"
    4. Opens the matching APP instance (see *** IMPORTANT *** below)
    5. In the popup window, scrolls to the Grant Info Dynamic Grid and
       clicks Import
    6. Uploads the matching local .xls file for that project
    7. Clicks Import, then Save, then closes the popup
    8. Logs the result to Excel after EVERY project
Then logs out.

*** IMPORTANT ***
    APP instance selection is now based on real DOM evidence: each
    instance appears as a cell reading "APP - N" inside a table with
    data-test-id="main-table". The script parses every such cell's
    number and picks the highest one — e.g. "APP - 4" over "APP - 1/2/3"
    — rather than guessing based on visual/DOM order. Still worth
    watching the first couple of TEST_MODE runs closely on any project
    that actually has multiple instances, to confirm it grabs the right
    one in practice.

SETUP
    pip install playwright python-dotenv openpyxl --break-system-packages
    python -m playwright install chromium

    .env file, same as your other scripts:
        EBUILDER_USERNAME=shubhda_shail@onindus.com
        MS_EMAIL=sshail@onindus.com
        EBUILDER_PASSWORD=your_password
        EBUILDER_ACCOUNT_NAME=Miami Dade County, FL
        EBUILDER_URL=https://app-us2.e-builder.net/auth/www/index.aspx?ReturnUrl=%2f

    GRANT_FILES_FOLDER below must point to the folder containing your
    141 generated grant tracker .xls files (named like
    "3001385_METROMOVER_..._OVERHAUL.xls").

USAGE
    python ebuilder_bulk_grant_import.py
"""

import glob
import os
import re
import sys
import time
from datetime import datetime

import openpyxl
from openpyxl.utils import get_column_letter
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

load_dotenv()

EBUILDER_USERNAME = os.environ.get("EBUILDER_USERNAME")
MS_EMAIL = os.environ.get("MS_EMAIL")
PASSWORD = os.environ.get("EBUILDER_PASSWORD")
ACCOUNT_NAME = os.environ.get("EBUILDER_ACCOUNT_NAME")
BASE_URL = os.environ.get(
    "EBUILDER_URL",
    "https://app-us2.e-builder.net/auth/www/index.aspx?ReturnUrl=%2f",
)

PROFILE_DIR = "ebuilder_profile"
STEP_CHECK_TIMEOUT_MS = 6_000
MFA_MANUAL_ENTRY_TIMEOUT_MS = 120_000

LOG_FILE = "cashflow_import_log.xlsx"

# *** SET THIS to the folder holding your 141 generated .xls files ***
GRANT_FILES_FOLDER = (
    r"/Users/kunalchand/Desktop/projects/others/shubhda-kunal-execution/kunal"
)

# --- SAFETY: verify the flow works before running the full list ------------
TEST_MODE = False
TEST_LIMIT = 2
# -----------------------------------------------------------------------------

# Confirmed identical across both example projects in your recording —
# looks like a shared template ID, not project-specific.
GRID_GUID = "fef510497cac41c49f61938820f60351"
GRID_IMPORT_BTN_ID = (
    f"ctl00_contentSection_DynamicGrid_{GRID_GUID}_ucGridInstance_btnImport"
)
GRID_MODAL_SELECTOR = (
    f"#ctl00_contentSection_DynamicGrid_{GRID_GUID}_ucGridInstance_modalImport iframe"
)
GRID_SAVE_BTN_ID = "ctl00_contentSection_btnSave"
# Section header for the Cashflow grid — confirmed via recording, this is
# a table cell (NOT plain text like the earlier "Grant Information"
# section), clicked twice in the recording (possibly a real two-step
# expand behavior, so replicated exactly rather than assumed to be one).
GRID_SECTION_HEADER_SELECTOR = (
    f"#ctl00_contentSection_DynamicGrid_{GRID_GUID}_ucGridInstance_dynamicGridWrapper "
    "> .section-header-accordion > tbody > tr > td:nth-child(2)"
)

PROJECT_NUMBERS = [
    # "3008541",
    # "3008543",
    "3008544",
    "3008545",
    "3008546",
    "3009127",
    "3009245",
    "3009246",
    "3009248",
    "3009249",
    "3009250",
    "3009254",
    "3009255",
    "3009256",
    "3009257",
    "3009258",
    "3009259",
    "3009260",
    "3009281",
    "3009283",
    "3009288",
    "3009289",
    "3009290",
    "3009291",
    "3009293",
    "3009403",
    "3009404",
    "3009482",
    "3009483",
    "3009484",
    "3009621",
    "3009622",
    "3009623",
    "3009624",
    "3009625",
    "3009626",
    "3009627",
    "3009628",
    "3009629",
    "3009630",
    "3009636",
    "3009637",
    "3009638",
    "3009639",
    "3009640",
    "3009641",
    "3009642",
    "3009643",
    "3009644",
    "3009645",
    "3009705",
    "3009706",
    "3009707",
    "3009708",
    "3009709",
    "3009721",
    "3009722",
    "3009781",
    "3010202",
    "3010701",
    "3010704",
    "3010705",
    "3010706",
    "3010707",
    "3010712",
    "3010713",
    "3010714",
    "3010715",
    "3010716",
    "3010717",
    "3010718",
    "3010719",
    "3010720",
    "3010936",
    "3011061",
    "3011201",
    "3011285",
    "3011301",
    "3011302",
    "3011304",
    "3011321",
    "3011341",
    "3011361",
    "3011365",
    "3011368",
    "3011369",
    "3011370",
    "3011371",
    "3011379",
    "3011382",
    "3011383",
    "3011390",
    "3011391",
    "3011393",
    "3011394",
    "3011408",
    "3011426",
    "3011427",
    "3011429",
    "3011430",
    "3011431",
    "3011432",
    "3011434",
    "3011435",
    "3011436",
    "3011437",
    "3011438",
    "3011439",
    "3011440",
    "3011443",
    "3011444",
    "3011445",
    "3011446",
    "3011447",
    "3011450",
    "3011452",
    "3011455",
    "3011456",
    "3011457",
    "3011458",
    "3011459",
    "3011460",
    "3011461",
    "3011462",
    "3011463",
    "3011464",
    "3011466",
    "3011467",
    "3011602",
    "3011723",
    "3011724",
    "3011861",
    "3011901",
    "3011902",
    "3011903",
    "3011904",
    "3011921",
    "3011941",
    "3011961",
    "3011962",
    "3012021",
    "3012041",
    "3012121",
    "3012984",
    "3012985",
    "3013001",
    "3013002",
    "3013025",
    "3013041",
    "3013042",
    "3013045",
    "3013046",
    "3013047",
    "3013048",
    "3013049",
    "3013061",
    "3013064",
    "3013065",
    "3013066",
    "3013067",
    "3013086",
    "3013087",
    "3013090",
    "3013101",
    "3013102",
    "3013103",
    "3013104",
    "3013105",
    "3013106",
    "3013107",
    "3013108",
    "3013109",
    "3013110",
    "3013111",
    "3013112",
    "3013113",
]


def is_visible_now(locator, timeout=STEP_CHECK_TIMEOUT_MS):
    try:
        locator.wait_for(state="visible", timeout=timeout)
        return True
    except PlaywrightTimeoutError:
        return False


# ---------------------------------------------------------------------------
# Excel logging
# ---------------------------------------------------------------------------


def init_log_workbook():
    if os.path.exists(LOG_FILE):
        wb = openpyxl.load_workbook(LOG_FILE)
        ws = wb.active
    else:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Import Log"
        headers = ["Project No.", "Project Name", "Status", "Timestamp", "Notes"]
        ws.append(headers)
        for c in range(1, len(headers) + 1):
            ws.cell(row=1, column=c).font = openpyxl.styles.Font(bold=True)
        widths = [14, 45, 12, 20, 50]
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        wb.save(LOG_FILE)
    return wb, ws


def log_result(wb, ws, project_no, project_name, status, notes=""):
    ws.append(
        [
            project_no,
            project_name or "",
            status,
            datetime.now().strftime("%m/%d/%Y %H:%M:%S"),
            notes,
        ]
    )
    save_log_with_retry(wb)


def save_log_with_retry(wb, max_attempts=3, delay_seconds=3):
    for attempt in range(1, max_attempts + 1):
        try:
            wb.save(LOG_FILE)
            return
        except PermissionError:
            if attempt < max_attempts:
                print(
                    f"  (Could not save {LOG_FILE} — it may be open in Excel. "
                    f"Close it if so. Retrying in {delay_seconds}s...)"
                )
                time.sleep(delay_seconds)
            else:
                fallback = f"cashflow_import_log_{int(time.time())}.xlsx"
                print(
                    f"  Still couldn't save {LOG_FILE} after {max_attempts} attempts. "
                    f"Saving to {fallback} instead."
                )
                wb.save(fallback)


def find_grant_file(project_no):
    """Look up the local .xls file for this project by its number prefix.
    Naming convention confirmed via recording: "{project_no} - 2026
    Cashflow Download.xls" — the pattern below matches that broadly
    (project number, then " - ", then anything, then .xls)."""
    pattern = os.path.join(GRANT_FILES_FOLDER, f"{project_no} - *.xls")
    matches = glob.glob(pattern)
    if not matches:
        return None
    return matches[0]


# ---------------------------------------------------------------------------
# Login (identical to ebuilder_bulk_field_update.py)
# ---------------------------------------------------------------------------


def login(page):
    print(f"Navigating to {BASE_URL} ...")
    page.goto(BASE_URL)

    projects_link = page.get_by_role("link", name="Projects", exact=True)
    if is_visible_now(projects_link, timeout=5_000):
        print("Already logged in (remembered session) — skipping login steps.")
        return

    eb_username_field = page.get_by_role("textbox", name="Username")
    if is_visible_now(eb_username_field):
        eb_username_field.click()
        eb_username_field.fill(EBUILDER_USERNAME)
        page.locator("#usernameContinueBtn").get_by_text("Continue").click()

    ms_email_field = page.get_by_role("textbox", name="Email or username")
    if is_visible_now(ms_email_field):
        ms_email_field.click()
        ms_email_field.fill(MS_EMAIL)
        page.get_by_role("button", name="Next").click()

    cookie_banner = page.locator("#onetrust-banner-sdk")
    if is_visible_now(cookie_banner, timeout=3_000):
        cookie_banner.click()

    password_field = page.get_by_role("textbox", name="Password")
    if is_visible_now(password_field):
        password_field.click()
        password_field.fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()

    code_field = page.get_by_role("textbox", name="Code")
    if is_visible_now(code_field):
        print("\n>>> MFA code needed. Switch to the browser window now.")
        print(
            ">>> Enter the current code from your Authenticator app and click Submit."
        )
        print(
            f">>> Waiting up to {MFA_MANUAL_ENTRY_TIMEOUT_MS // 1000}s for you to do that...\n"
        )
        page.get_by_role("button", name="Submit").wait_for(
            state="hidden", timeout=MFA_MANUAL_ENTRY_TIMEOUT_MS
        )

    account_dropdown = page.get_by_label("Select account to log into")
    if is_visible_now(account_dropdown, timeout=10_000):
        try:
            account_dropdown.select_option(label=ACCOUNT_NAME)
        except PlaywrightTimeoutError:
            try:
                options = account_dropdown.evaluate(
                    "el => Array.from(el.options).map(o => ({value: o.value, label: o.label || o.text}))"
                )
                print(
                    f"\nCould not select an option labeled {ACCOUNT_NAME!r}. Options actually available:"
                )
                for opt in options:
                    print(f"  value={opt['value']!r}  label={opt['label']!r}")
            except Exception:
                pass
            raise
        page.get_by_role("button", name="Continue").click()

    page.get_by_role("link", name="Projects", exact=True).wait_for(
        state="visible", timeout=30_000
    )
    print("Login successful.")


# ---------------------------------------------------------------------------
# Project search (identical logic to ebuilder_bulk_field_update.py)
# ---------------------------------------------------------------------------


def find_and_open_project(page, project_no, max_attempts=3):
    """Retries the whole search-and-click sequence if it fails — kept as
    a general safety net (e.g. against transient slow periods on
    e-Builder's side), even though the click itself now uses Playwright's
    default timeout rather than an artificially short one. See
    _attempt_find_and_open_project for the actual logic."""
    last_notes = ""
    for attempt in range(1, max_attempts + 1):
        success, project_name, notes = _attempt_find_and_open_project(page, project_no)
        if success:
            return True, project_name, notes
        last_notes = notes
        if attempt < max_attempts:
            page.wait_for_timeout(500)
    return False, "", f"(after {max_attempts} attempts) {last_notes}"


def _attempt_find_and_open_project(page, project_no):
    """Returns (success: bool, project_name: str, notes: str).

    This widget turns out to be the SAME Telerik RadComboBox template used
    on the Projects-module page (confirmed by identical column headers:
    "Project No." | "Project Name" | "Managing Department"). Each row is
    <li class="rcbItem rcbTemplate"> containing <li class="comboCol">
    cells — not a single text blob. Reusing the proven matching logic
    from ebuilder_bulk_field_update.py, including the element_handle()
    fix that correctly disambiguates e.g. "3001034" from "3001034-DEMO".
    """
    id_input = page.locator(
        "#ctl00_ctl00_ContentPlaceHolder1_contentSection_psCombo_cmbProjectName_Input"
    )

    # Click the dropdown arrow first, if present, to properly "wake up"
    # this combo instance before typing. A much earlier recording showed
    # this as a required extra step specifically when switching projects
    # from within an already-open project's page (as opposed to arriving
    # fresh at the main Processes tab) — never incorporated until now.
    # Evidence this matters: some searches returned a large, unrelated set
    # of results instead of ever filtering, suggesting the AJAX filter
    # wasn't triggering at all for those specific searches.
    arrow_btn = page.locator(
        "#ctl00_ctl00_ContentPlaceHolder1_contentSection_psCombo_cmbProjectName_Arrow"
    )
    if is_visible_now(arrow_btn, timeout=2_000):
        arrow_btn.click()
        page.wait_for_timeout(300)

    id_input.click()
    # Playwright uses Meta for the macOS Command key; Control+a does not
    # select the entire field on macOS, so the previous project number could
    # remain and the next number would be appended to it.
    id_input.press("Meta+a")
    id_input.press("Delete")
    page.wait_for_timeout(300)

    # Simulate real keystrokes — .fill() doesn't trigger this widget's
    # AJAX suggestion search (confirmed root cause of earlier stalls).
    id_input.press_sequentially(project_no, delay=100)

    try:
        page.wait_for_load_state("networkidle", timeout=10_000)
    except PlaywrightTimeoutError:
        pass

    try:
        page.wait_for_selector("li.rcbTemplate", state="attached", timeout=10_000)
    except PlaywrightTimeoutError:
        return False, "", "No suggestions rendered at all for this project number."

    def row_project_no(row, timeout=800):
        return row.locator(".comboCol").first.inner_text(timeout=timeout).strip()

    # A row is ALWAYS classed "rcbTemplate" — but "rcbItem" only applies
    # to non-highlighted rows, and swaps to "rcbHovered" for whichever one
    # is currently auto-highlighted (confirmed via DevTools: the hovered
    # row's actual class is "rcbHovered rcbTemplate", never "rcbItem" at
    # all). With exactly one result, that single row IS the hovered one
    # from the start — so restricting to .rcbItem alone finds zero rows
    # in that case. Match on .rcbTemplate alone instead, which covers both.
    #
    # POLL for the match rather than reading once after a fixed delay.
    # A fixed short delay risks reading BEFORE the AJAX filter has
    # actually finished narrowing results (catching the stale, unfiltered
    # "All Projects" default list instead) — real evidence showed exactly
    # that (texts like "MIF-E2", "PWS-FY280165" — the default list — for
    # a search that should have returned just 2 filtered rows). A fixed
    # LONG delay, on the other hand, risks the dropdown auto-closing
    # before we click. Polling adapts to however long filtering actually
    # takes on each project, and clicks the instant a match appears.
    match_handle = None
    scanned_texts = []
    poll_deadline = time.time() + 8.0
    while time.time() < poll_deadline and match_handle is None:
        rows = page.locator("li.rcbTemplate")
        scanned_texts = []
        for i in range(rows.count()):
            row = rows.nth(i)
            try:
                no_text = row_project_no(row, timeout=400)
            except PlaywrightTimeoutError:
                scanned_texts.append("(unreadable)")
                continue
            scanned_texts.append(no_text)
            if no_text == project_no:
                # Freeze a handle to THIS specific element immediately —
                # the list can still be streaming/reordering, so clicking
                # a live index-based locator later risks clicking
                # whatever ends up at that position by then (this is what
                # caused "3001034-DEMO" to get clicked instead of
                # "3001034" once).
                match_handle = row.element_handle()
                break
        if match_handle is None:
            page.wait_for_timeout(250)

    # Fallback for virtualized/not-yet-rendered rows: use the widget's own
    # arrow-key navigation, which loads more as you go past what's rendered.
    if match_handle is None:
        for _ in range(120):
            id_input.press("ArrowDown")
            page.wait_for_timeout(150)
            hovered = page.locator("li.rcbHovered.rcbTemplate")
            if hovered.count() == 0:
                continue
            try:
                no_text = row_project_no(hovered.first)
            except PlaywrightTimeoutError:
                continue
            if no_text == project_no:
                match_handle = hovered.first.element_handle()
                break

    if match_handle is None:
        return (
            False,
            "",
            (
                f"Scanned all available suggestions but found no exact match for project "
                f"{project_no}. Texts actually seen: {scanned_texts}"
            ),
        )

    # Re-verify against the frozen handle immediately before clicking —
    # this is a synchronous check against an already-obtained handle, so
    # it doesn't add meaningful delay on its own.
    try:
        cells = match_handle.query_selector_all(".comboCol")
        confirmed_no = cells[0].inner_text().strip()
        project_name = cells[1].inner_text().strip()
    except Exception as e:
        return False, "", f"Matched row became stale before it could be clicked: {e}"

    if confirmed_no != project_no:
        return (
            False,
            "",
            (
                f"Re-check right before clicking found '{confirmed_no}', not '{project_no}' "
                "— list changed underneath us. Skipped rather than risk clicking the wrong row."
            ),
        )

    # Use Playwright's default timeout (30s), NOT a short artificial one.
    # Direct comparison against the proven grant-import script (which ran
    # successfully across many consecutive projects using a plain
    # match_handle.click() with no timeout override) showed this was the
    # actual difference — the short 5s timeout was very likely giving up
    # before Playwright's own built-in visible/stable/enabled wait would
    # have succeeded naturally. The retry wrapper in find_and_open_project
    # above still provides resilience if a click genuinely never resolves.
    try:
        match_handle.click()
    except PlaywrightTimeoutError:
        return (
            False,
            "",
            "Row was found and verified but became unclickable before the click landed (likely dropdown auto-close).",
        )
    except Exception as e:
        return False, "", f"Row became unusable right before clicking: {e}"

    page.wait_for_load_state("networkidle")
    return True, project_name, ""


# ---------------------------------------------------------------------------


def select_last_app_instance(page):
    """
    Filters process instances to "APP" and returns the instance with the
    HIGHEST number (e.g. picks "APP - 4" over "APP - 1/2/3"). Confirmed
    via two separate recordings, which showed two different possible DOM
    shapes for the instance cells:
      1. A <table data-test-id="main-table"> with role="cell" entries
      2. A plain <div> with exact text "APP - N"
    Both are tried, since we don't know which will be present on any
    given project's page.
    """
    filter_box = page.get_by_role("textbox", name="Filter process instance table")
    filter_box.click()
    filter_box.fill("APP")
    filter_box.press("Enter")
    page.wait_for_timeout(1000)

    close_panel_btn = page.get_by_role("button", name="close panel")
    if is_visible_now(close_panel_btn, timeout=2_000):
        close_panel_btn.click()

    app_pattern = re.compile(r"^APP\s*-\s*\d+$")

    candidate_strategies = [
        lambda: page.locator('[data-test-id="main-table"]')
        .get_by_role("cell")
        .filter(has_text=app_pattern),
        lambda: page.locator("div").filter(has_text=app_pattern),
    ]

    cells = None
    for strategy in candidate_strategies:
        try:
            candidates = strategy()
            if candidates.count() > 0:
                cells = candidates
                break
        except Exception:
            continue

    if cells is None:
        return (
            None,
            "No APP process instances found after filtering (tried table-cell and div strategies).",
        )

    best_cell = None
    best_num = -1
    for i in range(cells.count()):
        cell = cells.nth(i)
        try:
            text = cell.inner_text(timeout=2_000).strip()
        except PlaywrightTimeoutError:
            continue
        m = re.match(r"^APP\s*-\s*(\d+)$", text)
        if m:
            num = int(m.group(1))
            if num > best_num:
                best_num = num
                best_cell = cell

    if best_cell is None:
        return (
            None,
            "Found APP-labeled elements but couldn't parse instance numbers from any of them.",
        )

    return best_cell, ""


def import_grant_file(page, project_no, project_name):
    """Returns (success: bool, notes: str). Assumes we're on the project's
    Processes tab with the process instance table already visible."""
    instance_locator, err = select_last_app_instance(page)
    if instance_locator is None:
        return False, err

    try:
        with page.expect_popup(timeout=15_000) as popup_info:
            instance_locator.click()
        popup = popup_info.value
    except PlaywrightTimeoutError:
        return False, "APP instance click did not open the expected popup window."

    # Safety guard: if this ever resolves to the SAME page object instead
    # of a genuine new popup (e.g. a project with a single process
    # instance navigating in-place instead of opening a real popup), never
    # let popup.close() run — that would close the main working page and
    # break every subsequent project for the rest of the run.
    is_real_popup = popup is not page

    try:
        # Click into the Cashflow grid's section header to reveal it. The
        # recording showed this clicked twice — made conditional here
        # rather than a blind double-click, since the section may already
        # be expanded after the first click (a redundant second click
        # risks toggling it back closed, or worse, on a stale element).
        section_header = popup.locator(GRID_SECTION_HEADER_SELECTOR)
        if is_visible_now(section_header, timeout=10_000):
            section_header.click()
            popup.wait_for_timeout(400)
            import_btn_visible = is_visible_now(
                popup.locator(f"#{GRID_IMPORT_BTN_ID}"), timeout=2_000
            )
            if not import_btn_visible:
                section_header.click()
                popup.wait_for_timeout(500)

        popup.locator(f"#{GRID_IMPORT_BTN_ID}").click(timeout=15_000)

        import_frame = popup.locator(GRID_MODAL_SELECTOR).content_frame
        file_input_btn = import_frame.get_by_role(
            "button", name="*Import file Please select a"
        )
        file_input_btn.wait_for(state="visible", timeout=10_000)

        grant_file_path = find_grant_file(project_no)
        if not grant_file_path:
            if is_real_popup:
                popup.close()
            return (
                False,
                f"No local Cashflow file found in {GRANT_FILES_FOLDER} for project {project_no}.",
            )

        file_input_btn.set_input_files(grant_file_path)
        import_frame.get_by_role("button", name="Import", exact=True).click()

        # Save was clicked twice in the recording. Made conditional: only
        # click again if the button is still there and the popup hasn't
        # already closed itself as part of a successful save — a blind
        # second click risks firing against an already-closing window.
        save_btn = popup.locator(f"#{GRID_SAVE_BTN_ID}")
        save_btn.click(timeout=15_000)
        popup.wait_for_timeout(800)
        if not popup.is_closed() and is_visible_now(save_btn, timeout=2_000):
            save_btn.click(timeout=15_000)
        popup.wait_for_timeout(1500)  # let the save round-trip complete
        if is_real_popup:
            popup.close()
        return True, f"Imported {os.path.basename(grant_file_path)}"

    except PlaywrightTimeoutError as e:
        popup.screenshot(path=f"error_import_{project_no}.png")
        if is_real_popup:
            popup.close()
        return (
            False,
            f"Timeout during import/save: {e}. Screenshot: error_import_{project_no}.png",
        )
    except Exception as e:
        try:
            popup.screenshot(path=f"error_import_{project_no}.png")
            if is_real_popup:
                popup.close()
        except Exception:
            pass
        return (
            False,
            f"Error during import/save: {e}. Screenshot: error_import_{project_no}.png",
        )


def process_project(page, project_no):
    """Per-project flow: find project (already inside Processes module),
    filter/select the APP instance, and import the grant file."""
    found, project_name, notes = find_and_open_project(page, project_no)
    if not found:
        return False, project_name, notes

    success, import_notes = import_grant_file(page, project_no, project_name)
    return success, project_name, import_notes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    missing = [
        name
        for name, val in [
            ("EBUILDER_USERNAME", EBUILDER_USERNAME),
            ("MS_EMAIL", MS_EMAIL),
            ("EBUILDER_PASSWORD", PASSWORD),
            ("EBUILDER_ACCOUNT_NAME", ACCOUNT_NAME),
        ]
        if not val
    ]
    if missing:
        print(f"Missing from .env: {', '.join(missing)}")
        sys.exit(1)

    if not os.path.isdir(GRANT_FILES_FOLDER):
        print(f"GRANT_FILES_FOLDER does not exist: {GRANT_FILES_FOLDER}")
        print("Update that path at the top of this script.")
        sys.exit(1)

    projects_to_run = PROJECT_NUMBERS[:TEST_LIMIT] if TEST_MODE else PROJECT_NUMBERS
    if TEST_MODE:
        print(
            f"*** TEST_MODE is ON — only processing the first {TEST_LIMIT} "
            f"project(s): {projects_to_run} ***"
        )
        print(
            "*** Watch the browser directly, especially the APP-instance "
            "selection step if any project has more than one instance. ***\n"
        )

    wb, ws = init_log_workbook()

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(PROFILE_DIR, headless=False)
        page = context.pages[0] if context.pages else context.new_page()

        try:
            login(page)

            # Click into the Processes module ONCE — the project search
            # widget lives inside this module and is reused across all
            # projects, rather than re-entering per project via the
            # Projects tab.
            page.get_by_role("link", name="Processes").click()
            page.wait_for_load_state("networkidle")

            for i, project_no in enumerate(projects_to_run, start=1):
                if page.is_closed():
                    print(
                        f"\nMain page was closed unexpectedly before project {project_no} "
                        f"(processed {i-1}/{len(projects_to_run)}). Stopping here instead of "
                        "continuing to fail on every remaining project — check the log for "
                        "what happened around the last successful import."
                    )
                    break

                print(
                    f"[{i}/{len(projects_to_run)}] Processing project {project_no} ..."
                )
                try:
                    success, project_name, notes = process_project(page, project_no)
                    status = "Success" if success else "Failed"
                    if not success:
                        try:
                            page.screenshot(path=f"error_{project_no}.png")
                            notes = (
                                notes + f" Screenshot: error_{project_no}.png"
                            ).strip()
                        except Exception:
                            pass
                    log_result(wb, ws, project_no, project_name, status, notes)
                    print(
                        f"  -> {status}: {project_name or '(name not captured)'} | {notes}"
                    )
                except Exception as e:
                    try:
                        page.screenshot(path=f"error_{project_no}.png")
                    except Exception:
                        pass
                    log_result(
                        wb,
                        ws,
                        project_no,
                        "",
                        "Failed",
                        f"Error: {e}. Screenshot: error_{project_no}.png",
                    )
                    print(f"  -> Failed (error) — logged and continuing.")

            print(f"\nDone processing {len(projects_to_run)} project(s).")

            # ---- LOGOUT ---------------------------------------------------
            if page.is_closed():
                log_result(
                    wb,
                    ws,
                    "SESSION",
                    "",
                    "Logout Skipped",
                    "Main page was already closed (see earlier note in the log) — nothing to log out of.",
                )
                print("Skipping logout — page was already closed.")
            else:
                try:
                    user_menu_strategies = [
                        lambda: page.get_by_role(
                            "button", name="User menu, Shubhda Shail"
                        ),
                        lambda: page.get_by_text("SS", exact=True),
                        lambda: page.locator("div")
                        .filter(has_text="SSShubhda Shail")
                        .nth(4),
                    ]
                    opened_menu = False
                    for strategy in user_menu_strategies:
                        locator = strategy()
                        if is_visible_now(locator, timeout=5_000):
                            locator.click()
                            opened_menu = True
                            break
                    if not opened_menu:
                        raise PlaywrightTimeoutError(
                            "Could not find the user menu with any known selector."
                        )

                    page.get_by_text("Sign out").click()
                    page.wait_for_load_state("networkidle")
                    log_result(
                        wb,
                        ws,
                        "SESSION",
                        "",
                        "Logged Out",
                        f"Session ended after processing {len(projects_to_run)} project(s).",
                    )
                    print("Logout successful.")
                except Exception as e:
                    try:
                        page.screenshot(path="error_logout.png")
                    except Exception:
                        pass
                    log_result(
                        wb,
                        ws,
                        "SESSION",
                        "",
                        "Logout Failed",
                        f"Error: {e}. Screenshot: error_logout.png",
                    )
                    print(f"Logout failed — logged. Error: {e}")

        finally:
            context.close()


if __name__ == "__main__":
    main()
