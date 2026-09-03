export const URLS = {
  planGridLanding: 'https://app.plangrid.com',
  autodeskSignIn: 'https://signin.autodesk.com',
} as const;

export const ENV_KEYS = {
  email: 'PLANGRID_EMAIL',
  password: 'PLANGRID_PASSWORD',
  platformUrl: 'PLATFORM_URL',
} as const;

export const TIMEOUTS = {
  navigationMs: 30_000,
  actionMs: 15_000,
  downloadMs: 60_000,
} as const;

// Update these once the two-page login HTML is inspected.
export const LOGIN_SELECTORS = {
  emailInput: '#test-email',
  nextButton: '#test-submitLogin',
  passwordInput: '#test-password',
  loginButton: '#test-submitLogin',
  nextButtonText: 'Next',
  loginButtonText: 'Login',
} as const;
