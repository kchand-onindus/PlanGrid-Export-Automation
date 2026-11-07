import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { timeouts } from './config.js';
import { logError, logger, type LogContext } from './logger.js';
import { PROJECT_SELECTORS, URLS } from '../utils/constants.js';
import type { Project, ProjectResult } from './types.js';

async function selectProject(page: Page, project: Project): Promise<boolean> {
  const searchTerm = project.projectName;
  const searchInput = page.locator(PROJECT_SELECTORS.searchInput);

  logger.info('Searching for project', { searchTerm });
  await searchInput.fill(searchTerm, { timeout: timeouts.projectsReadyMs });

  const rows = page.locator(PROJECT_SELECTORS.projectRows);
  const matchingRows = rows.filter({ hasText: searchTerm });
  try {
    await matchingRows.first().waitFor({ state: 'visible', timeout: timeouts.projectsReadyMs });
  } catch {
    logger.warn('Project match not found', {
      projectName: project.projectName,
      searchTerm,
      reason: 'No matching project rows became visible after searching',
      waitTimeoutMs: timeouts.projectsReadyMs,
    });
    return false;
  }

  const matchingCount = await matchingRows.count();
  if (matchingCount === 0) {
    logger.warn('Project match not found', {
      projectName: project.projectName,
      searchTerm,
      reason: 'Visible project rows did not contain the project name',
    });
    return false;
  }
  if (matchingCount > 1) {
    throw new Error(
      `Multiple project rows matched project name "${searchTerm}"; refusing to select an ambiguous result `
        + `(matchingCount: ${matchingCount})`,
    );
  }

  logger.info('Opening matching project', { searchTerm, matchingCount });
  await matchingRows.first().click({ timeout: timeouts.projectsReadyMs });
  await page.waitForLoadState('domcontentloaded');
  return true;
}

function startDownloadStatusUpdates(context: LogContext): () => void {
  const startedAt = Date.now();
  let nextElapsedMs = timeouts.downloadStatusFirstMs;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;

  function schedule(): void {
    timer = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt;
      // Updates occur at 10, 20, 40, 80... elapsed minutes; cap gaps at one day.
      const nextGapMs = Math.min(nextElapsedMs, 24 * 60 * 60_000);
      nextElapsedMs = Math.max(nextElapsedMs, elapsedMs) + nextGapMs;
      logger.info('ZIP transfer or saving still in progress; waiting for completion', {
        ...context,
        elapsedMinutes: Number((elapsedMs / 60_000).toFixed(1)),
        nextUpdateInMinutes: Math.ceil((nextElapsedMs - elapsedMs) / 60_000),
      });
      if (!stopped) schedule();
    }, Math.max(0, nextElapsedMs - (Date.now() - startedAt)));
    timer.unref();
  }

  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function readBuildId(href: string | null, projectUrl: string): string {
  if (!href) throw new Error('An As-built row has no build identifier; refusing to use an uncertain build');
  const scope = new URL(projectUrl);
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(href, scope);
  } catch {
    throw new Error('An As-built row has an unreadable build identifier');
  }
  const projectPath = /^\/projects\/([^/]+)(?:\/|$)/.exec(scope.pathname);
  const buildPath = /^\/projects\/([^/]+)\/asbuilts\/([a-zA-Z0-9-]+)\/direct\/?$/.exec(downloadUrl.pathname);
  if (scope.origin !== new URL(URLS.projects).origin || downloadUrl.origin !== scope.origin
      || !projectPath || !buildPath || buildPath[1] !== projectPath[1]) {
    throw new Error('An As-built row has an invalid or mismatched build identifier');
  }
  return buildPath[2];
}

async function readBuildIds(page: Page, projectUrl: string): Promise<Set<string>> {
  // Read hidden links too: processing rows already expose their build IDs.
  const pathsByRow = await page.locator(PROJECT_SELECTORS.asBuiltRows).evaluateAll(
    (rows, selector) => rows.map((row) => Array.from(
      row.querySelectorAll(selector), (link) => link.getAttribute('href'),
    )),
    PROJECT_SELECTORS.downloadLink,
  );
  const ids = new Set<string>();
  for (const paths of pathsByRow) {
    if (paths.length !== 1) throw new Error('Cannot reliably identify every As-built row; expected one build link per row');
    const id = readBuildId(paths[0], projectUrl);
    if (ids.has(id)) throw new Error(`Duplicate As-built ID ${id}; refusing an ambiguous table`);
    ids.add(id);
  }
  return ids;
}

async function identifyNewBuild(
  page: Page, project: Project, projectUrl: string, previousBuildIds: ReadonlySet<string>,
): Promise<string> {
  let waitingLogged = false;
  while (!page.isClosed()) {
    await page.locator(PROJECT_SELECTORS.asBuiltList).waitFor({ state: 'visible', timeout: timeouts.actionMs });
    const currentIds = await readBuildIds(page, projectUrl);
    const newIds = [...currentIds].filter((id) => !previousBuildIds.has(id));
    if (newIds.length > 1) {
      throw new Error(`Ambiguous As-built request: ${newIds.length} new build IDs appeared (${newIds.join(', ')}); no download attempted`);
    }
    if (newIds.length === 1) {
      logger.info('New As-built identified; tracking its build ID', {
        projectName: project.projectName, buildId: newIds[0], previousBuildCount: previousBuildIds.size,
      });
      return newIds[0];
    }
    if (!waitingLogged) {
      logger.info('Waiting for the newly requested As-built to appear; existing builds will not be downloaded', {
        projectName: project.projectName,
      });
      waitingLogged = true;
    }
    await page.waitForTimeout(timeouts.progressPollMs);
  }
  throw new Error('As-built identification stopped because the page was closed before a new build appeared');
}

async function waitForAsBuiltDownload(
  page: Page,
  project: Project,
  downloadDirectory: string,
  buildId: string,
  projectUrl: string,
): Promise<string> {
  const row = page.locator(PROJECT_SELECTORS.asBuiltRowById(buildId));

  let lastState = '';
  let lastUnknownStatus: string | undefined;
  logger.info('Waiting for As-built export to reach 100%; no time limit is applied', {
    projectUid: project.projectUid,
    buildId,
    pollIntervalMs: timeouts.progressPollMs,
  });

  while (!page.isClosed()) {
    await row.waitFor({ state: 'visible', timeout: timeouts.actionMs });
    if (await row.count() !== 1) throw new Error(`Cannot uniquely locate tracked As-built ${buildId}`);
    // innerText excludes the hidden Processing span retained in completed rows.
    const status = (await row.locator(PROJECT_SELECTORS.status).innerText()).trim();
    if (/^(failed|error|cancelled|canceled)[.!]?$/i.test(status)) {
      throw new Error(`Tracked As-built ${buildId} reported terminal status "${status}"`);
    }
    const progress = (await row.locator(PROJECT_SELECTORS.progress).innerText()).trim();
    const downloadLink = row.locator(PROJECT_SELECTORS.downloadLink);
    if (await downloadLink.count() !== 1
        || readBuildId(await downloadLink.getAttribute('href'), projectUrl) !== buildId) {
      throw new Error(`Cannot verify the download link for tracked As-built ${buildId}`);
    }
    const downloadVisible = await downloadLink.isVisible();
    const state = JSON.stringify([progress, status, downloadVisible]);

    if (state !== lastState) {
      logger.info('As-built export status', {
        projectUid: project.projectUid,
        buildId,
        progress,
        status,
        downloadVisible,
      });
      lastState = state;
    }

    if (progress === '100%' && downloadVisible) {
      logger.success('As-built export is ready for download', {
        projectUid: project.projectUid,
        buildId,
        progress,
      });

      const filename = `${project.projectCleanName}.zip`;
      const destination = path.join(downloadDirectory, filename);
      const downloadContext = { projectName: project.projectName, buildId, destination };
      logger.info('Clicking Download for the new As-built ZIP', downloadContext);
      const stopStatusUpdates = startDownloadStatusUpdates(downloadContext);
      try {
        // Register the listener before clicking and handle either failure together.
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          downloadLink.click(),
        ]);
        logger.info('ZIP download started; saving to destination and waiting for completion', downloadContext);
        await download.saveAs(destination);
        return destination;
      } finally {
        stopStatusUpdates();
      }
    }

    if (!/^(processing[.\s…]*|queued|download)$/i.test(status) && status !== lastUnknownStatus) {
      logger.warn('Unrecognized As-built status; continuing to wait for the tracked build', {
        projectName: project.projectName, buildId, progress, status,
      });
      lastUnknownStatus = status;
    }
    await page.waitForTimeout(timeouts.progressPollMs);
  }

  throw new Error('As-built export monitoring stopped because the page was closed before download became available');
}

export async function exportProject(
  page: Page,
  project: Project,
  downloadRoot: string,
  options: { reuseProjectsPage?: boolean } = {},
): Promise<ProjectResult> {
  const startedAt = Date.now();

  if (!project.enabled) {
    logger.info('Skipping disabled project', {
      projectUid: project.projectUid,
      projectName: project.projectName,
    });
    return { project, status: 'SKIPPED', message: 'Project is disabled', durationMs: 0 };
  }

  const downloadDirectory = path.join(downloadRoot, project.projectCleanName);

  try {
    await fs.mkdir(downloadDirectory, { recursive: true });
    logger.debug('Download directory ready', {
      projectUid: project.projectUid,
      downloadDirectory,
    });

    const projectsUrl = new URL(URLS.projects);
    const currentUrl = new URL(page.url());
    const canReuseProjectsPage = options.reuseProjectsPage
      && currentUrl.origin === projectsUrl.origin
      && (currentUrl.pathname === projectsUrl.pathname || currentUrl.pathname === `${projectsUrl.pathname}/`);
    if (canReuseProjectsPage) {
      logger.info('Reusing verified projects landing page; checking readiness before searching');
      await page.waitForLoadState('domcontentloaded', { timeout: timeouts.projectsNavigationMs });
    } else {
      logger.info('Opening projects landing page before searching', { projectsUrl: URLS.projects });
      await page.goto(URLS.projects, {
        waitUntil: 'domcontentloaded',
        timeout: timeouts.projectsNavigationMs,
      });
    }
    await page.locator(PROJECT_SELECTORS.searchInput).waitFor({
      state: 'visible',
      timeout: timeouts.projectsReadyMs,
    });
    logger.info('Waiting for projects list to finish loading', {
      settleMs: timeouts.projectsPageSettleMs,
    });
    await page.waitForTimeout(timeouts.projectsPageSettleMs);
    logger.info('Projects landing page ready for project search', { projectName: project.projectName });

    const projectSelected = await selectProject(page, project);
    if (!projectSelected) {
      return {
        project,
        status: 'SKIPPED',
        message: 'Project name was not found on the landing page',
        downloadDirectory,
        durationMs: Date.now() - startedAt,
      };
    }

    logger.info('Opening project Settings');
    await page.locator(PROJECT_SELECTORS.settingsLink).click();
    await page.waitForLoadState('domcontentloaded');

    logger.info('Opening Download and Export As-Builts');
    await page.locator(PROJECT_SELECTORS.asBuiltLink).click();
    await page.waitForLoadState('domcontentloaded');

    const startDate = page.locator(PROJECT_SELECTORS.startDateInput);
    await page.locator(PROJECT_SELECTORS.asBuiltPage).first().waitFor({
      state: 'visible',
      timeout: timeouts.actionMs,
    });
    const firstTimeExport = await startDate.isVisible().catch(() => false);
    const exportType = firstTimeExport ? 'first-time' : 'recurring';
    const projectUrl = page.url();
    let previousBuildIds = new Set<string>();

    if (!firstTimeExport) {
      logger.info('As-built table page detected; requesting a fresh build', {
        projectName: project.projectName,
        pageType: 'table',
        exportType,
      });
      previousBuildIds = await readBuildIds(page, projectUrl);
      logger.info('Existing As-built IDs captured; generating immediately without waiting for older builds', {
        projectName: project.projectName, previousBuildCount: previousBuildIds.size,
      });
      await page.locator(PROJECT_SELECTORS.generateAsBuilt).click();
    }

    await startDate.waitFor({ state: 'visible', timeout: timeouts.actionMs });
    logger.info('As-built form page ready; setting date range', {
      projectName: project.projectName,
      pageType: 'form',
      exportType,
      startDate: project.startDate,
      endDate: project.endDate,
    });
    if (project.startDate) {
      await startDate.fill(project.startDate);
    } else {
      logger.info('Start date is blank; leaving platform default unchanged');
    }
    if (project.endDate) {
      await page.locator(PROJECT_SELECTORS.endDateInput).fill(project.endDate);
    } else {
      logger.info('End date is blank; leaving platform default unchanged');
    }

    const checkboxes = page.locator(PROJECT_SELECTORS.includeCheckboxes);
    const checkboxCount = await checkboxes.count();
    if (checkboxCount === 0) {
      throw new Error('No As-built include checkboxes were found; refusing to request an incomplete export');
    }
    const checkedOptions: string[] = [];
    for (let index = 0; index < checkboxCount; index += 1) {
      const checkbox = checkboxes.nth(index);
      const name = await checkbox.getAttribute('name') ?? `checkbox ${index + 1}`;
      await checkbox.check();
      if (!await checkbox.isChecked()) {
        throw new Error(`As-built include checkbox "${name}" is not checked`);
      }
      checkedOptions.push(name);
    }
    logger.success('All As-built include checkboxes are checked', {
      projectName: project.projectName,
      exportType,
      checkboxCount,
      checkedOptions,
    });

    logger.info('Selecting Zip File to generate a fresh As-built', { exportType });
    await page.locator(PROJECT_SELECTORS.zipOption).click();
    await page.locator(PROJECT_SELECTORS.asBuiltList).waitFor({
      state: 'visible',
      timeout: timeouts.actionMs,
    });
    logger.info('As-built table page ready; identifying the newly requested build', {
      projectName: project.projectName,
      pageType: 'table',
      exportType,
    });

    const buildId = await identifyNewBuild(page, project, projectUrl, previousBuildIds);
    const savedFile = await waitForAsBuiltDownload(page, project, downloadDirectory, buildId, projectUrl);
    logger.success('As-built ZIP saved', { projectUid: project.projectUid, buildId, savedFile });
    return {
      project,
      status: 'SUCCESS',
      message: 'As-built ZIP downloaded successfully',
      downloadDirectory,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    logError(`Project ${project.projectUid || project.projectName} failed`, error, {
      projectName: project.projectName,
      startDate: project.startDate,
      endDate: project.endDate,
      downloadDirectory,
    });
    return {
      project,
      status: 'FAILED',
      message: error instanceof Error ? error.message : String(error),
      downloadDirectory,
      durationMs: Date.now() - startedAt,
    };
  }
}
