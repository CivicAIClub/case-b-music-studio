// In plain English: this file is the Dashboard's "Time sheet" card (Phase 6). Mr. O'Neal is
// paid per private lesson and logs every lesson in a payroll time sheet (a separate Google
// Sheet). This card lists the lessons that have ended but aren't on that time sheet yet, oldest
// first, so he can add each one with a click instead of typing it twice. "Preview" opens the
// pop-up in TimesheetPreviewModal.tsx; "Skip" marks a lesson that didn't happen (or that he
// already typed in) so it leaves the list. Lessons dated before the time sheet's start date
// (the TIMESHEET_START_DATE setting in Apps Script) are never listed: those were typed in by hand.
// It is built like the Pending lessons card (PendingLessonsSection.tsx) and, like the Class
// Resources card, asks the Apps Script for its own status when the page opens.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getTimesheetStatus,
  skipTimesheetRow,
  type TimesheetStatus,
} from "../api/appsScriptTimesheet";
import type { LessonRowKey } from "../api/appsScriptCalendar";
import {
  formatLessonBlockDisplay,
  formatLessonTimeRangeForDisplay,
  lessonDateTime,
  timesheetLessonsSorted,
} from "../lib/lessonScheduleUtils";
import { lessonCalendarTab } from "../lib/displayUtils";
import { formatLessonDateLong, formatLessonDateShort } from "../lib/dateUtils";
import { TimesheetPreviewModal } from "./TimesheetPreviewModal";
import type { ScheduledLesson } from "../types";

// Where the card stands: still asking Google, connected (or not), or the question failed.
type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: TimesheetStatus }
  | { kind: "error"; message: string };

// A label for one lesson: student email, date and start time joined together.
function keyString(key: LessonRowKey): string {
  return `${key.studentEmail.trim().toLowerCase()}|${key.lessonDate}|${key.startTime}`;
}

function keyOf(lesson: ScheduledLesson): LessonRowKey {
  return { studentEmail: lesson.studentEmail, lessonDate: lesson.lessonDate, startTime: lesson.startTime };
}

/**
 * Dashboard card for Phase 6. `lessons` is the whole Lesson Schedule (already loaded by the
 * Dashboard); `onChanged` asks the Dashboard to reload it after a lesson is added or skipped.
 */
export function TimesheetSection({
  lessons,
  scheduleLoadStatus,
  onChanged,
}: {
  lessons: ScheduledLesson[];
  scheduleLoadStatus: "idle" | "loading" | "ok" | "error";
  onChanged: () => void;
}) {
  const [state, setState] = useState<StatusState>({ kind: "loading" });
  // The lesson open in the preview pop-up (and its student's name for the header).
  const [preview, setPreview] = useState<{ key: LessonRowKey; name: string } | null>(null);
  // Lessons added or skipped in this visit, hidden right away while the schedule reloads.
  const [done, setDone] = useState<Set<string>>(() => new Set());
  // The lesson whose Skip is being sent (its buttons are grayed out meanwhile).
  const [skipping, setSkipping] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Ask the Apps Script whether the time sheet is connected.
  const load = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: "loading" });
    getTimesheetStatus({ signal: ac.signal })
      .then((status) => setState({ kind: "ready", status }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not check the time sheet.",
        });
      });
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  // The lessons to list: ended, on or after the start date, not cancelled, not yet marked.
  const startDate = state.kind === "ready" && state.status.configured ? state.status.startDate : null;
  const toLog = useMemo(() => {
    if (!startDate) return [];
    return timesheetLessonsSorted(lessons, startDate).filter((l) => !done.has(keyString(keyOf(l))));
  }, [lessons, startDate, done]);

  // After an add or a skip: hide the lesson now, and reload the schedule to confirm it.
  const markDone = useCallback(
    (key: LessonRowKey) => {
      setDone((prev) => new Set(prev).add(keyString(key)));
      onChanged();
    },
    [onChanged]
  );

  // "Skip": confirm first, then mark the lesson Skipped (the time sheet itself isn't touched).
  const handleSkip = useCallback(
    async (lesson: ScheduledLesson) => {
      const who = lesson.studentName.trim() || lesson.studentEmail;
      const ok = window.confirm(
        `Skip ${who}'s lesson on ${formatLessonDateShort(lesson.lessonDate)}?\n\n` +
          "It won't be added to the time sheet, and it will leave this list. Use this when the lesson " +
          "didn't happen or is already on the time sheet."
      );
      if (!ok) return;
      const key = keyOf(lesson);
      setSkipping(keyString(key));
      try {
        await skipTimesheetRow(key);
        markDone(key);
      } catch (err) {
        window.alert("Skip failed: " + (err instanceof Error ? err.message : "please try again."));
      } finally {
        setSkipping(null);
      }
    },
    [markDone]
  );

  // An older Code.gs doesn't know these actions yet; that just means "not connected yet".
  const notConnected =
    (state.kind === "ready" && !state.status.configured) ||
    (state.kind === "error" && /^Unknown action/i.test(state.message));
  const status = state.kind === "ready" && state.status.configured ? state.status : null;

  // The pop-up sits next to the card (not inside it), like the calendar pop-up on the Dashboard.
  return (
    <>
      <section className="card span-2 pending-lessons-card timesheet-card" aria-labelledby="timesheet-h">
        <div className="timesheet-card__header">
          <div>
            <h2 id="timesheet-h" className="card__title">
              <span aria-hidden="true">🧾</span> Time sheet
            </h2>
            {status && status.startDate && toLog.length > 0 && (
              <p className="muted profile-updates-intro">
                Lessons since {formatLessonDateLong(status.startDate)} that have ended and aren&rsquo;t on the
                time sheet yet, oldest first. Preview each one, then add it.
              </p>
            )}
          </div>
          {status && status.sheetUrl && (
            <a
              className="button button--ghost timesheet-card__open"
              href={status.sheetUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open time sheet ↗
            </a>
          )}
        </div>

        {state.kind === "loading" && <p className="muted">Checking the time sheet…</p>}

        {notConnected && (
          <p className="placeholder-text" title={state.kind === "ready" ? state.status.reason : undefined}>
            {"The time sheet isn't connected yet"}
          </p>
        )}

        {state.kind === "error" && !notConnected && (
          <div className="timesheet-card__error">
            <p className="status-error" role="alert">
              Couldn&rsquo;t check the time sheet: {state.message}
            </p>
            <button type="button" className="button button--ghost" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {status && (
          <TimesheetList
            lessons={toLog}
            scheduleLoadStatus={scheduleLoadStatus}
            startDate={status.startDate ?? ""}
            skipping={skipping}
            onPreview={(lesson) =>
              setPreview({ key: keyOf(lesson), name: lesson.studentName.trim() || lesson.studentEmail })
            }
            onSkip={handleSkip}
          />
        )}
      </section>

      <TimesheetPreviewModal
        lessonKey={preview ? preview.key : null}
        studentName={preview ? preview.name : ""}
        onClose={() => setPreview(null)}
        onAdded={markDone}
      />
    </>
  );
}

// The list of lessons to log (or one line saying there's nothing to log).
function TimesheetList({
  lessons,
  scheduleLoadStatus,
  startDate,
  skipping,
  onPreview,
  onSkip,
}: {
  lessons: ScheduledLesson[];
  scheduleLoadStatus: "idle" | "loading" | "ok" | "error";
  startDate: string;
  skipping: string | null;
  onPreview: (lesson: ScheduledLesson) => void;
  onSkip: (lesson: ScheduledLesson) => void;
}) {
  // While the schedule loads for the first time there is nothing to list yet. (On a reload the
  // Dashboard keeps the old list, so the card doesn't flicker.)
  if (lessons.length === 0 && (scheduleLoadStatus === "loading" || scheduleLoadStatus === "idle")) {
    return <p className="muted">Loading lessons…</p>;
  }
  if (lessons.length === 0 && scheduleLoadStatus === "error") {
    return <p className="muted">The Lesson Schedule didn&rsquo;t load (see Upcoming lessons below).</p>;
  }
  if (lessons.length === 0) {
    return (
      <p className="placeholder-text">
        Nothing to log: every lesson since {formatLessonDateShort(startDate)} that has ended is on the time sheet
        or skipped.
      </p>
    );
  }
  return (
    <ul className="pending-list">
      {lessons.map((lesson) => {
        const key = keyString(keyOf(lesson));
        return (
          <TimesheetItem
            key={key}
            lesson={lesson}
            busy={skipping === key}
            onPreview={() => onPreview(lesson)}
            onSkip={() => onSkip(lesson)}
          />
        );
      })}
    </ul>
  );
}

// One lesson in the list: a date tab, the student and lesson details, and the two buttons.
function TimesheetItem({
  lesson,
  busy,
  onPreview,
  onSkip,
}: {
  lesson: ScheduledLesson;
  busy: boolean;
  onPreview: () => void;
  onSkip: () => void;
}) {
  const tab = lessonCalendarTab(lessonDateTime(lesson));
  const block = formatLessonBlockDisplay(lesson);
  const timeRange = formatLessonTimeRangeForDisplay(lesson);
  const studentLabel = lesson.studentName.trim() || lesson.studentEmail;

  return (
    <li className="pending-list__item">
      <div className="pending-list__date" aria-hidden={tab ? undefined : true}>
        {tab ? (
          <>
            <span className="lesson-row__date-day">{tab.weekday}</span>
            <span className="lesson-row__date-num">{tab.day}</span>
            <span className="lesson-row__date-month">{tab.month}</span>
          </>
        ) : (
          <span className="lesson-row__date-num">?</span>
        )}
      </div>

      <div className="pending-list__main">
        <span className="pending-list__name strong">{studentLabel}</span>
        <span className="pending-list__meta muted">
          <span>{block}</span>
          {timeRange && (
            <>
              <span aria-hidden="true">·</span>
              <span>{timeRange}</span>
            </>
          )}
        </span>
      </div>

      <div className="pending-list__action timesheet-card__actions">
        <button type="button" className="button button--ghost" onClick={onSkip} disabled={busy}>
          {busy ? "Skipping…" : "Skip"}
        </button>
        <button type="button" className="button" onClick={onPreview} disabled={busy}>
          Preview
        </button>
      </div>
    </li>
  );
}
