import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright';
import { exportProject } from './project-exporter.js';
import { readProjects } from './csv.js';
import { logger, type LogContext } from './logger.js';
import { PROJECT_SELECTORS, TIMEOUTS, URLS } from '../utils/constants.js';
import type { Project } from './types.js';

const includeNames = [
  'inc_sheets', 'inc_conformed', 'inc_master', 'inc_user_annotations', 'inc_photos',
  'inc_attach', 'inc_field_reports', 'inc_drawing_log', 'inc_curr_set_log',
];

interface FixtureBuild {
  id: string;
  progress: string;
  status: string;
  visible: boolean;
  href?: string | null;
  linkCount?: number;
}

interface FixtureProjectRow {
  title?: string;
  text: string;
}

async function createFixture(t: TestContext, options: {
  recurring?: boolean;
  blankDates?: boolean;
  checkboxNames?: string[];
  uncheckedOption?: string;
  neverPublishNewBuild?: boolean;
  initialUrl?: string;
  navigationFailures?: number;
  searchReadyFailures?: number;
  projectMatchFailures?: number;
  projectName?: string;
  projectRows?: FixtureProjectRow[];
  failDownloadClick?: boolean;
  beforeSave?: () => Promise<void>;
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
  for (const level of ['info', 'debug', 'success', 'warn', 'error'] as const) {
    t.mock.method(logger, level, (message: string, context?: LogContext) => logs.push({ message, context }));
  }
  const project: Project = {
    projectUid: 'uid-1', projectName: options.projectName ?? 'Original / PlanGrid Project',
    projectCleanName: 'Custom Project-01', enabled: true,
    startDate: options.blankDates ? undefined : '2025-01-23',
    endDate: options.blankDates ? undefined : '2026-11-08',
  };
  const state = {
    screen: 'projects', searched: '', saved: '', generateClicks: 0, zipClicks: 0, polls: 0,
    submitted: false, downloadListening: false, downloadedPaths: [] as string[],
    startDate: '2020-01-01', endDate: '2030-12-31',
    currentUrl: options.initialUrl ?? URLS.projects,
    navigations: [] as { url: string; timeout: number }[], searchReadyChecks: 0, matchChecks: 0,
    waits: [] as number[],
    snapshots: [] as { submitted: boolean; ids: string[] }[],
    observedIds: [] as string[],
    openedProjectTitles: [] as (string | undefined)[],
    checkboxes: (options.checkboxNames ?? includeNames).map((name, index) => ({ name, checked: index % 2 === 0 })),
  };
  const projectRows = options.projectRows ?? [{ title: project.projectName, text: project.projectName }];
  const buildPath = (id: string) => `/projects/uid-1/asbuilts/${id}/direct`;
  const previousBuilds: FixtureBuild[] = options.previousBuilds ?? (options.recurring ? [
    { id: 'old-top', progress: '100%', status: 'Download', visible: true },
    { id: 'old-second', progress: '100%', status: 'Download', visible: true },
  ] : []);
  const newPath = buildPath('new');
  const href = (build: FixtureBuild) => build.href === undefined ? buildPath(build.id) : build.href;
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
  function locator(selector: string, index = 0, buildId?: string, titleFilter?: string, firstOnly = false) {
    const selectedProjects = () => projectRows.filter((row) => titleFilter === undefined
      || row.title === titleFilter);
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
      first: () => locator(selector, index, trackedId, titleFilter, true),
      nth: (itemIndex: number) => locator(selector, itemIndex, trackedId, titleFilter),
      and: ({ projectTitle }: { projectTitle: string }) => locator(selector, index, trackedId, projectTitle),
      locator: (child: string) => locator(child, 0, trackedId),
      waitFor: async ({ timeout }: { timeout: number }) => {
        if (selector === PROJECT_SELECTORS.searchInput) {
          state.searchReadyChecks += 1;
          assert.equal(timeout, TIMEOUTS.projectsReadyMs);
          if (state.searchReadyChecks <= (options.searchReadyFailures ?? 0)) throw new Error('Search box readiness timeout');
        } else if (selector === PROJECT_SELECTORS.projectRows) {
          state.matchChecks += 1;
          assert.equal(timeout, TIMEOUTS.projectsReadyMs);
          if (state.matchChecks <= (options.projectMatchFailures ?? 0)) throw new Error('Project match timeout');
          if (selectedProjects().length === 0) throw new Error('No matching project became visible');
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
        if (selector === PROJECT_SELECTORS.searchInput) {
          assert.ok(state.searchReadyChecks > 0, 'Search must wait for the field even when reusing the page');
          assert.ok(state.waits.includes(TIMEOUTS.projectsPageSettleMs), 'Search must retain the settle wait');
          state.searched = value;
        }
        else {
          assert.equal(state.screen, 'form');
          if (selector === PROJECT_SELECTORS.startDateInput) state.startDate = value;
          else if (selector === PROJECT_SELECTORS.endDateInput) state.endDate = value;
          else assert.fail(`Unexpected fill: ${selector}`);
        }
      },
      count: async () => {
        if (selector === PROJECT_SELECTORS.projectRows) return selectedProjects().length;
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
      check: async () => {
        assert.equal(state.screen, 'form');
        const checkbox = state.checkboxes[index];
        if (checkbox.name !== options.uncheckedOption) checkbox.checked = true;
      },
      isChecked: async () => state.checkboxes[index].checked,
      click: async () => {
        if (selector === PROJECT_SELECTORS.settingsLink) state.screen = 'settings';
        else if (selector === PROJECT_SELECTORS.asBuiltLink) state.screen = 'loading';
        else if (selector === PROJECT_SELECTORS.generateAsBuilt) {
          assert.equal(state.screen, 'table');
          assert.equal(state.submitted, false);
          assert.deepEqual(state.snapshots[0], { submitted: false, ids: previousBuilds.map(({ id }) => id) });
          state.generateClicks += 1;
          state.screen = 'form';
        } else if (selector === PROJECT_SELECTORS.zipOption) {
          assert.equal(state.screen, 'form');
          assert.ok(state.checkboxes.length > 0);
          assert.ok(state.checkboxes.every(({ checked }) => checked), 'All options must be checked before submission');
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
          assert.equal(selector, PROJECT_SELECTORS.projectRows);
          if (!firstOnly) assert.equal(selectedProjects().length, 1, 'Project clicks must resolve to one row');
          state.openedProjectTitles.push(selectedProjects()[index]?.title);
          state.currentUrl = `${URLS.projects}/uid-1`;
        }
      },
      isVisible: async () => selector === PROJECT_SELECTORS.startDateInput
        ? state.screen === 'form' : selector === PROJECT_SELECTORS.downloadLink ? trackedBuild().visible : true,
      innerText: async () => selector === PROJECT_SELECTORS.progress ? trackedBuild().progress : trackedBuild().status,
    };
  }
  const page = {
    locator,
    getByTitle: (projectTitle: string, { exact }: { exact: boolean }) => {
      assert.equal(exact, true, 'Project names must match in full');
      return { projectTitle };
    },
    url: () => state.currentUrl,
    goto: async (url: string, { timeout }: { timeout: number }) => {
      state.navigations.push({ url, timeout });
      assert.equal(timeout, TIMEOUTS.projectsNavigationMs);
      if (state.navigations.length <= (options.navigationFailures ?? 0)) throw new Error('Projects navigation timeout');
      state.currentUrl = url;
      state.screen = 'projects';
      state.submitted = false;
      state.polls = 0;
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
          await options.beforeSave?.();
          await fs.writeFile(destination, 'test ZIP contents');
        },
      };
    },
  } as unknown as Page;
  return { root, page, project, state, logs, newPath };
}

test('first-time export fills dates, checks all options, polls, and saves using the exact clean name', async (t) => {
  const { root, page, project, state, logs, newPath } = await createFixture(t);
  const result = await exportProject(page, project, root);
  const directory = path.join(root, project.projectCleanName);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.downloadDirectory, directory);
  assert.equal(state.searched, project.projectName);
  assert.equal(state.saved, path.join(directory, `${project.projectCleanName}.zip`));
  assert.equal(await fs.readFile(state.saved, 'utf8'), 'test ZIP contents');
  assert.equal(state.startDate, project.startDate);
  assert.equal(state.endDate, project.endDate);
  assert.equal(state.generateClicks, 0);
  assert.equal(state.zipClicks, 1);
  assert.ok(state.checkboxes.every(({ checked }) => checked));
  assert.deepEqual(state.downloadedPaths, [newPath]);
  assert.equal(state.polls, 3);
  assert.ok(logs.some(({ context }) => context?.pageType === 'form' && context.exportType === 'first-time'));
  assert.ok(logs.some(({ context }) => context?.pageType === 'table' && context.exportType === 'first-time'));
  assert.ok(logs.some(({ context }) => context?.checkboxCount === includeNames.length));
  const clickLog = logs.findIndex(({ message }) => message.includes('Clicking Download'));
  const saveStartedLog = logs.findIndex(({ message }) => message.startsWith('ZIP download started'));
  const savedLog = logs.findIndex(({ message }) => message === 'As-built ZIP saved');
  assert.ok(clickLog >= 0 && saveStartedLog > clickLog && savedLog > saveStartedLog);
  assert.equal(logs[saveStartedLog].context?.destination, state.saved);

  state.searched = '';
  state.saved = '';
  const disabled = await exportProject(page, { ...project, enabled: false, projectCleanName: 'Disabled' }, root);
  assert.equal(disabled.status, 'SKIPPED');
  assert.equal(state.searched, '');
  assert.equal(state.saved, '');
  assert.equal(state.zipClicks, 1);
  assert.deepEqual(await fs.readdir(root), [project.projectCleanName]);
});

test('opens the exact project name among similar search results regardless of row order', async (t) => {
  const similar = 'ZZ CNU910-128725.00 - Hawkins Co. SR70, Slope Stabilization';
  for (const titles of [['cnu910', similar], [similar, 'cnu910']]) {
    await t.test(titles.join(' / '), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, {
        projectName: 'cnu910',
        projectRows: titles.map((title) => ({ title, text: `${title} 0 workspaces Create a workspace` })),
      });
      assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
      assert.deepEqual(state.openedProjectTitles, ['cnu910']);
      assert.equal(state.zipClicks, 1);
    });
  }
});

test('matches literal project names containing punctuation and quotes', async (t) => {
  const projectName = 'Project [A] + (B).* "quoted" \\ C?';
  const { root, page, project, state } = await createFixture(t, {
    projectName,
    projectRows: [
      { title: `${projectName} extension`, text: projectName },
      { title: projectName, text: `${projectName} Address 0 workspaces` },
    ],
  });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.deepEqual(state.openedProjectTitles, [projectName]);
});

test('preserves the CSV project name through search and exact selection, including surrounding whitespace', async (t) => {
  const baseName = '129769.00 Greene Count Bridge Repair ove Lick Creek';
  for (const projectName of [`${baseName} `, ` ${baseName}`, `\t ${baseName} \n`]) {
    await t.test(JSON.stringify(projectName), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, {
        projectName,
        projectRows: [
          { title: baseName, text: baseName },
          { title: `${projectName} Annex`, text: `${projectName} Annex` },
          { title: projectName, text: `${projectName} 0 workspaces` },
        ],
      });
      const inputFile = path.join(root, 'projects.csv');
      await fs.writeFile(inputFile, 'project_uid,project_name,project_clean_name,enabled\n'
        + `${project.projectUid},"${projectName}",${project.projectCleanName},true\n`);
      const [csvProject] = await readProjects(inputFile);
      assert.equal(csvProject.projectName, projectName);
      assert.equal((await exportProject(page, csvProject, root)).status, 'SUCCESS');
      assert.equal(state.searched, projectName);
      assert.deepEqual(state.openedProjectTitles, [projectName]);
      assert.equal(state.zipClicks, 1);
    });
  }
});

test('names differing in surrounding whitespace are distinct project names', async (t) => {
  const { root, page, project, state } = await createFixture(t, {
    projectName: 'cnu910',
    projectRows: [
      { title: 'cnu910', text: 'cnu910' },
      { title: ' cnu910 ', text: 'cnu910' },
    ],
  });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.deepEqual(state.openedProjectTitles, ['cnu910']);
  assert.equal(state.zipClicks, 1);
});

test('duplicate exact project names including their whitespace fail without selecting a row', async (t) => {
  const { root, page, project, state } = await createFixture(t, {
    projectName: ' cnu910 ',
    projectRows: [
      { title: ' cnu910 ', text: 'cnu910 First Address' },
      { title: ' cnu910 ', text: 'cnu910 Second Address' },
    ],
  });
  const result = await exportProject(page, project, root);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message ?? '', /Multiple project rows have the exact name " cnu910 ".*matchingCount: 2/);
  assert.deepEqual(state.openedProjectTitles, []);
  assert.equal(state.zipClicks, 0);
});

test('any whitespace difference prevents an exact project-name match', async (t) => {
  for (const title of ['Bridge Repair ', ' Bridge Repair', 'Bridge  Repair', 'Bridge\tRepair', 'Bridge Repair\n']) {
    await t.test(JSON.stringify(title), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, {
        projectName: 'Bridge Repair',
        projectRows: [{ title, text: title }],
      });
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      assert.deepEqual(state.openedProjectTitles, []);
      assert.equal(state.zipClicks, 0);
    });
  }
});

test('missing exact names fail without clicking a partial name, address, or row lacking a title', async (t) => {
  for (const projectRows of [
    [],
    [{ title: 'ZZ CNU910-128725.00', text: 'ZZ CNU910-128725.00' }],
    [{ title: 'Another Project', text: 'Another Project cnu910 Address' }],
    [{ title: 'CNU910', text: 'CNU910' }],
    [{ text: 'cnu910' }],
  ]) {
    await t.test(JSON.stringify(projectRows), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, { projectName: 'cnu910', projectRows });
      const result = await exportProject(page, project, root);
      assert.equal(result.status, 'FAILED');
      assert.match(result.message ?? '', /No project row with exact name "cnu910" became visible within 30 seconds/);
      assert.equal(state.matchChecks, 1);
      assert.deepEqual(state.openedProjectTitles, []);
      assert.equal(state.zipClicks, 0);
      assert.equal(state.saved, '');
    });
  }
});

test('duplicate exact project names fail without clicking either row and allow the next project to succeed', async (t) => {
  const projectRows = [
    { title: 'cnu910', text: 'cnu910 First Address' },
    { title: 'ZZ CNU910-128725.00', text: 'ZZ CNU910-128725.00' },
    { title: 'cnu910', text: 'cnu910 Second Address' },
  ];
  const { root, page, project, state } = await createFixture(t, { projectName: 'cnu910', projectRows });
  const result = await exportProject(page, project, root);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message ?? '', /Multiple project rows have the exact name "cnu910".*matchingCount: 2/);
  assert.deepEqual(state.openedProjectTitles, []);
  assert.equal(state.zipClicks, 0);
  assert.equal(state.saved, '');

  assert.equal((await exportProject(page, { ...project, projectName: 'ZZ CNU910-128725.00' }, root)).status, 'SUCCESS');
  assert.deepEqual(state.openedProjectTitles, ['ZZ CNU910-128725.00']);
  assert.equal(state.navigations.length, 2);
});

test('recurring export generates a fresh build, fills the form, and ignores the old completed top row', async (t) => {
  const { root, page, project, state, logs, newPath } = await createFixture(t, { recurring: true });
  const result = await exportProject(page, project, root);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(state.generateClicks, 1);
  assert.equal(state.zipClicks, 1);
  assert.equal(state.startDate, project.startDate);
  assert.equal(state.endDate, project.endDate);
  assert.ok(state.checkboxes.every(({ checked }) => checked));
  assert.deepEqual(state.downloadedPaths, [newPath]);
  assert.equal(state.polls, 3);
  assert.ok(logs.some(({ context }) => context?.pageType === 'form' && context.exportType === 'recurring'));
  assert.equal(logs.filter(({ context }) => context?.pageType === 'table' && context.exportType === 'recurring').length, 2);
  assert.ok(logs.some(({ message }) => message.includes('existing builds will not be downloaded')));
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

test('blank dates preserve platform defaults and all present checkboxes are included', async (t) => {
  const checkboxNames = [...includeNames, 'inc_additional_option'];
  const { root, page, project, state, logs } = await createFixture(t, {
    recurring: true, blankDates: true, checkboxNames,
  });
  assert.equal((await exportProject(page, project, root)).status, 'SUCCESS');
  assert.equal(state.startDate, '2020-01-01');
  assert.equal(state.endDate, '2030-12-31');
  assert.ok(state.checkboxes.every(({ checked }) => checked));
  assert.deepEqual(logs.find(({ context }) => context?.checkboxCount)?.context?.checkedOptions, checkboxNames);
});

test('missing or uncheckable include options fail before requesting or downloading a build', async (t) => {
  for (const options of [{ checkboxNames: [] }, { uncheckedOption: 'inc_conformed' }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { root, page, project, state } = await createFixture(subtest, options);
      const result = await exportProject(page, project, root);
      assert.equal(result.status, 'FAILED');
      assert.match(result.message ?? '', /checkbox/);
      assert.equal(state.zipClicks, 0);
      assert.deepEqual(state.downloadedPaths, []);
      assert.equal(state.saved, '');
    });
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

test('reuses the initial projects page while retaining search readiness and settle checks', async (t) => {
  const { root, page, project, state } = await createFixture(t, { initialUrl: `${URLS.projects}/?sort=name` });
  const disabled = await exportProject(page, { ...project, enabled: false }, root, { reuseProjectsPage: true });
  assert.equal(disabled.status, 'SKIPPED');
  assert.equal((await exportProject(page, project, root, { reuseProjectsPage: true })).status, 'SUCCESS');
  assert.equal(state.navigations.length, 0);
  assert.equal(state.searchReadyChecks, 1);
  assert.equal(state.matchChecks, 1);
  assert.ok(state.waits.includes(TIMEOUTS.projectsPageSettleMs));
});

test('navigates to projects if initial page reuse is requested from a different page', async (t) => {
  const { root, page, project, state } = await createFixture(t, { initialUrl: `${URLS.projects}/another-project` });
  assert.equal((await exportProject(page, project, root, { reuseProjectsPage: true })).status, 'SUCCESS');
  assert.deepEqual(state.navigations, [{ url: URLS.projects, timeout: TIMEOUTS.projectsNavigationMs }]);
});

test('a failed or missing project returns a result and the next attempt navigates and succeeds', async (t) => {
  for (const options of [{ navigationFailures: 1 }, { searchReadyFailures: 1 }, { projectMatchFailures: 1 }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { root, page, project, state, logs } = await createFixture(subtest, options);
      const first = await exportProject(page, project, root);
      assert.equal(first.status, 'FAILED');
      assert.equal(state.saved, '');
      assert.ok(logs.some(({ message }) => message.includes('failed') || message.includes('not found')));
      const next = await exportProject(page, project, root);
      assert.equal(next.status, 'SUCCESS');
      assert.equal(state.navigations.length, 2);
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
      assert.equal((await exportProject(page, project, root)).status, 'FAILED');
      subtest.mock.timers.tick(80 * 60_000);
      assert.equal(logs.some(({ message }) => message.startsWith('ZIP transfer or saving still in progress')), false);
      assert.equal(logs.some(({ message }) => message === 'As-built ZIP saved'), false);
    });
  }
});
