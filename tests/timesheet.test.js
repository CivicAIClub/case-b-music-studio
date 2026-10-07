// Tests for Phase 6 (the payroll time sheet) in apps-script/Code.gs. Code.gs runs inside Node
// with pretend Google services (tests/helpers). Every name, email and ID is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate } from "./helpers/gas-sandbox.js";
import {
  buildWorld, defaultTabs, lookupTabs, tab2026, exampleRows, day, lesson, keyOf,
  STUDENTS, SECRET, TIMESHEET_ID, TIMESHEET_URL, YEAR_HEADERS,
} from "./helpers/world.js";

const { avery, jordan, casey, riley, morgan, quinn } = STUDENTS;
const VERSION = "2026-10-06 phase 6 time sheet";
const NO_EARLIER_LESSON_1 =
  "No earlier lessons for this student this term, so this is lesson 1. If that's wrong, the name may be spelled differently on the time sheet.";

// The default tabs with a 2026-2027 tab (holding the five example rows) in front.
const withTab2026 = (rows = exampleRows(), extra = {}) => [tab2026(rows, extra), ...defaultTabs()];

// A regular 45-minute lesson for Avery on Oct 15, 2026, and a 90-minute (double) one on Oct 16.
const averyRegular = lesson(avery, "2026-10-15", "Lunch", "12:00 PM", "12:45 PM");
const averyDouble = lesson(avery, "2026-10-16", "Lunch", "12:00 PM", "1:30 PM");

// ─── Settings and status ────────────────────────────────────────────────────────────────

test("status: not connected when both Script Properties are missing, and it names them", () => {
  const w = buildWorld({ props: { SHARED_SECRET: SECRET } });
  const r = w.post("timesheet-status");
  assert.equal(r.ok, true);
  assert.equal(r.configured, false);
  assert.equal(
    r.reason,
    "The TIMESHEET_SPREADSHEET_ID Script Property isn't set, and the TIMESHEET_START_DATE Script Property isn't set."
  );
  assert.equal(r.codeVersion, VERSION);
  assert.equal(r.sheetUrl, null);
  assert.equal(w.fakes.openCalls.length, 0);
});

test("status: names only the missing setting, and explains a badly written start date", () => {
  let w = buildWorld({ props: { SHARED_SECRET: SECRET, TIMESHEET_SPREADSHEET_ID: TIMESHEET_ID } });
  assert.equal(w.post("timesheet-status").reason, "The TIMESHEET_START_DATE Script Property isn't set.");

  w = buildWorld({ props: { SHARED_SECRET: SECRET, TIMESHEET_START_DATE: "2026-09-01" } });
  let r = w.post("timesheet-status");
  assert.equal(r.reason, "The TIMESHEET_SPREADSHEET_ID Script Property isn't set.");
  assert.equal(r.startDate, "2026-09-01");

  w = buildWorld({ props: { SHARED_SECRET: SECRET, TIMESHEET_SPREADSHEET_ID: TIMESHEET_ID, TIMESHEET_START_DATE: "10/5/2026" } });
  r = w.post("timesheet-status");
  assert.equal(r.configured, false);
  assert.equal(r.reason, 'TIMESHEET_START_DATE should be a date written like 2026-10-05, not "10/5/2026".');
});

test("status: connected with the ID given as a full Sheets URL; lists keep their types", () => {
  const w = buildWorld();
  const r = w.post("timesheet-status");
  assert.equal(r.configured, true);
  assert.equal(r.reason, undefined);
  assert.deepEqual(w.fakes.openCalls, [TIMESHEET_ID]);
  assert.equal(r.sheetUrl, TIMESHEET_URL);
  assert.equal(r.sheetTitle, "Payroll Time Sheet (test copy)");
  assert.equal(r.targetTab, "2026-2027");
  assert.equal(r.targetTabExists, false);
  assert.equal(r.startDate, "2026-09-01");
  assert.equal(r.codeVersion, VERSION);
  assert.deepEqual(r.lists.lessonNo, [1, 2, 3, 4, 5, 6, 7, 8, 9, "Double", "Late Cancel", "No Show"]);
  assert.deepEqual(r.lists.hours, [0.75]);
  assert.deepEqual(r.lists.instrument, ["Guitar", "Bass", "Ukulele"]);
  assert.equal(r.lists.block.length, 19);
  assert.ok(r.lists.block.includes("1PM  Shadow Block"));
});

test("status: a time sheet the script can't open is 'not connected', with the sharing fix", () => {
  const w = buildWorld({ props: { SHARED_SECRET: SECRET, TIMESHEET_SPREADSHEET_ID: "SOME-OTHER-SHEET-ID", TIMESHEET_START_DATE: "2026-09-01" } });
  const r = w.post("timesheet-status");
  assert.equal(r.configured, false);
  assert.match(r.reason, /share the time sheet as Editor with the Google account the web app runs as/);
});

test("ping returns CODE_VERSION; a wrong secret is refused", () => {
  const w = buildWorld();
  assert.equal(w.post("ping").codeVersion, VERSION);
  const out = w.ctx.doPost({ postData: { contents: JSON.stringify({ action: "timesheet-status", secret: "wrong" }) } });
  assert.deepEqual(JSON.parse(out.getContent()), { ok: false, error: "Unauthorized" });
});

test("authorize: CODE_VERSION on the first line, then plain OK lines for the time sheet", () => {
  const w = buildWorld();
  w.ctx.authorize();
  assert.equal(w.logs[0], "Code version: " + VERSION);
  assert.ok(w.logs.includes(
    'OK TIMESHEET_SPREADSHEET_ID: "Payroll Time Sheet (test copy)", tab 2026-2027 (not there yet; it will be created just before 2025-2026 on the first add)'
  ), w.logs.join("\n"));
  assert.ok(w.logs.includes("Time sheet lists: Lesson No. 12, Block 19, hours 1, Instrument 3"));
  assert.ok(w.logs.includes("OK TIMESHEET_START_DATE: 2026-09-01"));
  assert.match(w.logs[w.logs.length - 1], /^Authorization complete/);

  const w2 = buildWorld({ tabs: withTab2026() });
  w2.ctx.authorize();
  assert.ok(w2.logs.includes('OK TIMESHEET_SPREADSHEET_ID: "Payroll Time Sheet (test copy)", tab 2026-2027'));
});

test("authorize: says plainly when a setting is missing or the sheet can't be opened", () => {
  const w = buildWorld({ props: { SHARED_SECRET: SECRET } });
  w.ctx.authorize();
  assert.equal(w.logs[0], "Code version: " + VERSION);
  assert.ok(w.logs.some((l) => l.startsWith("PROBLEM TIMESHEET_SPREADSHEET_ID: not set.")));
  assert.ok(w.logs.some((l) => l.startsWith("PROBLEM TIMESHEET_START_DATE: not set.")));

  const w2 = buildWorld({ props: { SHARED_SECRET: SECRET, TIMESHEET_SPREADSHEET_ID: "SOME-OTHER-SHEET-ID", TIMESHEET_START_DATE: "2026-09-01" } });
  w2.ctx.authorize();
  assert.ok(w2.logs.includes(
    "PROBLEM TIMESHEET_SPREADSHEET_ID: can't open it: share the time sheet as Editor with the Google account this script runs as (script.owner@example.org)."
  ), w2.logs.join("\n"));
  assert.ok(w2.logs.includes("OK TIMESHEET_START_DATE: 2026-09-01"));
});

// ─── Lesson numbering ───────────────────────────────────────────────────────────────────

test("numbering: the five example rows give Avery lesson 5 and Jordan lesson 3", () => {
  const jordanLesson = lesson(jordan, "2026-10-15", "C Block", "3:00 PM", "3:45 PM");
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular, jordanLesson] });

  const a = w.post("preview-timesheet-row", keyOf(averyRegular));
  assert.equal(a.ok, true, a.error);
  // 1, then Double (+2 = 3), then 4 (typed as text "9/24/2026" in column A), so next is 5.
  assert.deepEqual(a.row, ["10/15/2026", 5, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.equal(a.tab, "2026-2027");
  assert.equal(a.createsTab, false);
  assert.equal(a.addsTermLabel, false);
  assert.deepEqual(a.warnings, []);

  // No Show leaves the count at 0, then 2, so next is 3.
  const j = w.post("preview-timesheet-row", keyOf(jordanLesson));
  assert.deepEqual(j.row, ["10/15/2026", 3, "Jordan", "Test", "C", 0.75, "Bass"]);
  assert.deepEqual(j.warnings, []);
});

test("numbering: a blank lesson number and Late Cancel leave the count unchanged", () => {
  const rows = exampleRows().concat([
    [day("2026-10-01"), "Late Cancel", "Avery", "Sample", "Lunch", 0.75, "Guitar"],
    [day("2026-10-08"), "", "Avery", "Sample", "Lunch", 0.75, "Guitar"],
  ]);
  const w = buildWorld({ tabs: withTab2026(rows), lessons: [averyRegular] });
  assert.equal(w.post("preview-timesheet-row", keyOf(averyRegular)).row[1], 5);
});

test("numbering: a new term starts at lesson 1 under a 'Winter 2026-27' label row", () => {
  const winter1 = lesson(avery, "2026-12-15", "Lunch", "12:00 PM", "12:45 PM");
  const winter2 = lesson(avery, "2026-12-17", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ now: "2026-12-20T20:00:00-05:00", tabs: withTab2026(), lessons: [winter1, winter2] });

  const p = w.post("preview-timesheet-row", keyOf(winter1));
  assert.equal(p.row[1], 1);
  assert.equal(p.addsTermLabel, true);
  assert.equal(p.termLabel, "Winter 2026-27");
  assert.ok(p.warnings.includes(NO_EARLIER_LESSON_1));

  const r = w.post("add-timesheet-row", keyOf(winter1));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.labelRowNumber, 11);
  assert.equal(r.rowNumber, 12);
  const shown = w.shown("2026-2027");
  assert.deepEqual(shown[10], ["Winter 2026-27"]);
  assert.deepEqual(shown[11], ["12/15/2026", 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);

  // The term's second lesson: no second label, and the count goes on.
  const r2 = w.post("add-timesheet-row", keyOf(winter2));
  assert.equal(r2.labelRowNumber, null);
  assert.equal(r2.rowNumber, 13);
  assert.deepEqual(w.shown("2026-2027")[12], ["12/17/2026", 2, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
});

test("numbering: a new school year starts over (last year's tab doesn't count)", () => {
  const w = buildWorld({ lessons: [averyRegular] }); // no 2026-2027 tab yet
  const p = w.post("preview-timesheet-row", keyOf(averyRegular));
  assert.equal(p.ok, true, p.error);
  assert.equal(p.tab, "2026-2027");
  assert.equal(p.createsTab, true);
  assert.equal(p.insertBefore, "2025-2026");
  assert.equal(p.addsTermLabel, true);
  assert.equal(p.termLabel, "Fall 2026");
  assert.deepEqual(p.row, ["10/15/2026", 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.ok(p.warnings.includes(NO_EARLIER_LESSON_1));
});

test("numbering: a 90-minute lesson is a Double with 1.5 hours (a number), with a note", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyDouble] });
  const p = w.post("preview-timesheet-row", keyOf(averyDouble));
  assert.deepEqual(p.row, ["10/16/2026", "Double", "Avery", "Sample", "Lunch", 1.5, "Guitar"]);
  assert.ok(p.warnings.some((x) => x.startsWith("1.5 isn't on the time sheet's hours list.")));

  const r = w.post("add-timesheet-row", keyOf(averyDouble));
  assert.equal(r.ok, true, r.error);
  assert.equal(w.tab("2026-2027").valueAt(r.rowNumber, 6), 1.5);
  assert.equal(w.tab("2026-2027").valueAt(r.rowNumber, 2), "Double");
});

test("numbering: past the end of the Lesson No. list is flagged and left for him to pick", () => {
  const rows = [["Fall 2026"]];
  for (let n = 1; n <= 9; n++) {
    rows.push([day(`2026-09-${String(n + 1).padStart(2, "0")}`), n, "Casey", "Demo", "D", 0.75, "Ukulele"]);
  }
  const c = lesson(casey, "2026-10-15", "D Block", "8:00 AM", "8:45 AM");
  const w = buildWorld({ tabs: withTab2026(rows), lessons: [c] });
  const p = w.post("preview-timesheet-row", keyOf(c));
  assert.equal(p.row[1], "");
  assert.ok(p.warnings.includes(
    "By the time sheet's count this would be lesson 10, but the Lesson No. list stops at 9. Pick the lesson number."
  ));
});

// ─── Column A: label rows, text dates, term label rows ─────────────────────────────────

test("labels: a hand-typed 'Winter TERM' label below the last lesson means no second label", () => {
  const rows = exampleRows().concat([[], ["Holiday Break"], ["Winter TERM"]]);
  const winter = lesson(avery, "2026-12-15", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ now: "2026-12-20T20:00:00-05:00", tabs: withTab2026(rows), lessons: [winter] });
  const p = w.post("preview-timesheet-row", keyOf(winter));
  assert.equal(p.addsTermLabel, false);
  const r = w.post("add-timesheet-row", keyOf(winter));
  assert.equal(r.rowNumber, 14);
  assert.deepEqual(w.shown("2026-2027")[12], ["Winter TERM"]);
  assert.deepEqual(w.shown("2026-2027")[13], ["12/15/2026", 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
});

test("labels: 'End of Spring' and 'Holiday Break' rows are skipped, text dates count", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular] });
  const rows = w.ctx.readYearTabRows(w.tab("2026-2027"), "America/New_York");
  const dated = rows.filter((r) => r.dateKey).map((r) => r.dateKey);
  assert.deepEqual(Array.from(dated), ["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01", "2026-10-08"]);
  assert.equal(w.ctx.timesheetDateKey("Week 1", "America/New_York"), null);
  assert.equal(w.ctx.timesheetDateKey("End of Spring 2025", "America/New_York"), null);
  assert.equal(w.ctx.timesheetDateKey("2/30/2026", "America/New_York"), null);
  assert.equal(w.ctx.timesheetDateKey("9/10/2026", "America/New_York"), "2026-09-10");
});

test("terms and tabs: Fall, Winter and Spring dates map to the right label and school-year tab", () => {
  const w = buildWorld();
  const cases = [
    ["2026-08-01", "Fall 2026", "2026-2027"],
    ["2026-11-30", "Fall 2026", "2026-2027"],
    ["2026-12-01", "Winter 2026-27", "2026-2027"],
    ["2027-02-28", "Winter 2026-27", "2026-2027"],
    ["2027-03-01", "Spring 2027", "2026-2027"],
    ["2027-07-31", "Spring 2027", "2026-2027"],
    ["2027-08-01", "Fall 2027", "2027-2028"],
  ];
  for (const [key, label, tab] of cases) {
    assert.equal(w.ctx.termFor(key).label, label, key);
    assert.equal(w.ctx.schoolYearTabName(key), tab, key);
  }
});

// ─── Tabs: exact names, CHAPEL tabs, creating a new school-year tab ─────────────────────

test("tabs: a new 2026-2027 tab is made just before 2025-2026, copying header, panes, widths and B/E/F/G dropdowns", () => {
  const chapel = { name: "2026-2027 (CHAPEL/MISC.)", rows: [[day("2026-09-06"), "Chapel service", "", "", "", 50]] };
  const w = buildWorld({ tabs: [chapel, ...defaultTabs()], lessons: [averyRegular] });
  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.createdTab, true);
  assert.equal(r.labelRowNumber, 2);
  assert.equal(r.rowNumber, 3);

  // Exact names only: the CHAPEL tabs were neither used nor touched.
  assert.deepEqual(w.ts.getSheets().map((s) => s.getName()).slice(0, 4),
    ["2026-2027 (CHAPEL/MISC.)", "2025-2026 (CHAPEL/MISC.)", "2026-2027", "2025-2026"]);
  assert.ok(w.ts.writes.every((x) => !String(x.sheet || "").includes("CHAPEL")));
  assert.deepEqual(w.shown("2026-2027 (CHAPEL/MISC.)")[1], ["9/6/2026", "Chapel service", "", "", "", 50]);

  const tab = w.tab("2026-2027");
  const template = w.tab("2025-2026");
  assert.deepEqual(w.shown("2026-2027"), [
    YEAR_HEADERS,
    ["Fall 2026"],
    ["10/15/2026", 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"],
  ]);
  assert.equal(tab.peek(1, 1).style.fontWeight, "bold");
  assert.equal(tab.peek(1, 9).style.background, "#d9ead3");
  assert.equal(tab.getFrozenRows(), 1);
  assert.equal(tab.getFrozenColumns(), 2);
  for (let c = 1; c <= 9; c++) assert.equal(tab.getColumnWidth(c), template.getColumnWidth(c));
  for (const col of [2, 5, 6, 7]) {
    assert.equal(tab.peek(2, col).rule, template.peek(6, col).rule, "column " + col);
    assert.equal(tab.peek(1000, col).rule, template.peek(6, col).rule, "column " + col);
  }
  assert.equal(tab.peek(3, 3).rule, null);
  assert.equal(tab.peek(3, 4).rule, null);
});

test("tabs: a Spring 2026 lesson goes on 2025-2026, never its CHAPEL tab (which comes first)", () => {
  const spring = lesson(avery, "2026-03-19", "Lunch", "12:00 PM", "12:45 PM");
  const props = { SHARED_SECRET: SECRET, TIMESHEET_SPREADSHEET_ID: TIMESHEET_ID, TIMESHEET_START_DATE: "2026-01-01" };
  const w = buildWorld({ now: "2026-03-20T20:00:00-04:00", props, lessons: [spring] });
  const r = w.post("add-timesheet-row", keyOf(spring));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tab, "2025-2026");
  assert.equal(r.rowNumber, 8);
  assert.equal(r.labelRowNumber, null);
  assert.deepEqual(w.shown("2025-2026")[7], ["3/19/2026", 4, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.deepEqual(w.shown("2025-2026 (CHAPEL/MISC.)"), [YEAR_HEADERS, ["3/1/2026", "Chapel service", "", "", "", 50]]);
});

// ─── Block, instrument and name ────────────────────────────────────────────────────────

test("block: 'C Block' becomes C, list values pass through, unknown blocks are left to pick", () => {
  const lessons = [
    lesson(avery, "2026-10-13", "C Block", "8:00 AM", "8:45 AM"),
    lesson(jordan, "2026-10-13", "Lunch", "12:00 PM", "12:45 PM"),
    lesson(casey, "2026-10-13", "1PM Shadow Block", "1:00 PM", "1:45 PM"),
    lesson(riley, "2026-10-13", "Study Hall", "2:00 PM", "2:45 PM"),
  ];
  const w = buildWorld({ tabs: withTab2026(), lessons });
  const blocks = lessons.map((l) => w.post("preview-timesheet-row", keyOf(l)));
  assert.deepEqual(blocks.map((p) => p.row[4]), ["C", "Lunch", "1PM  Shadow Block", ""]);
  assert.ok(blocks[3].warnings.includes(
    "The Lesson Schedule says \"Study Hall\", which isn't on the time sheet's Block list, so Block is blank. Pick one."
  ));
});

test("instrument: mapped from the latest form answer onto the Instrument list", () => {
  const students = [avery, jordan, casey, riley, morgan, quinn];
  const lessons = students.map((s) => lesson(s, "2026-10-13", "Lunch", "12:00 PM", "12:45 PM"));
  const w = buildWorld({ tabs: withTab2026(), lessons });
  const subjects = lessons.map((l) => w.post("preview-timesheet-row", keyOf(l)));
  // Electric guitar, bass guitar, Ukulele, uke, Drums, "guitar and bass"
  assert.deepEqual(subjects.map((p) => p.row[6]), ["Guitar", "Bass", "Ukulele", "Ukulele", "", ""]);
  assert.ok(subjects[4].warnings.some((x) => x.startsWith('The sign-up form says "Drums"')));
  assert.ok(subjects[5].warnings.some((x) => x.startsWith('The sign-up form says "guitar and bass"')));

  // A later submission wins; a later blank answer doesn't erase an earlier one.
  const t1 = new Date("2026-08-20T13:00:00Z");
  const formRows = [
    [t1, avery.email, avery.name, "Bass"],
    [t1, avery.email, avery.name, "acoustic guitar"],
    [t1, avery.email, avery.name, ""],
  ];
  const w2 = buildWorld({ tabs: withTab2026(), lessons: [averyRegular], formRows });
  assert.equal(w2.post("preview-timesheet-row", keyOf(averyRegular)).row[6], "Guitar");
});

test("names: split at the first space, with a warning when it isn't exactly two words", () => {
  const unknown = { email: "new.student@example.org", name: "Taylor Example" };
  const lessons = [
    lesson(morgan, "2026-10-13", "Lunch", "12:00 PM", "12:45 PM"),
    lesson(quinn, "2026-10-13", "Lunch", "1:00 PM", "1:45 PM"),
    lesson(unknown, "2026-10-13", "Lunch", "2:00 PM", "2:45 PM"),
  ];
  const w = buildWorld({ tabs: withTab2026(), lessons });
  const [m, q, u] = lessons.map((l) => w.post("preview-timesheet-row", keyOf(l)));
  assert.deepEqual([m.row[2], m.row[3]], ["Morgan", "Ann Fake"]);
  assert.ok(m.warnings.includes(
    'The name "Morgan Ann Fake" has 3 words, so it was split as first name "Morgan" and last name "Ann Fake". Check that it matches the time sheet.'
  ));
  assert.deepEqual([q.row[2], q.row[3]], ["Quinn", ""]);
  assert.ok(q.warnings.includes('The name "Quinn" is one word, so the last name is blank. Type it before adding.'));
  // Not on the sign-up form: the Lesson Schedule's Student Name is used.
  assert.deepEqual([u.row[2], u.row[3]], ["Taylor", "Example"]);
});

test("names: if C/D dropdowns use the First Name / Last Name tabs, a new name is a warning, not a block", () => {
  const r1 = lesson(riley, "2026-10-15", "Lunch", "2:00 PM", "2:45 PM");
  const w = buildWorld({ tabs: withTab2026(exampleRows(), { nameDropdowns: true }), lessons: [r1, averyRegular] });
  const p = w.post("preview-timesheet-row", keyOf(r1));
  assert.ok(p.warnings.some((x) => x.startsWith("\"Riley\" isn't on the First Name list that column C's dropdown uses")));
  assert.ok(p.warnings.some((x) => x.startsWith("\"Mock\" isn't on the Last Name list that column D's dropdown uses")));
  assert.equal(w.post("add-timesheet-row", keyOf(r1)).ok, true);
  // The lists themselves are never written.
  assert.ok(w.ts.writes.every((x) => x.sheet !== "First Name" && x.sheet !== "Last Name"));
  // A name that is on both lists gets no such warning.
  const a = w.post("preview-timesheet-row", keyOf(averyRegular));
  assert.ok(!a.warnings.some((x) => x.includes("First Name list") || x.includes("Last Name list")));
});

test("hours: no end time or an unusual length is 0.75, with a warning", () => {
  const noEnd = lesson(avery, "2026-10-13", "Lunch", "12:00 PM", "");
  const hour = lesson(jordan, "2026-10-13", "Lunch", "12:00 PM", "1:00 PM");
  const w = buildWorld({ tabs: withTab2026(), lessons: [noEnd, hour] });
  const a = w.post("preview-timesheet-row", keyOf(noEnd));
  assert.equal(a.row[5], 0.75);
  assert.ok(a.warnings.includes("This lesson has no end time on the Lesson Schedule, so it's counted as a regular lesson (0.75 hours)."));
  const b = w.post("preview-timesheet-row", keyOf(hour));
  assert.equal(b.row[5], 0.75);
  assert.ok(b.warnings.some((x) => x.startsWith("This lesson is 60 minutes long.")));
});

test("a missing lookup tab is a warning, and its column is left blank", () => {
  const tabs = withTab2026().filter((t) => t.name !== "Instrument");
  const w = buildWorld({ tabs, lessons: [averyRegular] });
  const p = w.post("preview-timesheet-row", keyOf(averyRegular));
  assert.equal(p.row[6], "");
  assert.ok(p.warnings.includes("The time sheet has no \"Instrument\" tab, so that column can't be checked against its dropdown list."));
});

// ─── Adding ─────────────────────────────────────────────────────────────────────────────

test("add: appends one A-G row below the last used row, with the right types, and marks the lesson", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular] });
  const before = w.shown("2026-2027");
  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.alreadyThere, false);
  assert.equal(r.tab, "2026-2027");
  assert.equal(r.rowNumber, 11);
  assert.equal(r.labelRowNumber, null);
  assert.equal(r.createdTab, false);
  assert.deepEqual(r.row, ["10/15/2026", 5, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.equal(r.mark, "Added 10/20/2026");

  // Exactly one write of values: row 11, columns A to G.
  const writes = w.valueWrites();
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].sheet, writes[0].row, writes[0].col, writes[0].numRows, writes[0].numCols], ["2026-2027", 11, 1, 1, 7]);
  // Existing rows untouched; H and I blank.
  assert.deepEqual(w.shown("2026-2027").slice(0, 10), before);
  const tab = w.tab("2026-2027");
  assert.equal(tab.valueAt(11, 8), "");
  assert.equal(tab.valueAt(11, 9), "");
  // Same types as the lists: the number 5, the number 0.75.
  assert.equal(typeof tab.valueAt(11, 2), "number");
  assert.equal(typeof tab.valueAt(11, 6), "number");
  // Column A: a real date at midnight in the time sheet's time zone, shown as M/d/yyyy.
  const a = tab.valueAt(11, 1);
  assert.ok(a instanceof Date);
  assert.equal(formatDate(a, "America/New_York", "yyyy-MM-dd HH:mm:ss"), "2026-10-15 00:00:00");
  assert.equal(tab.peek(11, 1).format, "M/d/yyyy");

  // The Lesson Schedule's new Time Sheet column: created, grayed, warning-protected, marked.
  const headers = w.schedule.getRange(1, 1, 1, w.schedule.getLastColumn()).getValues()[0];
  assert.equal(headers[10], "Time Sheet");
  assert.equal(w.mark(0), "Added 10/20/2026");
  assert.equal(w.schedule.peek(2, 11).style.fontStyle, "italic");
  assert.ok(w.schedule.getProtections().some((p) => p.getRange().getColumn() === 11 && p.warningOnly));

  // Adding the same lesson again finds its row and adds nothing.
  const again = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(again.ok, true);
  assert.equal(again.alreadyThere, true);
  assert.equal(w.valueWrites().length, 1);
});

test("add: the date can't land a day early when the time sheet is in another time zone", () => {
  const w = buildWorld({ timesheetTz: "Pacific/Honolulu", tabs: withTab2026(), lessons: [averyRegular] });
  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  // The example rows were read in Honolulu time too, so the count is still right.
  assert.equal(r.row[1], 5);
  const a = w.tab("2026-2027").valueAt(r.rowNumber, 1);
  assert.equal(formatDate(a, "Pacific/Honolulu", "yyyy-MM-dd HH:mm:ss"), "2026-10-15 00:00:00");
});

test("add: refuses a duplicate (same date and student already on the tab) and only writes the mark", () => {
  const rows = exampleRows().concat([[day("2026-10-15"), 5, "avery", " Sample ", "Lunch", 0.75, "Guitar"]]);
  const w = buildWorld({ tabs: withTab2026(rows), lessons: [averyRegular] });
  const p = w.post("preview-timesheet-row", keyOf(averyRegular));
  assert.deepEqual(p.duplicate, { rowNumber: 11, cells: ["10/15/2026", 5, "avery", " Sample ", "Lunch", 0.75, "Guitar"] });
  assert.equal(p.warnings[0], "This lesson is already on 2026-2027 (row 11). Adding won't create a second row; it only marks the lesson as added.");
  assert.equal(p.addsTermLabel, false);

  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.alreadyThere, true);
  assert.equal(r.rowNumber, 11);
  assert.equal(w.valueWrites().length, 0);
  assert.equal(w.mark(0), "Added 10/20/2026");
});

test("add: retry after the row went in but the mark didn't (no second row)", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular] });
  // Make the lesson's Time Sheet cell (row 2, column 11) refuse the first write.
  w.schedule.failWrite = (row, col) => (row === 2 && col === 11 ? "Exception: Service Spreadsheets timed out" : null);
  const first = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(first.ok, false);
  assert.equal(first.error,
    "The row is on 2026-2027 (row 11), but the Lesson Schedule couldn't be marked (Service Spreadsheets timed out). Trying again is safe: the tool will see the row is already there and only write the mark.");
  assert.equal(w.valueWrites().length, 1);
  assert.equal(w.mark(0), "");

  w.schedule.failWrite = null;
  const retry = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.alreadyThere, true);
  assert.equal(retry.rowNumber, 11);
  assert.equal(w.valueWrites().length, 1);
  assert.equal(w.mark(0), "Added 10/20/2026");
});

test("add: a lesson marked Added whose row is gone, or marked Skipped, is refused", () => {
  const added = Object.assign({}, averyRegular, { mark: "Added 10/16/2026" });
  const skipped = lesson(jordan, "2026-10-15", "C Block", "3:00 PM", "3:45 PM", { mark: "Skipped" });
  const w = buildWorld({ tabs: withTab2026(), lessons: [added, skipped], timeSheetColumn: true });
  const a = w.post("add-timesheet-row", keyOf(added));
  assert.equal(a.ok, false);
  assert.match(a.error, /^This lesson is already marked "Added 10\/16\/2026" on the Lesson Schedule, but no row for it was found on 2026-2027/);
  const s = w.post("add-timesheet-row", keyOf(skipped));
  assert.equal(s.ok, false);
  assert.match(s.error, /^This lesson is marked "Skipped" on the Lesson Schedule\./);
  assert.equal(w.valueWrites().length, 0);
});

test("add: lessons before TIMESHEET_START_DATE are never offered (preview and add both refuse)", () => {
  const early = lesson(avery, "2026-08-28", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ tabs: withTab2026(), lessons: [early] });
  const message = "This lesson (8/28/2026) is dated before TIMESHEET_START_DATE (9/1/2026). Lessons before that date were typed into the time sheet by hand, so the tool doesn't offer them.";
  assert.deepEqual(w.post("preview-timesheet-row", keyOf(early)), { ok: false, error: message });
  assert.deepEqual(w.post("add-timesheet-row", keyOf(early)), { ok: false, error: message });
  assert.equal(w.ts.writes.length, 0);
  assert.equal(w.mark(0), "");
});

test("add: future and cancelled lessons are refused", () => {
  const future = lesson(avery, "2026-10-22", "Lunch", "12:00 PM", "12:45 PM");
  const cancelled = lesson(jordan, "2026-10-15", "C Block", "3:00 PM", "3:45 PM", { status: "Cancelled" });
  const w = buildWorld({ tabs: withTab2026(), lessons: [future, cancelled] });
  assert.match(w.post("add-timesheet-row", keyOf(future)).error, /hasn't happened yet/);
  assert.match(w.post("add-timesheet-row", keyOf(cancelled)).error, /marked Cancelled/);
  assert.equal(w.ts.writes.length, 0);
});

test("add: values changed in the preview win, are matched to the list's own copy, and can't be formulas", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular] });
  // Different names re-count lessons for that name (what "Check again" shows).
  const p = w.post("preview-timesheet-row", Object.assign(keyOf(averyRegular), { overrides: { firstName: "Jordan", lastName: "Test" } }));
  assert.equal(p.row[1], 3);

  const bad = w.post("add-timesheet-row", Object.assign(keyOf(averyRegular), { overrides: { firstName: "=IMPORTRANGE(1)" } }));
  assert.deepEqual(bad, { ok: false, error: 'First name can\'t start with "=".' });

  const overrides = { lessonNo: "6", firstName: "  Avery ", lastName: "Sample", block: "lunch", hours: "0.75", subject: "guitar" };
  const r = w.post("add-timesheet-row", Object.assign(keyOf(averyRegular), { overrides }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.row, ["10/15/2026", 6, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.equal(typeof w.tab("2026-2027").valueAt(r.rowNumber, 2), "number");
});

// ─── Strict ("Reject input") dropdowns ──────────────────────────────────────────────────

test("strict dropdowns: a refused write comes back as one plain-English sentence, nothing added or marked", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyDouble], rejectInvalidScriptWrites: true });
  const r = w.post("add-timesheet-row", keyOf(averyDouble));
  assert.equal(r.ok, false);
  assert.equal(r.error,
    "Google Sheets refused this row because a value isn't allowed by the time sheet's dropdowns (Total Hours 1.5). " +
    "Pick values from the dropdowns, or add the value to the matching list on the time sheet. " +
    "Nothing was added, and the lesson wasn't marked. " +
    "(Google said: The data you entered in cell F11 violates the data validation rules set on this cell.)");
  assert.ok(!r.error.includes("\n"));
  assert.equal(w.tab("2026-2027").getLastRow(), 10);
  assert.equal(w.mark(0), "");
});

test("strict dropdowns: values taken from the lists (numbers as numbers) are accepted", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular], rejectInvalidScriptWrites: true });
  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rowNumber, 11);
});

// ─── Skipping, and the never-touch rules ────────────────────────────────────────────────

test("skip: marks the lesson Skipped and never opens the time sheet (even when not connected)", () => {
  const w = buildWorld({ props: { SHARED_SECRET: SECRET }, lessons: [averyRegular] });
  const r = w.post("skip-timesheet-row", keyOf(averyRegular));
  assert.deepEqual(r, { ok: true, skipped: true, mark: "Skipped" });
  assert.equal(w.mark(0), "Skipped");
  assert.equal(w.fakes.openCalls.length, 0);
  assert.equal(w.ts.writes.length, 0);
  // Skipping again changes nothing.
  assert.equal(w.post("skip-timesheet-row", keyOf(averyRegular)).ok, true);
});

test("skip: a lesson already marked Added keeps its mark", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular] });
  assert.equal(w.post("add-timesheet-row", keyOf(averyRegular)).ok, true);
  const r = w.post("skip-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'This lesson is already marked "Added 10/20/2026", so there is nothing to skip.');
  assert.equal(w.mark(0), "Added 10/20/2026");
});

test("H and I are never written, and only school-year tabs are ever changed", () => {
  const winter = lesson(jordan, "2026-12-15", "C Block", "3:00 PM", "4:30 PM");
  const lessons = [averyRegular, averyDouble, winter, lesson(riley, "2026-10-14", "E Block", "9:00 AM", "9:45 AM")];
  const w = buildWorld({ now: "2026-12-20T20:00:00-05:00", lessons });
  for (const l of lessons) w.post("add-timesheet-row", keyOf(l));
  assert.ok(w.ts.writes.length > 0);
  // A short description of a write for failure messages (dropdown rules point back at sheets).
  const describe = (x) => JSON.stringify(Object.assign({}, x, { rule: undefined }));
  for (const x of w.ts.writes) {
    if (x.kind === "insertSheet") {
      assert.equal(x.sheet, "2026-2027");
      continue;
    }
    assert.match(String(x.sheet), /^\d{4}-\d{4}$/, describe(x));
    if (x.kind === "values") {
      assert.ok(x.row >= 2, describe(x));
      assert.ok(x.col === 1 && x.col + x.numCols - 1 <= 7, describe(x));
    }
    if (x.kind === "copy") assert.equal(x.row, 1);
  }
  const tab = w.tab("2026-2027");
  for (let r = 2; r <= tab.getLastRow(); r++) {
    assert.equal(tab.valueAt(r, 8), "");
    assert.equal(tab.valueAt(r, 9), "");
  }
});

test("setupSheetFormatting adds and protects the Time Sheet column like Calendar Event ID", () => {
  const w = buildWorld({ lessons: [averyRegular] });
  assert.ok(Array.from(w.ctx.AUTO_MANAGED_LESSON_COLUMNS).includes("Time Sheet"));
  w.ctx.setupSheetFormatting();
  const headers = w.schedule.getRange(1, 1, 1, w.schedule.getLastColumn()).getValues()[0];
  const col = headers.indexOf("Time Sheet") + 1;
  assert.equal(col, 11);
  const protection = w.schedule.getProtections().find((p) => p.getRange().getColumn() === col);
  assert.ok(protection && protection.warningOnly);
  assert.equal(protection.getDescription(), "Auto-managed by the Music Studio dashboard. Please don't edit.");
  assert.ok(w.schedule.peek(1, col).note);
});

test("lookup and CHAPEL tabs are only ever read", () => {
  const w = buildWorld({ tabs: withTab2026(), lessons: [averyRegular, averyDouble] });
  w.post("timesheet-status");
  w.post("preview-timesheet-row", keyOf(averyDouble));
  w.post("add-timesheet-row", keyOf(averyRegular));
  const untouchable = lookupTabs().map((t) => t.name).concat(["2025-2026 (CHAPEL/MISC.)", "2024-2025 (CHAPEL/MISC.)", "2025-2026", "2024-2025"]);
  assert.ok(w.ts.writes.every((x) => !untouchable.includes(x.sheet)), JSON.stringify(w.ts.writes.map((x) => x.sheet)));
});
