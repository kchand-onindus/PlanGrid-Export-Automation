// Set browser visibility before loading the application and its configuration.
// Doing this in Node avoids shell-specific environment-variable syntax.
process.env.HEADLESS = process.argv.includes('--headless') ? 'true' : 'false';

await import('./main.js');
