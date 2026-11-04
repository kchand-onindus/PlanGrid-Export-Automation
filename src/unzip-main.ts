import { paths } from './config.js';
import { createLogger } from './logger.js';
import { unzipProjects } from './unzip.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('unzip');
  logger.general('Starting project ZIP extraction', {
    inputFile: paths.inputFile, downloadRoot: paths.downloadRoot, logFile: logFilePath,
  });
  try {
    const results = await unzipProjects(paths.inputFile, paths.downloadRoot, logger);
    const failed = results.filter((result) => result.status === 'FAILED').length;
    logger.general('ZIP extraction completed', {
      total: results.length,
      success: results.filter((result) => result.status === 'SUCCESS').length,
      skipped: results.filter((result) => result.status === 'SKIPPED').length,
      failed,
    });
    if (failed) process.exitCode = 1;
  } catch (error) {
    logger.error('ZIP extraction stopped', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

void main();
