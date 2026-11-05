import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../utils/env.js';
import { ENV_KEYS, TIMEOUTS, URLS } from '../utils/constants.js';

export const platformUrl = process.env.PLATFORM_URL ?? URLS.planGridLanding;
export const connectChrome = process.argv.includes('--connect-chrome');

// Resolve paths from the repository location, not from wherever the command is launched.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  inputFile: path.join(projectRoot, 'input', 'projects.csv'),
  downloadRoot: path.isAbsolute(process.env[ENV_KEYS.downloadDir] ?? '')
    ? process.env[ENV_KEYS.downloadDir]!
    : path.resolve(projectRoot, process.env[ENV_KEYS.downloadDir] ?? 'downloads'),
  syncUpRoot: path.isAbsolute(process.env[ENV_KEYS.syncUpDir] ?? '')
    ? process.env[ENV_KEYS.syncUpDir]!
    : path.resolve(projectRoot, process.env[ENV_KEYS.syncUpDir] ?? 'sync_ups'),
  drawingsRoot: path.isAbsolute(process.env[ENV_KEYS.drawingsDir] ?? '')
    ? process.env[ENV_KEYS.drawingsDir]!
    : path.resolve(projectRoot, process.env[ENV_KEYS.drawingsDir] ?? 'drawings'),
  logRoot: path.join(projectRoot, 'logs'),
};

export const timeouts = TIMEOUTS;
