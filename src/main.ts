import { chromium, type Browser, type Page } from 'playwright';
import { browserOptions } from '../playwright.config.js';
import { connectChrome, paths, platformUrl, timeouts } from './config.js';
import { URLS } from '../utils/constants.js';
import { login, logout, verifyAttachedChromeSession, type LoginResult } from './auth.js';
import { connectToExistingChrome } from './chrome-session.js';
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
      connectChrome,
    });

    if (connectChrome && browserOptions.headless) {
      throw new Error('Chrome session mode requires a visible browser; use `npm run export:chrome`.');
    }

    const projects = await readProjects(paths.inputFile);
    logger.info('Projects loaded from CSV', {
      totalProjects: projects.length,
      enabledProjects: projects.filter((project) => project.enabled).length,
    });

    logger.debug(connectChrome ? 'Connecting to existing Chrome; accept the Allow prompt in Chrome if shown' : 'Launching browser');
    let loginResult: LoginResult;
    if (connectChrome) {
      browser = await connectToExistingChrome();
      const context = browser.contexts()[0];
      if (!context) throw new Error('Chrome did not expose an existing browser context.');

      // A new tab in the existing context shares its session without navigating the user's tabs.
      page = await context.newPage();
      await page.goto(URLS.projects, { waitUntil: 'domcontentloaded', timeout: timeouts.projectsNavigationMs });
      await page.bringToFront();
      loginResult = await verifyAttachedChromeSession(page);
    } else {
      browser = await chromium.launch(browserOptions);
      page = await browser.newPage({ acceptDownloads: true });

      logger.info('Opening platform', { platformUrl });
      await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      logger.success('Platform page loaded', { url: page.url(), title: await page.title() });

      logger.info('Starting login flow');
      loginResult = await login(page);
    }
    logger.success('Login stage completed', { result: loginResult });

    canAttemptLogout = true;

    const results = [];
    let reuseProjectsPage = true;
    for (const [index, project] of projects.entries()) {
      logger.info('Processing project', {
        projectUid: project.projectUid,
        projectName: project.projectName,
        projectCleanName: project.projectCleanName,
        position: index + 1,
        total: projects.length,
      });
      const result = await exportProject(page, project, paths.downloadRoot, { reuseProjectsPage });
      if (project.enabled) reuseProjectsPage = false;
      results.push(result);

      const resultLog = {
        projectUid: project.projectUid,
        projectName: project.projectName,
        projectCleanName: project.projectCleanName,
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
      if (project.enabled && result.status !== 'SUCCESS' && index + 1 < projects.length) {
        logger.warn('Continuing with the next CSV project after this project was skipped or failed', {
          projectName: project.projectName,
          status: result.status,
          nextPosition: index + 2,
          total: projects.length,
          instruction: 'The next enabled project will open the projects landing page and repeat readiness checks.',
        });
      }
    }

    if (connectChrome) {
      logger.info('All projects have been processed; preserving the authenticated session');
    } else {
      logger.info('All projects have been processed; starting logout');
      logoutAttempted = true;
      await logout(page);
    }

    const successful = results.filter((result) => result.status === 'SUCCESS').length;
    const skipped = results.filter((result) => result.status === 'SKIPPED').length;
    const failed = results.filter((result) => result.status === 'FAILED').length;
    if (failed > 0) process.exitCode = 1;

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
      if (!connectChrome && page && canAttemptLogout && !logoutAttempted) {
        logger.warn('Attempting logout during cleanup after an earlier automation failure');
        logoutAttempted = true;
        await logout(page);
      }

      if (page && !browserOptions.headless) {
        logger.warn(connectChrome ? 'Export session has ended; Chrome will remain open' : 'Session has ended; browser is about to close', {
          instruction: connectChrome
            ? 'Review the export results, then resume Playwright to disconnect. Chrome and its signed-in session will remain open.'
            : 'Log out manually and complete any final verification, then resume Playwright.',
        });

        try {
          await page.pause();
          logger.info('Final verification pause resumed');
        } catch (error) {
          logError(connectChrome
            ? 'Final verification pause failed; continuing with Chrome disconnect'
            : 'Final verification pause failed; continuing with browser close', error);
        }
      } else if (browserOptions.headless) {
        logger.debug('Headless session has ended; skipping final manual logout pause');
      }

      logger.debug(connectChrome ? 'Disconnecting from Chrome' : 'Closing browser');
      // For a CDP-connected browser, close() disconnects without closing Chrome.
      await browser.close();
      logger.info(connectChrome ? 'Disconnected; Chrome remains open' : 'Browser closed');
    }
  }
}

void main();
