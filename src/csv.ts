import fs from 'node:fs/promises';
import type { Project } from './types.js';

function parseRequiredBoolean(value: string, rowNumber: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`CSV row ${rowNumber}: enabled must be true or false`);
}

function parseOptionalDate(value: string, fieldName: string, rowNumber: number): string | undefined {
  const date = value.trim();
  if (!date) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`CSV row ${rowNumber}: ${fieldName} must use YYYY-MM-DD format; received "${date}"`);
  }
  return date;
}

export async function readProjects(filePath: string): Promise<Project[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length === 0) return [];

  const headers = rows.shift()!.split(',').map((header) => header.trim());
  const numberIndex = headers.indexOf('project_number');
  const nameIndex = headers.indexOf('project_name');
  const enabledIndex = headers.indexOf('enabled');
  const startDateIndex = headers.indexOf('start_date');
  const endDateIndex = headers.indexOf('end_date');

  if (nameIndex < 0 || enabledIndex < 0) {
    throw new Error('CSV must contain project_name and enabled columns');
  }

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const values = row.split(',').map((value) => value.trim());
    const projectName = values[nameIndex] ?? '';
    if (!projectName) {
      throw new Error(`CSV row ${rowNumber}: project_name is required`);
    }

    return {
      projectNumber: numberIndex >= 0 ? values[numberIndex] ?? '' : '',
      projectName,
      enabled: parseRequiredBoolean(values[enabledIndex] ?? '', rowNumber),
      startDate: startDateIndex >= 0
        ? parseOptionalDate(values[startDateIndex] ?? '', 'start_date', rowNumber)
        : undefined,
      endDate: endDateIndex >= 0
        ? parseOptionalDate(values[endDateIndex] ?? '', 'end_date', rowNumber)
        : undefined,
    };
  });
}
