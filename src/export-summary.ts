import { logger } from './logger.js';
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
