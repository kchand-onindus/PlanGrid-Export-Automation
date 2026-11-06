import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import type { Logger } from '../logger.js';
import { prepareSync } from './prepare.js';
import type { OverwriteRequest } from './prepare.js';
import { confirmSyncOverwrite } from './confirmation.js';

const headers = 'project_uid,project_name,project_clean_name,enabled,start_date,end_date';
const quietLogger: Logger = { general() {}, info() {}, debug() {}, success() {}, warn() {}, error() {} };

async function fixture(t: TestContext, rows = 'uid-1,Original Project,Custom_name,true,,', existingDestination = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-preparation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'projects.csv');
  const downloads = path.join(root, 'custom downloads');
  const syncRoot = path.join(root, 'custom sync destination');
  const extraction = path.join(downloads, 'Custom_name/Custom_name');
  const destination = path.join(syncRoot, 'Custom_name');
  await fs.writeFile(input, `${headers}\n${rows}\n`);
  await fs.mkdir(extraction, { recursive: true });
  if (existingDestination) await fs.mkdir(destination, { recursive: true });
  return { root, input, downloads, syncRoot, extraction, destination };
}

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('copies Documents and Photos from a project wrapper with all nested contents and retains sources', async (t) => {
  const f = await fixture(t);
  const wrapper = path.join(f.extraction, 'Original Project ');
  await write(path.join(wrapper, 'Documents/contracts/a.txt'), 'contract');
  await write(path.join(wrapper, 'Documents/contracts/deep/b.txt'), 'nested document');
  await write(path.join(wrapper, 'Photos/2026/site.jpg'), 'photo');
  await write(path.join(wrapper, 'Drawings/A.pdf'), 'drawing must stay out of staging');
  await fs.mkdir(path.join(wrapper, 'Photos/empty'), { recursive: true });
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(result.downloadDirectory, f.destination);
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/contracts/a.txt'), 'utf8'), 'contract');
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/contracts/deep/b.txt'), 'utf8'), 'nested document');
  assert.equal(await fs.readFile(path.join(f.destination, 'Photos/2026/site.jpg'), 'utf8'), 'photo');
  assert.ok((await fs.stat(path.join(f.destination, 'Photos/empty'))).isDirectory());
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['Documents', 'Photos']);
  assert.equal(await fs.readFile(path.join(wrapper, 'Documents/contracts/a.txt'), 'utf8'), 'contract');
  assert.equal(await fs.readFile(path.join(wrapper, 'Drawings/A.pdf'), 'utf8'), 'drawing must stay out of staging');
});

test('copies either folder directly under the extraction parent, including empty folders', async (t) => {
  for (const name of ['Documents', 'Photos']) {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.extraction, name));
    const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(await fs.readdir(f.destination), [name]);
    assert.deepEqual(await fs.readdir(path.join(f.destination, name)), []);
  }
});

test('skips disabled projects and absent folders, reports missing extraction, and continues', async (t) => {
  const f = await fixture(t, [
    '1,Disabled,Disabled,false,,', '2,Missing,Missing,true,,',
    '3,No matching folders,Empty,true,,', '4,Good project,Custom_name,true,,',
  ].join('\n'));
  await fs.mkdir(path.join(f.downloads, 'Empty/Empty'), { recursive: true });
  await write(path.join(f.extraction, 'Documents/file.txt'), 'document');
  const results = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.deepEqual(results.map((result) => result.status), ['SKIPPED', 'FAILED', 'SKIPPED', 'SUCCESS']);
  assert.deepEqual(await fs.readdir(f.syncRoot), ['Custom_name']);
});

test('rejects ambiguous wrappers instead of merging their contents', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Project One/Documents/a.txt'), 'one');
  await write(path.join(f.extraction, 'Project Two/Photos/b.jpg'), 'two');
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Multiple project wrappers/);
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('preflights both folders before copying and preserves existing destination files on conflict', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/new.txt'), 'new document');
  await write(path.join(f.extraction, 'Photos/existing.jpg'), 'source photo');
  await write(path.join(f.destination, 'Photos/existing.jpg'), 'existing destination photo');
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /overwrite/);
  assert.equal(await fs.readFile(path.join(f.destination, 'Photos/existing.jpg'), 'utf8'), 'existing destination photo');
  assert.equal(await fs.readFile(path.join(f.extraction, 'Photos/existing.jpg'), 'utf8'), 'source photo');
  await assert.rejects(fs.stat(path.join(f.destination, 'Documents')), { code: 'ENOENT' });
});

test('asks once before any copying and overwrites approved files while preserving unrelated files', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/new.txt'), 'new document');
  await write(path.join(f.extraction, 'Documents/existing.txt'), 'updated document');
  await write(path.join(f.extraction, 'Photos/existing.jpg'), 'updated photo');
  await write(path.join(f.destination, 'Documents/existing.txt'), 'old document');
  await write(path.join(f.destination, 'Photos/existing.jpg'), 'old photo');
  await write(path.join(f.destination, 'Documents/unrelated.txt'), 'keep unrelated');
  let requests = 0;
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger, async (request) => {
    requests++;
    assert.equal(request.project.projectCleanName, 'Custom_name');
    assert.equal(request.destination, f.destination);
    assert.deepEqual(request.files.sort(), [
      path.join(f.destination, 'Documents/existing.txt'), path.join(f.destination, 'Photos/existing.jpg'),
    ]);
    assert.equal(await fs.readFile(path.join(f.destination, 'Documents/existing.txt'), 'utf8'), 'old document');
    await assert.rejects(fs.stat(path.join(f.destination, 'Documents/new.txt')), { code: 'ENOENT' });
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/existing.txt'), 'utf8'), 'updated document');
  assert.equal(await fs.readFile(path.join(f.destination, 'Photos/existing.jpg'), 'utf8'), 'updated photo');
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/new.txt'), 'utf8'), 'new document');
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/unrelated.txt'), 'utf8'), 'keep unrelated');
  assert.equal(await fs.readFile(path.join(f.extraction, 'Documents/existing.txt'), 'utf8'), 'updated document');
  assert.deepEqual((await fs.readdir(path.join(f.destination, 'Documents'))).sort(), ['existing.txt', 'new.txt', 'unrelated.txt']);
});

test('declining skips the complete project without copying new files and continues with the next project', async (t) => {
  const f = await fixture(t, '1,First,Custom_name,true,,\n2,Next,Next,true,,');
  await write(path.join(f.extraction, 'Documents/existing.txt'), 'source');
  await write(path.join(f.extraction, 'Photos/new.jpg'), 'new photo');
  await write(path.join(f.destination, 'Documents/existing.txt'), 'keep destination');
  await write(path.join(f.downloads, 'Next/Next/Documents/next.txt'), 'next project');
  await fs.mkdir(path.join(f.syncRoot, 'Next'));
  const results = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger, async () => false);
  assert.deepEqual(results.map((result) => result.status), ['SKIPPED', 'SUCCESS']);
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/existing.txt'), 'utf8'), 'keep destination');
  await assert.rejects(fs.stat(path.join(f.destination, 'Photos')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.syncRoot, 'Next/Documents/next.txt'), 'utf8'), 'next project');
});

test('refuses to overwrite a file that changed while approval was pending', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/file.txt'), 'source');
  await write(path.join(f.destination, 'Documents/file.txt'), 'old');
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger, async () => {
    await fs.writeFile(path.join(f.destination, 'Documents/file.txt'), 'changed by another process');
    return true;
  });
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /changed after the overwrite preview/);
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/file.txt'), 'utf8'), 'changed by another process');
});

test('keeps an approved destination intact when its incoming copy fails', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/file.txt'), 'source');
  await write(path.join(f.destination, 'Documents/file.txt'), 'keep original');
  t.mock.method(fs, 'copyFile', async () => { throw new Error('Simulated copy failure'); });
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger, async () => true);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Simulated copy failure/);
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/file.txt'), 'utf8'), 'keep original');
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Documents')), ['file.txt']);
});

test('does not prompt when all incoming files are new', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/new.txt'), 'new');
  await write(path.join(f.destination, 'Documents/unrelated.txt'), 'unrelated');
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger, async () => {
    throw new Error('No overwrite prompt should be needed');
  });
  assert.equal(result.status, 'SUCCESS');
});

async function promptFixture(t: TestContext, replies: (string | null)[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  let transcript = '';
  let questionCount = 0;
  output.on('data', (chunk: Buffer) => {
    const message = chunk.toString();
    transcript += message;
    if (message.includes('Overwrite these existing files?')) {
      const reply = replies[questionCount++];
      setImmediate(() => {
        if (reply === null || reply === undefined) input.end();
        else input.write(`${reply}\n`);
      });
    }
  });
  const destination = path.join(os.tmpdir(), 'sync-preview', 'Project');
  const request: OverwriteRequest = {
    project: { projectUid: 'uid-1', projectName: 'Original', projectCleanName: 'Project', enabled: true },
    destination,
    files: [path.join(destination, 'Documents/file.txt')],
  };
  const approved = await confirmSyncOverwrite(request, input, output, true);
  return { approved, transcript, questionCount };
}

test('terminal confirmation shows the destination and approves only y/yes', async (t) => {
  for (const reply of ['y', 'YES']) {
    const result = await promptFixture(t, [reply]);
    assert.equal(result.approved, true);
    assert.equal(result.questionCount, 1);
    assert.match(result.transcript, /Project: Project/);
    assert.match(result.transcript, /Destination:/);
    assert.match(result.transcript, /Existing files that will be overwritten: 1/);
    assert.match(result.transcript, /\[y\/N\]/);
  }
});

test('terminal confirmation declines on n/no, Enter, or closed input', async (t) => {
  for (const reply of ['n', 'NO', '', null]) assert.equal((await promptFixture(t, [reply])).approved, false);
});

test('terminal confirmation reprompts for invalid answers and rejects noninteractive approval', async (t) => {
  const result = await promptFixture(t, ['maybe', 'n']);
  assert.equal(result.approved, false);
  assert.equal(result.questionCount, 2);
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  const request: OverwriteRequest = {
    project: { projectUid: '', projectName: 'Original', projectCleanName: 'Project', enabled: true },
    destination: os.tmpdir(), files: ['file.txt'],
  };
  await assert.rejects(confirmSyncOverwrite(request, input, output, false), /interactive terminal/);
});

test('reuses existing destination directories without removing unrelated files', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/new.txt'), 'new');
  await write(path.join(f.destination, 'Documents/unrelated.txt'), 'keep');
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/new.txt'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/unrelated.txt'), 'utf8'), 'keep');
});

test('rejects links inside source folders before copying either folder', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/good.txt'), 'document');
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(f.extraction, 'Photos'));
  try {
    await fs.symlink(outside, path.join(f.extraction, 'Photos/link'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; }
    throw error;
  }
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Links and special files/);
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('rejects sync destinations overlapping the extracted tree', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/file.txt'), 'document');
  const [result] = await prepareSync(f.input, f.downloads, f.extraction, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /must be separate/);
  assert.deepEqual(await fs.readdir(f.extraction), ['Documents']);
});

test('rejects an invalid CSV before staging any data', async (t) => {
  const f = await fixture(t, '1,Project,../outside,true,,', false);
  await assert.rejects(prepareSync(f.input, f.downloads, f.syncRoot, quietLogger), /project_clean_name/);
  await assert.rejects(fs.stat(f.syncRoot), { code: 'ENOENT' });
});

test('requires an existing project destination without creating the root or project, and continues', async (t) => {
  for (const existingRoot of [false, true]) {
    const f = await fixture(t, '1,Missing,Missing,true,,\n2,Good,Custom_name,true,,', false);
    await write(path.join(f.downloads, 'Missing/Missing/Documents/file.txt'), 'missing destination');
    await write(path.join(f.extraction, 'Photos/site.jpg'), 'photo');
    if (existingRoot) await fs.mkdir(f.destination, { recursive: true });
    const results = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
    assert.deepEqual(results.map((result) => result.status), ['FAILED', existingRoot ? 'SUCCESS' : 'FAILED']);
    assert.match(results[0].message!, /Destination project folder must already exist/);
    await assert.rejects(fs.stat(path.join(f.syncRoot, 'Missing')), { code: 'ENOENT' });
    if (existingRoot) {
      assert.equal(await fs.readFile(path.join(f.destination, 'Photos/site.jpg'), 'utf8'), 'photo');
      assert.deepEqual(await fs.readdir(f.syncRoot), ['Custom_name']);
    } else {
      await assert.rejects(fs.stat(f.syncRoot), { code: 'ENOENT' });
    }
  }
});

test('warns about existing folders even without overwrites and only changes Documents/Photos', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/new.txt'), 'document');
  await write(path.join(f.extraction, 'Photos/new.jpg'), 'photo');
  await write(path.join(f.extraction, 'Drawings/existing.pdf'), 'do not copy');
  const retained = [
    'Custom_name/Documents/retained.txt', 'Custom_name/Photos/retained.jpg',
    'Custom_name/Drawings/existing.pdf', 'Custom_name/Other/deep/file.txt',
    'Custom_name/project.txt', 'Other Project/Documents/file.txt', 'root.txt',
  ];
  for (const file of retained) await write(path.join(f.syncRoot, file), `keep ${file}`);
  const before = await Promise.all(retained.map((file) => fs.stat(path.join(f.syncRoot, file))));
  const parent = await fs.stat(f.destination);
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  const logger = { ...quietLogger, warn(message: string, context?: Record<string, unknown>) { warnings.push({ message, context }); } };
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, logger, async () => {
    throw new Error('No overwrite prompt should be needed');
  });
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /destination folders already exist/);
  assert.deepEqual(warnings[0].context?.existingFolders, ['Documents', 'Photos']);
  assert.equal(warnings[0].context?.overwrittenFileCount, 0);
  assert.equal((await fs.stat(f.destination)).ino, parent.ino);
  for (const [index, file] of retained.entries()) {
    assert.equal(await fs.readFile(path.join(f.syncRoot, file), 'utf8'), `keep ${file}`);
    const after = await fs.stat(path.join(f.syncRoot, file));
    assert.equal(after.ino, before[index].ino);
    assert.equal(after.mtimeMs, before[index].mtimeMs);
  }
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/new.txt'), 'utf8'), 'document');
  assert.equal(await fs.readFile(path.join(f.destination, 'Photos/new.jpg'), 'utf8'), 'photo');
});

test('rejects a project destination link without changing the linked folder', async (t) => {
  const f = await fixture(t, undefined, false);
  await write(path.join(f.extraction, 'Documents/new.txt'), 'document');
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(f.syncRoot);
  try {
    await fs.symlink(outside, f.destination, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; }
    throw error;
  }
  const [result] = await prepareSync(f.input, f.downloads, f.syncRoot, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Destination project folder must be a directory, not a file or link/);
  assert.deepEqual(await fs.readdir(outside), []);
});
