import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { logError, logger } from "./logger.js";
import type { Project, ProjectResult } from "./types.js";

function safeFolderName(project: Project): string {
  const source =
    project.projectNumber || project.projectName || "unknown-project";
  return source.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function exportProject(
  _page: Page,
  project: Project,
  downloadRoot: string,
): Promise<ProjectResult> {
  const startedAt = Date.now();

  if (!project.enabled) {
    logger.info("Skipping disabled project", {
      projectNumber: project.projectNumber,
      projectName: project.projectName,
    });
    return {
      project,
      status: "SKIPPED",
      message: "Project is disabled",
      durationMs: 0,
    };
  }

  const downloadDirectory = path.join(downloadRoot, safeFolderName(project));

  try {
    await fs.mkdir(downloadDirectory, { recursive: true });
    logger.debug("Download directory ready", {
      projectNumber: project.projectNumber,
      downloadDirectory,
    });

    // TODO: Add the inspected PlanGrid selectors for this sequence:
    // 1. Search for and open the project.
    // 2. Open Settings.
    // 3. Open Download and export as builds.
    // 4. Fill fromDate and toDate.
    // 5. Click ZIP file.
    // 6. Wait for processing to reach 100%.
    // 7. Click Download and save the ZIP in downloadDirectory.
    logger.warn("PlanGrid selectors are not configured yet", {
      projectNumber: project.projectNumber,
      fromDate: project.fromDate,
      toDate: project.toDate,
    });
    return {
      project,
      status: "SKIPPED",
      message: "PlanGrid selectors and export steps are not configured yet",
      downloadDirectory,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    logError(`Project ${project.projectNumber} failed`, error, {
      projectName: project.projectName,
      fromDate: project.fromDate,
      toDate: project.toDate,
    });
    return {
      project,
      status: "FAILED",
      message: error instanceof Error ? error.message : String(error),
      downloadDirectory,
      durationMs: Date.now() - startedAt,
    };
  }
}
