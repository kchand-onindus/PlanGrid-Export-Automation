export interface Project {
  projectUid: string;
  projectName: string;
  projectCleanName: string;
  enabled: boolean;
  startDate?: string;
  endDate?: string;
}

export type ProjectStatus = 'SUCCESS' | 'SKIPPED' | 'FAILED';

export type ExportErrorType =
  | 'PROJECTS_PAGE_ERROR' | 'PROJECT_NOT_FOUND' | 'PROJECT_AMBIGUOUS' | 'PROJECT_SELECTION_ERROR'
  | 'EXPORT_FORM_ERROR' | 'BUILD_IDENTITY_ERROR' | 'BUILD_FAILED' | 'BUILD_ERROR' | 'BUILD_CANCELLED'
  | 'BUILD_MONITORING_ERROR' | 'DOWNLOAD_ERROR' | 'DOWNLOAD_CLEANUP_ERROR' | 'UNKNOWN_ERROR';

export interface ProjectResult {
  project: Project;
  status: ProjectStatus;
  message?: string;
  errorType?: ExportErrorType;
  downloadDirectory?: string;
  durationMs: number;
}
