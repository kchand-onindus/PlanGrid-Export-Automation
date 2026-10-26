import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { ImportFile, VersionSet } from './types.js';

export interface VersionFolder {
  archiveFolder: string;
  entries: Entry[];
}

interface ArchiveContents {
  drawingsRoot: string;
  excludedFolders: string[];
  folders: Map<string, VersionFolder>;
}

export async function withArchive<T>(
  zipPath: string,
  action: (zip: ZipFile, entries: Entry[]) => Promise<T>,
): Promise<T> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, opened) => {
      if (error) reject(error);
      else resolve(opened!);
    });
  });
  try {
    const entries = await new Promise<Entry[]>((resolve, reject) => {
      const result: Entry[] = [];
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        result.push(entry);
        zip.readEntry();
      });
      zip.once('end', () => resolve(result));
      zip.readEntry();
    });
    return await action(zip, entries);
  } finally {
    zip.close();
  }
}

function isMetadata(parts: string[]): boolean {
  return parts.some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'));
}

export function inspectDrawings(entries: Entry[]): ArchiveContents {
  const roots = new Set<string>();
  for (const entry of entries) {
    const parts = entry.fileName.split('/');
    if (isMetadata(parts)) continue;
    // PlanGrid archives contain either Drawings/... or a single project wrapper/Drawings/...
    const index = parts[0].toLowerCase() === 'drawings' ? 0
      : parts[1]?.toLowerCase() === 'drawings' ? 1 : -1;
    if (index >= 0) roots.add(parts.slice(0, index + 1).join('/'));
  }
  if (roots.size !== 1) {
    throw new Error(`Expected one Drawings directory in the ZIP; found ${roots.size}`);
  }
  const drawingsRoot = [...roots][0];
  const folders = new Map<string, VersionFolder>();
  const excludedFolders = new Set<string>();
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (!entry.fileName.startsWith(`${drawingsRoot}/`)) continue;
    const parts = entry.fileName.slice(drawingsRoot.length + 1).split('/');
    if (!parts[0] || isMetadata(parts)) continue;
    const [name, ...remainder] = parts;
    const archiveFolder = `${drawingsRoot}/${name}`;
    if (name.toLowerCase() === 'current') {
      excludedFolders.add(archiveFolder);
      continue;
    }
    if (!remainder.length) throw new Error(`Unexpected file directly inside Drawings: ${entry.fileName}`);
    if (seenPaths.has(entry.fileName)) throw new Error(`Duplicate ZIP entry: ${entry.fileName}`);
    seenPaths.add(entry.fileName);
    const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
      throw new Error(`Unsupported ZIP entry (links and special files are excluded): ${entry.fileName}`);
    }
    if (remainder.slice(0, -1).some((part) => !part || part === '.')) {
      throw new Error(`Invalid ZIP path: ${entry.fileName}`);
    }
    const folder = folders.get(name) ?? { archiveFolder, entries: [] };
    folders.set(name, folder);
    if (!entry.fileName.endsWith('/')) {
      if (!entry.uncompressedSize) throw new Error(`Empty drawing file: ${entry.fileName}`);
      folder.entries.push(entry);
    }
  }
  return { drawingsRoot, excludedFolders: [...excludedFolders], folders };
}

function normalizedFolderName(value: string): string {
  return value.normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .toLowerCase();
}

export function mapVersionFolders(
  versions: VersionSet[],
  folders: Map<string, VersionFolder>,
): VersionFolder[] {
  const used = new Set<string>();
  const mapped = versions.map((version) => {
    const matches = [...folders].filter(([name]) =>
      name.toLowerCase() === version.versionSetUid.toLowerCase()
      || normalizedFolderName(name) === normalizedFolderName(version.versionName));
    if (matches.length !== 1) {
      throw new Error(`Version "${version.versionName}" (${version.versionSetUid}) matched ${matches.length} `
        + `Drawings folders; expected exactly one. Available: ${[...folders.keys()].join(', ')}`);
    }
    const [name, folder] = matches[0];
    if (used.has(name)) throw new Error(`Drawings folder "${name}" maps to more than one CSV version`);
    if (!folder.entries.length) throw new Error(`Version folder "${name}" contains no drawing files`);
    used.add(name);
    return folder;
  });
  const unmatched = [...folders.keys()].filter((name) => !used.has(name));
  if (unmatched.length) throw new Error(`Drawings folders missing from the project CSV: ${unmatched.join(', ')}`);
  return mapped;
}

export async function extractVersion(zip: ZipFile, folder: VersionFolder, destination: string): Promise<ImportFile[]> {
  await fs.mkdir(destination, { recursive: true });
  const files: ImportFile[] = [];
  const destinations = new Set<string>();
  for (const entry of [...folder.entries].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const relative = entry.fileName.slice(folder.archiveFolder.length + 1);
    const localPath = path.resolve(destination, relative);
    if (!localPath.startsWith(`${path.resolve(destination)}${path.sep}`)) {
      throw new Error(`ZIP entry escapes its version directory: ${entry.fileName}`);
    }
    // Catch collisions before writing, including on case-insensitive macOS filesystems.
    const destinationKey = localPath.normalize('NFC').toLowerCase();
    if (destinations.has(destinationKey)) throw new Error(`Colliding drawing paths: ${entry.fileName}`);
    destinations.add(destinationKey);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
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
    await pipeline(source, verifier, createWriteStream(localPath, { flags: 'wx' }));
    if (checksum !== entry.crc32) throw new Error(`CRC mismatch for drawing file: ${entry.fileName}`);
    const stat = await fs.stat(localPath);
    if (!stat.isFile() || stat.size !== entry.uncompressedSize) {
      throw new Error(`Extracted drawing size mismatch: ${entry.fileName}`);
    }
    await fs.access(localPath, fs.constants.R_OK);
    files.push({ archivePath: entry.fileName, localPath, bytes: stat.size });
  }
  return files;
}
