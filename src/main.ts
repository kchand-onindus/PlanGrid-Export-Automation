import { chromium, type Browser, type Page } from 'playwright';
import { browserOptions } from '../playwright.config.js';
import { paths, platformUrl } from './config.js';
import { URLS } from '../utils/constants.js';
import { login, logout } from './auth.js';
import { readProjects } from './csv.js';
import { logError, logger, logFilePath, wasErrorLogged } from './logger.js';
import { exportProject } from './project-exporter.js';

async function main(): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let canAttemptLogout = false;
  let logoutAttempted = false;

  try {
    logger.general('Starting PlanGrid export automation', {
      platformUrl,
      inputFile: paths.inputFile,
      downloadRoot: paths.downloadRoot,
      logFile: logFilePath,
      headless: browserOptions.headless,
    });

    const projects = await readProjects(paths.inputFile);
    logger.info('Projects loaded from CSV', {
      totalProjects: projects.length,
      enabledProjects: projects.filter((project) => project.enabled).length,
    });

    logger.debug('Launching browser');
    browser = await chromium.launch(browserOptions);
    page = await browser.newPage({ acceptDownloads: true });

    logger.info('Opening platform', { platformUrl });
    await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    logger.success('Platform page loaded', { url: page.url(), title: await page.title() });

    logger.info('Starting login flow');
    const loginResult = await login(page);
    logger.success('Login stage completed', { result: loginResult });

    if (page.url() !== URLS.projects) {
      logger.info('Opening project landing page', { projectsUrl: URLS.projects });
      await page.goto(URLS.projects, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    canAttemptLogout = true;

    const results = [];
    for (const [index, project] of projects.entries()) {
      logger.info('Processing project', {
        projectNumber: project.projectNumber,
        projectName: project.projectName,
        position: index + 1,
        total: projects.length,
      });
      const result = await exportProject(page, project, paths.downloadRoot);
      results.push(result);

      const resultLog = {
        projectNumber: project.projectNumber,
        projectName: project.projectName,
        status: result.status,
        durationMs: result.durationMs,
        message: result.message,
        downloadDirectory: result.downloadDirectory,
      };

      if (result.status === 'SUCCESS') {
        logger.success('Project export completed', resultLog);
      } else if (result.status === 'SKIPPED') {
        logger.warn('Project export skipped', resultLog);
      } else {
        logger.error('Project export failed', resultLog);
      }
    }

    logger.info('All projects have been processed; starting logout');
    logoutAttempted = true;
    await logout(page);

    const successful = results.filter((result) => result.status === 'SUCCESS').length;
    const skipped = results.filter((result) => result.status === 'SKIPPED').length;
    const failed = results.filter((result) => result.status === 'FAILED').length;

    logger.general('Export run completed', {
      total: results.length,
      success: successful,
      skipped,
      failed,
    });
  } catch (error) {
    // Log the actual failure before the browser cleanup starts.
    if (!wasErrorLogged(error)) {
      logError('Automation failed', error);
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      if (page && canAttemptLogout && !logoutAttempted) {
        logger.warn('Attempting logout during cleanup after an earlier automation failure');
        logoutAttempted = true;
        await logout(page);
      }

      if (page && !browserOptions.headless) {
        logger.warn('Session has ended; browser is about to close', {
          instruction: 'Log out manually and complete any final verification, then resume Playwright.',
        });

        try {
          await page.pause();
          logger.info('Final verification pause resumed');
        } catch (error) {
          logError('Final verification pause failed; continuing with browser close', error);
        }
      } else if (browserOptions.headless) {
        logger.debug('Headless session has ended; skipping final manual logout pause');
      }

      logger.debug('Closing browser');
      await browser.close();
      logger.info('Browser closed');
    }
  }
}

void main();
