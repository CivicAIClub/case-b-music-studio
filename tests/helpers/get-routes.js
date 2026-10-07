// get-routes.js: one made-up studio and the list of GET requests the website makes, used to
// prove the GET routes still answer exactly as they did before the Google-hosting change.
// tests/fixtures/get-routes-golden.json holds the answers recorded from the old Code.gs.
import { zonedMs } from "./gas-sandbox.js";
import { buildWorld, lesson, STUDENTS, SECRET, STUDIO_TZ } from "./world.js";

const { avery, jordan, casey } = STUDENTS;

// A studio with lessons (text times, real time cells and a date-and-time cell), a per-student
// tab for Avery, and form rows whose Timestamp is a real date and time.
export function buildGetRoutesWorld(options = {}) {
  const w = buildWorld(Object.assign({
    lessons: [
      lesson(avery, "2026-10-15", "Lunch", "12:00 PM", "12:45 PM"),
      lesson(jordan, "2026-10-16", "C Block", "3:00 PM", "4:30 PM", { status: "Scheduled" }),
      lesson(casey, "2026-10-19", "D Block", "8:00 AM", "8:45 AM", { status: "Cancelled" }),
    ],
  }, options));
  // A row typed the way Sheets stores it: times as 1899-12-30 times, and a date with a time.
  const next = w.schedule.getLastRow() + 1;
  w.schedule.putRow(next, [
    jordan.email, jordan.name,
    new Date(zonedMs(2026, 10, 20, 15, 30, 0, STUDIO_TZ)),
    "E Block",
    new Date(zonedMs(1899, 12, 30, 15, 30, 0, STUDIO_TZ)),
    new Date(zonedMs(1899, 12, 30, 16, 15, 0, STUDIO_TZ)),
    "", "", "", "",
  ]);
  // Avery's own tab (made by onFormSubmit for every sign-up): the form's headers, then answers.
  const tab = w.studio.addSheet(avery.email);
  const headers = w.form.getRange(1, 1, 1, w.form.getLastColumn()).getValues()[0];
  tab.putRow(1, headers);
  tab.putRow(2, [new Date(zonedMs(2026, 8, 20, 9, 0, 0, STUDIO_TZ)), avery.email, avery.name, "Electric guitar"]);
  tab.putRow(3, [new Date(zonedMs(2026, 9, 2, 14, 5, 0, STUDIO_TZ)), avery.email, avery.name, "Bass"]);
  return w;
}

// [name, the query parameters] for every GET request shape the website uses, plus refusals.
export function getRouteCases() {
  return [
    ["list", { action: "list", secret: SECRET }],
    ["student-with-own-tab", { email: avery.email, secret: SECRET }],
    ["student-from-form-responses", { email: jordan.email, secret: SECRET }],
    ["student-email-in-capitals", { email: "AVERY.SAMPLE@EXAMPLE.ORG", secret: SECRET }],
    ["student-unknown", { email: "nobody@example.org", secret: SECRET }],
    ["schedule-list", { action: "schedule-list", secret: SECRET }],
    ["schedule-one-student", { action: "schedule", email: jordan.email, secret: SECRET }],
    ["unknown-action", { action: "nope", secret: SECRET }],
    ["no-secret", { action: "list" }],
    ["wrong-secret", { action: "schedule-list", secret: "wrong" }],
  ];
}
