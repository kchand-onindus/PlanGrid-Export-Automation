import { paths } from '../config.js';
import { createLogger } from '../logger.js';
import { prepareDrawings } from '../sync/prepare.js';
import { confirmSyncOverwrite } from '../sync/confirmation.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('drawings-preparation');
  logger.general('Starting local copying of project contents except Documents/Photos', {
    inputFile: paths.inputFile, downloadRoot: paths.downloadRoot, drawingsRoot: paths.drawingsRoot, logFile: logFilePath,
  });
  try {
    const results = await prepareDrawings(paths.inputFile, paths.downloadRoot, paths.drawingsRoot, logger, confirmSyncOverwrite);
    const failed = results.filter((result) => result.status === 'FAILED').length;
    logger.general('Local drawings preparation completed', {
      total: results.length,
      success: results.filter((result) => result.status === 'SUCCESS').length,
      skipped: results.filter((result) => result.status === 'SKIPPED').length,
      failed,
    });
    if (failed) process.exitCode = 1;
  } catch (error) {
    logger.error('Local drawings preparation stopped', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

void main();
