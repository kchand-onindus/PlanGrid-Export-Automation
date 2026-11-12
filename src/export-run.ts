import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import timers from 'node:timers/promises';
import type { ExportSelection, RetrySource, SelectedProject } from './export-selection.js';
import { EXPORT_ERROR_TYPES, type ProjectResult } from './types.js';
import { logger } from './logger.js';

type RunProjectStatus = 'PENDING' | 'IN_PROGRESS' | 'INTERRUPTED' | ProjectResult['status'];
interface RunProject extends SelectedProject {
  status: RunProjectStatus;
  startedAt?: string;
  completedAt?: string;
  errorType?: ProjectResult['errorType'];
  message?: string;
  durationMs?: number;
  downloadDirectory?: string;
}

export interface ExportRunReport {
  kind: 'plangrid-export-run';
  schemaVersion: 1;
  runId: string;
  runType: 'batch' | 'retry';
  parentRunId?: string;
  rootRunId: string;
  sourceReport?: string;
  status: 'RUNNING' | 'COMPLETED' | 'ABORTED';
  executionSummary: ReturnType<typeof summarizeRun>;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  inputFile: string;
  logFile: string;
  csvHeaders: string[];
  selection: { skip?: number; limit?: number; csvTotal: number; enabledTotal: number };
  projects: RunProject[];
}

function summarizeRun(projects: readonly RunProject[]) {
  const count = (status: RunProjectStatus) => projects.filter((project) => project.status === status).length;
  return {
    selected: projects.length, success: count('SUCCESS'), failed: count('FAILED'), skipped: count('SKIPPED'),
    pending: count('PENDING'), inProgress: count('IN_PROGRESS'), interrupted: count('INTERRUPTED'),
  };
}

function csvField(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function failedCsv(report: ExportRunReport): string {
  // Replace a source error column rather than carrying an old value or adding a duplicate header.
  const columns = report.csvHeaders.filter((name) => name.trim() !== 'error');
  const header = [...columns, 'error'].map((name) => /[",\r\n]/.test(name) ? csvField(name) : name).join(',');
  const rows = report.projects.filter(({ status }) => status === 'FAILED').map(({ project, errorType }) => {
    const source = project.sourceCsv;
    const fields: Record<string, unknown> = {
      project_uid: project.projectUid, project_name: project.projectName, project_clean_name: project.projectCleanName,
      enabled: project.enabled, start_date: project.startDate, end_date: project.endDate, excel_name: project.excelName,
    };
    const values = columns.map((name) => source
      ? source.values[source.headers.indexOf(name)] ?? '' : fields[name.trim()] ?? '');
    const error = errorType && errorType !== 'UNKNOWN_ERROR' && EXPORT_ERROR_TYPES.includes(errorType) ? errorType : 'UNKNOWN';
    return [...values, error].map(csvField).join(',');
  });
  return [header, ...rows, ''].join('\r\n');
}

const reportWriteRetryDelays = [1_000, 2_000, 4_000, 8_000];

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export class ReportWriteError extends Error {
  readonly code: string | undefined;

  constructor(readonly filePath: string, cause: unknown) {
    const code = errorCode(cause);
    const advice = ['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
      ? 'The file may be locked or access denied. Close this run\'s CSV and JSON in Excel, editors, and preview panes. '
      : '';
    super(`Could not update export report "${filePath}"${code ? ` (${code})` : ''}. ${advice}`
      + `Check folder permissions and available disk space. No further projects will start. `
      + `Details: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ReportWriteError';
    this.code = code;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    for (let retry = 0; ; retry += 1) {
      try {
        await fs.rename(temporary, filePath);
        if (retry > 0) logger.info('Run report saved after retrying file access', { filePath });
        return;
      } catch (error) {
        const code = errorCode(error);
        const delayMs = reportWriteRetryDelays[retry];
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || delayMs === undefined) throw error;
        logger.warn('Run report may be locked or access denied; retrying report save', {
          filePath, code, retry: retry + 1, maxRetries: reportWriteRetryDelays.length, delayMs,
          instruction: 'Close this run\'s CSV and JSON in Excel, editors, and preview panes now. No further projects start until both reports are saved.',
        });
        await timers.setTimeout(delayMs);
      }
    }
  } catch (error) {
    // A cleanup failure must not hide the report path and original write error.
    if (errorCode(error) !== 'EEXIST') {
      try {
        await fs.rm(temporary, { force: true });
      } catch (cleanupError) {
        logger.warn('Could not remove temporary run-report file', {
          temporary, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    throw new ReportWriteError(filePath, error);
  }
}

export class ExportRun {
  readonly reportPath: string;
  readonly failedCsvPath: string;
  private savedReports = { json: false, csv: false };

  get persistence(): Readonly<{ json: boolean; csv: boolean }> {
    return { ...this.savedReports };
  }

  private constructor(readonly directory: string, readonly report: ExportRunReport) {
    this.reportPath = path.join(directory, 'results.json');
    this.failedCsvPath = path.join(directory, 'failed-projects.csv');
  }

  static async create(options: {
    runsRoot: string; selection: ExportSelection; inputFile: string; logFile: string;
    csvHeaders?: readonly string[];
  }): Promise<ExportRun> {
    const { selection } = options;
    const startedAt = new Date().toISOString();
    const timestamp = startedAt.replace('T', '_').replace(/[:.]/g, '-');
    const label = selection.runType === 'batch'
      ? `batch_skip-${selection.skip}_limit-${selection.limit ?? 'all'}` : 'retry';
    const runId = `${timestamp}_${label}_${randomUUID().slice(0, 8)}`;
    const directory = path.join(options.runsRoot, runId);
    await fs.mkdir(options.runsRoot, { recursive: true });
    // Never reuse or overwrite a previous run directory.
    await fs.mkdir(directory);
    const projects: RunProject[] = selection.entries.map((entry) => ({
      ...entry, project: structuredClone(entry.project), status: 'PENDING',
    }));
    const run = new ExportRun(directory, {
      kind: 'plangrid-export-run', schemaVersion: 1, runId, runType: selection.runType,
      parentRunId: selection.parentRunId, rootRunId: selection.rootRunId ?? runId,
      sourceReport: selection.sourceReport, status: 'RUNNING', startedAt, updatedAt: startedAt,
      executionSummary: summarizeRun(projects),
      inputFile: options.inputFile, logFile: options.logFile,
      csvHeaders: [...(options.csvHeaders ?? projects[0]?.project.sourceCsv?.headers
        ?? ['project_uid', 'project_name', 'project_clean_name', 'enabled', 'start_date', 'end_date', 'excel_name'])],
      selection: {
        skip: selection.skip, limit: selection.limit, csvTotal: selection.csvTotal, enabledTotal: selection.enabledTotal,
      },
      projects,
    });
    await run.save();
    return run;
  }

  private async save(): Promise<void> {
    this.report.updatedAt = new Date().toISOString();
    this.report.executionSummary = summarizeRun(this.report.projects);
    this.savedReports = { json: false, csv: false };
    // JSON is authoritative. A CSV write failure also stops execution before another export.
    await atomicWrite(this.reportPath, `${JSON.stringify(this.report, null, 2)}\n`);
    this.savedReports.json = true;
    await atomicWrite(this.failedCsvPath, failedCsv(this.report));
    this.savedReports.csv = true;
  }

  async execute(index: number, action: () => Promise<ProjectResult>): Promise<ProjectResult> {
    const entry = this.report.projects[index];
    if (this.report.status !== 'RUNNING' || !entry || entry.status !== 'PENDING') {
      throw new Error('Only a pending project in the current run may be executed');
    }
    if (!this.savedReports.json || !this.savedReports.csv) {
      throw new Error('Run reports must be saved before another project can start');
    }
    entry.status = 'IN_PROGRESS';
    entry.startedAt = new Date().toISOString();
    await this.save();
    const result = await action();
    entry.status = result.status;
    entry.completedAt = new Date().toISOString();
    entry.errorType = result.errorType;
    entry.message = result.message;
    entry.durationMs = result.durationMs;
    entry.downloadDirectory = result.downloadDirectory;
    await this.save();
    return result;
  }

  async finish(aborted = false): Promise<void> {
    if (this.report.status !== 'RUNNING' && this.savedReports.json && this.savedReports.csv) return;
    if (!aborted && this.report.projects.some(({ status }) => status === 'PENDING' || status === 'IN_PROGRESS')) {
      throw new Error('Cannot complete a run with unfinished projects');
    }
    this.report.status = aborted ? 'ABORTED' : 'COMPLETED';
    this.report.completedAt = new Date().toISOString();
    for (const entry of this.report.projects) {
      if (entry.status === 'IN_PROGRESS') {
        entry.status = 'INTERRUPTED';
        entry.completedAt = this.report.completedAt;
      }
    }
    await this.save();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveRetryReportPath(target: string, locations: { projectRoot: string; runsRoot: string }): string {
  if (/[/\\]/.test(target) || /\.json$/i.test(target)) {
    return path.resolve(locations.projectRoot, target);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target)) {
    throw new Error('Retry requires a run ID (the folder name inside runs/) or a path to a JSON results report');
  }
  return path.join(locations.runsRoot, target, 'results.json');
}

export async function readRetrySource(reportPath: string): Promise<RetrySource> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch {
    throw new Error(`Cannot read a valid JSON retry report at ${reportPath}`);
  }
  const invalid = () => new Error(`Invalid or unsupported PlanGrid results.json report at ${reportPath}`);
  if (!isRecord(value) || value.kind !== 'plangrid-export-run' || value.schemaVersion !== 1
      || typeof value.runId !== 'string' || !value.runId || typeof value.rootRunId !== 'string' || !value.rootRunId
      || !['batch', 'retry'].includes(String(value.runType))
      || !['RUNNING', 'COMPLETED', 'ABORTED'].includes(String(value.status)) || !Array.isArray(value.projects)) {
    throw invalid();
  }
  const failedCleanNames: string[] = [];
  const seen = new Set<string>();
  let unfinishedProjects = 0;
  for (const entry of value.projects) {
    if (!isRecord(entry) || !isRecord(entry.project) || typeof entry.project.projectCleanName !== 'string'
        || !entry.project.projectCleanName.trim()
        || !['PENDING', 'IN_PROGRESS', 'INTERRUPTED', 'SUCCESS', 'FAILED', 'SKIPPED'].includes(String(entry.status))) {
      throw invalid();
    }
    const cleanName = entry.project.projectCleanName;
    const key = cleanName.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate project_clean_name "${cleanName}" in retry report; refusing ambiguous selection`);
    seen.add(key);
    if (entry.status === 'FAILED') failedCleanNames.push(cleanName);
    if (['PENDING', 'IN_PROGRESS', 'INTERRUPTED'].includes(String(entry.status))) unfinishedProjects += 1;
  }
  return { runId: value.runId, rootRunId: value.rootRunId, reportPath, unfinishedProjects, failedCleanNames };
}

export function retryCommand(target: string, mode: 'chrome' | 'visible' | 'headless'): string {
  const script = mode === 'chrome' ? 'export:chrome' : mode === 'headless' ? 'headless' : 'export';
  return `npm run ${script} retry="${target.replace(/\\/g, '/')}"`;
}
