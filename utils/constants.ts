export const URLS = {
  planGridLanding: 'https://app.plangrid.com',
  projects: 'https://app.plangrid.com/projects',
  autodeskSignIn: 'https://signin.autodesk.com',
  kahuaLanding: 'https://devproductionlaunch.kahua.com/',
} as const;

export const ENV_KEYS = {
  email: 'PLANGRID_EMAIL',
  password: 'PLANGRID_PASSWORD',
  platformUrl: 'PLATFORM_URL',
  downloadDir: 'DOWNLOAD_DIR',
  kahuaUsername: 'KAHUA_USERNAME',
  kahuaPassword: 'KAHUA_PASSWORD',
  kahuaUrl: 'KAHUA_URL',
} as const;

export const TIMEOUTS = {
  navigationMs: 30_000,
  actionMs: 15_000,
  projectsPageSettleMs: 5_000,
  progressPollMs: 2_000,
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

export const AUTODESK_SELECTORS = {
  emailInput: '#userName',
  nextButton: '#verify_user_btn',
  passwordInput: '#password',
  signInButton: '#btnSubmit',
} as const;

export const PROJECT_SELECTORS = {
  searchInput: 'input[name="project_search"]',
  projectRows: 'a[data-qa^="projects-table.row"]',
  settingsLink: 'li[data-qa="navigation.settings"] a',
  asBuiltLink: 'a[data-qa="Exports.asbuilts"]',
  startDateInput: 'input[name="startDate"]',
  endDateInput: 'input[name="endDate"]',
  zipOption: '.abDeliveryMethod.makeZipAsbuilt',
  asBuiltRows: 'tbody tr',
  progress: '.abProgress',
  status: '.abDown',
  downloadLink: 'a.asbuilt-download',
} as const;

export const LOGOUT_SELECTORS = {
  accountName: 'Vikas Handa',
  accountNameElement: 'span.button-text',
  logoutLink: 'a[href="/logout"]',
  logoutText: 'Log Out',
  loginEmailInput: '#test-email',
} as const;

export const KAHUA_SELECTORS = {
  canvas: '#uno-canvas',
  enableAccessibility: '#uno-enable-accessibility',
  semanticsRoot: '#uno-semantics-root',
  usernameInput: 'input[xamlautomationid="UserName"]',
  passwordInput: 'input[type="password"][xamlautomationid="Password"]',
  nextButton: 'button[xamlautomationid="SignInNext"]',
  messageBox: '[xamlautomationid="MessageBox"]',
  devProductionNotice: 'p[aria-label^="Users should only be using DevProduction to stage data needed"]',
  okButtons: 'button[xamlautomationid="CmdOk"]',
  tasksNavigation: 'button[xamlautomationid="TasksNavigationItem"]',
  messagesNavigation: 'button[xamlautomationid="MessagesNavigationItem"]',
} as const;
