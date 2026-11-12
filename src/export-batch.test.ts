import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'csv-parse/sync';
import { parseExportOptions, selectExportProjects } from './export-selection.js';
import { ExportRun, readRetrySource, retryCommand, type ExportRunReport } from './export-run.js';
import { readProjects } from './csv.js';
import type { Project, ProjectResult } from './types.js';

function project(index: number, enabled = true): Project {
  return {
    projectUid: '', projectName: ` Project "${index}", exact name `,
    projectCleanName: `Project-${index}`, enabled,
    startDate: '2025-01-01', endDate: '2026-11-12',
  };
}

async function fixture(t: TestContext, projects: Project[] = [project(1), project(2), project(3)]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'export-batch-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputFile = path.join(root, 'projects.csv');
  await fs.writeFile(inputFile, 'untouched input fixture');
  const options = { runsRoot: path.join(root, 'runs'), inputFile, logFile: path.join(root, 'export.log') };
  const selection = selectExportProjects(projects, { runType: 'batch', skip: 0, limit: 50 });
  return { root, projects, options, selection, run: await ExportRun.create({ ...options, selection }) };
}

async function report(run: ExportRun): Promise<ExportRunReport> {
  return JSON.parse(await fs.readFile(run.reportPath, 'utf8'));
}

function result(project: Project, status: ProjectResult['status']): ProjectResult {
  return {
    project, status, durationMs: 25,
    errorType: status === 'FAILED' ? 'PROJECT_NOT_FOUND' : undefined,
    message: status === 'FAILED' ? 'Not found, with "quotes"\nand a new line\nCall log:\n  - waiting for locator("project")' : 'Done',
  };
}

test('batch arguments default to all enabled projects and override environment independently', () => {
  assert.deepEqual(parseExportOptions([], {}), { runType: 'batch', skip: 0, limit: undefined });
  assert.deepEqual(parseExportOptions([], { BATCH_SKIP: ' 50 ', BATCH_LIMIT: '100' }),
    { runType: 'batch', skip: 50, limit: 100 });
  assert.deepEqual(parseExportOptions(['--connect-chrome', '--skip', '100'], { BATCH_SKIP: 'bad', BATCH_LIMIT: '50' }),
    { runType: 'batch', skip: 100, limit: 50 });
  assert.deepEqual(parseExportOptions(['--headless', '--offset=50', '--limit=10'], { BATCH_SKIP: '0', BATCH_LIMIT: 'bad' }),
    { runType: 'batch', skip: 50, limit: 10 });
  assert.deepEqual(parseExportOptions([], { BATCH_SKIP: '', BATCH_LIMIT: ' ' }),
    { runType: 'batch', skip: 0, limit: undefined });
});

test('malformed, ambiguous, and unknown batch arguments are rejected', () => {
  for (const args of [
    ['--skip', '-1'], ['--limit', '0'], ['--limit', '-1'], ['--skip', '1.5'], ['--limit', '1e2'],
    ['--skip', '9007199254740992'], ['--limit', 'Infinity'], ['--skip'], ['--limit='],
    ['--skip', '--limit', '50'], ['--skip', '1', '--offset', '2'], ['--limit', '5', '--limit=10'],
    ['--limti', '50'], ['unexpected'], ['--retry-failed'], ['--retry-failed', 'a', '--retry-failed', 'b'],
    ['--retry-failed', 'results.json', '--skip', '0'], ['--retry-failed=results.json', '--limit=50'],
  ]) assert.throws(() => parseExportOptions(args, {}), Error, args.join(' '));
  assert.throws(() => parseExportOptions([], { BATCH_SKIP: '-1' }), /non-negative/);
  assert.throws(() => parseExportOptions([], { BATCH_LIMIT: '0' }), /positive/);
  assert.deepEqual(parseExportOptions(['--retry-failed', 'runs/report with spaces/results.json'], {
    BATCH_SKIP: 'invalid', BATCH_LIMIT: '-10',
  }), { runType: 'retry', reportPath: 'runs/report with spaces/results.json' });
});

test('offset counts enabled projects, preserves exact names and positions, and does not change the source', () => {
  const projects = [project(1, false), project(2), project(3, false), project(4), project(5), project(6)];
  const before = structuredClone(projects);
  const selected = selectExportProjects(projects, { runType: 'batch', skip: 1, limit: 2 });
  assert.deepEqual(selected.entries.map(({ project }) => project), [projects[3], projects[4]]);
  assert.deepEqual(selected.entries.map(({ csvPosition, enabledPosition }) => [csvPosition, enabledPosition]), [[4, 2], [5, 3]]);
  assert.equal(selected.csvTotal, 6);
  assert.equal(selected.enabledTotal, 4);
  assert.equal(selected.entries[0].project.projectName, ' Project "4", exact name ');
  assert.deepEqual(projects, before);
  assert.equal(selectExportProjects(projects, { runType: 'batch', skip: 4, limit: 50 }).entries.length, 0);
  assert.equal(selectExportProjects(projects, { runType: 'batch', skip: 2 }).entries.length, 2);
  assert.equal(selectExportProjects([], { runType: 'batch', skip: 0 }).entries.length, 0);
  assert.equal(selectExportProjects([project(1, false)], { runType: 'batch', skip: 0 }).entries.length, 0);
});

test('run snapshots persist before execution, after each outcome, and across separate retries', async (t) => {
  const { run, projects, options } = await fixture(t);
  const initial = await report(run);
  assert.match(initial.runId, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z_batch_skip-0_limit-50_[a-f0-9]{8}$/);
  assert.equal(initial.rootRunId, initial.runId);
  assert.equal(initial.status, 'RUNNING');
  assert.deepEqual(initial.summary, { selected: 3, success: 0, failed: 0, skipped: 0, pending: 3, inProgress: 0, interrupted: 0 });
  for (const [index, current] of projects.entries()) {
    await run.execute(index, async () => {
      const during = await report(run);
      assert.equal(during.projects[index].status, 'IN_PROGRESS');
      assert.equal(during.summary.pending, projects.length - index - 1);
      assert.equal(during.projects.filter(({ status }) => status === 'SUCCESS' || status === 'FAILED').length, index);
      return result(current, index === 0 ? 'SUCCESS' : 'FAILED');
    });
    assert.equal((await report(run)).projects[index].status, index === 0 ? 'SUCCESS' : 'FAILED');
  }
  await run.finish();
  const original = await fs.readFile(run.reportPath, 'utf8');
  assert.equal((await report(run)).summary.failed, 2);
  assert.equal((await report(run)).status, 'COMPLETED');
  assert.ok((await report(run)).completedAt);
  const failedRows = parse(await fs.readFile(run.failedCsvPath, 'utf8'), { columns: true }) as Record<string, string>[];
  assert.equal(failedRows.length, 2);
  assert.deepEqual(failedRows[0], {
    project_uid: projects[1].projectUid,
    project_name: projects[1].projectName,
    project_clean_name: projects[1].projectCleanName,
    enabled: 'true',
    start_date: projects[1].startDate,
    end_date: projects[1].endDate,
  });
  assert.equal((await report(run)).projects[1].message, result(projects[1], 'FAILED').message);
  assert.equal((await report(run)).projects[1].errorType, 'PROJECT_NOT_FOUND');
  assert.equal((await fs.readFile(run.failedCsvPath, 'utf8')).includes('Call log:'), false);
  assert.deepEqual(failedRows.map((row: Record<string, string>) => row.project_clean_name), ['Project-2', 'Project-3']);

  // A later CSV may be reordered and contain corrected details. Match by clean name, never row number or blank UID.
  const currentProjects = [projects[2], { ...projects[1], projectName: ' Corrected name ', endDate: '2026-11-13' }, projects[0]];
  const retrySource = await readRetrySource(run.reportPath);
  const selection = selectExportProjects(currentProjects, { runType: 'retry', reportPath: run.reportPath }, retrySource);
  assert.deepEqual(selection.entries.map(({ project }) => project.projectCleanName), ['Project-2', 'Project-3']);
  assert.equal(selection.entries[0].project.projectName, ' Corrected name ');
  assert.equal(selection.entries[0].project.endDate, '2026-11-13');
  const retry = await ExportRun.create({ ...options, selection });
  assert.notEqual(retry.report.runId, run.report.runId);
  assert.match(retry.report.runId, /Z_retry_[a-f0-9]{8}$/);
  assert.equal(retry.report.parentRunId, run.report.runId);
  assert.equal(retry.report.rootRunId, run.report.runId);
  assert.equal(retry.report.selection.skip, undefined);
  for (const [index, entry] of selection.entries.entries()) {
    await retry.execute(index, async () => result(entry.project, index === 0 ? 'SUCCESS' : 'FAILED'));
  }
  await retry.finish();
  const source2 = await readRetrySource(retry.reportPath);
  assert.deepEqual(source2.failedCleanNames, ['Project-3']);
  const selection2 = selectExportProjects(currentProjects, { runType: 'retry', reportPath: retry.reportPath }, source2);
  const retry2 = await ExportRun.create({ ...options, selection: selection2 });
  assert.equal(retry2.report.parentRunId, retry.report.runId);
  assert.equal(retry2.report.rootRunId, run.report.runId);
  await retry2.execute(0, async () => result(selection2.entries[0].project, 'SUCCESS'));
  await retry2.finish();
  assert.deepEqual((await readRetrySource(retry2.reportPath)).failedCleanNames, []);
  assert.equal(await fs.readFile(run.reportPath, 'utf8'), original);
  assert.equal(await fs.readFile(options.inputFile, 'utf8'), 'untouched input fixture');
  assert.deepEqual((await fs.readdir(run.directory)).sort(), ['failed-projects.csv', 'results.json']);
});

test('aborted and abruptly stopped runs preserve completed outcomes and separate unfinished projects', async (t) => {
  const { run, projects } = await fixture(t);
  await run.execute(0, async () => result(projects[0], 'FAILED'));
  await assert.rejects(run.execute(1, async () => { throw new Error('Browser disconnected'); }), /Browser disconnected/);
  const during = await report(run);
  assert.deepEqual(during.projects.map(({ status }) => status), ['FAILED', 'IN_PROGRESS', 'PENDING']);
  // This on-disk state is also what remains after a hard stop; explicit FAILED records alone are retryable.
  assert.equal((await readRetrySource(run.reportPath)).unfinishedProjects, 2);
  assert.deepEqual((await readRetrySource(run.reportPath)).failedCleanNames, ['Project-1']);
  await run.finish(true);
  const ended = await report(run);
  assert.equal(ended.status, 'ABORTED');
  assert.deepEqual(ended.projects.map(({ status }) => status), ['FAILED', 'INTERRUPTED', 'PENDING']);
  assert.equal(ended.summary.interrupted, 1);
  assert.equal(ended.summary.pending, 1);
  assert.deepEqual((await readRetrySource(run.reportPath)).failedCleanNames, ['Project-1']);
  await assert.rejects(run.execute(2, async () => result(projects[2], 'SUCCESS')), /pending project/);
});

test('startup failures leave pending projects, and empty selections can finish without any actions', async (t) => {
  const { run, options } = await fixture(t);
  await assert.rejects(run.finish(), /unfinished/);
  await run.finish(true);
  assert.equal((await report(run)).summary.pending, 3);
  const selection = selectExportProjects([], { runType: 'batch', skip: 100, limit: 50 });
  const empty = await ExportRun.create({ ...options, selection });
  await empty.finish();
  assert.equal((await report(empty)).status, 'COMPLETED');
  assert.equal((await report(empty)).summary.selected, 0);
  assert.equal(await fs.readFile(empty.failedCsvPath, 'utf8'),
    'project_uid,project_name,project_clean_name,enabled,start_date,end_date\r\n');
  assert.deepEqual((await readRetrySource(empty.reportPath)).failedCleanNames, []);
});

test('retry fails safely for missing or disabled records, without changing source data', async (t) => {
  const { run, projects } = await fixture(t);
  await run.execute(0, async () => result(projects[0], 'FAILED'));
  const source = await readRetrySource(run.reportPath);
  const options = { runType: 'retry' as const, reportPath: run.reportPath };
  assert.throws(() => selectExportProjects(projects.slice(1), options, source), /missing or disabled/);
  assert.throws(() => selectExportProjects([{ ...projects[0], enabled: false }, ...projects.slice(1)], options, source), /missing or disabled/);
  assert.throws(() => selectExportProjects([projects[0], projects[0]], options, source), /unique/);
});

test('invalid reports and duplicate identities cannot select projects for retry', async (t) => {
  const { root, run } = await fixture(t);
  const original = await report(run);
  const badPath = path.join(root, 'bad.json');
  for (const value of [
    null, {}, [], { ...original, schemaVersion: 2 }, { ...original, kind: 'other' },
    { ...original, runId: '' }, { ...original, rootRunId: '' }, { ...original, projects: [{}] },
    { ...original, projects: [{ project: { projectCleanName: '' }, status: 'FAILED' }] },
    { ...original, projects: [{ project: { projectCleanName: 'Project-1' }, status: 'UNKNOWN' }] },
    { ...original, projects: [original.projects[0], original.projects[0]] },
  ]) {
    await fs.writeFile(badPath, JSON.stringify(value));
    await assert.rejects(readRetrySource(badPath), /Invalid|Duplicate/);
  }
  await fs.writeFile(badPath, '{');
  await assert.rejects(readRetrySource(badPath), /Cannot read/);
  await assert.rejects(readRetrySource(path.join(root, 'missing.json')), /Cannot read/);
});

test('report persistence failure prevents the export action and leaves previous JSON readable', async (t) => {
  const { run, projects } = await fixture(t);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === run.reportPath) throw new Error('Report drive is unavailable');
    return rename(source, destination);
  });
  let calls = 0;
  await assert.rejects(run.execute(0, async () => { calls += 1; return result(projects[0], 'SUCCESS'); }), /unavailable/);
  assert.equal(calls, 0);
  assert.equal((await report(run)).projects[0].status, 'PENDING');
  assert.deepEqual((await fs.readdir(run.directory)).sort(), ['failed-projects.csv', 'results.json']);
  mock.mock.restore();
  await run.finish(true);
});

test('CSV report failure also stops execution, while the authoritative JSON retains the last result', async (t) => {
  const { run, projects } = await fixture(t);
  const rename = fs.rename;
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === run.failedCsvPath && calls > 0) throw new Error('CSV report is locked');
    return rename(source, destination);
  });
  await assert.rejects(run.execute(0, async () => { calls += 1; return result(projects[0], 'FAILED'); }), /locked/);
  assert.equal(calls, 1);
  assert.equal((await report(run)).projects[0].status, 'FAILED');
  mock.mock.restore();
  await run.finish(true);
});

test('failure CSV contains only project data, preserves exact names, and retry commands support all export modes', async (t) => {
  const current = { ...project(1), projectName: ' \tQuoted "project", with\nnewline ' };
  const { root, run } = await fixture(t, [current]);
  await run.execute(0, async () => result(current, 'FAILED'));
  const parsed = await readProjects(run.failedCsvPath);
  assert.deepEqual(parsed, [current]);
  const rows = parse(await fs.readFile(run.failedCsvPath, 'utf8')) as string[][];
  assert.deepEqual(rows[0], ['project_uid', 'project_name', 'project_clean_name', 'enabled', 'start_date', 'end_date']);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.length === 6));
  assert.match((await report(run)).projects[0].message ?? '', /\nCall log:\n/);
  const quotedPath = path.join(root, 'report with spaces', 'results.json');
  assert.match(retryCommand(quotedPath, 'chrome'), /^npm run export:chrome -- --retry-failed ".*report with spaces\/results.json"$/);
  assert.match(retryCommand('runs\\a\\results.json', 'visible'), /^npm run export -- --retry-failed "runs\/a\/results.json"$/);
  assert.match(retryCommand('runs/a/results.json', 'headless'), /^npm run headless -- --retry-failed/);
});
