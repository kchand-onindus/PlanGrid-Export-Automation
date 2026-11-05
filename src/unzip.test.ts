import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { crc32 } from 'node:zlib';
import type { Logger } from './logger.js';
import { unzipProjects } from './unzip.js';
import { prepareSync } from './sync/prepare.js';

const headers = 'project_uid,project_name,project_clean_name,enabled,start_date,end_date';
const quietLogger: Logger = { general() {}, info() {}, debug() {}, success() {}, warn() {}, error() {} };
interface FixtureEntry { name: string; contents?: string; symlink?: boolean; corrupt?: boolean }

// Stored ZIP fixtures keep these tests independent of external ZIP programs.
function makeZip(entries: FixtureEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.contents ?? 'drawing contents');
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    const mode = entry.symlink ? 0o120777 : entry.name.endsWith('/') ? 0o040755 : 0o100644;
    directory.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    if (entry.corrupt && data.length) data[0] ^= 0xff;
    local.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

async function fixture(t: TestContext, rows = 'uid-1,Original Project,Custom_name,true,,') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-unzip-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'projects.csv');
  const downloads = path.join(root, 'custom-downloads');
  await fs.writeFile(input, `${headers}\n${rows}\n`);
  const directory = path.join(downloads, 'Custom_name');
  await fs.mkdir(directory, { recursive: true });
  const zipPath = path.join(directory, 'Custom_name.zip');
  const output = path.join(directory, 'Custom_name');
  return { root, input, downloads, directory, zipPath, output };
}

test('extracts all contents inside a clean-name parent next to the retained ZIP', async (t) => {
  const f = await fixture(t);
  const zip = makeZip([
    { name: 'Drawings/Version One/A.pdf', contents: 'PDF contents' },
    { name: 'Drawings/ROW Plans/9c.pdf', contents: 'ROW Plans drawing' },
    { name: 'Drawings/Current/9c.pdf', contents: 'Current drawing' },
    { name: 'Documents/readme.txt', contents: 'document contents' },
    { name: 'root.txt', contents: 'root file' },
    { name: 'Custom_name.zip', contents: 'an archive member with the same name as the source' },
    { name: 'empty/', contents: '' },
  ]);
  await fs.writeFile(f.zipPath, zip);
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.downloadDirectory, f.output);
  assert.equal(await fs.readFile(path.join(f.output, 'Drawings/Version One/A.pdf'), 'utf8'), 'PDF contents');
  assert.equal(await fs.readFile(path.join(f.output, 'Drawings/ROW Plans/9c.pdf'), 'utf8'), 'ROW Plans drawing');
  assert.equal(await fs.readFile(path.join(f.output, 'Drawings/Current/9c.pdf'), 'utf8'), 'Current drawing');
  assert.equal(await fs.readFile(path.join(f.output, 'Documents/readme.txt'), 'utf8'), 'document contents');
  assert.equal(await fs.readFile(path.join(f.output, 'root.txt'), 'utf8'), 'root file');
  assert.equal(await fs.readFile(path.join(f.output, 'Custom_name.zip'), 'utf8'), 'an archive member with the same name as the source');
  assert.ok((await fs.stat(path.join(f.output, 'empty'))).isDirectory());
  assert.deepEqual(await fs.readFile(f.zipPath), zip);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['Custom_name', 'Custom_name.zip']);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['Custom_name.zip', 'Documents', 'Drawings', 'empty', 'root.txt']);

  await fs.writeFile(path.join(f.output, 'root.txt'), 'old extracted contents');
  await fs.writeFile(path.join(f.output, 'stale.txt'), 'not in the current ZIP');
  const [rerun] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(rerun.status, 'SUCCESS', rerun.message);
  assert.equal(await fs.readFile(path.join(f.output, 'root.txt'), 'utf8'), 'root file');
  await assert.rejects(fs.stat(path.join(f.output, 'stale.txt')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['Custom_name', 'Custom_name.zip']);
});

test('skips disabled rows and continues after missing folders, missing ZIPs, and invalid archives', async (t) => {
  const f = await fixture(t, [
    '1,Missing folder,Missing,true,,', '2,Disabled,Disabled,false,,',
    '3,Missing ZIP,NoZip,true,,', '4,Broken ZIP,Broken,true,,',
    '5,Good Project,Custom_name,true,,',
  ].join('\n'));
  await fs.mkdir(path.join(f.downloads, 'NoZip'));
  await fs.mkdir(path.join(f.downloads, 'Broken'));
  await fs.writeFile(path.join(f.downloads, 'Broken/Broken.zip'), 'not a ZIP');
  await fs.writeFile(f.zipPath, makeZip([{ name: 'ok.txt' }]));
  const results = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.deepEqual(results.map((result) => result.status), ['FAILED', 'SKIPPED', 'FAILED', 'FAILED', 'SUCCESS']);
  assert.equal(await fs.readFile(path.join(f.output, 'ok.txt'), 'utf8'), 'drawing contents');
  await assert.rejects(fs.stat(path.join(f.downloads, 'Disabled')), { code: 'ENOENT' });
});

test('omits a single project wrapper while retaining all contents under the clean-name parent', async (t) => {
  for (const wrapper of ['DB2505 - I-24 at Epps Mill-Buchanan Road', 'Grainger 101410.01 ROW Plans ']) {
    const f = await fixture(t);
    const zip = makeZip([
      { name: `${wrapper}/`, contents: '' },
      { name: `${wrapper}/Documents/contracts/deep/file.txt`, contents: 'document' },
      { name: `${wrapper}/Photos/site.jpg`, contents: 'photo' },
      { name: `${wrapper}/Drawings/Current/9c.pdf`, contents: 'current drawing' },
      { name: `${wrapper}/Drawings/ROW Plans/9c.pdf`, contents: 'ROW drawing' },
      { name: `${wrapper}/export_log.csv`, contents: 'log' },
    ]);
    await fs.writeFile(f.zipPath, zip);
    const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
    assert.equal(result.status, 'SUCCESS', result.message);
    assert.equal(await fs.readFile(path.join(f.output, 'Documents/contracts/deep/file.txt'), 'utf8'), 'document');
    assert.equal(await fs.readFile(path.join(f.output, 'Photos/site.jpg'), 'utf8'), 'photo');
    assert.equal(await fs.readFile(path.join(f.output, 'Drawings/Current/9c.pdf'), 'utf8'), 'current drawing');
    assert.equal(await fs.readFile(path.join(f.output, 'Drawings/ROW Plans/9c.pdf'), 'utf8'), 'ROW drawing');
    assert.equal(await fs.readFile(path.join(f.output, 'export_log.csv'), 'utf8'), 'log');
    assert.deepEqual((await fs.readdir(f.output)).sort(), ['Documents', 'Drawings', 'Photos', 'export_log.csv']);
    assert.deepEqual(await fs.readFile(f.zipPath), zip);
  }
});

test('preserves meaningful single content folders and archives with multiple top-level items', async (t) => {
  for (const entries of [
    [{ name: 'Documents/nested/file.txt', contents: 'document' }],
    [{ name: 'Drawings/Version One/A.pdf', contents: 'drawing' }],
    [{ name: 'Photos/nested/site.jpg', contents: 'photo' }],
    [{ name: 'Project/Documents/a.txt', contents: 'document' }, { name: 'root.txt', contents: 'root file' }],
  ]) {
    const f = await fixture(t);
    await fs.writeFile(f.zipPath, makeZip(entries));
    const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
    assert.equal(result.status, 'SUCCESS', result.message);
    for (const entry of entries) assert.equal(await fs.readFile(path.join(f.output, entry.name), 'utf8'), entry.contents);
  }
});

test('refreshes an existing legacy wrapper layout without manual cleanup', async (t) => {
  const f = await fixture(t);
  const wrapper = 'Original-project';
  await fs.mkdir(path.join(f.output, wrapper, 'Documents'), { recursive: true });
  const existing = path.join(f.output, wrapper, 'Documents/file.txt');
  await fs.writeFile(existing, 'keep old extraction');
  await fs.writeFile(f.zipPath, makeZip([{ name: `${wrapper}/Documents/file.txt`, contents: 'archive contents' }]));
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.output, 'Documents/file.txt'), 'utf8'), 'archive contents');
  assert.deepEqual(await fs.readdir(f.output), ['Documents']);
  await assert.rejects(fs.stat(path.join(f.output, wrapper)), { code: 'ENOENT' });
});

test('rejects unsafe entries before omitting the wrapper', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.zipPath, makeZip([
    { name: 'Project/', symlink: true },
    { name: 'Project/Documents/file.txt' },
  ]));
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Unsafe or unsupported ZIP entry/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('preserves internal names, including PlanGrid trailing-space wrappers, without using CSV names', async (t) => {
  const f = await fixture(t);
  const zip = makeZip([
    { name: 'Grainger 101410.01 ROW Plans /', contents: '' },
    { name: 'Grainger 101410.01 ROW Plans /Drawings/ROW Plans/7B.pdf', contents: '7B drawing' },
    { name: 'Grainger 101410.01 ROW Plans /Documents. /notes.txt ', contents: 'notes' },
    { name: 'CON.txt', contents: 'ordinary file on macOS/Linux' },
    { name: 'Special <notes>?.txt', contents: 'special characters' },
  ]);
  await fs.writeFile(f.zipPath, zip);
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  if (process.platform === 'win32') {
    assert.equal(result.status, 'FAILED');
    assert.match(result.message!, /cannot be preserved on Windows/);
    assert.deepEqual(await fs.readdir(f.directory), ['Custom_name.zip']);
    assert.deepEqual(await fs.readFile(f.zipPath), zip);
    return;
  }
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.equal(await fs.readFile(path.join(f.output, 'Grainger 101410.01 ROW Plans /Drawings/ROW Plans/7B.pdf'), 'utf8'), '7B drawing');
  assert.equal(await fs.readFile(path.join(f.output, 'Grainger 101410.01 ROW Plans /Documents. /notes.txt '), 'utf8'), 'notes');
  assert.equal(await fs.readFile(path.join(f.output, 'CON.txt'), 'utf8'), 'ordinary file on macOS/Linux');
  assert.equal(await fs.readFile(path.join(f.output, 'Special <notes>?.txt'), 'utf8'), 'special characters');
  assert.deepEqual((await fs.readdir(f.output)).sort(), [
    'CON.txt', 'Grainger 101410.01 ROW Plans ', 'Special <notes>?.txt',
  ]);
  assert.deepEqual(await fs.readFile(f.zipPath), zip);
});

test('preflights unsafe paths, links, and colliding ZIP entries before writing files', async (t) => {
  for (const badEntries of [
    [{ name: '../outside.txt' }], [{ name: '/absolute.txt' }],
    [{ name: 'link', symlink: true }],
    [{ name: 'same.pdf' }, { name: 'same.pdf' }],
    [{ name: 'file' }, { name: 'file/child' }],
  ]) {
    const f = await fixture(t);
    await fs.writeFile(f.zipPath, makeZip([{ name: 'first.txt' }, ...badEntries]));
    const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
    assert.equal(result.status, 'FAILED', JSON.stringify(badEntries));
    assert.deepEqual(await fs.readdir(f.directory), ['Custom_name.zip']);
    await assert.rejects(fs.stat(path.join(f.downloads, 'outside.txt')), { code: 'ENOENT' });
  }
});

test('preserves case-distinct files on capable filesystems and reports both names otherwise', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.zipPath, makeZip([
    { name: 'Drawings/ROW Plans/9C.pdf', contents: 'uppercase drawing' },
    { name: 'Drawings/ROW Plans/9c.pdf', contents: 'lowercase drawing' },
    { name: 'Drawings/Current/9C.pdf', contents: 'uppercase current drawing' },
    { name: 'Drawings/Current/9c.pdf', contents: 'lowercase current drawing' },
  ]));
  let caseSensitive = false;
  try {
    await fs.stat(path.join(f.directory, 'cUSTOM_NAME.ZIP'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    caseSensitive = true;
  }
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  if (caseSensitive) {
    assert.equal(result.status, 'SUCCESS', result.message);
    assert.equal(await fs.readFile(path.join(f.output, 'Drawings/ROW Plans/9C.pdf'), 'utf8'), 'uppercase drawing');
    assert.equal(await fs.readFile(path.join(f.output, 'Drawings/ROW Plans/9c.pdf'), 'utf8'), 'lowercase drawing');
    assert.equal(await fs.readFile(path.join(f.output, 'Drawings/Current/9C.pdf'), 'utf8'), 'uppercase current drawing');
    assert.equal(await fs.readFile(path.join(f.output, 'Drawings/Current/9c.pdf'), 'utf8'), 'lowercase current drawing');
  } else {
    assert.equal(result.status, 'FAILED');
    assert.match(result.message!, /9C.pdf/);
    assert.match(result.message!, /9c.pdf/);
    assert.match(result.message!, /case-sensitive/);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  }
});

test('replaces existing extracted files while retaining the source ZIP', async (t) => {
  for (const name of ['existing.txt', 'Custom_name.zip']) {
    const f = await fixture(t);
    await fs.mkdir(f.output);
    await fs.writeFile(path.join(f.output, name), 'keep me');
    const zip = makeZip([{ name: 'new.txt' }, { name }]);
    await fs.writeFile(f.zipPath, zip);
    const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
    assert.equal(result.status, 'SUCCESS', result.message);
    assert.equal(await fs.readFile(path.join(f.output, name), 'utf8'), 'drawing contents');
    assert.deepEqual(await fs.readFile(f.zipPath), zip);
    assert.equal(await fs.readFile(path.join(f.output, 'new.txt'), 'utf8'), 'drawing contents');
  }
});

test('replaces old extracted symlinks without following them', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(f.output);
  try {
    await fs.symlink(outside, path.join(f.output, 'linked'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; }
    throw error;
  }
  await fs.writeFile(f.zipPath, makeZip([{ name: 'first.txt' }, { name: 'linked/outside.txt' }]));
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'SUCCESS', result.message);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(path.join(f.output, 'first.txt'), 'utf8'), 'drawing contents');
  assert.equal(await fs.readFile(path.join(f.output, 'linked/outside.txt'), 'utf8'), 'drawing contents');
  assert.equal((await fs.lstat(path.join(f.output, 'linked'))).isSymbolicLink(), false);
});

test('reports checksum failures and retains the source archive', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.output);
  await fs.writeFile(path.join(f.output, 'previous.txt'), 'keep previous extraction');
  const zip = makeZip([{ name: 'corrupt.txt', corrupt: true }]);
  await fs.writeFile(f.zipPath, zip);
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /CRC mismatch/);
  assert.deepEqual(await fs.readFile(f.zipPath), zip);
  assert.deepEqual(await fs.readdir(f.output), ['previous.txt']);
  assert.equal(await fs.readFile(path.join(f.output, 'previous.txt'), 'utf8'), 'keep previous extraction');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['Custom_name', 'Custom_name.zip']);
});

test('rejects a linked extraction parent without modifying its target', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'outside contents');
  try {
    await fs.symlink(outside, f.output, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; }
    throw error;
  }
  await fs.writeFile(f.zipPath, makeZip([{ name: 'Documents/file.txt' }]));
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /not a file or link/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside contents');
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});

test('restores the old extraction if publishing the verified replacement fails', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.output);
  await fs.writeFile(path.join(f.output, 'previous.txt'), 'old extraction');
  await fs.writeFile(f.zipPath, makeZip([{ name: 'Documents/new.txt', contents: 'new extraction' }]));
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (path.basename(from).startsWith('.unzip-stage-')) throw new Error('Simulated publish failure');
    return rename(from, to);
  });
  const [result] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(result.status, 'FAILED');
  assert.match(result.message!, /Simulated publish failure/);
  assert.equal(await fs.readFile(path.join(f.output, 'previous.txt'), 'utf8'), 'old extraction');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['Custom_name', 'Custom_name.zip']);
});

test('sync preparation reads Documents and Photos from the refreshed clean-name extraction parent', async (t) => {
  const f = await fixture(t);
  const syncRoot = path.join(f.root, 'sync_ups');
  await fs.writeFile(f.zipPath, makeZip([
    { name: 'Original-project/Documents/nested/file.txt', contents: 'document' },
    { name: 'Original-project/Photos/site.jpg', contents: 'photo' },
    { name: 'Original-project/Drawings/A.pdf', contents: 'drawing' },
  ]));
  const [extracted] = await unzipProjects(f.input, f.downloads, quietLogger);
  assert.equal(extracted.status, 'SUCCESS', extracted.message);
  const [copied] = await prepareSync(f.input, f.downloads, syncRoot, quietLogger);
  assert.equal(copied.status, 'SUCCESS', copied.message);
  assert.equal(await fs.readFile(path.join(syncRoot, 'Custom_name/Documents/nested/file.txt'), 'utf8'), 'document');
  assert.equal(await fs.readFile(path.join(syncRoot, 'Custom_name/Photos/site.jpg'), 'utf8'), 'photo');
  assert.deepEqual((await fs.readdir(path.join(syncRoot, 'Custom_name'))).sort(), ['Documents', 'Photos']);
});

test('invalid project CSV stops extraction before filesystem changes', async (t) => {
  const f = await fixture(t, '1,Project,../outside,true,,');
  await assert.rejects(unzipProjects(f.input, f.downloads, quietLogger), /project_clean_name/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});
