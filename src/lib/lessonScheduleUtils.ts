// In plain English: this file holds small helpers for making sense of the lesson schedule.
// The schedule comes from the "Lesson Schedule" tab in the studio's Google Sheet (fetched by
// src/api/appsScriptSchedule.ts). These helpers answer questions like: Is this lesson still
// waiting to be put on the calendar ("Pending")? Is it coming up ("Upcoming")? Is it already
// over ("History")? What order should lessons be listed in? How should the time be shown?
// The Dashboard, the Students page, and pieces like LessonRow, PendingLessonsSection, and
// RecapsTimeline use these answers to decide what to show where.
// Nothing here talks to Google; it only looks at lessons that were already loaded.
// Borrow the shape of a "lesson" and a helper that reads dates the way the sheet writes them.
import type { ScheduledLesson } from "../types";
import { parseSheetDate } from "./dateUtils";

// Tidy a lesson's Status cell by trimming extra spaces from both ends.
/** Trim; comparisons use lowercase where noted. */
export function normalizeStatus(status: string): string {
  return status.trim();
}

// Give back the Status in lowercase for easy comparing; a blank Status counts as
// "scheduled".
/**
 * Treat a blank status cell as "scheduled" so a teacher who forgets to fill
 * the Status column still sees the lesson on the dashboard.
 *
 * Phase 2 caveat: a lesson is treated as Pending (not Upcoming) when its
 * Status is blank/Draft *and* it has no Calendar Event ID — see
 * `isPendingLesson` below. Callers that want the Upcoming view must
 * exclude pending rows separately.
 */
function statusLowerOrDefault(status: string): string {
  const s = normalizeStatus(status).toLowerCase();
  return s.length ? s : "scheduled";
}

// Given a moment in time, give back midnight at the start of that same day (local time).
// This lets us compare which day two moments fall on, ignoring the time of day.
/** Start of calendar day in local timezone (for school block scheduling). */
export function startOfLocalDay(d: Date): Date {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

// Read the lesson's date from the sheet and turn it into a real date. Gives back nothing
// (null) if the date cell is blank or unreadable.
/**
 * Parse lesson date for comparisons. Handles "yyyy-MM-dd" (date-only sheet
 * cells) as a local date, and ISO/other strings via the standard Date
 * constructor. Invalid values return null.
 */
export function lessonDateTime(lesson: ScheduledLesson): Date | null {
  return parseSheetDate(lesson.lessonDate);
}

// Work out the exact moment a lesson ends: its date plus its end time (like "3:00 PM").
// Gives back nothing if either the date or the end time can't be read.
/**
 * Combine the lesson date with the parsed end-time for same-day comparisons.
 * Returns null when either side is unparseable.
 */
function lessonEndDateTime(lesson: ScheduledLesson): Date | null {
  const day = lessonDateTime(lesson);
  if (!day) return null;
  const t = lesson.endTime.trim();
  // Match times written like "3:00", "3:00 PM", or "15:00". The pattern picks out the hour,
  // the minutes, and AM or PM if present.
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(t);
  if (!m) return null;
  // Switch to a 24-hour clock: 1 PM becomes 13, and 12 AM (midnight) becomes 0.
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const period = m[3]?.toUpperCase();
  if (period === "PM" && hour < 12) hour += 12;
  else if (period === "AM" && hour === 12) hour = 0;
  // Put that hour and minute onto the lesson's date.
  const result = new Date(day);
  result.setHours(hour, minute, 0, 0);
  return result;
}

// Turn a time cell from the sheet into text that is safe to show, like "11:30 AM".
// Gives back nothing (null) if the time is blank or can't be shown safely.
/**
 * Apps Script formats time-only cells as wall-clock strings ("h:mm a"), so the
 * common case is "11:30 AM" / "1:02 PM". Display those as-is — never round-trip
 * through `new Date()`, which can latch onto today's date and break formatting.
 *
 * The 1899-12-30 ISO branches stay for backward compatibility with older Apps
 * Script deployments that haven't been updated yet.
 */
export function formatSheetTimeForDisplay(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;

  // Most common case: the time is already written like "11:30 AM", so show it as-is.
  if (/^\d{1,2}:\d{2}(\s*[AP]M)?$/i.test(t)) return t;

  // Otherwise, try reading it as a full date and time.
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;

  // Google Sheets stores a time with no date as a moment on Dec 30, 1899 (its "day zero").
  // If we see that, show just the time part. Any other full date isn't trusted, so show nothing.
  const y = d.getFullYear();
  if (y < 1905 || /1899-12-3[01]/i.test(t)) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return null;
}

// Build the time range shown for a lesson, like "2:30 PM–3:00 PM". If only one side can
// be shown safely, show just that side; if neither can, give back nothing.
/** "2:30 PM – 3:00 PM" only when at least one side is safe; never raw serial strings. */
export function formatLessonTimeRangeForDisplay(
  lesson: ScheduledLesson
): string | null {
  const a = formatSheetTimeForDisplay(lesson.startTime);
  const b = formatSheetTimeForDisplay(lesson.endTime);
  if (a && b) return `${a}–${b}`;
  if (a) return a;
  if (b) return b;
  return null;
}

// Show the lesson's block (the school's name for its class period), or "-" if it's blank.
/** Lesson block only (no raw sheet time strings in UI). */
export function formatLessonBlockDisplay(lesson: ScheduledLesson): string {
  const block = lesson.lessonBlock.trim();
  return block.length ? block : "-";
}

// Decide whether a lesson is "Pending": the teacher entered it in the sheet but hasn't yet
// used "Preview & schedule" to put it on Google Calendar. Gives back true or false.
// "now" is the current time; a different time can be passed in for testing.
/**
 * Phase 2: Pending = a row the teacher has filled in but hasn't run
 * "Preview & schedule" on yet. We detect this by:
 *   - no Calendar Event ID written back
 *   - Status is blank or literally "Draft"
 *   - lesson is today or in the future
 *
 * Completed/Cancelled rows never count as Pending. Once an event is
 * created, the Apps Script side writes the Event ID and flips Status
 * to "Scheduled", which moves the row into Upcoming on the next refresh.
 */
export function isPendingLesson(lesson: ScheduledLesson, now: Date = new Date()): boolean {
  // It already has a calendar event, so it isn't pending.
  if (lesson.calendarEventId.trim() !== "") return false;
  // Only a blank or "Draft" Status counts as pending.
  const st = normalizeStatus(lesson.status).toLowerCase();
  if (st !== "" && st !== "draft") return false;

  // Lessons on earlier days aren't pending; lessons on later days are.
  const dt = lessonDateTime(lesson);
  if (!dt) return false;
  const dayStart = startOfLocalDay(now);
  const lessonDay = startOfLocalDay(dt);
  if (lessonDay.getTime() < dayStart.getTime()) return false;
  if (lessonDay.getTime() > dayStart.getTime()) return true;

  // For a lesson today, it stays pending until its end time passes. If the end time
  // can't be read, keep it pending for the whole day.
  const endDt = lessonEndDateTime(lesson);
  if (!endDt) return true;
  return endDt.getTime() >= now.getTime();
}

// Decide whether a lesson is "Upcoming": not pending, marked Scheduled or Rescheduled
// (a blank Status counts as Scheduled), and not over yet. Gives back true or false.
/**
 * Upcoming = future date OR same day with end time still ahead, AND status is
 * Scheduled / Rescheduled (or blank, treated as Scheduled). Completed and
 * Cancelled are excluded so the dashboard stays forward-looking. A same-day
 * lesson rolls off "Upcoming" once its end time has passed.
 *
 * Phase 2: rows that satisfy `isPendingLesson` are excluded so the same
 * row never appears in both the Pending and Upcoming sections.
 */
export function isUpcomingLesson(lesson: ScheduledLesson, now: Date = new Date()): boolean {
  // A lesson can't be both Pending and Upcoming, so pending ones are left out here.
  if (isPendingLesson(lesson, now)) return false;
  // Skip Completed and Cancelled lessons, and anything not Scheduled or Rescheduled.
  const st = statusLowerOrDefault(lesson.status);
  if (st === "completed" || st === "cancelled") return false;
  if (st !== "scheduled" && st !== "rescheduled") return false;

  // Earlier days: no. Later days: yes. Today: only until the lesson's end time passes
  // (or all day, if the end time can't be read).
  const dt = lessonDateTime(lesson);
  if (!dt) return false;
  const dayStart = startOfLocalDay(now);
  const lessonDay = startOfLocalDay(dt);
  if (lessonDay.getTime() < dayStart.getTime()) return false;
  if (lessonDay.getTime() > dayStart.getTime()) return true;

  const endDt = lessonEndDateTime(lesson);
  if (!endDt) return true;
  return endDt.getTime() >= now.getTime();
}

// Give back only the pending lessons, soonest first. Used by the Dashboard's Pending card.
/** All pending lessons sorted soonest-first (Dashboard "Pending" section). */
export function pendingLessonsSorted(
  lessons: ScheduledLesson[],
  now?: Date
): ScheduledLesson[] {
  return lessons
    .filter((l) => isPendingLesson(l, now))
    .sort(compareLessonsByDateTime);
}

// Turn a time cell (like "9:00 AM", "1:30 PM", or "15:00") into minutes after midnight, so
// times can be put in real clock order. Gives back nothing (null) if the time can't be read.
// We can't just sort the words, because as text "10:00 AM" comes before "9:00 AM" (the
// character "1" comes before "9"), and "1:00 PM" would come before "11:00 AM".
function timeOfDayMinutes(raw: string): number | null {
  // Most common case: the time is written like "9:00 AM" or "15:00".
  const t = raw.trim();
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(t);
  if (m) {
    // Switch to a 24-hour clock: 1 PM becomes 13, and 12 AM (midnight) becomes 0.
    let hour = Number(m[1]);
    const period = m[3]?.toUpperCase();
    if (period === "PM" && hour < 12) hour += 12;
    else if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + Number(m[2]);
  }
  // Older versions of the Apps Script send a time as a moment on Dec 30, 1899 (Google Sheets'
  // "day zero"). Read the clock time from that, the same way formatSheetTimeForDisplay does.
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() < 1905 || /1899-12-3[01]/i.test(t)) {
    return d.getHours() * 60 + d.getMinutes();
  }
  return null;
}

// Put two times of day in order, earliest first. A lesson whose time can't be read goes after
// lessons whose time is known. Gives back 0 when the two can't be told apart this way.
function compareTimesOfDay(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// The rule for putting two lessons in order: earlier date first; on the same date, earlier
// start time first (by the real clock, so 9:00 AM comes before 10:00 AM), then earlier end
// time. Lessons with no readable time come after timed ones that day and are ordered by their
// lesson block name. If still tied, order by student email alphabetically.
// A lesson with an unreadable date is treated as coming before all the others.
export function compareLessonsByDateTime(a: ScheduledLesson, b: ScheduledLesson): number {
  const da = lessonDateTime(a)?.getTime() ?? 0;
  const db = lessonDateTime(b)?.getTime() ?? 0;
  if (da !== db) return da - db;
  // Same day: compare start times, then end times, as minutes after midnight.
  const byStart = compareTimesOfDay(timeOfDayMinutes(a.startTime), timeOfDayMinutes(b.startTime));
  if (byStart !== 0) return byStart;
  const byEnd = compareTimesOfDay(timeOfDayMinutes(a.endTime), timeOfDayMinutes(b.endTime));
  if (byEnd !== 0) return byEnd;
  // Still tied (often because neither lesson has a time): order by the block name, like "A Block".
  const ba = a.lessonBlock.trim();
  const bb = b.lessonBlock.trim();
  if (ba !== bb) return ba.localeCompare(bb, undefined, { sensitivity: "base" });
  return a.studentEmail.localeCompare(b.studentEmail, undefined, {
    sensitivity: "base",
  });
}

// Make emails easy to compare: trim spaces and lowercase, so "Sam@X.com " matches
// "sam@x.com".
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

// Decide whether a lesson belongs in a student's "History" list. Gives back true or false.
/**
 * History: completed, lesson date before today, or same-day lesson whose end
 * time has passed. Cancelled rows are omitted.
 */
export function isPastOrCompletedRecent(lesson: ScheduledLesson, now: Date = new Date()): boolean {
  // Cancelled lessons never show in History; Completed ones always do.
  const st = statusLowerOrDefault(lesson.status);
  if (st === "cancelled") return false;
  if (st === "completed") return true;

  // Otherwise: earlier days count, later days don't, and a lesson today counts once its end
  // time has passed. If today's end time can't be read, don't count it yet.
  const dt = lessonDateTime(lesson);
  if (!dt) return false;
  const dayStart = startOfLocalDay(now);
  const lessonDay = startOfLocalDay(dt);
  if (lessonDay.getTime() < dayStart.getTime()) return true;
  if (lessonDay.getTime() > dayStart.getTime()) return false;

  const endDt = lessonEndDateTime(lesson);
  if (!endDt) return false;
  return endDt.getTime() < now.getTime();
}

// The same ordering rule as above, but reversed: newest lesson first.
export function compareLessonsByDateTimeDesc(a: ScheduledLesson, b: ScheduledLesson): number {
  return compareLessonsByDateTime(b, a);
}

// How one student's lessons are split up for their profile panel: the very next lesson,
// the rest of their upcoming lessons, and their past lessons (newest first).
export type StudentLessonPartition = {
  nextLesson: ScheduledLesson | null;
  upcomingLessons: ScheduledLesson[];
  /** All historical lessons newest-first; UI may cap how many it renders. */
  recentLessons: ScheduledLesson[];
};

// Split the full schedule into one student's next lesson, other upcoming lessons, and
// history. It is given every lesson plus the student's email, and gives back the three groups.
/**
 * Filter by student email, then split into next / rest of upcoming / recent
 * history. The recent list is no longer pre-truncated so the UI can show a
 * count + "Show all" affordance instead of silently dropping rows.
 */
export function partitionStudentLessons(
  lessons: ScheduledLesson[],
  studentEmail: string
): StudentLessonPartition {
  // Keep only this student's lessons.
  const key = emailKey(studentEmail);
  const mine = lessons.filter((l) => emailKey(l.studentEmail) === key);

  // Their upcoming lessons in order; the first is "next", and the rest follow.
  const upcomingSorted = mine
    .filter((l) => isUpcomingLesson(l))
    .sort(compareLessonsByDateTime);

  const nextLesson = upcomingSorted[0] ?? null;
  const upcomingLessons = upcomingSorted.slice(1);

  // Their past lessons, newest first.
  const recentLessons = mine
    .filter((l) => isPastOrCompletedRecent(l))
    .sort(compareLessonsByDateTimeDesc);

  return { nextLesson, upcomingLessons, recentLessons };
}

// Every upcoming lesson for every student, soonest first. Used by the Dashboard.
/** Dashboard: all upcoming lessons, soonest first (cap optional in UI). */
export function upcomingLessonsSorted(lessons: ScheduledLesson[], now?: Date): ScheduledLesson[] {
  return lessons
    .filter((l) => isUpcomingLesson(l, now))
    .sort(compareLessonsByDateTime);
}

// Build a label that identifies a lesson in an on-screen list. React (the tool that builds
// this website's pages) needs a unique label for each item in a list so it can keep track of
// which is which when the list changes. The sheet has no ID column, so we join together the
// student's email, the date, the start time, the block, and the lesson's position in the list.
/** Stable-enough key for list items when the sheet has no row id. */
export function lessonStableKey(lesson: ScheduledLesson, index: number): string {
  return `${lesson.studentEmail}|${lesson.lessonDate}|${lesson.startTime}|${lesson.lessonBlock}|${index}`;
}

// Choose what to show for "when" in a lesson row: the block name if there is one,
// otherwise the time range, otherwise "-".
/**
 * Prefer block; only show times when safely formatted (never raw 1899-… strings).
 */
export function formatLessonBlockOrTime(lesson: ScheduledLesson): string {
  const block = lesson.lessonBlock.trim();
  if (block) return block;
  const range = formatLessonTimeRangeForDisplay(lesson);
  if (range) return range;
  return "-";
}
