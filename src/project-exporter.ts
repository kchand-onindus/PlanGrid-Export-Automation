import path from 'node:path';
import type { Page } from 'playwright';
import { timeouts } from './config.js';
import { logError, logger, type LogContext } from './logger.js';
import { ExportError } from './export-errors.js';
import { saveExportDownload } from './export-download.js';
import { PROJECT_SELECTORS, URLS } from '../utils/constants.js';
import type { ExportErrorType, Project, ProjectResult } from './types.js';

async function selectProject(page: Page, project: Project): Promise<void> {
  const searchTerm = project.projectName;
  const searchInput = page.locator(PROJECT_SELECTORS.searchInput);

  logger.info('Searching for project', { searchTerm });
  await searchInput.fill(searchTerm, { timeout: timeouts.projectsReadyMs });

  const rows = page.locator(PROJECT_SELECTORS.projectRows);
  // Each project link's title contains only its full name, without addresses or workspace text.
  const matchingRows = rows.and(page.getByTitle(searchTerm, { exact: true }));
  try {
    await matchingRows.first().waitFor({ state: 'visible', timeout: timeouts.projectsReadyMs });
  } catch (error) {
    throw new ExportError('PROJECT_NOT_FOUND',
      `No project row with exact name "${searchTerm}" became visible within ${timeouts.projectsReadyMs / 1000} seconds`,
      { cause: error },
    );
  }

  const matchingCount = await matchingRows.count();
  if (matchingCount === 0) {
    throw new ExportError('PROJECT_NOT_FOUND', `No project row with exact name "${searchTerm}" was found after searching`);
  }
  if (matchingCount > 1) {
    throw new ExportError('PROJECT_AMBIGUOUS',
      `Multiple project rows have the exact name "${searchTerm}"; refusing to select an ambiguous result `
        + `(matchingCount: ${matchingCount})`,
    );
  }

  logger.info('Opening project with exact name match', { searchTerm, matchingCount });
  // Retain strict clicking so a newly appearing duplicate cannot silently select the first row.
  await matchingRows.click({ timeout: timeouts.projectsReadyMs });
  await page.waitForLoadState('domcontentloaded');
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
  if (!href) throw new ExportError('BUILD_IDENTITY_ERROR', 'An As-built row has no build identifier; refusing to use an uncertain build');
  const scope = new URL(projectUrl);
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(href, scope);
  } catch {
    throw new ExportError('BUILD_IDENTITY_ERROR', 'An As-built row has an unreadable build identifier');
  }
  const projectPath = /^\/projects\/([^/]+)(?:\/|$)/.exec(scope.pathname);
  const buildPath = /^\/projects\/([^/]+)\/asbuilts\/([a-zA-Z0-9-]+)\/direct\/?$/.exec(downloadUrl.pathname);
  if (scope.origin !== new URL(URLS.projects).origin || downloadUrl.origin !== scope.origin
      || !projectPath || !buildPath || buildPath[1] !== projectPath[1]) {
    throw new ExportError('BUILD_IDENTITY_ERROR', 'An As-built row has an invalid or mismatched build identifier');
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
    if (paths.length !== 1) throw new ExportError('BUILD_IDENTITY_ERROR', 'Cannot reliably identify every As-built row; expected one build link per row');
    const id = readBuildId(paths[0], projectUrl);
    if (ids.has(id)) throw new ExportError('BUILD_IDENTITY_ERROR', `Duplicate As-built ID ${id}; refusing an ambiguous table`);
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
      throw new ExportError('BUILD_IDENTITY_ERROR', `Ambiguous As-built request: ${newIds.length} new build IDs appeared (${newIds.join(', ')}); no download attempted`);
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
    projectName: project.projectName,
    buildId,
    pollIntervalMs: timeouts.progressPollMs,
  });

  while (!page.isClosed()) {
    await row.waitFor({ state: 'visible', timeout: timeouts.actionMs });
    if (await row.count() !== 1) throw new ExportError('BUILD_IDENTITY_ERROR', `Cannot uniquely locate tracked As-built ${buildId}`);
    // innerText excludes the hidden Processing span retained in completed rows.
    const status = (await row.locator(PROJECT_SELECTORS.status).innerText()).trim();
    const terminalStatus = /^(failed|error|cancelled|canceled)[.!]?$/i.exec(status)?.[1].toLowerCase();
    if (terminalStatus) {
      const errorType = terminalStatus === 'failed' ? 'BUILD_FAILED'
        : terminalStatus === 'error' ? 'BUILD_ERROR' : 'BUILD_CANCELLED';
      throw new ExportError(errorType, `Tracked As-built ${buildId} reported terminal status "${status}"`);
    }
    const progress = (await row.locator(PROJECT_SELECTORS.progress).innerText()).trim();
    const downloadLink = row.locator(PROJECT_SELECTORS.downloadLink);
    if (await downloadLink.count() !== 1
        || readBuildId(await downloadLink.getAttribute('href'), projectUrl) !== buildId) {
      throw new ExportError('BUILD_IDENTITY_ERROR', `Cannot verify the download link for tracked As-built ${buildId}`);
    }
    const downloadVisible = await downloadLink.isVisible();
    const state = JSON.stringify([progress, status, downloadVisible]);

    if (state !== lastState) {
      logger.info('As-built export status', {
        projectUid: project.projectUid,
        projectName: project.projectName,
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
        projectName: project.projectName,
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
        await saveExportDownload(download, destination, downloadContext);
        return destination;
      } catch (error) {
        if (error instanceof ExportError) throw error;
        throw new ExportError('DOWNLOAD_ERROR', error instanceof Error ? error.message : String(error), { cause: error });
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
  let errorType: ExportErrorType = 'PROJECTS_PAGE_ERROR';

  try {
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

    errorType = 'PROJECT_SELECTION_ERROR';
    await selectProject(page, project);

    errorType = 'EXPORT_FORM_ERROR';
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
      errorType = 'BUILD_IDENTITY_ERROR';
      previousBuildIds = await readBuildIds(page, projectUrl);
      errorType = 'EXPORT_FORM_ERROR';
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

    errorType = 'BUILD_IDENTITY_ERROR';
    const buildId = await identifyNewBuild(page, project, projectUrl, previousBuildIds);
    errorType = 'BUILD_MONITORING_ERROR';
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
    if (error instanceof ExportError) errorType = error.errorType;
    logError(`Project ${project.projectUid || project.projectName} failed`, error, {
      errorType,
      projectUid: project.projectUid,
      projectName: project.projectName,
      startDate: project.startDate,
      endDate: project.endDate,
      downloadDirectory,
    });
    return {
      project,
      status: 'FAILED',
      errorType,
      message: error instanceof Error ? error.message : String(error),
      downloadDirectory,
      durationMs: Date.now() - startedAt,
    };
  }
}
