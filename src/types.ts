export interface Project {
  projectNumber: string;
  projectName: string;
  enabled: boolean;
  fromDate: string;
  toDate: string;
}

export type ProjectStatus = 'SUCCESS' | 'SKIPPED' | 'FAILED';

export interface ProjectResult {
  project: Project;
  status: ProjectStatus;
  message?: string;
  downloadDirectory?: string;
  durationMs: number;
}
