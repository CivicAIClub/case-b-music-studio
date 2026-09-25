/**
 * Phase 2 — Calendar event creation client.
 *
 * Each action targets one row in the "Lesson Schedule" sheet, identified
 * by the composite key { studentEmail, lessonDate, startTime }. The Apps
 * Script side (`apps-script/Code.gs`) does the row lookup and writes
 * back the resulting Calendar Event ID + Status.
 *
 * Flow:
 *   1. Dashboard renders pending lessons (no Calendar Event ID yet).
 *   2. Teacher clicks Preview → frontend calls `previewCalendarEvent`
 *      to fetch event details *without* touching the calendar.
 *   3. Modal renders preview → teacher confirms → frontend calls
 *      `createCalendarEvent` which actually creates the event and
 *      sends Google Calendar invites to all attendees.
 *   4. Frontend re-fetches the schedule; the row now has a Calendar
 *      Event ID and Status="Scheduled" so it moves out of Pending and
 *      into Upcoming.
 */
import { postToAppsScript, type AppsScriptPostInit } from "./appsScriptPost";

/** Composite key — must match a row in the Lesson Schedule sheet. */
export type LessonRowKey = {
  studentEmail: string;
  lessonDate: string;
  startTime: string;
};

/**
 * Calendar event metadata as the frontend renders it. The backend builds
 * this for both preview (no side effects) and create (returns the same
 * shape under `preview` when the row was already scheduled).
 */
export type EventPreview = {
  title: string;
  /** ISO timestamp the calendar event will start at (in the spreadsheet's TZ). */
  startISO: string;
  /** ISO timestamp the calendar event will end at. */
  endISO: string;
  /** Email addresses that will receive Google Calendar invites. */
  attendees: string[];
  /** Plain-text body of the event description. */
  description: string;
  /** Display name of the calendar the event will land on. */
  calendarName: string;
  /** True if a Calendar Event ID is already on the sheet row. */
  alreadyScheduled: boolean;
  /** Existing event ID when alreadyScheduled is true. */
  calendarEventId: string | null;
  studentEmail: string;
  studentName: string;
  lessonDate: string;
  startTime: string;
  endTime: string;
};

type PreviewResponse = {
  ok: true;
  preview: EventPreview;
};

type CreateResponse = {
  ok: true;
  alreadyScheduled: boolean;
  calendarEventId: string;
  eventLink: string | null;
  /** Present when the event already existed; the backend returns its preview shape. */
  preview?: EventPreview;
};

// What the script sends back after a cancel request. "cancelled" is false when the lesson row
// had no Calendar Event ID (nothing was on the calendar to delete); "reason" then says why.
type CancelResponse = {
  ok: true;
  cancelled: boolean;
  reason?: string;
};

/** Reads the lesson row and returns the proposed calendar event details. */
export async function previewCalendarEvent(
  key: LessonRowKey,
  init?: AppsScriptPostInit
): Promise<EventPreview> {
  const result = await postToAppsScript<PreviewResponse>(
    "preview-event",
    keyAsPayload(key),
    init
  );
  return result.preview;
}

/**
 * Creates the calendar event, sends invites, writes the Event ID back
 * to the sheet row. Idempotent: returns `alreadyScheduled: true` plus
 * the existing event ID without creating a duplicate.
 *
 * Pass `attendees` to override the auto-built invitee list (typically
 * from the modal where the teacher added/removed attendees inline).
 * The backend enforces "at least one attendee" — passing `[]` will
 * surface as an `ok:false` error rather than silently falling back.
 */
export async function createCalendarEvent(
  key: LessonRowKey,
  options?: { attendees?: string[] },
  init?: AppsScriptPostInit
): Promise<{ calendarEventId: string; alreadyScheduled: boolean; eventLink: string | null }> {
  const payload: Record<string, unknown> = keyAsPayload(key);
  if (options?.attendees) {
    payload.attendees = options.attendees;
  }
  const result = await postToAppsScript<CreateResponse>(
    "create-event",
    payload,
    init
  );
  return {
    calendarEventId: result.calendarEventId,
    alreadyScheduled: result.alreadyScheduled,
    eventLink: result.eventLink,
  };
}

/**
 * Cancels and clears the calendar event for this lesson. Sets the
 * row's Status to "Cancelled" so it drops out of Pending and Upcoming.
 * Resolves with `cancelled: false` (and the server's `reason`) when the
 * row had no Calendar Event ID, in which case nothing was changed.
 */
// Ask the script to cancel one lesson. Gives back whether anything was actually cancelled,
// plus the script's explanation when nothing was, so the page can tell the teacher.
export async function cancelCalendarEvent(
  key: LessonRowKey,
  init?: AppsScriptPostInit
): Promise<{ cancelled: boolean; reason: string | null }> {
  const result = await postToAppsScript<CancelResponse>(
    "cancel-event",
    keyAsPayload(key),
    init
  );
  // Only an explicit "true" counts as cancelled; anything else means nothing was changed.
  return {
    cancelled: result.cancelled === true,
    reason: typeof result.reason === "string" ? result.reason : null,
  };
}

function keyAsPayload(key: LessonRowKey): Record<string, unknown> {
  return {
    studentEmail: key.studentEmail.trim(),
    lessonDate: key.lessonDate.trim(),
    startTime: key.startTime.trim(),
  };
}
