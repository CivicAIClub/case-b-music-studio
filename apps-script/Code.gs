// PLAIN-ENGLISH OVERVIEW: This file is the "back office" of the music studio website. It is a
// Google Apps Script, a small program that lives inside the studio's Google Sheet and runs on
// Google's computers. The website (the React code in src/) can't open the Sheet, Calendar, or
// Drive by itself, so it sends requests here, and this script does the work and replies.
// Reading (doGet) hands the website the student roster and lesson schedule from the Sheet.
// Writing (doPost) books or cancels lessons on Google Calendar, sets up and shares Google Drive
// folders, saves the teacher's lesson recaps, and adds each lesson he teaches to his payroll time
// sheet (a separate Google Sheet). Every request, read or write, must carry a shared password.
// onFormSubmit runs whenever a student fills in the sign-up Google Form. The website files that
// talk to this script are src/api/appsScriptStudent.ts, appsScriptSchedule.ts, appsScriptPost.ts.
// The long technical note below is for developers; plain-English notes like this run throughout.
/**
 * Case B — Music Studio: Google Apps Script backend (Code.gs)
 *
 * This is the script bound to Mr. O'Neal's Google Sheet (Extensions →
 * Apps Script). It powers the React frontend in this folder by exposing
 * a single Web App URL that the frontend calls. Keep this file in sync
 * with whatever is actually deployed in the Apps Script editor — it is
 * the canonical source of truth.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Spreadsheet layout this script expects
 * ───────────────────────────────────────────────────────────────────────
 *  - "Form Responses 1"   → master roster (every Google Form submission)
 *  - "Lesson Schedule"    → manually maintained by the teacher
 *      Headers (row 1, exact strings):
 *        Student Email | Student Name | Lesson Date | Lesson Block |
 *        Start Time    | End Time     | Status      | Lesson Focus |
 *        Note          (or "Notes")
 *      plus two columns the script adds and fills in itself (grayed out,
 *      warning-protected): "Calendar Event ID" (Phase 2) and
 *      "Time Sheet" (Phase 6: "Added 10/7/2026" or "Skipped").
 *  - One tab per student, named after their email — created automatically
 *    by `onFormSubmit` below. Old responses submitted *before* this
 *    trigger was installed will not have a per-email tab; run a one-time
 *    backfill (loop over Form Responses 1 and call the same logic) if
 *    you need history for older students.
 *
 * ───────────────────────────────────────────────────────────────────────
 * HTTP endpoints (one Web App, routed by query params or POST body)
 * ───────────────────────────────────────────────────────────────────────
 *  Every GET must include &secret=… (same SHARED_SECRET as POSTs);
 *  otherwise the reply is { error: "Unauthorized" }.
 *  GET  ?email=foo@bar.com           → latest row from that student's tab
 *  GET  ?action=list                 → { students: [...] }  every roster row
 *  GET  ?action=schedule-list        → { rows: [...] }      all booked lessons
 *  GET  ?action=schedule&email=…     → { rows: [...] }      one student's lessons
 *
 *  POST body (Content-Type: text/plain — see CORS note below). Every
 *  POST must include a "secret" field whose value matches the
 *  SHARED_SECRET stored in Script Properties (Project Settings →
 *  Script Properties). Body shapes below show only the
 *  action-specific fields (secret is implicit on every request):
 *    {"action":"ping","secret":"…"} → { ok: true, pong: true, ts: <ms> }
 *
 *    Phase 2 — Calendar event creation. All three actions identify the
 *    target lesson row by composite key { studentEmail, lessonDate,
 *    startTime } against the "Lesson Schedule" tab.
 *      {"action":"preview-event", "secret":"…", studentEmail, lessonDate,
 *       startTime}
 *           → { ok, preview: { title, startISO, endISO, attendees,
 *                              description, calendarName,
 *                              alreadyScheduled, calendarEventId } }
 *      {"action":"create-event",  "secret":"…", studentEmail, lessonDate,
 *       startTime}
 *           → { ok, calendarEventId, eventLink }   // sends invites
 *      {"action":"cancel-event",  "secret":"…", studentEmail, lessonDate,
 *       startTime}
 *           → { ok, cancelled: true }
 *             or { ok, cancelled: false, reason } when the row has no
 *             Calendar Event ID (nothing changed; the website tells the
 *             teacher)
 *
 *    Phase 3 — Class Resources (shared Google Drive folder visible to
 *    every enrolled student). The folder ID is set once in Script
 *    Properties (CLASS_RESOURCES_FOLDER_ID = the folder portion of its
 *    Drive URL); the script grants viewer access, never owner.
 *      {"action":"list-class-resources", "secret":"…"}
 *           → { ok, folder: { id, name, webViewLink },
 *                files: [ { id, name, mimeType, modifiedTime,
 *                           webViewLink, iconLink, isFolder } ] }
 *      {"action":"sync-class-resources-access", "secret":"…"}
 *           → { ok, folder: { id, name }, granted: [...emails],
 *                alreadyHadAccess: [...], errors: [{email, message}] }
 *
 *    Phase 4 — Student Resources (one Drive folder per student, with
 *    student as editor). Folders are children of a parent folder set
 *    once in Script Properties (STUDENT_RESOURCES_PARENT_FOLDER_ID),
 *    auto-created on first use, and cached by email in Script
 *    Properties (STUDENT_FOLDER:<email>) for O(1) lookup.
 *      {"action":"list-student-folder", "secret":"…", studentEmail}
 *           → { ok, folder: { id, name, webViewLink, created },
 *                files: [...], student: { email, name } }
 *      {"action":"ensure-student-folder", "secret":"…", studentEmail}
 *           → { ok, folder: { id, name, webViewLink, created },
 *                student: { email, name } }
 *      {"action":"sync-student-folders", "secret":"…"}
 *           → { ok, parent: { id, name }, created: [...emails],
 *                existed: [...emails], errors: [{email, message}] }
 *
 *    Phase 5 — Teacher recaps. One structured recap per lesson row,
 *    keyed by composite (studentEmail, lessonDate, startTime). Stored
 *    in a "Lesson Recaps" tab auto-created on first save; upsert
 *    semantics (write twice = update). Read endpoints never touch
 *    the sheet schema (return [] when the tab doesn't exist yet).
 *      {"action":"get-lesson-recap", "secret":"…", studentEmail,
 *       lessonDate, startTime}
 *           → { ok, recap: { ...fields, updatedAt } | null }
 *      {"action":"save-lesson-recap", "secret":"…", studentEmail,
 *       lessonDate, startTime, fields: { greeting, todayWe,
 *       homework, nextClass } }
 *           → { ok, recap: { ...saved-fields, updatedAt } }
 *      {"action":"list-recaps-for-student", "secret":"…", studentEmail}
 *           → { ok, recaps: [...] }
 *      {"action":"list-recaps", "secret":"…"}
 *           → { ok, recaps: [...] }
 *
 *    Phase 6 — Time sheet. Mr. O'Neal's payroll time sheet is a separate
 *    Google Sheet: one tab per school year named exactly "2026-2027"
 *    (newest first), "(CHAPEL/MISC.)" companion tabs, and lookup tabs
 *    (Lesson No., Block, hours, Instrument) that feed its dropdowns. Two
 *    Script Properties connect it (never put either value in the repo):
 *      TIMESHEET_SPREADSHEET_ID = the time sheet's ID, or its whole URL
 *      TIMESHEET_START_DATE     = first lesson date to offer, like
 *                                 2026-10-07 (earlier lessons were typed
 *                                 in by hand and are never offered)
 *    Share the time sheet as Editor with the Google account the web app
 *    runs as. The row actions use the Phase 2 composite key. The script
 *    appends rows (columns A-G only, never H or I, never editing or
 *    deleting a row), matches year tabs by exact name (never the CHAPEL
 *    tabs), only reads the lookup tabs, and notes each lesson in the
 *    Lesson Schedule's "Time Sheet" column.
 *      {"action":"timesheet-status", "secret":"…"}
 *           → { ok, configured, reason?, sheetUrl, sheetTitle, targetTab,
 *                targetTabExists, startDate, codeVersion,
 *                lists: { lessonNo, block, hours, instrument } }
 *             (never fails for a setup problem: configured is false and
 *             reason says what's missing, in plain words)
 *      {"action":"preview-timesheet-row", "secret":"…", studentEmail,
 *       lessonDate, startTime, overrides? }
 *           → { ok, tab, createsTab, insertBefore, termLabel,
 *                addsTermLabel, row: [A..G as shown], fields, duplicate,
 *                warnings: [plain English], lists, mark, lesson,
 *                sheetUrl, sheetTitle }        // writes nothing
 *      {"action":"add-timesheet-row", "secret":"…", studentEmail,
 *       lessonDate, startTime, overrides?: { lessonNo, firstName,
 *       lastName, block, hours, subject } }
 *           → { ok, tab, rowNumber, row, alreadyThere, createdTab,
 *                labelRowNumber, mark }
 *             Takes the script lock. If the same date + student is already
 *             on the tab, nothing is appended and only the mark is written
 *             (so a retry is safe). Creates the school-year tab if needed.
 *      {"action":"skip-timesheet-row", "secret":"…", studentEmail,
 *       lessonDate, startTime}
 *           → { ok, skipped: true, mark: "Skipped" }  // time sheet untouched
 *    "ping" also returns codeVersion (CODE_VERSION, near the top of the
 *    Config section), and authorize() logs it on its first line.
 *
 *  Future POST actions (Phases 7+) will follow the same shape:
 *    { "action": "<name>", "secret": "…", ...payload }
 *
 * The frontend clients live in:
 *   src/api/appsScriptStudent.ts        (GET, roster + single student)
 *   src/api/appsScriptSchedule.ts       (GET, lesson schedule)
 *   src/api/appsScriptPost.ts           (POST, write actions — Phase 1+)
 *
 * ───────────────────────────────────────────────────────────────────────
 * Auth (shared secret)
 * ───────────────────────────────────────────────────────────────────────
 *  Every POST must include a "secret" field whose value matches the
 *  SHARED_SECRET stored in Script Properties (Project Settings →
 *  Script Properties → Add property: SHARED_SECRET = <random hex>).
 *  Every GET must include the same value as a "secret" query
 *  parameter (?action=list&secret=…), because GETs return the roster
 *  (with student emails) and the schedule.
 *  The frontend reads it from .env.local (VITE_APPS_SCRIPT_SHARED_SECRET).
 *
 *  IMPORTANT: this secret IS bundled into the JS the browser
 *  downloads — anyone who can open the deployed site in DevTools can
 *  read it. Treat the deployed URL as private (don't link it
 *  publicly, don't share with people you wouldn't trust with the
 *  backend). For a single-teacher tool this is acceptable; if the
 *  site ever needs to be linked publicly, swap to a server-side
 *  proxy that holds the secret.
 *
 * ───────────────────────────────────────────────────────────────────────
 * CORS note (why POSTs use Content-Type: text/plain)
 * ───────────────────────────────────────────────────────────────────────
 *  Apps Script web apps don't expose custom CORS headers, so any
 *  "non-simple" cross-origin request (e.g. Content-Type: application/json)
 *  triggers a preflight OPTIONS that fails. The frontend works around
 *  this by sending the JSON body as text/plain — `e.postData.contents`
 *  on this side is still the raw JSON string, parsed with JSON.parse.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Triggers (set up once in the Apps Script editor)
 * ───────────────────────────────────────────────────────────────────────
 *  Triggers → Add Trigger:
 *    - Function:        onFormSubmit
 *    - Event source:    From spreadsheet
 *    - Event type:      On form submit
 *
 * ───────────────────────────────────────────────────────────────────────
 * Deployment (Apps Script editor → Deploy → New deployment)
 * ───────────────────────────────────────────────────────────────────────
 *    Type:           Web app
 *    Execute as:     Me
 *    Who has access: Anyone
 *  Copy the resulting `/exec` URL into APPS_SCRIPT_BASE_URL inside
 *  src/api/appsScriptStudent.ts. After ANY change to Code.gs, redeploy
 *  via Deploy → Manage deployments → ✏️ → "New version" so the live
 *  /exec URL serves the new code.
 */

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────

// Which version of this file is pasted into the Apps Script editor. Change it whenever Code.gs
// changes. authorize() logs it on its first line and "ping" sends it back, so after a paste you
// can confirm the live web app is running this exact version.
var CODE_VERSION = "2026-10-06 phase 6 time sheet";

/** Property key under which the GET/POST shared secret is stored. */
// SETTINGS. This section holds fixed settings the rest of the file relies on: tab names, who is
// invited to every lesson, and who can see the shared folders.
// "Script Properties" are a private settings box Google keeps for this script, a bit like a
// locked drawer. Sensitive values, such as the shared password, live there, not in this file.
// This is the label of the drawer slot where the shared password is kept.
var SHARED_SECRET_PROPERTY_KEY = "SHARED_SECRET";

/** Tab containing the lesson schedule (column titles in row 1). */
// The name of the Sheet tab where the teacher lists every booked lesson.
var LESSON_SCHEDULE_SHEET_NAME = "Lesson Schedule";

/**
 * Column added by Phase 2 to the Lesson Schedule sheet. The backend
 * writes the Google Calendar event ID here after a successful create so
 * subsequent calls (cancel, future updates, recap-attach) can reference
 * the same event without scanning calendars by metadata. Auto-created
 * by `ensureCalendarEventIdColumn_` if missing.
 */
// The title of the extra column where the script writes each lesson's calendar event ID (a code
// Google gives every calendar event), so it can find that exact event again later.
var CALENDAR_EVENT_ID_COLUMN = "Calendar Event ID";

/**
 * Always invited to every auto-created lesson event. Mr. O'Neal owns
 * the calendar (the deployer of the web app), so he's already on every
 * event as the organizer — but he's listed here too so the dashboard's
 * "Attendees" preview shows him explicitly. Cayden's two emails are
 * here for ongoing maintenance visibility, and Dr. Burns is the
 * always-CC'd music department contact.
 */
// The people added as guests to every lesson the website puts on the calendar, in addition to
// the student. Change this list to change who is always invited.
var ALWAYS_INVITE_EMAILS = [
  "roneal@pomfret.org",
  "rburns@pomfret.org",
  "caydenauyang@gmail.com",
  "cauyang.27@pomfret.org"
];

/**
 * Phase 3 — Class Resources. Property key under which the Drive folder
 * ID for the shared "Class Resources" folder is stored. The folder
 * itself is a sub-folder of the studio's shared drive (kept separate
 * from per-student folders so its permissions can be managed in bulk).
 *
 * Set this once in Project Settings → Script Properties → Add property:
 *   CLASS_RESOURCES_FOLDER_ID = <the id portion of the folder URL>
 *
 * The id is the random-looking segment in
 * https://drive.google.com/drive/folders/<id>.
 */
// The drawer-slot label that holds the ID of the shared "Class Resources" Drive folder.
// A folder's ID is the long code at the end of its Google Drive web address.
var CLASS_RESOURCES_FOLDER_ID_PROPERTY_KEY = "CLASS_RESOURCES_FOLDER_ID";

/**
 * Additional emails (beyond the enrolled-student roster) that should
 * always have viewer access on the Class Resources folder. Mr. O'Neal
 * owns the folder so he doesn't need to be listed. This list is the
 * canonical "music department admins + dev maintenance" set.
 */
// Extra people (besides enrolled students) who should always be able to view, but not change,
// the shared Class Resources folder.
var CLASS_RESOURCES_EXTRA_VIEWERS = [
  "rburns@pomfret.org",
  "caydenauyang@gmail.com",
  "cauyang.27@pomfret.org"
];

/**
 * Phase 4 — Student Resources. Property key under which the parent
 * Drive folder ID is stored. Per-student folders live as direct
 * children of this parent and are auto-created on first use.
 *
 * Set this once in Project Settings → Script Properties → Add property:
 *   STUDENT_RESOURCES_PARENT_FOLDER_ID = <folder id from its Drive URL>
 *
 * The parent folder is intentionally separate from the Class Resources
 * folder so the two can have different sharing scopes (Class = viewer
 * for everyone; per-student = editor for one student). Both can sit
 * inside the same shared drive.
 */
// The drawer-slot label that holds the ID of the main "Student Resources" folder, which holds
// one personal folder for each student.
var STUDENT_RESOURCES_PARENT_FOLDER_ID_PROPERTY_KEY = "STUDENT_RESOURCES_PARENT_FOLDER_ID";

/**
 * Per-student folder ID cache. Keys are
 * "STUDENT_FOLDER:<email>" → folder id. Populated lazily by
 * ensureStudentFolder_, never edited by hand.
 */
// Once a student's folder is made, its ID is remembered in the drawer under a label that starts
// with this text followed by the student's email, so it can be found quickly next time.
var STUDENT_FOLDER_PROPERTY_PREFIX = "STUDENT_FOLDER:";

/**
 * Always invited as editors on every per-student folder. Dr. Burns
 * (music dept) needs to drop annotated PDFs into any student's folder;
 * Cayden's two emails are for ongoing dev maintenance. Mr. O'Neal owns
 * the parent so he doesn't need to be listed.
 */
// Extra people (besides the student) who can add and change files in every student's personal
// folder.
var STUDENT_RESOURCES_EXTRA_EDITORS = [
  "rburns@pomfret.org",
  "caydenauyang@gmail.com",
  "cauyang.27@pomfret.org"
];

/**
 * Phase 5 — Teacher recaps. Tab name + canonical header order. Auto-
 * created on first save; never auto-deleted. Mirrors the
 * "Lesson Schedule" composite key (studentEmail, lessonDate,
 * startTime) so a recap binds permanently to the lesson instance it
 * was written for, even if the lesson is later rescheduled.
 */
// The name of the Sheet tab where the teacher's lesson recaps are saved.
var LESSON_RECAPS_SHEET_NAME = "Lesson Recaps";

/**
 * Headers in the order they should appear when the tab is auto-
 * created. The script reads by header name, so re-ordering the
 * columns by hand later is safe; the script will still find them.
 * Adding new columns to the right (e.g. for a future "delivered
 * to student" timestamp) is also safe.
 */
// The column titles for the Lesson Recaps tab, in the order they are first laid out.
var LESSON_RECAPS_HEADERS = [
  "Student Email",
  "Student Name",
  "Lesson Date",
  "Start Time",
  "Greeting",
  "Today We",
  "Homework",
  "Next Class",
  "Updated At"
];

// NOTE: the two settings below are exact repeats of the two just above. Having them twice does
// no harm (the second copy simply sets the same values again), but one copy could be removed.
/**
 * Phase 5 — Teacher recaps. Tab name + canonical header order. Auto-
 * created on first save; never auto-deleted. Mirrors the
 * "Lesson Schedule" composite key (studentEmail, lessonDate,
 * startTime) so a recap binds permanently to the lesson instance it
 * was written for, even if the lesson is later rescheduled.
 */
var LESSON_RECAPS_SHEET_NAME = "Lesson Recaps";

/**
 * Headers in the order they should appear when the tab is auto-
 * created. The script reads by header name, so re-ordering the
 * columns by hand later is safe; the script will still find them.
 * Adding new columns to the right (e.g. for a future "delivered
 * to student" timestamp) is also safe.
 */
var LESSON_RECAPS_HEADERS = [
  "Student Email",
  "Student Name",
  "Lesson Date",
  "Start Time",
  "Greeting",
  "Today We",
  "Homework",
  "Next Class",
  "Updated At"
];

/**
 * Phase 6 — Time sheet. Mr. O'Neal is paid per private lesson and logs each one in a payroll
 * time sheet: a separate Google Sheet with one tab per school year ("2025-2026", newest first)
 * plus lookup tabs that feed its dropdowns. The script adds one row per lesson, A to G only.
 * Both settings below live in Script Properties, never in this file.
 */
// The drawer-slot label for the time sheet's ID. Either the bare ID or the whole web address
// pasted from the browser works; the script picks the ID out of the address.
var TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY = "TIMESHEET_SPREADSHEET_ID";

// The drawer-slot label for the first lesson date the tool may offer, written like 2026-10-05.
// Lessons before it were already typed into the time sheet by hand and are never offered again.
var TIMESHEET_START_DATE_PROPERTY_KEY = "TIMESHEET_START_DATE";

// The title of the extra Lesson Schedule column where the script notes what happened to each
// lesson: "Added 10/7/2026" once it is on the time sheet, or "Skipped". Auto-created on first use.
var TIME_SHEET_COLUMN = "Time Sheet";

// The time sheet's lookup tabs. Each tab's column A holds the choices for one dropdown on the
// year tabs: Lesson No. (column B), Block (E), hours (F), and Instrument (G, "Music Subject").
// The script only ever reads these tabs.
var TIMESHEET_LIST_TABS = {
  lessonNo: "Lesson No.",
  block: "Block",
  hours: "hours",
  instrument: "Instrument"
};

// Mr. O'Neal's own lists of student first and last names. Read only, never written.
var TIMESHEET_FIRST_NAME_TAB = "First Name";
var TIMESHEET_LAST_NAME_TAB = "Last Name";

// The script writes columns A to G of a year tab and nothing else. Column H (Dir. of Music Sign.)
// and column I (Paid on paydate) are filled in by the music director and the business office.
var TIMESHEET_WRITE_COLUMNS = 7;

// Total Hours for a regular lesson, and for a double lesson (one that lasts 90 minutes).
var TIMESHEET_REGULAR_HOURS = 0.75;
var TIMESHEET_DOUBLE_HOURS = 1.5;
var TIMESHEET_DOUBLE_MINUTES = 90;

// The question on the sign-up form that says which instrument a student plays.
var FORM_INSTRUMENT_QUESTION = "What instrument do you want to play?";

// doGet answers "read" requests from the website: requests that only look at information and
// never change anything. Google runs this automatically whenever someone opens this script's
// web address. The website adds a note to the address saying what it wants (for example
// "?action=list" for the roster). The answer goes back as JSON (a plain-text format for data
// that both this script and the website understand). Read requests must carry the same shared
// password as write requests (as "&secret=..." on the address), because they hand out student
// emails and the lesson schedule.
function doGet(e) {
  // Check the shared password before reading anything. If it's missing or wrong, refuse. The
  // reply uses the same { error: ... } shape the website already shows for failed reads.
  const params = (e && e.parameter) || {};
  if (!isValidSecret_(params.secret)) {
    return jsonResponse_({ error: "Unauthorized" });
  }

  // Open the studio spreadsheet and read what the website asked for: an "action" word and/or a
  // student's email. Both are tidied up (extra spaces removed, lowercase) so they match reliably.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const action = String(e.parameter.action || "").trim().toLowerCase();
  const email = String(e.parameter.email || "").trim().toLowerCase();

  // 1) One student by email — latest row from that student's per-email tab.
  // Falls back to scanning Form Responses 1 when no per-email tab exists,
  // which happens for submissions that pre-date the onFormSubmit trigger
  // (or when a tab gets manually deleted). Without the fallback those
  // students show on the roster but error out when clicked.
  if (email && !action) {
    // First, look for the student's own tab (each student has a tab named after their email).
    const sheet = ss.getSheetByName(email);
    if (sheet) {
      // Read everything on that tab. If there is nothing below the title row, say so.
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        return jsonResponse_({ error: "No data found for this student" });
      }

      // Row 1 holds the column titles; the last row is the student's most recent form answers.
      // Pair each answer with its title and send it back.
      const headers = data[0];
      const lastRow = data[data.length - 1];
      return jsonResponse_(rowToObject_(headers, lastRow));
    }

    // No personal tab? Fall back to the main form-answers tab and search it instead.
    const formSheet = ss.getSheetByName("Form Responses 1");
    if (!formSheet) {
      return jsonResponse_({ error: "Student not found" });
    }
    const formData = formSheet.getDataRange().getValues();
    if (formData.length < 2) {
      return jsonResponse_({ error: "Student not found" });
    }
    // Find which column holds the email addresses. If there is none, give up politely.
    const formHeaders = formData[0];
    const emailColIndex = formHeaders
      .map((h) => String(h).trim().toLowerCase())
      .indexOf("email address");
    if (emailColIndex === -1) {
      return jsonResponse_({ error: "Student not found" });
    }
    // Go down every row. Each time the email matches, remember that row, so by the end we hold the
    // student's latest submission (lower rows are newer).
    let latestRow = null;
    for (let r = 1; r < formData.length; r++) {
      const rowEmail = String(formData[r][emailColIndex] || "")
        .trim()
        .toLowerCase();
      if (rowEmail === email) latestRow = formData[r];
    }
    // If the student never appeared, say so; otherwise send back their latest answers.
    if (!latestRow) {
      return jsonResponse_({ error: "Student not found" });
    }
    return jsonResponse_(rowToObject_(formHeaders, latestRow));
  }

  // 2) Student roster list — every row from "Form Responses 1".
  if (action === "list") {
    // Open the form-answers tab, where every student sign-up lands.
    const formSheet = ss.getSheetByName("Form Responses 1");
    if (!formSheet) {
      return jsonResponse_({ error: 'Sheet "Form Responses 1" not found' });
    }

    // Read the whole tab. If only the title row is there, send back an empty roster.
    const data = formSheet.getDataRange().getValues();
    if (data.length < 2) {
      return jsonResponse_({ students: [] });
    }

    // Turn each row into a labeled record (column title and answer), and drop any row with no
    // email, since a student without an email can't be looked up or contacted.
    const headers = data[0];
    const rows = data.slice(1);

    const students = rows
      .map((row) => rowToObject_(headers, row))
      .filter((student) => String(student["Email Address"] || "").trim() !== "");

    return jsonResponse_({ students });
  }

  // 3) All scheduled lessons.
  if (action === "schedule-list") {
    // Open the Lesson Schedule tab the teacher keeps by hand.
    const sheet = ss.getSheetByName("Lesson Schedule");
    if (!sheet) {
      return jsonResponse_({ error: "Lesson Schedule sheet not found" });
    }

    // Read every lesson. If only the title row is there, send back an empty list.
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      return jsonResponse_({ rows: [] });
    }

    // Label each lesson row by column title and skip blank rows (rows with no student email).
    const headers = data[0];
    const rows = data.slice(1)
      .map((row) => rowToObject_(headers, row))
      .filter((lesson) => String(lesson["Student Email"] || "").trim() !== "");

    return jsonResponse_({ rows });
  }

  // 4) One student's scheduled lessons.
  if (action === "schedule" && email) {
    // Same as above, but for just one student.
    const sheet = ss.getSheetByName("Lesson Schedule");
    if (!sheet) {
      return jsonResponse_({ error: "Lesson Schedule sheet not found" });
    }

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      return jsonResponse_({ rows: [] });
    }

    // Keep only the lessons whose email matches the student asked about.
    const headers = data[0];
    const rows = data.slice(1)
      .map((row) => rowToObject_(headers, row))
      .filter((lesson) =>
        String(lesson["Student Email"] || "").trim().toLowerCase() === email
      );

    return jsonResponse_({ rows });
  }

  // The request didn't match any of the four kinds above, so explain what the website may ask for.
  return jsonResponse_({
    error: "Missing email or invalid action. Use ?email=student@example.com, ?action=list, ?action=schedule-list, or ?action=schedule&email=student@example.com"
  });
}

/**
 * Sheets stores time-only cells as fractional days from 1899-12-30. When those
 * Date objects are serialized to UTC ISO and parsed by the browser, JavaScript
 * applies 1899's local-mean-time offset, which produces nonsense like "12:02
 * PM" for a cell the teacher typed as "11:30". Format time-only cells as
 * wall-clock strings on this side so the frontend can display them as-is.
 *
 * Date-only cells (year >= 1900, midnight in the spreadsheet's timezone) are
 * sent as plain "yyyy-MM-dd" so the frontend can render the same calendar
 * date for any viewer regardless of timezone. Anything else (timestamps with
 * a real time component) keeps full ISO so the frontend can parse it as a
 * Date and format it with the viewer's locale.
 */
// rowToObject_ turns one spreadsheet row into a labeled record, pairing each cell with the column
// title above it (for example "Lesson Date" and its value). It is given the title row and one
// data row, and gives back the labeled record. Along the way it fixes how dates and times look.
function rowToObject_(headers, row) {
  // Look up the spreadsheet's time zone so dates and times are read the way the teacher sees them.
  const ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const obj = {};
  // Go across the row one cell at a time, pairing each cell with its column title.
  for (let i = 0; i < headers.length; i++) {
    const key = String(headers[i] || "").trim();
    const val = row[i];
    if (val instanceof Date) {
      // Sheets secretly stores a time on its own (like "3:30 PM") as a date in the year 1899.
      // If we see that, send just the clock time, such as "3:30 PM".
      if (val.getFullYear() < 1900) {
        obj[key] = Utilities.formatDate(val, ssTz, "h:mm a");
      } else {
        // A real date. If its clock time is exactly midnight, it's a date with no time, so send
        // just the day (like "2026-09-25"). Otherwise keep the full date and time.
        const wallClock = Utilities.formatDate(val, ssTz, "HH:mm:ss");
        if (wallClock === "00:00:00") {
          obj[key] = Utilities.formatDate(val, ssTz, "yyyy-MM-dd");
        } else {
          obj[key] = val;
        }
      }
    } else {
      // Anything that isn't a date (words, numbers) is passed along unchanged.
      obj[key] = val;
    }
  }
  return obj;
}

// jsonResponse_ packages any answer as JSON (plain-text data) so the website can read it.
// It is given the answer and gives back a reply that Google sends to the website.
function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────────────────────────────────
// POST endpoint (write actions, secret-gated)
// ──────────────────────────────────────────────────────────────────────

/**
 * Routes POST actions. The body must be a JSON string sent with
 * Content-Type: text/plain (see CORS note in the file header).
 *
 * Every action is gated by a shared secret stored in Script Properties.
 * Adding a new action: add a `case` below and implement a small
 * `handle<Action>(payload)` function returning a plain object. Throw
 * an Error to return a 200 with `{ ok: false, error: <message> }`.
 */
// doPost handles every request that changes something: booking lessons, sharing folders, saving
// recaps. Google runs it whenever the website sends information to this script.
// Steps: unpack the request, check the shared password, see which job was asked for, do that
// job, and send back the result. If anything goes wrong, the website gets a clear error message.
function doPost(e) {
  // Unpack the request. If it's garbled or empty, reply with an error and stop.
  var payload;
  try {
    payload = parsePostPayload_(e);
  } catch (err) {
    return jsonResponse_({ ok: false, error: "Invalid request body: " + err.message });
  }

  // Check the shared password. If it's missing or wrong, refuse the request.
  if (!isValidSecret_(payload && payload.secret)) {
    return jsonResponse_({ ok: false, error: "Unauthorized" });
  }

  // Read which job the website wants done (the "action"). Without one, there is nothing to do.
  var action = String((payload && payload.action) || "").trim().toLowerCase();
  if (!action) {
    return jsonResponse_({ ok: false, error: "Missing 'action' in request body" });
  }

  // Hand the request to the matching job. Each "case" below is one job name the website can ask
  // for, and the function next to it does that job.
  try {
    switch (action) {
      case "ping":
        return jsonResponse_(handlePing_(payload));
      case "preview-event":
        return jsonResponse_(handlePreviewEvent_(payload));
      case "create-event":
        return jsonResponse_(handleCreateEvent_(payload));
      case "cancel-event":
        return jsonResponse_(handleCancelEvent_(payload));
      case "list-class-resources":
        return jsonResponse_(handleListClassResources_(payload));
      case "sync-class-resources-access":
        return jsonResponse_(handleSyncClassResourcesAccess_(payload));
      case "list-student-folder":
        return jsonResponse_(handleListStudentFolder_(payload));
      case "ensure-student-folder":
        return jsonResponse_(handleEnsureStudentFolder_(payload));
      case "sync-student-folders":
        return jsonResponse_(handleSyncStudentFolders_(payload));
      case "get-lesson-recap":
        return jsonResponse_(handleGetLessonRecap_(payload));
      case "save-lesson-recap":
        return jsonResponse_(handleSaveLessonRecap_(payload));
      case "list-recaps-for-student":
        return jsonResponse_(handleListRecapsForStudent_(payload));
      case "list-recaps":
        return jsonResponse_(handleListRecaps_(payload));
      case "timesheet-status":
        return jsonResponse_(handleTimesheetStatus_(payload));
      case "preview-timesheet-row":
        return jsonResponse_(handlePreviewTimesheetRow_(payload));
      case "add-timesheet-row":
        return jsonResponse_(handleAddTimesheetRow_(payload));
      case "skip-timesheet-row":
        return jsonResponse_(handleSkipTimesheetRow_(payload));
      default:
        return jsonResponse_({ ok: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    // If a job ran into a problem, send its message back so the teacher sees what went wrong.
    return jsonResponse_({
      ok: false,
      error: err && err.message ? err.message : "Action handler threw an unexpected error"
    });
  }
}

/**
 * Parses the POST body as JSON. Apps Script gives us the raw string at
 * `e.postData.contents` regardless of the Content-Type the client sent,
 * so we tolerate text/plain (preferred, no CORS preflight) and
 * application/json equally.
 */
// parsePostPayload_ opens up the request the website sent and turns its text into usable data.
// It is given the raw request and gives back the data inside it, or stops with an error if the
// request is empty, garbled, or not the expected kind of data.
function parsePostPayload_(e) {
  // Make sure the request actually has a message inside it.
  if (!e || !e.postData || typeof e.postData.contents !== "string") {
    throw new Error("Empty body");
  }
  var raw = e.postData.contents;
  if (!raw.trim()) {
    throw new Error("Empty body");
  }
  // Try to read the text as JSON. If it isn't valid JSON, report that.
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Body is not valid JSON");
  }
  // The data must be a single labeled bundle (like { action, secret, ... }), not a list.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Body must be a JSON object");
  }
  return parsed;
}

/**
 * Constant-time-ish comparison against the shared secret in Script
 * Properties. Returns false (not throws) on any mismatch so the response
 * shape stays uniform.
 */
// isValidSecret_ checks the password the website sent against the real one kept in the drawer.
// It is given the password that came with the request and gives back yes (true) or no (false).
function isValidSecret_(candidate) {
  // No password sent, no real password set up yet, or the wrong length: the answer is no.
  if (typeof candidate !== "string" || !candidate) return false;
  var expected = getSharedSecret_();
  if (!expected) return false;
  if (candidate.length !== expected.length) return false;
  // Compare every character. It deliberately checks all of them, even after finding a mismatch,
  // so an outsider can't guess the password by timing how quickly it says "no".
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  }
  return diff === 0;
}

// getSharedSecret_ fetches the real shared password from the script's settings drawer (Script
// Properties). It gives back an empty value if none has been set.
function getSharedSecret_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty(SHARED_SECRET_PROPERTY_KEY) || "";
}

/**
 * Smoke-test action. Confirms the round trip works end-to-end:
 * frontend → POST with secret → routed → back to frontend.
 *
 * Safe to invoke directly from the Apps Script editor's Run button
 * (no arguments) — the payload is treated as optional.
 */
// handlePing_ is a simple "are you there?" test. It changes nothing and just replies "pong", with
// the current time, the spreadsheet's name, and CODE_VERSION, so a developer can confirm the
// website and this script are connected, the password works, and which version is live.
function handlePing_(payload) {
  // If the test included a short message, send it straight back (an "echo").
  var message = payload && typeof payload.message === "string"
    ? payload.message
    : null;
  return {
    ok: true,
    pong: true,
    ts: Date.now(),
    echo: message,
    spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
    codeVersion: CODE_VERSION
  };
}

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — Calendar event creation
// ──────────────────────────────────────────────────────────────────────

// LESSON BOOKING: the functions in this part put lessons on Google Calendar and take them off.
/**
 * Returns the lesson row plus the proposed event details — does NOT
 * touch the calendar. Used to populate the "preview before create"
 * modal on the Dashboard.
 */
// handlePreviewEvent_ shows the teacher what a calendar event WOULD look like before it is made.
// It is given which lesson (student email, date, start time) and gives back the proposed title,
// times, guest list, and description. Nothing is put on the calendar here.
function handlePreviewEvent_(payload) {
  // Find that lesson's row in the Lesson Schedule tab, then draft the event from it.
  var found = findLessonRowFromPayload_(payload);
  return { ok: true, preview: buildEventPreview_(found.row) };
}

/**
 * Idempotently creates a Google Calendar event for the lesson row,
 * sends invites to the student + ALWAYS_INVITE_EMAILS, and writes the
 * event ID + status back to the sheet.
 *
 * Idempotent: if the row already has a Calendar Event ID, returns the
 * existing event details instead of creating a duplicate. The frontend
 * disables the "Create event" button when `alreadyScheduled` is true,
 * but a stale UI tab could still POST again — this guard catches that.
 */
// handleCreateEvent_ puts a lesson on the teacher's Google Calendar and emails invitations.
// It is given which lesson (student email, date, start time) and gives back the new event's ID
// and a link to it. The real work happens in createEventLocked_, just below.
function handleCreateEvent_(payload) {
  // Serialize concurrent creates against the same script. Without this, a
  // double-click on the modal Confirm button (or two browser tabs open on
  // the same lesson) both pass the existingId guard below and end up
  // creating two calendar events with two invite emails to the student.
  // Script-level lock is sufficient — Apps Script web app concurrency is
  // already script-scoped — and 30s is well above any normal create path.
  // In plain terms: take a "lock" (like the single key to a room) so only one booking happens at a
  // time. If someone else holds it for 30 seconds, give up and ask the teacher to try again.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    throw new Error(
      "Another schedule is in progress for this studio. Please try again in a moment."
    );
  }
  // Do the booking while holding the lock, and always hand the key back afterward, even if
  // something went wrong.
  try {
    return createEventLocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

// createEventLocked_ does the actual booking, and only runs while the lock above is held.
// It finds the lesson row, checks it hasn't already been booked, creates the calendar event,
// and records the event's ID and a "Scheduled" status back in the Sheet.
function createEventLocked_(payload) {
  // Find the lesson row and note which columns to write the event ID and status into.
  var found = findLessonRowFromPayload_(payload);
  var sheet = found.sheet;
  var rowIndex = found.rowIndex;
  var row = found.row;
  var eventIdCol = found.calendarEventIdCol; // 1-indexed
  var statusCol = found.statusCol;            // 1-indexed or null

  // Idempotency guard. Re-reads the row inside the lock so a concurrent
  // create that finished between findLessonRowFromPayload_ and here is
  // observed. Without this re-read, a double-click could still create
  // two events if the second request's snapshot is older than the
  // first request's commit.
  // In plain terms: read the row again, fresh, in case another request booked it moments ago.
  var freshRow = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var freshRowObj = rowToObject_(headers, freshRow);
  var existingId = String(freshRowObj[CALENDAR_EVENT_ID_COLUMN] || "").trim();
  // Already booked? Don't make a second event. Just send back the existing event's details.
  if (existingId) {
    var existingEvent = safeGetEvent_(existingId);
    return {
      ok: true,
      alreadyScheduled: true,
      calendarEventId: existingId,
      eventLink: existingEvent ? eventEditUrl_(existingEvent) : null,
      preview: buildEventPreview_(freshRowObj)
    };
  }

  // Draft the event. If the teacher edited the guest list in the preview window, use that list;
  // otherwise use the standard list (the student plus the always-invited people). The event goes
  // on the main calendar of the Google account that runs this script (the teacher's calendar).
  var preview = buildEventPreview_(row);
  var attendeesOverride = normalizeAttendeesOverride_(payload);
  var guestsList = attendeesOverride || preview.attendees;
  var calendar = CalendarApp.getDefaultCalendar();

  // Create the event with its title, start and end times, and description, and email an
  // invitation to every guest.
  var event = calendar.createEvent(
    preview.title,
    new Date(preview.startISO),
    new Date(preview.endISO),
    {
      description: preview.description,
      guests: guestsList.join(","),
      sendInvites: true
    }
  );

  // Write the new event's ID into the lesson row and mark the lesson "Scheduled", so the website
  // moves it from Pending to Upcoming and knows it's already booked.
  var eventId = event.getId();
  sheet.getRange(rowIndex, eventIdCol).setValue(eventId);
  if (statusCol) {
    sheet.getRange(rowIndex, statusCol).setValue("Scheduled");
  }
  // Save the changes to the Sheet right away, before replying to the website.
  SpreadsheetApp.flush();

  // Tell the website it worked, with the event ID and a link to open it in Google Calendar.
  return {
    ok: true,
    alreadyScheduled: false,
    calendarEventId: eventId,
    eventLink: eventEditUrl_(event)
  };
}

/**
 * Deletes the calendar event (if any) and clears the row's Calendar
 * Event ID. Sets Status to "Cancelled" only when an event was actually
 * cancelled — calling cancel on a row that was never scheduled is a
 * clean no-op and leaves Status untouched. Does not delete the sheet row.
 */
// handleCancelEvent_ takes a lesson off Google Calendar. It is given which lesson (student email,
// date, start time). It deletes the event, clears the saved event ID, and marks the lesson
// "Cancelled". The lesson row itself stays in the Sheet.
// Like booking, it takes the lock first, so a cancel and a booking for the same lesson can't
// run at the same moment and leave the Sheet and the calendar disagreeing.
function handleCancelEvent_(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    throw new Error(
      "Another schedule change is in progress for this studio. Please try again in a moment."
    );
  }
  // Do the cancel while holding the lock, and always hand the key back afterward.
  try {
    return cancelEventLocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

// cancelEventLocked_ does the actual cancelling, and only runs while the lock above is held.
// Because the row is looked up inside the lock, it always sees the Sheet as it is right now,
// including a booking that finished a moment ago.
function cancelEventLocked_(payload) {
  // Find the lesson row and the columns we may need to update.
  var found = findLessonRowFromPayload_(payload);
  var sheet = found.sheet;
  var rowIndex = found.rowIndex;
  var row = found.row;
  var eventIdCol = found.calendarEventIdCol;
  var statusCol = found.statusCol;

  // If the lesson was never booked, there's nothing to cancel, so say so and change nothing.
  var existingId = String(row[CALENDAR_EVENT_ID_COLUMN] || "").trim();
  if (!existingId) {
    return { ok: true, cancelled: false, reason: "No event to cancel for this lesson row." };
  }

  // Find the event on the calendar and delete it. If someone already deleted it by hand in
  // Google Calendar, skip this step quietly.
  var existing = safeGetEvent_(existingId);
  if (existing) existing.deleteEvent();

  // Clear the saved event ID, mark the lesson "Cancelled", and save the Sheet right away.
  sheet.getRange(rowIndex, eventIdCol).setValue("");
  if (statusCol) {
    sheet.getRange(rowIndex, statusCol).setValue("Cancelled");
  }
  SpreadsheetApp.flush();

  return { ok: true, cancelled: true };
}

/**
 * One-time authorization helper. Run this from the Apps Script editor
 * after adding any new Google service (Calendar, Drive, Gmail, etc.)
 * to surface the consent dialog without needing a real POST request.
 *
 * Touch every service the deployed code uses so the prompt covers
 * everything in one go. Safe to re-run — purely read-only.
 */
// authorize is run by hand, once, from the Apps Script editor (not by the website). Google asks
// the account owner for permission before a script may use their Calendar or Drive. This touches
// each Google service once so all the permission pop-ups appear together, and writes a short
// report to the log showing whether each piece is set up correctly.
function authorize() {
  // First line of the log: which version of this file is running, so a paste can be confirmed.
  Logger.log("Code version: " + CODE_VERSION);

  // Touch each service so Apps Script knows it must request the
  // corresponding OAuth scope. Logger output is purely informational.
  var ssName = SpreadsheetApp.getActiveSpreadsheet().getName();
  var calName = CalendarApp.getDefaultCalendar().getName();

  // Drive scope (Phase 3+). Touching the root folder is the cheapest
  // way to surface the consent prompt; if the configured folder IDs
  // are set, also resolve them so we get clear errors here (instead
  // of from the live web app) when an ID is wrong.
  var rootName = DriveApp.getRootFolder().getName();
  var props = PropertiesService.getScriptProperties();

  // Look up the two configured Drive folders by name, so a wrong folder ID shows up here clearly.
  var classResourcesName = resolveFolderNameForAuthorize_(
    props.getProperty(CLASS_RESOURCES_FOLDER_ID_PROPERTY_KEY)
  );
  var studentResourcesParentName = resolveFolderNameForAuthorize_(
    props.getProperty(STUDENT_RESOURCES_PARENT_FOLDER_ID_PROPERTY_KEY)
  );

  // Write a short report to the editor's "Execution log" panel, and return the same details.
  Logger.log("Spreadsheet:              " + ssName);
  Logger.log("Calendar:                 " + calName);
  Logger.log("Drive root:               " + rootName);
  Logger.log("Class Resources:          " + classResourcesName);
  Logger.log("Student Resources parent: " + studentResourcesParentName);

  // Phase 6: open the time sheet too (so the permission prompt covers it) and report, in plain
  // words, whether both time sheet settings are ready. A problem here never stops authorize().
  var timesheet = checkTimesheetForAuthorize_();
  timesheet.lines.forEach(function (line) {
    Logger.log(line);
  });

  Logger.log(
    "Authorization complete. Re-deploy (Manage deployments → ✏️ → New version) " +
    "if you haven't already."
  );
  return {
    ok: true,
    codeVersion: CODE_VERSION,
    spreadsheet: ssName,
    calendar: calName,
    driveRoot: rootName,
    classResources: classResourcesName,
    studentResourcesParent: studentResourcesParentName,
    timesheet: timesheet.summary
  };
}

/**
 * Helper for authorize() — turns a (possibly-missing) folder id into a
 * human-readable name for the execution log. Never throws; surfaces
 * any Drive error inline so the teacher sees what to fix.
 */
// resolveFolderNameForAuthorize_ turns a folder ID into the folder's name for the report above.
// It says "(not configured)" if no ID was set, or shows Google's error if the ID doesn't work.
function resolveFolderNameForAuthorize_(folderId) {
  if (!folderId) return "(not configured)";
  try {
    return DriveApp.getFolderById(folderId).getName();
  } catch (err) {
    return "(error: " + (err && err.message ? err.message : err) + ")";
  }
}

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Looks up a Lesson Schedule row by composite key. Returns sheet
 * handle, 1-indexed rowIndex, the row as a header→value object, and
 * 1-indexed column numbers for the columns we'll write back to.
 *
 * Throws (the message bubbles back to the frontend as `ok:false`)
 * when the sheet is missing, the row isn't found, the key matches more
 * than one row, or the key is bad.
 */
// findLessonRowFromPayload_ finds one lesson in the Lesson Schedule tab. A lesson is identified by
// three things together: the student's email, the lesson date, and the start time. It gives back
// the tab, the row number, the row's contents, and which columns hold the event ID and status.
// If the lesson can't be found, or more than one row matches, it stops with a message the teacher
// will see on the website.
function findLessonRowFromPayload_(payload) {
  // Pull the three identifying details out of the request and tidy them up.
  var studentEmail = String((payload && payload.studentEmail) || "")
    .trim()
    .toLowerCase();
  var lessonDate = String((payload && payload.lessonDate) || "").trim();
  var startTime = String((payload && payload.startTime) || "").trim();

  // All three are required; if any is missing, stop and say which one.
  if (!studentEmail) throw new Error("Missing studentEmail");
  if (!lessonDate) throw new Error("Missing lessonDate");
  if (!startTime) throw new Error("Missing startTime");

  // Open the Lesson Schedule tab.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LESSON_SCHEDULE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + LESSON_SCHEDULE_SHEET_NAME + '" not found');
  }

  // Make sure the "Calendar Event ID" column exists (it's added automatically the first time).
  ensureCalendarEventIdColumn_(sheet);

  // Read the whole tab. Row 1 holds the column titles.
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error("Lesson Schedule sheet has no rows");
  var headers = data[0];

  // Work out which column is which by its title, so the teacher can reorder columns safely.
  var emailCol = headerIndex_(headers, "Student Email");
  var dateCol = headerIndex_(headers, "Lesson Date");
  var startCol = headerIndex_(headers, "Start Time");
  var statusCol = headerIndex_(headers, "Status");
  var eventIdCol = headerIndex_(headers, CALENDAR_EVENT_ID_COLUMN);

  // If a required column is missing, stop with a message naming it.
  if (emailCol === -1) throw new Error('Column "Student Email" not found');
  if (dateCol === -1) throw new Error('Column "Lesson Date" not found');
  if (startCol === -1) throw new Error('Column "Start Time" not found');
  if (eventIdCol === -1) throw new Error(
    'Column "' + CALENDAR_EVENT_ID_COLUMN + '" not found (auto-init failed?)'
  );

  // Go down the lessons one by one, looking for the row whose email, date, and start time all
  // match. Dates and times are rewritten in the same style the website uses before comparing.
  // Every matching row is collected (not just the first), so duplicates can be caught below.
  var ssTz = ss.getSpreadsheetTimeZone();
  var matchRowIndexes = [];

  for (var r = 1; r < data.length; r++) {
    var rowEmail = String(data[r][emailCol] || "").trim().toLowerCase();
    if (rowEmail !== studentEmail) continue;

    var rowDate = normalizeSheetDate_(data[r][dateCol], ssTz);
    if (rowDate !== lessonDate) continue;

    var rowStart = normalizeSheetTime_(data[r][startCol], ssTz);
    if (rowStart !== startTime) continue;

    matchRowIndexes.push(r + 1); // sheet rows are 1-indexed
  }

  // No match: tell the teacher which lesson couldn't be found.
  if (matchRowIndexes.length === 0) {
    throw new Error(
      "No matching row in Lesson Schedule for " + studentEmail +
      " on " + lessonDate + " at " + startTime
    );
  }

  // More than one row has the same student, date, and start time. The website has no way to say
  // which one it means, so rather than guess (and maybe book or cancel the wrong row), stop and
  // tell the teacher which rows to fix in the Sheet.
  if (matchRowIndexes.length > 1) {
    throw new Error(
      "More than one row in Lesson Schedule matches " + studentEmail + " on " + lessonDate +
      " at " + startTime + " (rows " + matchRowIndexes.join(", ") + "). " +
      "Delete or correct the duplicate row, then try again."
    );
  }
  var matchRowIndex = matchRowIndexes[0];

  // Found it: send back the row as a labeled record plus where it lives in the Sheet.
  // (Sheet rows and columns count from 1, while the code counts from 0, hence the "+ 1".)
  var rowObj = rowToObject_(headers, data[matchRowIndex - 1]);
  return {
    sheet: sheet,
    rowIndex: matchRowIndex,
    row: rowObj,
    calendarEventIdCol: eventIdCol + 1,
    statusCol: statusCol === -1 ? null : statusCol + 1
  };
}

/**
 * Adds the Calendar Event ID column to the right of the existing
 * headers if it doesn't already exist. Idempotent. Run on every
 * lookup so the column appears the first time the teacher uses Phase 2,
 * without requiring a manual sheet edit.
 */
// ensureCalendarEventIdColumn_ adds a "Calendar Event ID" column to the end of the Lesson
// Schedule tab if it isn't there yet, and styles it. If the column already exists, it does nothing.
function ensureCalendarEventIdColumn_(sheet) {
  ensureAutoManagedColumn_(sheet, CALENDAR_EVENT_ID_COLUMN);
}

// ensureAutoManagedColumn_ adds a column the website fills in by itself (such as "Calendar Event
// ID" or "Time Sheet") to the end of the Lesson Schedule tab if it isn't there yet, styles it,
// and puts the "please don't edit" warning on it. It gives back the column's number (counting
// from 1), or -1 if the tab is completely empty.
function ensureAutoManagedColumn_(sheet, columnName) {
  // Read the title row, and stop if the tab is empty or the column is already there.
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return -1;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === columnName) return i + 1;
  }
  // Otherwise, add the title in the next empty column, in bold white on the studio's crimson.
  // (If the tab has no spare column left, add one first.)
  var newCol = lastCol + 1;
  if (newCol > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
  }
  sheet.getRange(1, newCol)
    .setValue(columnName)
    .setFontWeight("bold")
    .setFontColor(FMT_HEADER_TEXT)
    .setBackground(FMT_HEADER_BG);
  // Newly added — apply the auto-managed treatment so it's clearly
  // off-limits from the moment the column appears, even before the
  // teacher runs setupSheetFormatting().
  try {
    highlightAutoManagedColumn_(sheet, newCol, columnName);
    protectAutoManagedColumn_(sheet, newCol);
  } catch (err) {
    Logger.log("ensureAutoManagedColumn_(" + columnName + "): highlight/protect failed: " + err);
  }
  return newCol;
}

/**
 * Validates an optional `attendees` array on the create-event payload.
 * Returns null when the field is absent so the caller falls back to the
 * auto-built preview list. Throws (bubbles to the frontend as `ok:false`)
 * on any malformed entry or an empty list — the frontend already enforces
 * "at least one attendee", so an empty array hitting this side is a bug
 * worth surfacing rather than silently falling back.
 */
// normalizeAttendeesOverride_ checks the guest list the teacher may have edited in the preview
// window. It gives back a clean list (no blanks, no repeats, only real-looking email addresses),
// or nothing if the teacher didn't send a list, in which case the standard list is used.
function normalizeAttendeesOverride_(payload) {
  // No list sent: use the standard guest list instead.
  if (!payload || !("attendees" in payload)) return null;
  if (!Array.isArray(payload.attendees)) {
    throw new Error("attendees must be an array of email strings");
  }
  // Go through each guest, skipping blanks and repeats, and stop with an error on anything that
  // doesn't look like an email address (something@something.something).
  var seen = {};
  var out = [];
  for (var i = 0; i < payload.attendees.length; i++) {
    var raw = payload.attendees[i];
    if (typeof raw !== "string") {
      throw new Error("Invalid attendee entry (not a string)");
    }
    var v = raw.trim();
    if (!v) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      throw new Error("Invalid attendee email: " + v);
    }
    var k = v.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(v);
  }
  // An empty list is a mistake (a lesson needs at least one guest), so report it.
  if (out.length === 0) {
    throw new Error("At least one attendee is required.");
  }
  return out;
}

/** Builds the calendar event metadata for one row (preview + create share this). */
// buildEventPreview_ drafts a calendar event from one lesson row. It is given the row and gives
// back the event's title, start and end times, guest list, and description, plus whether the
// lesson is already on the calendar. Both the preview window and the real booking use it.
function buildEventPreview_(row) {
  // Pull out each piece of the lesson row, trimmed of stray spaces.
  var studentName = String(row["Student Name"] || "").trim();
  var studentEmail = String(row["Student Email"] || "").trim();
  var lessonFocus = String(row["Lesson Focus"] || "").trim();
  var lessonBlock = String(row["Lesson Block"] || "").trim();
  var note = String(row["Note"] || row["Notes"] || "").trim();
  var lessonDate = String(row["Lesson Date"] || "").trim();
  var startTime = String(row["Start Time"] || "").trim();
  var endTime = String(row["End Time"] || "").trim();
  var existingEventId = String(row[CALENDAR_EVENT_ID_COLUMN] || "").trim();

  // Combine the date with the start and end times, using the spreadsheet's time zone.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var startDate = parseLessonDateTime_(lessonDate, startTime, tz);
  var endDate = parseLessonDateTime_(lessonDate, endTime, tz);

  // If the date or times can't be understood, stop and show what was in the row.
  if (!startDate || !endDate) {
    throw new Error(
      "Could not parse lesson date/time: date='" + lessonDate +
      "', start='" + startTime + "', end='" + endTime + "'"
    );
  }
  // Cross-midnight: a lesson typed as 11:30 PM → 12:30 AM produces an
  // end that's 23 hours BEFORE the start when both share the same
  // calendar date. Roll the end forward by one day so the duration is
  // positive and the calendar event spans correctly. Anything still
  // ≤ start after that roll is genuinely invalid (same wall-clock).
  if (endDate.getTime() <= startDate.getTime()) {
    var rolled = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
    if (rolled.getTime() > startDate.getTime()) {
      endDate = rolled;
    } else {
      throw new Error("End time must be after start time");
    }
  }

  // Title: "Student Name - Lesson Focus", or "Student Name - Music Lesson" if no focus is set.
  // If the row has no name, the student's email is used instead.
  var displayName = studentName || studentEmail;
  var title = lessonFocus
    ? displayName + " - " + lessonFocus
    : displayName + " - Music Lesson";

  // Description: the student, block, focus, and notes, each on its own line, followed by a
  // reminder that the event was made by the dashboard.
  var descriptionParts = [];
  descriptionParts.push("Student: " + displayName + " <" + studentEmail + ">");
  if (lessonBlock) descriptionParts.push("Block: " + lessonBlock);
  if (lessonFocus) descriptionParts.push("Focus: " + lessonFocus);
  if (note) descriptionParts.push("Notes: " + note);
  descriptionParts.push("");
  descriptionParts.push(
    "Auto-created by the Music Studio dashboard. Edit the lesson row in " +
    'the "Lesson Schedule" tab and re-run if you need to change times.'
  );
  var description = descriptionParts.join("\n");

  // Dedupe attendees case-insensitively, normalizing the stored value to
  // lowercase too — otherwise `Foo@Bar.com` from the form and
  // `foo@bar.com` from ALWAYS_INVITE_EMAILS produce two attendees on
  // the calendar event.
  var attendeeSet = {};
  if (studentEmail) attendeeSet[studentEmail.toLowerCase()] = studentEmail.toLowerCase();
  for (var i = 0; i < ALWAYS_INVITE_EMAILS.length; i++) {
    var e = ALWAYS_INVITE_EMAILS[i];
    if (e) attendeeSet[e.toLowerCase()] = e.toLowerCase();
  }
  // Turn the de-duplicated guests into a simple list.
  var attendees = [];
  Object.keys(attendeeSet).forEach(function (k) {
    attendees.push(attendeeSet[k]);
  });

  // Hand back everything the preview window and the booking step need.
  return {
    title: title,
    startISO: startDate.toISOString(),
    endISO: endDate.toISOString(),
    attendees: attendees,
    description: description,
    calendarName: CalendarApp.getDefaultCalendar().getName(),
    alreadyScheduled: existingEventId !== "",
    calendarEventId: existingEventId || null,
    studentEmail: studentEmail,
    studentName: studentName,
    lessonDate: lessonDate,
    startTime: startTime,
    endTime: endTime
  };
}

/**
 * Combines a date string ("yyyy-MM-dd") and a wall-clock time string
 * ("h:mm AM/PM" or "HH:mm") into a Date interpreted in the given
 * timezone. Returns null on parse failure.
 */
// parseLessonDateTime_ joins a date (like "2026-09-25") and a clock time (like "3:30 PM") into one
// exact moment in the spreadsheet's time zone. It gives back nothing if either can't be read.
function parseLessonDateTime_(dateStr, timeStr, tz) {
  // Check the date is written as year-month-day, and read the clock time.
  var dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!dateMatch) return null;
  var hm = parseWallClockTime_(timeStr);
  if (!hm) return null;
  // Rebuild the moment as text like "2026-09-25 15:30:00" and let Google convert it using the
  // right time zone.
  var hh = hm.h < 10 ? "0" + hm.h : "" + hm.h;
  var mm = hm.m < 10 ? "0" + hm.m : "" + hm.m;
  var iso = dateStr + " " + hh + ":" + mm + ":00";
  try {
    return Utilities.parseDate(iso, tz, "yyyy-MM-dd HH:mm:ss");
  } catch (err) {
    return null;
  }
}

// parseWallClockTime_ reads a clock time typed like "3:30 PM" or "15:30" and gives back the hour
// (0 to 23) and minutes. It gives back nothing if the text isn't a sensible time.
function parseWallClockTime_(timeStr) {
  // Check the text looks like a time: hours, a colon, minutes, and maybe AM or PM.
  var m = /^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/.exec(String(timeStr).trim());
  if (!m) return null;
  var h = parseInt(m[1], 10);
  var min = parseInt(m[2], 10);
  var ampm = m[3] ? m[3].toUpperCase() : "";
  // Convert to a 24-hour clock: 3 PM becomes 15, and 12 AM (midnight) becomes 0.
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  // Reject impossible times like 25:00 or 10:75.
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h: h, m: min };
}

/** "yyyy-MM-dd" string from a value that may already be a Date or a string. */
// normalizeSheetDate_ makes sure a date from the Sheet is written as "year-month-day" text,
// whether the cell held a real date or typed text, so dates can be compared reliably.
function normalizeSheetDate_(val, tz) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, tz, "yyyy-MM-dd");
  }
  return String(val || "").trim();
}

/**
 * Wall-clock string ("h:mm a") from a sheet value. Sheets stores
 * time-only cells as Dates from 1899-12-30; the existing rowToObject_
 * already formats those correctly. We mirror that logic here so a row
 * lookup matches what the frontend received and is sending back.
 */
// normalizeSheetTime_ does the same for clock times, writing them like "3:30 PM", so a time from
// the Sheet matches the time the website sends back.
function normalizeSheetTime_(val, tz) {
  if (val instanceof Date) {
    if (val.getFullYear() < 1900) {
      return Utilities.formatDate(val, tz, "h:mm a");
    }
    return Utilities.formatDate(val, tz, "h:mm a");
  }
  return String(val || "").trim();
}

// headerIndex_ finds which column has a given title. It gives back the column's position
// (counting from 0), or -1 if no column has that title.
function headerIndex_(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === name) return i;
  }
  return -1;
}

/** Returns the calendar event or null if it's been deleted out of band. */
// safeGetEvent_ looks up a calendar event by its ID. If the event was deleted or can't be found,
// it gives back nothing instead of crashing.
function safeGetEvent_(eventId) {
  try {
    return CalendarApp.getDefaultCalendar().getEventById(eventId);
  } catch (err) {
    return null;
  }
}

/** Best-effort link to the event in Google Calendar. */
// eventEditUrl_ builds a web link that opens the event in Google Calendar for editing. Google
// expects the event's ID and the calendar's ID together, scrambled into a code (base64, a
// standard way of turning text into letters and numbers that are safe to put in a link).
function eventEditUrl_(event) {
  // event.getId() is "<id>@google.com"; the editor expects just the id part
  var raw = event.getId();
  var atIdx = raw.indexOf("@");
  var id = atIdx > 0 ? raw.substring(0, atIdx) : raw;
  return "https://calendar.google.com/calendar/u/0/r/eventedit/" +
    Utilities.base64Encode(id + " " + CalendarApp.getDefaultCalendar().getId());
}

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — Class Resources (shared Drive folder)
// ──────────────────────────────────────────────────────────────────────

// SHARED CLASS FOLDER: one Google Drive folder of class materials that every student can view
// (but not change).
/**
 * Returns a snapshot of the Class Resources folder for the Dashboard:
 * folder metadata + a list of its top-level children. Read-only — does
 * not touch permissions. Sub-folders are returned alongside files (the
 * UI treats them as "open in Drive" items, same as files).
 *
 * Returns up to CLASS_RESOURCES_LIST_CAP entries, sorted by modified
 * time descending, so the most recently touched material surfaces first
 * even if the folder grows.
 */
// handleListClassResources_ gives the website a list of what's in the shared Class Resources
// folder: the folder's name and link, plus its files and sub-folders, newest first.
// It only looks; it never changes who can see the folder.
function handleListClassResources_(payload) {
  // Open the folder, list what's inside, and send both back.
  var folder = getClassResourcesFolder_();
  var files = listFolderFiles_(folder);
  return {
    ok: true,
    folder: {
      id: folder.getId(),
      name: folder.getName(),
      webViewLink: folder.getUrl()
    },
    files: files
  };
}

/**
 * Grants viewer access on the Class Resources folder to every email in
 * the student roster (Form Responses 1) plus CLASS_RESOURCES_EXTRA_VIEWERS.
 *
 * Idempotent: emails that already have access are reported under
 * `alreadyHadAccess` and not re-added. Per-email errors (invalid email,
 * Drive rejection, etc.) are collected into `errors` so a single bad
 * row doesn't poison the whole sync.
 *
 * The script owner is intentionally excluded from the grant loop — they
 * own the folder and addViewer would error.
 */
// handleSyncClassResourcesAccess_ gives every student on the roster (plus the extra people in the
// settings) permission to VIEW the shared Class Resources folder. It never removes anyone.
// It reports back who was newly added, who already had access, and any addresses that failed.
function handleSyncClassResourcesAccess_(payload) {
  // Open the folder.
  var folder = getClassResourcesFolder_();

  // Gather everyone who should see it: every roster email plus the extra viewers from the
  // settings, tidied to lowercase.
  var rosterEmails = getStudentEmails_();
  var extraEmails = (CLASS_RESOURCES_EXTRA_VIEWERS || []).map(function (e) {
    return String(e || "").trim().toLowerCase();
  }).filter(function (e) { return e !== ""; });

  // Build the "skip self" set. The folder's `getOwner()` is unreliable
  // for shared-drive sub-folders (it can return the shared drive
  // entity, null, or throw), so also skip the email of the user the
  // web app runs as — that's the canonical "the script owner already
  // has access" check, and it works in both My Drive and shared drives.
  // In plain terms: skip the folder's owner and the account running this script. They already
  // have full access, and Google would refuse to add them as viewers.
  var skip = {};
  try {
    var ownerEmail = String(folder.getOwner().getEmail() || "").toLowerCase();
    if (ownerEmail) skip[ownerEmail] = true;
  } catch (err) {
    // Shared-drive folders without a single owner — fall through.
  }
  try {
    var selfEmail = String(Session.getEffectiveUser().getEmail() || "").toLowerCase();
    if (selfEmail) skip[selfEmail] = true;
  } catch (err) {
    // Session.getEffectiveUser is gated by scope on some accounts; safe to ignore.
  }

  // Build the final list of people to add, skipping blanks, the owner, and repeats.
  var seen = {};
  var targets = [];
  rosterEmails.concat(extraEmails).forEach(function (email) {
    if (!email) return;
    if (skip[email]) return;
    if (seen[email]) return;
    seen[email] = true;
    targets.push(email);
  });

  // Find out who can already see or edit the folder, so we don't add them twice.
  var existingViewers = {};
  try {
    folder.getViewers().forEach(function (user) {
      var em = String(user.getEmail() || "").toLowerCase();
      if (em) existingViewers[em] = true;
    });
    folder.getEditors().forEach(function (user) {
      var em = String(user.getEmail() || "").toLowerCase();
      if (em) existingViewers[em] = true;
    });
  } catch (err) {
    // Some shared-drive configs throw on getViewers/getEditors enumeration.
    // Treat as "no prior access known" and let addViewer be the source of truth.
  }

  // Keep three tallies for the report: newly added, already had access, and failures.
  var granted = [];
  var alreadyHadAccess = [];
  var errors = [];

  // Go through each person. If they already have access, note it. Otherwise give them view
  // access. If Google refuses (for example, a mistyped email), note the error and keep going.
  targets.forEach(function (email) {
    if (existingViewers[email]) {
      alreadyHadAccess.push(email);
      return;
    }
    try {
      folder.addViewer(email);
      granted.push(email);
    } catch (err) {
      errors.push({
        email: email,
        message: err && err.message ? err.message : String(err)
      });
    }
  });

  // Send the report back to the website.
  return {
    ok: true,
    folder: { id: folder.getId(), name: folder.getName() },
    granted: granted,
    alreadyHadAccess: alreadyHadAccess,
    errors: errors
  };
}

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — helpers
// ──────────────────────────────────────────────────────────────────────

/** Maximum number of children returned by handleListClassResources_. */
// At most 100 items are shown on the dashboard, so a very full folder doesn't slow the page.
var CLASS_RESOURCES_LIST_CAP = 100;

/**
 * Resolves the Class Resources folder via its Script Property ID.
 * Throws (with a teacher-friendly message) when the property is unset
 * or the ID points at something Drive can't open — both of these
 * messages bubble back to the dashboard as the action's error so the
 * teacher sees what to fix.
 */
// getClassResourcesFolder_ opens the shared Class Resources folder using the ID saved in the
// settings drawer. If no ID has been saved, or the ID doesn't open a folder, it stops with a
// message telling the teacher exactly what to fix.
function getClassResourcesFolder_() {
  // Look up the saved folder ID. If there isn't one, explain how to set it.
  var folderId = PropertiesService.getScriptProperties()
    .getProperty(CLASS_RESOURCES_FOLDER_ID_PROPERTY_KEY);
  if (!folderId) {
    throw new Error(
      'Class Resources folder is not configured. Set the "' +
      CLASS_RESOURCES_FOLDER_ID_PROPERTY_KEY +
      '" Script Property to the folder id from its Drive URL.'
    );
  }
  // Try to open the folder. If Google can't, pass along why.
  try {
    return DriveApp.getFolderById(folderId);
  } catch (err) {
    throw new Error(
      'Could not open Class Resources folder (id "' + folderId + '"): ' +
      (err && err.message ? err.message : String(err))
    );
  }
}

/**
 * Lists immediate children of a folder (files + sub-folders), sorted
 * by modified time descending. Capped at CLASS_RESOURCES_LIST_CAP.
 *
 * webViewLink is taken from `getUrl()` for both files and folders;
 * iconLink falls back to a Drive-hosted generic icon when Apps Script
 * doesn't expose one for the mime type.
 */
// listFolderFiles_ lists what's directly inside a Drive folder (files and sub-folders, but not
// what's inside those sub-folders). For each item it gives back its name, type, last-changed
// time, link, and a small icon, sorted newest first and capped at 100 items.
function listFolderFiles_(folder) {
  var entries = [];

  // Go through every file in the folder and note its details.
  var fileIter = folder.getFiles();
  while (fileIter.hasNext()) {
    var f = fileIter.next();
    entries.push({
      id: f.getId(),
      name: f.getName(),
      mimeType: f.getMimeType(),
      modifiedTime: f.getLastUpdated().toISOString(),
      webViewLink: f.getUrl(),
      iconLink: iconLinkForMimeType_(f.getMimeType()),
      isFolder: false
    });
  }

  // Then do the same for every sub-folder.
  var subIter = folder.getFolders();
  while (subIter.hasNext()) {
    var sf = subIter.next();
    entries.push({
      id: sf.getId(),
      name: sf.getName(),
      mimeType: "application/vnd.google-apps.folder",
      modifiedTime: sf.getLastUpdated().toISOString(),
      webViewLink: sf.getUrl(),
      iconLink: iconLinkForMimeType_("application/vnd.google-apps.folder"),
      isFolder: true
    });
  }

  // Put the most recently changed items first.
  entries.sort(function (a, b) {
    return (b.modifiedTime || "").localeCompare(a.modifiedTime || "");
  });

  // If there are more than 100, keep only the newest 100.
  if (entries.length > CLASS_RESOURCES_LIST_CAP) {
    entries = entries.slice(0, CLASS_RESOURCES_LIST_CAP);
  }
  return entries;
}

/**
 * Stable Drive icon URL for a given mime type. Drive's CDN serves
 * 16-px icons keyed by mime type; falling back to the generic file
 * icon when the type isn't recognized keeps the UI tidy.
 */
// iconLinkForMimeType_ gives back the web address of Google Drive's small icon for a kind of file
// (a "mime type" is a standard label for a file's kind, like PDF or spreadsheet).
// If the kind is unknown, it uses a plain generic-file icon.
function iconLinkForMimeType_(mimeType) {
  var base = "https://drive-thirdparty.googleusercontent.com/16/type/";
  if (!mimeType) return base + "application/octet-stream";
  return base + mimeType;
}

/**
 * Reads "Form Responses 1" and returns the deduped, lowercased list of
 * student email addresses. Skips blanks. Does NOT validate format —
 * Drive will reject genuinely malformed addresses on addViewer, and
 * the sync handler reports those as per-email errors.
 */
// getStudentEmails_ reads the form-answers tab and gives back every student's email address,
// once each, in lowercase, skipping blank rows. It's used when sharing folders with the roster.
function getStudentEmails_() {
  // Open the form-answers tab and read everything on it.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Form Responses 1");
  if (!sheet) {
    throw new Error('Sheet "Form Responses 1" not found');
  }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  // Find the email column by its title.
  var headers = data[0].map(function (h) {
    return String(h || "").trim().toLowerCase();
  });
  var emailCol = headers.indexOf("email address");
  if (emailCol === -1) {
    throw new Error('Could not find "Email Address" column in Form Responses 1');
  }

  // Collect each email once, even if a student submitted the form more than once.
  var seen = {};
  var emails = [];
  for (var r = 1; r < data.length; r++) {
    var raw = String(data[r][emailCol] || "").trim().toLowerCase();
    if (!raw) continue;
    if (seen[raw]) continue;
    seen[raw] = true;
    emails.push(raw);
  }
  return emails;
}

// ──────────────────────────────────────────────────────────────────────
// Phase 4 — Student Resources (per-student Drive folders, editor access)
// ──────────────────────────────────────────────────────────────────────

// PERSONAL STUDENT FOLDERS: each student gets their own Drive folder that they can add files to
// (recordings, marked-up music, and so on).
/**
 * Returns the per-student folder for one student plus its top-level
 * children. Auto-creates the folder on first call (idempotent, with the
 * student granted editor access) so the dashboard never has to know
 * whether the folder exists yet.
 */
// handleListStudentFolder_ is used when the teacher opens a student's profile on the website.
// It makes sure that student has a personal Drive folder (creating it if needed) and gives back
// the folder's name and link plus a list of what's inside it.
function handleListStudentFolder_(payload) {
  // Work out which student this is, make sure their folder exists, then list its contents.
  var resolved = resolveStudentFromPayload_(payload);
  var ensured = ensureStudentFolder_(resolved.email, resolved.name);
  var files = listFolderFiles_(ensured.folder);
  // Send back the folder details, the student, and the file list.
  return {
    ok: true,
    folder: {
      id: ensured.folder.getId(),
      name: ensured.folder.getName(),
      webViewLink: ensured.folder.getUrl(),
      created: ensured.created
    },
    student: { email: resolved.email, name: resolved.name },
    files: files
  };
}

/**
 * Same as list-student-folder but without the file listing — useful
 * when the caller only needs to know the folder exists / get its URL.
 * Used internally by sync-student-folders so the bulk sync doesn't pay
 * the per-student `listFolderFiles_` cost for every row.
 */
// handleEnsureStudentFolder_ does the same as above but skips listing the files, for when only
// the folder itself (and its link) is needed.
function handleEnsureStudentFolder_(payload) {
  // Work out which student this is, make sure their folder exists, and send back its details.
  var resolved = resolveStudentFromPayload_(payload);
  var ensured = ensureStudentFolder_(resolved.email, resolved.name);
  return {
    ok: true,
    folder: {
      id: ensured.folder.getId(),
      name: ensured.folder.getName(),
      webViewLink: ensured.folder.getUrl(),
      created: ensured.created
    },
    student: { email: resolved.email, name: resolved.name }
  };
}

/**
 * Bulk-creates per-student folders for every email in Form Responses 1
 * that doesn't already have one. Reports `created` (newly made),
 * `existed` (already had a folder), and `errors` (per-email failures —
 * e.g. invalid email rejected by Drive's permission API).
 *
 * Idempotent. Safe to re-run after adding new students to the form.
 */
// handleSyncStudentFolders_ is the "Sync all student folders" button on the Dashboard. It goes
// through every student on the roster and makes sure each has a personal folder with the right
// sharing. It reports which folders were newly made, which already existed, and any failures.
function handleSyncStudentFolders_(payload) {
  // Open the main Student Resources folder (this stops early if it isn't set up), and get the
  // roster of students with their names.
  var parent = getStudentResourcesParentFolder_();
  var students = getStudentRoster_(); // [{ email, name }, ...]

  // Three tallies for the report.
  var created = [];
  var existed = [];
  var errors = [];

  // For each student, make sure their folder exists. One student's problem is noted and doesn't
  // stop the rest.
  students.forEach(function (s) {
    try {
      var ensured = ensureStudentFolder_(s.email, s.name);
      if (ensured.created) {
        created.push(s.email);
      } else {
        existed.push(s.email);
      }
    } catch (err) {
      errors.push({
        email: s.email,
        message: err && err.message ? err.message : String(err)
      });
    }
  });

  // Send the report back to the website.
  return {
    ok: true,
    parent: { id: parent.getId(), name: parent.getName() },
    created: created,
    existed: existed,
    errors: errors
  };
}

// ──────────────────────────────────────────────────────────────────────
// Phase 4 — helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolves an email payload field plus the student's display name from
 * Form Responses 1. The name is best-effort — if the roster doesn't
 * have a row for this email yet, we fall back to the email itself for
 * the folder name.
 */
// resolveStudentFromPayload_ reads the student's email from the website's request and looks up
// their name on the roster. It gives back both. The name may be blank if the student isn't on
// the roster yet.
function resolveStudentFromPayload_(payload) {
  // Tidy the email and stop if it's missing.
  var email = String((payload && payload.studentEmail) || "")
    .trim()
    .toLowerCase();
  if (!email) throw new Error("Missing studentEmail");

  // Look up the student's name from the form answers.
  var nameByEmail = getStudentNameMap_();
  var name = nameByEmail[email] || "";
  return { email: email, name: name };
}

/**
 * Returns the parent folder that holds every per-student sub-folder.
 * Same shape as getClassResourcesFolder_ — throws a teacher-friendly
 * message when the property is unset or the ID is bad.
 */
// getStudentResourcesParentFolder_ opens the main Student Resources folder (the one that holds
// every student's personal folder), using the ID saved in the settings drawer. If the ID is
// missing or wrong, it stops with a message telling the teacher what to fix.
function getStudentResourcesParentFolder_() {
  // Look up the saved folder ID. If there isn't one, explain how to set it.
  var folderId = PropertiesService.getScriptProperties()
    .getProperty(STUDENT_RESOURCES_PARENT_FOLDER_ID_PROPERTY_KEY);
  if (!folderId) {
    throw new Error(
      'Student Resources parent folder is not configured. Set the "' +
      STUDENT_RESOURCES_PARENT_FOLDER_ID_PROPERTY_KEY +
      '" Script Property to the folder id from its Drive URL.'
    );
  }
  // Try to open the folder. If Google can't, pass along why.
  try {
    return DriveApp.getFolderById(folderId);
  } catch (err) {
    throw new Error(
      'Could not open Student Resources parent (id "' + folderId + '"): ' +
      (err && err.message ? err.message : String(err))
    );
  }
}

/**
 * Idempotent "make sure this student has a folder, with editor access".
 * Behaviour:
 *   1. If the email maps to a cached folder id (Script Properties) and
 *      that folder is still valid, reuse it — but rename it if the
 *      student's display name changed and re-grant editor access if
 *      needed.
 *   2. Otherwise create a fresh folder under the parent, grant editor
 *      access, cache the id, return.
 *
 * Returns { folder: <Folder>, created: <bool> }.
 *
 * Edits-in-place are intentionally minimal — we never touch existing
 * file contents, never lower a permission, and never delete a stale
 * folder (in case the teacher has work-in-progress in it).
 */
// ensureStudentFolder_ makes sure one student has their own Drive folder they can add files to.
// It is given the student's email and name. It gives back the folder and whether it was just
// created. It never deletes a folder and never takes away anyone's access.
function ensureStudentFolder_(email, name) {
  // An email is required to know whose folder this is.
  if (!email) throw new Error("ensureStudentFolder_ requires an email");

  // Serialize concurrent calls for the same student. Without this, two
  // POSTs (e.g. dashboard auto-load + bulk sync) racing for the same
  // never-seen-before email both miss the cache and call createFolder,
  // ending up with two duplicate per-student folders. 30s lock is well
  // above any normal create + permission grant.
  // In plain terms: take the lock so two requests can't make two folders for the same student.
  // If it stays busy for 30 seconds, ask the teacher to try again.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    throw new Error(
      "Another folder operation is in progress. Please retry in a moment."
    );
  }
  // Do the work while holding the lock, then always give the lock back.
  try {
    return ensureStudentFolderLocked_(email, name);
  } finally {
    lock.releaseLock();
  }
}

// ensureStudentFolderLocked_ does the real work of ensureStudentFolder_ while the lock is held.
// It first checks the settings drawer for a remembered folder ID; if there isn't a working one,
// it creates a new folder. Either way, it then makes sure the right people can edit it.
function ensureStudentFolderLocked_(email, name) {
  // Open the main Student Resources folder and look for this student's remembered folder ID.
  var parent = getStudentResourcesParentFolder_();
  var props = PropertiesService.getScriptProperties();
  var cacheKey = STUDENT_FOLDER_PROPERTY_PREFIX + email;
  var cachedId = props.getProperty(cacheKey);

  // If we have a remembered ID, try to open that folder. If it no longer works (for example, it
  // was deleted), forget the ID so a new folder is made below.
  var folder = null;
  if (cachedId) {
    try {
      folder = DriveApp.getFolderById(cachedId);
    } catch (err) {
      folder = null;
      props.deleteProperty(cacheKey);
    }
  }

  // No usable folder: make a new one named after the student, and remember its ID.
  var created = false;
  if (!folder) {
    folder = parent.createFolder(studentFolderName_(name, email));
    props.setProperty(cacheKey, folder.getId());
    created = true;
  } else {
    // Folder already exists: if the student's name has changed on the form, rename the folder.
    var desiredName = studentFolderName_(name, email);
    if (folder.getName() !== desiredName && name) {
      folder.setName(desiredName);
    }
  }

  // Make sure the student and the extra editors can add and change files in the folder.
  applyStudentFolderPermissions_(folder, email);
  return { folder: folder, created: created };
}

/**
 * Grants editor access to the student + every email in
 * STUDENT_RESOURCES_EXTRA_EDITORS, idempotently. Skips emails that
 * already have access at editor-or-above OR match the folder owner /
 * deployer. Per-email errors (invalid address, account not in
 * Google's directory yet, Drive transient) are LOGGED but do not
 * throw — otherwise one bad address would break the entire folder
 * listing for the teacher. The dashboard's "Sync student folders"
 * backfill button can re-try later.
 */
// applyStudentFolderPermissions_ gives the student, plus the extra editors from the settings,
// permission to add and change files in the student's folder. People who already have that
// access are left alone. If Google refuses an address, it's noted in the log and skipped.
function applyStudentFolderPermissions_(folder, studentEmail) {
  var normalizedStudent = String(studentEmail || "").trim().toLowerCase();

  // Find out who can already edit this folder.
  var existing = {};
  try {
    folder.getEditors().forEach(function (u) {
      var em = String(u.getEmail() || "").toLowerCase();
      if (em) existing[em] = true;
    });
  } catch (err) {
    // Some shared-drive edge cases — fall through to addEditor as source of truth.
  }

  // Skip the folder's owner and the account running this script; they already have access.
  var skip = {};
  try {
    var ownerEmail = String(folder.getOwner().getEmail() || "").toLowerCase();
    if (ownerEmail) skip[ownerEmail] = true;
  } catch (err) {
    // Shared-drive sub-folders may have no single owner. Falls through.
  }
  try {
    var selfEmail = String(Session.getEffectiveUser().getEmail() || "").toLowerCase();
    if (selfEmail) skip[selfEmail] = true;
  } catch (err) {
    // Session.getEffectiveUser is gated by scope on some accounts; safe to ignore.
  }

  // Build the list of people who should be editors: the student first, then the extras.
  var targets = [];
  if (normalizedStudent) targets.push(normalizedStudent);
  (STUDENT_RESOURCES_EXTRA_EDITORS || []).forEach(function (e) {
    var trimmed = String(e || "").trim().toLowerCase();
    if (trimmed) targets.push(trimmed);
  });

  // Add each person as an editor unless they are skipped or already have access.
  targets.forEach(function (em) {
    if (!em) return;
    if (skip[em]) return;
    if (existing[em]) return;
    try {
      folder.addEditor(em);
    } catch (err) {
      // Don't let one bad address take down the whole folder listing.
      // Most common cause is the email not being in Google's directory
      // yet (new student account, typo on the form, or a personal
      // Gmail with restricted sharing). Teacher can re-share manually
      // from Drive if needed.
      Logger.log(
        "applyStudentFolderPermissions_: addEditor(" + em + ") on folder " +
        folder.getId() + " failed: " + (err && err.message ? err.message : err)
      );
    }
  });
}

/**
 * "First Last — student@example.com" if both sides are non-empty;
 * "student@example.com" otherwise. Keeping the email visible in the
 * folder name makes it easy for the teacher to find a folder in Drive
 * directly when the cache is empty / mid-debugging.
 */
// studentFolderName_ decides what a student's folder is called: "Name - email" when the name is
// known, or just the email when it isn't. Keeping the email in the name makes folders easy to
// find in Drive.
function studentFolderName_(name, email) {
  var trimmed = String(name || "").trim();
  if (!trimmed) return String(email).trim();
  return trimmed + " - " + String(email).trim();
}

/**
 * Reads "Form Responses 1" and returns a map of email → name (the
 * latest non-empty name wins for a given email). Used by
 * `resolveStudentFromPayload_` for per-student lookups.
 */
// getStudentNameMap_ reads the form-answers tab and builds a lookup from each student's email to
// their name. If a student submitted the form more than once, the latest name is used.
// It gives back an empty lookup if the tab or the email column is missing.
function getStudentNameMap_() {
  // Open the form-answers tab and read everything on it.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Form Responses 1");
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  // Find the email column and the name column (titled "First and Last Name", or just "Name").
  var headers = data[0].map(function (h) {
    return String(h || "").trim().toLowerCase();
  });
  var emailCol = headers.indexOf("email address");
  var nameCol = headers.indexOf("first and last name");
  if (nameCol === -1) nameCol = headers.indexOf("name");
  if (emailCol === -1) return {};

  // Go down every row and record each email's name. A later row replaces an earlier one, and an
  // email with no name is still listed (with a blank name).
  var out = {};
  for (var r = 1; r < data.length; r++) {
    var em = String(data[r][emailCol] || "").trim().toLowerCase();
    if (!em) continue;
    var nm = nameCol === -1 ? "" : String(data[r][nameCol] || "").trim();
    if (nm) out[em] = nm; // later submissions overwrite earlier ones
    else if (!(em in out)) out[em] = "";
  }
  return out;
}

/**
 * Deduped roster as `[{ email, name }, ...]`. Used by the bulk
 * sync handler. Same source of truth as `getStudentEmails_` (Form
 * Responses 1); the name is best-effort and may be empty.
 */
// getStudentRoster_ gives back the list of students, each with an email and a name (the name
// may be blank). It combines the two helpers just above.
function getStudentRoster_() {
  var emails = getStudentEmails_();
  var nameByEmail = getStudentNameMap_();
  return emails.map(function (em) {
    return { email: em, name: nameByEmail[em] || "" };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Phase 5 — Teacher recaps
// ──────────────────────────────────────────────────────────────────────

// LESSON RECAPS: after each lesson the teacher writes a short structured summary for the
// student. These functions save and fetch those recaps in the "Lesson Recaps" tab.
/**
 * Returns the recap for one specific lesson, or `null` if none exists.
 * Read-only — never touches the schema. Lesson Recaps tab missing is
 * a clean null return rather than an error so the UI can render an
 * empty state without a server roundtrip first.
 */
// handleGetLessonRecap_ fetches the teacher's recap for one lesson, identified by the student's
// email, lesson date, and start time. It gives back the recap, or "none" if it hasn't been
// written yet. It only reads; it never changes the Sheet.
function handleGetLessonRecap_(payload) {
  // Read the three identifying details, then look for a matching recap row.
  var key = parseRecapKey_(payload);
  var existing = findRecapRow_(key);
  return {
    ok: true,
    recap: existing ? existing.recap : null
  };
}

/**
 * Upserts the recap for one lesson. Auto-creates the Lesson Recaps
 * tab + headers on first call so the teacher never has to set up the
 * sheet manually. `fields` is an object with up to four string keys:
 * greeting, todayWe, homework, nextClass. Missing fields default to
 * empty string. Updated At is set server-side (current time in the
 * spreadsheet's TZ).
 */
// handleSaveLessonRecap_ saves the teacher's recap for one lesson into the Lesson Recaps tab.
// The recap has four parts: the greeting, what we did today, the homework, and plans for next
// class. If a recap for that lesson already exists it is updated; otherwise a new row is added.
// It gives back the saved recap, including when it was saved. The real work happens in
// saveLessonRecapLocked_, just below.
function handleSaveLessonRecap_(payload) {
  // Serialize concurrent saves, the same way handleCreateEvent_ does. Without this, two saves
  // for a lesson that has no recap yet (a double-click, or two browser tabs) could both miss
  // the existing-row lookup below and each append a new row, leaving duplicate recaps.
  // In plain terms: take the "lock" (the single key to the room) so only one recap save
  // happens at a time. If someone else holds it for 30 seconds, give up and ask to try again.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    throw new Error(
      "Another save is in progress for this studio. Please try again in a moment."
    );
  }
  // Save while holding the lock, and always hand the key back afterward, even if something
  // went wrong.
  try {
    return saveLessonRecapLocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

// saveLessonRecapLocked_ does the actual saving, and only runs while the lock above is held.
// It finds the lesson's existing recap row (or adds a new one at the bottom) and writes the
// four recap parts into it.
function saveLessonRecapLocked_(payload) {
  // Read which lesson this is for and the four parts the teacher wrote. Missing parts are blank.
  var key = parseRecapKey_(payload);
  var fields = (payload && payload.fields) || {};

  var greeting = String(fields.greeting || "");
  var todayWe = String(fields.todayWe || "");
  var homework = String(fields.homework || "");
  var nextClass = String(fields.nextClass || "");

  // Pull the student's display name from the roster when available so
  // recaps stay readable even if the original lesson row only had an
  // email. We take "best name we know now"; if the form hasn't been
  // submitted yet the column stays blank, which is fine.
  var nameByEmail = getStudentNameMap_();
  var studentName = nameByEmail[key.studentEmail] || "";

  // Open the Lesson Recaps tab (creating it the first time) and find each column by its title.
  // The "+ 1" converts to the Sheet's column numbers, which start at 1.
  var sheet = ensureRecapsSheet_();
  var headers = recapHeaders_(sheet);
  var emailCol = headerIndex_(headers, "Student Email") + 1;
  var nameCol = headerIndex_(headers, "Student Name") + 1;
  var dateCol = headerIndex_(headers, "Lesson Date") + 1;
  var startCol = headerIndex_(headers, "Start Time") + 1;
  var greetingCol = headerIndex_(headers, "Greeting") + 1;
  var todayCol = headerIndex_(headers, "Today We") + 1;
  var homeworkCol = headerIndex_(headers, "Homework") + 1;
  var nextCol = headerIndex_(headers, "Next Class") + 1;
  var updatedCol = headerIndex_(headers, "Updated At") + 1;

  // Note the current date and time in the spreadsheet's time zone, as the "Updated At" stamp.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();
  var nowIso = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");

  // If a recap for this lesson already exists, reuse its row. If not, start a new row at the
  // bottom and fill in which student and lesson it belongs to.
  var existing = findRecapRow_(key);
  var rowIndex;
  if (existing) {
    rowIndex = existing.rowIndex;
  } else {
    rowIndex = sheet.getLastRow() + 1;
    sheet.getRange(rowIndex, emailCol).setValue(key.studentEmail);
    sheet.getRange(rowIndex, dateCol).setValue(key.lessonDate);
    sheet.getRange(rowIndex, startCol).setValue(key.startTime);
  }

  // Always refresh the display name from the roster on save — keeps it
  // consistent if a student renamed themselves on the form.
  if (studentName) sheet.getRange(rowIndex, nameCol).setValue(studentName);
  // Write the four recap parts and the time it was saved, then save the Sheet right away.
  sheet.getRange(rowIndex, greetingCol).setValue(greeting);
  sheet.getRange(rowIndex, todayCol).setValue(todayWe);
  sheet.getRange(rowIndex, homeworkCol).setValue(homework);
  sheet.getRange(rowIndex, nextCol).setValue(nextClass);
  sheet.getRange(rowIndex, updatedCol).setValue(nowIso);
  SpreadsheetApp.flush();

  // Send the saved recap back so the website can show it right away.
  return {
    ok: true,
    recap: {
      studentEmail: key.studentEmail,
      studentName: studentName,
      lessonDate: key.lessonDate,
      startTime: key.startTime,
      greeting: greeting,
      todayWe: todayWe,
      homework: homework,
      nextClass: nextClass,
      updatedAt: nowIso
    }
  };
}

/**
 * Returns every recap for one student, sorted by lesson date desc
 * then start time desc (newest first). `[]` when the tab is missing
 * or the student has no recaps yet.
 */
// handleListRecapsForStudent_ gives back every recap for one student, newest lesson first.
// It gives back an empty list if there are none yet.
function handleListRecapsForStudent_(payload) {
  // Tidy the student's email and stop if it's missing.
  var email = String((payload && payload.studentEmail) || "")
    .trim()
    .toLowerCase();
  if (!email) throw new Error("Missing studentEmail");

  // Read all recaps, keep only this student's, and sort them newest first.
  var recaps = readAllRecaps_().filter(function (r) {
    return String(r.studentEmail).toLowerCase() === email;
  });
  recaps.sort(compareRecapsNewestFirst_);
  return { ok: true, recaps: recaps };
}

/**
 * Returns every recap in the system, sorted newest first. Used by
 * the Recaps tab page on the website.
 */
// handleListRecaps_ gives back every recap for every student, newest lesson first. It feeds the
// Recaps page on the website.
function handleListRecaps_(payload) {
  var recaps = readAllRecaps_();
  recaps.sort(compareRecapsNewestFirst_);
  return { ok: true, recaps: recaps };
}

// ──────────────────────────────────────────────────────────────────────
// Phase 5 — helpers
// ──────────────────────────────────────────────────────────────────────

// parseRecapKey_ pulls the three details that identify a lesson (student email, lesson date,
// start time) out of the website's request. It stops with an error if any is missing.
function parseRecapKey_(payload) {
  var studentEmail = String((payload && payload.studentEmail) || "")
    .trim()
    .toLowerCase();
  var lessonDate = String((payload && payload.lessonDate) || "").trim();
  var startTime = String((payload && payload.startTime) || "").trim();
  if (!studentEmail) throw new Error("Missing studentEmail");
  if (!lessonDate) throw new Error("Missing lessonDate");
  if (!startTime) throw new Error("Missing startTime");
  return { studentEmail: studentEmail, lessonDate: lessonDate, startTime: startTime };
}

/**
 * Returns the Lesson Recaps sheet, creating it (with the canonical
 * header row) if it doesn't exist. Idempotent. Existing tabs with
 * a different column order are left alone — we look up columns by
 * header name, not position.
 */
// ensureRecapsSheet_ opens the Lesson Recaps tab, creating it with its column titles the first
// time a recap is saved. It gives back the tab.
function ensureRecapsSheet_() {
  // Look for the tab.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LESSON_RECAPS_SHEET_NAME);
  var freshlyCreated = false;
  if (!sheet) {
    // Not there: create it, write the column titles in bold, and keep the title row pinned at the
    // top while scrolling ("frozen").
    sheet = ss.insertSheet(LESSON_RECAPS_SHEET_NAME);
    sheet.getRange(1, 1, 1, LESSON_RECAPS_HEADERS.length)
      .setValues([LESSON_RECAPS_HEADERS])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
    freshlyCreated = true;
  } else if (sheet.getLastRow() === 0) {
    // The tab exists but is completely empty: write the column titles the same way.
    sheet.getRange(1, 1, 1, LESSON_RECAPS_HEADERS.length)
      .setValues([LESSON_RECAPS_HEADERS])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
    freshlyCreated = true;
  }
  // If we just set it up, apply the studio's colors. A styling problem never blocks saving.
  if (freshlyCreated) {
    try {
      formatLessonRecapsSheet_(sheet);
    } catch (err) {
      Logger.log("formatLessonRecapsSheet_ failed: " + err);
    }
  }
  return sheet;
}

/**
 * Returns the header row of the Lesson Recaps tab. Auto-appends any
 * headers from LESSON_RECAPS_HEADERS that are missing (so older
 * sheets created before a new column was added still work).
 */
// recapHeaders_ reads the Lesson Recaps tab's column titles. If an expected title is missing
// (for example, a column added in a later version), it adds it at the end. Gives back the titles.
function recapHeaders_(sheet) {
  // Read the title row and note which titles are present.
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existing = {};
  headers.forEach(function (h) { existing[String(h).trim()] = true; });
  // Work out which expected titles are missing, and add them to the right of the existing ones.
  var missing = LESSON_RECAPS_HEADERS.filter(function (h) { return !existing[h]; });
  if (missing.length > 0) {
    var startCol = lastCol + 1;
    sheet.getRange(1, startCol, 1, missing.length)
      .setValues([missing])
      .setFontWeight("bold");
    headers = headers.concat(missing);
  }
  return headers;
}

/**
 * Looks up one recap row by composite key. Returns
 * `{ rowIndex, recap }` (1-indexed) or `null` when no match. Returns
 * `null` (not throws) when the tab doesn't exist, which is the
 * pre-first-save state.
 */
// findRecapRow_ searches the Lesson Recaps tab for the recap of one lesson (matching email, date,
// and start time). It gives back the row number and the recap, or nothing if there isn't one.
function findRecapRow_(key) {
  // Open the tab and read it. No tab, or no rows below the titles, means no recap yet.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LESSON_RECAPS_SHEET_NAME);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;

  // Find the three identifying columns by title. If any is missing, there's nothing to match.
  var headers = data[0];
  var emailCol = headerIndex_(headers, "Student Email");
  var dateCol = headerIndex_(headers, "Lesson Date");
  var startCol = headerIndex_(headers, "Start Time");
  if (emailCol === -1 || dateCol === -1 || startCol === -1) return null;

  // Go down each row and stop at the first one where the email, date, and start time all match.
  var ssTz = ss.getSpreadsheetTimeZone();
  for (var r = 1; r < data.length; r++) {
    var rowEmail = String(data[r][emailCol] || "").trim().toLowerCase();
    if (rowEmail !== key.studentEmail) continue;
    var rowDate = normalizeSheetDate_(data[r][dateCol], ssTz);
    if (rowDate !== key.lessonDate) continue;
    var rowStart = normalizeSheetTime_(data[r][startCol], ssTz);
    if (rowStart !== key.startTime) continue;
    return {
      rowIndex: r + 1,
      recap: recapRowToObject_(headers, data[r], ssTz)
    };
  }
  return null;
}

/**
 * Reads every recap from the Lesson Recaps tab into a plain JS array.
 * Returns `[]` when the tab is missing — which is normal until the
 * teacher saves their first recap.
 */
// readAllRecaps_ reads every recap in the Lesson Recaps tab into a list, skipping blank rows.
// It gives back an empty list if the tab doesn't exist yet.
function readAllRecaps_() {
  // Open the tab and read it. No tab, or no rows below the titles, means an empty list.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LESSON_RECAPS_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  // Turn each row that has a student email into a recap record.
  var headers = data[0];
  var ssTz = ss.getSpreadsheetTimeZone();
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var email = String(row[headerIndex_(headers, "Student Email")] || "").trim();
    if (!email) continue; // skip blank rows
    out.push(recapRowToObject_(headers, row, ssTz));
  }
  return out;
}

// recapRowToObject_ turns one row of the Lesson Recaps tab into a labeled recap record the
// website understands, with dates and times written the same way everywhere.
function recapRowToObject_(headers, row, ssTz) {
  // A small helper: given a column title, fetch this row's value in that column (blank if the
  // column doesn't exist).
  function pick(name) {
    var idx = headerIndex_(headers, name);
    return idx === -1 ? "" : row[idx];
  }
  // Read the date, the start time, and the "last saved" time, and put each in a standard form.
  var dateRaw = pick("Lesson Date");
  var startRaw = pick("Start Time");
  var updatedRaw = pick("Updated At");

  var lessonDate = normalizeSheetDate_(dateRaw, ssTz);
  var startTime = normalizeSheetTime_(startRaw, ssTz);
  var updatedAt;
  if (updatedRaw instanceof Date) {
    updatedAt = updatedRaw.toISOString();
  } else {
    updatedAt = String(updatedRaw || "").trim();
  }

  // Assemble the finished recap record.
  return {
    studentEmail: String(pick("Student Email") || "").trim().toLowerCase(),
    studentName: String(pick("Student Name") || "").trim(),
    lessonDate: lessonDate,
    startTime: startTime,
    greeting: String(pick("Greeting") || ""),
    todayWe: String(pick("Today We") || ""),
    homework: String(pick("Homework") || ""),
    nextClass: String(pick("Next Class") || ""),
    updatedAt: updatedAt
  };
}

/** Sort comparator: newer lesson first; if same date, later start first. */
// compareRecapsNewestFirst_ decides the order of two recaps when sorting: the later lesson date
// comes first, and on the same day the later start time comes first.
function compareRecapsNewestFirst_(a, b) {
  // Compare dates first. Year-month-day text sorts in date order, so a simple comparison works.
  if (a.lessonDate < b.lessonDate) return 1;
  if (a.lessonDate > b.lessonDate) return -1;
  // Same date — compare start times. Wall-clock strings sort poorly;
  // compare via Date objects parsed with parseWallClockTime_.
  // Turn each start time into minutes after midnight, so "2:00 PM" correctly beats "9:00 AM".
  var ah = parseWallClockTime_(a.startTime) || { h: 0, m: 0 };
  var bh = parseWallClockTime_(b.startTime) || { h: 0, m: 0 };
  var aMin = ah.h * 60 + ah.m;
  var bMin = bh.h * 60 + bh.m;
  return bMin - aMin;
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — Time sheet
// ──────────────────────────────────────────────────────────────────────

// TIME SHEET: Mr. O'Neal is paid per private lesson, and he logs every lesson in a payroll time
// sheet (a separate Google Sheet that the music director signs off and the business office pays
// from). These functions add each lesson he teaches to that time sheet, so he never types it
// twice. The rules they always follow:
//   - Append only. A new row goes directly below the last used row of the school-year tab.
//     Existing time sheet rows are never edited or deleted.
//   - Only columns A to G are written. H (signature) and I (pay date) are never touched.
//   - The CHAPEL/MISC. tabs are never touched, and the lookup tabs are only read.
//   - A lesson is offered only if it is dated on or after TIMESHEET_START_DATE.
// After a lesson is added (or skipped), the Lesson Schedule's "Time Sheet" column says so.

// The message shown whenever the script can't open the time sheet. Google gives the same kind
// of error for a wrong ID and for a sheet that isn't shared, so the message covers both.
var TIMESHEET_CANT_OPEN_MESSAGE =
  "The script can't open the time sheet. Check the TIMESHEET_SPREADSHEET_ID Script Property, " +
  "and share the time sheet as Editor with the Google account the web app runs as.";

/**
 * timesheet-status. Never throws for a setup problem; it answers
 * { configured: false, reason } instead so the dashboard can say "not connected yet".
 */
// handleTimesheetStatus_ tells the website whether the time sheet is connected. If it is, it also
// sends the sheet's link and title, the tab today's lessons go to, the start date, and the
// choices in each dropdown list. If not, it says which setting is the problem, in plain words.
function handleTimesheetStatus_(payload) {
  // Start with a "not connected" answer and fill it in as each check passes.
  var config = readTimesheetConfig_();
  var answer = {
    ok: true,
    configured: false,
    sheetUrl: null,
    sheetTitle: null,
    targetTab: null,
    startDate: config.startDate,
    codeVersion: CODE_VERSION,
    lists: { lessonNo: [], block: [], hours: [], instrument: [] }
  };
  if (!config.ok) {
    answer.reason = config.reason;
    return answer;
  }

  // Both settings are there; now try to open the time sheet itself.
  var ts;
  try {
    ts = SpreadsheetApp.openById(config.id);
  } catch (err) {
    answer.reason = TIMESHEET_CANT_OPEN_MESSAGE + googleSaid_(err);
    return answer;
  }

  // Connected. Work out today's school-year tab (in the time sheet's own time zone) and read
  // the dropdown lists from the lookup tabs.
  var tz = ts.getSpreadsheetTimeZone();
  var targetTab = schoolYearTabName_(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
  answer.configured = true;
  answer.sheetUrl = ts.getUrl();
  answer.sheetTitle = ts.getName();
  answer.targetTab = targetTab;
  answer.targetTabExists = findYearTab_(ts, targetTab) !== null;
  answer.lists = readTimesheetLists_(ts).values;
  return answer;
}

// handlePreviewTimesheetRow_ shows exactly which row WOULD be added to the time sheet for one
// lesson (student email, lesson date, start time), without changing anything. It also says which
// tab the row goes to, whether that tab would be created, whether a term label row would be added
// above it, and plain-English warnings for anything the teacher should check first.
function handlePreviewTimesheetRow_(payload) {
  var ctx = loadTimesheetLesson_(payload);
  var plan = planTimesheetRow_(ctx, readTimesheetOverrides_(payload));
  return {
    ok: true,
    tab: plan.tab,
    createsTab: plan.createsTab,
    insertBefore: plan.insertBefore,
    termLabel: plan.termLabel,
    addsTermLabel: plan.addsTermLabel,
    row: plan.cells,
    fields: plan.fields,
    duplicate: plan.duplicate,
    warnings: plan.warnings,
    lists: plan.lists,
    mark: plan.mark,
    lesson: plan.lesson,
    sheetUrl: ctx.ts.getUrl(),
    sheetTitle: ctx.ts.getName()
  };
}

// handleAddTimesheetRow_ adds one lesson to the time sheet and notes it on the Lesson Schedule.
// It takes the same lock as the other changes, so two clicks (or two browser tabs) can't add
// the same lesson twice. The real work happens in addTimesheetRowLocked_, just below.
function handleAddTimesheetRow_(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    throw new Error(
      "Another change is in progress for this studio. Please try again in a moment."
    );
  }
  try {
    return addTimesheetRowLocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

// addTimesheetRowLocked_ does the adding, only while the lock is held, in this order:
//   1. check (again, with a fresh read) whether the lesson is already on the tab,
//   2. append the row,
//   3. write "Added <date>" in the lesson's Time Sheet cell on the Lesson Schedule.
// If the lesson is already on the tab, nothing is appended; only the note is written. That makes
// a retry safe after a call that added the row but failed before writing the note.
function addTimesheetRowLocked_(payload) {
  var ctx = loadTimesheetLesson_(payload);
  if (isSkippedMark_(ctx.mark)) {
    throw new Error(
      'This lesson is marked "Skipped" on the Lesson Schedule. To add it after all, clear its ' +
      "Time Sheet cell there, then try again."
    );
  }
  var plan = planTimesheetRow_(ctx, readTimesheetOverrides_(payload));

  // Step 1: already on the tab? Then don't add a second row; just write the note.
  if (plan.duplicate) {
    var existingMark = isAddedMark_(ctx.mark) ? ctx.mark : addedMarkText_(ctx.studioTz);
    if (!isAddedMark_(ctx.mark)) {
      writeTimesheetMark_(ctx.found, existingMark, plan.tab, plan.duplicate.rowNumber);
    }
    return {
      ok: true,
      alreadyThere: true,
      tab: plan.tab,
      rowNumber: plan.duplicate.rowNumber,
      row: plan.duplicate.cells,
      createdTab: false,
      labelRowNumber: null,
      mark: existingMark
    };
  }

  // The Lesson Schedule says it was added, but no matching row is on the tab. Rather than guess,
  // stop: someone may have deleted the row, or the name may be spelled differently there.
  if (isAddedMark_(ctx.mark)) {
    throw new Error(
      'This lesson is already marked "' + ctx.mark + '" on the Lesson Schedule, but no row for ' +
      "it was found on " + plan.tab + " (it may have been deleted, or the name may be spelled " +
      "differently). To add it again, clear its Time Sheet cell on the Lesson Schedule first."
    );
  }

  // Step 2: append the row (with a term label row above it when this starts a new term).
  var appended = appendTimesheetRow_(ctx, plan);

  // Step 3: note it on the Lesson Schedule, so it leaves the dashboard's list.
  var mark = addedMarkText_(ctx.studioTz);
  writeTimesheetMark_(ctx.found, mark, plan.tab, appended.rowNumber);
  return {
    ok: true,
    alreadyThere: false,
    tab: plan.tab,
    rowNumber: appended.rowNumber,
    row: plan.cells,
    createdTab: appended.createdTab,
    labelRowNumber: appended.labelRowNumber,
    mark: mark,
    warnings: plan.warnings
  };
}

// handleSkipTimesheetRow_ marks one lesson "Skipped" on the Lesson Schedule: it didn't happen, or
// it's already on the time sheet. It never opens or changes the time sheet.
function handleSkipTimesheetRow_(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    throw new Error(
      "Another change is in progress for this studio. Please try again in a moment."
    );
  }
  try {
    requireLessonKey_(payload);
    var found = findLessonRowFromPayload_(payload);
    var mark = String(found.row[TIME_SHEET_COLUMN] || "").trim();
    // A lesson that is already on the time sheet keeps its "Added" note.
    if (isAddedMark_(mark)) {
      throw new Error('This lesson is already marked "' + mark + '", so there is nothing to skip.');
    }
    if (!isSkippedMark_(mark)) writeTimesheetMark_(found, "Skipped", null, null);
    return { ok: true, skipped: true, mark: "Skipped" };
  } finally {
    lock.releaseLock();
  }
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — settings and the lesson being logged
// ──────────────────────────────────────────────────────────────────────

// readTimesheetConfig_ reads the two time sheet settings from the settings drawer (Script
// Properties). It gives back { ok, id, startDate } when both are usable, or { ok: false, reason }
// naming what's wrong in plain words. startDate is included whenever it is a real date.
function readTimesheetConfig_() {
  var props = PropertiesService.getScriptProperties();
  var rawId = String(props.getProperty(TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY) || "").trim();
  var rawStart = String(props.getProperty(TIMESHEET_START_DATE_PROPERTY_KEY) || "").trim();
  var startDate = isValidDateKey_(rawStart) ? rawStart : null;

  // Collect every problem, so one message covers them all.
  var problems = [];
  if (!rawId) {
    problems.push("the " + TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + " Script Property isn't set");
  } else if (!spreadsheetIdFromSetting_(rawId)) {
    problems.push(TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + " doesn't look like a Google Sheets ID or link");
  }
  if (!rawStart) {
    problems.push("the " + TIMESHEET_START_DATE_PROPERTY_KEY + " Script Property isn't set");
  } else if (!startDate) {
    problems.push(
      TIMESHEET_START_DATE_PROPERTY_KEY + ' should be a date written like 2026-10-05, not "' +
      rawStart + '"'
    );
  }
  if (problems.length > 0) {
    var reason = problems.join(", and ") + ".";
    return { ok: false, reason: reason.charAt(0).toUpperCase() + reason.substring(1), startDate: startDate };
  }
  return { ok: true, id: spreadsheetIdFromSetting_(rawId), startDate: startDate };
}

// spreadsheetIdFromSetting_ accepts either a bare spreadsheet ID or a whole Google Sheets web
// address, and gives back just the ID (the part between "/d/" and the next "/"). It gives back ""
// if the text doesn't look like an ID.
function spreadsheetIdFromSetting_(raw) {
  var text = String(raw || "").trim();
  var marker = text.indexOf("/d/");
  if (marker !== -1) {
    // Keep what follows "/d/", up to the next "/" (or "?" or "#", in case the address ends there).
    text = text.substring(marker + 3).split(/[\/?#]/)[0];
  }
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : "";
}

// openTimesheet_ opens the time sheet by its ID, or stops with a plain-English message.
function openTimesheet_(id) {
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(TIMESHEET_CANT_OPEN_MESSAGE + googleSaid_(err));
  }
}

// googleSaid_ turns Google's own error words into a short ending for a plain-English message, like
// " (Google said: You do not have permission to access the requested document.)".
function googleSaid_(err) {
  var raw = String(err && err.message ? err.message : err).replace(/^Exception:\s*/, "").trim();
  return raw ? " (Google said: " + raw + ")" : "";
}

// requireLessonKey_ checks the request names a lesson (student email, lesson date, start time) and
// stops with a plain-English message if a piece is missing.
function requireLessonKey_(payload) {
  if (!String((payload && payload.studentEmail) || "").trim() ||
      !String((payload && payload.lessonDate) || "").trim()) {
    throw new Error("The request didn't say which lesson (a student email and a lesson date are needed).");
  }
  if (!String((payload && payload.startTime) || "").trim()) {
    throw new Error(
      "This lesson has no Start Time on the Lesson Schedule. Add one there, refresh the page, " +
      "and try again."
    );
  }
}

// loadTimesheetLesson_ gathers what is needed to plan a time sheet row for one lesson: the two
// settings, the lesson's row on the Lesson Schedule, and the opened time sheet. It stops with a
// plain-English message if the time sheet isn't connected, or if the lesson can't be offered
// (dated before TIMESHEET_START_DATE, not happened yet, or cancelled).
function loadTimesheetLesson_(payload) {
  requireLessonKey_(payload);
  var config = readTimesheetConfig_();
  if (!config.ok) {
    throw new Error("The time sheet isn't connected yet. " + config.reason);
  }

  // Find the lesson on the Lesson Schedule and read its date as year-month-day, using the studio
  // spreadsheet's own time zone.
  var found = findLessonRowFromPayload_(payload);
  var studioTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var lessonDateKey = dateKeyFromLessonCell_(found.row["Lesson Date"], studioTz);
  if (!lessonDateKey) {
    throw new Error(
      'Can\'t read this lesson\'s date on the Lesson Schedule ("' + found.row["Lesson Date"] + '").'
    );
  }

  // Lessons before the start date were typed into the time sheet by hand: never offer them.
  if (lessonDateKey < config.startDate) {
    throw new Error(
      "This lesson (" + displayDateFromKey_(lessonDateKey) + ") is dated before " +
      TIMESHEET_START_DATE_PROPERTY_KEY + " (" + displayDateFromKey_(config.startDate) + "). " +
      "Lessons before that date were typed into the time sheet by hand, so the tool doesn't offer them."
    );
  }
  // A lesson that hasn't happened yet can't be paid for yet.
  var todayKey = Utilities.formatDate(new Date(), studioTz, "yyyy-MM-dd");
  if (lessonDateKey > todayKey) {
    throw new Error(
      "This lesson (" + displayDateFromKey_(lessonDateKey) + ") hasn't happened yet, so it can't " +
      "go on the time sheet."
    );
  }
  // Cancelled lessons are left off the time sheet.
  var status = String(found.row["Status"] || "").trim().toLowerCase();
  if (status === "cancelled" || status === "canceled") {
    throw new Error("This lesson is marked Cancelled on the Lesson Schedule, so it isn't added to the time sheet.");
  }

  var ts = openTimesheet_(config.id);
  return {
    config: config,
    found: found,
    studioTz: studioTz,
    lessonDateKey: lessonDateKey,
    ts: ts,
    tsTz: ts.getSpreadsheetTimeZone(),
    mark: String(found.row[TIME_SHEET_COLUMN] || "").trim()
  };
}

// readTimesheetOverrides_ reads the values the teacher changed in the preview window (lesson
// number, first and last name, block, hours, subject). A value that wasn't sent is left out, so
// the script works it out itself; an empty value means "leave this cell blank".
function readTimesheetOverrides_(payload) {
  var raw = payload && payload.overrides;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("overrides must be an object");
  }
  var out = {};
  ["lessonNo", "firstName", "lastName", "block", "hours", "subject"].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined && raw[key] !== null) {
      out[key] = raw[key];
    }
  });
  return out;
}

// hasOverride_ says whether the teacher sent a value for one field (see readTimesheetOverrides_).
function hasOverride_(overrides, key) {
  return Object.prototype.hasOwnProperty.call(overrides, key);
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — planning the row
// ──────────────────────────────────────────────────────────────────────

/**
 * Builds the A-G row for one lesson plus everything the preview shows. Used by both
 * preview-timesheet-row and add-timesheet-row, so what the teacher previews is what gets written.
 */
// planTimesheetRow_ works out the row for one lesson: which tab, the seven values for columns A to
// G, whether a term label row goes above it, whether the lesson is already on the tab, and a list
// of plain-English warnings. Values the teacher changed in the preview window win over the
// script's own suggestions.
function planTimesheetRow_(ctx, overrides) {
  var row = ctx.found.row;
  var warnings = [];
  // Short notes like "Total Hours 1.5", reused in the error message if Google refuses the row.
  var notOnList = [];

  // The dropdown choices, read fresh from the lookup tabs.
  var lists = readTimesheetLists_(ctx.ts);
  lists.missingTabs.forEach(function (tabName) {
    warnings.push(
      'The time sheet has no "' + tabName + '" tab, so that column can\'t be checked against its dropdown list.'
    );
  });

  // Which school-year tab and which term the lesson belongs to.
  var tabName = schoolYearTabName_(ctx.lessonDateKey);
  var term = termFor_(ctx.lessonDateKey);
  var tab = findYearTab_(ctx.ts, tabName);
  var newest = tab ? null : newestYearTab_(ctx.ts);
  var tabRows = tab ? readYearTabRows_(tab, ctx.tsTz) : [];
  if (!tab && !newest) {
    warnings.push(
      "The time sheet has no school-year tab (like 2025-2026) to copy, so the tool can't create " +
      tabName + ". Add that tab by hand first."
    );
  }

  // Columns C and D: first and last name. The sign-up form's name wins; the Lesson Schedule's
  // Student Name is the backup. The name is split at its first space.
  var email = String(row["Student Email"] || "").trim().toLowerCase();
  var fullName = getStudentNameMap_()[email] || String(row["Student Name"] || "").trim();
  var names = splitStudentName_(fullName);
  var namesTyped = hasOverride_(overrides, "firstName") || hasOverride_(overrides, "lastName");
  var firstName = hasOverride_(overrides, "firstName")
    ? cleanCellText_(String(overrides.firstName), "First name")
    : names.first;
  var lastName = hasOverride_(overrides, "lastName")
    ? cleanCellText_(String(overrides.lastName), "Last name")
    : names.last;
  if (!namesTyped && names.warning) warnings.push(names.warning);

  // Column F: total hours, from how long the lesson is (90 minutes is a double).
  var minutes = lessonMinutes_(row, ctx.studioTz);
  var hours;
  if (hasOverride_(overrides, "hours")) {
    hours = listValueOrRaw_(lists.values.hours, overrides.hours, "Total Hours");
  } else {
    var ninetyMinutes = minutes === TIMESHEET_DOUBLE_MINUTES;
    hours = listValueOrRaw_(
      lists.values.hours,
      ninetyMinutes ? TIMESHEET_DOUBLE_HOURS : TIMESHEET_REGULAR_HOURS,
      "Total Hours"
    );
    if (minutes === null) {
      warnings.push(
        "This lesson has no end time on the Lesson Schedule, so it's counted as a regular " +
        "lesson (0.75 hours)."
      );
    } else if (!ninetyMinutes && minutes !== 45) {
      warnings.push(
        "This lesson is " + minutes + " minutes long. The time sheet uses 0.75 for a regular " +
        "lesson and 1.5 for a double (90 minutes), so 0.75 is filled in. Check the hours."
      );
    }
  }
  var isDouble = sameListValue_(hours, TIMESHEET_DOUBLE_HOURS);

  // Column B: the lesson number, counted per student, per term, the way the time sheet does.
  var count = countStudentLessons_(tabRows, term, firstName, lastName);
  var lessonNo;
  if (hasOverride_(overrides, "lessonNo")) {
    lessonNo = listValueOrRaw_(lists.values.lessonNo, overrides.lessonNo, "Lesson No.");
  } else if (isDouble) {
    lessonNo = listValueOrRaw_(lists.values.lessonNo, "Double", "Lesson No.");
  } else {
    var next = count.running + 1;
    var highest = highestNumberOnList_(lists.values.lessonNo) || 9;
    var onList = findListItem_(lists.values.lessonNo, next);
    if (next > highest || (!onList.found && lists.values.lessonNo.length > 0)) {
      // Past the end of the list: don't guess, let the teacher pick.
      lessonNo = "";
      warnings.push(
        "By the time sheet's count this would be lesson " + next + ", but the Lesson No. list " +
        "stops at " + highest + ". Pick the lesson number."
      );
    } else {
      lessonNo = onList.found ? onList.value : next;
    }
  }
  if (count.prior === 0) {
    warnings.push(
      sameListValue_(lessonNo, 1)
        ? "No earlier lessons for this student this term, so this is lesson 1. If that's wrong, " +
          "the name may be spelled differently on the time sheet."
        : "No earlier lessons for this student this term. If that's wrong, the name may be " +
          "spelled differently on the time sheet."
    );
  }

  // Column E: the block. "C Block" on the Lesson Schedule becomes "C" on the time sheet.
  var block;
  if (hasOverride_(overrides, "block")) {
    block = listValueOrRaw_(lists.values.block, overrides.block, "Block");
  } else {
    var mappedBlock = mapBlockToList_(row["Lesson Block"], lists.values.block);
    block = mappedBlock.value;
    if (mappedBlock.warning) warnings.push(mappedBlock.warning);
  }

  // Column G: the music subject, from the instrument on the student's latest sign-up form.
  var subject;
  if (hasOverride_(overrides, "subject")) {
    subject = listValueOrRaw_(lists.values.instrument, overrides.subject, "Music Subject");
  } else {
    var mappedSubject = mapInstrumentToList_(formInstrumentAnswer_(email), lists.values.instrument);
    subject = mappedSubject.value;
    if (mappedSubject.warning) warnings.push(mappedSubject.warning);
  }

  // Check every dropdown value against its list, so nothing surprising reaches the time sheet.
  checkOnList_("Lesson No.", lessonNo, lists.values.lessonNo, warnings, notOnList);
  checkOnList_("Block", block, lists.values.block, warnings, notOnList);
  if (hours !== "" && lists.values.hours.length > 0 && !findListItem_(lists.values.hours, hours).found) {
    notOnList.push("Total Hours " + hours);
    warnings.push(
      isDouble
        ? "1.5 isn't on the time sheet's hours list. Doubles are written as 1.5 anyway; if the " +
          "hours dropdown is set to reject other values, Google may refuse the row, and you'll " +
          "see why here."
        : 'Total Hours "' + hours + "\" isn't on the time sheet's hours list."
    );
  }
  checkOnList_("Music Subject", subject, lists.values.instrument, warnings, notOnList);

  // If columns C and D use Mr. O'Neal's First Name / Last Name lists as dropdowns, a new
  // student won't be on them yet. That's only a warning; it never blocks adding.
  if (tab) {
    nameListWarnings_(tab, tabRows, firstName, lastName).forEach(function (w) {
      warnings.push(w.message);
      notOnList.push(w.note);
    });
  }

  // Is this lesson already on the tab (same date, same student)? Then nothing will be appended.
  var duplicateRow = findDuplicateRow_(tabRows, ctx.lessonDateKey, firstName, lastName);
  var duplicate = null;
  if (duplicateRow) {
    duplicate = { rowNumber: duplicateRow.rowNumber, cells: displayCells_(duplicateRow.cells, ctx.tsTz) };
    warnings.unshift(
      "This lesson is already on " + tabName + " (row " + duplicateRow.rowNumber + "). Adding " +
      "won't create a second row; it only marks the lesson as added."
    );
  }

  var fields = {
    lessonNo: lessonNo,
    firstName: firstName,
    lastName: lastName,
    block: block,
    hours: hours,
    subject: subject
  };
  return {
    tab: tabName,
    createsTab: !tab,
    insertBefore: newest ? String(newest.getName()) : null,
    term: term,
    termLabel: term.label,
    addsTermLabel: !duplicate && needsTermLabel_(tabRows, term),
    lessonDateKey: ctx.lessonDateKey,
    fields: fields,
    cells: [displayDateFromKey_(ctx.lessonDateKey), lessonNo, firstName, lastName, block, hours, subject],
    duplicate: duplicate,
    warnings: warnings,
    notOnList: notOnList,
    lists: lists.values,
    mark: ctx.mark,
    lesson: {
      studentEmail: email,
      studentName: fullName,
      lessonDate: ctx.lessonDateKey,
      startTime: clockText_(row["Start Time"], ctx.studioTz),
      endTime: clockText_(row["End Time"], ctx.studioTz),
      lessonBlock: String(row["Lesson Block"] || "").trim(),
      minutes: minutes
    }
  };
}

// checkOnList_ adds a warning when a filled-in dropdown value isn't one of its list's choices.
function checkOnList_(label, value, list, warnings, notOnList) {
  if (value === "" || list.length === 0) return;
  if (findListItem_(list, value).found) return;
  notOnList.push(label + " " + value);
  warnings.push(label + ' "' + value + "\" isn't on the time sheet's " + label + " list.");
}

// splitStudentName_ splits a full name at its first space into a first and last name, with a
// warning when the name isn't exactly two words (or is missing).
function splitStudentName_(fullName) {
  var clean = String(fullName || "").trim().replace(/\s+/g, " ");
  if (!clean) {
    return {
      first: "",
      last: "",
      warning: "No name was found for this student on the sign-up form or the Lesson Schedule. " +
        "Type the first and last name."
    };
  }
  var space = clean.indexOf(" ");
  if (space === -1) {
    return {
      first: clean,
      last: "",
      warning: 'The name "' + clean + '" is one word, so the last name is blank. Type it before adding.'
    };
  }
  var first = clean.substring(0, space);
  var last = clean.substring(space + 1);
  var words = clean.split(" ").length;
  return {
    first: first,
    last: last,
    warning: words === 2
      ? null
      : 'The name "' + clean + '" has ' + words + ' words, so it was split as first name "' +
        first + '" and last name "' + last + '". Check that it matches the time sheet.'
  };
}

// lessonMinutes_ works out how long a lesson is, in minutes, from its start and end times. It
// gives back nothing (null) if either time is missing or unreadable.
function lessonMinutes_(row, tz) {
  var start = parseWallClockTime_(clockText_(row["Start Time"], tz));
  var end = parseWallClockTime_(clockText_(row["End Time"], tz));
  if (!start || !end) return null;
  var minutes = (end.h * 60 + end.m) - (start.h * 60 + start.m);
  // A lesson that runs past midnight (rare) ends "earlier" than it starts; add a day.
  if (minutes <= 0) minutes += 24 * 60;
  return minutes;
}

// clockText_ turns a time cell into text like "3:30 PM". Most times already arrive as text; a
// cell that holds a full date and time is shown in the given time zone.
function clockText_(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, "h:mm a");
  return String(value === null || value === undefined ? "" : value).trim();
}

// mapBlockToList_ turns the Lesson Schedule's block (like "C Block") into the time sheet's Block
// choice (like "C"). A value that is already on the list passes straight through. Anything else
// is left blank with a warning, so the teacher picks it.
function mapBlockToList_(raw, list) {
  var text = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!text) {
    return {
      value: "",
      warning: "This lesson has no Lesson Block on the Lesson Schedule, so Block is blank. Pick one."
    };
  }
  var exact = findListItem_(list, text);
  if (exact.found) return { value: exact.value };
  // "C Block" → "C", "Lunch Block" → "Lunch".
  var withoutWord = text.replace(/\s+block\s*$/i, "");
  if (withoutWord !== text) {
    var stripped = findListItem_(list, withoutWord);
    if (stripped.found) return { value: stripped.value };
  }
  if (list.length === 0) return { value: withoutWord };
  return {
    value: "",
    warning: 'The Lesson Schedule says "' + text + "\", which isn't on the time sheet's Block " +
      "list, so Block is blank. Pick one."
  };
}

// mapInstrumentToList_ turns the instrument a student wrote on the sign-up form into one of the
// time sheet's Music Subject choices: "electric guitar" → Guitar, "bass guitar" → Bass. When it
// can't tell (no answer, an instrument that isn't on the list, or two different instruments), it
// leaves the cell blank with a warning, so the teacher picks.
function mapInstrumentToList_(answer, list) {
  var text = String(answer || "").trim();
  if (!text) {
    return {
      value: "",
      warning: "The sign-up form has no instrument for this student, so Music Subject is blank. Pick one."
    };
  }
  if (list.length === 0) return { value: "" };
  var exact = findListItem_(list, text);
  if (exact.found) return { value: exact.value };

  // Look for each choice as a whole word in the answer ("uke" counts as "ukulele").
  var lower = " " + listKey_(text).replace(/\buke\b/g, "ukulele") + " ";
  var hits = [];
  list.forEach(function (item) {
    var word = listKey_(item);
    if (!word) return;
    var match = new RegExp("[^a-z0-9]" + escapeRegExp_(word) + "[^a-z0-9]").exec(lower);
    if (match) hits.push({ item: item, index: match.index + 1, word: word });
  });
  hits.sort(function (a, b) { return a.index - b.index; });

  // One instrument named: that's it.
  if (hits.length === 1) return { value: hits[0].item };
  // Two names side by side, like "bass guitar": the first word names the instrument.
  if (hits.length === 2) {
    var between = lower.substring(hits[0].index + hits[0].word.length, hits[1].index);
    if (/^\s+$/.test(between)) return { value: hits[0].item };
  }
  return {
    value: "",
    warning: 'The sign-up form says "' + text + '", which doesn\'t match one of the time sheet\'s ' +
      "instruments (" + list.join(", ") + "), so Music Subject is blank. Pick one."
  };
}

// formInstrumentAnswer_ finds what a student wrote for "What instrument do you want to play?" on
// their latest sign-up form (a later non-blank answer replaces an earlier one).
function formInstrumentAnswer_(email) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Form Responses 1");
  if (!sheet) return "";
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return "";
  var headers = data[0].map(function (h) {
    return String(h || "").trim().toLowerCase();
  });
  var emailCol = headers.indexOf("email address");
  var instrumentCol = headers.indexOf(FORM_INSTRUMENT_QUESTION.toLowerCase());
  // If the question was reworded, fall back to the first column that mentions "instrument".
  if (instrumentCol === -1) {
    for (var c = 0; c < headers.length; c++) {
      if (headers[c].indexOf("instrument") !== -1) {
        instrumentCol = c;
        break;
      }
    }
  }
  if (emailCol === -1 || instrumentCol === -1) return "";
  var answer = "";
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][emailCol] || "").trim().toLowerCase() !== email) continue;
    var value = String(data[r][instrumentCol] || "").trim();
    if (value) answer = value;
  }
  return answer;
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — the time sheet's tabs and rows
// ──────────────────────────────────────────────────────────────────────

// termFor_ says which school term a date (like "2026-10-05") falls in. Fall is Aug 1 to Nov 30,
// Winter is Dec 1 to the end of February, Spring is Mar 1 to Jul 31. It gives back the school
// year's first year, the term's name, an ID for comparing, and the label for a term label row:
// "Fall 2026", "Winter 2026-27", or "Spring 2027".
function termFor_(dateKey) {
  var year = Number(dateKey.substring(0, 4));
  var month = Number(dateKey.substring(5, 7));
  // August to December belong to the school year starting this year; January to July to the
  // one that started last year.
  var start = month >= 8 ? year : year - 1;
  var name;
  if (month >= 8 && month <= 11) name = "Fall";
  else if (month === 12 || month <= 2) name = "Winter";
  else name = "Spring";
  var label;
  if (name === "Fall") label = "Fall " + start;
  else if (name === "Winter") label = "Winter " + start + "-" + String(start + 1).substring(2);
  else label = "Spring " + (start + 1);
  return { schoolYearStart: start, name: name, id: start + " " + name, label: label };
}

// schoolYearTabName_ gives the name of the school-year tab a date belongs to: August to December
// of 2026 → "2026-2027", January to July of 2027 → "2026-2027".
function schoolYearTabName_(dateKey) {
  var start = termFor_(dateKey).schoolYearStart;
  return start + "-" + (start + 1);
}

// findYearTab_ finds a school-year tab by its exact name (surrounding spaces ignored). It never
// matches by "starts with" or "contains", because the CHAPEL/MISC. tab names hold the year too.
function findYearTab_(ss, name) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getName()).trim() === name) return sheets[i];
  }
  return null;
}

// newestYearTab_ finds the newest school-year tab: the one named like "2025-2026" with the
// latest years. CHAPEL/MISC. tabs never count. Gives back nothing (null) if there is none.
function newestYearTab_(ss) {
  var best = null;
  var bestYear = -1;
  ss.getSheets().forEach(function (sheet) {
    var m = /^(\d{4})-(\d{4})$/.exec(String(sheet.getName()).trim());
    if (!m || Number(m[2]) !== Number(m[1]) + 1) return;
    if (Number(m[1]) > bestYear) {
      bestYear = Number(m[1]);
      best = sheet;
    }
  });
  return best;
}

// findSheetByLooseName_ finds a tab by name: an exact match first, then one that differs only in
// capital letters or surrounding spaces. Used for the lookup tabs, whose names hold no year.
function findSheetByLooseName_(ss, name) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === name) return sheets[i];
  }
  for (var j = 0; j < sheets.length; j++) {
    if (listKey_(sheets[j].getName()) === listKey_(name)) return sheets[j];
  }
  return null;
}

// readTimesheetLists_ reads every dropdown list from the time sheet's lookup tabs: the non-blank
// cells in column A, exactly as they are (a number stays a number). It also names any lookup tab
// that is missing.
function readTimesheetLists_(ts) {
  var values = {};
  var missingTabs = [];
  Object.keys(TIMESHEET_LIST_TABS).forEach(function (key) {
    var sheet = findSheetByLooseName_(ts, TIMESHEET_LIST_TABS[key]);
    if (!sheet) {
      values[key] = [];
      missingTabs.push(TIMESHEET_LIST_TABS[key]);
      return;
    }
    var lastRow = sheet.getLastRow();
    values[key] = lastRow < 1
      ? []
      : sheet.getRange(1, 1, lastRow, 1).getValues()
        .map(function (r) { return r[0]; })
        .filter(function (v) {
          return v !== "" && v !== null && v !== undefined && !(v instanceof Date);
        });
  });
  return { values: values, missingTabs: missingTabs };
}

// readYearTabRows_ reads columns A to G of every row below the title row of a school-year tab.
// For each row it notes the row number, the date in column A as year-month-day (or nothing for
// label rows like "Fall 2025" or "Week 1", and for blank rows), the lesson number, and the name.
function readYearTabRows_(sheet, tz) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, TIMESHEET_WRITE_COLUMNS).getValues();
  return values.map(function (cells, i) {
    return {
      rowNumber: i + 2,
      a: cells[0],
      dateKey: timesheetDateKey_(cells[0], tz),
      lessonNo: cells[1],
      first: cells[2],
      last: cells[3],
      cells: cells
    };
  });
}

// timesheetDateKey_ reads column A of a time sheet row as a date, written year-month-day. A real
// date counts (read in the time sheet's own time zone), and so does text like "9/10/2026".
// Anything else (a label like "Week 1", or a blank) gives back nothing (null).
function timesheetDateKey_(value, tz) {
  if (value instanceof Date) {
    if (isNaN(value.getTime()) || value.getFullYear() < 1900) return null;
    return Utilities.formatDate(value, tz, "yyyy-MM-dd");
  }
  if (typeof value === "string") return dateKeyFromSlashDate_(value);
  return null;
}

// countStudentLessons_ follows the time sheet's own numbering for one student in one term. It
// walks the student's rows in that term from top to bottom, starting at 0: a number n sets the
// count to n, "Double" adds 2, and "No Show", "Late Cancel" or a blank leave it alone. The next
// lesson is that count plus 1. It also counts how many of the student's rows it saw.
function countStudentLessons_(rows, term, first, last) {
  var running = 0;
  var prior = 0;
  if (!nameKey_(first) && !nameKey_(last)) return { running: 0, prior: 0 };
  rows.forEach(function (r) {
    if (!r.dateKey || termFor_(r.dateKey).id !== term.id) return;
    if (!sameStudentName_(r, first, last)) return;
    prior++;
    var n = lessonNumberValue_(r.lessonNo);
    if (n !== null) {
      running = n;
    } else if (listKey_(r.lessonNo) === "double") {
      running += 2;
    }
  });
  return { running: running, prior: prior };
}

// needsTermLabel_ decides whether a term label row (like "Fall 2026") goes above the new row: yes
// when no row on the tab is dated in that term yet, unless the teacher already typed a label for
// that term below the last dated row (like "Winter TERM").
function needsTermLabel_(rows, term) {
  var lastDated = -1;
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].dateKey) continue;
    if (termFor_(rows[i].dateKey).id === term.id) return false;
    lastDated = i;
  }
  var word = new RegExp("\\b" + term.name.toLowerCase() + "\\b");
  for (var j = lastDated + 1; j < rows.length; j++) {
    if (typeof rows[j].a !== "string") continue;
    var text = rows[j].a.trim().toLowerCase();
    if (!text || /^end\b/.test(text)) continue;
    if (word.test(text)) return false;
  }
  return true;
}

// findDuplicateRow_ finds a row on the tab with the same date and the same student (first and
// last name, ignoring capitals and extra spaces). Gives back that row, or nothing (null).
function findDuplicateRow_(rows, dateKey, first, last) {
  if (!nameKey_(first) && !nameKey_(last)) return null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].dateKey === dateKey && sameStudentName_(rows[i], first, last)) return rows[i];
  }
  return null;
}

// sameStudentName_ says whether a time sheet row is for the given student (first + last name,
// trimmed, ignoring capital letters).
function sameStudentName_(row, first, last) {
  return nameKey_(row.first) === nameKey_(first) && nameKey_(row.last) === nameKey_(last);
}

// nameKey_ tidies a name for comparing: no outside spaces, single inside spaces, lowercase.
function nameKey_(value) {
  return String(value === null || value === undefined ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
}

// lessonNumberValue_ reads a Lesson No. cell as a number (1, or the text "1"), or gives back
// nothing (null) for "Double", "No Show", "Late Cancel", a blank, and anything else.
function lessonNumberValue_(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  var text = String(value === null || value === undefined ? "" : value).trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

// highestNumberOnList_ gives the biggest number on a list (9 for the Lesson No. list), or 0 if
// the list holds no numbers.
function highestNumberOnList_(list) {
  var highest = 0;
  list.forEach(function (item) {
    var n = lessonNumberValue_(item);
    if (n !== null && n > highest) highest = n;
  });
  return highest;
}

// displayCells_ turns a row's A to G values into what the time sheet shows: dates as M/d/yyyy.
function displayCells_(cells, tz) {
  return cells.map(function (value) {
    return value instanceof Date ? Utilities.formatDate(value, tz, "M/d/yyyy") : value;
  });
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — dropdown lists
// ──────────────────────────────────────────────────────────────────────

// listKey_ tidies a value for comparing with a list choice: text, trimmed, single spaces,
// lowercase. So "1PM Shadow Block" matches the list's "1PM  Shadow Block" (two spaces).
function listKey_(value) {
  return String(value === null || value === undefined ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
}

// sameListValue_ says whether two values mean the same choice: the same text (see listKey_), or
// the same number (so 1 matches "1", and 0.75 matches "0.75").
function sameListValue_(a, b) {
  var ka = listKey_(a);
  var kb = listKey_(b);
  if (ka === kb) return true;
  if (ka === "" || kb === "") return false;
  var na = Number(ka);
  var nb = Number(kb);
  return isFinite(na) && isFinite(nb) && na === nb;
}

// findListItem_ looks for a value on a dropdown list. It gives back { found: true, value } with
// the list's own copy of the choice (so the exact text, and a number stays a number), or
// { found: false }.
function findListItem_(list, value) {
  for (var i = 0; i < list.length; i++) {
    if (sameListValue_(list[i], value)) return { found: true, value: list[i] };
  }
  return { found: false };
}

// listValueOrRaw_ gives back the list's own copy of a choice when the value is on the list, so it
// is written exactly as the dropdown expects. Otherwise it gives back the value as typed (text
// that looks like a number becomes a number, the way Sheets treats typing). Blank stays blank.
function listValueOrRaw_(list, value, label) {
  if (typeof value === "string" && value.trim() === "") return "";
  var match = findListItem_(list, value);
  if (match.found) return match.value;
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error(label + " must be a number or a choice from its list.");
    return value;
  }
  var text = cleanCellText_(String(value), label);
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

// cleanCellText_ checks text the teacher typed before it goes on the time sheet: trimmed, not
// too long, and never starting with "=" (which Sheets would treat as a formula).
function cleanCellText_(text, label) {
  var clean = String(text).trim();
  if (clean.length > 80) throw new Error(label + " is too long (80 characters at most).");
  if (clean.charAt(0) === "=") throw new Error(label + ' can\'t start with "=".');
  return clean;
}

// escapeRegExp_ makes text safe to search for inside a pattern (so "1PM" or "Dept." match
// literally).
function escapeRegExp_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// nameListWarnings_ checks the tab's first-name and last-name columns (C and D). Only if their
// dropdowns use Mr. O'Neal's First Name / Last Name tabs does it compare the student's name with
// those lists, and only to warn: a new student won't be on them yet. The tool never writes to
// those tabs. It gives back { message, note } pairs.
function nameListWarnings_(tab, rows, first, last) {
  var out = [];
  var dataRow = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].dateKey) {
      dataRow = rows[i];
      break;
    }
  }
  if (!dataRow) return out;
  [
    { column: 3, letter: "C", tabName: TIMESHEET_FIRST_NAME_TAB, name: first },
    { column: 4, letter: "D", tabName: TIMESHEET_LAST_NAME_TAB, name: last }
  ].forEach(function (spec) {
    if (!spec.name) return;
    var listRange = validationListRange_(tab.getRange(dataRow.rowNumber, spec.column).getDataValidation());
    if (!listRange || listKey_(listRange.getSheet().getName()) !== listKey_(spec.tabName)) return;
    var names = [];
    listRange.getValues().forEach(function (r) {
      r.forEach(function (v) {
        if (v !== "" && v !== null) names.push(v);
      });
    });
    if (findListItem_(names, spec.name).found) return;
    out.push({
      message: '"' + spec.name + '" isn\'t on the ' + spec.tabName + " list that column " +
        spec.letter + "'s dropdown uses (normal for a new student). Add it to the " +
        spec.tabName + " tab by hand if you want it there; the tool never writes to that tab.",
      note: spec.tabName + ' "' + spec.name + '"'
    });
  });
  return out;
}

// validationListRange_ gives back the cells a dropdown takes its choices from, when the dropdown
// is the "from a range" kind. Otherwise (no dropdown, or a typed-in list) it gives back nothing.
function validationListRange_(rule) {
  if (!rule) return null;
  try {
    if (rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) return null;
    var criteria = rule.getCriteriaValues();
    return criteria && criteria[0] && typeof criteria[0].getValues === "function" ? criteria[0] : null;
  } catch (err) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — writing
// ──────────────────────────────────────────────────────────────────────

// appendTimesheetRow_ writes the planned row directly below the last used row of the school-year
// tab (creating the tab first if this is the school year's first lesson). When the lesson starts
// a new term, the term label row goes in just above it. Both rows go in with one write, columns A
// to G only. Column A gets a real date with the M/d/yyyy format, made in the time sheet's own
// time zone so it can't land a day early. It gives back the lesson's row number.
function appendTimesheetRow_(ctx, plan) {
  var sheet = findYearTab_(ctx.ts, plan.tab);
  var createdTab = false;
  if (!sheet) {
    sheet = createYearTab_(ctx.ts, plan.tab, ctx.tsTz);
    createdTab = true;
  }

  var f = plan.fields;
  var rows = [];
  if (plan.addsTermLabel) rows.push([plan.termLabel, "", "", "", "", "", ""]);
  rows.push([
    Utilities.parseDate(plan.lessonDateKey, ctx.tsTz, "yyyy-MM-dd"),
    f.lessonNo,
    f.firstName,
    f.lastName,
    f.block,
    f.hours,
    f.subject
  ]);

  var firstRow = sheet.getLastRow() + 1;
  var lessonRow = firstRow + rows.length - 1;
  ensureSheetRows_(sheet, lessonRow);
  sheet.getRange(lessonRow, 1).setNumberFormat("M/d/yyyy");
  try {
    sheet.getRange(firstRow, 1, rows.length, TIMESHEET_WRITE_COLUMNS).setValues(rows);
    // Sheets saves writes in batches; flushing here makes any refusal show up now, inside this
    // try, instead of later.
    SpreadsheetApp.flush();
  } catch (err) {
    var problem = timesheetWriteProblem_(err, plan, sheet, firstRow, rows.length);
    // The new tab itself stays (with its header and dropdowns); the next try reuses it.
    if (createdTab) {
      problem = problem.replace(
        " (Google said:",
        " The new " + plan.tab + " tab was created and stays ready for the next try. (Google said:"
      );
    }
    throw new Error(problem);
  }
  return {
    rowNumber: lessonRow,
    labelRowNumber: plan.addsTermLabel ? firstRow : null,
    createdTab: createdTab
  };
}

// timesheetWriteProblem_ turns Google's error from a refused write into a plain-English message
// for the website: what went wrong, whether anything landed on the tab, and Google's own words.
function timesheetWriteProblem_(err, plan, sheet, firstRow, count) {
  var raw = String(err && err.message ? err.message : err).replace(/^Exception:\s*/, "");
  // Check whether any of it landed, so the message can say so honestly.
  var landed = false;
  try {
    landed = sheet.getRange(firstRow, 1, count, TIMESHEET_WRITE_COLUMNS).getValues().some(function (r) {
      return r.some(function (v) { return v !== "" && v !== null; });
    });
  } catch (readErr) {
    landed = false;
  }
  var lead;
  if (/data validation|violates/i.test(raw)) {
    lead = "Google Sheets refused this row because a value isn't allowed by the time sheet's dropdowns" +
      (plan.notOnList.length > 0 ? " (" + plan.notOnList.join("; ") + ")" : "") +
      ". Pick values from the dropdowns, or add the value to the matching list on the time sheet.";
  } else if (/protected/i.test(raw)) {
    lead = "That part of the time sheet is protected, so the script can't write there.";
  } else if (/permission|access/i.test(raw)) {
    lead = "The script can't edit the time sheet. Share it as Editor with the Google account the web app runs as.";
  } else {
    lead = "Google Sheets couldn't add the row.";
  }
  var outcome = landed
    ? " Part of it may have been written to row " + firstRow + " of " + plan.tab +
      ", so check the time sheet before trying again."
    : " Nothing was added, and the lesson wasn't marked.";
  return lead + outcome + " (Google said: " + raw + ")";
}

// createYearTab_ makes a new school-year tab (like "2026-2027") just before the newest existing
// one, copying from it: the title row with its formatting, the frozen rows and columns, the
// column widths, and the dropdowns on columns B, E, F and G (taken from one of its lesson rows).
// No lesson rows are copied.
function createYearTab_(ts, name, tz) {
  var template = newestYearTab_(ts);
  if (!template) {
    throw new Error(
      "The time sheet has no school-year tab (like 2025-2026) to copy, so the tool can't create " +
      name + ". Add that tab by hand, then try again."
    );
  }
  try {
    var sheet = ts.insertSheet(name, template.getIndex() - 1);
    var lastCol = Math.max(template.getLastColumn(), TIMESHEET_WRITE_COLUMNS);
    if (sheet.getMaxColumns() < lastCol) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), lastCol - sheet.getMaxColumns());
    }
    // The title row: its words and its look.
    template.getRange(1, 1, 1, lastCol).copyTo(sheet.getRange(1, 1, 1, lastCol));
    // The frozen title row and frozen columns, and each column's width.
    sheet.setFrozenRows(template.getFrozenRows());
    sheet.setFrozenColumns(template.getFrozenColumns());
    for (var c = 1; c <= lastCol; c++) {
      sheet.setColumnWidth(c, template.getColumnWidth(c));
    }
    copyYearTabDropdowns_(template, sheet, tz);
    return sheet;
  } catch (err) {
    throw new Error(
      "Couldn't finish creating the " + name + " tab (" +
      String(err && err.message ? err.message : err).replace(/^Exception:\s*/, "") + "). " +
      "If a half-made " + name + " tab is on the time sheet, delete it, then try again."
    );
  }
}

// copyYearTabDropdowns_ copies the dropdowns of columns B, E, F and G from the template tab's
// newest lesson row that has one, onto every row below the title on the new tab.
function copyYearTabDropdowns_(template, sheet, tz) {
  var rows = readYearTabRows_(template, tz);
  if (rows.length === 0) return;
  [2, 5, 6, 7].forEach(function (column) {
    // One read per column: every row's dropdown rule for that column.
    var rules = template.getRange(2, column, rows.length, 1).getDataValidations();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].dateKey || !rules[i][0]) continue;
      sheet.getRange(2, column, sheet.getMaxRows() - 1, 1).setDataValidation(rules[i][0]);
      return;
    }
  });
}

// ensureSheetRows_ adds empty rows at the bottom of a tab if it has fewer than `needed` rows.
function ensureSheetRows_(sheet, needed) {
  var maxRows = sheet.getMaxRows();
  if (maxRows < needed) sheet.insertRowsAfter(maxRows, needed - maxRows);
}

// writeTimesheetMark_ writes the note ("Added 10/7/2026" or "Skipped") into the lesson's Time
// Sheet cell on the Lesson Schedule, adding that column the first time.
function writeTimesheetMark_(found, text, tabName, rowNumber) {
  try {
    var column = ensureAutoManagedColumn_(found.sheet, TIME_SHEET_COLUMN);
    found.sheet.getRange(found.rowIndex, column).setValue(text);
    SpreadsheetApp.flush();
  } catch (err) {
    var why = String(err && err.message ? err.message : err).replace(/^Exception:\s*/, "");
    if (tabName) {
      throw new Error(
        "The row is on " + tabName + " (row " + rowNumber + "), but the Lesson Schedule couldn't " +
        "be marked (" + why + "). Trying again is safe: the tool will see the row is already " +
        "there and only write the mark."
      );
    }
    throw new Error("The Lesson Schedule couldn't be marked (" + why + ").");
  }
}

// addedMarkText_ is the note for a lesson that is on the time sheet: "Added" and today's date in
// the studio spreadsheet's time zone, like "Added 10/7/2026".
function addedMarkText_(studioTz) {
  return "Added " + Utilities.formatDate(new Date(), studioTz, "M/d/yyyy");
}

// isAddedMark_ and isSkippedMark_ read a lesson's Time Sheet note.
function isAddedMark_(mark) {
  return /^added\b/i.test(String(mark || "").trim());
}
function isSkippedMark_(mark) {
  return /^skipped$/i.test(String(mark || "").trim());
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — dates
// ──────────────────────────────────────────────────────────────────────

// dateKeyFromLessonCell_ reads a Lesson Schedule date as year-month-day text ("2026-10-05"). It
// takes a real date (read in the studio spreadsheet's time zone), "2026-10-05", or "10/5/2026".
function dateKeyFromLessonCell_(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, "yyyy-MM-dd");
  var text = String(value === null || value === undefined ? "" : value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidDateKey_(text) ? text : null;
  return dateKeyFromSlashDate_(text);
}

// dateKeyFromSlashDate_ reads text like "9/10/2026" (month/day/year) as "2026-09-10", or gives back
// nothing (null) if it isn't a real date written that way.
function dateKeyFromSlashDate_(text) {
  var m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(text));
  if (!m) return null;
  return dateKeyFromParts_(Number(m[3]), Number(m[1]), Number(m[2]));
}

// dateKeyFromParts_ builds "yyyy-MM-dd" from a year, month and day, or gives back nothing (null)
// for an impossible date like February 30.
function dateKeyFromParts_(year, month, day) {
  var check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day;
}

// isValidDateKey_ says whether text is a real date written year-month-day, like 2026-10-05.
function isValidDateKey_(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
  return !!m && dateKeyFromParts_(Number(m[1]), Number(m[2]), Number(m[3])) === text;
}

// displayDateFromKey_ turns "2026-10-05" into "10/5/2026", the way the time sheet shows dates.
function displayDateFromKey_(key) {
  return Number(key.substring(5, 7)) + "/" + Number(key.substring(8, 10)) + "/" + key.substring(0, 4);
}

// ──────────────────────────────────────────────────────────────────────
// Phase 6 — authorize() report
// ──────────────────────────────────────────────────────────────────────

// checkTimesheetForAuthorize_ opens the time sheet (so Google's permission prompt covers it) and
// writes plain-English report lines for the authorize() log: "OK ..." when a setting works, or
// "PROBLEM ..." with what to do. It never stops authorize().
function checkTimesheetForAuthorize_() {
  var lines = [];
  var summary = { configured: false };
  var props = PropertiesService.getScriptProperties();
  var rawId = String(props.getProperty(TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY) || "").trim();
  var rawStart = String(props.getProperty(TIMESHEET_START_DATE_PROPERTY_KEY) || "").trim();
  var idOk = false;

  if (!rawId) {
    lines.push(
      "PROBLEM " + TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + ": not set. Add it in Project " +
      "Settings → Script Properties (the time sheet's ID or its whole web address)."
    );
  } else if (!spreadsheetIdFromSetting_(rawId)) {
    lines.push(
      "PROBLEM " + TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + ": doesn't look like a Google Sheets ID or link."
    );
  } else {
    var ts = null;
    try {
      ts = SpreadsheetApp.openById(spreadsheetIdFromSetting_(rawId));
    } catch (err) {
      var me = effectiveUserEmail_();
      lines.push(
        "PROBLEM " + TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + ": can't open it: share the time " +
        "sheet as Editor with the Google account this script runs as" + (me ? " (" + me + ")" : "") +
        "." + googleSaid_(err)
      );
    }
    if (ts) {
      try {
        var tz = ts.getSpreadsheetTimeZone();
        var tabName = schoolYearTabName_(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
        var tabNote = "";
        if (!findYearTab_(ts, tabName)) {
          var newest = newestYearTab_(ts);
          tabNote = newest
            ? " (not there yet; it will be created just before " + newest.getName() + " on the first add)"
            : " (not there yet, and there's no school-year tab to copy; add it by hand)";
        }
        lines.push(
          "OK " + TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + ': "' + ts.getName() + '", tab ' + tabName + tabNote
        );
        var lists = readTimesheetLists_(ts);
        lines.push(
          "Time sheet lists: Lesson No. " + lists.values.lessonNo.length + ", Block " +
          lists.values.block.length + ", hours " + lists.values.hours.length + ", Instrument " +
          lists.values.instrument.length +
          (lists.missingTabs.length > 0 ? " (missing tabs: " + lists.missingTabs.join(", ") + ")" : "")
        );
        idOk = true;
        summary = { configured: false, sheetTitle: ts.getName(), targetTab: tabName };
      } catch (err) {
        lines.push(
          "PROBLEM " + TIMESHEET_SPREADSHEET_ID_PROPERTY_KEY + ": opened it, but couldn't read it (" +
          String(err && err.message ? err.message : err) + ")."
        );
      }
    }
  }

  if (!rawStart) {
    lines.push(
      "PROBLEM " + TIMESHEET_START_DATE_PROPERTY_KEY + ": not set. Add it in Project Settings → " +
      "Script Properties, written like 2026-10-05."
    );
  } else if (!isValidDateKey_(rawStart)) {
    lines.push(
      "PROBLEM " + TIMESHEET_START_DATE_PROPERTY_KEY + ': "' + rawStart + "\" isn't a date written like 2026-10-05."
    );
  } else {
    lines.push("OK " + TIMESHEET_START_DATE_PROPERTY_KEY + ": " + rawStart);
    summary.startDate = rawStart;
    if (idOk) summary.configured = true;
  }
  return { lines: lines, summary: summary };
}

// effectiveUserEmail_ gives the email of the Google account this script is running as, or "" if
// Google won't say.
function effectiveUserEmail_() {
  try {
    return String(Session.getEffectiveUser().getEmail() || "");
  } catch (err) {
    return "";
  }
}

/**
 * Form-submit trigger. Buckets every new submission into a tab named
 * after the submitter's email so `?email=…` lookups are O(1).
 *
 * Install: Triggers → Add Trigger → onFormSubmit / From spreadsheet /
 * On form submit.
 */
// onFormSubmit runs automatically every time a student submits the sign-up Google Form (it is
// set up as a "trigger": an instruction telling Google to run this on each new form answer).
// It copies the student's answers onto their own tab (named after their email), creating the
// tab the first time, then creates their personal Drive folder and shares the class folder.
function onFormSubmit(e) {
  // Open the spreadsheet and the tab where form answers land, and read its column titles.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const formSheet = ss.getSheetByName("Form Responses 1");

  const headers = formSheet.getRange(1, 1, 1, formSheet.getLastColumn()).getValues()[0];
  // "e.values" holds the new answers, in the same order as the column titles.
  const responses = e.values;

  // Find the email column. Without it we can't tell whose answers these are, so stop.
  const normalizedHeaders = headers.map(h => String(h).trim().toLowerCase());
  const emailIndex = normalizedHeaders.indexOf("email address");

  if (emailIndex === -1) {
    throw new Error('Could not find "Email Address" column. Found headers: ' + headers.join(" | "));
  }

  // Read the student's email from their answers. A blank email is an error.
  const email = String(responses[emailIndex] || "").trim().toLowerCase();

  if (!email) {
    throw new Error("Email is blank. Response row: " + JSON.stringify(responses));
  }

  // Pull the student's name from the same row when available — used as
  // the per-student folder name. Tries common header variants so a
  // future form rename doesn't silently fall back to email-only.
  var nameIndex = normalizedHeaders.indexOf("first and last name");
  if (nameIndex === -1) nameIndex = normalizedHeaders.indexOf("name");
  var studentName = nameIndex === -1
    ? ""
    : String(responses[nameIndex] || "").trim();

  // Find the student's own tab. If they don't have one yet, create it and copy in the titles.
  let sheet = ss.getSheetByName(email);
  var createdNewTab = false;

  if (!sheet) {
    sheet = ss.insertSheet(email);
    sheet.appendRow(headers);
    createdNewTab = true;
  }

  // Add this submission as a new row at the bottom of their tab.
  sheet.appendRow(responses);

  // If the tab is brand new, give it the studio's colors.
  if (createdNewTab) {
    try {
      formatStudentTab_(sheet);
    } catch (err) {
      // Formatting is cosmetic — never let a styling failure block the
      // submission from being recorded.
      Logger.log("formatStudentTab_ failed for " + email + ": " + err);
    }
  }

  // Auto-onboard the student into Drive: their personal folder (with
  // editor access) plus viewer access on the shared Class Resources
  // folder. Each step is wrapped so a configuration miss (folder ID
  // not set, Drive quota, etc.) never blocks the submission from being
  // recorded — the bulk Sync handlers can backfill any failures.
  try {
    ensureStudentFolder_(email, studentName);
  } catch (err) {
    Logger.log("ensureStudentFolder_ failed for " + email + ": " + err);
  }

  try {
    grantClassResourcesViewerForStudent_(email);
  } catch (err) {
    Logger.log("grantClassResourcesViewerForStudent_ failed for " + email + ": " + err);
  }
}

/**
 * Best-effort: grant viewer access on the Class Resources folder to a
 * single newly-onboarded student. No-op when the folder isn't
 * configured (e.g. fresh deployment), when the email already has
 * access at viewer-or-above, or when Drive rejects the email — all
 * three are conditions the bulk `sync-class-resources-access` handler
 * also tolerates, so this stays consistent with that flow.
 */
// grantClassResourcesViewerForStudent_ lets one new student view the shared Class Resources
// folder. It's called right after they submit the form. It quietly does nothing if the folder
// isn't set up, the student already has access, or Google refuses; the Sync button can retry.
function grantClassResourcesViewerForStudent_(studentEmail) {
  // Tidy the email and look up the saved folder ID. Stop quietly if either is missing.
  var normalized = String(studentEmail || "").trim().toLowerCase();
  if (!normalized) return;
  var folderId = PropertiesService.getScriptProperties()
    .getProperty(CLASS_RESOURCES_FOLDER_ID_PROPERTY_KEY);
  if (!folderId) return; // not configured yet — skip silently
  // Try to open the folder. If it can't be opened, note it in the log and stop.
  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (err) {
    Logger.log("Class Resources folder unreachable: " + err);
    return;
  }
  // Skip if already has access at any level.
  try {
    var viewers = folder.getViewers();
    for (var i = 0; i < viewers.length; i++) {
      if (String(viewers[i].getEmail() || "").toLowerCase() === normalized) return;
    }
    var editors = folder.getEditors();
    for (var j = 0; j < editors.length; j++) {
      if (String(editors[j].getEmail() || "").toLowerCase() === normalized) return;
    }
  } catch (err) {
    // Some shared-drive configs throw; fall through and let addViewer be
    // the source of truth.
  }
  // Skip if it's the folder owner or current deployer — addViewer
  // would error in those cases.
  try {
    var ownerEmail = String(folder.getOwner().getEmail() || "").toLowerCase();
    if (ownerEmail === normalized) return;
  } catch (err) {
    // Shared-drive folders without a single owner — fall through.
  }
  try {
    var selfEmail = String(Session.getEffectiveUser().getEmail() || "").toLowerCase();
    if (selfEmail === normalized) return;
  } catch (err) {
    // Session.getEffectiveUser is gated by scope on some accounts; safe to ignore.
  }
  // Give the student permission to view (not change) the folder.
  try {
    folder.addViewer(normalized);
  } catch (err) {
    // Same reasoning as applyStudentFolderPermissions_: a single bad
    // address shouldn't break the form-submit handler. Log and let
    // the bulk Sync handler retry later.
    Logger.log(
      "grantClassResourcesViewerForStudent_: addViewer(" + normalized +
      ") failed: " + (err && err.message ? err.message : err)
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Sheet formatting + auto-column protection
//
// One-time setup: open the Apps Script editor, select setupSheetFormatting,
// and click Run. It styles every known tab (Form Responses 1, Lesson
// Schedule, Lesson Recaps, every per-student tab) and applies warning-only
// protection to the auto-managed columns ("Status", "Calendar Event ID",
// "Time Sheet") on the Lesson Schedule tab, adding the last two if missing.
//
// New per-student tabs created by `onFormSubmit` are styled at creation,
// so the teacher only ever needs to run setupSheetFormatting() once after
// pulling new code (and again if a tab gets manually renamed or rebuilt).
// ──────────────────────────────────────────────────────────────────────

/** Pomfret crimson palette — mirrors the dashboard's --accent / surfaces. */
// SHEET STYLING. The studio's colors used to style the Sheet: crimson title rows with white
// text, two soft alternating row colors, and a muted gray-brown for columns the website fills in.
var FMT_HEADER_BG = "#7a142f";
var FMT_HEADER_TEXT = "#ffffff";
var FMT_BAND_FIRST = "#fffdfb";
var FMT_BAND_SECOND = "#f6f1ec";
var FMT_AUTO_COLUMN_BG = "#ece4dd";
var FMT_AUTO_COLUMN_TEXT = "#574d44";

/**
 * Columns the dashboard writes to automatically. Listed by exact header
 * string; warning-only protection + visual highlight is applied to each.
 * Anything edited in these columns by hand will be overwritten on the
 * next create-event / cancel-event call, hence the warning.
 */
// The Lesson Schedule columns the website fills in by itself (Status, Calendar Event ID, and
// Time Sheet). They get a different look and a warning if someone tries to edit them by hand.
var AUTO_MANAGED_LESSON_COLUMNS = ["Status", CALENDAR_EVENT_ID_COLUMN, TIME_SHEET_COLUMN];

/** Note shown when the teacher hovers a header cell of an auto column. */
// The note that pops up when the teacher hovers over the title of one of those columns.
var AUTO_MANAGED_HEADER_NOTE =
  "Auto-managed by the dashboard. Don't edit by hand: your changes will " +
  "be overwritten the next time the dashboard updates this lesson.";

/** Description used on the warning-only protection (also shown in the dialog). */
// The message shown in the warning box if someone tries to edit one of those columns.
var AUTO_MANAGED_PROTECTION_DESCRIPTION =
  "Auto-managed by the Music Studio dashboard. Please don't edit.";

/**
 * Property key for an explicit fallback spreadsheet ID. Only consulted
 * when `SpreadsheetApp.getActiveSpreadsheet()` returns null — which
 * happens for standalone scripts (not container-bound) or when the
 * editor is opened from `script.google.com` without an associated
 * sheet. Set it once in Project Settings → Script Properties:
 *   MUSIC_STUDIO_SPREADSHEET_ID = <id portion of the sheet URL>
 * The id is the segment between `/d/` and `/edit` in the sheet URL.
 */
// The settings-drawer label for a backup spreadsheet ID, used only if the script can't tell
// which spreadsheet it belongs to.
var MUSIC_STUDIO_SPREADSHEET_ID_PROPERTY_KEY = "MUSIC_STUDIO_SPREADSHEET_ID";

/**
 * Returns the music studio spreadsheet, tolerant of how the script was
 * launched. Used by setup-time helpers that may run from the editor
 * before the runtime has an active-spreadsheet context.
 */
// resolveMusicStudioSpreadsheet_ finds the studio spreadsheet. Normally the script already knows
// (it lives inside the Sheet); if not, it opens the Sheet using the backup ID from the settings
// drawer, or stops with instructions if that isn't set.
function resolveMusicStudioSpreadsheet_() {
  // Normal case: the script is attached to the Sheet, so use that.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  // Otherwise look up the backup ID; explain how to set it if it's missing.
  var fallbackId = PropertiesService.getScriptProperties()
    .getProperty(MUSIC_STUDIO_SPREADSHEET_ID_PROPERTY_KEY);
  if (!fallbackId) {
    throw new Error(
      "No active spreadsheet and no fallback ID configured. Either open " +
      "the editor via Sheet → Extensions → Apps Script, or set the " +
      MUSIC_STUDIO_SPREADSHEET_ID_PROPERTY_KEY +
      " Script Property to the spreadsheet ID (the segment between /d/ " +
      "and /edit in the sheet URL)."
    );
  }
  // Open the spreadsheet by its ID, or explain why that failed.
  try {
    return SpreadsheetApp.openById(fallbackId);
  } catch (err) {
    throw new Error(
      "Could not open spreadsheet by id '" + fallbackId + "': " +
      (err && err.message ? err.message : String(err))
    );
  }
}

/**
 * Manual entry point. Run once from the Apps Script editor after deploying
 * a new version. Formats every known tab and (re-)applies warning-only
 * protection to the auto-managed columns on the Lesson Schedule tab.
 *
 * Idempotent — safe to run repeatedly.
 */
// setupSheetFormatting is run by hand from the Apps Script editor (not by the website). It styles
// every tab in the studio spreadsheet with the studio's colors and adds "please don't edit"
// warnings to the columns the website manages. Running it again is harmless.
function setupSheetFormatting() {
  // Open the spreadsheet and start a list of which tabs were styled and which were skipped.
  var ss = resolveMusicStudioSpreadsheet_();
  var summary = { formatted: [], skipped: [] };

  // Style the form-answers (roster) tab, if it exists.
  var roster = ss.getSheetByName("Form Responses 1");
  if (roster) {
    formatRosterSheet_(roster);
    summary.formatted.push("Form Responses 1");
  } else {
    summary.skipped.push("Form Responses 1 (not found)");
  }

  // Style the Lesson Schedule tab, including the warnings on the website-managed columns.
  var schedule = ss.getSheetByName(LESSON_SCHEDULE_SHEET_NAME);
  if (schedule) {
    formatLessonScheduleSheet_(schedule);
    summary.formatted.push(LESSON_SCHEDULE_SHEET_NAME);
  } else {
    summary.skipped.push(LESSON_SCHEDULE_SHEET_NAME + " (not found)");
  }

  // Style the Lesson Recaps tab, if a recap has been saved yet.
  var recaps = ss.getSheetByName(LESSON_RECAPS_SHEET_NAME);
  if (recaps) {
    formatLessonRecapsSheet_(recaps);
    summary.formatted.push(LESSON_RECAPS_SHEET_NAME);
  } else {
    summary.skipped.push(LESSON_RECAPS_SHEET_NAME + " (not created yet)");
  }

  // Style every student's personal tab: the tabs whose names look like an email address.
  // Any other tabs are left alone.
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    var name = s.getName();
    if (name === "Form Responses 1") continue;
    if (name === LESSON_SCHEDULE_SHEET_NAME) continue;
    if (name === LESSON_RECAPS_SHEET_NAME) continue;
    // Per-student tabs are named after the student's email.
    if (!/.+@.+\..+/.test(name)) continue;
    formatStudentTab_(s);
    summary.formatted.push(name);
  }

  // Write a summary of what was done to the editor's log, and return it.
  Logger.log("setupSheetFormatting complete.");
  Logger.log("Formatted: " + summary.formatted.join(", "));
  if (summary.skipped.length > 0) {
    Logger.log("Skipped:   " + summary.skipped.join(", "));
  }
  return { ok: true, formatted: summary.formatted, skipped: summary.skipped };
}

/**
 * Common base format applied to every tab: bold/colored header row,
 * frozen first row, alternating row banding in the Pomfret palette,
 * and a thin border under the header.
 */
// applyBaseTableFormat_ gives one tab the studio's standard look: a bold crimson title row that
// stays pinned while scrolling, alternating row colors, and sensible column widths.
function applyBaseTableFormat_(sheet) {
  // Work out how many columns and rows the tab has (at least 1 column and 2 rows).
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var maxRows = Math.max(sheet.getMaxRows(), 2);

  // Header row.
  var headerRange = sheet.getRange(1, 1, 1, lastCol);
  headerRange
    .setFontWeight("bold")
    .setFontColor(FMT_HEADER_TEXT)
    .setBackground(FMT_HEADER_BG)
    .setVerticalAlignment("middle")
    .setWrap(true);

  sheet.setFrozenRows(1);

  // Body — neutral defaults so banding shows through cleanly.
  var bodyRange = sheet.getRange(2, 1, maxRows - 1, lastCol);
  bodyRange
    .setFontColor("#1a1411")
    .setFontStyle("normal")
    .setVerticalAlignment("top");

  // Replace any existing banding on this sheet so we own the colors.
  var existingBandings = sheet.getBandings();
  for (var i = 0; i < existingBandings.length; i++) {
    existingBandings[i].remove();
  }

  // Apply a wide banding so future rows pick up the alternating colors
  // without the teacher needing to re-run formatting.
  var bandingRange = sheet.getRange(1, 1, maxRows, lastCol);
  var banding = bandingRange.applyRowBanding(
    SpreadsheetApp.BandingTheme.LIGHT_GREY,
    /* showHeader */ true,
    /* showFooter */ false
  );
  banding.setHeaderRowColor(FMT_HEADER_BG);
  banding.setFirstRowColor(FMT_BAND_FIRST);
  banding.setSecondRowColor(FMT_BAND_SECOND);

  // Resize columns to fit headers + content (capped so a stray long cell
  // doesn't blow the layout out).
  for (var c = 1; c <= lastCol; c++) {
    try {
      sheet.autoResizeColumn(c);
      var w = sheet.getColumnWidth(c);
      if (w < 110) sheet.setColumnWidth(c, 110);
      if (w > 320) sheet.setColumnWidth(c, 320);
    } catch (err) {
      // Some sheets reject autoResize on hidden columns — ignore.
    }
  }
}

/** Format the master roster (Form Responses 1) — base format only. */
// Style the roster (form answers) tab with the standard look.
function formatRosterSheet_(sheet) {
  applyBaseTableFormat_(sheet);
}

/** Format a per-student tab — base format only. */
// Style one student's personal tab with the standard look.
function formatStudentTab_(sheet) {
  applyBaseTableFormat_(sheet);
}

/** Format the Lesson Recaps tab — base format only. */
// Style the Lesson Recaps tab with the standard look.
function formatLessonRecapsSheet_(sheet) {
  applyBaseTableFormat_(sheet);
}

/**
 * Format the Lesson Schedule tab. Base format + visual highlight + warning
 * protection on every column listed in AUTO_MANAGED_LESSON_COLUMNS.
 *
 * Requires the Calendar Event ID column to exist (we ensure it on every
 * lookup, but if no preview/create has run yet this function will still
 * try). If a column is missing it is silently skipped — the formatting
 * is cosmetic and shouldn't block setup.
 */
// formatLessonScheduleSheet_ styles the Lesson Schedule tab with the standard look, then marks
// the website-managed columns (Status, Calendar Event ID, Time Sheet) with muted colors and an
// edit warning.
function formatLessonScheduleSheet_(sheet) {
  // Make sure the Calendar Event ID and Time Sheet columns exist, then apply the standard look.
  ensureCalendarEventIdColumn_(sheet);
  ensureAutoManagedColumn_(sheet, TIME_SHEET_COLUMN);
  applyBaseTableFormat_(sheet);

  // Read the column titles, then find and mark each website-managed column.
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  for (var i = 0; i < AUTO_MANAGED_LESSON_COLUMNS.length; i++) {
    var name = AUTO_MANAGED_LESSON_COLUMNS[i];
    var idx = headerIndex_(headers, name);
    if (idx === -1) continue;
    highlightAutoManagedColumn_(sheet, idx + 1, name);
    protectAutoManagedColumn_(sheet, idx + 1);
  }
}

/**
 * Visual treatment for an auto-managed column: header gets a hover note,
 * data cells get a muted background + italic font so the teacher
 * immediately sees the column is "different".
 */
// highlightAutoManagedColumn_ makes a website-managed column look different: a note on its title
// and gray-brown italic text below it, so the teacher can see it isn't meant for typing in.
function highlightAutoManagedColumn_(sheet, columnIndex, columnName) {
  var maxRows = Math.max(sheet.getMaxRows(), 2);

  // Attach the hover note to the column's title cell.
  sheet.getRange(1, columnIndex)
    .setNote(AUTO_MANAGED_HEADER_NOTE);

  // Append "(auto)" marker to the visible header without changing the
  // canonical column name (header lookups use the raw value, so we keep
  // the original text and use a note instead — no value rewrite).

  // Color every cell below the title in muted colors and italics.
  sheet.getRange(2, columnIndex, maxRows - 1, 1)
    .setBackground(FMT_AUTO_COLUMN_BG)
    .setFontColor(FMT_AUTO_COLUMN_TEXT)
    .setFontStyle("italic");
}

/**
 * Warning-only protection on an auto-managed column. Anyone editing the
 * cells gets a confirm dialog explaining that the dashboard owns this
 * data — they can override, but the next create/cancel will rewrite it.
 *
 * Idempotent: removes any prior protection with the same description
 * before adding a fresh one, so re-running setup never stacks up
 * duplicate protections on the same range.
 */
// protectAutoManagedColumn_ puts a soft lock on a website-managed column: anyone who edits it
// sees a warning box first. They can still go ahead, but the website may overwrite the change.
function protectAutoManagedColumn_(sheet, columnIndex) {
  // Select every cell in the column below the title.
  var maxRows = Math.max(sheet.getMaxRows(), 2);
  var range = sheet.getRange(2, columnIndex, maxRows - 1, 1);

  // Remove any earlier warning this script put on the same column, so they don't pile up.
  var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < existing.length; i++) {
    var p = existing[i];
    if (p.getDescription() === AUTO_MANAGED_PROTECTION_DESCRIPTION) {
      var r = p.getRange();
      if (r.getColumn() === columnIndex && r.getNumColumns() === 1) {
        p.remove();
      }
    }
  }

  // Add a fresh warning-only lock with the standard message.
  range.protect()
    .setDescription(AUTO_MANAGED_PROTECTION_DESCRIPTION)
    .setWarningOnly(true);
}
