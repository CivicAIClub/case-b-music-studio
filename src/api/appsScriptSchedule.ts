/**
 * Lesson Schedule — Google Apps Script client (same BASE_URL as roster).
 *
 * Your script must read the tab named "Lesson Schedule" and expose:
 *   GET ?action=schedule-list          → JSON array of row objects
 *   GET ?action=schedule&email=…       → JSON array for that student only
 * Both also carry &secret=… (the shared secret; doGet rejects reads without it).
 *
 * The matching doGet handler lives in apps-script/Code.gs (HTTP endpoints
 * section at the top of that file).
 */
// In plain English: this file fetches the lesson schedule. The teacher keeps the schedule
// in a tab called "Lesson Schedule" in the studio's Google Sheet. The Apps Script (a small
// program Google runs for us, attached to that sheet; code in apps-script/Code.gs) reads that
// tab and sends the rows here. This file turns each row into a lesson the website can use,
// with help from mapLessonScheduleRow.ts. The Dashboard uses the full schedule, and the
// Students page uses one student's lessons. Reading the schedule needs the shared secret
// (password), which is added to the end of each web address below.
// Borrow the script's web address, the shared-secret helper, the row-tidying helper, and the
// shape of a "lesson".
import { APPS_SCRIPT_BASE_URL, readSharedSecret } from "./appsScriptStudent";
import { mapScheduleRowToLesson } from "./mapLessonScheduleRow";
import type { ScheduledLesson } from "../types";

// A small safety check: is this value a "record" (a bundle of labeled values, like one
// spreadsheet row with column names) rather than a list or nothing at all?
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Find the list of rows inside the script's reply. It may be a bare list, or a list tucked
// under "rows", "students", or "data". Anything else is an error.
function extractScheduleRowArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    if (Array.isArray(json.rows)) return json.rows;
    if (Array.isArray(json.students)) return json.students;
    if (Array.isArray(json.data)) return json.data;
  }
  throw new Error(
    'Schedule response must be a JSON array, or an object with "rows", "students", or "data" array.'
  );
}

// Turn the script's whole reply into a list of lessons. If the script sent an error
// message, stop and pass it along. Rows that aren't proper records, or that can't become a
// lesson (for example, a row with no student email), are quietly skipped.
function mapScheduleResponse(json: unknown): ScheduledLesson[] {
  if (isRecord(json) && typeof json.error === "string") {
    throw new Error(json.error);
  }
  const rows = extractScheduleRowArray(json);
  const out: ScheduledLesson[] = [];
  // Go through each row one at a time and keep the ones that make a valid lesson.
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const lesson = mapScheduleRowToLesson(row);
    if (lesson) out.push(lesson);
  }
  return out;
}

// Get every lesson in the schedule, for the Dashboard. It is given optional request
// settings (for example, a way to cancel) and gives back the list of lessons.
export async function getScheduleList(
  init?: RequestInit
): Promise<ScheduledLesson[]> {
  // Build the web address that asks: "send me the whole lesson schedule."
  // The shared secret rides along at the end so the script knows the request is from us.
  const url = `${APPS_SCRIPT_BASE_URL}?action=schedule-list&secret=${encodeURIComponent(readSharedSecret())}`;

  // Ask the script, and wait for its reply.
  const res = await fetch(url, {
    method: "GET",
    ...init,
  });

  // Read the reply as JSON (a plain-text format for structured information). If it can't be
  // read, the web address is probably wrong or the script sent back an error page.
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Could not read schedule (HTTP ${res.status}). Is the web app URL correct?`
    );
  }

  // The script can reply with an "error" message of its own; pass that along.
  if (isRecord(json) && typeof json.error === "string") {
    throw new Error(json.error);
  }

  // A failing status number (anything not in the 200s) also counts as an error.
  if (!res.ok) {
    throw new Error(
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `Schedule request failed (HTTP ${res.status}).`
    );
  }

  // Turn the rows into lessons and hand them back.
  return mapScheduleResponse(json);
}

// Get only one student's lessons, looked up by email, for that student's profile panel.
// It works like the function above, but asks the script for just one student.
export async function getStudentSchedule(
  email: string,
  init?: RequestInit
): Promise<ScheduledLesson[]> {
  const trimmed = email.trim();
  // A blank email can't be looked up, so stop early.
  if (!trimmed) {
    throw new Error("Email is required to load a student schedule.");
  }

  // Build the web address for this student, with the email safely encoded (characters like
  // "+" and "@" have special meanings in a web address). The shared secret rides along too.
  const url = `${APPS_SCRIPT_BASE_URL}?action=schedule&email=${encodeURIComponent(trimmed)}&secret=${encodeURIComponent(readSharedSecret())}`;

  // Ask the script, and wait for its reply.
  const res = await fetch(url, {
    method: "GET",
    ...init,
  });

  // Read the reply as JSON; complain clearly if it can't be read.
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Could not read student schedule (HTTP ${res.status}). Is the web app URL correct?`
    );
  }

  // Stop if the script reported an error or the request failed.
  if (isRecord(json) && typeof json.error === "string") {
    throw new Error(json.error);
  }

  if (!res.ok) {
    throw new Error(
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `Student schedule request failed (HTTP ${res.status}).`
    );
  }

  // Turn the rows into lessons and hand them back.
  return mapScheduleResponse(json);
}
