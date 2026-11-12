import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import timers from 'node:timers/promises';
import { parse } from 'csv-parse/sync';
import { parseExportOptions, selectExportProjects } from './export-selection.js';
import { ExportRun, ReportWriteError, readRetrySource, resolveRetryReportPath, retryCommand, type ExportRunReport } from './export-run.js';
import { logRunReport } from './export-summary.js';
import { logger, type LogContext } from './logger.js';
import { readProjectInput, readProjects } from './csv.js';
import type { ExportErrorType, Project, ProjectResult } from './types.js';

function project(index: number, enabled = true): Project {
  return {
    projectUid: '', projectName: ` Project "${index}", exact name `,
    projectCleanName: `Project-${index}`, enabled,
    startDate: '2025-01-01', endDate: '2026-11-12',
    excelName: ` Excel "${index}", reference `,
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

function reportLogs(t: TestContext) {
  const logs: { level: string; message: string; context?: LogContext }[] = [];
  for (const level of ['general', 'info', 'warn', 'error'] as const) {
    t.mock.method(logger, level, (message: string, context?: LogContext) => logs.push({ level, message, context }));
  }
  const delays: number[] = [];
  t.mock.method(timers, 'setTimeout', async (delayMs: number) => { delays.push(delayMs); });
  return { logs, delays };
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

test('simple key=value arguments match existing batch and retry flags', () => {
  for (const [simple, flags] of [
    [['skip=50', 'limit=100'], ['--skip', '50', '--limit', '100']],
    [['offset=0', 'limit=50'], ['--offset=0', '--limit=50']],
    [['retry=runs/a report/results.json'], ['--retry-failed', 'runs/a report/results.json']],
  ]) {
    assert.deepEqual(parseExportOptions(simple, {}), parseExportOptions(flags, {}));
  }
  assert.deepEqual(parseExportOptions(['--connect-chrome', 'skip=100'], { BATCH_SKIP: 'invalid', BATCH_LIMIT: '50' }),
    { runType: 'batch', skip: 100, limit: 50 });
  assert.deepEqual(parseExportOptions(['limit=10'], { BATCH_SKIP: '50', BATCH_LIMIT: 'invalid' }),
    { runType: 'batch', skip: 50, limit: 10 });
  assert.deepEqual(parseExportOptions(['retry=runs/a=b/results.json'], { BATCH_SKIP: 'invalid', BATCH_LIMIT: 'invalid' }),
    { runType: 'retry', reportPath: 'runs/a=b/results.json' });
  for (const args of [
    ['skip=1', '--offset=2'], ['limit=10', '--limit', '20'], ['retry=a', '--retry-failed', 'b'],
    ['skip=-1'], ['limit=0'], ['limit='], ['retry='], ['skpi=50'], ['skip', '50'],
    ['retry=a', 'limit=10'], ['retry=a', '--skip', '0'], ['--retry-failed', 'a', 'offset=1'],
  ]) assert.throws(() => parseExportOptions(args, {}), Error, args.join(' '));
});

test('npm forwards simple batch and retry arguments without a separator', async (t) => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !/(?:^|[/\\])npm-cli\.js$/.test(npmCli)) {
    t.skip('Run through npm run test:export to verify npm argument forwarding');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'export-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true, scripts: { arguments: 'node print-arguments.cjs' },
  }));
  await fs.writeFile(path.join(root, 'print-arguments.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  for (const args of [['skip=50', 'limit=100'], ['retry=runs/report with spaces/results.json'], ['retry=2026-11-13_10-00-00-123Z_retry_a1b2c3d4']]) {
    const executed: SpawnSyncReturns<string> = spawnSync(process.execPath, [npmCli, '--prefix', root, '--silent', 'run', 'arguments', ...args], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(executed.status, 0, executed.stderr);
    const forwarded: string[] = JSON.parse(executed.stdout);
    assert.deepEqual(forwarded, args);
    assert.deepEqual(parseExportOptions(forwarded, {}), parseExportOptions(args, {}));
  }
});

test('retry run IDs resolve inside runs while existing JSON report paths remain supported', async (t) => {
  const { root, options } = await fixture(t);
  const locations = { projectRoot: root, runsRoot: options.runsRoot };
  for (const runId of [
    '2026-11-13_10-00-00-123Z_batch_skip-0_limit-50_a1b2c3d4',
    '2026-11-13_11-00-00-456Z_retry_e5f6a7b8',
  ]) {
    for (const args of [[`retry=${runId}`], ['--retry-failed', runId]]) {
      const parsed = parseExportOptions(args, { BATCH_SKIP: 'invalid', BATCH_LIMIT: 'invalid' });
      assert.equal(parsed.runType, 'retry');
      if (parsed.runType !== 'retry') assert.fail('Expected retry mode');
      assert.equal(resolveRetryReportPath(parsed.reportPath, locations), path.join(options.runsRoot, runId, 'results.json'));
    }
    assert.equal(retryCommand(runId, 'chrome'), `npm run export:chrome retry="${runId}"`);
    assert.equal(retryCommand(runId, 'visible'), `npm run export retry="${runId}"`);
    assert.equal(retryCommand(runId, 'headless'), `npm run headless retry="${runId}"`);
  }
  for (const reportPath of ['results.json', 'results.JSON', 'runs/a report/results.json', './custom-report', path.join(root, 'external', 'results.json')]) {
    assert.equal(resolveRetryReportPath(reportPath, locations), path.resolve(root, reportPath));
  }
  for (const invalid of ['', '.', '..', 'run id with spaces', 'invalid:id']) {
    assert.throws(() => resolveRetryReportPath(invalid, locations), /run ID.*JSON results report/);
  }
  const missing = resolveRetryReportPath('missing-run-id', locations);
  await assert.rejects(readRetrySource(missing), /Cannot read a valid JSON retry report/);
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
  const { root, run, projects, options } = await fixture(t);
  const locations = { projectRoot: root, runsRoot: options.runsRoot };
  const initial = await report(run);
  assert.match(initial.runId, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z_batch_skip-0_limit-50_[a-f0-9]{8}$/);
  assert.equal(initial.rootRunId, initial.runId);
  assert.equal(initial.status, 'RUNNING');
  assert.deepEqual(initial.executionSummary, { selected: 3, success: 0, failed: 0, skipped: 0, pending: 3, inProgress: 0, interrupted: 0 });
  for (const [index, current] of projects.entries()) {
    await run.execute(index, async () => {
      const during = await report(run);
      assert.equal(during.projects[index].status, 'IN_PROGRESS');
      assert.equal(during.executionSummary.pending, projects.length - index - 1);
      assert.equal(during.projects.filter(({ status }) => status === 'SUCCESS' || status === 'FAILED').length, index);
      return result(current, index === 0 ? 'SUCCESS' : 'FAILED');
    });
    assert.equal((await report(run)).projects[index].status, index === 0 ? 'SUCCESS' : 'FAILED');
  }
  await run.finish();
  const original = await fs.readFile(run.reportPath, 'utf8');
  assert.equal((await report(run)).executionSummary.failed, 2);
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
    excel_name: projects[1].excelName,
    error: 'PROJECT_NOT_FOUND',
  });
  assert.equal((await report(run)).projects[1].message, result(projects[1], 'FAILED').message);
  assert.equal((await report(run)).projects[1].errorType, 'PROJECT_NOT_FOUND');
  assert.equal((await fs.readFile(run.failedCsvPath, 'utf8')).includes('Call log:'), false);
  assert.deepEqual(failedRows.map((row: Record<string, string>) => row.project_clean_name), ['Project-2', 'Project-3']);

  // A later CSV may be reordered and contain corrected details. Match by clean name, never row number or blank UID.
  const currentProjects = [projects[2], { ...projects[1], projectName: ' Corrected name ', endDate: '2026-11-13' }, projects[0]];
  const retrySource = await readRetrySource(resolveRetryReportPath(run.report.runId, locations));
  const selection = selectExportProjects(currentProjects, parseExportOptions([`retry=${run.report.runId}`], {}), retrySource);
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
  const source2 = await readRetrySource(resolveRetryReportPath(retry.report.runId, locations));
  assert.deepEqual(source2.failedCleanNames, ['Project-3']);
  const selection2 = selectExportProjects(currentProjects, parseExportOptions([`retry=${retry.report.runId}`], {}), source2);
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
  assert.equal(ended.executionSummary.interrupted, 1);
  assert.equal(ended.executionSummary.pending, 1);
  assert.deepEqual((await readRetrySource(run.reportPath)).failedCleanNames, ['Project-1']);
  await assert.rejects(run.execute(2, async () => result(projects[2], 'SUCCESS')), /pending project/);
});

test('startup failures leave pending projects, and empty selections can finish without any actions', async (t) => {
  const { run, options } = await fixture(t);
  await assert.rejects(run.finish(), /unfinished/);
  await run.finish(true);
  assert.equal((await report(run)).executionSummary.pending, 3);
  const selection = selectExportProjects([], { runType: 'batch', skip: 100, limit: 50 });
  const empty = await ExportRun.create({ ...options, selection });
  await empty.finish();
  assert.equal((await report(empty)).status, 'COMPLETED');
  assert.equal((await report(empty)).executionSummary.selected, 0);
  assert.equal(await fs.readFile(empty.failedCsvPath, 'utf8'),
    'project_uid,project_name,project_clean_name,enabled,start_date,end_date,excel_name,error\r\n');
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

test('temporary report locks recover without repeating exports or changing failure CSV contents', async (t) => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    await t.test(code, async (t) => {
      const { run, projects } = await fixture(t);
      const { logs, delays } = reportLogs(t);
      const rename = fs.rename;
      let actions = 0;
      let lockedAttempts = 0;
      t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
        if (destination === run.failedCsvPath && actions === 1 && lockedAttempts++ < 2) {
          throw Object.assign(new Error('Report file is open'), { code });
        }
        return rename(source, destination);
      });
      await run.execute(0, async () => { actions += 1; return result(projects[0], 'FAILED'); });
      await run.execute(1, async () => { actions += 1; return result(projects[1], 'SUCCESS'); });
      assert.equal(actions, 2);
      assert.deepEqual(delays, [1_000, 2_000]);
      assert.deepEqual(run.persistence, { json: true, csv: true });
      assert.deepEqual((await report(run)).projects.map(({ status }) => status), ['FAILED', 'SUCCESS', 'PENDING']);
      const failures = parse(await fs.readFile(run.failedCsvPath, 'utf8'), { columns: true }) as Record<string, string>[];
      assert.deepEqual(failures.map(({ project_clean_name }) => project_clean_name), ['Project-1']);
      assert.ok(logs.some(({ context }) => context?.filePath === run.failedCsvPath && context?.code === code));
      assert.ok(logs.some(({ message }) => message === 'Run report saved after retrying file access'));
      assert.deepEqual((await fs.readdir(run.directory)).sort(), ['failed-projects.csv', 'results.json']);
    });
  }
});

test('persistent CSV locks preserve the latest success in JSON and log every known failure even if abort saving fails', async (t) => {
  const { run, projects } = await fixture(t, [project(1), project(2), project(3), project(4)]);
  const { logs, delays } = reportLogs(t);
  await run.execute(0, async () => result(projects[0], 'FAILED'));
  await run.execute(1, async () => result(projects[1], 'FAILED'));
  const previousCsv = await fs.readFile(run.failedCsvPath, 'utf8');
  const rename = fs.rename;
  let actions = 0;
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === run.failedCsvPath && actions > 0) {
      throw Object.assign(new Error('Report file is open'), { code: 'EPERM' });
    }
    return rename(source, destination);
  });
  await assert.rejects(run.execute(2, async () => { actions += 1; return result(projects[2], 'SUCCESS'); }), (error: unknown) => {
    assert.ok(error instanceof ReportWriteError);
    assert.equal(error.filePath, run.failedCsvPath);
    assert.equal(error.code, 'EPERM');
    assert.match(error.message, /Close this run's CSV and JSON/);
    return true;
  });
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  assert.equal(actions, 1);
  assert.deepEqual(run.persistence, { json: true, csv: false });
  await assert.rejects(run.execute(3, async () => { actions += 1; return result(projects[3], 'SUCCESS'); }), /reports must be saved/);
  assert.equal(actions, 1, 'A report failure must prevent the next export');
  await assert.rejects(run.finish(true), ReportWriteError);
  logRunReport(run, 'chrome', true);
  const saved = await report(run);
  assert.equal(saved.status, 'ABORTED');
  assert.deepEqual(saved.projects.map(({ status }) => status), ['FAILED', 'FAILED', 'SUCCESS', 'PENDING']);
  assert.equal(await fs.readFile(run.failedCsvPath, 'utf8'), previousCsv);
  assert.deepEqual(logs.filter(({ message }) => message === 'Failed project in stopped run')
    .map(({ context }) => context?.projectCleanName), ['Project-1', 'Project-2']);
  const summary = logs.find(({ message }) => message === 'Export run report')?.context;
  assert.equal(summary?.success, 1);
  assert.equal(summary?.pending, 1);
  assert.equal(summary?.resultsJsonUpdated, true);
  assert.equal(summary?.failedCsvUpdated, false);
  assert.ok(logs.some(({ context }) => String(context?.instruction).includes('results.json is current')));
  assert.ok(logs.some(({ context }) => context?.command === retryCommand(run.report.runId, 'chrome')));
  assert.deepEqual((await fs.readdir(run.directory)).sort(), ['failed-projects.csv', 'results.json']);
});

test('a locked JSON report prevents the next action and logs unsaved failures without a misleading retry command', async (t) => {
  const { run, projects } = await fixture(t);
  const { logs, delays } = reportLogs(t);
  await run.execute(0, async () => result(projects[0], 'FAILED'));
  const before = await fs.readFile(run.reportPath, 'utf8');
  const rename = fs.rename;
  let actions = 0;
  let blockedAttempts = 0;
  const mock = t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === run.reportPath && actions > 0) {
      blockedAttempts += 1;
      throw Object.assign(new Error('JSON report is open'), { code: 'EBUSY' });
    }
    return rename(source, destination);
  });
  await assert.rejects(run.execute(1, async () => { actions += 1; return result(projects[1], 'FAILED'); }), ReportWriteError);
  await assert.rejects(run.execute(2, async () => { actions += 1; return result(projects[2], 'SUCCESS'); }), /reports must be saved/);
  assert.equal(actions, 1);
  assert.equal(blockedAttempts, 5);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  await assert.rejects(run.finish(true), ReportWriteError);
  logRunReport(run, 'chrome', true);
  // The on-disk IN_PROGRESS state predates the failed final save for the second project.
  assert.notEqual(await fs.readFile(run.reportPath, 'utf8'), before);
  assert.deepEqual((await report(run)).projects.map(({ status }) => status), ['FAILED', 'IN_PROGRESS', 'PENDING']);
  assert.deepEqual(logs.filter(({ message }) => message === 'Failed project in stopped run')
    .map(({ context }) => context?.projectCleanName), ['Project-1', 'Project-2']);
  assert.ok(logs.some(({ context }) => String(context?.instruction).includes('results.json may be stale')));
  assert.equal(logs.some(({ context }) => context?.command), false);
  assert.deepEqual((await fs.readdir(run.directory)).sort(), ['failed-projects.csv', 'results.json']);
  mock.mock.restore();
  await run.finish(true);
  assert.equal((await report(run)).status, 'ABORTED');
  assert.deepEqual((await readRetrySource(run.reportPath)).failedCleanNames, ['Project-1', 'Project-2']);
});

test('unrecoverable report writes stop immediately and keep the original error if temporary cleanup also fails', async (t) => {
  const { run, projects } = await fixture(t);
  const { logs, delays } = reportLogs(t);
  const previous = await fs.readFile(run.reportPath, 'utf8');
  const writeFile = fs.writeFile;
  const rm = fs.rm;
  const writeMock = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(run.reportPath)) {
      throw Object.assign(new Error('Disk is full'), { code: 'ENOSPC' });
    }
    return writeFile(...args);
  });
  const cleanupMock = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).startsWith(run.reportPath)) throw new Error('Cleanup access denied');
    return rm(...args);
  });
  let actions = 0;
  await assert.rejects(run.execute(0, async () => { actions += 1; return result(projects[0], 'SUCCESS'); }), (error: unknown) => {
    assert.ok(error instanceof ReportWriteError);
    assert.equal(error.filePath, run.reportPath);
    assert.equal(error.code, 'ENOSPC');
    assert.match(error.message, /Disk is full/);
    assert.match(error.message, /available disk space/);
    return true;
  });
  assert.equal(actions, 0);
  assert.deepEqual(delays, []);
  assert.equal(await fs.readFile(run.reportPath, 'utf8'), previous);
  assert.ok(logs.some(({ message }) => message === 'Could not remove temporary run-report file'));
  writeMock.mock.restore();
  cleanupMock.mock.restore();
  await run.finish(true);
});

test('a failed completion save can still be finalized as aborted after file access recovers', async (t) => {
  const { run, projects } = await fixture(t, [project(1)]);
  reportLogs(t);
  await run.execute(0, async () => result(projects[0], 'SUCCESS'));
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === run.failedCsvPath) throw Object.assign(new Error('Report file is open'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await assert.rejects(run.finish(), ReportWriteError);
  mock.mock.restore();
  await run.finish(true);
  assert.equal((await report(run)).status, 'ABORTED');
  assert.equal((await report(run)).projects[0].status, 'SUCCESS');
});

test('failure CSV preserves project metadata with classified errors, and retry commands support all export modes', async (t) => {
  const current = { ...project(1), projectName: ' \tQuoted "project", with\nnewline ' };
  const { root, run } = await fixture(t, [current]);
  await run.execute(0, async () => result(current, 'FAILED'));
  const parsed = await readProjects(run.failedCsvPath);
  assert.deepEqual(parsed, [current]);
  const rows = parse(await fs.readFile(run.failedCsvPath, 'utf8')) as string[][];
  assert.deepEqual(rows[0], ['project_uid', 'project_name', 'project_clean_name', 'enabled', 'start_date', 'end_date', 'excel_name', 'error']);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.length === 8));
  assert.match((await report(run)).projects[0].message ?? '', /\nCall log:\n/);
  const quotedPath = path.join(root, 'report with spaces', 'results.json');
  assert.match(retryCommand(quotedPath, 'chrome'), /^npm run export:chrome retry=".*report with spaces\/results.json"$/);
  assert.match(retryCommand('runs\\a\\results.json', 'visible'), /^npm run export retry="runs\/a\/results.json"$/);
  assert.match(retryCommand('runs/a/results.json', 'headless'), /^npm run headless retry=/);
});

test('failure CSV error cells contain only known classifications or UNKNOWN, never messages or call logs', async (t) => {
  const cases: { value: string | undefined; expected: string }[] = [
    ...[
      'PROJECTS_PAGE_ERROR', 'PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_SELECTION_ERROR',
      'EXPORT_FORM_ERROR', 'BUILD_IDENTITY_ERROR', 'BUILD_FAILED', 'BUILD_ERROR', 'BUILD_CANCELLED',
      'BUILD_MONITORING_ERROR', 'DOWNLOAD_ERROR', 'DOWNLOAD_CLEANUP_ERROR',
    ].map((value) => ({ value, expected: value })),
    { value: undefined, expected: 'UNKNOWN' },
    { value: 'UNKNOWN_ERROR', expected: 'UNKNOWN' },
    { value: 'UNRECOGNIZED_CODE', expected: 'UNKNOWN' },
    { value: 'PROJECT_NOT_FOUND\nCall log:\n  - waiting for locator', expected: 'UNKNOWN' },
    { value: 'Error, refer to logs', expected: 'UNKNOWN' },
  ];
  const projects = cases.map((_, index) => project(index));
  // Older inputs without excel_name remain supported and produce a blank metadata cell.
  delete projects[0].excelName;
  const { run } = await fixture(t, projects);
  for (const [index, current] of projects.entries()) {
    await run.execute(index, async () => ({
      ...result(current, 'FAILED'), errorType: cases[index].value as ExportErrorType | undefined,
    }));
  }
  await run.finish();
  const raw = await fs.readFile(run.failedCsvPath, 'utf8');
  const rows = parse(raw, { columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map((row) => row.error), cases.map(({ expected }) => expected));
  assert.ok(rows.every((row) => /^[A-Z_]+$/.test(row.error)));
  assert.equal(rows[0].excel_name, '');
  assert.equal(raw.includes('Call log:'), false);
  assert.equal(raw.trimEnd().split(/\r\n|\r|\n/).length, projects.length + 1);
  assert.match((await report(run)).projects[0].message ?? '', /Call log:/);
  assert.deepEqual((await readRetrySource(run.reportPath)).failedCleanNames, projects.map(({ projectCleanName }) => projectCleanName));
});

test('failure CSV mirrors all input columns and values across batching, empty runs, and reordered retry inputs', async (t) => {
  const columns = ['project_uid', 'project_name', 'project_clean_name', 'excel_name', 'enabled', 'start_date', 'end_date', 'action', 'sheets_count'];
  for (const headers of [columns, ['error', ...columns.slice().reverse(), 'custom,"reference"']]) {
    await t.test(headers.join(','), async (subtest) => {
      const { options } = await fixture(subtest, []);
      const records: Record<string, string>[] = [0, 1, 2].map((index) => ({
        project_uid: ` uid-${index} `,
        project_name: ` Project "${index}", exact name `,
        project_clean_name: ` Project-${index} `,
        excel_name: ` Excel, "${index}" `,
        enabled: index === 0 ? 'false' : ' TRUE ',
        start_date: ' 2025-01-01 ',
        end_date: '',
        action: ' Migrate, "final" ',
        sheets_count: `000${index}`,
        'custom,"reference"': '',
        error: 'Old diagnostic\nCall log:\n  - this must not enter the new error cell',
      }));
      const encode = (fields: string[], rows: Record<string, string>[]) => [fields, ...rows.map((record) => fields.map((field) => record[field]))]
        .map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const originalInput = encode(headers, records);
      await fs.writeFile(options.inputFile, originalInput);
      const input = await readProjectInput(options.inputFile);
      const selection = selectExportProjects(input.projects, { runType: 'batch', skip: 0, limit: 2 });
      assert.deepEqual(selection.entries.map(({ project }) => project.projectCleanName), ['Project-1', 'Project-2']);
      const run = await ExportRun.create({ ...options, selection, csvHeaders: input.headers });
      const snapshot = await report(run);
      assert.deepEqual(snapshot.csvHeaders, headers);
      assert.deepEqual(snapshot.projects[0].project.sourceCsv?.values, headers.map((name) => records[1][name]));
      for (const [index, entry] of selection.entries.entries()) {
        await run.execute(index, async () => result(entry.project, index === 0 ? 'FAILED' : 'SUCCESS'));
      }
      await run.finish();
      const originalReport = await fs.readFile(run.reportPath, 'utf8');
      const legacy: Partial<ExportRunReport> & { summary?: ExportRunReport['executionSummary'] } = await report(run);
      legacy.summary = legacy.executionSummary;
      delete legacy.executionSummary;
      delete legacy.csvHeaders;
      for (const entry of legacy.projects ?? []) delete entry.project.sourceCsv;
      const legacyPath = path.join(path.dirname(options.inputFile), 'legacy-results.json');
      await fs.writeFile(legacyPath, JSON.stringify(legacy));
      assert.deepEqual((await readRetrySource(legacyPath)).failedCleanNames, ['Project-1']);
      const outputColumns = [...headers.filter((name) => name !== 'error'), 'error'];
      const failedRows = parse(await fs.readFile(run.failedCsvPath, 'utf8')) as string[][];
      assert.deepEqual(failedRows, [outputColumns, outputColumns.map((name) => name === 'error' ? 'PROJECT_NOT_FOUND' : records[1][name])]);
      assert.equal(await fs.readFile(options.inputFile, 'utf8'), originalInput);

      const emptySelection = selectExportProjects(input.projects, { runType: 'batch', skip: 100, limit: 50 });
      const empty = await ExportRun.create({ ...options, selection: emptySelection, csvHeaders: input.headers });
      await empty.finish();
      assert.deepEqual(parse(await fs.readFile(empty.failedCsvPath, 'utf8')), [outputColumns]);

      // Retry matches by clean name using current CSV data, independently of both row and column order.
      const retryHeaders = headers.slice().reverse();
      const retryRecords: Record<string, string>[] = records.slice().reverse().map((record) => ({ ...record, action: 'Updated action', sheets_count: '0042' }));
      await fs.writeFile(options.inputFile, encode(retryHeaders, retryRecords));
      const retryInput = await readProjectInput(options.inputFile);
      const source = await readRetrySource(run.reportPath);
      const retrySelection = selectExportProjects(retryInput.projects, { runType: 'retry', reportPath: run.reportPath }, source);
      assert.deepEqual(retrySelection.entries.map(({ project }) => project.projectCleanName), ['Project-1']);
      const retry = await ExportRun.create({ ...options, selection: retrySelection, csvHeaders: retryInput.headers });
      await retry.execute(0, async () => ({ ...result(retrySelection.entries[0].project, 'FAILED'), errorType: undefined }));
      await retry.finish();
      const retryColumns = [...retryHeaders.filter((name) => name !== 'error'), 'error'];
      const retryRecord = retryRecords.find((record) => record.project_clean_name.trim() === 'Project-1')!;
      assert.deepEqual(parse(await fs.readFile(retry.failedCsvPath, 'utf8')), [
        retryColumns, retryColumns.map((name) => name === 'error' ? 'UNKNOWN' : retryRecord[name]),
      ]);
      assert.equal(await fs.readFile(run.reportPath, 'utf8'), originalReport);
    });
  }
});
