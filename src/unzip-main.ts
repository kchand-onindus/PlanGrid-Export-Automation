import { paths } from './config.js';
import { createLogger } from './logger.js';
import { unzipProjects } from './unzip.js';
import { summarizeLocalResults } from './local-results.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('unzip');
  logger.general('Starting project ZIP extraction', {
    inputFile: paths.inputFile, downloadRoot: paths.downloadRoot, logFile: logFilePath,
  });
  try {
    const results = await unzipProjects(paths.inputFile, paths.downloadRoot, logger);
    const summary = summarizeLocalResults(results);
    logger.general('ZIP extraction completed — UNZIP SUMMARY', summary);
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    logger.error('ZIP extraction stopped', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

void main();
