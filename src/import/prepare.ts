import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { extractVersion, inspectDrawings, mapVersionFolders, withArchive } from './archive.js';
import { readVersionSets, validateSequence } from './csv.js';
import type { ImportPlan, PreparedVersion } from './types.js';

export interface PreparationOptions {
  projectUid: string;
  csvFile: string;
  zipFile: string;
  outputRoot: string;
}

export async function prepareImport(options: PreparationOptions, logger: Logger): Promise<string> {
  const versions = await readVersionSets(options.csvFile, options.projectUid);
  logger.info('Selected project version sets loaded', {
    projectUid: options.projectUid,
    projectName: versions[0].projectName,
    versions: versions.length,
    entityIdColumn: versions[0].entityIdColumn,
    entityId: versions[0].entityId,
  });
  const warnings = validateSequence(versions);
  for (const warning of warnings) logger.warn(warning);
  if (!warnings.length) logger.success('Publication dates agree with upload_sequence');

  return withArchive(options.zipFile, async (zip, entries) => {
    const contents = inspectDrawings(entries);
    const folders = mapVersionFolders(versions, contents.folders);
    logger.info('ZIP drawings mapped to CSV versions', {
      archiveEntries: entries.length,
      drawingsRoot: contents.drawingsRoot,
      excludedFolders: contents.excludedFolders,
    });
    // A fresh directory per run preserves existing ZIPs, manual extractions, and previous plans.
    await fs.mkdir(options.outputRoot, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDirectory = await fs.mkdtemp(path.join(options.outputRoot, `import-${timestamp}-`));
    logger.info('Import preparation output directory created', { runDirectory });
    const prepared: PreparedVersion[] = [];
    for (const [index, version] of versions.entries()) {
      const folder = folders[index];
      const localFolder = path.join(runDirectory, 'drawings', String(version.uploadSequence));
      const files = await extractVersion(zip, folder, localFolder);
      prepared.push({ ...version, archiveFolder: folder.archiveFolder, localFolder, files });
      logger.success('Version files prepared and verified', {
        uploadSequence: version.uploadSequence,
        versionSetUid: version.versionSetUid,
        versionName: version.versionName,
        publishedAt: version.publishedAt,
        archiveFolder: folder.archiveFolder,
        localFolder,
        fileCount: files.length,
        bytes: files.reduce((total, file) => total + file.bytes, 0),
      });
    }
    const plan: ImportPlan = {
      status: 'PREPARED',
      preparedAt: new Date().toISOString(),
      sourceCsv: path.resolve(options.csvFile),
      sourceZip: path.resolve(options.zipFile),
      projectUid: versions[0].projectUid,
      projectName: versions[0].projectName,
      drawingsRoot: contents.drawingsRoot,
      excludedFolders: contents.excludedFolders,
      warnings,
      versions: prepared,
    };
    const manifestPath = path.join(runDirectory, 'import-plan.json');
    // Publish the plan only after every selected version has been verified.
    await fs.writeFile(manifestPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    logger.success('Import preparation completed', {
      manifestPath,
      versions: prepared.length,
      files: prepared.reduce((total, version) => total + version.files.length, 0),
      warnings: warnings.length,
    });
    return manifestPath;
  });
}
