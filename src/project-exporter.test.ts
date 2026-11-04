import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { exportProject } from './project-exporter.js';
import { logger } from './logger.js';
import { PROJECT_SELECTORS } from '../utils/constants.js';
import type { Project } from './types.js';

test('searches by original name and saves folder and ZIP using the exact clean name', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-export-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const level of ['info', 'debug', 'success'] as const) t.mock.method(logger, level, () => {});
  const project: Project = {
    projectUid: 'uid-1', projectName: 'Original / PlanGrid Project',
    projectCleanName: 'Custom Project-01', enabled: true,
  };
  let searched = '';
  let saved = '';
  // Simulate an existing, completed export; no browser or server is involved.
  function locator(selector: string) {
    return {
      first: () => locator(selector),
      filter: ({ hasText }: { hasText: string }) => {
        assert.equal(hasText, project.projectName);
        return locator(selector);
      },
      locator,
      waitFor: async () => {},
      fill: async (value: string) => { searched = value; },
      count: async () => 1,
      click: async () => {},
      isVisible: async () => selector !== PROJECT_SELECTORS.startDateInput,
      innerText: async () => selector === PROJECT_SELECTORS.progress ? '100%' : 'Ready',
    };
  }
  const page = {
    locator,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    waitForEvent: async () => ({
      suggestedFilename: () => { throw new Error('Platform filename must not be used'); },
      saveAs: async (destination: string) => {
        saved = destination;
        await fs.writeFile(destination, 'test ZIP contents');
      },
    }),
  } as unknown as Page;
  const result = await exportProject(page, project, root);
  const directory = path.join(root, project.projectCleanName);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.downloadDirectory, directory);
  assert.equal(searched, project.projectName);
  assert.equal(saved, path.join(directory, `${project.projectCleanName}.zip`));
  assert.equal(await fs.readFile(saved, 'utf8'), 'test ZIP contents');

  searched = '';
  saved = '';
  const disabled = await exportProject(page, { ...project, enabled: false, projectCleanName: 'Disabled' }, root);
  assert.equal(disabled.status, 'SKIPPED');
  assert.equal(searched, '');
  assert.equal(saved, '');
  assert.deepEqual(await fs.readdir(root), [project.projectCleanName]);
});
