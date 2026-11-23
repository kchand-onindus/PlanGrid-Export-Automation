import type { Page } from 'playwright';
import { PROJECT_USER_SELECTORS, TIMEOUTS } from '../../utils/constants.js';
import type { LogContext, Logger } from '../logger.js';

type GrantResult = 'CONFIRMED' | 'IN_PROGRESS';

export async function grantAdminAccess(
  page: Page, userEmailId: string, logger: Logger, details: LogContext,
): Promise<GrantResult> {
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(userEmailId)) {
    throw new Error('user_email_id must contain a single email address.');
  }

  const selectors = PROJECT_USER_SELECTORS;
  const options = { timeout: TIMEOUTS.projectsReadyMs };
  const search = page.locator(selectors.searchInput);
  const modal = page.locator(selectors.addModal);
  const emailField = modal.locator(selectors.multiEmailField);
  const emailInput = emailField.locator(selectors.inviteEmailInput);
  const recipient = emailField.getByText(userEmailId, { exact: true });
  const admin = modal.locator(selectors.adminRadio);
  const submit = modal.locator(selectors.submitInvite);
  const teamUrl = page.url();

  let step = 'clear the Team search';
  try {
    await search.clear(options);
    if (await search.inputValue(options)) throw new Error();
    step = 'open the Add Team Members dialog';
    await page.locator(selectors.addTeamMembers).click(options);

    step = 'enter and verify the recipient email';
    await emailInput.fill(userEmailId, options);
    await emailInput.press('Enter', options);
    await recipient.waitFor({ state: 'visible', ...options });
    if (await emailInput.inputValue(options)) throw new Error();

    step = 'select and verify the Admin role';
    await modal.locator(`label:has(> ${selectors.adminRadio})`).click(options);
    step = 'verify the project, recipient and Admin role before submission';
    if (!(await admin.isChecked(options)) || await emailInput.inputValue(options)
        || !(await recipient.isVisible()) || page.url() !== teamUrl) throw new Error();

    step = 'verify the invitation submission and read its confirmation';
    logger.info('Submitting the Admin invitation.', details);
    await submit.click(options);
    const confirmation = page.locator(selectors.confirmationModal);
    const done = confirmation.locator(selectors.confirmationDone);
    await done.waitFor({ state: 'visible', ...options });
    const message = (await confirmation.locator(selectors.confirmationBody).innerText(options)).trim();
    const result = message ? 'CONFIRMED' : 'IN_PROGRESS';
    if (message) logger.info('PlanGrid invitation confirmation.', { ...details, confirmation: message });

    step = 'dismiss the confirmation dialog';
    await done.click(options);
    await confirmation.waitFor({ state: 'hidden', ...options });
    return result;
  } catch {
    throw new Error(`Could not ${step}.`);
  }
}
