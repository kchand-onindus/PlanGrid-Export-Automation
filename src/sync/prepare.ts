import fs from 'node:fs/promises';
import path from 'node:path';
import { readProjects } from '../csv.js';
import type { Logger, LogContext } from '../logger.js';
import type { Project } from '../types.js';
import type { LocalProjectResult } from '../local-results.js';
import { refreshDrawingDestination } from '../drawings/refresh.js';

const folderNames = ['Documents', 'Photos'] as const;
interface SourceEntry { name: string; source: string }
type CopyMode = 'sync' | 'drawings';
interface TreeEntry {
  relative: string;
  directory: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
interface SyncFolder extends SourceEntry {
  target: string;
  items: { incoming: TreeEntry; previous?: TreeEntry }[];
}

interface ProjectOverwritePreview {
  project: Project;
  destination: string;
  files: string[];
  folders?: string[];
}
export interface OverwriteRequest extends ProjectOverwritePreview {
  additionalProjects?: ProjectOverwritePreview[];
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

async function readTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    const directory = stat.isDirectory();
    if (!directory && !stat.isFile()) throw new Error(`Links and special files cannot be copied: ${file}`);
    entries.push({
      relative, directory, dev: stat.dev, ino: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    });
    if (directory) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
    }
  }
  await visit('');
  return entries;
}

async function copyTree(entries: TreeEntry[], source: string, destination: string): Promise<void> {
  for (const entry of entries) {
    const target = path.join(destination, entry.relative);
    if (entry.directory) await fs.mkdir(target);
    else await fs.copyFile(path.join(source, entry.relative), target, fs.constants.COPYFILE_EXCL);
  }
}

async function requireSameDirectory(directory: string, expected: { dev: number; ino: number }): Promise<void> {
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Destination directory changed: ${directory}`);
  }
}

async function planSyncFolders(sources: SourceEntry[], destination: string): Promise<SyncFolder[]> {
  const folders: SyncFolder[] = [];
  for (const source of sources) {
    const target = path.join(destination, source.name);
    const items: SyncFolder['items'] = [];
    for (const incoming of await readTree(source.source)) {
      const file = path.join(target, incoming.relative);
      const stat = await statIfPresent(file);
      if (stat && !(incoming.directory ? stat.isDirectory() : stat.isFile())) {
        throw new Error(`Copy destination has an incompatible file/directory type or link: ${file}`);
      }
      items.push({ incoming, previous: stat && {
        relative: incoming.relative, directory: incoming.directory, dev: stat.dev, ino: stat.ino,
        size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      } });
    }
    folders.push({ ...source, target, items });
  }
  return folders;
}

function buildOverwritePreview(
  project: Project, destination: string, folders: SyncFolder[],
): ProjectOverwritePreview | undefined {
  const files: string[] = [];
  const affectedFolders: string[] = [];
  for (const { name, target, items } of folders) {
    const matches = items.filter(({ incoming, previous }) => !incoming.directory && previous);
    if (!matches.length) continue;
    affectedFolders.push(name);
    files.push(...matches.map(({ incoming }) => path.join(target, incoming.relative)));
  }
  if (!files.length) return undefined;
  return { project, destination, folders: affectedFolders, files };
}

async function checkSyncItem(file: string, { incoming, previous }: SyncFolder['items'][number]): Promise<void> {
  const current = await statIfPresent(file);
  if (!previous && !current) return;
  if (previous && current && current.dev === previous.dev && current.ino === previous.ino) {
    if (incoming.directory && current.isDirectory()) return;
    if (!incoming.directory && current.isFile() && current.size === previous.size
        && current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs) return;
  }
  throw new Error(`Destination changed after the overwrite preview; rerun to review it: ${file}`);
}

async function mergeSyncFolders(
  folders: SyncFolder[], destination: string, parent: { dev: number; ino: number },
): Promise<number> {
  await requireSameDirectory(destination, parent);
  for (const { source, target, items } of folders) {
    if (JSON.stringify(await readTree(source)) !== JSON.stringify(items.map(({ incoming }) => incoming))) {
      throw new Error(`Extracted source changed during sync preparation; rerun to review it: ${source}`);
    }
    for (const item of items) await checkSyncItem(path.join(target, item.incoming.relative), item);
  }

  let fileCount = 0;
  for (const { source, target, items } of folders) {
    const directories = new Map<string, { dev: number; ino: number }>([[destination, parent]]);
    for (const item of items) {
      const from = path.join(source, item.incoming.relative);
      const to = path.join(target, item.incoming.relative);
      const directory = path.dirname(to);
      const expectedParent = directories.get(directory)!;
      await requireSameDirectory(destination, parent);
      await requireSameDirectory(directory, expectedParent);
      await checkSyncItem(to, item);
      if (item.incoming.directory) {
        if (!item.previous) await fs.mkdir(to);
        directories.set(to, item.previous ?? await fs.lstat(to));
        continue;
      }

      if (item.previous) {
        // Stage next to the destination so the file replacement stays on the same filesystem.
        const temporary = await fs.mkdtemp(path.join(directory, '.sync-copy-'));
        try {
          const staged = path.join(temporary, 'incoming');
          await fs.copyFile(from, staged, fs.constants.COPYFILE_EXCL);
          await requireSameDirectory(destination, parent);
          await requireSameDirectory(directory, expectedParent);
          await checkSyncItem(to, item);
          await fs.rename(staged, to);
        } finally {
          await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
        }
      } else {
        await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      }
      fileCount++;
    }
  }
  return fileCount;
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
  const results = new Map<Project, LocalProjectResult>();
  const syncPlans: {
    project: Project;
    destination: string;
    parent: { dev: number; ino: number };
    folders: SyncFolder[];
    preview: ProjectOverwritePreview | undefined;
    context: LogContext;
    startedAt: number;
  }[] = [];
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
      results.set(project, { project, status: 'SKIPPED', skipReason: 'DISABLED', message: 'Project is disabled', durationMs: 0 });
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
        results.set(project, { project, status: 'SKIPPED', skipReason: 'MISSING_EXTRACTION', message, durationMs: Date.now() - startedAt });
        continue;
      }
      const sources = await (mode === 'sync' ? findSourceFolders(extractionRoot) : findDrawingSources(extractionRoot));
      if (!sources.length) {
        const skipReason = mode === 'sync' ? 'NO_MATCHING_FOLDER' : 'NO_MATCHING_CONTENT';
        logger.info(`${noSources}; skipping project`, { ...context, skipReason });
        results.set(project, { project, status: 'SKIPPED', skipReason, message: noSources, durationMs: Date.now() - startedAt });
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
      if (mode === 'drawings') {
        const fileCount = await refreshDrawingDestination(destination, logger, context, async (staging) => {
          let fileCount = 0;
          for (const entry of sources) {
            const tree = await readTree(entry.source);
            await copyTree(tree, entry.source, path.join(staging, entry.name));
            fileCount += tree.filter(({ directory }) => !directory).length;
          }
          return fileCount;
        });
        logger.success('Project drawings staging refreshed completely; source contents retained', {
          ...context, entries: sources.map((entry) => entry.name), fileCount,
        });
        results.set(project, { project, status: 'SUCCESS', downloadDirectory: destination, durationMs: Date.now() - startedAt });
        continue;
      }
      if (!existing) {
        throw new Error(`Destination project folder must already exist; no folders or files were created: ${destination}`);
      }
      const folders = await planSyncFolders(sources, destination);
      const preview = buildOverwritePreview(project, destination, folders);
      const existingFolders = folders.filter(({ items }) => items[0].previous).map(({ name }) => name);
      if (existingFolders.length) {
        logger.warn('Documents/Photos destination folders already exist; destination-only items will be kept', {
          ...context, existingFolders, overwrittenFileCount: preview?.files.length ?? 0,
        });
      }
      syncPlans.push({ project, destination, parent: existing, folders, preview, context, startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Project ${mode} preparation failed`, { ...context, error: message });
      results.set(project, { project, status: 'FAILED', message, downloadDirectory: destination, durationMs: Date.now() - startedAt });
    }
  }
  const previews = syncPlans.flatMap(({ preview }) => preview ? [preview] : []);
  const [first, ...additionalProjects] = previews;
  let approved = false;
  let approvalError: string | undefined;
  if (first) {
    try {
      if (!confirmOverwrite) {
        throw new Error('Existing contents require overwrite approval; run npm run sync:prepare in an interactive terminal');
      }
      approved = await confirmOverwrite({ ...first, additionalProjects });
    } catch (error) {
      approvalError = error instanceof Error ? error.message : String(error);
    }
  }

  for (const { project, destination, parent, folders, preview, context, startedAt } of syncPlans) {
    try {
      if (preview) {
        if (approvalError !== undefined) throw new Error(approvalError);
        if (!approved) {
          logger.info('Overwrite declined; project skipped without changes', { ...context, skipReason: 'OVERWRITE_DECLINED' });
          results.set(project, { project, status: 'SKIPPED', skipReason: 'OVERWRITE_DECLINED', message: 'Overwrite declined; destination unchanged', durationMs: Date.now() - startedAt });
          continue;
        }
      }
      const fileCount = await mergeSyncFolders(folders, destination, parent);
      logger.success('Project Documents/Photos copied; source contents retained', {
        ...context, entries: folders.map(({ name }) => name), fileCount,
      });
      results.set(project, { project, status: 'SUCCESS', downloadDirectory: destination, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Project sync preparation failed', { ...context, error: message });
      results.set(project, { project, status: 'FAILED', message, downloadDirectory: destination, durationMs: Date.now() - startedAt });
    }
  }
  return projects.map((project) => results.get(project)!);
}
