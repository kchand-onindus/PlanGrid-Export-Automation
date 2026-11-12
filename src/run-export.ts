import { EXPORT_HELP } from './export-selection.js';

// Set browser visibility before loading the application and its configuration.
// Doing this in Node avoids shell-specific environment-variable syntax.
process.env.HEADLESS = process.argv.includes('--headless') ? 'true' : 'false';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(EXPORT_HELP);
} else {
  await import('./main.js');
}
