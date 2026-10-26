import fs from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { VersionSet } from './types.js';

const requiredColumns = [
  'project_uid', 'project_name', 'version_set_uid', 'version_name', 'published_at', 'upload_sequence',
];
const entityColumns = ['curvo_entity_id', 'project_kahua_entity_id'] as const;

export async function readVersionSets(filePath: string, projectUid: string): Promise<VersionSet[]> {
  const rows: string[][] = parse(await fs.readFile(filePath, 'utf8'), {
    bom: true,
    trim: true,
    skip_empty_lines: true,
  });
  const headers = rows.shift() ?? [];
  if (new Set(headers).size !== headers.length) {
    throw new Error('Version CSV contains duplicate column names');
  }
  const missing = requiredColumns.filter((column) => !headers.includes(column));
  const entityIdColumn = entityColumns.find((column) => headers.includes(column));
  if (missing.length || !entityIdColumn) {
    throw new Error(`Version CSV is missing required columns: ${[
      ...missing, ...(!entityIdColumn ? ['curvo_entity_id (or project_kahua_entity_id)'] : []),
    ].join(', ')}`);
  }

  const versions: VersionSet[] = [];
  for (const [index, values] of rows.entries()) {
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column].trim()]));
    if (record.project_uid.toLowerCase() !== projectUid.toLowerCase()) continue;
    const label = `Version CSV record ${index + 2}`;
    for (const column of [...requiredColumns, entityIdColumn]) {
      if (!record[column]) throw new Error(`${label}: ${column} is required`);
    }
    if (entityColumns.every((column) => headers.includes(column))
        && record.curvo_entity_id !== record.project_kahua_entity_id) {
      throw new Error(`${label}: entity ID columns disagree`);
    }
    const uploadSequence = Number(record.upload_sequence);
    if (!/^\d+$/.test(record.upload_sequence) || !Number.isSafeInteger(uploadSequence) || uploadSequence < 1) {
      throw new Error(`${label}: upload_sequence must be a positive integer`);
    }
    const date = record.published_at;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp)
        || new Date(timestamp).toISOString().slice(0, 10) !== date) {
      throw new Error(`${label}: published_at must be a valid YYYY-MM-DD date; received "${date}"`);
    }
    versions.push({
      projectUid: record.project_uid,
      projectName: record.project_name,
      entityId: record[entityIdColumn],
      entityIdColumn,
      versionSetUid: record.version_set_uid,
      versionName: record.version_name,
      publishedAt: date,
      uploadSequence,
    });
  }

  if (!versions.length) throw new Error(`No version sets found for project UID ${projectUid}`);
  const sequences = new Set<number>();
  const uids = new Set<string>();
  for (const version of versions) {
    if (sequences.has(version.uploadSequence)) {
      throw new Error(`Duplicate upload_sequence ${version.uploadSequence} for project ${projectUid}`);
    }
    if (uids.has(version.versionSetUid.toLowerCase())) {
      throw new Error(`Duplicate version_set_uid ${version.versionSetUid} for project ${projectUid}`);
    }
    if (version.projectName !== versions[0].projectName || version.entityId !== versions[0].entityId) {
      throw new Error(`Inconsistent project name or entity ID for project ${projectUid}`);
    }
    sequences.add(version.uploadSequence);
    uids.add(version.versionSetUid.toLowerCase());
  }
  return versions.sort((a, b) => a.uploadSequence - b.uploadSequence);
}

export function validateSequence(versions: VersionSet[]): string[] {
  const warnings: string[] = [];
  for (const [index, version] of versions.entries()) {
    const previous = versions[index - 1];
    if (version.uploadSequence !== (previous?.uploadSequence ?? 0) + 1) {
      warnings.push(`Sequence gap before upload_sequence ${version.uploadSequence}; upload_sequence order is retained.`);
    }
    if (previous && version.publishedAt < previous.publishedAt) {
      warnings.push(`Date order discrepancy: upload_sequence ${version.uploadSequence} (${version.versionName}, `
        + `${version.publishedAt}) precedes the date of upload_sequence ${previous.uploadSequence} `
        + `(${previous.publishedAt}); upload_sequence order is retained.`);
    }
  }
  return warnings;
}
