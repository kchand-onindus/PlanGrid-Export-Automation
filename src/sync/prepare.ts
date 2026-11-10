import fs from 'node:fs/promises';
import path from 'node:path';
import { readProjects } from '../csv.js';
import type { Logger } from '../logger.js';
import type { Project } from '../types.js';
import type { LocalProjectResult } from '../local-results.js';
import { refreshDrawingDestination } from '../drawings/refresh.js';

const folderNames = ['Documents', 'Photos'] as const;
interface SourceEntry { name: string; source: string }
type CopyMode = 'sync' | 'drawings';
interface FileState { dev: number; ino: number; size: number; mtimeMs: number }
interface CopyItem { source: string; destination: string; directory: boolean; previous?: FileState }

export interface OverwriteRequest {
  project: Project;
  destination: string;
  files: string[];
}
export type ConfirmOverwrite = (request: OverwriteRequest) => Promise<boolean>;

async function statIfPresent(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requireDirectory(directory: string): Promise<void> {
  if (!(await fs.lstat(directory)).isDirectory()) {
    throw new Error(`Expected a directory, not a file or link: ${directory}`);
  }
}

async function foldersAt(root: string, names: readonly string[] = folderNames): Promise<SourceEntry[]> {
  const folders: SourceEntry[] = [];
  for (const name of names) {
    const source = path.join(root, name);
    const stat = await statIfPresent(source);
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Error(`Expected ${name} to be a directory, not a file or link: ${source}`);
    folders.push({ name, source });
  }
  return folders;
}

async function findSourceFolders(extractionRoot: string): Promise<SourceEntry[]> {
  const direct = await foldersAt(extractionRoot);
  if (direct.length) return direct;

  // PlanGrid can place the complete project under one wrapper in the ZIP.
  // Look one level down, never inside Documents/Photos or arbitrary drawing trees.
  const candidates: SourceEntry[][] = [];
  for (const entry of await fs.readdir(extractionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folders = await foldersAt(path.join(extractionRoot, entry.name));
    if (folders.length) candidates.push(folders);
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple project wrappers contain Documents/Photos; refusing to merge ambiguous sources: ${extractionRoot}`);
  }
  return candidates[0] ?? [];
}

async function findDrawingSources(extractionRoot: string): Promise<SourceEntry[]> {
  const entries = await fs.readdir(extractionRoot, { withFileTypes: true });
  const projectFolders = [...folderNames, 'Drawings'];
  let sourceRoot = extractionRoot;
  if (!entries.some((entry) => projectFolders.includes(entry.name))) {
    const wrappers: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(extractionRoot, entry.name);
      if ((await foldersAt(candidate, projectFolders)).length) wrappers.push(candidate);
    }
    if (wrappers.length > 1) {
      throw new Error(`Multiple project wrappers contain Documents/Photos/Drawings; refusing to merge ambiguous sources: ${extractionRoot}`);
    }
    // Only omit a sole project wrapper; otherwise retain every sibling and its hierarchy.
    if (wrappers.length === 1 && entries.length === 1) sourceRoot = wrappers[0];
  }
  return (await fs.readdir(sourceRoot))
    .filter((name) => !folderNames.some((excluded) => name === excluded))
    .map((name) => ({ name, source: path.join(sourceRoot, name) }));
}

function overlaps(first: string, second: string): boolean {
  const relative = path.relative(first, second);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function canonicalPath(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (error) {
    const parent = path.dirname(file);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === file) throw error;
    return path.join(await canonicalPath(parent), path.basename(file));
  }
}

async function planCopy(source: string, destination: string, items: CopyItem[]): Promise<void> {
  const sourceStat = await fs.lstat(source);
  const directory = sourceStat.isDirectory();
  if (!directory && !sourceStat.isFile()) throw new Error(`Links and special files cannot be copied: ${source}`);
  const existing = await statIfPresent(destination);
  if (existing && (directory ? !existing.isDirectory() : !existing.isFile())) {
    throw new Error(`Copy destination has an incompatible file/directory type or link: ${destination}`);
  }
  items.push({ source, destination, directory, previous: !directory && existing ? {
    dev: existing.dev, ino: existing.ino, size: existing.size, mtimeMs: existing.mtimeMs,
  } : undefined });
  if (directory) {
    for (const name of await fs.readdir(source)) await planCopy(path.join(source, name), path.join(destination, name), items);
  }
}

async function checkDestination(item: CopyItem): Promise<void> {
  const current = await statIfPresent(item.destination);
  if (item.directory) {
    if (current && !current.isDirectory()) throw new Error(`Copy destination changed to a file or link: ${item.destination}`);
  } else if (item.previous) {
    if (!current?.isFile() || current.dev !== item.previous.dev || current.ino !== item.previous.ino
        || current.size !== item.previous.size || current.mtimeMs !== item.previous.mtimeMs) {
      throw new Error(`Existing destination file changed after the overwrite preview; rerun to review it: ${item.destination}`);
    }
  } else if (current) {
    throw new Error(`A new destination file appeared after the preview; rerun to review it: ${item.destination}`);
  }
}

async function copyItem(item: CopyItem): Promise<void> {
  if (!item.previous) {
    await fs.copyFile(item.source, item.destination, fs.constants.COPYFILE_EXCL);
    return;
  }
  // Finish the incoming copy before replacing an approved destination file.
  const temporary = await fs.mkdtemp(path.join(path.dirname(item.destination), '.sync-copy-'));
  try {
    const staged = path.join(temporary, 'incoming');
    await fs.copyFile(item.source, staged, fs.constants.COPYFILE_EXCL);
    await checkDestination(item);
    await fs.rename(staged, item.destination);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareSync(
  inputFile: string,
  downloadRoot: string,
  syncUpRoot: string,
  logger: Logger,
  confirmOverwrite?: ConfirmOverwrite,
): Promise<LocalProjectResult[]> {
  return prepareLocalCopies(inputFile, downloadRoot, syncUpRoot, logger, 'sync', confirmOverwrite);
}

export async function prepareDrawings(
  inputFile: string,
  downloadRoot: string,
  drawingsRoot: string,
  logger: Logger,
): Promise<LocalProjectResult[]> {
  return prepareLocalCopies(inputFile, downloadRoot, drawingsRoot, logger, 'drawings');
}

async function prepareLocalCopies(
  inputFile: string,
  downloadRoot: string,
  destinationRoot: string,
  logger: Logger,
  mode: CopyMode,
  confirmOverwrite?: ConfirmOverwrite,
): Promise<LocalProjectResult[]> {
  const description = mode === 'sync' ? 'Documents/Photos' : 'contents except Documents/Photos';
  const noSources = mode === 'sync' ? 'No Documents or Photos folders found' : 'No contents other than Documents or Photos found';
  const projects = await readProjects(inputFile);
  const results: LocalProjectResult[] = [];
  for (const project of projects) {
    const startedAt = Date.now();
    const projectDirectory = path.resolve(downloadRoot, project.projectCleanName);
    const extractionRoot = path.join(projectDirectory, project.projectCleanName);
    const destination = path.resolve(destinationRoot, project.projectCleanName);
    const context = {
      projectUid: project.projectUid, projectName: project.projectName,
      projectCleanName: project.projectCleanName, extractionRoot, destination,
    };
    if (!project.enabled) {
      logger.info('Skipping disabled project', { ...context, skipReason: 'DISABLED' });
      results.push({ project, status: 'SKIPPED', skipReason: 'DISABLED', message: 'Project is disabled', durationMs: 0 });
      continue;
    }
    try {
      let missingSource: string | undefined;
      for (const source of [projectDirectory, extractionRoot]) {
        const entry = await statIfPresent(source);
        if (!entry) { missingSource = source; break; }
        if (!entry.isDirectory()) throw new Error(`Expected a directory, not a file or link: ${source}`);
      }
      if (missingSource) {
        const message = 'Extracted project source is missing; no copying attempted';
        logger.warn('Project skipped; extracted source is missing', {
          ...context, skipReason: 'MISSING_EXTRACTION', missingSource,
        });
        results.push({ project, status: 'SKIPPED', skipReason: 'MISSING_EXTRACTION', message, durationMs: Date.now() - startedAt });
        continue;
      }
      const sources = await (mode === 'sync' ? findSourceFolders(extractionRoot) : findDrawingSources(extractionRoot));
      if (!sources.length) {
        const skipReason = mode === 'sync' ? 'NO_MATCHING_FOLDER' : 'NO_MATCHING_CONTENT';
        logger.info(`${noSources}; skipping project`, { ...context, skipReason });
        results.push({ project, status: 'SKIPPED', skipReason, message: noSources, durationMs: Date.now() - startedAt });
        continue;
      }
      // Resolve existing ancestors to catch aliases without creating output.
      const sourceRoot = await fs.realpath(extractionRoot);
      const actualDestination = await canonicalPath(destination);
      if (overlaps(sourceRoot, actualDestination) || overlaps(actualDestination, sourceRoot)) {
        throw new Error('Copy destination must be separate from the extracted project tree');
      }
      const existing = await statIfPresent(destination);
      if (existing && !existing.isDirectory()) throw new Error(`Destination project folder must be a directory, not a file or link: ${destination}`);
      if (mode === 'sync' && !existing) {
        throw new Error(`Destination project folder must already exist; no folders or files were created: ${destination}`);
      }
      if (mode === 'drawings') {
        const fileCount = await refreshDrawingDestination(destination, logger, context, async (staging) => {
          const stagedItems: CopyItem[] = [];
          for (const entry of sources) await planCopy(entry.source, path.join(staging, entry.name), stagedItems);
          for (const item of stagedItems) {
            if (item.directory) await fs.mkdir(item.destination, { recursive: true });
            else await copyItem(item);
          }
          return stagedItems.filter((item) => !item.directory).length;
        });
        logger.success('Project drawings staging refreshed completely; source contents retained', {
          ...context, entries: sources.map((entry) => entry.name), fileCount,
        });
        results.push({ project, status: 'SUCCESS', downloadDirectory: destination, durationMs: Date.now() - startedAt });
        continue;
      }
      const items: CopyItem[] = [];
      for (const entry of sources) await planCopy(entry.source, path.join(destination, entry.name), items);
      const overwritten = items.filter((item) => item.previous);
      {
        const existingFolders = [];
        for (const entry of sources) {
          if (await statIfPresent(path.join(destination, entry.name))) existingFolders.push(entry.name);
        }
        if (existingFolders.length) {
          logger.warn('Documents/Photos destination folders already exist; contents will be merged and unrelated files retained', {
            ...context, existingFolders, overwrittenFileCount: overwritten.length,
          });
        }
      }
      if (overwritten.length) {
        logger.warn('Existing destination files require overwrite confirmation', { ...context, existingFileCount: overwritten.length });
        if (!confirmOverwrite) throw new Error('Existing destination files require overwrite approval; run npm run sync:prepare in an interactive terminal');
        const approved = await confirmOverwrite({ project, destination, files: overwritten.map((item) => item.destination) });
        if (!approved) {
          logger.info('Overwrite declined; project skipped without changes', { ...context, skipReason: 'OVERWRITE_DECLINED' });
          results.push({ project, status: 'SKIPPED', skipReason: 'OVERWRITE_DECLINED', message: 'Overwrite declined; destination unchanged', durationMs: Date.now() - startedAt });
          continue;
        }
        logger.info('Overwrite approved for existing destination files', { ...context, existingFileCount: overwritten.length });
      }
      // Recheck the preview before making changes, especially after waiting for input.
      await requireDirectory(destination);
      for (const item of items) await checkDestination(item);

      logger.info(`Copying project ${description} to local staging`, { ...context, entries: sources.map((entry) => entry.name) });
      for (const item of items) {
        if (item.directory) await fs.mkdir(item.destination, { recursive: true });
        else await copyItem(item);
      }
      logger.success(`Project ${description} copied; source contents retained`, {
        ...context, entries: sources.map((entry) => entry.name), fileCount: items.filter((item) => !item.directory).length,
        overwrittenFileCount: overwritten.length,
      });
      results.push({ project, status: 'SUCCESS', downloadDirectory: destination, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Project ${mode} preparation failed`, { ...context, error: message });
      results.push({ project, status: 'FAILED', message, downloadDirectory: destination, durationMs: Date.now() - startedAt });
    }
  }
  return results;
}
