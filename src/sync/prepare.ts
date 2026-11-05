import fs from 'node:fs/promises';
import path from 'node:path';
import { readProjects } from '../csv.js';
import type { Logger } from '../logger.js';
import type { Project, ProjectResult } from '../types.js';

const folderNames = ['Documents', 'Photos'] as const;
interface SourceFolder { name: typeof folderNames[number]; source: string }
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

async function foldersAt(root: string): Promise<SourceFolder[]> {
  const folders: SourceFolder[] = [];
  for (const name of folderNames) {
    const source = path.join(root, name);
    const stat = await statIfPresent(source);
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Error(`Expected ${name} to be a directory, not a file or link: ${source}`);
    folders.push({ name, source });
  }
  return folders;
}

async function findSourceFolders(extractionRoot: string): Promise<SourceFolder[]> {
  const direct = await foldersAt(extractionRoot);
  if (direct.length) return direct;

  // PlanGrid can place the complete project under one wrapper in the ZIP.
  // Look one level down, never inside Documents/Photos or arbitrary drawing trees.
  const candidates: SourceFolder[][] = [];
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
    if (current && !current.isDirectory()) throw new Error(`Sync destination changed to a file or link: ${item.destination}`);
  } else if (item.previous) {
    if (!current?.isFile() || current.dev !== item.previous.dev || current.ino !== item.previous.ino
        || current.size !== item.previous.size || current.mtimeMs !== item.previous.mtimeMs) {
      throw new Error(`Existing sync file changed after the overwrite preview; rerun to review it: ${item.destination}`);
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
): Promise<ProjectResult[]> {
  const projects = await readProjects(inputFile);
  const results: ProjectResult[] = [];
  for (const project of projects) {
    const startedAt = Date.now();
    const projectDirectory = path.resolve(downloadRoot, project.projectCleanName);
    const extractionRoot = path.join(projectDirectory, project.projectCleanName);
    const destination = path.resolve(syncUpRoot, project.projectCleanName);
    const context = { projectUid: project.projectUid, projectCleanName: project.projectCleanName, extractionRoot, destination };
    if (!project.enabled) {
      logger.info('Skipping disabled project', context);
      results.push({ project, status: 'SKIPPED', message: 'Project is disabled', durationMs: 0 });
      continue;
    }
    try {
      await requireDirectory(projectDirectory);
      await requireDirectory(extractionRoot);
      const folders = await findSourceFolders(extractionRoot);
      if (!folders.length) {
        logger.info('No Documents or Photos folders found; skipping project', context);
        results.push({ project, status: 'SKIPPED', message: 'No Documents or Photos folders found', durationMs: Date.now() - startedAt });
        continue;
      }
      // Resolve existing ancestors to catch aliases without creating output.
      const sourceRoot = await fs.realpath(extractionRoot);
      const actualDestination = await canonicalPath(destination);
      if (overlaps(sourceRoot, actualDestination) || overlaps(actualDestination, sourceRoot)) {
        throw new Error('Sync destination must be separate from the extracted project tree');
      }
      const existing = await statIfPresent(destination);
      if (existing && !existing.isDirectory()) throw new Error(`Sync project folder must be a directory, not a file or link: ${destination}`);
      const items: CopyItem[] = [];
      for (const folder of folders) await planCopy(folder.source, path.join(destination, folder.name), items);
      const overwritten = items.filter((item) => item.previous);
      if (overwritten.length) {
        logger.warn('Existing sync files require overwrite confirmation', { ...context, existingFileCount: overwritten.length });
        if (!confirmOverwrite) throw new Error('Existing sync files require overwrite approval; run npm run sync:prepare in an interactive terminal');
        const approved = await confirmOverwrite({ project, destination, files: overwritten.map((item) => item.destination) });
        if (!approved) {
          logger.info('Overwrite declined; project skipped without changes', context);
          results.push({ project, status: 'SKIPPED', message: 'Overwrite declined; destination unchanged', durationMs: Date.now() - startedAt });
          continue;
        }
        logger.info('Overwrite approved for existing sync files', { ...context, existingFileCount: overwritten.length });
      }
      // Recheck the preview before making changes, especially after waiting for input.
      for (const item of items) await checkDestination(item);

      logger.info('Copying project Documents/Photos to local sync staging', { ...context, folders: folders.map((folder) => folder.name) });
      await fs.mkdir(destination, { recursive: true });
      for (const item of items) {
        if (item.directory) await fs.mkdir(item.destination, { recursive: true });
        else await copyItem(item);
      }
      logger.success('Project Documents/Photos copied; source contents retained', {
        ...context, folders: folders.map((folder) => folder.name), fileCount: items.filter((item) => !item.directory).length,
        overwrittenFileCount: overwritten.length,
      });
      results.push({ project, status: 'SUCCESS', downloadDirectory: destination, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Project sync preparation failed', { ...context, error: message });
      results.push({ project, status: 'FAILED', message, downloadDirectory: destination, durationMs: Date.now() - startedAt });
    }
  }
  return results;
}
