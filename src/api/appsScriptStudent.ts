/**
 * Google Apps Script “web app” client for your music studio.
 *
 * There are only two HTTP GET shapes your script should support:
 *
 * 1) Roster (directory / dashboard list)
 *    URL:  BASE_URL?action=list
 *    Body: JSON array of row objects, OR wrap the array in any of:
 *          { "students": [...] }  { "rows": [...] }  { "data": [...] }
 *    Each object should use the same column titles as your Google Form / Sheet
 *    (see mapSheetRowToProfile in mapSheetStudentResponse.ts).
 *    Multiple rows with the same Email Address are treated as separate form
 *    submissions; the app keeps the latest row for the roster and shows history
 *    on the student profile.
 *
 * 2) One student (profile panel — freshest row for that email)
 *    URL:  BASE_URL?email=student@example.com
 *    Body: one JSON object (same columns as above).
 *
 * The deployed `/exec` URL lives in `VITE_APPS_SCRIPT_BASE_URL` in
 * `.env.local`. The frontend appends `?action=...` or `?email=...`, plus
 * `&secret=...` (the same shared secret POSTs carry; doGet rejects reads
 * without it).
 */
// In plain English: this file fetches student information for the website. Students fill
// out a Google Form, and their answers land in the studio's Google Sheet. The Apps Script
// (a small program Google runs for us, attached to that sheet; code in apps-script/Code.gs)
// reads the sheet and hands rows back to this website when asked.
// This file does two jobs: get the whole roster (every student), and get one student's newest
// answers. Each row is tidied into a student profile by mapSheetStudentResponse.ts, and the
// Students page and the Dashboard show the results.
// It also keeps the script's web address, which the other files in src/api borrow.
// Reading data needs the same shared secret (password) that changes carry (see
// appsScriptPost.ts), so the roster's emails aren't open to anyone who finds the script's address.
// Helpers from other files: one turns a raw sheet row into a tidy profile, and one picks a
// student's most recent answers when they filled out the form more than once.
import {
  mapSheetRowToProfile,
  type SheetStudentProfile,
} from "./mapSheetStudentResponse";
import { pickLatestProfileFromSubmissions } from "../lib/formSubmissionHistory";

// Read the script's web address from the settings file (.env.local), which is copied into
// the website when it is built. If it is missing, stop right away with instructions,
// because nothing on the site can work without it.
const RAW_BASE_URL = (import.meta.env.VITE_APPS_SCRIPT_BASE_URL ?? "").trim();
if (!RAW_BASE_URL) {
  throw new Error(
    "VITE_APPS_SCRIPT_BASE_URL is not set. Copy .env.example to .env.local " +
      "and paste your Apps Script /exec URL."
  );
}
// Share the address so the other data files (schedule, calendar, recaps) use the same one.
export const APPS_SCRIPT_BASE_URL = RAW_BASE_URL;

// Look up the shared secret (the password that proves a request came from this website).
// It comes from a settings file (.env.local) and is copied into the website when it is built.
// If it is missing or blank, stop right away with a message explaining how to fix it.
// Both the reading files (this one and appsScriptSchedule.ts) and appsScriptPost.ts use it.
export function readSharedSecret(): string {
  const value = import.meta.env.VITE_APPS_SCRIPT_SHARED_SECRET;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "Missing VITE_APPS_SCRIPT_SHARED_SECRET. Add it to .env.local at the repo root (copy .env.example) and restart the dev server."
    );
  }
  return value;
}

// A small safety check: is this value a "record" (a bundle of labeled values, like one
// spreadsheet row with column names) rather than a list or nothing at all?
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Given one reply from the script, find the actual student row inside it.
// Sometimes the row comes "wrapped" inside a label like "row" or "student". This looks inside
// each possible wrapper, picks the one with the most columns, and uses it only if it has more
// columns than the outer reply. Otherwise the reply itself is treated as the row.
/**
 * Some doGet handlers return { row: { ...sheet columns } } instead of a flat row.
 * If we map the wrapper, every column lookup misses and the profile looks empty.
 */
function extractSingleStudentRow(json: Record<string, unknown>): Record<string, unknown> {
  const wrapperCandidates = [
    "row",
    "student",
    "record",
    "data",
    "profile",
  ] as const;
  // Keep track of the best wrapper found so far and how many columns it has.
  let best: Record<string, unknown> | null = null;
  let bestKeyCount = 0;
  for (const k of wrapperCandidates) {
    const inner = json[k];
    if (!isRecord(inner) || Array.isArray(inner)) continue;
    const n = Object.keys(inner).length;
    if (n > bestKeyCount) {
      bestKeyCount = n;
      best = inner;
    }
  }
  // Only use the wrapper if it clearly holds more information than the outer reply.
  const outerKeys = Object.keys(json).length;
  if (best && bestKeyCount > outerKeys) return best;
  return json;
}

// Find the list of rows inside the roster reply. The script may send a bare list, or a
// list tucked under "rows", "students", or "data". Anything else is an error.
function extractRowArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    if (Array.isArray(json.rows)) return json.rows;
    if (Array.isArray(json.students)) return json.students;
    if (Array.isArray(json.data)) return json.data;
  }
  throw new Error(
    'Roster response must be a JSON array, or an object with "rows", "students", or "data" array.'
  );
}

// What the roster fetch gives back: the newest profile for each student, plus every form
// submission grouped by student email (so a profile can show a history of past answers).
export type AllStudentsRosterResult = {
  /** Latest row per email (by form Timestamp / Date when present). */
  students: SheetStudentProfile[];
  /** All list rows grouped by lowercase email (sheet order preserved per key). */
  submissionsByEmail: Record<string, SheetStudentProfile[]>;
};

// Get every student for the roster. It is given optional request settings (for example,
// a way to cancel) and gives back the two lists described just above.
/**
 * Fetches everyone for the student list (Students page + Dashboard count/search).
 * Your Apps Script doGet should handle e.parameter.action === "list".
 */
export async function getAllStudents(
  init?: RequestInit
): Promise<AllStudentsRosterResult> {
  // Build the web address that asks the script: "send me the whole student list."
  // The shared secret rides along at the end so the script knows the request is from us.
  const url = `${APPS_SCRIPT_BASE_URL}?action=list&secret=${encodeURIComponent(readSharedSecret())}`;

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
      `Could not read roster (HTTP ${res.status}). Is the web app URL correct?`
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
        : `Roster request failed (HTTP ${res.status}).`
    );
  }

  // Pull out the list of rows, and get ready to sort them into piles by student email.
  const rows = extractRowArray(json);
  const submissionsByEmail: Record<string, SheetStudentProfile[]> = {};

  // Go through each row one at a time: tidy it into a profile, then file it under the
  // student's email in lowercase, so "Sam@x.com" and "sam@x.com" count as the same person.
  // Rows with no email are skipped.
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const profile = mapSheetRowToProfile(extractSingleStudentRow(row));
    const emailKey = profile.email.trim().toLowerCase();
    if (!emailKey) continue;
    if (!submissionsByEmail[emailKey]) submissionsByEmail[emailKey] = [];
    submissionsByEmail[emailKey].push(profile);
  }

  // For each student, keep only their most recent form answers for the roster list.
  const students: SheetStudentProfile[] = [];
  for (const list of Object.values(submissionsByEmail)) {
    const latest = pickLatestProfileFromSubmissions(list);
    if (latest) students.push(latest);
  }

  // Hand back both the roster and the full history.
  return { students, submissionsByEmail };
}

// Get the newest answers for one student, looked up by email. Used by the profile panel.
// It is given the email (and optional request settings) and gives back one student profile.
/**
 * Fetches the latest saved row for one email (right-hand profile panel).
 * Uses encodeURIComponent so characters like + and @ are safe in the query string.
 * Pass AbortController.signal from React when the user switches students quickly.
 */
export async function getStudentByEmail(
  email: string,
  init?: RequestInit
): Promise<SheetStudentProfile> {
  const trimmed = email.trim();
  // A blank email can't be looked up, so stop early.
  if (!trimmed) {
    throw new Error("Email is required to load a student from the sheet.");
  }

  // Build the web address that asks for this one student, with the email safely encoded.
  // The shared secret rides along at the end so the script knows the request is from us.
  const url = `${APPS_SCRIPT_BASE_URL}?email=${encodeURIComponent(trimmed)}&secret=${encodeURIComponent(readSharedSecret())}`;

  // Ask the script, then read its reply as JSON; complain clearly if it can't be read.
  const res = await fetch(url, {
    method: "GET",
    ...init,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Could not read response (HTTP ${res.status}). Is the web app URL correct?`
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
        : `Request failed (HTTP ${res.status}).`
    );
  }

  // The reply should be one row (a bundle of labeled values), not a list.
  if (!isRecord(json)) {
    throw new Error("Unexpected response: expected a JSON object (one row).");
  }

  // Unwrap the row if needed and tidy it into a student profile.
  return mapSheetRowToProfile(extractSingleStudentRow(json));
}
