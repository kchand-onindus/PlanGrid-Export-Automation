import fs from 'node:fs/promises';
import type { Project } from './types.js';

function parseBoolean(value: string): boolean {
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
}

function parseDate(value: string, fieldName: string): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format; received "${date}"`);
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
  const fromDateIndex = headers.indexOf('from_date');
  const toDateIndex = headers.indexOf('to_date');

  if (numberIndex < 0 || nameIndex < 0 || enabledIndex < 0 || fromDateIndex < 0 || toDateIndex < 0) {
    throw new Error(
      'CSV must contain project_number, project_name, enabled, from_date, and to_date columns',
    );
  }

  return rows.map((row) => {
    const values = row.split(',').map((value) => value.trim());
    return {
      projectNumber: values[numberIndex] ?? '',
      projectName: values[nameIndex] ?? '',
      enabled: parseBoolean(values[enabledIndex] ?? ''),
      fromDate: parseDate(values[fromDateIndex] ?? '', 'from_date'),
      toDate: parseDate(values[toDateIndex] ?? '', 'to_date'),
    };
  });
}
