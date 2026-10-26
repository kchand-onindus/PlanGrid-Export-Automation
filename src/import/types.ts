export interface VersionSet {
  projectUid: string;
  projectName: string;
  entityId: string;
  entityIdColumn: 'curvo_entity_id' | 'project_kahua_entity_id';
  versionSetUid: string;
  versionName: string;
  publishedAt: string;
  uploadSequence: number;
}

export interface ImportFile {
  archivePath: string;
  localPath: string;
  bytes: number;
}

export interface PreparedVersion extends VersionSet {
  archiveFolder: string;
  localFolder: string;
  files: ImportFile[];
}

export interface ImportPlan {
  status: 'PREPARED';
  preparedAt: string;
  sourceCsv: string;
  sourceZip: string;
  projectUid: string;
  projectName: string;
  drawingsRoot: string;
  excludedFolders: string[];
  warnings: string[];
  versions: PreparedVersion[];
}
