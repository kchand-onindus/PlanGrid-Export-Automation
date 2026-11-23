export const URLS = {
  planGridLanding: 'https://app.plangrid.com',
  projects: 'https://app.plangrid.com/projects',
  planGridOrganizationUsers: 'https://app.plangrid.com/enterprise/organizations/9c85eaf0-0e11-4e8a-91fb-a6b7dcb7a88e/users',
  autodeskSignIn: 'https://signin.autodesk.com',
  kahuaLanding: 'https://devproductionlaunch.kahua.com/',
} as const;

export const ENV_KEYS = {
  email: 'PLANGRID_EMAIL',
  password: 'PLANGRID_PASSWORD',
  platformUrl: 'PLATFORM_URL',
  projectsCsv: 'PROJECTS_CSV',
  downloadDir: 'DOWNLOAD_DIR',
  syncUpDir: 'SYNC_UP_DIR',
  drawingsDir: 'DRAWINGS_DIR',
  batchSkip: 'BATCH_SKIP',
  batchLimit: 'BATCH_LIMIT',
  planGridCdpUrl: 'PLANGRID_CDP_URL',
  chromeUserDataDir: 'PLANGRID_CHROME_USER_DATA_DIR',
  kahuaUsername: 'KAHUA_USERNAME',
  kahuaPassword: 'KAHUA_PASSWORD',
  kahuaUrl: 'KAHUA_URL',
} as const;

export const TIMEOUTS = {
  navigationMs: 30_000,
  actionMs: 15_000,
  projectsNavigationMs: 45_000,
  projectsReadyMs: 30_000,
  projectsPageSettleMs: 5_000,
  progressPollMs: 2_000,
  downloadStatusFirstMs: 10 * 60_000,
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
  asBuiltPage: '.generateStaple form:visible, .asbuiltsList:visible',
  asBuiltList: '.asbuiltsList',
  generateAsBuilt: '#test-generateAsbuilt',
  startDateInput: 'input[name="startDate"]',
  endDateInput: 'input[name="endDate"]',
  includeCheckboxes: '.generateStaple form input[type="checkbox"]',
  zipOption: '.abDeliveryMethod.makeZipAsbuilt',
  asBuiltRows: '.asbuiltsList tbody tr',
  asBuiltRowById: (buildId: string) =>
    `.asbuiltsList tbody tr:has(a.asbuilt-download[href*="/asbuilts/${buildId}/direct"])`,
  progress: '.abProgress',
  status: '.abDown',
  downloadLink: 'a.asbuilt-download',
} as const;

export const PROJECT_USER_SELECTORS = {
  searchInput: 'input[data-qa="ProjectUsers.search"]',
  table: '[data-qa="ProjectUsers.table"]',
  row: '[data-qa^="ProjectUsers.row "]',
  emailCell: '[data-qa="ProjectUsers.email"]',
  roleCell: '[data-qa="ProjectUsers.role"]',
  noMatches: '[data-qa="ProjectUsers.noMatches"]',
  footer: '[class*="TableFooter-module_tableFooter__"]',
  addTeamMembers: 'button[data-qa="ProjectUsers.add"]',
  addModal: '[data-qa="ProjectUsers.addModal"]',
  multiEmailField: '[data-component="MultiEmailField"]',
  inviteEmailInput: 'input[placeholder="Enter or paste comma-separated values"]',
  adminRadio: 'input[type="radio"][data-component="RolesRadioGroup.radio Admin"]',
  submitInvite: 'button[data-qa="ProjectUsers.addModal.add"]',
  confirmationModal: '[class*="Modal-module_modal__"]:has(button[data-qa="ProjectUsers.addModal.done"])',
  confirmationBody: '[class*="Modal-module_body__"]',
  confirmationDone: 'button[data-qa="ProjectUsers.addModal.done"]',
} as const;

export const AS_BUILT_EXCLUDED_CHECKBOX_NAMES: readonly string[] = [
  'inc_conformed', // Current Set
  'inc_drawing_log', // Drawing Log
  'inc_curr_set_log', // Current Set Log
];

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
