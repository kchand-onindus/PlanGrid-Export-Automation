export interface Project {
  projectNumber: string;
  projectName: string;
  enabled: boolean;
  startDate?: string;
  endDate?: string;
}

export type ProjectStatus = 'SUCCESS' | 'SKIPPED' | 'FAILED';

export interface ProjectResult {
  project: Project;
  status: ProjectStatus;
  message?: string;
  downloadDirectory?: string;
  durationMs: number;
}
