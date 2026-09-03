import type { Page } from 'playwright';
import { browserOptions } from '../playwright.config.js';
import { getCredentials } from '../utils/env.js';
import {
  AUTODESK_SELECTORS,
  LOGIN_SELECTORS,
  LOGOUT_SELECTORS,
  TIMEOUTS,
  URLS,
} from '../utils/constants.js';
import { logError, logger } from './logger.js';

export type LoginResult =
  | 'ACTIVE_SESSION'
  | 'AUTODESK_HANDOFF'
  | 'PASSWORD_FLOW';

async function handleAutodeskLogin(page: Page, email: string, password: string): Promise<LoginResult> {
  const emailInput = page.locator(AUTODESK_SELECTORS.emailInput);

  logger.info('Preparing Autodesk email step', { selector: AUTODESK_SELECTORS.emailInput });
  await emailInput.fill('');
  await emailInput.fill(email);

  logger.info('Submitting Autodesk email', { selector: AUTODESK_SELECTORS.nextButton });
  await page.locator(AUTODESK_SELECTORS.nextButton).click();

  logger.debug('Waiting for Autodesk password page or PlanGrid landing page');
  const passwordReady = page
    .locator(AUTODESK_SELECTORS.passwordInput)
    .waitFor({ state: 'visible', timeout: TIMEOUTS.actionMs })
    .then(() => 'password' as const)
    .catch(() => null);
  const projectsLanding = page
    .waitForURL(
      (url) =>
        url.hostname === new URL(URLS.projects).hostname &&
        url.pathname.startsWith(new URL(URLS.projects).pathname),
      { timeout: TIMEOUTS.actionMs },
    )
    .then(() => 'landing' as const)
    .catch(() => null);

  const nextStep = await Promise.race([passwordReady, projectsLanding]);

  if (nextStep === 'landing') {
    logger.success('Autodesk skipped password and returned to the PlanGrid landing page', {
      currentUrl: page.url(),
    });
    return 'AUTODESK_HANDOFF';
  }

  if (nextStep === 'password') {
    logger.info('Filling Autodesk password');
    await page.locator(AUTODESK_SELECTORS.passwordInput).fill(password);

    logger.info('Clicking Autodesk Sign in', { selector: AUTODESK_SELECTORS.signInButton });
    await page.locator(AUTODESK_SELECTORS.signInButton).click();

    logger.debug('Waiting for direct PlanGrid landing page or OTP/verification');
    const returnedToProjects = page
      .waitForURL(
        (url) =>
          url.hostname === new URL(URLS.projects).hostname &&
          url.pathname.startsWith(new URL(URLS.projects).pathname),
        { timeout: TIMEOUTS.actionMs },
      )
      .then(() => true)
      .catch(() => false);

    if (await returnedToProjects) {
      logger.success('Autodesk sign-in returned directly to the PlanGrid landing page', {
        currentUrl: page.url(),
      });
      return 'AUTODESK_HANDOFF';
    }

    logger.warn('OTP or additional Autodesk verification is expected', {
      currentUrl: page.url(),
      instruction: 'Enter and submit the OTP manually, then resume Playwright.',
    });
    await page.pause();
    logger.info('Autodesk OTP/verification pause resumed');
    return 'AUTODESK_HANDOFF';
  }

  const error = new Error(`Autodesk password field and PlanGrid landing page did not appear at ${page.url()}`);
  logError('Autodesk login destination was not detected', error, {
    passwordSelector: AUTODESK_SELECTORS.passwordInput,
    currentUrl: page.url(),
    timeoutMs: TIMEOUTS.actionMs,
  });
  throw error;
}

/**
 * Platform login placeholder.
 * The exact selectors and OTP behavior will be added once the platform is inspected.
 */
export async function login(page: Page): Promise<LoginResult> {
  const credentials = getCredentials();

  if (!(await page.locator(LOGIN_SELECTORS.emailInput).isVisible().catch(() => false))) {
    logger.info('Login form is not visible; assuming an existing session');
    return 'ACTIVE_SESSION';
  }

  logger.info('Credentials loaded from .env', {
    email: credentials.email,
    passwordLoaded: Boolean(credentials.password),
  });

  logger.info('Filling email address');
  await page.locator(LOGIN_SELECTORS.emailInput).fill(credentials.email);

  logger.info('Submitting email address');
  await page
    .getByRole('button', { name: LOGIN_SELECTORS.nextButtonText, exact: true })
    .click();

  logger.debug('Waiting for password page or Autodesk handoff');
  const passwordReady = page
    .locator(LOGIN_SELECTORS.passwordInput)
    .waitFor({ state: 'visible', timeout: TIMEOUTS.actionMs })
    .then(() => 'password' as const)
    .catch(() => null);
  const autodeskHandoff = page
    .waitForURL(
      (url) => url.hostname === new URL(URLS.autodeskSignIn).hostname,
      { timeout: TIMEOUTS.actionMs },
    )
    .then(() => 'autodesk' as const)
    .catch(() => null);

  const nextStep = await Promise.race([passwordReady, autodeskHandoff]);

  if (nextStep === 'autodesk') {
    logger.info('Autodesk sign-in page detected; skipping Autodesk interaction', {
      currentUrl: page.url(),
      nextStep: 'Complete Autodesk login manually, then resume Playwright',
    });

    if (browserOptions.headless) {
      logger.error('Cannot complete the Autodesk handoff in headless mode');
      throw new Error('Autodesk login requires visible manual interaction; use `npm run export`.');
    }

    return handleAutodeskLogin(page, credentials.email, credentials.password);
  }

  if (nextStep !== 'password') {
    const error = new Error(`Password field did not appear at ${page.url()}`);
    logError('Password field did not appear after submitting email', error, {
      selector: LOGIN_SELECTORS.passwordInput,
      timeoutMs: TIMEOUTS.actionMs,
      currentUrl: page.url(),
    });
    throw error;
  }
  logger.success('Password field is visible');

  logger.info('Filling password');
  await page.locator(LOGIN_SELECTORS.passwordInput).fill(credentials.password);

  logger.info('Submitting password');
  await page
    .getByRole('button', { name: LOGIN_SELECTORS.loginButtonText, exact: true })
    .click();

  if (browserOptions.headless) {
    logger.error('Cannot pause for OTP in headless mode');
    throw new Error('OTP is not automated yet; use `npm run export` for visible verification.');
  }

  logger.warn('Waiting for OTP or manual verification', {
    instruction: 'Complete OTP/verification in the visible browser, then resume Playwright.',
  });
  await page.pause();
  logger.info('OTP/manual verification pause resumed');
  return 'PASSWORD_FLOW';
}

export async function logout(page: Page): Promise<boolean> {
  try {
    logger.info('Returning to the project landing page before logout');
    if (!page.url().startsWith(URLS.projects)) {
      await page.goto(URLS.projects, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigationMs });
    }

    logger.info('Opening account menu', {
      accountName: LOGOUT_SELECTORS.accountName,
      selector: LOGOUT_SELECTORS.accountNameElement,
    });
    await page
      .locator(LOGOUT_SELECTORS.accountNameElement)
      .filter({ hasText: LOGOUT_SELECTORS.accountName })
      .first()
      .click();

    logger.info('Clicking Log Out', { selector: LOGOUT_SELECTORS.logoutLink });
    await page
      .locator(LOGOUT_SELECTORS.logoutLink)
      .filter({ hasText: LOGOUT_SELECTORS.logoutText })
      .click();

    await page.waitForURL(
      (url) => url.pathname === '/login' || url.pathname.startsWith('/login/'),
      { timeout: TIMEOUTS.navigationMs },
    );
    await page.locator(LOGOUT_SELECTORS.loginEmailInput).waitFor({
      state: 'visible',
      timeout: TIMEOUTS.actionMs,
    });

    logger.success('Logout verified', { currentUrl: page.url() });
    return true;
  } catch (error) {
    logError('Logout could not be completed automatically', error, {
      currentUrl: page.url(),
      accountName: LOGOUT_SELECTORS.accountName,
      logoutSelector: LOGOUT_SELECTORS.logoutLink,
    });
    return false;
  }
}
