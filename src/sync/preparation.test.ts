import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Logger } from '../logger.js';
import { prepareSync } from './prepare.js';

const headers = 'project_uid,project_name,project_clean_name,enabled,start_date,end_date';
const quietLogger: Logger = { general() {}, info() {}, debug() {}, success() {}, warn() {}, error() {} };

async function fixture(t: TestContext, rows = 'uid-1,Original Project,Custom_name,true,,') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-preparation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'projects.csv');
  const downloads = path.join(root, 'custom downloads');
  const syncRoot = path.join(root, 'custom sync destination');
  const extraction = path.join(downloads, 'Custom_name/Custom_name');
  const destination = path.join(syncRoot, 'Custom_name');
  await fs.writeFile(input, `${headers}\n${rows}\n`);
  await fs.mkdir(extraction, { recursive: true });
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
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
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
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
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
  const f = await fixture(t, '1,Project,../outside,true,,');
  await assert.rejects(prepareSync(f.input, f.downloads, f.syncRoot, quietLogger), /project_clean_name/);
  await assert.rejects(fs.stat(f.syncRoot), { code: 'ENOENT' });
});
