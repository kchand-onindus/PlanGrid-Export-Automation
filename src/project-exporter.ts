import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { timeouts } from './config.js';
import { logError, logger } from './logger.js';
import { PROJECT_SELECTORS } from '../utils/constants.js';
import type { Project, ProjectResult } from './types.js';

function safeFolderName(project: Project): string {
  const source = project.projectName.trim() || 'unknown-project';
  const cleaned = source
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const folderName = cleaned || 'unknown-project';

  // Avoid Windows-reserved folder names if the configured download directory is shared.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(folderName)
    ? `_${folderName}`
    : folderName;
}

async function selectProject(page: Page, project: Project): Promise<boolean> {
  const searchTerm = project.projectName;
  const searchInput = page.locator(PROJECT_SELECTORS.searchInput);

  logger.info('Searching for project', { searchTerm });
  await searchInput.fill(searchTerm);

  const rows = page.locator(PROJECT_SELECTORS.projectRows);
  try {
    await rows.first().waitFor({ state: 'visible', timeout: timeouts.actionMs });
  } catch {
    logger.warn('Project match not found', {
      projectName: project.projectName,
      searchTerm,
      reason: 'No project rows became visible after searching',
    });
    return false;
  }

  const matchingRows = rows.filter({ hasText: searchTerm });
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
    logger.warn('Multiple project rows matched; selecting the first exact search result', {
      searchTerm,
      matchingCount,
    });
  }

  logger.info('Opening matching project', { searchTerm, matchingCount });
  await matchingRows.first().click();
  await page.waitForLoadState('domcontentloaded');
  return true;
}

async function waitForAsBuiltDownload(page: Page, project: Project, downloadDirectory: string): Promise<string> {
  const row = page.locator(PROJECT_SELECTORS.asBuiltRows).first();
  await row.waitFor({ state: 'visible', timeout: timeouts.actionMs });

  let lastProgress = '';
  logger.info('Waiting for As-built export to reach 100%; no time limit is applied', {
    projectNumber: project.projectNumber,
    pollIntervalMs: timeouts.progressPollMs,
  });

  while (!page.isClosed()) {
    const progress = (await row.locator(PROJECT_SELECTORS.progress).innerText().catch(() => '')).trim();
    const status = (await row.locator(PROJECT_SELECTORS.status).innerText().catch(() => '')).trim();
    const downloadLink = row.locator(PROJECT_SELECTORS.downloadLink);
    const downloadVisible = await downloadLink.isVisible().catch(() => false);

    if (progress !== lastProgress) {
      logger.info('As-built export status', {
        projectNumber: project.projectNumber,
        progress,
        status,
        downloadVisible,
      });
      lastProgress = progress;
    }

    if (progress === '100%' && downloadVisible) {
      logger.success('As-built export is ready for download', {
        projectNumber: project.projectNumber,
        progress,
      });

      const downloadPromise = page.waitForEvent('download');
      await downloadLink.click();
      const download = await downloadPromise;
      const filename = download.suggestedFilename() || `${safeFolderName(project)}.zip`;
      const destination = path.join(downloadDirectory, filename);
      await download.saveAs(destination);
      return destination;
    }

    await page.waitForTimeout(timeouts.progressPollMs);
  }

  throw new Error('As-built export monitoring stopped because the page was closed before download became available');
}

export async function exportProject(
  page: Page,
  project: Project,
  downloadRoot: string,
): Promise<ProjectResult> {
  const startedAt = Date.now();

  if (!project.enabled) {
    logger.info('Skipping disabled project', {
      projectNumber: project.projectNumber,
      projectName: project.projectName,
    });
    return { project, status: 'SKIPPED', message: 'Project is disabled', durationMs: 0 };
  }

  const downloadDirectory = path.join(downloadRoot, safeFolderName(project));

  try {
    await fs.mkdir(downloadDirectory, { recursive: true });
    logger.debug('Download directory ready', {
      projectNumber: project.projectNumber,
      downloadDirectory,
    });

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
    const firstTimeExport = await startDate.isVisible().catch(() => false);

    if (firstTimeExport) {
      logger.info('First-time As-built export form detected; setting date range', {
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
      logger.info('Selecting Zip File export');
      await page.locator(PROJECT_SELECTORS.zipOption).click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    } else {
      logger.info('Existing As-built export page detected; skipping date form');
    }

    const savedFile = await waitForAsBuiltDownload(page, project, downloadDirectory);
    logger.success('As-built ZIP saved', { projectNumber: project.projectNumber, savedFile });
    return {
      project,
      status: 'SUCCESS',
      message: 'As-built ZIP downloaded successfully',
      downloadDirectory,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    logError(`Project ${project.projectNumber} failed`, error, {
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
