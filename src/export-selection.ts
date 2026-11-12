import { ENV_KEYS } from '../utils/constants.js';
import type { Project } from './types.js';

export type ExportOptions =
  | { runType: 'batch'; skip: number; limit?: number }
  | { runType: 'retry'; reportPath: string };

export interface SelectedProject {
  project: Project;
  csvPosition: number;
  enabledPosition: number;
}

export interface RetrySource {
  runId: string;
  rootRunId: string;
  reportPath: string;
  unfinishedProjects: number;
  failedCleanNames: string[];
}

export interface ExportSelection {
  runType: 'batch' | 'retry';
  skip?: number;
  limit?: number;
  csvTotal: number;
  enabledTotal: number;
  entries: SelectedProject[];
  parentRunId?: string;
  rootRunId?: string;
  sourceReport?: string;
}

function integer(value: string, label: string, minimum: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new Error(`${label} must be a ${minimum === 0 ? 'non-negative' : 'positive'} safe integer`);
  }
  return Number(value);
}

export function parseExportOptions(args: readonly string[], env: Record<string, string | undefined>): ExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--connect-chrome' || argument === '--headless') continue;
    const separator = argument.indexOf('=');
    let name = separator < 0 ? argument : argument.slice(0, separator);
    if (separator >= 0 && !name.startsWith('-')) {
      name = name === 'retry' ? '--retry-failed' : `--${name}`;
    }
    if (name === '--offset') name = '--skip';
    if (!['--skip', '--limit', '--retry-failed'].includes(name)) {
      throw new Error(`Unknown export argument: ${name}. Use help or --help to list supported options.`);
    }
    if (values.has(name)) throw new Error(`${name} was supplied more than once`);
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }

  const reportPath = values.get('--retry-failed');
  if (reportPath !== undefined) {
    if (values.has('--skip') || values.has('--limit')) {
      throw new Error('Retry mode cannot be combined with skip/offset or limit arguments; retry selection is separate from batching');
    }
    // Even invalid batch environment values are irrelevant to an explicit retry.
    return { runType: 'retry', reportPath };
  }
  const skip = integer(values.get('--skip') ?? (env[ENV_KEYS.batchSkip]?.trim() || '0'), 'Batch skip/offset', 0);
  const rawLimit = values.get('--limit') ?? env[ENV_KEYS.batchLimit]?.trim();
  const limit = rawLimit ? integer(rawLimit, 'Batch limit', 1) : undefined;
  return { runType: 'batch', skip, limit };
}

export function selectExportProjects(
  projects: readonly Project[], options: ExportOptions, retry?: RetrySource,
): ExportSelection {
  const enabled: SelectedProject[] = [];
  for (const [index, project] of projects.entries()) {
    if (project.enabled) enabled.push({ project, csvPosition: index + 1, enabledPosition: enabled.length + 1 });
  }
  const common = { csvTotal: projects.length, enabledTotal: enabled.length };
  if (options.runType === 'batch') {
    const remaining = enabled.slice(options.skip);
    return {
      ...common, runType: 'batch', skip: options.skip, limit: options.limit,
      entries: options.limit === undefined ? remaining : remaining.slice(0, options.limit),
    };
  }
  if (!retry) throw new Error('A validated results.json report is required for retry selection');
  const byCleanName = new Map(enabled.map((entry) => [entry.project.projectCleanName, entry]));
  if (byCleanName.size !== enabled.length) throw new Error('Enabled project_clean_name values must be unique');
  const entries = retry.failedCleanNames.map((cleanName) => {
    const entry = byCleanName.get(cleanName);
    if (!entry) {
      throw new Error(`Failed project "${cleanName}" is missing or disabled in input/projects.csv; retry selection stopped before browser startup`);
    }
    // The current CSV remains authoritative, allowing corrections to names and dates before retrying.
    return entry;
  });
  return {
    ...common, runType: 'retry', entries,
    parentRunId: retry.runId, rootRunId: retry.rootRunId, sourceReport: retry.reportPath,
  };
}

export const EXPORT_HELP = `PlanGrid export (macOS/Linux, Windows Command Prompt and PowerShell)

  npm run export:chrome [arguments]   Existing authenticated Chrome session
  npm run export [arguments]          Visible automated login
  npm run headless [arguments]        Headless automated login

Arguments:
  skip=N            Skip N enabled projects in CSV order (alias: offset=N)
  limit=N           Attempt at most N enabled projects (positive integer)
  retry="RUN-ID"    Retry only FAILED projects from a batch or retry run ID
  help              Show this help without starting a browser

Examples:
  npm run export:chrome skip=0 limit=50
  npm run export:chrome retry="<run-id>"

The original --skip/--offset, --limit, --retry-failed, and --help flags still work.
For those flag forms, use npm's separator: npm run export:chrome -- --skip 0 --limit 50

Batch defaults: BATCH_SKIP=0; BATCH_LIMIT unset/blank means all remaining.
Command-line values override .env. Retry mode ignores both batch environment
settings and cannot be combined with explicit skip/offset/limit arguments.
Copy the entire folder name inside runs/ or the runId printed in the terminal.
For remaining failures after a retry, use the new retry run's ID.
A bare run ID expands to runs/<run-id>/results.json automatically. Explicit
relative/absolute JSON report paths are also supported. Relative paths resolve
from this repository. Reports are saved under
runs/<UTC-timestamp>_<batch-or-retry>_<unique-suffix>/, independently of DOWNLOAD_DIR.
CSV data is never rewritten. Retry records must still be enabled in the CSV.
Chrome mode verifies authentication automatically and disconnects without Inspector
pauses. Chrome's Allow prompt may still appear. CAPTCHA/OTP remain manual;
visible automated login retains its verification and final Inspector pauses.
`;
