import fs from 'node:fs/promises';
import os from 'node:os';
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
  previous: TreeEntry[];
  incoming: TreeEntry[];
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

async function clearContents(directory: string, expected: { dev: number; ino: number }): Promise<void> {
  await requireSameDirectory(directory, expected);
  for (const name of await fs.readdir(directory)) {
    await requireSameDirectory(directory, expected);
    await fs.rm(path.join(directory, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

async function planSyncFolders(sources: SourceEntry[], destination: string): Promise<SyncFolder[]> {
  const folders: SyncFolder[] = [];
  for (const source of sources) {
    const target = path.join(destination, source.name);
    const previous = await statIfPresent(target) ? await readTree(target) : [];
    const incoming = await readTree(source.source);
    if ((previous.length && !previous[0].directory) || !incoming[0].directory) {
      throw new Error(`Expected a Documents/Photos directory: ${target}`);
    }
    folders.push({ ...source, target, previous, incoming });
  }

  return folders;
}

function buildOverwritePreview(
  project: Project, destination: string, folders: SyncFolder[],
): ProjectOverwritePreview | undefined {
  const replacing = folders.filter(({ previous }) => previous.length > 1);
  if (!replacing.length) return undefined;
  return {
    project, destination,
    folders: replacing.map(({ name }) => name),
    files: replacing.flatMap(({ target, previous }) =>
      previous.slice(1).map(({ relative }) => path.join(target, relative))),
  };
}

async function refreshSyncFolders(
  folders: SyncFolder[],
  destination: string,
  parent: { dev: number; ino: number },
  logger: Logger,
  context: LogContext,
): Promise<number> {
  async function checkDestination({ target, previous }: SyncFolder): Promise<void> {
    await requireSameDirectory(destination, parent);
    const current = await statIfPresent(target) ? await readTree(target) : [];
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      throw new Error(`Destination contents changed after the replacement preview; rerun to review them: ${target}`);
    }
  }

  for (const folder of folders) await checkDestination(folder);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'plangrid-sync-'));
  const staged = path.join(temporary, 'incoming');
  const backup = path.join(temporary, 'backup');
  const started: { folder: SyncFolder; directory: { dev: number; ino: number } }[] = [];
  let keepBackup = false;
  try {
    await fs.mkdir(staged);
    await fs.mkdir(backup);
    for (const folder of folders) {
      if (JSON.stringify(await readTree(folder.source)) !== JSON.stringify(folder.incoming)) {
        throw new Error(`Extracted source changed during sync preparation; rerun to review it: ${folder.source}`);
      }
      await copyTree(folder.incoming, folder.source, path.join(staged, folder.name));
      if (folder.previous.length) await copyTree(folder.previous, folder.target, path.join(backup, folder.name));
    }

    // Verify both folders before clearing either, including destination-only entries.
    for (const folder of folders) await checkDestination(folder);

    try {
      for (const folder of folders) {
        await checkDestination(folder);
        if (!folder.previous.length) await fs.mkdir(folder.target);
        const directory = folder.previous[0] ?? await fs.lstat(folder.target);
        started.push({ folder, directory });
        await clearContents(folder.target, directory);
        await copyTree(folder.incoming.slice(1), path.join(staged, folder.name), folder.target);
      }
    } catch (error) {
      for (const { folder, directory } of started.reverse()) {
        try {
          await requireSameDirectory(destination, parent);
          await clearContents(folder.target, directory);
          if (folder.previous.length) {
            await copyTree(folder.previous.slice(1), path.join(backup, folder.name), folder.target);
          } else {
            await fs.rmdir(folder.target);
          }
        } catch (restoreError) {
          keepBackup = true;
          logger.error('Could not restore sync folder contents', {
            ...context, folder: folder.target, error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          });
        }
      }
      if (keepBackup) throw new Error(`Sync refresh and restoration failed; recovery backup retained at ${backup}`, { cause: error });
      throw error;
    }

    return folders.reduce((count, folder) => count + folder.incoming.filter(({ directory }) => !directory).length, 0);
  } finally {
    if (!keepBackup) {
      try {
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        logger.error('Could not remove temporary sync directory', {
          ...context, temporary, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
          logger.info('Replacement declined; project skipped without changes', { ...context, skipReason: 'OVERWRITE_DECLINED' });
          results.set(project, { project, status: 'SKIPPED', skipReason: 'OVERWRITE_DECLINED', message: 'Replacement declined; destination unchanged', durationMs: Date.now() - startedAt });
          continue;
        }
      }
      const fileCount = await refreshSyncFolders(folders, destination, parent, logger, context);
      logger.success('Project Documents/Photos contents refreshed; source contents retained', {
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
