import type { Page } from 'playwright';
import { PROJECT_USER_SELECTORS, TIMEOUTS } from '../../utils/constants.js';

export async function findExactProjectUserRoles(
  page: Page, userEmailId: string, waitForMatch = false,
): Promise<string[]> {
  try {
    await page.locator(PROJECT_USER_SELECTORS.searchInput).fill(userEmailId, { timeout: TIMEOUTS.projectsReadyMs });
  } catch {
    throw new Error('Could not fill the project Team search field.');
  }

  try {
    const result = await page.waitForFunction(({ email, selectors, waitForMatch }) => {
      const search = document.querySelector<HTMLInputElement>(selectors.searchInput);
      const table = document.querySelector(selectors.table);
      const footer = table?.querySelector<HTMLElement>(selectors.footer);
      if (search?.value !== email || !table || !footer?.checkVisibility({ visibilityProperty: true })) return false;

      const footerText = footer.innerText.trim();
      const tableRows = table.querySelectorAll(selectors.row);

      // An empty project roster uses a total count without echoing the search.
      const emptyState = table.querySelector<HTMLElement>(selectors.noMatches);
      if (!waitForMatch && tableRows.length === 0 && /^0 users?$/i.test(footerText)
          && emptyState?.checkVisibility({ visibilityProperty: true })
          && emptyState.innerText.trim() === 'No project users') {
        return { roles: [] };
      }

      // For filtered results, wait for the footer to acknowledge this query and its rows to render.
      const summary = /^(\d+|no) users? matching "(.*)"$/i.exec(footerText);
      if (!summary || summary[2] !== email) return false;
      const reportedCount = summary[1].toLowerCase() === 'no' ? 0 : Number(summary[1]);
      const rows = Array.from(tableRows).filter((row) => row.checkVisibility({ visibilityProperty: true }));
      if (rows.length !== reportedCount) return false;

      const cells = rows.map((row) => row.querySelector<HTMLElement>(selectors.emailCell));
      if (cells.some((cell) => !cell?.checkVisibility({ visibilityProperty: true }) || !cell.innerText.trim())) return false;
      const roles = rows.filter((_, index) => cells[index]?.innerText.trim() === email).map((row) => {
        const role = row.querySelector<HTMLElement>(selectors.roleCell);
        return role?.checkVisibility({ visibilityProperty: true }) ? role.innerText.trim() : '';
      });
      if (roles.length === 1 && !roles[0]) return false;
      if (waitForMatch && roles.length === 0) return false;
      return { roles };
    }, { email: userEmailId, selectors: PROJECT_USER_SELECTORS, waitForMatch }, { timeout: TIMEOUTS.projectsReadyMs });
    try {
      const snapshot = await result.jsonValue();
      if (snapshot) return snapshot.roles;
      throw new Error('Search results were unavailable.');
    } finally {
      await result.dispose();
    }
  } catch {
    throw new Error(waitForMatch
      ? 'Could not verify the invited user in the Team table after submission.'
      : 'Could not verify that the project Team search results finished rendering.');
  }
}
