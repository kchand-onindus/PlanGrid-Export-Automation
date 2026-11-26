import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright';
import { exportProject } from './project-exporter.js';
import { readProjects } from './csv.js';
import { summarizeExports, logExportSummary } from './export-summary.js';
import { logger, type LogContext } from './logger.js';
import { PROJECT_SELECTORS, TIMEOUTS, URLS } from '../utils/constants.js';
import type { ExportErrorType, Project, ProjectResult } from './types.js';

const includeNames = [
  'inc_sheets', 'inc_conformed', 'inc_master', 'inc_user_annotations', 'inc_photos',
  'inc_attach', 'inc_field_reports', 'inc_drawing_log', 'inc_curr_set_log',
];
const excludedNames = ['inc_conformed', 'inc_drawing_log', 'inc_curr_set_log'];

function assertIncludeSettings(checkboxes: { name: string; checked: boolean }[]): void {
  for (const { name, checked } of checkboxes) {
    assert.equal(checked, !excludedNames.includes(name), `Incorrect Include setting for ${name}`);
  }
}

interface FixtureBuild {
  id: string;
  progress: string;
  status: string;
  visible: boolean;
  href?: string | null;
  linkCount?: number;
}

async function createFixture(t: TestContext, options: {
  recurring?: boolean;
  blankDates?: boolean;
  checkboxNames?: string[];
  unchangeableOption?: string;
  revertOptionAfterSetup?: string;
  neverPublishNewBuild?: boolean;
  navigationFailures?: number;
  settingsReadyFailures?: number;
  httpStatus?: number;
  homeRedirect?: string;
  exportRedirect?: string;
  projectName?: string;
  failDownloadClick?: boolean;
  beforeSave?: (destination: string) => Promise<void>;
  onPoll?: () => void;
  previousBuilds?: FixtureBuild[];
  newBuilds?: FixtureBuild[];
  newStatus?: (poll: number) => string;
  newHref?: string | null;
  laterBuildAtPoll?: number;
  missingTrackedAtPoll?: number;
  duplicateTrackedAtPoll?: number;
  downloadVisibleAtPoll?: number;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-export-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logs: { message: string; context?: LogContext }[] = [];
  for (const level of ['general', 'info', 'debug', 'success', 'warn', 'error'] as const) {
    t.mock.method(logger, level, (message: string, context?: LogContext) => logs.push({ message, context }));
  }
  const project: Project = {
    projectUid: 'uid-1', projectName: options.projectName ?? 'Original / PlanGrid Project',
    projectCleanName: 'Custom Project-01', enabled: true,
    startDate: options.blankDates ? undefined : '2025-01-23',
    endDate: options.blankDates ? undefined : '2026-11-08',
  };
  const state = {
    screen: 'projects', saved: '', generateClicks: 0, zipClicks: 0, polls: 0,
    submitted: false, downloadListening: false, downloadedPaths: [] as string[],
    startDate: '2020-01-01', endDate: '2030-12-31',
    currentUrl: String(URLS.projects),
    navigations: [] as { url: string; timeout: number }[], settingsReadyChecks: 0,
    waits: [] as number[],
    snapshots: [] as { submitted: boolean; ids: string[] }[],
    observedIds: [] as string[],
    checkboxes: (options.checkboxNames ?? includeNames).map((name, index) => ({ name, checked: index % 2 === 0 })),
  };
  const buildPath = (id: string) => `/projects/uid-1/asbuilts/${id}/direct`;
  const previousBuilds: FixtureBuild[] = options.previousBuilds ?? (options.recurring ? [
    { id: 'old-top', progress: '100%', status: 'Download', visible: true },
    { id: 'old-second', progress: '100%', status: 'Download', visible: true },
  ] : []);
  const newPath = buildPath('new');
  const href = (build: FixtureBuild) => build.href === undefined
    ? `/projects/${new URL(state.currentUrl).pathname.split('/')[2]}/asbuilts/${build.id}/direct` : build.href;
  function tableRows(): FixtureBuild[] {
    if (!state.submitted || options.neverPublishNewBuild || (options.recurring && state.polls === 0)) {
      return previousBuilds;
    }
    let rows = options.newBuilds ?? [{
      id: 'new', href: options.newHref,
      progress: state.polls >= 3 ? '100%' : state.polls === 2 ? '65%' : '0%',
      status: options.newStatus?.(state.polls) ?? (state.polls >= 3 ? 'Download' : 'Processing...'),
      visible: state.polls >= (options.downloadVisibleAtPoll ?? 3),
    }];
    if (options.missingTrackedAtPoll !== undefined && state.polls >= options.missingTrackedAtPoll) rows = [];
    if (options.duplicateTrackedAtPoll !== undefined && state.polls >= options.duplicateTrackedAtPoll) rows = [...rows, ...rows];
    if (options.laterBuildAtPoll !== undefined && state.polls >= options.laterBuildAtPoll) {
      rows = [{ id: 'someone-else', progress: '100%', status: 'Download', visible: true }, ...rows];
    }
    return [...rows, ...previousBuilds];
  }

  // Simulate delayed page rendering, form controls, table updates, and download events.
  // No browser, server, credentials, or real project downloads are involved.
  function locator(selector: string, index = 0, buildId?: string) {
    const trackedId = /:has\(a\.asbuilt-download\[href\*="\/asbuilts\/([a-zA-Z0-9-]+)\/direct"\]\)/.exec(selector)?.[1] ?? buildId;
    const isTrackedRow = selector === PROJECT_SELECTORS.asBuiltRowById(trackedId ?? '');
    const selectedRows = () => trackedId === undefined ? tableRows()
      : tableRows().filter((build) => href(build)?.includes(`/asbuilts/${trackedId}/direct`));
    function trackedBuild(): FixtureBuild {
      assert.ok(trackedId, 'Build reads and downloads must be scoped to a stable ID');
      assert.equal(selectedRows().length, 1);
      state.observedIds.push(trackedId);
      return selectedRows()[0];
    }
    return {
      first: () => locator(selector, index, trackedId),
      nth: (itemIndex: number) => locator(selector, itemIndex, trackedId),
      locator: (child: string) => locator(child, 0, trackedId),
      waitFor: async ({ timeout }: { timeout: number }) => {
        if (selector === PROJECT_SELECTORS.settingsLink) {
          assert.equal(state.screen, 'home');
          assert.equal(timeout, TIMEOUTS.projectsReadyMs);
          state.settingsReadyChecks += 1;
          if (state.settingsReadyChecks <= (options.settingsReadyFailures ?? 0)) throw new Error('Settings link readiness timeout');
        } else if (selector === PROJECT_SELECTORS.asBuiltPage) {
          assert.equal(state.screen, 'loading');
          state.screen = options.recurring ? 'table' : 'form';
        } else if (selector === PROJECT_SELECTORS.startDateInput) {
          assert.equal(state.screen, 'form');
        } else if (selector === PROJECT_SELECTORS.asBuiltList || selector === PROJECT_SELECTORS.asBuiltRows) {
          assert.equal(state.screen, 'table');
        } else if (isTrackedRow && selectedRows().length === 0) {
          throw new Error('Tracked As-built row did not become visible');
        }
      },
      fill: async (value: string) => {
        assert.equal(state.screen, 'form');
        if (selector === PROJECT_SELECTORS.startDateInput) state.startDate = value;
        else if (selector === PROJECT_SELECTORS.endDateInput) state.endDate = value;
        else assert.fail(`Unexpected fill: ${selector}`);
      },
      count: async () => {
        if (selector === PROJECT_SELECTORS.includeCheckboxes) return state.checkboxes.length;
        if (isTrackedRow) return selectedRows().length;
        if (selector === PROJECT_SELECTORS.downloadLink) return selectedRows()[0]?.linkCount ?? (selectedRows().length ? 1 : 0);
        return 1;
      },
      evaluateAll: async (callback: (rows: { querySelectorAll: (selector: string) => { getAttribute: (name: string) => string | null }[] }[], selector: string) => unknown, childSelector: string) => {
        assert.equal(selector, PROJECT_SELECTORS.asBuiltRows);
        assert.equal(state.screen, 'table');
        const rows = tableRows();
        state.snapshots.push({ submitted: state.submitted, ids: rows.map(({ id }) => id) });
        return callback(rows.map((build) => ({ querySelectorAll: (child: string) => {
          assert.equal(child, PROJECT_SELECTORS.downloadLink);
          return Array.from({ length: build.linkCount ?? 1 }, () => ({ getAttribute: () => href(build) }));
        } })), childSelector);
      },
      getAttribute: async (name: string) => {
        if (selector === PROJECT_SELECTORS.includeCheckboxes && name === 'name') return state.checkboxes[index].name;
        if (selector === PROJECT_SELECTORS.downloadLink && name === 'href') return href(trackedBuild());
        assert.fail(`Unexpected attribute: ${selector}, ${name}`);
      },
      setChecked: async (checked: boolean) => {
        assert.equal(state.screen, 'form');
        const checkbox = state.checkboxes[index];
        if (checkbox.name !== options.unchangeableOption) checkbox.checked = checked;
        if (index === state.checkboxes.length - 1 && options.revertOptionAfterSetup) {
          const reverted = state.checkboxes.find(({ name }) => name === options.revertOptionAfterSetup)!;
          reverted.checked = excludedNames.includes(reverted.name);
        }
      },
      isChecked: async () => state.checkboxes[index].checked,
      click: async () => {
        if (selector === PROJECT_SELECTORS.settingsLink) {
          assert.equal(state.screen, 'home');
          assert.ok(state.settingsReadyChecks > 0);
          state.screen = 'settings';
        } else if (selector === PROJECT_SELECTORS.asBuiltLink) {
          assert.equal(state.screen, 'settings');
          state.screen = 'loading';
          state.currentUrl = options.exportRedirect ?? new URL('asbuilts', state.currentUrl).href;
        }
        else if (selector === PROJECT_SELECTORS.generateAsBuilt) {
          assert.equal(state.screen, 'table');
          assert.equal(state.submitted, false);
          assert.deepEqual(state.snapshots[0], { submitted: false, ids: previousBuilds.map(({ id }) => id) });
          state.generateClicks += 1;
          state.screen = 'form';
        } else if (selector === PROJECT_SELECTORS.zipOption) {
          assert.equal(state.screen, 'form');
          assert.ok(state.checkboxes.length > 0);
          assertIncludeSettings(state.checkboxes);
          state.zipClicks += 1;
          state.submitted = true;
          state.screen = 'table';
        } else if (selector === PROJECT_SELECTORS.downloadLink) {
          if (options.failDownloadClick) throw new Error('Download click failed');
          assert.equal(state.submitted, true);
          assert.equal(state.downloadListening, true);
          const build = trackedBuild();
          assert.equal(build.progress, '100%');
          assert.equal(build.visible, true);
          state.downloadedPaths.push(href(build)!);
        } else {
          assert.fail(`Unexpected click: ${selector}`);
        }
      },
      isVisible: async () => selector === PROJECT_SELECTORS.startDateInput
        ? state.screen === 'form' : selector === PROJECT_SELECTORS.downloadLink ? trackedBuild().visible : true,
      innerText: async () => selector === PROJECT_SELECTORS.progress ? trackedBuild().progress : trackedBuild().status,
    };
  }
  const page = {
    locator,
    url: () => state.currentUrl,
    goto: async (url: string, { timeout }: { timeout: number }) => {
      state.navigations.push({ url, timeout });
      assert.equal(timeout, TIMEOUTS.projectsNavigationMs);
      if (state.navigations.length <= (options.navigationFailures ?? 0)) throw new Error('Project navigation timeout');
      assert.match(url, /^https:\/\/app\.plangrid\.com\/projects\/[a-zA-Z0-9_-]+\/home$/);
      state.currentUrl = options.homeRedirect ?? url;
      state.screen = 'home';
      state.submitted = false;
      state.polls = 0;
      return { status: () => options.httpStatus ?? 200 };
    },
    waitForLoadState: async () => {},
    waitForTimeout: async (milliseconds: number) => {
      state.waits.push(milliseconds);
      if (state.submitted) {
        state.polls += 1;
        options.onPoll?.();
      }
    },
    isClosed: () => Boolean(options.neverPublishNewBuild && state.polls >= 3),
    waitForEvent: async (event: string) => {
      assert.equal(event, 'download');
      state.downloadListening = true;
      return {
        suggestedFilename: () => { throw new Error('Platform filename must not be used'); },
        saveAs: async (destination: string) => {
          state.saved = destination;
          await options.beforeSave?.(destination);
          await fs.writeFile(destination, 'test ZIP contents');
        },
      };
    },
  } as unknown as Page;
  return { root, page, project, state, logs, newPath };
}

test('first-time export fills dates, configures Include options, polls, and saves using the exact clean name', async (t) => {
  const { root, page, project, state, logs, newPath } = await createFixture(t);
  const result = await exportProject(page, project, root);
  const directory = path.join(root, project.projectCleanName);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.downloadDirectory, directory);
  assert.deepEqual(state.navigations, [{
    url: `${URLS.projects}/${project.projectUid}/home`, timeout: TIMEOUTS.projectsNavigationMs,
  }]);
  assert.ok(state.waits.every((wait) => wait === TIMEOUTS.progressPollMs));
  const destination = path.join(directory, `${project.projectCleanName}.zip`);
  assert.equal(path.dirname(state.saved), root);
  assert.match(path.basename(state.saved), /^\.export-download-.*\.zip$/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'test ZIP contents');
  await assert.rejects(fs.stat(state.saved), { code: 'ENOENT' });
  assert.equal(state.startDate, project.startDate);
  assert.equal(state.endDate, project.endDate);
  assert.equal(state.generateClicks, 0);
  assert.equal(state.zipClicks, 1);
  assertIncludeSettings(state.checkboxes);
  assert.deepEqual(state.downloadedPaths, [newPath]);
  assert.equal(state.polls, 3);
  assert.ok(logs.some(({ context }) => context?.pageType === 'form' && context.exportType === 'first-time'));
  assert.ok(logs.some(({ context }) => context?.pageType === 'table' && context.exportType === 'first-time'));
  const includeLog = logs.find(({ context }) => context?.checkboxCount === includeNames.length);
  assert.match(includeLog?.message ?? '', /Include settings verified/);
  assert.deepEqual(includeLog?.context?.checkedOptions, includeNames.filter((name) => !excludedNames.includes(name)));
  assert.deepEqual(includeLog?.context?.uncheckedOptions, excludedNames);
  assert.equal(includeLog?.context?.projectName, project.projectName);
  const clickLog = logs.findIndex(({ message }) => message.includes('Clicking Download'));
  const saveStartedLog = logs.findIndex(({ message }) => message.startsWith('ZIP download started'));
  const savedLog = logs.findIndex(({ message }) => message === 'As-built ZIP saved');
  assert.ok(clickLog >= 0 && saveStartedLog > clickLog && savedLog > saveStartedLog);
  assert.equal(logs[saveStartedLog].context?.destination, destination);

  state.saved = '';
  const disabled = await exportProject(page, { ...project, enabled: false, projectCleanName: 'Disabled' }, root);
  assert.equal(disabled.status, 'SKIPPED');
  assert.equal(state.navigations.length, 1);
  assert.equal(state.saved, '');
  assert.equal(state.zipClicks, 1);
  assert.deepEqual(await fs.readdir(root), [project.projectCleanName]);
});

test('navigates using the UID from CSV and preserves the project name in logs', async (t) => {
  const projectName = ' Bridge Repair / Phase 1 ';
  const projectUid = '7a4d2bb4-ffe6-57bc-8d5d-ea494a96d6cf';
  const { root, page, project, state, logs } = await createFixture(t);
  const inputFile = path.join(root, 'projects.csv');
  await fs.writeFile(inputFile, 'project_uid,project_name,project_clean_name,enabled\n'
    + `${projectUid},"${projectName}",${project.projectCleanName},true\n`);
  const [csvProject] = await readProjects(inputFile);
  assert.equal((await exportProject(page, csvProject, root)).status, 'SUCCESS');
  assert.deepEqual(state.navigations, [{
    url: `${URLS.projects}/${projectUid}/home`, timeout: TIMEOUTS.projectsNavigationMs,
  }]);
  assert.ok(logs.some(({ context }) => context?.projectUid === projectUid && context.projectName === projectName));
});

test('invalid UIDs fail before project navigation or build submission', async (t) => {
  const { root, page, project, state } = await createFixture(t);
  for (const projectUid of ['', '../another-project', 'uid%2Fanother-project', 'uid?x=1']) {
    const result = await exportProject(page, { ...project, projectUid }, root);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorType, 'PROJECT_SELECTION_ERROR');
    assert.match(result.message ?? '', /project_uid/);
  }
  assert.deepEqual(state.navigations, []);
  assert.equal(state.zipClicks, 0);
});

test('redirected project and export pages fail before submitting a build', async (t) => {
  for (const options of [
    { homeRedirect: URLS.projects },
    { homeRedirect: `${URLS.projects}/another-project/home` },
    { exportRedirect: `${URLS.projects}/another-project/asbuilts` },
    { homeRedirect: 'https://signin.autodesk.com/' },
  ]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, options);
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      assert.equal(state.generateClicks, 0);
      assert.equal(state.zipClicks, 0);
    });
  }
});

test('recurring export generates a fresh build, fills the form, and ignores the old completed top row', async (t) => {
  const { root, page, project, state, logs, newPath } = await createFixture(t, { recurring: true });
  const result = await exportProject(page, project, root);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(state.generateClicks, 1);
  assert.equal(state.zipClicks, 1);
  assert.equal(state.startDate, project.startDate);
  assert.equal(state.endDate, project.endDate);
  assertIncludeSettings(state.checkboxes);
  assert.deepEqual(state.downloadedPaths, [newPath]);
  assert.equal(state.polls, 3);
  assert.ok(logs.some(({ context }) => context?.pageType === 'form' && context.exportType === 'recurring'));
  assert.equal(logs.filter(({ context }) => context?.pageType === 'table' && context.exportType === 'recurring').length, 2);
  assert.ok(logs.some(({ message }) => message.includes('existing builds will not be downloaded')));
  assert.deepEqual(logs.find(({ context }) => context?.checkboxCount)?.context?.uncheckedOptions, excludedNames);
});

test('captures every old ID, including processing and failed rows, and generates without waiting for them', async (t) => {
  const previousBuilds: FixtureBuild[] = [
    { id: 'processing-one', progress: '13%', status: 'Processing...', visible: false },
    { id: 'processing-two', progress: '16%', status: 'Processing...', visible: false },
    { id: 'old-failed', progress: '0%', status: 'Failed', visible: false },
    { id: 'old-ready', progress: '100%', status: 'Download', visible: true },
  ];
  const { root, page, project, state, newPath } = await createFixture(t, { recurring: true, previousBuilds });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.deepEqual(state.snapshots[0], { submitted: false, ids: previousBuilds.map(({ id }) => id) });
  assert.equal(state.generateClicks, 1);
  assert.equal(state.zipClicks, 1);
  assert.deepEqual(state.downloadedPaths, [newPath]);
  assert.ok(state.observedIds.every((id) => id === 'new'));
});

test('keeps tracking the identified build when another completed build later appears above it', async (t) => {
  const { root, page, project, state, newPath, logs } = await createFixture(t, {
    recurring: true, laterBuildAtPoll: 2,
  });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.deepEqual(state.downloadedPaths, [newPath]);
  assert.equal(state.polls, 3);
  assert.ok(state.observedIds.every((id) => id === 'new'));
  assert.deepEqual(logs.filter(({ message }) => message.startsWith('New As-built identified')).map(({ context }) => context?.buildId), ['new']);
});

test('multiple new IDs fail immediately without choosing the topmost build or attempting a download', async (t) => {
  for (const recurring of [false, true]) {
    await t.test(recurring ? 'recurring' : 'first-time', async (subtest) => {
      const newBuilds: FixtureBuild[] = [
        { id: 'someone-else', progress: '100%', status: 'Download', visible: true },
        { id: 'new', progress: '0%', status: 'Processing...', visible: false },
      ];
      const { root, page, project, state, logs } = await createFixture(subtest, { recurring, newBuilds });
      const result = await exportProject(page, project, root);
      assert.equal(result.status, 'FAILED');
      assert.match(result.message ?? '', /Ambiguous As-built request: 2 new build IDs/);
      assert.equal(state.zipClicks, 1);
      assert.deepEqual(state.downloadedPaths, []);
      assert.equal(state.downloadListening, false);
      assert.equal(state.saved, '');
      assert.equal(logs.some(({ message }) => message === 'As-built ZIP saved'), false);
      // A returned failure leaves the caller free to process the next CSV entry.
      newBuilds.splice(0, 1);
      Object.assign(newBuilds[0], { progress: '100%', status: 'Download', visible: true });
      assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
    });
  }
});

test('missing, malformed, or foreign build IDs fail rather than downloading an uncertain record', async (t) => {
  for (const newHref of [null, '/unreadable', '/projects/other/asbuilts/new/direct', 'https://example.invalid/projects/uid-1/asbuilts/new/direct']) {
    await t.test(String(newHref), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, { newHref });
      const result = await exportProject(page, project, root);
      assert.equal(result.status, 'FAILED');
      assert.match(result.message ?? '', /build identifier/);
      assert.deepEqual(state.downloadedPaths, []);
      assert.equal(state.downloadListening, false);
      assert.equal(state.saved, '');
    });
  }
});

test('unreadable or duplicate existing IDs fail before submitting another build', async (t) => {
  for (const previousBuilds of [
    [{ id: 'old', progress: '100%', status: 'Download', visible: true, linkCount: 0 }],
    [{ id: 'old', progress: '100%', status: 'Download', visible: true }, { id: 'old', progress: '0%', status: 'Processing', visible: false }],
  ]) {
    await t.test(previousBuilds.length === 1 ? 'missing link' : 'duplicate ID', async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, { recurring: true, previousBuilds });
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      assert.equal(state.generateClicks, 0);
      assert.equal(state.zipClicks, 0);
      assert.deepEqual(state.downloadedPaths, []);
    });
  }
});

test('clear terminal statuses on the tracked build fail the project without a download', async (t) => {
  for (const status of ['Failed', 'Error', 'Cancelled', 'Canceled']) {
    await t.test(status, async (subtest) => {
      const { root, page, project, state, logs } = await createFixture(subtest, { newStatus: () => status });
      const result = await exportProject(page, project, root);
      assert.equal(result.status, 'FAILED');
      assert.match(result.message ?? '', /Tracked As-built new reported terminal status/);
      assert.deepEqual(state.downloadedPaths, []);
      assert.equal(state.saved, '');
      assert.equal(logs.some(({ message }) => message === 'As-built ZIP saved'), false);
    });
  }
});

test('unfamiliar and blank status text can recover without false failure', async (t) => {
  for (const status of ['Preparing archive', '']) {
    await t.test(status || 'blank', async (subtest) => {
      const { root, page, project, state, logs, newPath } = await createFixture(subtest, {
        newStatus: (poll) => poll >= 3 ? 'Download' : status,
      });
      assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
      assert.deepEqual(state.downloadedPaths, [newPath]);
      assert.equal(logs.filter(({ message }) => message.startsWith('Unrecognized As-built status')).length, 1);
    });
  }
});

test('a missing or duplicated tracked row fails without switching to another completed build', async (t) => {
  for (const options of [{ missingTrackedAtPoll: 2 }, { duplicateTrackedAtPoll: 2 }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, { ...options, laterBuildAtPoll: 2 });
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      assert.deepEqual(state.downloadedPaths, []);
      assert.equal(state.saved, '');
      assert.ok(state.observedIds.every((id) => id === 'new'));
    });
  }
});

test('requires both 100 percent and a visible link on the tracked build', async (t) => {
  for (const downloadVisibleAtPoll of [1, 4]) {
    await t.test(`link visible at poll ${downloadVisibleAtPoll}`, async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, { downloadVisibleAtPoll });
      assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
      assert.equal(state.polls, Math.max(3, downloadVisibleAtPoll));
    });
  }
});

test('blank dates preserve platform defaults and additional Include options are checked', async (t) => {
  const checkboxNames = [...includeNames, 'inc_additional_option'];
  const { root, page, project, state, logs } = await createFixture(t, {
    recurring: true, blankDates: true, checkboxNames,
  });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.equal(state.startDate, '2020-01-01');
  assert.equal(state.endDate, '2030-12-31');
  assertIncludeSettings(state.checkboxes);
  assert.deepEqual(logs.find(({ context }) => context?.checkboxCount)?.context?.checkedOptions,
    checkboxNames.filter((name) => !excludedNames.includes(name)));
  assert.deepEqual(logs.find(({ context }) => context?.checkboxCount)?.context?.uncheckedOptions, excludedNames);
});

test('both export paths enforce Include settings regardless of the initial checkbox states', async (t) => {
  for (const recurring of [false, true]) {
    for (const initialState of ['checked', 'unchecked', 'correct'] as const) {
      await t.test(`${recurring ? 'recurring' : 'first-time'}: initially ${initialState}`, async (subtest) => {
        const { root, page, project, state, logs } = await createFixture(subtest, { recurring });
        for (const checkbox of state.checkboxes) {
          checkbox.checked = initialState === 'correct' ? !excludedNames.includes(checkbox.name) : initialState === 'checked';
        }
        assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
        assertIncludeSettings(state.checkboxes);
        assert.equal(state.zipClicks, 1);
        const confirmation = logs.findIndex(({ message }) => message.includes('Include settings verified'));
        const submission = logs.findIndex(({ message }) => message.startsWith('Selecting Zip File'));
        assert.ok(confirmation >= 0 && submission > confirmation);
      });
    }
  }
});

test('absent optional exclusions do not prevent checking the remaining Include options', async (t) => {
  const checkboxNames = ['inc_sheets', 'inc_photos', 'inc_additional_option'];
  const { root, page, project, state, logs } = await createFixture(t, { checkboxNames });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assertIncludeSettings(state.checkboxes);
  const confirmation = logs.find(({ context }) => context?.checkboxCount);
  assert.deepEqual(confirmation?.context?.checkedOptions, checkboxNames);
  assert.deepEqual(confirmation?.context?.uncheckedOptions, []);
});

test('missing or unverifiable Include settings fail before requesting or downloading a build', async (t) => {
  const cases = [
    { checkboxNames: [] },
    { unchangeableOption: 'inc_photos' },
    ...excludedNames.map((name) => ({ unchangeableOption: name })),
    { revertOptionAfterSetup: 'inc_sheets' },
    { revertOptionAfterSetup: 'inc_conformed' },
  ];
  for (const recurring of [false, true]) {
    for (const options of cases) {
      await t.test(`${recurring ? 'recurring' : 'first-time'}: ${JSON.stringify(options)}`, async (subtest) => {
        const { root, page, project, state, logs } = await createFixture(subtest, { recurring, ...options });
        for (const checkbox of state.checkboxes) checkbox.checked = excludedNames.includes(checkbox.name);
        const result = await exportProject(page, project, root);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.errorType, 'EXPORT_FORM_ERROR');
        assert.match(result.message ?? '', /checkbox/);
        assert.equal(state.zipClicks, 0);
        assert.deepEqual(state.downloadedPaths, []);
        assert.equal(state.saved, '');
        assert.equal(logs.some(({ message }) => message.includes('Include settings verified')), false);
      });
    }
  }
});

test('never falls back to an older download if the new build has not appeared', async (t) => {
  const { root, page, project, state, logs } = await createFixture(t, {
    recurring: true, neverPublishNewBuild: true,
  });
  const result = await exportProject(page, project, root);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message ?? '', /page was closed/);
  assert.equal(state.zipClicks, 1);
  assert.deepEqual(state.downloadedPaths, []);
  assert.equal(state.saved, '');
  assert.equal(logs.filter(({ message }) => message.includes('existing builds will not be downloaded')).length, 1);
});

test('after a project fails, the next project navigates directly using its own UID', async (t) => {
  for (const options of [{ navigationFailures: 1 }, { settingsReadyFailures: 1 }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, options);
      const first = await exportProject(page, project, root);
      assert.equal(first.status, 'FAILED');
      assert.equal(first.errorType, 'PROJECTS_PAGE_ERROR');
      assert.equal(state.zipClicks, 0);
      const next = await exportProject(page, { ...project, projectUid: 'next-uid', projectCleanName: 'Next project' }, root);
      assert.equal(next.status, 'SUCCESS');
      assert.deepEqual(state.navigations.map(({ url }) => url), [
        `${URLS.projects}/${project.projectUid}/home`, `${URLS.projects}/next-uid/home`,
      ]);
    });
  }
});

test('download updates follow elapsed 10/20/40/80 minute milestones and stop after saving', async (t) => {
  let notifySaving!: () => void;
  let finishSaving!: () => void;
  const savingStarted = new Promise<void>((resolve) => { notifySaving = resolve; });
  const savingGate = new Promise<void>((resolve) => { finishSaving = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { root, page, project, logs } = await createFixture(t, {
    onPoll: () => t.mock.timers.tick(10 * 60_000),
    beforeSave: async () => { notifySaving(); await savingGate; },
  });
  const exporting = exportProject(page, project, root);
  const updates = () => logs.filter(({ message }) => message.startsWith('ZIP transfer or saving still in progress'));
  try {
    await savingStarted;
    assert.equal(Date.now(), 30 * 60_000, 'Build polling can exceed 10 minutes without transfer updates');
    assert.equal(updates().length, 0);
    t.mock.timers.tick(10 * 60_000 - 1);
    assert.equal(updates().length, 0);
    t.mock.timers.tick(1);
    t.mock.timers.tick(10 * 60_000);
    t.mock.timers.tick(20 * 60_000);
    t.mock.timers.tick(40 * 60_000);
    assert.deepEqual(updates().map(({ context }) => context?.elapsedMinutes), [10, 20, 40, 80]);
  } finally {
    finishSaving();
    assert.equal((await exporting).status, 'SUCCESS');
  }
  t.mock.timers.tick(160 * 60_000);
  assert.equal(updates().length, 4);
});

test('download status timers stop on click and save failures without logging ZIP saved', async (t) => {
  for (const failure of ['click', 'save']) {
    await t.test(failure, async (subtest) => {
      subtest.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const { root, page, project, logs } = await createFixture(subtest, {
        failDownloadClick: failure === 'click',
        beforeSave: async () => { if (failure === 'save') throw new Error('ZIP save failed'); },
      });
      const result = await exportProject(page, project, root);
      assert.equal(result.status, 'FAILED');
      assert.equal(result.errorType, 'DOWNLOAD_ERROR');
      assert.deepEqual(await fs.readdir(root), [], 'Failed transfers must not leave project or staging folders');
      subtest.mock.timers.tick(80 * 60_000);
      assert.equal(logs.some(({ message }) => message.startsWith('ZIP transfer or saving still in progress')), false);
      assert.equal(logs.some(({ message }) => message === 'As-built ZIP saved'), false);
    });
  }
});

test('reports searchable error types and counts each failed project once in the summary', async (t) => {
  const cases: { options: Parameters<typeof createFixture>[1]; errorType: ExportErrorType }[] = [
    { options: { navigationFailures: 1 }, errorType: 'PROJECTS_PAGE_ERROR' },
    { options: { httpStatus: 404 }, errorType: 'PROJECT_NOT_FOUND' },
    { options: { homeRedirect: URLS.projects, projectName: 'Another missing project' }, errorType: 'PROJECT_NOT_FOUND' },
    { options: { checkboxNames: [] }, errorType: 'EXPORT_FORM_ERROR' },
    { options: { newHref: null }, errorType: 'BUILD_IDENTITY_ERROR' },
    { options: { newStatus: () => 'fAiLeD!' }, errorType: 'BUILD_FAILED' },
    { options: { newStatus: () => 'ERROR.' }, errorType: 'BUILD_ERROR' },
    { options: { newStatus: () => 'Canceled' }, errorType: 'BUILD_CANCELLED' },
    { options: { failDownloadClick: true }, errorType: 'DOWNLOAD_ERROR' },
  ];
  const results: ProjectResult[] = [];
  for (const { options, errorType } of cases) {
    const { root, page, project, logs } = await createFixture(t, options);
    const result = await exportProject(page, project, root);
    results.push(result);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorType, errorType);
    assert.ok(logs.some(({ message, context }) => message.startsWith(`[ERROR_TYPE: ${errorType}]`)
      && context?.errorType === errorType && context.projectName === project.projectName));
    assert.deepEqual(await fs.readdir(root), []);
  }

  const { root, page, project, logs } = await createFixture(t);
  results.push(await exportProject(page, project, root));
  results.push(await exportProject(page, { ...project, enabled: false }, root));
  const errorsByType = {
    PROJECTS_PAGE_ERROR: 1, PROJECT_NOT_FOUND: 2, EXPORT_FORM_ERROR: 1, BUILD_IDENTITY_ERROR: 1,
    BUILD_FAILED: 1, BUILD_ERROR: 1, BUILD_CANCELLED: 1, DOWNLOAD_ERROR: 1,
  };
  assert.deepEqual(summarizeExports(results), { total: 11, success: 1, skipped: 1, failed: 9, errorsByType });
  logExportSummary(results);
  assert.deepEqual(logs.find(({ message }) => message.includes('EXPORT ERROR SUMMARY BY TYPE'))?.context?.errorsByType,
    errorsByType);
  assert.deepEqual(logs.find(({ message }) => message === 'Export run completed')?.context,
    summarizeExports(results));
  assert.deepEqual(summarizeExports(results.slice(-2)).errorsByType, {});
});

test('partial saves are cleaned up before a project folder is created', async (t) => {
  const { root, page, project, state } = await createFixture(t, {
    beforeSave: async (destination) => {
      assert.deepEqual(await fs.readdir(root), [path.basename(destination)]);
      await fs.writeFile(destination, 'partial ZIP');
      throw new Error('Connection lost during saving');
    },
  });
  const result = await exportProject(page, project, root);
  assert.equal(result.errorType, 'DOWNLOAD_ERROR');
  assert.match(result.message ?? '', /Connection lost/);
  assert.notEqual(state.saved, '');
  assert.deepEqual(await fs.readdir(root), []);
});

test('failed ZIP publication removes the newly created empty project folder and staging', async (t) => {
  const { root, page, project } = await createFixture(t);
  t.mock.method(fs, 'rename', async () => { throw new Error('Destination is locked'); });
  const result = await exportProject(page, project, root);
  assert.equal(result.errorType, 'DOWNLOAD_ERROR');
  assert.match(result.message ?? '', /Destination is locked/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('failed exports preserve existing ZIPs, extracted files, empty project folders, and other projects', async (t) => {
  for (const failure of ['lookup', 'build', 'save', 'publish']) {
    await t.test(failure, async (subtest) => {
      const { root, page, project } = await createFixture(subtest, {
        httpStatus: failure === 'lookup' ? 404 : undefined,
        newStatus: failure === 'build' ? () => 'Failed' : undefined,
        beforeSave: failure === 'save' ? async (destination) => {
          await fs.writeFile(destination, 'partial ZIP');
          throw new Error('Saving failed');
        } : undefined,
      });
      const directory = path.join(root, project.projectCleanName);
      const extracted = path.join(directory, project.projectCleanName);
      const previousZip = path.join(directory, `${project.projectCleanName}.zip`);
      await fs.mkdir(extracted, { recursive: true });
      await fs.mkdir(path.join(root, 'Other project'));
      await fs.writeFile(previousZip, 'previous complete ZIP');
      await fs.writeFile(path.join(extracted, 'keep.txt'), 'previous extraction');
      if (failure === 'publish') {
        subtest.mock.method(fs, 'rename', async () => { throw new Error('Destination is locked'); });
      }
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      assert.equal(await fs.readFile(previousZip, 'utf8'), 'previous complete ZIP');
      assert.equal(await fs.readFile(path.join(extracted, 'keep.txt'), 'utf8'), 'previous extraction');
      assert.deepEqual((await fs.readdir(root)).sort(), [project.projectCleanName, 'Other project'].sort());

      await fs.rm(directory, { recursive: true });
      await fs.mkdir(directory);
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      assert.deepEqual(await fs.readdir(directory), [], 'A pre-existing empty project folder must be retained');
    });
  }
});

test('a successful download replaces only the ZIP and keeps existing project contents', async (t) => {
  const { root, page, project } = await createFixture(t);
  const directory = path.join(root, project.projectCleanName);
  const destination = path.join(directory, `${project.projectCleanName}.zip`);
  await fs.mkdir(directory);
  await fs.writeFile(destination, 'previous ZIP');
  await fs.writeFile(path.join(directory, 'keep.txt'), 'unrelated file');
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.equal(await fs.readFile(destination, 'utf8'), 'test ZIP contents');
  assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'unrelated file');
  assert.deepEqual(await fs.readdir(root), [project.projectCleanName]);
});

test('cleanup permission errors are reported with paths without stopping the next project', async (t) => {
  let failSaving = true;
  const { root, page, project, logs } = await createFixture(t, {
    beforeSave: async (destination) => {
      if (!failSaving) return;
      failSaving = false;
      await fs.writeFile(destination, 'partial ZIP');
      throw new Error('ZIP saving failed');
    },
  });
  const remove = fs.rm;
  const mockedRemove = t.mock.method(fs, 'rm', async (target: string, options: Parameters<typeof fs.rm>[1]) => {
    if (path.basename(target).startsWith('.export-download-')) throw new Error('Cleanup permission denied');
    return remove(target, options);
  });
  const result = await exportProject(page, project, root);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorType, 'DOWNLOAD_ERROR');
  assert.ok(logs.some(({ message, context }) => message.startsWith('[ERROR_TYPE: DOWNLOAD_CLEANUP_ERROR]')
    && typeof context?.stagedFile === 'string'));
  assert.deepEqual(summarizeExports([result]).errorsByType, { DOWNLOAD_ERROR: 1 });
  mockedRemove.mock.restore();
  assert.equal((await exportProject(page, { ...project, projectCleanName: 'Next project' }, root)).status, 'SUCCESS');
});
