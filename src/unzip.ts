import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import type { Entry, ZipFile } from 'yauzl';
import { readProjects } from './csv.js';
import { withArchive } from './import/archive.js';
import type { Logger } from './logger.js';
import type { ProjectResult } from './types.js';

async function statIfPresent(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Check an existing filename without creating probe files in the download folder.
async function isCaseSensitive(zipPath: string): Promise<boolean> {
  const alternateName = path.basename(zipPath).replace(/[a-zA-Z]/g, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
  const alternate = await statIfPresent(path.join(path.dirname(zipPath), alternateName));
  if (!alternate) return true;
  const original = await fs.lstat(zipPath);
  return original.dev !== alternate.dev || original.ino !== alternate.ino;
}

// Validate the whole archive and existing destinations before creating any output.
async function planExtraction(entries: Entry[], directory: string, caseSensitive: boolean) {
  const destinations = new Map<string, { relative: string; directory: boolean }>();
  const files: { entry: Entry; destination: string }[] = [];
  for (const entry of entries) {
    const isDirectory = entry.fileName.endsWith('/');
    const relative = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName;
    const parts = relative.split('/');
    const type = (entry.externalFileAttributes >>> 16) & 0o170000;
    if ((type && type !== (isDirectory ? 0o040000 : 0o100000))
        || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\u0000'))) {
      throw new Error(`Unsafe or unsupported ZIP entry: ${entry.fileName}`);
    }
    // Preserve archive names. If this host cannot represent one, report it
    // rather than silently renaming it (or creating a Windows alternate stream).
    if (process.platform === 'win32' && parts.some((part) => /[<>:"\\|?*\u0000-\u001f]/u.test(part)
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`ZIP entry name cannot be preserved on Windows: ${entry.fileName}`);
    }
    const destination = path.resolve(directory, ...parts);
    if (!destination.startsWith(`${directory}${path.sep}`)) {
      throw new Error(`ZIP entry escapes the project directory: ${entry.fileName}`);
    }
    for (let length = 1; length <= parts.length; length++) {
      const relativePath = parts.slice(0, length).join('/');
      const directoryEntry = length < parts.length || isDirectory;
      const key = caseSensitive ? relativePath : relativePath.normalize('NFC').toLowerCase();
      const previous = destinations.get(key);
      if (previous && (previous.relative !== relativePath || !previous.directory || !directoryEntry)) {
        throw new Error(`Colliding ZIP paths: "${previous.relative}" and "${relativePath}". `
          + (previous.relative !== relativePath
            ? 'Preserving both names requires a case-sensitive extraction location.'
            : 'The archive uses the same output path more than once.'));
      }
      destinations.set(key, { relative: relativePath, directory: directoryEntry });
    }
    if (!isDirectory) files.push({ entry, destination });
  }
  for (const item of destinations.values()) {
    const destination = path.join(directory, item.relative);
    const existing = await statIfPresent(destination);
    if (existing && (!item.directory || !existing.isDirectory() || existing.isSymbolicLink())) {
      throw new Error(`Extraction would overwrite an existing path or follow a link: ${destination}`);
    }
  }
  return { destinations, files };
}

async function extractFile(zip: ZipFile, entry: Entry, destination: string): Promise<void> {
  const source = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream!);
    });
  });
  let checksum = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
  });
  await pipeline(source, verifier, createWriteStream(destination, { flags: 'wx' }));
  if (checksum !== entry.crc32) throw new Error(`CRC mismatch for ZIP entry: ${entry.fileName}`);
  if ((await fs.stat(destination)).size !== entry.uncompressedSize) {
    throw new Error(`Extracted size mismatch for ZIP entry: ${entry.fileName}`);
  }
}

export async function unzipProjects(inputFile: string, downloadRoot: string, logger: Logger): Promise<ProjectResult[]> {
  const projects = await readProjects(inputFile);
  const results: ProjectResult[] = [];
  for (const project of projects) {
    const startedAt = Date.now();
    const projectDirectory = path.resolve(downloadRoot, project.projectCleanName);
    const zipPath = path.join(projectDirectory, `${project.projectCleanName}.zip`);
    const directory = path.join(projectDirectory, project.projectCleanName);
    const context = { projectUid: project.projectUid, projectCleanName: project.projectCleanName, zipPath, extractionDirectory: directory };
    if (!project.enabled) {
      logger.info('Skipping disabled project', context);
      results.push({ project, status: 'SKIPPED', message: 'Project is disabled', durationMs: 0 });
      continue;
    }
    try {
      if (!(await fs.lstat(projectDirectory)).isDirectory()) {
        throw new Error(`Project download folder must be a directory, not a link: ${projectDirectory}`);
      }
      if (!(await fs.lstat(zipPath)).isFile()) {
        throw new Error(`Project ZIP must be a regular file, not a link: ${zipPath}`);
      }
      const existing = await statIfPresent(directory);
      if (existing && !existing.isDirectory()) {
        throw new Error(`Extraction folder must be a directory, not a file or link: ${directory}`);
      }
      const caseSensitive = await isCaseSensitive(zipPath);
      logger.info('Extracting project ZIP into its clean-name parent folder', context);
      const fileCount = await withArchive(zipPath, async (zip, entries) => {
        const plan = await planExtraction(entries, directory, caseSensitive);
        await fs.mkdir(directory, { recursive: true });
        for (const item of plan.destinations.values()) {
          if (item.directory) await fs.mkdir(path.join(directory, item.relative), { recursive: true });
        }
        for (const file of plan.files) await extractFile(zip, file.entry, file.destination);
        return plan.files.length;
      });
      logger.success('Project ZIP extracted; source ZIP retained', { ...context, fileCount });
      results.push({ project, status: 'SUCCESS', downloadDirectory: directory, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Project ZIP extraction failed', { ...context, error: message });
      results.push({ project, status: 'FAILED', message, downloadDirectory: directory, durationMs: Date.now() - startedAt });
    }
  }
  return results;
}
