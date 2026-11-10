import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Logger } from '../logger.js';
import { prepareDrawings } from '../sync/prepare.js';
import { summarizeLocalResults } from '../local-results.js';

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

test('refreshes the whole project with eligible source contents, preserving sources and other projects', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Documents/contracts/a.txt'), 'excluded document');
  await write(path.join(f.extraction, 'Photos/site.jpg'), 'excluded photo');
  const files = ['Drawings/Version 1/deep/a.pdf', 'Other/Nested/Documents/keep.txt', 'export report.txt'];
  for (const file of files) await write(path.join(f.extraction, file), file);
  await fs.mkdir(path.join(f.extraction, 'Drawings/empty'), { recursive: true });
  await fs.mkdir(path.join(f.extraction, 'Other empty'), { recursive: true });
  await write(path.join(f.destination, 'unrelated.txt'), 'keep');
  await write(path.join(f.destination, 'Documents/old.txt'), 'remove stale excluded content');
  await write(path.join(f.drawings, 'Other Project/keep.txt'), 'keep other project');
  await write(path.join(f.drawings, 'root.txt'), 'keep root file');
  const before = await fs.stat(f.destination);
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(result.downloadDirectory, f.destination);
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['Drawings', 'Other', 'Other empty', 'export report.txt']);
  assert.equal((await fs.stat(f.destination)).ino, before.ino, 'Keep the project directory itself in place');
  for (const file of files) {
    assert.equal(await fs.readFile(path.join(f.destination, file), 'utf8'), file);
    assert.equal(await fs.readFile(path.join(f.extraction, file), 'utf8'), file);
  }
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Drawings/empty')), []);
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Other empty')), []);
  await assert.rejects(fs.stat(path.join(f.destination, 'unrelated.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.destination, 'Documents')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.drawings, 'Other Project/keep.txt'), 'utf8'), 'keep other project');
  assert.equal(await fs.readFile(path.join(f.drawings, 'root.txt'), 'utf8'), 'keep root file');
  assert.deepEqual((await fs.readdir(f.drawings)).sort(), ['Custom_name', 'Other Project', 'root.txt']);
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

test('skips disabled projects, missing extraction roots and Documents/Photos-only projects, and continues', async (t) => {
  const f = await fixture(t, '1,Disabled,Disabled,false,,\n2,Missing,Missing,true,,\n3,Excluded,Excluded,true,,\n4,Missing inner extraction,NoExtraction,true,,\n5,Good,Custom_name,true,,');
  await write(path.join(f.downloads, 'Excluded/Excluded/Documents/a.txt'), 'excluded');
  await fs.mkdir(path.join(f.downloads, 'NoExtraction'));
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'drawing');
  const results = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.deepEqual(results.map((result) => result.status), ['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED', 'SUCCESS']);
  assert.deepEqual(summarizeLocalResults(results), {
    total: 5, success: 1, skipped: 4, failed: 0,
    skippedByReason: { DISABLED: 1, MISSING_EXTRACTION: 2, NO_MATCHING_CONTENT: 1 }, failedProjects: [],
  });
  assert.deepEqual(await fs.readdir(f.drawings), ['Custom_name']);
  await assert.rejects(fs.stat(path.join(f.downloads, 'Missing')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(f.downloads, 'NoExtraction')), []);
});

test('replaces matching files and removes all destination-only content without an overwrite prompt', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/existing.pdf'), 'new drawing');
  await write(path.join(f.extraction, 'new.txt'), 'new file');
  await write(path.join(f.extraction, 'report.txt'), 'new report');
  await write(path.join(f.extraction, 'Documents/old.txt'), 'excluded document');
  await write(path.join(f.destination, 'Drawings/existing.pdf'), 'old drawing');
  await write(path.join(f.destination, 'Drawings/stale.pdf'), 'remove stale nested drawing');
  await write(path.join(f.destination, 'report.txt'), 'old report');
  await write(path.join(f.destination, 'Documents/old.txt'), 'keep document');
  await write(path.join(f.destination, 'unrelated.txt'), 'keep unrelated');
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/existing.pdf'), 'utf8'), 'new drawing');
  assert.equal(await fs.readFile(path.join(f.destination, 'report.txt'), 'utf8'), 'new report');
  assert.equal(await fs.readFile(path.join(f.destination, 'new.txt'), 'utf8'), 'new file');
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Drawings')), ['existing.pdf']);
  await assert.rejects(fs.stat(path.join(f.destination, 'Documents')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.destination, 'unrelated.txt')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(f.drawings)), ['Custom_name']);
});

test('refuses to clear a destination that changes while the replacement is staged', async (t) => {
  for (const change of ['existing', 'new']) {
    const f = await fixture(t);
    await write(path.join(f.extraction, 'Drawings/existing.pdf'), 'new drawing');
    await write(path.join(f.extraction, 'new.txt'), 'new file');
    await write(path.join(f.destination, 'Drawings/existing.pdf'), 'old');
    const copy = fs.copyFile;
    let changed = false;
    t.mock.method(fs, 'copyFile', async (from: string, to: string, mode?: number) => {
      await copy(from, to, mode);
      if (changed) return;
      changed = true;
      await write(path.join(f.destination, change === 'existing' ? 'Drawings/existing.pdf' : 'new.txt'), 'external change');
    });
    const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
    assert.equal(result.status, 'FAILED');
    assert.match(result.message!, /destination changed while preparing/);
    assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/existing.pdf'), 'utf8'), change === 'existing' ? 'external change' : 'old');
  }
});

test('rejects overlapping roots before copying or clearing anything', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'drawing');
  const [result] = await prepareDrawings(f.input, f.downloads, f.extraction, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /must be separate/);
  assert.deepEqual(await fs.readdir(f.extraction), ['Drawings']);
});

test('refresh replaces old file/directory types with the fresh source layout', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'new drawing');
  await write(path.join(f.extraction, 'report.txt'), 'new report');
  await write(path.join(f.destination, 'Drawings'), 'old file');
  await write(path.join(f.destination, 'report.txt/old.txt'), 'old directory');
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/a.pdf'), 'utf8'), 'new drawing');
  assert.equal(await fs.readFile(path.join(f.destination, 'report.txt'), 'utf8'), 'new report');
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

test('retains previous output when staging fails, reports failure, and continues to the next project', async (t) => {
  const f = await fixture(t, '1,First,Custom_name,true,,\n2,Next,Next,true,,');
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'new');
  await write(path.join(f.destination, 'Drawings/a.pdf'), 'keep');
  await write(path.join(f.downloads, 'Next/Next/Drawings/next.pdf'), 'next drawing');
  const copy = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (from: string, to: string, mode?: number) => {
    if (from.startsWith(`${f.extraction}${path.sep}`)) throw new Error('Simulated incoming copy failure');
    await copy(from, to, mode);
  });
  const [result, next] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/a.pdf'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'Drawings')), ['a.pdf']);
  assert.equal(next.status, 'SUCCESS', next.message);
  assert.deepEqual(summarizeLocalResults([result, next]), {
    total: 2, success: 1, skipped: 0, failed: 1, skippedByReason: {}, failedProjects: ['Custom_name'],
  });
  assert.deepEqual((await fs.readdir(f.drawings)).sort(), ['Custom_name', 'Next']);
});

test('creates missing output and refreshes existing output without directory renames', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/a.pdf'), 'first drawing');
  t.mock.method(fs, 'rename', async () => { throw new Error('Windows directory rename blocked'); });
  const [first] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(first.status, 'SUCCESS', first.message);
  await write(path.join(f.destination, 'stale.txt'), 'remove');
  await fs.writeFile(path.join(f.extraction, 'Drawings/a.pdf'), 'fresh drawing');
  const [second] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(second.status, 'SUCCESS', second.message);
  assert.deepEqual(await fs.readdir(f.destination), ['Drawings']);
  assert.equal(await fs.readFile(path.join(f.destination, 'Drawings/a.pdf'), 'utf8'), 'fresh drawing');
});

test('a failed backup leaves the previous project contents untouched', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'new.txt'), 'new contents');
  await write(path.join(f.destination, 'previous.txt'), 'old contents');
  t.mock.method(fs, 'cp', async () => { throw new Error('Backup copy failed'); });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Backup copy failed/);
  assert.deepEqual(await fs.readdir(f.destination), ['previous.txt']);
  assert.equal(await fs.readFile(path.join(f.destination, 'previous.txt'), 'utf8'), 'old contents');
  assert.deepEqual(await fs.readdir(f.drawings), ['Custom_name']);
});

test('restores all previous contents after partial publication fails', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'Drawings/new.pdf'), 'new drawing');
  await write(path.join(f.destination, 'previous.txt'), 'old contents');
  const copy = fs.cp;
  t.mock.method(fs, 'cp', async (from: string, to: string, options: Parameters<typeof fs.cp>[2]) => {
    if (path.basename(path.dirname(from)).startsWith('.drawings-stage-')) {
      await write(path.join(f.destination, 'partial.txt'), 'partial copy');
      throw new Error('Publication copy failed');
    }
    await copy(from, to, options);
  });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Publication copy failed/);
  assert.deepEqual(await fs.readdir(f.destination), ['previous.txt']);
  assert.equal(await fs.readFile(path.join(f.destination, 'previous.txt'), 'utf8'), 'old contents');
  assert.deepEqual(await fs.readdir(f.drawings), ['Custom_name']);
});

test('restores all previous contents if clearing old files fails partway through', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'new.txt'), 'new contents');
  await write(path.join(f.destination, 'first.txt'), 'old first');
  await write(path.join(f.destination, 'second.txt'), 'old second');
  const remove = fs.rm;
  let cleared = 0;
  let blocked = false;
  t.mock.method(fs, 'rm', async (target: string, options: Parameters<typeof fs.rm>[1]) => {
    if (path.dirname(target) === f.destination && !blocked && ++cleared === 2) {
      blocked = true;
      throw new Error('Old file is locked');
    }
    return remove(target, options);
  });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Old file is locked/);
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['first.txt', 'second.txt']);
  assert.equal(await fs.readFile(path.join(f.destination, 'first.txt'), 'utf8'), 'old first');
  assert.equal(await fs.readFile(path.join(f.destination, 'second.txt'), 'utf8'), 'old second');
  assert.deepEqual(await fs.readdir(f.drawings), ['Custom_name']);
});

test('removes a newly created project folder after a failed first publication', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'new.txt'), 'new contents');
  t.mock.method(fs, 'cp', async () => { throw new Error('Publication failed'); });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.drawings), []);
});

test('retains and reports the backup when both publication and restoration fail', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'new.txt'), 'new contents');
  await write(path.join(f.destination, 'previous.txt'), 'old contents');
  const copy = fs.cp;
  t.mock.method(fs, 'cp', async (from: string, to: string, options: Parameters<typeof fs.cp>[2]) => {
    const parent = path.basename(path.dirname(from));
    if (parent.startsWith('.drawings-stage-') || parent.startsWith('.drawings-backup-')) {
      throw new Error('Persistent copy lock');
    }
    await copy(from, to, options);
  });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  assert.equal(result.status, 'FAILED');
  const backups = (await fs.readdir(f.drawings)).filter((name) => name.startsWith('.drawings-backup-'));
  assert.equal(backups.length, 1);
  assert.match(result.message!, /recovery backup retained at/);
  assert.ok(result.message!.includes(path.join(f.drawings, backups[0])));
  assert.equal(await fs.readFile(path.join(f.drawings, backups[0], 'previous.txt'), 'utf8'), 'old contents');
  assert.equal((await fs.readdir(f.drawings)).some((name) => name.startsWith('.drawings-stage-')), false);
});

test('temporary cleanup failures count as failures with the retained paths reported', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.extraction, 'new.txt'), 'new contents');
  const remove = fs.rm;
  const mockedRemove = t.mock.method(fs, 'rm', async (target: string, options: Parameters<typeof fs.rm>[1]) => {
    if (path.basename(target).startsWith('.drawings-stage-')) throw new Error('Cleanup permission denied');
    return remove(target, options);
  });
  const [result] = await prepareDrawings(f.input, f.downloads, f.drawings, quietLogger);
  mockedRemove.mock.restore();
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /contents refreshed, but temporary cleanup failed.*\.drawings-stage-/);
  assert.equal(await fs.readFile(path.join(f.destination, 'new.txt'), 'utf8'), 'new contents');
});
