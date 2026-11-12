import fs from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { Project } from './types.js';

function validateCleanName(name: string, rowNumber: number): void {
  if (!name) {
    throw new Error(`CSV row ${rowNumber}: project_clean_name is required`);
  }
  if (name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
      || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(`CSV row ${rowNumber}: project_clean_name must be a valid Windows/macOS folder and file base name`);
  }
}

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

export async function readProjectInput(filePath: string): Promise<{ headers: string[]; projects: Project[] }> {
  const content = await fs.readFile(filePath, 'utf8');
  const rows: string[][] = parse(content, { bom: true, trim: false, skip_empty_lines: true });

  if (rows.length === 0) return { headers: [], projects: [] };

  const sourceHeaders = rows.shift()!;
  const headers = sourceHeaders.map((header) => header.trim());
  if (new Set(headers).size !== headers.length) {
    throw new Error('CSV contains duplicate column names');
  }
  const uidIndex = headers.indexOf('project_uid');
  const nameIndex = headers.indexOf('project_name');
  const cleanNameIndex = headers.indexOf('project_clean_name');
  const enabledIndex = headers.indexOf('enabled');
  const startDateIndex = headers.indexOf('start_date');
  const endDateIndex = headers.indexOf('end_date');
  const excelNameIndex = headers.indexOf('excel_name');

  if (uidIndex < 0 || nameIndex < 0 || cleanNameIndex < 0 || enabledIndex < 0) {
    throw new Error('CSV must contain project_uid, project_name, project_clean_name and enabled columns');
  }

  const enabledCleanNames = new Set<string>();
  const projects = rows.map((row, index) => {
    const rowNumber = index + 2;
    // project_name is PlanGrid's exact name; trim only the other configuration fields.
    const values = row.map((value, columnIndex) => columnIndex === nameIndex ? value : value.trim());
    const projectName = values[nameIndex] ?? '';
    if (/^\s*$/u.test(projectName)) {
      throw new Error(`CSV row ${rowNumber}: project_name is required`);
    }
    const projectCleanName = values[cleanNameIndex] ?? '';
    validateCleanName(projectCleanName, rowNumber);
    const enabled = parseRequiredBoolean(values[enabledIndex] ?? '', rowNumber);
    const cleanNameKey = projectCleanName.normalize('NFC').toLowerCase();
    if (enabled && enabledCleanNames.has(cleanNameKey)) {
      throw new Error(`CSV row ${rowNumber}: duplicate project_clean_name among enabled projects: "${projectCleanName}"`);
    }
    if (enabled) enabledCleanNames.add(cleanNameKey);
    // Optional source metadata is carried into reports without changing its decoded value.
    const excelName = excelNameIndex >= 0 ? row[excelNameIndex] : undefined;

    return {
      projectUid: values[uidIndex] ?? '',
      projectName,
      projectCleanName,
      enabled,
      startDate: startDateIndex >= 0
        ? parseOptionalDate(values[startDateIndex] ?? '', 'start_date', rowNumber)
        : undefined,
      endDate: endDateIndex >= 0
        ? parseOptionalDate(values[endDateIndex] ?? '', 'end_date', rowNumber)
        : undefined,
      ...(excelName ? { excelName } : {}),
      sourceCsv: { headers: [...sourceHeaders], values: [...row] },
    };
  });
  return { headers: sourceHeaders, projects };
}

export async function readProjects(filePath: string): Promise<Project[]> {
  const { projects } = await readProjectInput(filePath);
  // Local workflows need the validated settings; export reporting also keeps the source columns.
  return projects.map(({ sourceCsv: _sourceCsv, ...project }) => project);
}
