/**
 * Phase 6 — Time sheet client.
 *
 * Mr. O'Neal is paid per private lesson and logs each one in a payroll time sheet (a separate
 * Google Sheet). The Apps Script side (`apps-script/Code.gs`) owns the connection: the sheet's
 * ID and the first date to offer live in Script Properties (TIMESHEET_SPREADSHEET_ID,
 * TIMESHEET_START_DATE), never in this repo. The time sheet's link reaches the browser only at
 * runtime, from `timesheet-status`.
 *
 * Flow:
 *   1. Dashboard mounts → `getTimesheetStatus()` says whether the time sheet is connected and
 *      returns its link, the start date, and the dropdown lists.
 *   2. Teacher clicks Preview on an ended lesson → `previewTimesheetRow()` returns the exact
 *      A-G row, the tab it goes to, and plain-English warnings. Nothing is written.
 *   3. Teacher adjusts values if needed → `addTimesheetRow()` writes that exact row (columns A-G,
 *      in the first empty row under the last one filled in) and marks the lesson "Added <date>"
 *      on the Lesson Schedule, plus "(70 min, logged as 1.5)" when it wasn't 45 or 90 minutes
 *      long. Retrying never adds a second row.
 *   4. Or Skip → `skipTimesheetRow()` marks the lesson "Skipped" and never touches the time sheet.
 */
// In plain English: this file carries the Dashboard's time sheet requests to the Apps Script
// (the small program Google runs for the studio's sheet). It asks whether the time sheet is
// connected, asks for a preview of one lesson's row, adds that row, or skips the lesson. Each
// request names its lesson by the same three things the calendar uses: the student's email, the
// lesson date, and the start time.
import { postToAppsScript, type AppsScriptPostInit } from "./appsScriptPost";
import type { LessonRowKey } from "./appsScriptCalendar";

/** One time sheet cell: text, or a number (lesson numbers and hours are numbers). */
export type TimesheetCell = string | number;

/** The choices in each dropdown, read live from the time sheet's lookup tabs. */
export type TimesheetLists = {
  lessonNo: TimesheetCell[];
  block: TimesheetCell[];
  hours: TimesheetCell[];
  instrument: TimesheetCell[];
};

/** What `timesheet-status` reports. */
export type TimesheetStatus = {
  configured: boolean;
  /** Plain-English reason when `configured` is false. */
  reason?: string;
  sheetUrl: string | null;
  sheetTitle: string | null;
  /** The school-year tab today's lessons go to, like "2026-2027". */
  targetTab: string | null;
  targetTabExists?: boolean;
  /** TIMESHEET_START_DATE ("yyyy-MM-dd"); earlier lessons are never offered. */
  startDate: string | null;
  codeVersion: string;
  lists: TimesheetLists;
};

/** The six values the teacher can change in the preview: columns B to G. */
export type TimesheetFields = {
  lessonNo: TimesheetCell;
  firstName: string;
  lastName: string;
  block: TimesheetCell;
  hours: TimesheetCell;
  subject: TimesheetCell;
};

/** What `preview-timesheet-row` reports for one lesson. */
export type TimesheetPreview = {
  /** The school-year tab, like "2026-2027". */
  tab: string;
  /** True when that tab doesn't exist yet and adding will create it. */
  createsTab: boolean;
  /** The tab the new one would be created in front of, like "2025-2026". */
  insertBefore: string | null;
  /** Like "Fall 2026". */
  termLabel: string;
  /** True when a term label row will go just above the lesson's row. */
  addsTermLabel: boolean;
  /** Columns A to G exactly as they would be written (A shown as M/d/yyyy). */
  row: TimesheetCell[];
  fields: TimesheetFields;
  /** Set when the same date + student is already on the tab (adding then only marks it). */
  duplicate: { rowNumber: number; cells: TimesheetCell[] } | null;
  warnings: string[];
  /** Plain-English notes that need no action, like "Name and subject from your last time sheet row for this student." */
  info: string[];
  /** The line under the row, like "70-minute lesson, logged as 1.5 hours (a double)."; null without an end time. */
  lengthLine: string | null;
  lists: TimesheetLists;
  /** The lesson's current Time Sheet note on the Lesson Schedule ("" when none), like "Added 10/7/2026". */
  mark: string;
  lesson: {
    studentEmail: string;
    studentName: string;
    lessonDate: string;
    startTime: string;
    endTime: string;
    lessonBlock: string;
    minutes: number | null;
  };
  sheetUrl: string;
  sheetTitle: string;
};

/** What `add-timesheet-row` reports. */
export type TimesheetAddResult = {
  /** True when the lesson was already on the tab: no row was added, only the mark. */
  alreadyThere: boolean;
  tab: string;
  rowNumber: number;
  row: TimesheetCell[];
  createdTab: boolean;
  labelRowNumber: number | null;
  mark: string;
};

type StatusResponse = { ok: true } & TimesheetStatus;
type PreviewResponse = { ok: true } & TimesheetPreview;
type AddResponse = { ok: true } & TimesheetAddResult;
type SkipResponse = { ok: true; skipped: boolean; mark: string };

// Ask whether the time sheet is connected, and for its link, start date and dropdown lists.
export async function getTimesheetStatus(init?: AppsScriptPostInit): Promise<TimesheetStatus> {
  const result = await postToAppsScript<StatusResponse>("timesheet-status", {}, init);
  return result;
}

// Ask for the exact row one lesson would add. `overrides` are values the teacher changed in the
// preview; anything left out is worked out by the script (so "Check again" sends the names but
// not the lesson number, which is then recounted for those names).
export async function previewTimesheetRow(
  key: LessonRowKey,
  overrides?: Partial<TimesheetFields>,
  init?: AppsScriptPostInit
): Promise<TimesheetPreview> {
  const payload: Record<string, unknown> = keyAsPayload(key);
  if (overrides) payload.overrides = overrides;
  return postToAppsScript<PreviewResponse>("preview-timesheet-row", payload, init);
}

// Add one lesson's row to the time sheet, exactly as shown in the preview (`fields`).
export async function addTimesheetRow(
  key: LessonRowKey,
  fields: TimesheetFields,
  init?: AppsScriptPostInit
): Promise<TimesheetAddResult> {
  const payload: Record<string, unknown> = keyAsPayload(key);
  payload.overrides = fields;
  return postToAppsScript<AddResponse>("add-timesheet-row", payload, init);
}

// Mark one lesson "Skipped" (it didn't happen, or it's already on the time sheet).
export async function skipTimesheetRow(
  key: LessonRowKey,
  init?: AppsScriptPostInit
): Promise<{ skipped: boolean; mark: string }> {
  const result = await postToAppsScript<SkipResponse>("skip-timesheet-row", keyAsPayload(key), init);
  return { skipped: result.skipped === true, mark: result.mark };
}

// Two time sheet values mean the same choice: the same text (ignoring capital letters and extra
// spaces), or the same number (so 1 matches "1"). Mirrors sameListValue in Code.gs.
export function sameTimesheetCell(a: TimesheetCell, b: TimesheetCell): boolean {
  const ka = String(a).trim().replace(/\s+/g, " ").toLowerCase();
  const kb = String(b).trim().replace(/\s+/g, " ").toLowerCase();
  if (ka === kb) return true;
  if (ka === "" || kb === "") return false;
  const na = Number(ka);
  const nb = Number(kb);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

function keyAsPayload(key: LessonRowKey): Record<string, unknown> {
  return {
    studentEmail: key.studentEmail.trim(),
    lessonDate: key.lessonDate.trim(),
    startTime: key.startTime.trim(),
  };
}
