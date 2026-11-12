import { logger } from './logger.js';
import { retryCommand, type ExportRun } from './export-run.js';
import type { ExportErrorType, ProjectResult } from './types.js';

export function summarizeExports(results: readonly ProjectResult[]) {
  const errorsByType: Partial<Record<ExportErrorType, number>> = {};
  for (const result of results) {
    if (result.status !== 'FAILED') continue;
    const errorType = result.errorType ?? 'UNKNOWN_ERROR';
    errorsByType[errorType] = (errorsByType[errorType] ?? 0) + 1;
  }
  return {
    total: results.length,
    success: results.filter((result) => result.status === 'SUCCESS').length,
    skipped: results.filter((result) => result.status === 'SKIPPED').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
    errorsByType,
  };
}

export function logExportSummary(results: readonly ProjectResult[]): void {
  const summary = summarizeExports(results);
  logger.general('========== EXPORT ERROR SUMMARY BY TYPE ==========', {
    counting: 'One primary error per failed project; repeated log entries are not counted again.',
    failedProjects: summary.failed,
    errorsByType: summary.errorsByType,
  });
  logger.general('Export run completed', summary);
}

export function logRunReport(run: ExportRun, mode: 'chrome' | 'visible' | 'headless', stopped = false): void {
  logger.general('Export run report', {
    runId: run.report.runId,
    runType: run.report.runType,
    parentRunId: run.report.parentRunId,
    rootRunId: run.report.rootRunId,
    status: run.report.status,
    resultsFile: run.reportPath,
    failedProjectsFile: run.failedCsvPath,
    resultsJsonUpdated: run.persistence.json,
    failedCsvUpdated: run.persistence.csv,
    ...run.report.executionSummary,
  });
  if (!run.persistence.json || !run.persistence.csv) {
    logger.warn('Some run-report files could not be updated; summary reflects the results held in memory', {
      instruction: run.persistence.json
        ? 'results.json is current and authoritative; failed-projects.csv may be stale. Close report viewers and check file access.'
        : 'results.json may be stale. Review these logs and downloaded ZIPs before choosing projects to rerun.',
    });
  }
  if (stopped) {
    logger.general('All known failed projects at the time execution stopped', {
      failedProjects: run.report.executionSummary.failed,
      instruction: 'Only FAILED projects are listed below. Pending or interrupted projects require separate review.',
    });
    for (const entry of run.report.projects) {
      if (entry.status !== 'FAILED') continue;
      logger.error('Failed project in stopped run', {
        projectUid: entry.project.projectUid,
        projectName: entry.project.projectName,
        projectCleanName: entry.project.projectCleanName,
        csvPosition: entry.csvPosition,
        errorType: entry.errorType,
        message: entry.message,
      });
    }
  }
  if (run.report.executionSummary.failed > 0 && run.persistence.json) {
    logger.general('Retry only the failures recorded in this report', {
      command: retryCommand(run.report.runId, mode),
      instruction: 'Use this new report for the next retry; earlier reports retain their original failures. Pending or interrupted projects are not selected.',
    });
  }
}
