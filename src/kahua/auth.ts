import type { Page } from 'playwright';
import { getKahuaCredentials, getKahuaUsername } from '../../utils/env.js';
import { KAHUA_SELECTORS } from '../../utils/constants.js';
import type { Logger } from '../logger.js';
import { activateKahuaControl, enableKahuaAccessibility, waitForAuthenticatedKahua } from './uno.js';

export async function submitKahuaUsername(page: Page, logger: Logger): Promise<void> {
  const usernameValue = getKahuaUsername();

  logger.info('Waiting for the Kahua login screen; this wait has no fixed timeout');
  await enableKahuaAccessibility(page);

  const semanticRoot = page.locator(KAHUA_SELECTORS.semanticsRoot);
  const username = semanticRoot.locator(KAHUA_SELECTORS.usernameInput);
  await username.waitFor({ state: 'visible', timeout: 0 });

  logger.info('Filling the Kahua email address from KAHUA_USERNAME');
  await username.fill(usernameValue);
  if (await username.inputValue() !== usernameValue) {
    throw new Error('Kahua email address field did not retain the configured value');
  }

  logger.info('Activating the Kahua Next button');
  await activateKahuaControl(semanticRoot.locator(KAHUA_SELECTORS.nextButton));
  logger.success('Kahua email step submitted');
}

export async function submitKahuaPassword(page: Page, logger: Logger): Promise<void> {
  const { password: passwordValue } = getKahuaCredentials();
  const semanticRoot = page.locator(KAHUA_SELECTORS.semanticsRoot);
  const password = semanticRoot.locator(KAHUA_SELECTORS.passwordInput);

  logger.info('Waiting for the Kahua password field; this wait has no fixed timeout');
  await password.waitFor({ state: 'visible', timeout: 0 });

  logger.info('Filling the Kahua password from KAHUA_PASSWORD');
  await password.fill(passwordValue);
  if (await password.inputValue() !== passwordValue) {
    throw new Error('Kahua password field did not retain the configured value');
  }

  logger.info('Activating the final Kahua Sign In button');
  await activateKahuaControl(semanticRoot.locator(KAHUA_SELECTORS.nextButton));

  logger.info('Waiting for the DevProduction notice or authenticated landing controls; this wait has no fixed timeout');
  const { acceptedNotice } = await waitForAuthenticatedKahua(page, () => {
    logger.success('Expected DevProduction usage notice accepted with keyboard activation');
  });
  if (!acceptedNotice) logger.info('No DevProduction usage notice was shown');
  logger.success('Authenticated Kahua landing page verified', {
    markers: ['TasksNavigationItem', 'MessagesNavigationItem'],
  });
}
