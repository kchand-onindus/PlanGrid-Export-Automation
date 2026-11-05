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
    throw new Error('Overwrite confirmation requires an interactive terminal; no files were changed for this project');
  }
  output.write(`\nProject: ${request.project.projectCleanName}\nDestination: ${request.destination}\n`
    + `Existing files that will be overwritten: ${request.files.length}\n`);
  for (const file of request.files.slice(0, 10)) output.write(`  ${path.relative(request.destination, file)}\n`);
  if (request.files.length > 10) output.write(`  ...and ${request.files.length - 10} more\n`);
  output.write('This replaces the listed destination files with the extracted source files. Unrelated files remain.\n');
  const readline = createInterface({ input, output });
  let inputClosed = false;
  const closed = new Promise<string>((resolve) => readline.once('close', () => {
    inputClosed = true;
    resolve('');
  }));
  try {
    while (true) {
      if (inputClosed) return false;
      const answer = (await Promise.race([readline.question('Overwrite these existing files? [y/N]: '), closed])).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === '' || answer === 'n' || answer === 'no') return false;
      output.write('Enter y to overwrite, or n/Enter to keep the existing files.\n');
    }
  } finally {
    readline.close();
  }
}
