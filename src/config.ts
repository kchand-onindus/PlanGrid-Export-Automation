import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../utils/env.js';
import { TIMEOUTS, URLS } from '../utils/constants.js';

export const platformUrl = process.env.PLATFORM_URL ?? URLS.planGridLanding;

// Resolve paths from the repository location, not from wherever the command is launched.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  inputFile: path.join(projectRoot, 'input', 'projects.csv'),
  downloadRoot: path.join(projectRoot, 'downloads'),
  logRoot: path.join(projectRoot, 'logs'),
};

export const timeouts = TIMEOUTS;
