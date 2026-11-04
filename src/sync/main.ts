import { paths } from '../config.js';
import { createLogger } from '../logger.js';
import { prepareSync } from './prepare.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('sync-preparation');
  logger.general('Starting local Documents/Photos sync preparation', {
    inputFile: paths.inputFile, downloadRoot: paths.downloadRoot, syncUpRoot: paths.syncUpRoot, logFile: logFilePath,
  });
  try {
    const results = await prepareSync(paths.inputFile, paths.downloadRoot, paths.syncUpRoot, logger);
    const failed = results.filter((result) => result.status === 'FAILED').length;
    logger.general('Local sync preparation completed', {
      total: results.length,
      success: results.filter((result) => result.status === 'SUCCESS').length,
      skipped: results.filter((result) => result.status === 'SKIPPED').length,
      failed,
    });
    if (failed) process.exitCode = 1;
  } catch (error) {
    logger.error('Local sync preparation stopped', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

void main();
