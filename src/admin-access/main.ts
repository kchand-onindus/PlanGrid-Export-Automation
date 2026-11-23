import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { TIMEOUTS, URLS } from '../../utils/constants.js';
import { waitForAuthenticatedProjects } from '../auth.js';
import { connectToExistingChrome } from '../chrome-session.js';
import { paths } from '../config.js';
import { createLogger, type Logger, type LogContext } from '../logger.js';
import { readAdminAccessProjects, type AdminAccessProject } from './csv.js';
import { grantAdminAccess } from './grant.js';
import { findExactProjectUserRoles } from './team-search.js';

type ProjectStatus = 'SUCCESS' | 'SKIPPED' | 'IN_PROGRESS' | 'ERROR';
type ProjectResult = { status: ProjectStatus; reason: string };

async function openPage(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUTS.projectsNavigationMs,
  }).catch(() => {
    throw new Error('Browser navigation failed or timed out.');
  });
  if (!response?.ok()) {
    throw new Error(`Page navigation returned HTTP ${response?.status() ?? 'unknown'}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error.';
}

async function processProject(
  page: Page, project: AdminAccessProject, logger: Logger, details: LogContext,
): Promise<ProjectResult> {
  logger.info('Opening project Team page.', details);
  const target = project.enterpriseProjectUrl;
  await openPage(page, target.href);
  const current = new URL(page.url());
  if (current.origin !== target.origin || current.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) {
    throw new Error('Navigation left the requested project Team page.');
  }

  logger.info('Searching the project Team table for the configured email.', details);
  const roles = await findExactProjectUserRoles(page, project.userEmailId);
  if (page.url() !== current.href) throw new Error('Navigation left the requested project Team page during search.');
  if (roles.length > 1) throw new Error(`Team search returned ${roles.length} exact email matches.`);
  if (roles.length === 1) {
    if (roles[0] === 'Admin') return { status: 'SKIPPED', reason: 'The user already has the Admin role.' };
    throw new Error(`The user is already a project member with the ${roles[0]} role. An existing member requires a role change.`);
  }

  logger.info('No exact email match in the Team table. Preparing an Admin invitation.', details);
  const result = await grantAdminAccess(page, project.userEmailId, logger, details);
  if (result === 'IN_PROGRESS') {
    return { status: 'IN_PROGRESS', reason: 'PlanGrid displayed a blank confirmation message.' };
  }

  const grantedRoles = await findExactProjectUserRoles(page, project.userEmailId, true);
  if (grantedRoles.length !== 1 || grantedRoles[0] !== 'Admin') {
    throw new Error('The Team table did not show exactly one matching user with the Admin role after submission.');
  }
  return { status: 'SUCCESS', reason: 'The Team table verified the new Admin role.' };
}

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('grant-admin-access');
  const inputFile = path.join(paths.projectRoot, 'input', 'grant_admin_access_projects.csv');
  let browser: Browser | undefined;
  let selected: AdminAccessProject[] = [];
  let disabled = 0;
  const outcomes: (ProjectResult & { projectName: string; csvRow: number })[] = [];

  try {
    if (process.argv.length > 2) throw new Error('Usage: npm run grant:admin');

    const projects = await readAdminAccessProjects(inputFile);
    selected = projects.filter((project) => project.enabled);
    disabled = projects.length - selected.length;
    logger.general('Starting PlanGrid admin access workflow', {
      inputFile, logFile: logFilePath, enabled: selected.length, disabled,
    });
    if (!selected.length) {
      logger.info('No enabled projects to open.');
      return;
    }

    logger.info('Connecting to existing Chrome. Accept the Allow prompt if Chrome asks.');
    browser = await connectToExistingChrome();
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome did not expose an existing browser context.');
    const page = await context.newPage();
    await page.bringToFront();
    logger.info('Opening the PlanGrid projects landing page.');
    await openPage(page, URLS.projects);
    await waitForAuthenticatedProjects(page, TIMEOUTS.navigationMs).catch(() => {
      throw new Error('PlanGrid session verification failed. Sign in through Chrome and wait for the projects search box.');
    });
    logger.success('Verified the authenticated PlanGrid projects page.');

    for (const [index, project] of selected.entries()) {
      const details = {
        projectId: project.projectId, projectName: project.projectName,
        csvRow: project.rowNumber, position: `${index + 1}/${selected.length}`,
      };
      let result: ProjectResult;
      try {
        result = await processProject(page, project, logger, details);
      } catch (error) {
        result = { status: 'ERROR', reason: errorMessage(error) };
        process.exitCode = 1;
      }
      outcomes.push({ projectName: project.projectName, csvRow: project.rowNumber, ...result });
      const level = result.status === 'ERROR' ? 'error' : result.status === 'SUCCESS' ? 'success' : 'info';
      logger[level](`${result.status} — ${result.reason}`, details);
    }

    logger.info('Returning to the PlanGrid organization Users page.');
    try {
      await openPage(page, URLS.planGridOrganizationUsers);
      const destination = new URL(URLS.planGridOrganizationUsers);
      const current = new URL(page.url());
      if (current.origin !== destination.origin || current.pathname.replace(/\/$/, '') !== destination.pathname) {
        throw new Error('Navigation left the organization Users page.');
      }
    } catch (error) {
      logger.error('Could not return to the PlanGrid organization Users page.', { error: errorMessage(error) });
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error('Admin access workflow stopped.', { error: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
        logger.info('Disconnected from Chrome.');
      } catch {
        logger.error('Could not cleanly disconnect from Chrome.');
        process.exitCode = 1;
      }
    }
    const counts = { SUCCESS: 0, SKIPPED: 0, IN_PROGRESS: 0, ERROR: 0 };
    for (const outcome of outcomes) counts[outcome.status] += 1;
    logger.general('Admin access run summary', {
      outcomes, enabled: selected.length, disabled, notAttempted: selected.length - outcomes.length, ...counts,
    });
  }
}

void main();
