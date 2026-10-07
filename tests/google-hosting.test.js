// Tests for serving the website from Apps Script (Google hosting) in apps-script/Code.gs:
// doGet's page, api() and its ALLOWED_USERS check, the private-function safety rule, and that
// the existing GET routes and doPost answer exactly as before. Every name and email is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./helpers/gas-sandbox.js";
import { buildWorld, defaultProps, defaultTabs, lesson, keyOf, STUDENTS, SECRET } from "./helpers/world.js";
import { buildGetRoutesWorld, getRouteCases } from "./helpers/get-routes.js";

const { avery } = STUDENTS;
const GOLDEN = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/get-routes-golden.json"), "utf8"));
const NO_ACCESS = "You don't have access to the Music Studio. Ask Mr. O'Neal.";
const TEACHER = "teacher.example@example.org";
const withAllowed = (list, extra = {}) => Object.assign(defaultProps(), { ALLOWED_USERS: list }, extra);

// Same request through api(), for each GET route shape: [golden case name, api request].
const API_FOR_GET = [
  ["list", { action: "list" }],
  ["student-with-own-tab", { action: "student", email: avery.email }],
  ["student-from-form-responses", { action: "student", email: STUDENTS.jordan.email }],
  ["student-email-in-capitals", { action: "student", email: "AVERY.SAMPLE@EXAMPLE.ORG" }],
  ["student-unknown", { action: "student", email: "nobody@example.org" }],
  ["schedule-list", { action: "schedule-list" }],
  ["schedule-one-student", { action: "schedule", email: STUDENTS.jordan.email }],
];

// True if any Date object hides anywhere inside the value.
function containsDate(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") return true;
  if (Array.isArray(value)) return value.some(containsDate);
  if (value && typeof value === "object") return Object.values(value).some(containsDate);
  return false;
}

// ─── api(): who gets in ────────────────────────────────────────────────────────────────

test("api refuses a visitor whose email Google doesn't share (blank)", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: "" });
  assert.deepEqual(JSON.parse(JSON.stringify(w.api({ action: "list" }))), { ok: false, accessDenied: true, error: NO_ACCESS });
});

test("api refuses an email that isn't on ALLOWED_USERS, and everyone when it's empty", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: "student.example@example.org" });
  const denied = w.api({ action: "add-timesheet-row", studentEmail: avery.email, lessonDate: "2026-10-15", startTime: "12:00 PM" });
  assert.equal(denied.accessDenied, true);
  assert.equal(denied.error, NO_ACCESS);
  // Nothing was touched on the time sheet or the Lesson Schedule.
  assert.equal(w.ts.writes.length, 0);
  assert.equal(w.studio.writes.length, 0);

  const empty = buildGetRoutesWorld({ props: defaultProps(), activeUser: TEACHER });
  assert.equal(empty.api({ action: "ping" }).accessDenied, true);
});

test("api accepts listed emails whatever their capital letters, on either side", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(" Teacher.Example@Example.ORG ,second.person@example.org"), activeUser: "TEACHER.example@example.org" });
  const r = w.api({ action: "ping" });
  assert.equal(r.ok, true);
  assert.equal(r.codeVersion, "2026-10-07 post-delivery");
  assert.equal(w.api({ action: "ping" }, "Second.Person@example.org").ok, true);
});

test("api needs no shared password (it isn't even read on this path)", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER, { SHARED_SECRET: undefined }), activeUser: TEACHER });
  assert.equal(w.api({ action: "list" }).students.length, 6);
});

// ─── api(): same answers as the GET routes and doPost ──────────────────────────────────

test("api read requests answer exactly like the matching GET routes", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER });
  for (const [name, request] of API_FOR_GET) {
    assert.deepEqual(JSON.parse(JSON.stringify(w.api(request))), GOLDEN[name], name);
  }
});

test("api write requests go to the same handlers as doPost, with the same answers", () => {
  const lessons = [lesson(avery, "2026-10-15", "Lunch", "12:00 PM", "12:45 PM")];
  const tabs = defaultTabs();
  const viaPost = buildWorld({ lessons, tabs, props: withAllowed(TEACHER), activeUser: TEACHER });
  const viaApi = buildWorld({ lessons, tabs, props: withAllowed(TEACHER), activeUser: TEACHER });
  for (const action of ["timesheet-status", "preview-timesheet-row", "add-timesheet-row", "list-recaps"]) {
    const body = action === "timesheet-status" || action === "list-recaps" ? {} : keyOf(lessons[0]);
    const a = viaPost.post(action, body);
    const b = JSON.parse(JSON.stringify(viaApi.api(Object.assign({ action }, body))));
    assert.deepEqual(b, a, action);
  }
  // Both paths left the same rows on the time sheet and the same mark on the Lesson Schedule.
  assert.deepEqual(viaApi.shown("2026-2027"), viaPost.shown("2026-2027"));
  assert.equal(viaApi.mark(0), viaPost.mark(0));
  assert.equal(viaApi.mark(0), "Added 10/20/2026");
});

test("api returns errors as { ok: false, error } instead of throwing", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER });
  assert.deepEqual(JSON.parse(JSON.stringify(w.api({ action: "nope" }))), { ok: false, error: "Unknown action: nope" });
  assert.deepEqual(JSON.parse(JSON.stringify(w.api({}))), { ok: false, error: "Missing 'action' in request" });
  const missing = w.api({ action: "preview-event", studentEmail: avery.email, lessonDate: "2030-01-01", startTime: "9:00 AM" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /^No matching row in Lesson Schedule/);
});

test("api never returns a Date (google.script.run can't carry one)", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER });
  // The roster has date-and-time Timestamps; one lesson has a date with a time in it.
  for (const request of [{ action: "list" }, { action: "schedule-list" }, { action: "student", email: avery.email }, { action: "ping" }]) {
    const r = w.api(request);
    assert.equal(containsDate(r), false, JSON.stringify(request));
  }
  assert.equal(w.api({ action: "list" }).students[0].Timestamp, "2026-08-20T13:00:00.000Z");
});

// ─── doGet: the page, and the unchanged GET routes ────────────────────────────────────

test("doGet with no parameters returns the page (Index, titled Music Studio, phone-sized)", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER });
  for (const e of [undefined, {}, { parameter: {} }, { parameter: { secret: SECRET } }]) {
    const out = w.ctx.doGet(e);
    assert.equal(out.from, "file:Index");
    assert.equal(out.getTitle(), "Music Studio");
    assert.equal(out.meta.viewport, "width=device-width, initial-scale=1");
  }
});

test("doGet gives anyone not on ALLOWED_USERS a no-access page with no data", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: "visitor<b>@example.org" });
  const out = w.ctx.doGet({ parameter: {} });
  assert.equal(out.from, "string");
  assert.equal(out.getTitle(), "Music Studio");
  assert.ok(out.getContent().includes("You don&#39;t have access to the Music Studio. Ask Mr. O&#39;Neal."));
  assert.ok(out.getContent().includes("visitor&lt;b&gt;@example.org"));
  assert.ok(!out.getContent().includes(avery.email));
});

test("doGet explains a missing Index file instead of failing", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER, htmlFiles: [] });
  assert.match(w.ctx.doGet({ parameter: {} }).getContent(), /page file is missing/);
});

test("every existing GET route answers exactly as before (secret still required)", () => {
  const w = buildGetRoutesWorld();
  for (const [name, parameter] of getRouteCases()) {
    assert.deepEqual(JSON.parse(w.ctx.doGet({ parameter }).getContent()), GOLDEN[name], name);
  }
});

test("doPost still needs the shared password", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER });
  const out = w.ctx.doPost({ postData: { contents: JSON.stringify({ action: "list-recaps" }) } });
  assert.deepEqual(JSON.parse(out.getContent()), { ok: false, error: "Unauthorized" });
});

// ─── The safety rule: only six functions are reachable from a page ─────────────────────

test("only doGet, doPost, api, authorize, setupSheetFormatting and onFormSubmit lack a trailing _", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "apps-script/Code.gs"), "utf8");
  const publicNames = [...source.matchAll(/^function ([A-Za-z0-9_$]+)\(/gm)].map((m) => m[1]).filter((n) => !n.endsWith("_"));
  assert.deepEqual(publicNames.sort(), ["api", "authorize", "doGet", "doPost", "onFormSubmit", "setupSheetFormatting"]);
});

test("authorize and setupSheetFormatting refuse a page visitor (someone other than the account it runs as)", () => {
  const w = buildGetRoutesWorld({ props: withAllowed(TEACHER), activeUser: TEACHER });
  assert.throws(() => w.ctx.authorize(), /authorize can only be run from the Apps Script editor\./);
  assert.throws(() => w.ctx.setupSheetFormatting(), /setupSheetFormatting can only be run from the Apps Script editor\./);
  assert.throws(() => buildGetRoutesWorld({ activeUser: "" }).ctx.authorize(), /only be run from the Apps Script editor/);
});

test("onFormSubmit refuses anything but a real trigger event, and still works from one", () => {
  const w = buildGetRoutesWorld();
  const values = ["10/6/2026 9:00:00", "new.signup@example.org", "Taylor Example", "Guitar"];
  // What a page could send through google.script.run: plain data, no working Range.
  assert.throws(() => w.ctx.onFormSubmit({ values, range: { getRow: "not a function" } }), /only runs from its form-submit trigger/);
  assert.throws(() => w.ctx.onFormSubmit(), /only runs from its form-submit trigger/);
  assert.equal(w.studio.getSheetByName("new.signup@example.org"), null);
  // A real event carries the Range the answers landed in.
  w.ctx.onFormSubmit({ values, range: w.form.getRange(2, 1, 1, 4) });
  assert.ok(w.studio.getSheetByName("new.signup@example.org"));
});

// ─── authorize report and handoff cleanups ────────────────────────────────────────────

test("authorize logs who the script runs as and ALLOWED_USERS, with a PROBLEM line when empty", () => {
  const w = buildGetRoutesWorld({ props: withAllowed("Teacher.Example@example.org, second.person@example.org") });
  w.ctx.authorize();
  assert.equal(w.logs[0], "Code version: 2026-10-07 post-delivery");
  assert.equal(w.logs[1], "Runs as:                  script.owner@example.org");
  assert.ok(w.logs.includes("OK ALLOWED_USERS: 2 people: teacher.example@example.org, second.person@example.org"), w.logs.join("\n"));

  const one = buildGetRoutesWorld({ props: withAllowed(TEACHER) });
  one.ctx.authorize();
  assert.ok(one.logs.includes("OK ALLOWED_USERS: 1 person: " + TEACHER));

  const none = buildGetRoutesWorld();
  none.ctx.authorize();
  assert.ok(none.logs.some((l) => l.startsWith("PROBLEM ALLOWED_USERS: empty, so nobody can use the Google-hosted page.")));
});

test("calendar invites no longer include the club's maintenance emails; Drive lists are unchanged", () => {
  const w = buildGetRoutesWorld();
  const invites = Array.from(w.ctx.ALWAYS_INVITE_EMAILS);
  assert.equal(invites.length, 2);
  assert.ok(!invites.some((e) => /cauyang|caydenauyang/.test(e)));
  assert.equal(Array.from(w.ctx.CLASS_RESOURCES_EXTRA_VIEWERS).length, 3);
  assert.equal(Array.from(w.ctx.STUDENT_RESOURCES_EXTRA_EDITORS).length, 3);
});
