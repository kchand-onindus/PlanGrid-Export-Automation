import type { Page } from 'playwright';
import { browserOptions } from '../playwright.config.js';
import { getCredentials } from '../utils/env.js';
import { LOGIN_SELECTORS, TIMEOUTS, URLS } from '../utils/constants.js';
import { logError, logger } from './logger.js';

/**
 * Platform login placeholder.
 * The exact selectors and OTP behavior will be added once the platform is inspected.
 */
export async function login(page: Page): Promise<void> {
  const credentials = getCredentials();

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
      nextStep: 'Continue with the separate Autodesk flow later',
    });
    return;
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
}
