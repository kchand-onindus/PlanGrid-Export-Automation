import { paths } from '../config.js';
import { createLogger } from '../logger.js';
import { prepareDrawings } from '../sync/prepare.js';
import { summarizeLocalResults } from '../local-results.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('drawings-preparation');
  logger.general('Starting full refresh of local project contents except Documents/Photos', {
    inputFile: paths.inputFile, downloadRoot: paths.downloadRoot, drawingsRoot: paths.drawingsRoot, logFile: logFilePath,
  });
  try {
    const results = await prepareDrawings(paths.inputFile, paths.downloadRoot, paths.drawingsRoot, logger);
    const summary = summarizeLocalResults(results);
    logger.general('Local drawings preparation completed — DRAWINGS PREPARATION SUMMARY', summary);
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    logger.error('Local drawings preparation stopped', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

void main();
