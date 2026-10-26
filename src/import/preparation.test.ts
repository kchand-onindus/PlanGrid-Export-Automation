import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { crc32 } from 'node:zlib';
import type { Logger } from '../logger.js';
import { readVersionSets, validateSequence } from './csv.js';
import { prepareImport } from './prepare.js';
import type { ImportPlan } from './types.js';

const headers = 'project_uid,project_name,project_kahua_entity_id,version_set_uid,version_name,published_at,upload_sequence';
const first = 'project-1,"Project, One",0,version-1,Bid Set - 7/22/2025,2025-07-22,1';
const second = 'project-1,"Project, One",0,version-2,Revision,2025-06-01,2';
const quietLogger: Logger = {
  general() {}, info() {}, debug() {}, success() {}, warn() {}, error() {},
};

interface FixtureEntry {
  name: string;
  contents?: string;
  corrupt?: boolean;
  symlink?: boolean;
}

// Small stored ZIP fixtures avoid an extra ZIP-writing dependency in production.
function makeZip(entries: FixtureEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.contents ?? '%PDF-test drawing');
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
    directory.writeUInt32LE(((entry.symlink ? 0o120777 : 0o100644) * 0x10000) >>> 0, 38);
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

async function fixture(t: TestContext, csv: string, entries: FixtureEntry[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plangrid-import-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    projectUid: 'project-1', csvFile: path.join(root, 'versions.csv'),
    zipFile: path.join(root, 'source.zip'), outputRoot: path.join(root, 'prepared'),
  };
  await fs.writeFile(options.csvFile, csv);
  await fs.writeFile(options.zipFile, makeZip(entries));
  return options;
}

test('prepares ordered versions, preserves metadata, warns on dates, and excludes Current', async (t) => {
  const options = await fixture(t, `\ufeff${headers}\r\n${second}\r\n${first}\r\n`
    + 'other-project,Other,0,other-version,Unrelated,2025-01-01,1\r\n', [
    { name: 'Project/Drawings/Revision/subfolder/B.pdf' },
    { name: 'Project/Drawings/Bid Set - 7-22-2025/A.pdf' },
    { name: 'Project/Drawings/cUrReNt/combined.pdf' },
    { name: 'Project/Documents/contract.pdf' },
    { name: 'Project/Drawings/.DS_Store' },
    { name: '__MACOSX/Project/Drawings/ignored.pdf' },
  ]);
  const warnings: string[] = [];
  const manifest = await prepareImport(options, { ...quietLogger, warn(message) { warnings.push(message); } });
  const plan: ImportPlan = JSON.parse(await fs.readFile(manifest, 'utf8'));
  assert.equal(plan.status, 'PREPARED');
  assert.equal(plan.projectName, 'Project, One');
  assert.deepEqual(plan.versions.map((version) => version.uploadSequence), [1, 2]);
  assert.equal(plan.versions[0].versionName, 'Bid Set - 7/22/2025');
  assert.equal(plan.versions[0].entityId, '0');
  assert.equal(plan.versions[0].entityIdColumn, 'project_kahua_entity_id');
  assert.equal(plan.versions[1].publishedAt, '2025-06-01');
  assert.deepEqual(plan.excludedFolders, ['Project/Drawings/cUrReNt']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Date order discrepancy/);
  assert.deepEqual(plan.warnings, warnings);
  for (const version of plan.versions) {
    assert.equal(version.files.length, 1);
    assert.equal(await fs.readFile(version.files[0].localPath, 'utf8'), '%PDF-test drawing');
  }
  assert.match(plan.versions[1].files[0].localPath, /subfolder\/B.pdf$/);
  const nextManifest = await prepareImport(options, quietLogger);
  assert.notEqual(nextManifest, manifest);
  assert.equal(await fs.readFile(plan.versions[0].files[0].localPath, 'utf8'), '%PDF-test drawing');
});

test('accepts curvo_entity_id and a version UID folder without a project wrapper', async (t) => {
  const options = await fixture(t, `${headers.replace('project_kahua_entity_id', 'curvo_entity_id')}\n${first}`, [
    { name: 'Drawings/version-1/A.pdf' },
  ]);
  const plan: ImportPlan = JSON.parse(await fs.readFile(await prepareImport(options, quietLogger), 'utf8'));
  assert.equal(plan.versions[0].entityIdColumn, 'curvo_entity_id');
});

test('sorts sequence numbers numerically and reports gaps without changing the order', async (t) => {
  const options = await fixture(t, `${headers}\n${first.replace(/,1$/, ',10')}\n${second}`, []);
  const versions = await readVersionSets(options.csvFile, options.projectUid);
  assert.deepEqual(versions.map((version) => version.uploadSequence), [2, 10]);
  assert.equal(validateSequence(versions).filter((warning) => warning.includes('Sequence gap')).length, 2);
});

test('rejects invalid selected-project CSV input', async (t) => {
  const cases: Array<[string, string, RegExp]> = [
    ['missing column', `${headers.replace('version_name', 'wrong')}\n${first}`, /missing required columns/],
    ['duplicate column', `${headers},project_uid\n${first},project-1`, /duplicate column/],
    ['invalid date', `${headers}\n${first.replace('2025-07-22,1', '2025-02-30,1')}`, /valid YYYY-MM-DD/],
    ['invalid sequence', `${headers}\n${first.replace(/,1$/, ',0')}`, /positive integer/],
    ['duplicate sequence', `${headers}\n${first}\n${second.replace(/,2$/, ',1')}`, /Duplicate upload_sequence/],
    ['duplicate UID', `${headers}\n${first}\n${second.replace('version-2', 'version-1')}`, /Duplicate version_set_uid/],
    ['missing project', `${headers}\n${first.replace('project-1', 'other')}`, /No version sets/],
    ['empty version name', `${headers}\n${first.replace('Bid Set - 7/22/2025', '')}`, /version_name is required/],
    ['conflicting entity IDs', `${headers},curvo_entity_id\n${first},different`, /entity ID columns disagree/],
  ];
  for (const [name, csv, expected] of cases) {
    await t.test(name, async (subtest) => {
      const options = await fixture(subtest, csv, []);
      await assert.rejects(readVersionSets(options.csvFile, options.projectUid), expected);
    });
  }
});

test('rejects missing, ambiguous, unlisted, empty, corrupt, and unsafe drawing contents', async (t) => {
  const name = 'Project/Drawings/Bid Set - 7-22-2025/A.pdf';
  const cases: Array<[string, FixtureEntry[], RegExp]> = [
    ['no drawings', [{ name: 'Project/Documents/A.pdf' }], /Drawings directory/],
    ['missing version', [{ name: 'Project/Drawings/Current/A.pdf' }], /matched 0/],
    ['ambiguous version', [{ name }, { name: 'Project/Drawings/version-1/A.pdf' }], /matched 2/],
    ['unlisted folder', [{ name }, { name: 'Project/Drawings/Extra/A.pdf' }], /missing from the project CSV/],
    ['empty file', [{ name, contents: '' }], /Empty drawing file/],
    ['empty folder', [{ name: 'Project/Drawings/Bid Set - 7-22-2025/', contents: '' }], /contains no drawing files/],
    ['corrupt file', [{ name, corrupt: true }], /CRC mismatch/],
    ['duplicate entry', [{ name }, { name }], /Duplicate ZIP entry/],
    ['case collision', [{ name }, { name: name.replace('A.pdf', 'a.pdf') }], /Colliding drawing paths/],
    ['symlink', [{ name, symlink: true }], /Unsupported ZIP entry/],
    ['path traversal', [{ name: 'Project/Drawings/Bid Set - 7-22-2025/../../escape.pdf' }], /invalid relative path/],
  ];
  for (const [label, entries, expected] of cases) {
    await t.test(label, async (subtest) => {
      const options = await fixture(subtest, `${headers}\n${first}`, entries);
      await assert.rejects(prepareImport(options, quietLogger), expected);
      const runs = await fs.readdir(options.outputRoot).catch(() => []);
      for (const run of runs) {
        await assert.rejects(fs.access(path.join(options.outputRoot, run, 'import-plan.json')));
      }
    });
  }
});
