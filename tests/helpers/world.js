// world.js: builds a made-up studio spreadsheet and a made-up payroll time sheet, loads Code.gs
// next to them, and gives tests a way to call the web app's POST actions.
//
// Every name and email here is invented. The time sheet copies the real layout: school-year tabs
// named like "2025-2026" (newest first), "(CHAPEL/MISC.)" companion tabs, lookup tabs feeding
// "Reject input" dropdowns on columns B, E, F and G, and hand-typed label rows in column A.
import { createSandbox, loadCode, zonedMs, formatDate } from "./gas-sandbox.js";
import { FakeSpreadsheet, FakeRule, fakeGlobals } from "./fake-google.js";

export const STUDIO_TZ = "America/New_York";
export const TIMESHEET_ID = "FAKE-TIMESHEET-ID-0001";
export const TIMESHEET_URL = `https://docs.google.com/spreadsheets/d/${TIMESHEET_ID}/edit#gid=0`;
export const SECRET = "test-secret-not-a-real-one";

export const YEAR_HEADERS = [
  "$", "Lesson No.", "Student First Name", "Student Last Name", "Block",
  "Total Hours", "Music Subject", "Dir. of Music Sign.", "Paid on paydate",
];

// The lookup tabs, exactly as the real ones are laid out (column A, starting in row 1).
// "1PM  Shadow Block" really has two spaces. hours!A1:A2 holds only 0.75.
export const LISTS = {
  "Lesson No.": [1, 2, 3, 4, 5, 6, 7, 8, 9, "Double", "Late Cancel", "No Show"],
  Block: ["Zoom Meeting", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "1PM  Shadow Block",
    "2PM Shadow Block", "Lunch", "After School", "Before School", "Meeting Block",
    "Faculty/Dept. Meeting", "Sunday"],
  Instrument: ["Guitar", "Bass", "Ukulele"],
  hours: [0.75, ""],
};

// Which lookup tab (and how many rows of it) feeds each year-tab column's dropdown.
const DROPDOWNS = { 2: ["Lesson No.", 12], 5: ["Block", 19], 6: ["hours", 2], 7: ["Instrument", 3] };

// Made-up students: email, name on the sign-up form, and the instrument they wrote.
export const STUDENTS = {
  avery: { email: "avery.sample@example.org", name: "Avery Sample", instrument: "Electric guitar" },
  jordan: { email: "jordan.test@example.org", name: "Jordan Test", instrument: "bass guitar" },
  casey: { email: "casey.demo@example.org", name: "Casey Demo", instrument: "Ukulele" },
  riley: { email: "riley.mock@example.org", name: "Riley Mock", instrument: "uke" },
  morgan: { email: "morgan.fake@example.org", name: "Morgan Ann Fake", instrument: "Drums" },
  quinn: { email: "quinn.placeholder@example.org", name: "Quinn", instrument: "guitar and bass" },
};

// day("2026-09-10") puts a real date in a time sheet cell; plain text stays text.
export const day = (key) => ({ day: key });

// The five example rows from the time sheet's real pattern (names and signature made up).
export function exampleRows() {
  return [
    ["Fall 2026"],
    ["Week 1"],
    [day("2026-09-10"), 1, "Avery", "Sample", "Lunch", 0.75, "Guitar", "ZZ", day("2026-10-15")],
    [],
    ["Week 2"],
    [day("2026-09-17"), "Double", "Avery", "Sample", "Lunch", 1.5, "Guitar"],
    // Hand-typed as text instead of a real date: still counts as a date.
    ["9/24/2026", 4, "Avery", "Sample", "Lunch", 0.75, "Guitar"],
    [day("2026-10-01"), "No Show", "Jordan", "Test", "C", 0.75, "Bass"],
    [day("2026-10-08"), 2, "Jordan", "Test", "C", 0.75, "Bass"],
  ];
}

// The default time sheet tabs, in tab order: newest school year first, CHAPEL tabs next to
// their year (placed in front, so "starts with" matching would pick the wrong tab).
export function defaultTabs() {
  return [
    { name: "2025-2026 (CHAPEL/MISC.)", rows: [[day("2026-03-01"), "Chapel service", "", "", "", 50]] },
    {
      name: "2025-2026",
      year: true,
      rows: [
        ["Fall 2025"],
        [day("2025-09-11"), 1, "Avery", "Sample", "Lunch", 0.75, "Guitar", "ZZ", day("2025-10-15")],
        ["Holiday Break"],
        ["Spring 2026"],
        [day("2026-03-12"), 3, "Avery", "Sample", "Lunch", 0.75, "Guitar"],
        ["End of Spring 2026"],
      ],
    },
    { name: "2024-2025 (CHAPEL/MISC.)", rows: [] },
    { name: "2024-2025", year: true, dateHeader: "(dbl click) Date", rows: [["Fall 2024"], [day("2024-09-12"), 1, "Avery", "Sample", "B", 0.75, "Guitar"]] },
    ...lookupTabs(),
  ];
}

export function lookupTabs() {
  return [
    { name: "Lesson No.", list: LISTS["Lesson No."] },
    { name: "Block", list: LISTS.Block },
    { name: "Instrument", list: LISTS.Instrument },
    { name: "hours", list: LISTS.hours },
    { name: "First Name", list: ["Avery", "Jordan", "Casey"] },
    { name: "Last Name", list: ["Sample", "Test", "Demo"] },
  ];
}

// A school-year tab for 2026-2027 holding the five example rows.
export function tab2026(rows = exampleRows(), extra = {}) {
  return Object.assign({ name: "2026-2027", year: true, rows }, extra);
}

function defaultFormRows() {
  const ts = new Date(zonedMs(2026, 8, 20, 9, 0, 0, STUDIO_TZ));
  return Object.values(STUDENTS).map((s) => [ts, s.email, s.name, s.instrument]);
}

export function defaultProps() {
  return {
    SHARED_SECRET: SECRET,
    TIMESHEET_SPREADSHEET_ID: TIMESHEET_URL,
    TIMESHEET_START_DATE: "2026-09-01",
  };
}

const LESSON_HEADERS = [
  "Student Email", "Student Name", "Lesson Date", "Lesson Block", "Start Time", "End Time",
  "Status", "Lesson Focus", "Note", "Calendar Event ID",
];

// A Lesson Schedule row. `date` is "yyyy-MM-dd" (stored as a real date, like Sheets does).
export function lesson(student, date, block, start, end, extra = {}) {
  return Object.assign({ email: student.email, name: student.name, date, block, start, end, status: "" }, extra);
}

// The composite key the website sends for a lesson.
export function keyOf(l) {
  return { studentEmail: l.email, lessonDate: l.date, startTime: l.start };
}

// Builds everything and loads Code.gs. Options:
//   now                 ISO date-time for "now" inside the script
//   lessons             Lesson Schedule rows (see lesson())
//   tabs                time sheet tabs (see defaultTabs())
//   props               Script Properties (defaults: secret, time sheet URL, start date 2026-09-01)
//   timesheetTz         the time sheet's time zone (the studio sheet uses STUDIO_TZ)
//   timeSheetColumn     true to start the Lesson Schedule with a "Time Sheet" column
//   formRows            replaces Form Responses 1's rows
//   rejectInvalidScriptWrites  true makes "Reject input" dropdowns refuse script writes
export function buildWorld(options = {}) {
  const { context, SandboxDate } = createSandbox({ now: options.now || "2026-10-20T20:00:00-04:00" });

  const studio = new FakeSpreadsheet({ id: "FAKE-STUDIO-ID", name: "Music Studio (test)", timeZone: STUDIO_TZ, SandboxDate });
  const form = studio.addSheet("Form Responses 1");
  form.putRow(1, ["Timestamp", "Email Address", "Name", "What instrument do you want to play?"]);
  (options.formRows || defaultFormRows()).forEach((r, i) => form.putRow(i + 2, r));

  const schedule = studio.addSheet("Lesson Schedule");
  const headers = LESSON_HEADERS.concat(options.timeSheetColumn ? ["Time Sheet"] : []);
  schedule.putRow(1, headers);
  (options.lessons || []).forEach((l, i) => {
    const [y, m, d] = l.date.split("-").map(Number);
    schedule.putRow(i + 2, [
      l.email, l.name, new Date(zonedMs(y, m, d, 0, 0, 0, STUDIO_TZ)), l.block, l.start, l.end,
      l.status || "", l.focus || "", "", "",
    ].concat(options.timeSheetColumn ? [l.mark || ""] : []));
  });

  const timesheetTz = options.timesheetTz || STUDIO_TZ;
  const ts = new FakeSpreadsheet({
    id: TIMESHEET_ID,
    name: "Payroll Time Sheet (test copy)",
    timeZone: timesheetTz,
    url: TIMESHEET_URL,
    rejectInvalidScriptWrites: !!options.rejectInvalidScriptWrites,
    SandboxDate,
  });
  buildTimesheet(ts, options.tabs || defaultTabs(), timesheetTz);

  const fakes = fakeGlobals({
    SandboxDate,
    active: studio,
    spreadsheets: { [TIMESHEET_ID]: ts },
    props: options.props || defaultProps(),
  });
  Object.assign(context, fakes.globals);
  loadCode(context);

  return {
    ctx: context,
    studio,
    schedule,
    form,
    ts,
    fakes,
    logs: fakes.logs,
    timesheetTz,
    // Calls doPost like the website does and gives back the parsed reply.
    post(action, body = {}) {
      const out = context.doPost({ postData: { contents: JSON.stringify(Object.assign({ action, secret: SECRET }, body)) } });
      return JSON.parse(out.getContent());
    },
    tab(name) { return ts.getSheetByName(name); },
    // What a time sheet tab shows, row by row (dates as M/d/yyyy), trailing blanks trimmed.
    shown(name) { return shownRows(ts.getSheetByName(name), timesheetTz); },
    // The Lesson Schedule's Time Sheet note for lesson number i (0 = first lesson row).
    mark(i) {
      const col = schedule.getRange(1, 1, 1, schedule.getLastColumn()).getValues()[0].indexOf("Time Sheet") + 1;
      return col === 0 ? "" : schedule.valueAt(i + 2, col);
    },
    // Every recorded change to the time sheet that wrote cell values.
    valueWrites() { return ts.writes.filter((w) => w.kind === "values"); },
  };
}

function toCell(value, tz) {
  if (value && typeof value === "object" && value.day) {
    const [y, m, d] = value.day.split("-").map(Number);
    return new Date(zonedMs(y, m, d, 0, 0, 0, tz));
  }
  return value;
}

function buildTimesheet(ts, tabs, tz) {
  // Create every tab first, so dropdowns can point at the lookup tabs.
  for (const spec of tabs) {
    const sheet = ts.addSheet(spec.name);
    if (spec.list) {
      spec.list.forEach((v, i) => { sheet.cell(i + 1, 1).value = v; });
      continue;
    }
    const header = YEAR_HEADERS.slice();
    if (spec.dateHeader) header[0] = spec.dateHeader;
    sheet.putRow(1, header);
    for (let c = 1; c <= header.length; c++) {
      Object.assign(sheet.cell(1, c).style, { fontWeight: "bold", background: "#d9ead3" });
      sheet.widths[c] = 90 + c * 10;
    }
    sheet.frozenRows = 1;
    sheet.frozenColumns = 2;
    spec.rows.forEach((r, i) => sheet.putRow(i + 2, r.map((v) => toCell(v, tz))));
  }
  // Then give each school-year tab its "Reject input" dropdowns on B, E, F and G (and, when
  // asked, C and D pointing at the First Name / Last Name tabs), on rows 2 to 200.
  for (const spec of tabs) {
    if (!spec.year) continue;
    const sheet = ts.getSheetByName(spec.name);
    const columns = Object.assign({}, DROPDOWNS, spec.nameDropdowns ? { 3: ["First Name", 3], 4: ["Last Name", 3] } : {});
    for (const [col, [listTab, size]] of Object.entries(columns)) {
      const listSheet = ts.getSheetByName(listTab);
      if (!listSheet) continue; // a test left this lookup tab out
      const rule = new FakeRule({ range: listSheet.getRange(1, 1, size, 1), allowInvalid: false });
      for (let r = 2; r <= 200; r++) sheet.cell(r, Number(col)).rule = rule;
    }
  }
}

// What a tab shows, row by row: dates as M/d/yyyy in the time sheet's time zone.
export function shownRows(sheet, tz) {
  const last = sheet.getLastRow();
  const out = [];
  for (let r = 1; r <= last; r++) {
    const line = [];
    for (let c = 1; c <= 9; c++) {
      const v = sheet.valueAt(r, c);
      line.push(v instanceof Date ? formatDate(v, tz, "M/d/yyyy") : v);
    }
    while (line.length && (line[line.length - 1] === "" || line[line.length - 1] === null)) line.pop();
    out.push(line);
  }
  return out;
}
