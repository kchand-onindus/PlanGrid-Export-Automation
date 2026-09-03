export const browserOptions = {
  // Debug mode is visible by default. Use `npm run headless` when needed.
  headless: process.env.HEADLESS === 'true',
  timeout: 30_000,
};
