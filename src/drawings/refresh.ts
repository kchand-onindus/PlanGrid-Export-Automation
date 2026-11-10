import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger, LogContext } from '../logger.js';

interface EntryState {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  directory: boolean;
}
type Snapshot = Map<string, EntryState>;

async function snapshotDirectory(directory: string): Promise<Snapshot | undefined> {
  const snapshot: Snapshot = new Map();
  async function visit(file: string, relative: string): Promise<void> {
    const entry = await fs.lstat(file);
    if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Links and special files cannot be refreshed: ${file}`);
    if (relative === '' && !entry.isDirectory()) throw new Error(`Drawings destination must be a directory: ${directory}`);
    snapshot.set(relative, {
      dev: entry.dev, ino: entry.ino, size: entry.isFile() ? entry.size : 0,
      mtimeMs: entry.mtimeMs, directory: entry.isDirectory(),
    });
    if (entry.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
    }
  }
  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  await visit(directory, '');
  return snapshot;
}

async function checkUnchanged(directory: string, expected: Snapshot | undefined): Promise<void> {
  const current = await snapshotDirectory(directory);
  if (JSON.stringify(current && [...current]) !== JSON.stringify(expected && [...expected])) {
    throw new Error(`Drawings destination changed while preparing its replacement; no refresh started: ${directory}`);
  }
}

async function requireSameDirectory(directory: string, expected: EntryState): Promise<void> {
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Drawings destination changed to a different directory, file or link: ${directory}`);
  }
}

async function clearContents(directory: string, expected: EntryState): Promise<void> {
  await requireSameDirectory(directory, expected);
  for (const name of await fs.readdir(directory)) {
    await requireSameDirectory(directory, expected);
    await fs.rm(path.join(directory, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

async function copyContents(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const name of await fs.readdir(source)) {
    await fs.cp(path.join(source, name), path.join(destination, name), {
      recursive: true, force: true, dereference: false, verbatimSymlinks: true,
    });
  }
}

// Stage first, then refresh by copying while keeping the project directory in place.
// Directory renames are deliberately avoided for Windows compatibility.
export async function refreshDrawingDestination(
  destination: string,
  logger: Logger,
  context: LogContext,
  stageFiles: (staging: string) => Promise<number>,
): Promise<number> {
  const previous = await snapshotDirectory(destination);
  const root = path.dirname(destination);
  let staging: string | undefined;
  let backup: string | undefined;
  let retainBackup = false;
  let fileCount = 0;
  let failed = false;
  let failure: unknown;

  try {
    await fs.mkdir(root, { recursive: true });
    staging = await fs.mkdtemp(path.join(root, '.drawings-stage-'));
    logger.info('Staging fresh project contents before drawings refresh', { ...context, staging });
    fileCount = await stageFiles(staging);
    await checkUnchanged(destination, previous);

    if (previous) {
      backup = await fs.mkdtemp(path.join(root, '.drawings-backup-'));
      logger.info('Backing up all previous drawings project contents before replacement', { ...context, backup });
      await copyContents(destination, backup);
      await checkUnchanged(destination, previous);
    } else {
      // The staging root exists; nonrecursive mkdir refuses a newly appeared destination.
      await fs.mkdir(destination);
    }
    const destinationState = previous?.get('') ?? (await snapshotDirectory(destination))!.get('')!;

    try {
      logger.info('Refreshing drawings project folder; removing all old contents and copying the fresh staged contents', context);
      await clearContents(destination, destinationState);
      await copyContents(staging, destination);
    } catch (error) {
      try {
        await clearContents(destination, destinationState);
        if (backup) await copyContents(backup, destination);
        else await fs.rmdir(destination);
        logger.warn(backup
          ? 'Drawings refresh failed; previous project contents restored'
          : 'Drawings refresh failed; incomplete new project folder removed', context);
      } catch (restoreError) {
        retainBackup = true;
        logger.error('Could not restore drawings project contents after a refresh failure', {
          ...context, backup, error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
        throw new Error(backup
          ? `Drawings refresh and restoration failed; recovery backup retained at ${backup}`
          : `Drawings refresh and cleanup failed; inspect incomplete output at ${destination}`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  const cleanupFailures: string[] = [];
  for (const directory of [staging, retainBackup ? undefined : backup]) {
    if (!directory) continue;
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      cleanupFailures.push(directory);
      logger.error('Could not remove temporary drawings directory', {
        ...context, directory, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (cleanupFailures.length) {
    const message = failed ? (failure instanceof Error ? failure.message : String(failure))
      : 'Drawings contents refreshed, but temporary cleanup failed';
    throw new Error(`${message}; inspect temporary paths: ${cleanupFailures.join(', ')}`, { cause: failure });
  }
  if (failed) throw failure;
  return fileCount;
}
