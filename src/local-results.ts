import type { ProjectResult } from './types.js';

export type LocalSkipReason =
  | 'DISABLED' | 'MISSING_DOWNLOAD' | 'MISSING_EXTRACTION'
  | 'NO_MATCHING_FOLDER' | 'NO_MATCHING_CONTENT' | 'OVERWRITE_DECLINED' | 'OTHER';

export interface LocalProjectResult extends Omit<ProjectResult, 'errorType'> {
  skipReason?: LocalSkipReason;
}

// Each command summarizes only its own project results, without earlier-stage errors.
export function summarizeLocalResults(results: readonly LocalProjectResult[]) {
  const skippedByReason: Partial<Record<LocalSkipReason, number>> = {};
  for (const result of results) {
    if (result.status !== 'SKIPPED') continue;
    const reason = result.skipReason ?? 'OTHER';
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  }
  return {
    total: results.length,
    success: results.filter((result) => result.status === 'SUCCESS').length,
    skipped: results.filter((result) => result.status === 'SKIPPED').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
    skippedByReason,
    failedProjects: results.filter((result) => result.status === 'FAILED')
      .map((result) => result.project.projectCleanName),
  };
}
