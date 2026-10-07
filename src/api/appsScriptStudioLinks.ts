// In plain English: this file asks the Apps Script (apps-script/Code.gs) for the two spreadsheet
// links in the site's header: the studio Sheet opened on its Lesson Schedule tab, and the payroll
// time sheet the tool writes to (Mr. O'Neal's copy). The links aren't written into the website,
// so no spreadsheet address is kept in this repo; the script builds them from its own settings.
// Only people on ALLOWED_USERS get an answer (the same check as every other request).
import { postToAppsScript, type AppsScriptPostInit } from "./appsScriptPost";

/** What `studio-links` sends back. A link is null when the script has nothing to point at. */
export type StudioLinks = {
  /** The studio Sheet, opened on its Lesson Schedule tab. */
  lessonScheduleUrl: string | null;
  /** The time sheet the tool writes to; null when TIMESHEET_SPREADSHEET_ID isn't set. */
  timesheetUrl: string | null;
};

type StudioLinksResponse = { ok: true } & StudioLinks;

// Only a real https:// address is used as a link; anything else counts as "no link".
function httpsOrNull(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

// Ask the script for the two links.
export async function getStudioLinks(init?: AppsScriptPostInit): Promise<StudioLinks> {
  const result = await postToAppsScript<StudioLinksResponse>("studio-links", {}, init);
  return {
    lessonScheduleUrl: httpsOrNull(result.lessonScheduleUrl),
    timesheetUrl: httpsOrNull(result.timesheetUrl),
  };
}
