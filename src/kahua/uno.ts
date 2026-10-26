import type { Locator, Page } from 'playwright';
import { KAHUA_SELECTORS } from '../../utils/constants.js';

export async function enableKahuaAccessibility(page: Page): Promise<void> {
  // Kahua can take several minutes to render. A zero timeout deliberately
  // leaves this wait under the user's control instead of guessing a load time.
  await page.locator(KAHUA_SELECTORS.canvas).waitFor({ state: 'visible', timeout: 0 });

  const semanticRoot = page.locator(KAHUA_SELECTORS.semanticsRoot);
  const semanticControls = semanticRoot.locator('[role], input, button');
  if (await semanticControls.count()) return;

  const enable = page.locator(KAHUA_SELECTORS.enableAccessibility);
  if (!await enable.count()) {
    // Uno can create the activation element only after its first keyboard focus.
    await page.keyboard.press('Tab');
  }
  if (await enable.count()) {
    await enable.evaluate((element) => (element as HTMLElement).click());
  }

  await semanticControls.first().waitFor({ state: 'attached', timeout: 0 });
}

export async function activateKahuaControl(control: Locator): Promise<void> {
  await control.waitFor({ state: 'visible', timeout: 0 });
  if (await control.count() !== 1) {
    throw new Error('Kahua control selector must resolve to exactly one semantic element');
  }
  if (!await control.isEnabled()) throw new Error('Kahua control is disabled');
  // The semantic overlay intentionally rejects pointer events. Calling the
  // exact HTML button's activation method invokes the accessibility action
  // without relying on coordinates that can briefly lag behind canvas layout.
  await control.evaluate((element) => (element as HTMLButtonElement).click());
}

export async function activateLargestKahuaControl(page: Page, controls: Locator): Promise<void> {
  await controls.first().waitFor({ state: 'attached', timeout: 0 });
  const focused = await controls.evaluateAll((elements) => {
    const candidates = elements
      .filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement)
      .filter((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.hidden)
      .map((button) => {
        const bounds = button.getBoundingClientRect();
        return { button, area: bounds.width * bounds.height };
      })
      .sort((a, b) => b.area - a.area);
    const target = candidates[0];
    if (!target || target.area <= 0) return false;
    target.button.focus();
    return true;
  });
  if (!focused) throw new Error('Kahua did not expose a usable enabled dialog button');
  await page.keyboard.press('Enter');
}

export async function waitForAuthenticatedKahua(
  page: Page,
  onNoticeAccepted?: () => void,
): Promise<{ acceptedNotice: boolean }> {
  let acceptedNotice = false;

  while (true) {
    const outcomeHandle = await page.waitForFunction(({ selectors, noticeAlreadyAccepted }) => {
      const enable = document.querySelector(selectors.enable);
      if (enable instanceof HTMLElement && !enable.dataset.automationActivated) {
        enable.dataset.automationActivated = 'true';
        enable.click();
      }

      const root = document.querySelector(selectors.root);
      const authenticated = selectors.authenticated.every((selector) => root?.querySelector(selector));
      if (authenticated) return 'authenticated';

      const messageBox = root?.querySelector(selectors.messageBox);
      if (messageBox) {
        if (root?.querySelector(selectors.expectedNotice)) {
          return noticeAlreadyAccepted ? false : 'expected-notice';
        }
        // Uno can create the dialog shell before its semantic message nodes.
        // Leave an unknown or incomplete dialog untouched while it materializes.
        return false;
      }

      const statusText = [...document.querySelectorAll(`${selectors.root} [role="status"]`)]
        .map((status) => `${status.getAttribute('aria-label') ?? ''} ${status.textContent ?? ''}`.trim())
        .filter(Boolean)
        .join(' ');
      if (/invalid|incorrect|failed|error|unable|locked|expired|try again/i.test(statusText)) {
        return 'login-error';
      }
      return false;
    }, {
      selectors: {
        enable: KAHUA_SELECTORS.enableAccessibility,
        root: KAHUA_SELECTORS.semanticsRoot,
        authenticated: [KAHUA_SELECTORS.tasksNavigation, KAHUA_SELECTORS.messagesNavigation],
        messageBox: KAHUA_SELECTORS.messageBox,
        expectedNotice: KAHUA_SELECTORS.devProductionNotice,
      },
      noticeAlreadyAccepted: acceptedNotice,
    }, { timeout: 0 });

    const outcome = await outcomeHandle.jsonValue();
    await outcomeHandle.dispose();

    if (outcome === 'authenticated') {
      const root = page.locator(KAHUA_SELECTORS.semanticsRoot);
      await root.locator(KAHUA_SELECTORS.tasksNavigation).waitFor({ state: 'attached', timeout: 0 });
      await root.locator(KAHUA_SELECTORS.messagesNavigation).waitFor({ state: 'attached', timeout: 0 });
      return { acceptedNotice };
    }
    if (outcome === 'expected-notice') {
      const root = page.locator(KAHUA_SELECTORS.semanticsRoot);
      await activateLargestKahuaControl(page, root.locator(KAHUA_SELECTORS.okButtons));
      acceptedNotice = true;
      onNoticeAccepted?.();
      continue;
    }
    throw new Error('Kahua reported that the configured credentials were not accepted');
  }
}
