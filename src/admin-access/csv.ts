import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { URLS } from '../../utils/constants.js';

export interface AdminAccessProject {
  projectId: string;
  projectName: string;
  enterpriseProjectUrl: URL;
  userEmailId: string;
  enabled: boolean;
  rowNumber: number;
}

const columns = ['project_id', 'project_name', 'enterprise_project_url', 'user_email_id', 'enabled'] as const;
const planGridOrigin = new URL(URLS.planGridLanding).origin;
const teamPath = /^\/enterprise\/organizations\/[a-z\d-]+\/projects\/([a-z\d-]+)\/team\/?$/i;

export function isProjectTeamUrl(url: URL, projectId: string): boolean {
  return url.origin === planGridOrigin && !url.username && !url.password
    && teamPath.exec(url.pathname)?.[1] === projectId;
}

export async function readAdminAccessProjects(filePath: string): Promise<AdminAccessProject[]> {
  const content = await readFile(filePath, 'utf8').catch(() => {
    throw new Error('Could not read the admin access project CSV.');
  });
  let rows: string[][];
  try {
    rows = parse(content, { bom: true, skip_empty_lines: true });
  } catch {
    throw new Error('Invalid admin access CSV. Check quoting and that each row has the same number of fields as the header.');
  }

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  if (new Set(headers).size !== headers.length || columns.some((column) => !headers.includes(column))) {
    throw new Error(`The CSV requires unique headers and these columns: ${columns.join(', ')}.`);
  }
  const [projectIdIndex, projectNameIndex, enterpriseProjectUrlIndex, userEmailIdIndex, enabledIndex] =
    columns.map((column) => headers.indexOf(column));

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const projectId = row[projectIdIndex].trim();
    const projectName = row[projectNameIndex];
    const enterpriseProjectUrl = URL.parse(row[enterpriseProjectUrlIndex].trim());
    const userEmailId = row[userEmailIdIndex].trim();
    const enabled = row[enabledIndex].trim().toLowerCase();

    if (!projectName.trim() || !userEmailId) {
      throw new Error(`CSV row ${rowNumber}: project_name and user_email_id are required.`);
    }
    if (!enterpriseProjectUrl || enterpriseProjectUrl.search || enterpriseProjectUrl.hash
      || !isProjectTeamUrl(enterpriseProjectUrl, projectId)) {
      throw new Error(`CSV row ${rowNumber}: enterprise_project_url must be a PlanGrid team page matching project_id.`);
    }
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error(`CSV row ${rowNumber}: enabled must be true or false.`);
    }
    return { projectId, projectName, enterpriseProjectUrl, userEmailId, enabled: enabled === 'true', rowNumber };
  });
}
