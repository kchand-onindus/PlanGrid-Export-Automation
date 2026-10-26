import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Deliberately pinned to one known project/archive for this first import stage.
export const importConfig = {
  projectUid: 'b87288f1-1b8a-42e4-a0de-0d1467fdbf8c',
  csvFile: path.join(repositoryRoot, 'input', 'version_sets.csv'),
  zipFile: path.join(
    paths.downloadRoot,
    "'CNZ243 - PIN 133633.00 - Bradley Co - SR74 Drainage Improvements (ARPA)",
    '7b2bed72-478d-4bca-87ad-d8d6ebdb921f.zip',
  ),
  outputRoot: path.join(paths.downloadRoot, 'import-preparation'),
};
