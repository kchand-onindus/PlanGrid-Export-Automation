import { chromium, type Browser } from 'playwright';
import { createLogger } from '../logger.js';
import { submitKahuaPassword, submitKahuaUsername } from './auth.js';
import { kahuaUrl } from './config.js';

function safeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of ['KAHUA_USERNAME', 'KAHUA_PASSWORD']) {
    const secret = process.env[key];
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  return message;
}

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('kahua-import');
  let browser: Browser | undefined;
  try {
    const target = new URL(kahuaUrl);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new Error('KAHUA_URL must be an HTTPS URL without embedded credentials');
    }
    logger.general('Starting Kahua import browser workflow', {
      platform: target.origin + target.pathname,
      logFile: logFilePath,
    });
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(kahuaUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await submitKahuaUsername(page, logger);
    await submitKahuaPassword(page, logger);
    logger.info('Kahua login completed; pausing with Playwright Inspector on the authenticated application', {
      instruction: 'Use Record in Playwright Inspector and perform the next workflow manually. '
        + 'Copy the generated actions before clicking Resume, which closes the browser.',
    });
    await page.pause();
    logger.info('Inspection resumed; closing the Kahua browser');
  } catch (error) {
    logger.error('Kahua browser workflow could not complete. Check KAHUA_URL and the browser window.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      error: safeErrorMessage(error),
    });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

void main();
