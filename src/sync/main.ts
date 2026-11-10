import { paths } from '../config.js';
import { createLogger } from '../logger.js';
import { prepareSync } from './prepare.js';
import { confirmSyncOverwrite } from './confirmation.js';
import { summarizeLocalResults } from '../local-results.js';

async function main(): Promise<void> {
  const { logger, logFilePath } = createLogger('sync-preparation');
  logger.general('Starting local Documents/Photos sync preparation', {
    inputFile: paths.inputFile, downloadRoot: paths.downloadRoot, syncUpRoot: paths.syncUpRoot, logFile: logFilePath,
  });
  try {
    const results = await prepareSync(paths.inputFile, paths.downloadRoot, paths.syncUpRoot, logger, confirmSyncOverwrite);
    const summary = summarizeLocalResults(results);
    logger.general('Local sync preparation completed — SYNC PREPARATION SUMMARY', summary);
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    logger.error('Local sync preparation stopped', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

void main();
