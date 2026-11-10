import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Download } from 'playwright';
import { ExportError } from './export-errors.js';
import { logError, type LogContext } from './logger.js';

// Save outside the project folder so failed transfers cannot damage previous output.
export async function saveExportDownload(
  download: Download, destination: string, context: LogContext,
): Promise<void> {
  const projectDirectory = path.dirname(destination);
  const downloadRoot = path.dirname(projectDirectory);
  await fs.mkdir(downloadRoot, { recursive: true });
  const stagedFile = path.join(downloadRoot, `.export-download-${randomUUID()}.zip`);
  let createdStagedFile = false;
  let createdProjectDirectory = false;
  let failure: unknown;

  try {
    const handle = await fs.open(stagedFile, 'wx');
    createdStagedFile = true;
    await handle.close();
    await download.saveAs(stagedFile);
    try {
      await fs.mkdir(projectDirectory);
      createdProjectDirectory = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const entry = await fs.lstat(projectDirectory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('Download project destination must be a real directory, not a file or link');
      }
    }
    // Publish last: the same-filesystem file rename consumes the temporary file,
    // leaving no cleanup step that could fail after replacing a previous ZIP.
    await fs.rename(stagedFile, destination);
    return;
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (createdStagedFile) {
    try {
      await fs.rm(stagedFile, { force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (createdProjectDirectory) {
    try {
      // Remove only our newly created empty folder; never recursively delete project output.
      await fs.rmdir(projectDirectory);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    const cleanupError = new ExportError('DOWNLOAD_CLEANUP_ERROR',
      'Could not fully clean up download output; inspect the reported paths', {
        cause: new AggregateError(cleanupFailures),
      });
    logError('Download cleanup failed', cleanupError, {
      ...context, errorType: cleanupError.errorType, stagedFile, projectDirectory,
      cleanupErrors: cleanupFailures.map((error) => error instanceof Error ? error.message : String(error)),
    });
  }
  throw failure;
}
