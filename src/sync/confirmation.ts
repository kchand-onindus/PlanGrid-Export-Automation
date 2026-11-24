import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { OverwriteRequest } from './prepare.js';

export async function confirmSyncOverwrite(
  request: OverwriteRequest,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): Promise<boolean> {
  if (!interactive) {
    throw new Error('Overwrite confirmation requires an interactive terminal; no overwrites were approved');
  }
  const projects = [request, ...(request.additionalProjects ?? [])];
  output.write(`\nEXISTING FILES FOUND — REVIEW BEFORE OVERWRITING\nProjects requiring overwrite approval: ${projects.length}\n`);
  for (const { project, destination, folders, files } of projects) {
    output.write(`\nProject: ${project.projectCleanName}\nDestination: ${destination}\n`
      + `Folders with matching files: ${folders?.join(', ') ?? 'Documents/Photos'}\n`
      + `Existing files that will be overwritten: ${files.length}\n`);
    for (const file of files.slice(0, 10)) output.write(`  ${path.relative(destination, file)}\n`);
    if (files.length > 10) output.write(`  ...and ${files.length - 10} more\n`);
  }
  output.write('\nMatching files will be overwritten and new files and folders will be copied from the extraction.\n'
    + 'Files and folders found only at the destination will be kept, including inside matching subfolders.\n'
    + 'Choose y/yes to approve the listed overwrites for this run, or n/Enter to skip the listed projects.\n'
    + 'Projects that require no overwrites will still be processed.\n');
  const readline = createInterface({ input, output });
  let inputClosed = false;
  const closed = new Promise<string>((resolve) => readline.once('close', () => {
    inputClosed = true;
    resolve('');
  }));
  try {
    while (true) {
      if (inputClosed) return false;
      const answer = (await Promise.race([readline.question('Override existing Documents and/or Photos folder contents? [y/N] '), closed])).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === '' || answer === 'n' || answer === 'no') return false;
      output.write('Enter y to approve all listed overwrites, or n/Enter to skip the listed projects.\n');
    }
  } finally {
    readline.close();
  }
}
