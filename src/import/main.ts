import { createLogger } from '../logger.js';
import { importConfig } from './config.js';
import { prepareImport } from './prepare.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('import-preparation');
  logger.general('Starting single-project import preparation', { ...importConfig, logFile: logFilePath });
  try {
    await prepareImport(importConfig, logger);
  } catch (error) {
    logger.error('Import preparation failed; no completed import plan was produced', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

void main();
