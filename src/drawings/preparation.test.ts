import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Logger } from '../logger.js';
import { confirmSyncOverwrite } from '../sync/confirmation.js';
import { prepareDrawings } from '../sync/prepare.js';

const quietLogger: Logger = { general() {}, info() {}, debug() {}, success() {}, warn() {}, error() {} };

async function fixture(t: TestContext, rows = '1,Original Project,Custom_name,true,,') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drawings-preparation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'projects.csv');
  const downloads = path.join(root, 'downloads');
  const drawings = path.join(root, 'separate drawings destination');
  const extraction = path.join(downloads, 'Custom_name/Custom_name');
  const destination = path.join(drawings, 'Custom_name');
  await fs.writeFile(input, `project_uid,project_name,project_clean_name,enabled,start_date,end_date\n${rows}\n`);
  await fs.mkdir(extraction, { recursive: true });
  return { root, input, downloads, drawings, extraction, destination };
}

async function write(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

test('copies all other project entries, retaining nested names, empty directories, sources and unrelated output', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/contracts/a.txt'), 'excluded document');
  await write(path.join(f.extraction, 'Photos/site.jpg'), 'excluded photo');
  const files = ['Drawings/Version 1/deep/a.pdf', 'Other/Nested/Documents/keep.txt', 'export report.txt'];
  for (const file of files) await write(path.join(f.extraction, file), file);
  await fs.mkdir(path.join(f.extraction, 'Drawings/empty'), { recursive: true });
  await fs.mkdir(path.join(f.extraction, 'Other empty'), { recursive: true });
  await write(path.join(f.destination, 'unrelated.txt'), 'keep');
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(result.downloadDirectory, f.destination);
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['Drawings', 'Other', 'Other empty', 'export report.txt', 'unrelated.txt']);
  for (const file of files) {
    assert.equal(await fs.readFile(path.join(f.destination, file), 'utf8'), file);
    assert.equal(await fs.readFile(path.join(f.extraction, file), 'utf8'), file);
  }
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Drawings/empty')), []);
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Other empty')), []);
  assert.equal(await fs.readFile(path.join(f.destination, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(f.extraction, 'Documents/contracts/a.txt'), 'utf8'), 'excluded document');
});

test('supports a sole legacy project wrapper, including projects with only Drawings', async (t) => {
  for (const includeExcluded of [false, true]) {
    const f = await fixture(t);
    const wrapper = path.join(f.extraction, 'Original Project');
    await write(path.join(wrapper, 'Drawings/Versions/nested/a.pdf'), 'drawing');
    await write(path.join(wrapper, 'export.log'), 'report');
    if (includeExcluded) {
      await write(path.join(wrapper, 'Documents/a.txt'), 'excluded');
      await write(path.join(wrapper, 'Photos/a.jpg'), 'excluded');
    }
    const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
    assert.equal(result.status, 'SUCCESS', result.message);
    assert.deepEqual((await fs.readdir(f.destination)).sort(), ['Drawings', 'export.log']);
    assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/Versions/nested/a.pdf'), 'utf8'), 'drawing');
  }
});

test('copies arbitrary files and folders even without any standard project folders', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Notes/Deep/file.txt'), 'notes');
  await write(path.join(f.extraction, 'report.txt'), 'report');
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.destination, 'Notes/Deep/file.txt'), 'utf8'), 'notes');
  assert.equal(await fs.readFile(path.join(f.destination, 'report.txt'), 'utf8'), 'report');
});

test('retains multiple top-level items instead of dropping siblings or flattening their hierarchy', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Other/Drawings/a.pdf'), 'drawing');
  await write(path.join(f.extraction, 'report.txt'), 'report');
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.destination, 'Other/Drawings/a.pdf'), 'utf8'), 'drawing');
  assert.equal(await fs.readFile(path.join(f.destination, 'report.txt'), 'utf8'), 'report');
});

test('rejects multiple legacy project wrappers before copying', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'First/Drawings/a.pdf'), 'one');
  await write(path.join(f.extraction, 'Second/Documents/a.txt'), 'two');
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Multiple project wrappers/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('skips disabled and Documents/Photos-only projects, fails missing roots, and continues', async (t) => {
  const f = await fixture(t, '1,Disabled,Disabled,false,,\n2,Missing,Missing,true,,\n3,Excluded,Excluded,true,,\n4,Good,Custom_name,true,,');
  await write(path.join(f.downloads, 'Excluded/Excluded/Documents/a.txt'), 'excluded');
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'drawing');
  const results = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.deepEqual(results.map((result) => result.status), ['SKIPPED', 'FAILED', 'SKIPPED', 'SUCCESS']);
  assert.deepEqual(await fs.readdir(f.drawings), ['Custom_name']);
});

test('previews conflicts once before copying and preserves unrelated and excluded destination files', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/existing.pdf'), 'new drawing');
  await write(path.join(f.extraction, 'new.txt'), 'new file');
  await write(path.join(f.extraction, 'report.txt'), 'new report');
  await write(path.join(f.extraction, 'Documents/old.txt'), 'excluded document');
  await write(path.join(f.destination, 'Drawings/existing.pdf'), 'old drawing');
  await write(path.join(f.destination, 'report.txt'), 'old report');
  await write(path.join(f.destination, 'Documents/old.txt'), 'keep document');
  await write(path.join(f.destination, 'unrelated.txt'), 'keep unrelated');
  let requests = 0;
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger, async (request) => {
    requests++;
    assert.equal(request.destination, f.destination);
    assert.equal(request.project.projectCleanName, 'Custom_name');
    assert.deepEqual(request.files.sort(), [path.join(f.destination, 'Drawings/existing.pdf'), path.join(f.destination, 'report.txt')]);
    await assert.rejects(fs.stat(path.join(f.destination, 'new.txt')), { code: 'ENOENT' });
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/existing.pdf'), 'utf8'), 'new drawing');
  assert.equal(await fs.readFile(path.join(f.destination, 'report.txt'), 'utf8'), 'new report');
  assert.equal(await fs.readFile(path.join(f.destination, 'new.txt'), 'utf8'), 'new file');
  assert.equal(await fs.readFile(path.join(f.destination, 'Documents/old.txt'), 'utf8'), 'keep document');
  assert.equal(await fs.readFile(path.join(f.destination, 'unrelated.txt'), 'utf8'), 'keep unrelated');
});

test('declining, missing approval and noninteractive conflicts leave the whole project unchanged', async (t) => {
  for (const mode of ['declined', 'missing', 'noninteractive']) {
    const f = await fixture(t);
    await write(path.join(f.extraction, 'Drawings/existing.pdf'), 'new');
    await write(path.join(f.extraction, 'new.txt'), 'new file');
    await write(path.join(f.destination, 'Drawings/existing.pdf'), 'old');
    const confirm = mode === 'declined' ? async () => false
      : mode === 'noninteractive' ? (request: Parameters<typeof confirmSyncOverwrite>[0]) =>
        confirmSyncOverwrite(request, process.stdin, process.stdout, false) : undefined;
    const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger, confirm);
    assert.equal(result.status, mode === 'declined' ? 'SKIPPED' : 'FAILED');
    assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/existing.pdf'), 'utf8'), 'old');
    await assert.rejects(fs.stat(path.join(f.destination, 'new.txt')), { code: 'ENOENT' });
  }
});

test('rechecks existing and new destinations after approval before copying', async (t) => {
  for (const change of ['existing', 'new']) {
    const f = await fixture(t);
    await write(path.join(f.extraction, 'Drawings/existing.pdf'), 'new drawing');
    await write(path.join(f.extraction, 'new.txt'), 'new file');
    await write(path.join(f.destination, 'Drawings/existing.pdf'), 'old');
    const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger, async () => {
      await write(path.join(f.destination, change === 'existing' ? 'Drawings/existing.pdf' : 'new.txt'), 'external change');
      return true;
    });
    assert.equal(result.status, 'FAILED');
    assert.match(result.message!, /changed after the overwrite preview|appeared after the preview/);
    assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/existing.pdf'), 'utf8'), change === 'existing' ? 'external change' : 'old');
  }
});

test('rejects overlapping roots and destination type conflicts before copying', async (t) => {
  for (const conflict of ['overlap', 'type']) {
    const f = await fixture(t);
    await write(path.join(f.extraction, 'Drawings/a.pdf'), 'drawing');
    if (conflict === 'type') await write(path.join(f.destination, 'Drawings'), 'file conflicts with directory');
    const [result] = await prepareDrawings(f.input, f.downloads, conflict === 'overlap' ? f.extraction : f.drawings, quietLogger);
    assert.equal(result.status, 'FAILED');
    assert.match(result.message!, /must be separate|incompatible/);
    if (conflict === 'overlap') assert.deepEqual(await fs.readdir(f.extraction), ['Drawings']);
    else assert.equal(await fs.readFile(path.join(f.destination, 'Drawings'), 'utf8'), 'file conflicts with directory');
  }
});

test('rejects source and destination links before copying', async (t) => {
  for (const location of ['source', 'destination']) {
    const f = await fixture(t);
    await write(path.join(f.extraction, 'Drawings/a.pdf'), 'drawing');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    const link = path.join(location === 'source' ? f.extraction : f.destination, 'Other');
    await fs.mkdir(path.dirname(link), { recursive: true });
    if (location === 'destination') await fs.mkdir(path.join(f.extraction, 'Other'));
    try {
      await fs.symlink(outside, link, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; }
      throw error;
    }
    const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
    assert.equal(result.status, 'FAILED');
    assert.match(result.message!, /Links and special files|incompatible/);
    assert.deepEqual(await fs.readdir(outside), []);
    await assert.rejects(fs.stat(path.join(f.destination, 'Drawings')), { code: 'ENOENT' });
  }
});

test('retains approved destination files if staging the incoming replacement fails', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'new');
  await write(path.join(f.destination, 'Drawings/a.pdf'), 'keep');
  t.mock.method(fs, 'copyFile', async () => { throw new Error('Simulated incoming copy failure'); });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger, async () => true);
  assert.equal(result.status, 'FAILED');
  assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/a.pdf'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Drawings')), ['a.pdf']);
});
