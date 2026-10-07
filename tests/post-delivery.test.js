// Tests for the post-delivery updates in apps-script/Code.gs (after the Oct 7 handoff): where a
// new time sheet row lands, lessons over 45 minutes as doubles, term labels that follow the tab,
// remembered student spellings, the Lesson Schedule dropdowns, the studio-links action, and the
// calendar invite's last line. Every name, email and ID is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorld, defaultTabs, defaultProps, lookupTabs, tab2026, exampleRows, newLayoutTab, newLayoutRows,
  day, lesson, keyOf, STUDENTS, SECRET, TIMESHEET_URL, LISTS, LESSON_HEADERS, NEW_LAYOUT_HEADERS,
  PAY_PERIOD_COLORS, PREMADE_COLOR, STUDIO_TZ,
} from "./helpers/world.js";

const { avery, jordan, morgan } = STUDENTS;
const TEACHER = "teacher.example@example.org";
const NO_ACCESS = "You don't have access to the Music Studio. Ask Mr. O'Neal.";
const OVER_45 = (m) => `This lesson is ${m} minutes. Anything over 45 minutes counts as a double: 1.5 hours, Lesson No. Double.`;
const UNDER_45 = (m) => `This lesson is ${m} minutes, so it's 0.75 hours. If it's make-up time for a double you already logged, click Skip instead.`;
const SAVED_INFO = "Name and subject from your last time sheet row for this student.";

// A regular 45-minute lesson for Avery on Oct 15, 2026 (the clock in these tests is Oct 20).
const averyRegular = lesson(avery, "2026-10-15", "Lunch", "12:00 PM", "12:45 PM");

// The time sheet with a new-layout 2026-2027 tab in front of the usual tabs.
const newLayout = (options) => [newLayoutTab(options), ...defaultTabs()];

// The usual tabs, but with 1.5 on the hours list too (so doubles bring no "not on the list" note).
function tabsWithDoubleHours(front = []) {
  return [...front, ...defaultTabs().map((t) => (t.name === "hours" ? { name: "hours", list: [0.75, 1.5] } : t))];
}

// One value from a sandbox object as plain JSON (sandbox objects have other prototypes).
const plain = (v) => JSON.parse(JSON.stringify(v));

// The rule (dropdown or checkbox) on one cell, or null.
const ruleAt = (sheet, row, col) => sheet.peek(row, col)?.rule ?? null;

// ─── Where a new row lands ──────────────────────────────────────────────────────────────

test("landing row: 3 real rows and 50 pre-made rows → the lesson goes in row 5, H keeps its unticked box, nothing past G is written", () => {
  const w = buildWorld({ tabs: newLayout(), lessons: [averyRegular] });
  const tab = w.tab("2026-2027");
  // Google counts the pre-made rows' FALSE checkboxes as used...
  assert.equal(tab.getLastRow(), 54);
  // ...but the tool doesn't: only the three real rows are read.
  assert.equal(w.ctx.readYearTabRows_(tab, STUDIO_TZ).length, 3);

  const p = w.post("preview-timesheet-row", keyOf(averyRegular));
  assert.equal(p.ok, true, p.error);
  assert.deepEqual(p.row, ["10/15/2026", 3, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.equal(p.addsTermLabel, false);
  assert.equal(p.duplicate, null);
  assert.deepEqual(p.warnings, []);

  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rowNumber, 5);
  assert.equal(r.labelRowNumber, null);

  // One write of values: row 5, columns A to G. No rows were added (the tab didn't end there).
  const writes = w.valueWrites();
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].sheet, writes[0].row, writes[0].col, writes[0].numRows, writes[0].numCols], ["2026-2027", 5, 1, 1, 7]);
  assert.ok(!w.ts.writes.some((x) => x.kind === "insertRows"));
  assert.equal(tab.getMaxRows(), 54);
  assert.deepEqual(w.shown("2026-2027")[4], ["10/15/2026", 3, "Avery", "Sample", "Lunch", 0.75, "Guitar", false]);

  // H keeps its unticked checkbox; I and J stay blank.
  assert.equal(tab.valueAt(5, 8), false);
  assert.equal(ruleAt(tab, 5, 8).getCriteriaType(), "CHECKBOX");
  assert.equal(tab.valueAt(5, 9), "");
  assert.equal(tab.valueAt(5, 10), "");

  // Row 5 now has the look and the rules of lesson row 4, across all ten columns.
  for (let c = 1; c <= NEW_LAYOUT_HEADERS.length; c++) {
    assert.equal(tab.peek(5, c).style.background, PAY_PERIOD_COLORS[1], "column " + c);
    assert.equal(ruleAt(tab, 5, c), ruleAt(tab, 4, c), "column " + c);
  }
  assert.equal(tab.peek(5, 1).style.fontWeight, "bold");
  // The date keeps the row above's date format (it isn't reset to M/d/yyyy).
  assert.equal(tab.peek(5, 1).format, "m/d/yyyy");
  const copies = w.ts.writes.filter((x) => x.kind === "copy");
  assert.deepEqual(copies.map((x) => [x.type, x.fromRow, x.row, x.numCols]),
    [["PASTE_FORMAT", 4, 5, 10], ["PASTE_DATA_VALIDATION", 4, 5, 10]]);

  // The next pre-made row is untouched, and the next lesson goes there.
  assert.equal(tab.peek(6, 1).style.background, PREMADE_COLOR);
  assert.equal(tab.valueAt(6, 8), false);
  const jordanLesson = lesson(jordan, "2026-10-15", "C Block", "3:00 PM", "3:45 PM");
  const w2 = buildWorld({ tabs: newLayout(), lessons: [averyRegular, jordanLesson] });
  w2.post("add-timesheet-row", keyOf(averyRegular));
  const r2 = w2.post("add-timesheet-row", keyOf(jordanLesson));
  assert.equal(r2.rowNumber, 6);
  assert.deepEqual(r2.row, ["10/15/2026", 2, "Jordan", "Test", "C", 0.75, "Bass"]);
});

test("landing row: a tab that ends right after its last real row gets a new row shaped like the row above (not the title row)", () => {
  const w = buildWorld({ tabs: newLayout({ premade: 0 }), lessons: [averyRegular] });
  const tab = w.tab("2026-2027");
  assert.equal(tab.getMaxRows(), 4);
  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rowNumber, 5);
  assert.deepEqual(w.ts.writes.filter((x) => x.kind === "insertRows").map((x) => [x.sheet, x.after, x.count]), [["2026-2027", 4, 1]]);
  assert.equal(tab.getMaxRows(), 5);
  for (let c = 1; c <= NEW_LAYOUT_HEADERS.length; c++) {
    assert.equal(tab.peek(5, c).style.background, PAY_PERIOD_COLORS[1], "column " + c);
    assert.notEqual(tab.peek(5, c).style.background, tab.peek(1, c).style.background, "column " + c);
    assert.equal(ruleAt(tab, 5, c), ruleAt(tab, 4, c), "column " + c);
  }
  assert.equal(tab.peek(5, 1).format, "m/d/yyyy");
  // The checkbox is there, never ticked or written.
  assert.equal(ruleAt(tab, 5, 8).getCriteriaType(), "CHECKBOX");
  assert.equal(tab.valueAt(5, 8), "");
  assert.deepEqual(w.shown("2026-2027")[4], ["10/15/2026", 3, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
});

test("landing row: a ticked box or text past G in the landing row stops the add, with nothing written", () => {
  const w = buildWorld({ tabs: newLayout(), lessons: [averyRegular] });
  const tab = w.tab("2026-2027");
  tab.cell(5, 8).value = true;
  const ticked = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.deepEqual(ticked, {
    ok: false,
    error: "Row 5 of 2026-2027 is where this lesson would go, but its column H box is ticked. Untick it " +
      "(or fill in that row's columns A to G by hand), then try again. Nothing was added, and the lesson wasn't marked.",
  });
  tab.cell(5, 8).value = false;
  tab.cell(5, 9).value = "ZZ";
  const text = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(text.error,
    'Row 5 of 2026-2027 is where this lesson would go, but its column I already holds "ZZ". Clear that cell ' +
    "(or fill in that row's columns A to G by hand), then try again. Nothing was added, and the lesson wasn't marked.");
  assert.equal(w.ts.writes.length, 0);
  assert.equal(w.mark(0), "");

  // A formula's answer in a pre-made row is part of the row's template: fine.
  tab.cell(5, 9).value = "";
  Object.assign(tab.cell(5, 10), { value: 0, formula: "=IF(H5, 1, 0)" });
  const ok = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.rowNumber, 5);
});

test("landing row: below a hand-typed label, the new row copies the lesson row above the label", () => {
  const rows = exampleRows().concat([[], ["Holiday Break"], ["Winter TERM"]]);
  const winter = lesson(avery, "2026-12-15", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ now: "2026-12-20T20:00:00-05:00", tabs: [tab2026(rows), ...defaultTabs()], lessons: [winter] });
  const r = w.post("add-timesheet-row", keyOf(winter));
  assert.equal(r.rowNumber, 14);
  const copies = w.ts.writes.filter((x) => x.kind === "copy");
  assert.deepEqual(copies.map((x) => [x.fromRow, x.row]), [[10, 14], [10, 14]]);
  // Nothing above row 14 changed.
  assert.deepEqual(w.shown("2026-2027")[12], ["Winter TERM"]);
});

// ─── Lesson length: over 45 minutes counts as a double ──────────────────────────────────

test("hours: 30, 45, 46, 70, 90 and 120 minutes", () => {
  const ends = { 30: "12:30 PM", 45: "12:45 PM", 46: "12:46 PM", 70: "1:10 PM", 90: "1:30 PM", 120: "2:00 PM" };
  const dates = { 30: "2026-10-12", 45: "2026-10-13", 46: "2026-10-14", 70: "2026-10-15", 90: "2026-10-16", 120: "2026-10-19" };
  const lessons = Object.keys(ends).map((m) => lesson(avery, dates[m], "Lunch", "12:00 PM", ends[m]));
  const w = buildWorld({ tabs: tabsWithDoubleHours([tab2026()]), lessons });
  const p = Object.fromEntries(Object.keys(ends).map((m, i) => [m, w.post("preview-timesheet-row", keyOf(lessons[i]))]));

  assert.deepEqual(p[30].row.slice(1), [5, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.deepEqual(p[30].warnings, [UNDER_45(30)]);
  assert.equal(p[30].lengthLine, "30-minute lesson, logged as 0.75 hours.");

  assert.deepEqual(p[45].row.slice(1), [5, "Avery", "Sample", "Lunch", 0.75, "Guitar"]);
  assert.deepEqual(p[45].warnings, []);
  assert.equal(p[45].lengthLine, "45-minute lesson, logged as 0.75 hours.");

  for (const m of [46, 70, 120]) {
    assert.deepEqual(p[m].row.slice(1), ["Double", "Avery", "Sample", "Lunch", 1.5, "Guitar"], m + " minutes");
    assert.deepEqual(p[m].warnings, [OVER_45(m)], m + " minutes");
    assert.equal(p[m].lengthLine, `${m}-minute lesson, logged as 1.5 hours (a double).`);
  }
  assert.deepEqual(p[90].row.slice(1), ["Double", "Avery", "Sample", "Lunch", 1.5, "Guitar"]);
  assert.deepEqual(p[90].warnings, []);
  assert.equal(p[90].lengthLine, "90-minute lesson, logged as 1.5 hours (a double).");
  assert.equal(p[70].lesson.minutes, 70);
});

test("hours: the real length goes only in the Lesson Schedule's mark, never on the time sheet", () => {
  const ends = { 30: "12:30 PM", 45: "12:45 PM", 70: "1:10 PM", 90: "1:30 PM" };
  const students = { 30: STUDENTS.casey, 45: STUDENTS.riley, 70: avery, 90: jordan };
  const lessons = Object.keys(ends).map((m) => lesson(students[m], "2026-10-15", "Lunch", "12:00 PM", ends[m]));
  const w = buildWorld({ tabs: tabsWithDoubleHours([tab2026()]), lessons });
  const marks = lessons.map((l) => w.post("add-timesheet-row", keyOf(l)).mark);
  assert.deepEqual(marks, [
    "Added 10/20/2026 (30 min, logged as 0.75)",
    "Added 10/20/2026",
    "Added 10/20/2026 (70 min, logged as 1.5)",
    "Added 10/20/2026",
  ]);
  assert.deepEqual(lessons.map((_, i) => w.mark(i)), marks);
  // On the time sheet: A to G only, no notes, no length anywhere.
  assert.ok(w.valueWrites().every((x) => x.col === 1 && x.numCols === 7));
  assert.ok(!w.ts.writes.some((x) => x.kind === "note"));
  const shown = w.shown("2026-2027");
  assert.deepEqual(shown[12], ["10/15/2026", "Double", "Avery", "Sample", "Lunch", 1.5, "Guitar"]);
  assert.ok(!JSON.stringify(shown).includes("70"));

  // The longer mark still counts as marked everywhere.
  assert.equal(w.ctx.isAddedMark_("Added 10/20/2026 (70 min, logged as 1.5)"), true);
  assert.equal(w.post("skip-timesheet-row", keyOf(lessons[2])).error,
    'This lesson is already marked "Added 10/20/2026 (70 min, logged as 1.5)", so there is nothing to skip.');
  const again = w.post("add-timesheet-row", keyOf(lessons[2]));
  assert.equal(again.alreadyThere, true);
  assert.equal(again.mark, "Added 10/20/2026 (70 min, logged as 1.5)");
  assert.equal(w.valueWrites().length, 4);
});

test("hours: a lesson already on the tab is marked with the hours on that row", () => {
  const rows = exampleRows().concat([[day("2026-10-15"), "Double", "Avery", "Sample", "Lunch", 1.5, "Guitar"]]);
  const seventy = lesson(avery, "2026-10-15", "Lunch", "12:00 PM", "1:10 PM");
  const w = buildWorld({ tabs: [tab2026(rows), ...defaultTabs()], lessons: [seventy] });
  const p = w.post("preview-timesheet-row", keyOf(seventy));
  assert.equal(p.duplicate.rowNumber, 11);
  assert.equal(p.lengthLine, "70-minute lesson, logged as 1.5 hours (a double).");
  assert.equal(w.post("add-timesheet-row", keyOf(seventy)).mark, "Added 10/20/2026 (70 min, logged as 1.5)");
  assert.equal(w.valueWrites().length, 0);
});

// ─── Term labels follow the tab ─────────────────────────────────────────────────────────

test("term labels: an old-style tab with a 'Winter TERM' row gets labels", () => {
  const rows = [
    [day("2026-09-10"), 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"],
    ["Winter TERM"],
    [day("2026-12-10"), 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"],
  ];
  const spring = lesson(avery, "2027-03-10", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ now: "2027-03-12T20:00:00-05:00", tabs: [tab2026(rows), ...defaultTabs()], lessons: [spring] });
  const p = w.post("preview-timesheet-row", keyOf(spring));
  assert.equal(p.addsTermLabel, true);
  assert.equal(p.termLabel, "Spring 2027");
  const r = w.post("add-timesheet-row", keyOf(spring));
  assert.equal(r.labelRowNumber, 5);
  assert.equal(r.rowNumber, 6);
  assert.deepEqual(w.shown("2026-2027").slice(4), [["Spring 2027"], ["3/10/2027", 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"]]);
});

test("term labels: a tab without label rows gets none, even in a new term", () => {
  const winter = lesson(avery, "2026-12-15", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ now: "2026-12-20T20:00:00-05:00", tabs: newLayout(), lessons: [winter] });
  const p = w.post("preview-timesheet-row", keyOf(winter));
  assert.equal(p.addsTermLabel, false);
  assert.equal(p.row[1], 1); // a new term still starts at lesson 1
  const r = w.post("add-timesheet-row", keyOf(winter));
  assert.equal(r.labelRowNumber, null);
  assert.equal(r.rowNumber, 5);
  assert.equal(w.valueWrites().length, 1);
  assert.equal(w.valueWrites()[0].numRows, 1);
});

// ─── New school-year tab from a new-layout tab ──────────────────────────────────────────

test("new school-year tab: every column's rule is copied from the newest lesson row, checkbox included", () => {
  const fall = lesson(avery, "2027-08-20", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ now: "2027-08-25T20:00:00-04:00", tabs: newLayout(), lessons: [fall] });
  const r = w.post("add-timesheet-row", keyOf(fall));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tab, "2027-2028");
  assert.equal(r.createdTab, true);
  assert.equal(r.rowNumber, 2);
  assert.equal(r.labelRowNumber, null);
  assert.deepEqual(w.ts.getSheets().map((s) => s.getName()).slice(0, 2), ["2027-2028", "2026-2027"]);
  const tab = w.tab("2027-2028");
  const template = w.tab("2026-2027");
  assert.deepEqual(w.shown("2027-2028"), [NEW_LAYOUT_HEADERS, ["8/20/2027", 1, "Avery", "Sample", "Lunch", 0.75, "Guitar"]]);
  for (let c = 1; c <= NEW_LAYOUT_HEADERS.length; c++) {
    assert.equal(ruleAt(tab, 2, c), ruleAt(template, 4, c), "column " + c);
    assert.equal(ruleAt(tab, 1000, c), ruleAt(template, 4, c), "column " + c);
  }
  assert.equal(ruleAt(tab, 2, 8).getCriteriaType(), "CHECKBOX");
  assert.equal(tab.valueAt(2, 8), "");
});

// ─── Remembered spellings ───────────────────────────────────────────────────────────────

test("saved names: saved after the first add, used by the next preview, and preview edits still win", () => {
  const m1 = lesson(morgan, "2026-10-13", "Lunch", "12:00 PM", "12:45 PM");
  const m2 = lesson(morgan, "2026-10-15", "Lunch", "12:00 PM", "12:45 PM");
  const w = buildWorld({ tabs: [tab2026(), ...defaultTabs()], lessons: [m1, m2] });
  const key = "TIMESHEET_STUDENT:morgan.fake@example.org";

  // Nothing saved yet: the form's three-word name is split, and "Drums" isn't on the list.
  const first = w.post("preview-timesheet-row", keyOf(m1));
  assert.deepEqual(first.row.slice(2, 4), ["Morgan", "Ann Fake"]);
  assert.equal(first.row[6], "");
  assert.deepEqual(first.info, []);
  assert.ok(first.warnings.some((x) => x.startsWith('The name "Morgan Ann Fake" has 3 words')));

  // He fixes the row in the preview and adds it.
  const fields = { lessonNo: 1, firstName: "Morgan Ann", lastName: "Fake", block: "Lunch", hours: 0.75, subject: "Guitar" };
  assert.equal(w.post("add-timesheet-row", Object.assign(keyOf(m1), { overrides: fields })).ok, true);
  assert.deepEqual(JSON.parse(w.fakes.props[key]), { firstName: "Morgan Ann", lastName: "Fake", subject: "Guitar" });

  // The next lesson starts from the saved spelling, so it counts as lesson 2.
  const next = w.post("preview-timesheet-row", keyOf(m2));
  assert.deepEqual(next.row.slice(1), [2, "Morgan Ann", "Fake", "Lunch", 0.75, "Guitar"]);
  assert.deepEqual(next.info, [SAVED_INFO]);
  assert.ok(!next.warnings.some((x) => x.includes("3 words") || x.includes("Drums")), JSON.stringify(next.warnings));

  // Values changed in the preview still win, and "Check again" recounts for them.
  const edited = w.post("preview-timesheet-row", Object.assign(keyOf(m2), {
    overrides: { firstName: "Morgan", lastName: "Fake-Example", block: "Lunch", hours: 0.75, subject: "Bass" },
  }));
  assert.deepEqual(edited.row.slice(1), [1, "Morgan", "Fake-Example", "Lunch", 0.75, "Bass"]);
  assert.deepEqual(edited.info, []);

  // Adding again replaces the saved spelling with the new one.
  const fields2 = { lessonNo: 1, firstName: "Morgan", lastName: "Fake-Example", block: "Lunch", hours: 0.75, subject: "Bass" };
  assert.equal(w.post("add-timesheet-row", Object.assign(keyOf(m2), { overrides: fields2 })).ok, true);
  assert.deepEqual(JSON.parse(w.fakes.props[key]), { firstName: "Morgan", lastName: "Fake-Example", subject: "Bass" });
});

test("saved names: a failing property write never fails the add; a duplicate saves nothing", () => {
  const w = buildWorld({ tabs: [tab2026(), ...defaultTabs()], lessons: [averyRegular] });
  w.fakes.failPropertyWrites((k) => k.startsWith("TIMESHEET_STUDENT:"));
  const r = w.post("add-timesheet-row", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rowNumber, 11);
  assert.equal(w.mark(0), "Added 10/20/2026");
  assert.ok(!Object.keys(w.fakes.props).some((k) => k.startsWith("TIMESHEET_STUDENT:")));
  assert.ok(w.logs.some((l) => l.startsWith("Couldn't save the time sheet names for avery.sample@example.org (the lesson was still added)")), w.logs.join("\n"));

  const rows = exampleRows().concat([[day("2026-10-15"), 5, "Avery", "Sample", "Lunch", 0.75, "Guitar"]]);
  const dup = buildWorld({ tabs: [tab2026(rows), ...defaultTabs()], lessons: [averyRegular] });
  assert.equal(dup.post("add-timesheet-row", keyOf(averyRegular)).alreadyThere, true);
  assert.ok(!Object.keys(dup.fakes.props).some((k) => k.startsWith("TIMESHEET_STUDENT:")));

  // Something unreadable in the drawer is ignored (and logged), never an error.
  const odd = buildWorld({ tabs: [tab2026(), ...defaultTabs()], lessons: [averyRegular],
    props: Object.assign(defaultProps(), { "TIMESHEET_STUDENT:avery.sample@example.org": "{not json" }) });
  const p = odd.post("preview-timesheet-row", keyOf(averyRegular));
  assert.deepEqual(p.row.slice(2, 4), ["Avery", "Sample"]);
  assert.deepEqual(p.info, []);
});

// ─── Lesson Schedule dropdowns ──────────────────────────────────────────────────────────

const SHUFFLED_HEADERS = ["Lesson Date", "Start Time", "End Time", "Lesson Block", "Student Name", "Note",
  "Student Email", "Status", "Lesson Focus", "Calendar Event ID"];
const t0 = new Date("2026-08-20T13:00:00Z");
// The same student twice (capitals differ; the later name wins), a row with no email, a student
// with no name, and names that sort differently with capital letters.
const MESSY_ROSTER = [
  [t0, "zoe.example@example.org", "Zoe Example", "Guitar"],
  [t0, "Avery.Sample@example.org", "avery sample", "Bass"],
  [t0, "avery.sample@example.org", "Avery Sample", "Guitar"],
  [t0, "", "No Email", "Drums"],
  [t0, "blake.example@example.org", "", "Ukulele"],
  [t0, "casey.demo@example.org", "casey Demo", "Ukulele"],
];

test("Lesson Schedule dropdowns: found by title, roster de-duplicated and sorted, Block list exact, warning-only", () => {
  const w = buildWorld({ scheduleHeaders: SHUFFLED_HEADERS, formRows: MESSY_ROSTER, lessons: [averyRegular] });
  // A date rule someone already put on Lesson Date (column A here), and a rule on Status.
  const dateRule = { kind: "date rule (made up)" };
  const statusRule = { kind: "status rule (made up)" };
  for (let r = 2; r <= 1000; r++) {
    w.schedule.cell(r, 1).rule = dateRule;
    w.schedule.cell(r, 8).rule = statusRule;
  }
  const out = w.ctx.setupSheetFormatting();

  const emailRule = ruleAt(w.schedule, 2, 7);
  assert.equal(emailRule.getCriteriaType(), "VALUE_IN_LIST");
  assert.deepEqual(emailRule.list,
    ["avery.sample@example.org", "blake.example@example.org", "casey.demo@example.org", "zoe.example@example.org"]);
  assert.deepEqual(ruleAt(w.schedule, 2, 5).list, ["Avery Sample", "casey Demo", "Zoe Example"]);
  assert.deepEqual(ruleAt(w.schedule, 2, 4).list, LISTS.Block.map(String));
  assert.ok(ruleAt(w.schedule, 2, 4).list.includes("1PM  Shadow Block"));
  for (const col of [7, 5, 4]) {
    const rule = ruleAt(w.schedule, 2, col);
    assert.equal(rule.getAllowInvalid(), true, "column " + col);
    assert.equal(rule.showDropdown, true, "column " + col);
    assert.equal(ruleAt(w.schedule, 1000, col), rule, "column " + col);
    assert.equal(ruleAt(w.schedule, 1, col), null, "title of column " + col);
  }
  // Every other column's rules are left alone.
  assert.equal(ruleAt(w.schedule, 2, 1), dateRule);
  assert.equal(ruleAt(w.schedule, 2, 8), statusRule);
  const validationCols = new Set(w.studio.writes.filter((x) => x.kind === "validation").map((x) => x.col));
  assert.deepEqual([...validationCols].sort(), [4, 5, 7]);

  assert.deepEqual(plain(out.dropdowns), ["Student Email: 4 emails", "Student Name: 3 names", "Lesson Block: 19 blocks from the time sheet"]);
  assert.ok(w.logs.includes(
    "Lesson Schedule dropdowns (anything else typed in gets a warning, never refused): " +
    "Student Email: 4 emails; Student Name: 3 names; Lesson Block: 19 blocks from the time sheet"
  ), w.logs.join("\n"));
  // The time sheet was only read.
  assert.equal(w.ts.writes.length, 0);
});

test("Lesson Schedule dropdowns: the built-in Block list when the time sheet can't be opened or isn't set", () => {
  const expected = ["Zoom Meeting", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "1PM  Shadow Block",
    "2PM Shadow Block", "Lunch", "After School", "Before School", "Meeting Block", "Faculty/Dept. Meeting", "Sunday"];
  const w = buildWorld({ props: Object.assign(defaultProps(), { TIMESHEET_SPREADSHEET_ID: "SOME-OTHER-SHEET-ID" }) });
  w.ctx.setupSheetFormatting();
  assert.deepEqual(ruleAt(w.schedule, 2, 4).list, expected);
  assert.ok(w.logs.some((l) => l.startsWith("Lesson Block dropdown: the time sheet couldn't be opened (Google said: ") &&
    l.endsWith(", so the built-in Block list was used.")), w.logs.join("\n"));
  assert.ok(w.logs.some((l) => l.endsWith("Lesson Block: 19 blocks from the built-in list")));

  const unset = buildWorld({ props: { SHARED_SECRET: SECRET } });
  unset.ctx.setupSheetFormatting();
  assert.deepEqual(ruleAt(unset.schedule, 2, 4).list, expected);
  assert.ok(unset.logs.includes("Lesson Block dropdown: TIMESHEET_SPREADSHEET_ID isn't set, so the built-in Block list was used."));
});

test("Lesson Schedule dropdowns: a new sign-up refreshes the email and name lists (not Block)", () => {
  const w = buildWorld({ lessons: [averyRegular] });
  const values = [new Date("2026-10-06T13:00:00Z"), "new.signup@example.org", "Taylor Example", "Guitar"];
  w.form.putRow(w.form.getLastRow() + 1, values);
  w.ctx.onFormSubmit({ values, range: w.form.getRange(w.form.getLastRow(), 1, 1, 4) });
  assert.ok(ruleAt(w.schedule, 2, 1).list.includes("new.signup@example.org"));
  assert.ok(ruleAt(w.schedule, 2, 2).list.includes("Taylor Example"));
  assert.equal(ruleAt(w.schedule, 2, 1).list.length, 7);
  assert.equal(ruleAt(w.schedule, 2, 4), null);
  assert.equal(w.fakes.openCalls.length, 0);
});

// ─── studio-links ───────────────────────────────────────────────────────────────────────

test("studio-links: the Lesson Schedule tab's link and the time sheet's link, without opening it", () => {
  const w = buildWorld();
  const r = w.post("studio-links");
  assert.deepEqual(r, {
    ok: true,
    lessonScheduleUrl: "https://docs.google.com/spreadsheets/d/FAKE-STUDIO-ID/edit#gid=" + w.schedule.getSheetId(),
    timesheetUrl: "https://docs.google.com/spreadsheets/d/FAKE-TIMESHEET-ID-0001/edit",
  });
  assert.notEqual(w.schedule.getSheetId(), 0);
  assert.equal(w.fakes.openCalls.length, 0);
  // TIMESHEET_SPREADSHEET_ID was a whole link; a bare ID gives the same answer.
  assert.equal(TIMESHEET_URL.includes("#gid=0"), true);
});

test("studio-links: the time sheet link is null when it isn't connected", () => {
  for (const props of [{ SHARED_SECRET: SECRET }, { SHARED_SECRET: SECRET, TIMESHEET_SPREADSHEET_ID: "not a sheet" }]) {
    const r = buildWorld({ props }).post("studio-links");
    assert.equal(r.ok, true);
    assert.equal(r.timesheetUrl, null);
    assert.match(r.lessonScheduleUrl, /#gid=\d+$/);
  }
});

test("studio-links: through api() for listed people only; the web route still needs the password", () => {
  const props = Object.assign(defaultProps(), { ALLOWED_USERS: TEACHER });
  const w = buildWorld({ props, activeUser: TEACHER });
  assert.deepEqual(plain(w.api({ action: "studio-links" })), w.post("studio-links"));
  assert.deepEqual(plain(w.api({ action: "studio-links" }, "student.example@example.org")),
    { ok: false, accessDenied: true, error: NO_ACCESS });
  const out = w.ctx.doPost({ postData: { contents: JSON.stringify({ action: "studio-links", secret: "wrong" }) } });
  assert.deepEqual(JSON.parse(out.getContent()), { ok: false, error: "Unauthorized" });
});

// ─── Small fixes ────────────────────────────────────────────────────────────────────────

test("calendar invite: the description ends with 'Scheduled with the Music Studio.'", () => {
  const w = buildWorld({ lessons: [averyRegular] });
  const r = w.post("preview-event", keyOf(averyRegular));
  assert.equal(r.ok, true, r.error);
  const lines = r.preview.description.split("\n");
  assert.equal(lines[lines.length - 1], "Scheduled with the Music Studio.");
  assert.equal(lines[lines.length - 2], "");
  assert.equal(lines[0], "Student: Avery Sample <avery.sample@example.org>");
});

test("the new tab layout fixture matches the handoff description", () => {
  // Guards the fixture itself: A-J titles, no label rows, H a checkbox, real rows dated.
  assert.equal(NEW_LAYOUT_HEADERS.length, 10);
  assert.deepEqual(NEW_LAYOUT_HEADERS.slice(7), ["COMPLETED LESSON", "Dir. of Music Sign.", "Paid on paydate"]);
  assert.deepEqual(LESSON_HEADERS.slice(0, 4), ["Student Email", "Student Name", "Lesson Date", "Lesson Block"]);
  assert.ok(newLayoutRows().every((r) => typeof r[0] === "object" && r[0].day));
  assert.ok(lookupTabs().some((t) => t.name === "hours"));
});
