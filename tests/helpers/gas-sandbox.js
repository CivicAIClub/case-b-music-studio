// gas-sandbox.js: runs apps-script/Code.gs inside Node for testing.
//
// Apps Script files share one global scope, so Code.gs is loaded into a single Node "vm" context
// (a separate JavaScript world) along with pretend ("fake") Google services from fake-google.js.
// The clock inside the sandbox is frozen at a chosen moment, so "today" is the same on every run.
//
//   const sb = createSandbox({ now: "2026-10-06T20:00:00-04:00" });
//   Object.assign(sb.context, fakeGlobals);   // SpreadsheetApp, PropertiesService, ...
//   loadCode(sb.context);                      // runs Code.gs
//   sb.context.handlePing({});                 // call anything Code.gs defines
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Copies a value out of the sandbox into plain Node objects, so assert.deepStrictEqual can
// compare it (objects made inside the sandbox have different prototypes).
export function toPlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pad(n, width) {
  let s = String(n);
  while (s.length < width) s = "0" + s;
  return s;
}

// The wall-clock parts of a moment in a time zone (weekday: 1 = Monday ... 7 = Sunday).
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    weekday: "short", hourCycle: "h23",
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS_SHORT.indexOf(p.weekday) + 1,
  };
}

function formatField(letter, count, t, date, timeZone) {
  switch (letter) {
    case "y": return count === 2 ? pad(t.year % 100, 2) : pad(t.year, count);
    case "M":
      if (count >= 4) return MONTHS_LONG[t.month - 1];
      if (count === 3) return MONTHS_SHORT[t.month - 1];
      return pad(t.month, count);
    case "d": return pad(t.day, count);
    case "E": return count >= 4 ? WEEKDAYS_LONG[t.weekday - 1] : WEEKDAYS_SHORT[t.weekday - 1];
    case "u": return pad(t.weekday, count);
    case "H": return pad(t.hour, count);
    case "h": return pad(t.hour % 12 || 12, count);
    case "m": return pad(t.minute, count);
    case "s": return pad(t.second, count);
    case "a": return t.hour < 12 ? "AM" : "PM";
    case "X": {
      const offsetMin = Math.round(offsetMs(date.getTime(), timeZone) / 60000);
      if (offsetMin === 0) return "Z";
      const sign = offsetMin < 0 ? "-" : "+";
      const abs = Math.abs(offsetMin);
      return sign + pad(Math.floor(abs / 60), 2) + ":" + pad(abs % 60, 2);
    }
    default:
      throw new Error(`Utilities.formatDate fake: pattern letter "${letter}" is not supported`);
  }
}

// Fake of Utilities.formatDate, using Java SimpleDateFormat pattern letters like Apps Script.
export function formatDate(date, timeZone, pattern) {
  if (!date || typeof date.getTime !== "function" || Number.isNaN(date.getTime())) {
    throw new TypeError("Utilities.formatDate fake: first argument must be a valid Date");
  }
  if (typeof timeZone !== "string" || typeof pattern !== "string") {
    throw new TypeError("Utilities.formatDate fake: timeZone and pattern must be strings");
  }
  const t = localParts(new Date(date.getTime()), timeZone);
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      i++;
      while (i < pattern.length) {
        if (pattern[i] === "'" && pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (pattern[i] === "'") { i++; break; }
        out += pattern[i++];
      }
    } else if (/[A-Za-z]/.test(ch)) {
      let count = 1;
      while (pattern[i + count] === ch) count++;
      out += formatField(ch, count, t, date, timeZone);
      i += count;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// How far a time zone's wall clock is ahead of UTC at a given moment, in milliseconds.
function offsetMs(ms, timeZone) {
  const t = localParts(new Date(ms), timeZone);
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

// The moment (milliseconds since 1970) when a time zone's wall clock reads the given time.
export function zonedMs(year, month, day, hour = 0, minute = 0, second = 0, timeZone = "America/New_York") {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let ms = guess - offsetMs(guess, timeZone);
  // Re-check once, in case the guess crossed a daylight-saving change.
  ms = guess - offsetMs(ms, timeZone);
  return ms;
}

// Fake of Utilities.parseDate for the two patterns Code.gs uses. `MakeDate` is the sandbox's
// Date, so the result passes `instanceof Date` inside Code.gs.
export function makeParseDate(MakeDate) {
  return function parseDate(text, timeZone, pattern) {
    let m;
    if (pattern === "yyyy-MM-dd") {
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
      if (!m) throw new Error(`Unparseable date: "${text}"`);
      return new MakeDate(zonedMs(+m[1], +m[2], +m[3], 0, 0, 0, timeZone));
    }
    if (pattern === "yyyy-MM-dd HH:mm:ss") {
      m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text));
      if (!m) throw new Error(`Unparseable date: "${text}"`);
      return new MakeDate(zonedMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], timeZone));
    }
    throw new Error(`Utilities.parseDate fake: pattern "${pattern}" is not supported`);
  };
}

// Makes the sandbox with its clock frozen at `now` (an ISO date-time string). `new Date()` and
// `Date.now()` inside Code.gs give that moment; `new Date(x)` still works normally.
export function createSandbox({ now }) {
  const context = vm.createContext({ console });
  context.__FIXED_NOW__ = new Date(now).getTime();
  vm.runInContext(`
    (function () {
      var RealDate = Date;
      var fixed = globalThis.__FIXED_NOW__;
      class FixedDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(fixed);
          else super(...args);
        }
        static now() { return fixed; }
      }
      globalThis.Date = FixedDate;
    })();
  `, context);
  return { context, SandboxDate: context.Date };
}

// Runs Code.gs inside the sandbox. Call this after the fake services are in place.
export function loadCode(context, file = "apps-script/Code.gs") {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  vm.runInContext(source, context, { filename: file });
}
