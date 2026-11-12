import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright';
import { verifyAttachedChromeSession } from './auth.js';
import { logger, type LogContext } from './logger.js';
import { PROJECT_SELECTORS, TIMEOUTS, URLS } from '../utils/constants.js';

function fixture(t: TestContext, options: {
  initialUrl?: string;
  redirectToProjects?: boolean;
  missingSearch?: boolean;
  leaveProjectsAfterSearch?: boolean;
  onSearchWait?: () => Promise<void>;
} = {}) {
  const state = {
    url: options.initialUrl ?? URLS.projects,
    searchChecks: 0,
    urlChecks: 0,
    pauseCalls: 0,
  };
  const logs: { message: string; context?: LogContext }[] = [];
  for (const level of ['info', 'warn', 'success'] as const) {
    t.mock.method(logger, level, (message: string, context?: LogContext) => logs.push({ message, context }));
  }
  const page = {
    url: () => state.url,
    pause: async () => {
      state.pauseCalls += 1;
      assert.fail('Chrome verification must not pause for Inspector');
    },
    waitForTimeout: async () => assert.fail('Authentication readiness must use elements rather than a fixed sleep'),
    waitForURL: async (predicate: (url: URL) => boolean, { timeout }: { timeout: number }) => {
      state.urlChecks += 1;
      assert.equal(timeout, TIMEOUTS.navigationMs);
      if (options.redirectToProjects) state.url = URLS.projects;
      if (!predicate(new URL(state.url))) throw new Error('Authentication URL did not become ready');
    },
    locator: (selector: string) => {
      assert.equal(selector, PROJECT_SELECTORS.searchInput);
      return {
        waitFor: async ({ state: target, timeout }: { state: string; timeout: number }) => {
          assert.equal(target, 'visible');
          assert.equal(timeout, TIMEOUTS.navigationMs);
          state.searchChecks += 1;
          await options.onSearchWait?.();
          if (options.missingSearch) throw new Error('Projects search box did not become visible');
          if (options.leaveProjectsAfterSearch) state.url = URLS.autodeskSignIn;
        },
      };
    },
  } as unknown as Page;
  return { page, state, logs };
}

test('attached Chrome verifies the projects URL and visible search automatically without an Inspector pause', async (t) => {
  for (const initialUrl of [URLS.projects, `${URLS.projects}/?sort=name`]) {
    await t.test(initialUrl, async (subtest) => {
      const { page, state, logs } = fixture(subtest, { initialUrl });
      assert.equal(await verifyAttachedChromeSession(page), 'ACTIVE_SESSION');
      assert.equal(state.searchChecks, 1);
      assert.equal(state.urlChecks, 0);
      assert.equal(state.pauseCalls, 0);
      assert.ok(logs.some(({ message }) => message.startsWith('Authenticated PlanGrid projects page verified')));
    });
  }
});

test('attached Chrome waits for delayed search readiness before returning an authenticated result', async (t) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const { page, state } = fixture(t, { onSearchWait: () => ready });
  let completed = false;
  const checking = verifyAttachedChromeSession(page).then((result) => { completed = true; return result; });
  assert.equal(state.searchChecks, 1);
  assert.equal(completed, false);
  assert.equal(state.pauseCalls, 0);
  release();
  assert.equal(await checking, 'ACTIVE_SESSION');
});

test('attached Chrome waits for a projects redirect before checking the search field', async (t) => {
  const { page, state } = fixture(t, { initialUrl: URLS.autodeskSignIn, redirectToProjects: true });
  assert.equal(await verifyAttachedChromeSession(page), 'ACTIVE_SESSION');
  assert.equal(state.urlChecks, 1);
  assert.equal(state.searchChecks, 1);
  assert.equal(state.pauseCalls, 0);
});

test('expired authentication, missing search, and navigation away fail without an Inspector pause', async (t) => {
  for (const options of [
    { initialUrl: URLS.autodeskSignIn },
    { missingSearch: true },
    { leaveProjectsAfterSearch: true },
  ]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { page, state, logs } = fixture(subtest, options);
      await assert.rejects(verifyAttachedChromeSession(page), /Sign in to PlanGrid.*run the command again\. No exports were started\./);
      assert.equal(state.pauseCalls, 0);
      assert.equal(logs.some(({ message }) => message.startsWith('Authenticated PlanGrid projects page verified')), false);
    });
  }
});
