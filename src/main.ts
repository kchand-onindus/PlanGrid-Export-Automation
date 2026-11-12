import { chromium, type Browser, type Page } from 'playwright';
import { browserOptions } from '../playwright.config.js';
import { connectChrome, paths, platformUrl, timeouts } from './config.js';
import { URLS } from '../utils/constants.js';
import { login, logout, verifyAttachedChromeSession, type LoginResult } from './auth.js';
import { connectToExistingChrome } from './chrome-session.js';
import { readProjectInput } from './csv.js';
import { logError, logger, logFilePath, wasErrorLogged } from './logger.js';
import { exportProject } from './project-exporter.js';
import { logExportSummary, logRunReport } from './export-summary.js';
import { parseExportOptions, selectExportProjects } from './export-selection.js';
import { ExportRun, readRetrySource, resolveRetryReportPath } from './export-run.js';
import type { ProjectResult } from './types.js';

const exportMode = connectChrome ? 'chrome' : browserOptions.headless ? 'headless' : 'visible';

async function main(): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let canAttemptLogout = false;
  let logoutAttempted = false;
  let run: ExportRun | undefined;

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

    const options = parseExportOptions(process.argv.slice(2), process.env);
    const input = await readProjectInput(paths.inputFile);
    const projects = input.projects;
    logger.info('Projects loaded from CSV', {
      totalProjects: projects.length,
      enabledProjects: projects.filter((project) => project.enabled).length,
    });

    const retry = options.runType === 'retry'
      ? await readRetrySource(resolveRetryReportPath(options.reportPath, paths)) : undefined;
    const selection = selectExportProjects(projects, options, retry);
    logger.info('Export project selection ready; CSV unchanged', {
      runType: selection.runType,
      skip: selection.skip,
      limit: selection.limit ?? (selection.runType === 'batch' ? 'all remaining' : undefined),
      selectedProjects: selection.entries.length,
      csvTotal: selection.csvTotal,
      enabledTotal: selection.enabledTotal,
      firstEnabledPosition: selection.entries[0]?.enabledPosition,
      lastEnabledPosition: selection.entries.at(-1)?.enabledPosition,
      parentRunId: selection.parentRunId,
    });
    if (retry?.unfinishedProjects) {
      logger.warn('Retry source has unfinished projects; only explicit FAILED outcomes are selected', {
        unfinishedProjects: retry.unfinishedProjects,
        instruction: 'Review PENDING, IN_PROGRESS, or INTERRUPTED records separately; they are not automatically retried.',
      });
    }
    logger.info('Keep run reports closed while exports are running', {
      instruction: 'Keep failed-projects.csv and results.json closed in Excel, editors, and preview panes until the command exits. Use the terminal or log file for live progress.',
    });
    run = await ExportRun.create({
      runsRoot: paths.runsRoot, selection, inputFile: paths.inputFile, logFile: logFilePath,
      csvHeaders: input.headers,
    });
    logger.general('Timestamped export run created before browser startup', {
      runId: run.report.runId,
      startedAtUtc: run.report.startedAt,
      startedAtIst: new Date(run.report.startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      resultsFile: run.reportPath,
    });
    if (selection.entries.length === 0) {
      await run.finish();
      logger.info('No projects selected; browser startup skipped');
      logExportSummary([]);
      logRunReport(run, exportMode);
      return;
    }

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

    const results: ProjectResult[] = [];
    let reuseProjectsPage = true;
    for (const [index, { project, csvPosition, enabledPosition }] of selection.entries.entries()) {
      logger.info('Processing project', {
        projectUid: project.projectUid,
        projectName: project.projectName,
        projectCleanName: project.projectCleanName,
        position: index + 1,
        total: selection.entries.length,
        csvPosition,
        csvTotal: projects.length,
        enabledPosition,
        runId: run.report.runId,
      });
      const result = await run.execute(index, () => exportProject(page!, project, paths.downloadRoot, { reuseProjectsPage }));
      reuseProjectsPage = false;
      results.push(result);

      const resultLog = {
        projectUid: project.projectUid,
        projectName: project.projectName,
        projectCleanName: project.projectCleanName,
        status: result.status,
        errorType: result.errorType,
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
      if (result.status !== 'SUCCESS' && index + 1 < selection.entries.length) {
        logger.warn('Continuing with the next selected project after this project was skipped or failed', {
          projectName: project.projectName,
          status: result.status,
          nextPosition: index + 2,
          total: selection.entries.length,
          instruction: 'The next enabled project will open the projects landing page and repeat readiness checks.',
        });
      }
    }

    await run.finish();
    if (results.some((result) => result.status === 'FAILED')) process.exitCode = 1;
    logExportSummary(results);
    logRunReport(run, exportMode);

    if (connectChrome) {
      logger.info('All selected projects have been processed; preserving the authenticated session');
    } else {
      logger.info('All selected projects have been processed; starting logout');
      logoutAttempted = true;
      await logout(page);
    }
  } catch (error) {
    // Log the actual failure before the browser cleanup starts.
    if (!wasErrorLogged(error)) {
      logError('Automation failed', error);
    }
    process.exitCode = 1;
    if (run) {
      if (run.report.status === 'RUNNING' || !run.persistence.json || !run.persistence.csv) {
        try {
          await run.finish(true);
        } catch (reportError) {
          logError('Could not finalize the run report; execution stopped to preserve tracking', reportError, {
            resultsFile: run.reportPath,
            failedProjectsFile: run.failedCsvPath,
          });
        }
      }
      // Always show known outcomes, even if a locked report also prevents finalization.
      logRunReport(run, exportMode, true);
    }
  } finally {
    if (browser) {
      if (!connectChrome && page && canAttemptLogout && !logoutAttempted) {
        logger.warn('Attempting logout during cleanup after an earlier automation failure');
        logoutAttempted = true;
        await logout(page);
      }

      if (connectChrome) {
        logger.info('Chrome session finished; disconnecting without an Inspector pause. Chrome remains open and signed in.');
      } else if (page && !browserOptions.headless) {
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

      logger.debug(connectChrome ? 'Disconnecting from Chrome' : 'Closing browser');
      // For a CDP-connected browser, close() disconnects without closing Chrome.
      await browser.close();
      logger.info(connectChrome ? 'Disconnected; Chrome remains open' : 'Browser closed');
    }
  }
}

void main();
