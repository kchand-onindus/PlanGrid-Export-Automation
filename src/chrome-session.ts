import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { ENV_KEYS } from '../utils/constants.js';

function chromeUserDataDirectory(): string {
  const configured = process.env[ENV_KEYS.chromeUserDataDir]?.trim();
  if (configured) return configured;

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'google-chrome');
}

export async function connectToExistingChrome(): Promise<Browser> {
  let endpoint = process.env[ENV_KEYS.planGridCdpUrl]?.trim();

  if (!endpoint) {
    let connectionMetadata: string;
    try {
      // Read only Chrome's debugging connection metadata, never cookies or login data.
      connectionMetadata = await readFile(path.join(chromeUserDataDirectory(), 'DevToolsActivePort'), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          'Chrome debugging connection metadata is not accessible. On macOS, allow the terminal or app access to Google Chrome under System Settings > Privacy & Security > Files & Folders, or set PLANGRID_CDP_URL to the local debugging endpoint.',
        );
      }
      throw new Error(
        'Chrome debugging connection metadata was not found. Keep Chrome open and enable remote debugging at chrome://inspect/#remote-debugging. For a custom Chrome data directory, set PLANGRID_CHROME_USER_DATA_DIR; for an explicit debugging endpoint, set PLANGRID_CDP_URL.',
      );
    }

    const [rawPort, browserPath] = connectionMetadata.trim().split(/\r?\n/);
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath ?? '')) {
      throw new Error('Chrome debugging connection metadata is invalid. Disable and re-enable remote debugging in Chrome, then try again.');
    }
    endpoint = `ws://127.0.0.1:${port}${browserPath}`;
  }

  try {
    return await chromium.connectOverCDP(endpoint, { timeout: 60_000 });
  } catch {
    // Playwright connection errors can contain the debugging endpoint. Keep it out of logs.
    throw new Error(
      'Could not attach to Chrome. Keep remote debugging enabled and click Allow if Chrome asks to share the debugging session, then try again.',
    );
  }
}
