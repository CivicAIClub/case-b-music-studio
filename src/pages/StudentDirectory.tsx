// StudentDirectory.tsx: the "Students" page, the teacher's roster of music students. On the
// left are a search box, Instrument and Level filters, and one card per student. Clicking a
// card opens that student's full profile on the right, on the same page: their Google Form
// answers, past form submissions, booked lessons, lesson recaps, their personal Google Drive
// folder, and private teacher notes.
// The site is built with React (a toolkit for building web pages out of reusable pieces
// called "components"). This file holds two: StudentDetailPanel (the profile on the right)
// and StudentDirectory (the whole page).
// Data comes from the studio's Google Sheet through the Google Apps Script web app
// (apps-script/Code.gs): the roster and one student's answers via src/api/appsScriptStudent.ts,
// lessons via appsScriptSchedule.ts, recaps via appsScriptRecaps.ts, and lesson cancelling via
// appsScriptCalendar.ts. Teacher notes are NOT sent to Google; they stay in this web browser.
// The "import" lines below borrow those pieces, plus React's built-in helpers, from other files.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { cancelCalendarEvent } from "../api/appsScriptCalendar";
import { getStudentSchedule } from "../api/appsScriptSchedule";
import type { SheetStudentProfile } from "../api/mapSheetStudentResponse";
import { getAllStudents, getStudentByEmail } from "../api/appsScriptStudent";
import { FormSubmissionHistorySection } from "../components/FormSubmissionHistorySection";
import { sheetProfileToStudent } from "../api/studentFromSheet";
import {
  lessonStableKey,
  partitionStudentLessons,
} from "../lib/lessonScheduleUtils";
import {
  formatLessonDateLong,
  formatLessonDateShort,
} from "../lib/dateUtils";
import { studentInitials } from "../lib/displayUtils";
import { LessonRow } from "../components/LessonRow";
import { StudentResourcesSection } from "../components/StudentResourcesSection";
import { RecapsTimeline } from "../components/RecapsTimeline";
import {
  RecapEditorModal,
  type RecapEditorTarget,
} from "../components/RecapEditorModal";
import { listRecapsForStudent } from "../api/appsScriptRecaps";
import type { LessonRecap, ScheduledLesson, Student } from "../types";

// How many past lessons to show under "Recent" before the teacher asks to see all of them.
const RECENT_LESSONS_INITIAL_VISIBLE = 5;

// The possible situations for each thing this page loads from Google: not started yet
// ("idle"), in progress ("loading"), finished ("success", with the data), or failed ("error",
// with a message). This one is for one student's latest form answers.
type SheetFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; profile: SheetStudentProfile }
  | { status: "error"; message: string };

// The same idea for loading the whole roster (the list itself is remembered separately).
type RosterFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success" }
  | { status: "error"; message: string };

// The same idea for loading one student's lessons from the "Lesson Schedule" tab.
type ScheduleFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; lessons: ScheduledLesson[] }
  | { status: "error"; message: string };

/**
 * Storage keys are namespaced under `caseB.` so other Civic AI Club projects
 * deployed under the same `civicaiclub.github.io` origin don't collide on
 * unprefixed keys like `student-notes-<email>`.
 */
const TEACHER_NOTES_STORAGE_PREFIX = "caseB.teacherNotes.v1:";
/** Read-only: keys written by older builds. New writes always use the prefixed key. */
const LEGACY_LOCAL_NOTES_PREFIX = "student-notes-";
const LEGACY_SESSION_NOTES_PREFIX = "musicStudio.caseB.teacherNotes.v1:";

// After the teacher stops typing in the notes box, wait this long (400 milliseconds, under
// half a second) before saving, so we don't save after every single keystroke.
const NOTES_AUTOSAVE_MS = 400;

// Build the name under which one student's notes are saved in the browser. Given the
// student's ID (their email address), it gives back "caseB.teacherNotes.v1:" + that ID.
function studentNotesStorageKey(studentId: string): string {
  return `${TEACHER_NOTES_STORAGE_PREFIX}${studentId}`;
}

// Save one student's teacher notes in this browser's "localStorage" (a small storage area
// the browser keeps on this computer only; it is not shared with other computers or Google).
// If saving isn't possible (storage full, or a private browsing window), quietly give up.
function writeStudentNotesLocal(studentId: string, value: string): void {
  try {
    localStorage.setItem(studentNotesStorageKey(studentId), value);
  } catch {
    /* quota / private mode */
  }
}

// Tidy a profile answer for display. Given some text (or nothing), it gives back the text
// without extra spaces at the ends, or "-" if it is empty.
function displayField(s: string | undefined): string {
  const t = (s ?? "").trim();
  return t.length ? t : "-";
}

// Load a student's saved teacher notes from this browser. It checks the current storage name
// first, then two older names used by earlier versions of the site, so old notes aren't lost.
// If nothing is saved anywhere, it gives back the fallback text (with "-" treated as empty).
function readStoredTeacherNotes(studentId: string, fallback: string): string {
  try {
    const fromLocal = localStorage.getItem(
      studentNotesStorageKey(studentId)
    );
    if (fromLocal !== null) return fromLocal;
    const legacyLocal = localStorage.getItem(
      `${LEGACY_LOCAL_NOTES_PREFIX}${studentId}`
    );
    if (legacyLocal !== null) return legacyLocal;
    const legacySession = sessionStorage.getItem(
      `${LEGACY_SESSION_NOTES_PREFIX}${studentId}`
    );
    if (legacySession !== null) return legacySession;
  } catch {
    /* private mode */
  }
  return fallback === "-" ? "" : fallback;
}


// The profile panel on the right side of the page, for one selected student. It is given the
// student's details, all their past form submissions, how loading their lessons is going, and
// two actions from the page around it: "try loading the lessons again" and "close the panel".
function StudentDetailPanel({
  student,
  formSubmissions,
  scheduleFetchState,
  onScheduleRetry,
  onClose,
}: {
  student: Student;
  formSubmissions: SheetStudentProfile[];
  scheduleFetchState: ScheduleFetchState;
  onScheduleRetry: () => void;
  onClose: () => void;
}) {
  // "State" = information the page remembers and redraws itself when it changes.
  // Here: the text in the teacher notes box (starting from whatever this browser saved), and
  // whether the notes are waiting to be saved ("pending"), "saved", or untouched ("idle").
  const [teacherNotesDraft, setTeacherNotesDraft] = useState(() =>
    readStoredTeacherNotes(student.id, student.teacherNotes)
  );
  const [notesSaveStatus, setNotesSaveStatus] = useState<
    "idle" | "pending" | "saved"
  >("idle");

  // Phase 5 — recaps for this student. Loaded once on student switch
  // and refreshed after a successful save (the modal returns the saved
  // recap directly so we can patch the local list without another GET).
  const [recaps, setRecaps] = useState<LessonRecap[]>([]);
  const [recapsLoaded, setRecapsLoaded] = useState(false);
  const [recapModalTarget, setRecapModalTarget] =
    useState<RecapEditorTarget | null>(null);

  // Called when the teacher clicks Cancel on one of this student's lessons. It asks the Apps
  // Script (through appsScriptCalendar.ts) to delete the Google Calendar event and mark the
  // lesson "Cancelled" on the sheet. "useCallback" keeps this same function between redraws.
  const handleCancelLesson = useCallback(
    async (lesson: ScheduledLesson) => {
      try {
        const result = await cancelCalendarEvent({
          studentEmail: lesson.studentEmail,
          lessonDate: lesson.lessonDate,
          startTime: lesson.startTime,
        });
        // If the sheet row had no calendar event to delete (for example, the page was out of
        // date), nothing was changed, so tell the teacher in a pop-up instead of staying silent.
        if (!result.cancelled) {
          window.alert(
            "Nothing was cancelled: " +
              (result.reason ?? "this lesson has no calendar event on the sheet.") +
              " The schedule will now refresh."
          );
        }
        // Re-fetch this student's schedule so the cancelled lesson
        // drops out of Next / Upcoming and the cancelled status pill
        // appears in Recent (or, if nothing was cancelled, so the
        // page shows what the sheet really says now).
        onScheduleRetry();
      } catch (err) {
        // If cancelling failed, tell the teacher why in a pop-up message.
        const message =
          err instanceof Error ? err.message : "Could not cancel the lesson.";
        window.alert("Cancel failed: " + message);
      }
    },
    [onScheduleRetry]
  );

  // A "ref" is a note the page keeps that does NOT cause a redraw when it changes. The latest
  // notes text is kept here too, so the delayed save and the save-on-leaving below always
  // write the newest text rather than an out-of-date copy.
  const teacherNotesDraftRef = useRef(teacherNotesDraft);
  teacherNotesDraftRef.current = teacherNotesDraft;

  // Remembers the waiting "save in a moment" timer, so it can be stopped or replaced.
  const notesSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // "Effect" = something the page does automatically when it first opens or when something
  // changes. When a different student is shown, load that student's saved notes into the box.
  useEffect(() => {
    const next = readStoredTeacherNotes(student.id, student.teacherNotes);
    setTeacherNotesDraft(next);
    teacherNotesDraftRef.current = next;
    setNotesSaveStatus("idle");
  }, [student.id, student.teacherNotes]);

  // Refetch recaps every time the panel switches student. Failures
  // here are non-fatal — the timeline just renders "Write recap"
  // affordances and the user can still compose; the next save will
  // surface any backend error inline in the modal.
  useEffect(() => {
    // Recaps are filed under the student's email address. An "abort controller" is a cancel
    // switch, used if the teacher switches students before Google answers.
    const email = student.sheetEmail ?? student.id;
    const ac = new AbortController();
    setRecapsLoaded(false);
    setRecaps([]);
    // Ask the Apps Script for this student's recaps from the "Lesson Recaps" tab.
    listRecapsForStudent(email, { signal: ac.signal })
      .then((list) => {
        setRecaps(list);
        setRecapsLoaded(true);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Tab not yet created (first ever recap save) is a clean empty
        // list on the backend; any other error is silently treated as
        // "no recaps loaded" so the timeline still renders the
        // lessons + "Write recap" buttons.
        setRecaps([]);
        setRecapsLoaded(true);
      });
    // Clean-up: cancel the request if the teacher switches students before it finishes.
    return () => ac.abort();
  }, [student.id, student.sheetEmail]);

  // Open the recap pop-up to write a new recap for a past lesson. The lesson is identified by
  // student email + lesson date + start time (the same "key" the sheet uses); the name, lesson
  // focus, and end time are passed along for the pop-up to show.
  const openWriteRecap = useCallback((lesson: ScheduledLesson) => {
    setRecapModalTarget({
      key: {
        studentEmail: lesson.studentEmail,
        lessonDate: lesson.lessonDate,
        startTime: lesson.startTime,
      },
      studentName: lesson.studentName,
      lessonFocus: lesson.lessonFocus,
      endTime: lesson.endTime,
    });
  }, []);

  // Open the same pop-up to edit an existing recap (the pop-up loads the saved recap itself).
  const openEditRecap = useCallback(
    (lesson: ScheduledLesson, _recap: LessonRecap) => {
      // Edit mode reuses the same modal — it'll fetch the existing
      // recap on open and pre-fill. The `_recap` is intentionally
      // unused: the modal is the source of truth for "what was
      // saved" so we avoid stale prop concerns.
      setRecapModalTarget({
        key: {
          studentEmail: lesson.studentEmail,
          lessonDate: lesson.lessonDate,
          startTime: lesson.startTime,
        },
        studentName: lesson.studentName,
        lessonFocus: lesson.lessonFocus,
        endTime: lesson.endTime,
      });
    },
    []
  );

  // After a recap is saved, update this panel's list without asking Google again: replace the
  // old copy of that recap if there was one, or add the new one to the front of the list.
  const handleRecapSaved = useCallback((saved: LessonRecap) => {
    setRecaps((prev) => {
      const idx = prev.findIndex(
        (r) =>
          r.studentEmail === saved.studentEmail &&
          r.lessonDate === saved.lessonDate &&
          r.startTime === saved.startTime
      );
      if (idx === -1) return [saved, ...prev];
      const next = prev.slice();
      next[idx] = saved;
      return next;
    });
  }, []);

  // Stop the waiting "save in a moment" timer, if there is one.
  const clearNotesSaveTimeout = useCallback(() => {
    if (notesSaveTimeoutRef.current !== null) {
      clearTimeout(notesSaveTimeoutRef.current);
      notesSaveTimeoutRef.current = null;
    }
  }, []);

  // Save the notes right away (used when the teacher clicks out of the notes box).
  const flushNotesToLocalStorage = useCallback(() => {
    clearNotesSaveTimeout();
    writeStudentNotesLocal(student.id, teacherNotesDraftRef.current);
    setNotesSaveStatus("saved");
  }, [clearNotesSaveTimeout, student.id]);

  // When this panel closes or switches to another student, save the notes one last time so
  // nothing typed in the final moment is lost. (The part after "return () =>" runs on the
  // way out.)
  useEffect(() => {
    return () => {
      clearNotesSaveTimeout();
      writeStudentNotesLocal(student.id, teacherNotesDraftRef.current);
    };
  }, [clearNotesSaveTimeout, student.id]);

  // Runs on every keystroke in the notes box: update the text, show "Saving…", and restart a
  // short timer. Only once the teacher pauses typing does the timer go off and save the notes.
  const handleTeacherNotesChange = useCallback(
    (value: string) => {
      setTeacherNotesDraft(value);
      teacherNotesDraftRef.current = value;
      setNotesSaveStatus("pending");
      clearNotesSaveTimeout();
      notesSaveTimeoutRef.current = setTimeout(() => {
        notesSaveTimeoutRef.current = null;
        writeStudentNotesLocal(student.id, teacherNotesDraftRef.current);
        setNotesSaveStatus("saved");
      }, NOTES_AUTOSAVE_MS);
    },
    [clearNotesSaveTimeout, student.id]
  );

  // Once this student's lessons have loaded, split them into the next lesson, the rest of the
  // upcoming lessons, and past ("recent") lessons (see src/lib/lessonScheduleUtils.ts).
  // There is nothing to split while the lessons are still loading or failed to load.
  const schedulePartition = useMemo(() => {
    if (scheduleFetchState.status !== "success") return null;
    const email = student.sheetEmail ?? student.id;
    return partitionStudentLessons(scheduleFetchState.lessons, email);
  }, [scheduleFetchState, student.id, student.sheetEmail]);

  // Everything below describes what the profile panel shows. It is written in "JSX", which
  // looks like HTML (the language of web pages) mixed with bits of code in {curly braces}.
  // Blank answers show as "-".
  return (
    <div className="card student-detail-panel">
      {/* Top: the student's initials in a circle, name, instrument and level, and Close. */}
      <div className="student-detail-panel__header">
        <div className="student-detail-panel__identity">
          <span
            className="student-avatar student-avatar--lg"
            aria-hidden="true"
          >
            {studentInitials(student.name, student.contactEmail ?? student.id)}
          </span>
          <div>
            <h2 className="student-detail-panel__title">{student.name}</h2>
            <p className="muted student-detail-panel__meta">
              {displayField(student.instrument)} ·{" "}
              {displayField(student.currentLevel)}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="button-ghost"
          onClick={onClose}
          aria-label="Close profile"
        >
          Close
        </button>
      </div>

      {/* The student's main form answers. */}
      <section className="profile-section" aria-labelledby="profile-core-h">
        <h3 id="profile-core-h" className="profile-section__heading">
          Profile
        </h3>
        <dl className="dl student-detail-dl">
          <div>
            <dt>Name</dt>
            <dd>{displayField(student.name)}</dd>
          </div>
          <div>
            <dt>Instrument</dt>
            <dd>{displayField(student.instrument)}</dd>
          </div>
          <div>
            <dt>Level</dt>
            <dd>{displayField(student.currentLevel)}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{formatLessonDateLong(student.formDate)}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatLessonDateLong(student.lastUpdated)}</dd>
          </div>
        </dl>
      </section>

      {/* Their goals, how long they have played, and their music theory background. */}
      <section className="profile-section" aria-labelledby="profile-goals-h">
        <h3 id="profile-goals-h" className="profile-section__heading">
          Goals / learning
        </h3>
        <dl className="dl student-detail-dl">
          <div>
            <dt>Goal of the private lesson</dt>
            <dd>{displayField(student.goals)}</dd>
          </div>
          <div>
            <dt>How long have you been playing?</dt>
            <dd>{displayField(student.musicExperience)}</dd>
          </div>
          <div>
            <dt>Music theory</dt>
            <dd>{displayField(student.theory)}</dd>
          </div>
        </dl>
      </section>

      {/* The styles of music and specific songs they want to learn. */}
      <section className="profile-section" aria-labelledby="profile-rep-h">
        <h3 id="profile-rep-h" className="profile-section__heading">
          Interests / repertoire
        </h3>
        <dl className="dl student-detail-dl">
          <div>
            <dt>Genre</dt>
            <dd>{displayField(student.genre)}</dd>
          </div>
          <div>
            <dt>Specific song they want to learn</dt>
            <dd>{displayField(student.specificSong)}</dd>
          </div>
        </dl>
      </section>

      {/* Their email, and any updates or questions they wrote on the form. */}
      <section className="profile-section" aria-labelledby="profile-contact-h">
        <h3 id="profile-contact-h" className="profile-section__heading">
          Contact / student notes
        </h3>
        <dl className="dl student-detail-dl">
          <div>
            <dt>Email</dt>
            <dd>{displayField(student.contactEmail ?? student.id)}</dd>
          </div>
          <div>
            <dt>Any updates? Questions?</dt>
            <dd>{displayField(student.studentUpdates)}</dd>
          </div>
        </dl>
      </section>

      {/* A history of every time this student filled in the Google Form. */}
      <FormSubmissionHistorySection submissions={formSubmissions} />

      {/* Scheduling: the times the student said they are free (from the form), and their */}
      {/* actual booked lessons (from the "Lesson Schedule" tab). */}
      <section className="profile-section" aria-labelledby="profile-scheduling-h">
        <h3 id="profile-scheduling-h" className="profile-section__heading">
          Scheduling
        </h3>
        <dl className="dl student-detail-dl">
          <div>
            <dt>Preferred lesson availability</dt>
            <dd>
              {/* No times given shows "-"; otherwise one small badge per time slot. */}
              {student.availabilityBlocks.length === 0 ? (
                "-"
              ) : (
                <ul className="availability-badges" aria-label="Preferred lesson availability">
                  {student.availabilityBlocks.map((block, i) => (
                    <li
                      key={`${block}:${i}`}
                      className="availability-badges__item"
                    >
                      {block}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>

        <div className="profile-booked">
          <h4 className="profile-booked__heading">Booked lessons</h4>
          <p className="muted profile-booked__source">
            From the <strong>Lesson Schedule</strong> sheet (actual lessons,
            not form preferences).
          </p>
          {/* Lessons still loading. */}
          {(scheduleFetchState.status === "loading" ||
            scheduleFetchState.status === "idle") && (
            <p className="muted">Loading schedule…</p>
          )}
          {/* Loading failed: show why, with a button to try again. */}
          {scheduleFetchState.status === "error" && (
            <>
              <p className="empty-state" role="alert">
                {scheduleFetchState.message}
              </p>
              <button
                type="button"
                className="button-ghost"
                onClick={onScheduleRetry}
              >
                Retry schedule
              </button>
            </>
          )}
          {/* Loaded: show the next lesson, the other upcoming lessons (each can be */}
          {/* cancelled), and past lessons. */}
          {scheduleFetchState.status === "success" && schedulePartition && (
            <>
              <p className="profile-booked__sub eyebrow">Next lesson</p>
              {schedulePartition.nextLesson ? (
                <div className="lesson-rows">
                  <LessonRow
                    lesson={schedulePartition.nextLesson}
                    variant="static"
                    onCancel={handleCancelLesson}
                  />
                </div>
              ) : (
                <p className="muted profile-booked__line">None scheduled.</p>
              )}

              <p className="profile-booked__sub eyebrow">Upcoming</p>
              {schedulePartition.upcomingLessons.length === 0 ? (
                <p className="muted profile-booked__line">None scheduled.</p>
              ) : (
                <div className="lesson-rows">
                  {schedulePartition.upcomingLessons.map((lesson, i) => (
                    <LessonRow
                      key={lessonStableKey(lesson, i)}
                      lesson={lesson}
                      variant="static"
                      onCancel={handleCancelLesson}
                    />
                  ))}
                </div>
              )}

              <p className="profile-booked__sub eyebrow">
                Recent
                {schedulePartition.recentLessons.length > 0 && (
                  <span className="muted">
                    {" "}· {schedulePartition.recentLessons.length} total
                  </span>
                )}
                {!recapsLoaded && schedulePartition.recentLessons.length > 0 && (
                  <span className="muted"> · loading recaps…</span>
                )}
              </p>
              {/* Past lessons, each with a button to write or read its recap. Only the first */}
              {/* 5 are shown until the teacher asks to see them all (RecapsTimeline.tsx). */}
              <RecapsTimeline
                lessons={schedulePartition.recentLessons}
                recaps={recaps}
                initialVisible={RECENT_LESSONS_INITIAL_VISIBLE}
                onWriteRecap={openWriteRecap}
                onEditRecap={openEditRecap}
              />
            </>
          )}
        </div>
      </section>

      {/* This student's personal Google Drive folder of materials. */}
      <StudentResourcesSection
        studentEmail={student.sheetEmail ?? student.id}
        studentName={student.name}
      />

      {/* Private teacher notes, saved automatically in this browser only (not in the Sheet). */}
      <section className="profile-section profile-section--notes" aria-labelledby="profile-teacher-h">
        <div className="notes-card">
          <div className="notes-card__header">
            <h3 id="profile-teacher-h" className="profile-section__heading">
              Teacher notes
            </h3>
            <p className="muted profile-teacher-notes-lead">
              Saved in this browser until a server endpoint exists.
            </p>
          </div>
          <textarea
            className="profile-teacher-notes"
            rows={6}
            value={teacherNotesDraft}
            onChange={(e) => handleTeacherNotesChange(e.target.value)}
            onBlur={flushNotesToLocalStorage}
            aria-label="Teacher notes for this student"
            placeholder="Lesson prep, follow-ups, private reminders…"
          />
          {/* A small "Saving…" or "Saved" message once the teacher has typed something. */}
          {(notesSaveStatus === "pending" || notesSaveStatus === "saved") && (
            <p
              className="profile-teacher-notes-status"
              role="status"
              aria-live="polite"
            >
              {notesSaveStatus === "pending" ? "Saving…" : "Saved"}
            </p>
          )}
        </div>
      </section>

      {/* The pop-up for writing or editing a recap; hidden until a lesson is picked. */}
      <RecapEditorModal
        target={recapModalTarget}
        onClose={() => setRecapModalTarget(null)}
        onSaved={handleRecapSaved}
      />
    </div>
  );
}

// The whole Students page. It loads the roster, handles the search and filters, keeps track
// of which student is selected, and shows that student's profile panel.
export function StudentDirectory() {
  // The web address can end with "?student=<email>" so a link (for example from the
  // Dashboard) can open one student's profile. useSearchParams reads and changes that part.
  // Below it: which student is selected, the roster, and every form submission by email.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [submissionsByEmail, setSubmissionsByEmail] = useState<
    Record<string, SheetStudentProfile[]>
  >({});
  // How the roster load is going, plus a counter that goes up when the teacher clicks
  // "Try again" (which makes the roster load again).
  const [rosterState, setRosterState] = useState<RosterFetchState>({
    status: "idle",
  });
  const [rosterRetry, setRosterRetry] = useState(0);

  // How loading the selected student's latest answers and their lessons is going, each with
  // a counter that is raised to try again.
  const [sheetFetchState, setSheetFetchState] = useState<SheetFetchState>({
    status: "idle",
  });
  const [sheetRetryToken, setSheetRetryToken] = useState(0);
  const [scheduleFetchState, setScheduleFetchState] =
    useState<ScheduleFetchState>({ status: "idle" });
  const [scheduleRetryToken, setScheduleRetryToken] = useState(0);

  // What is typed in the search box and chosen in the Instrument and Level dropdowns.
  const [query, setQuery] = useState("");
  const [instrument, setInstrument] = useState("");
  const [level, setLevel] = useState("");

  // Roster: once when the page opens (or when you click "Try again" after an error).
  useEffect(() => {
    const ac = new AbortController();
    setRosterState({ status: "loading" });
    // Ask the Apps Script for the full roster: the newest answers for each student, plus
    // every past form submission grouped by email.
    getAllStudents({ signal: ac.signal })
      .then(({ students: profiles, submissionsByEmail: byEmail }) => {
        // Turn rows into students (skipping rows with no email) and sort by name, A to Z.
        const list: Student[] = [];
        for (const p of profiles) {
          const s = sheetProfileToStudent(p);
          if (s) list.push(s);
        }
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        setStudents(list);
        setSubmissionsByEmail(byEmail);
        setRosterState({ status: "success" });
      })
      // On failure (not a request we cancelled on purpose), clear the lists and remember
      // the error message.
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof Error ? err.message : "Could not load roster.";
        setStudents([]);
        setSubmissionsByEmail({});
        setRosterState({ status: "error", message });
      });
    // Clean-up: cancel the request if the teacher leaves the page before it finishes.
    return () => ac.abort();
  }, [rosterRetry]);

  // The choices for the Instrument dropdown: every different instrument on the roster,
  // skipping blanks, in A to Z order.
  const instruments = useMemo(() => {
    return [...new Set(students.map((s) => s.instrument))]
      .filter((v) => v && v !== "-")
      .sort();
  }, [students]);

  // The same for the Level dropdown.
  const levels = useMemo(() => {
    return [...new Set(students.map((s) => s.currentLevel))]
      .filter((v) => v && v !== "-")
      .sort();
  }, [students]);

  /**
   * Match the URL's `?student=` value to a roster student by lowercased
   * email. Email casing can drift between Form Responses 1 and Lesson
   * Schedule (the dashboard's "Upcoming lessons" link uses whatever the
   * Lesson Schedule sheet has), so a case-sensitive lookup would silently
   * leave the panel empty.
   */
  const syncSelectionFromUrl = useCallback(() => {
    const fromUrl = searchParams.get("student");
    if (!fromUrl) {
      setSelectedId(null);
      return;
    }
    const target = fromUrl.trim().toLowerCase();
    const match = students.find((s) => s.id.toLowerCase() === target);
    if (match) setSelectedId(match.id);
    else setSelectedId(null);
  }, [searchParams, students]);

  // Whenever the web address or the roster changes, select the student named in the address.
  useEffect(() => {
    syncSelectionFromUrl();
  }, [syncSelectionFromUrl]);

  // Select a student (or nobody) and write the choice into the web address, so the page can
  // be refreshed or bookmarked without losing it. "replace" keeps the browser's Back button
  // from stepping through every single click.
  const setSelection = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id) {
        setSearchParams({ student: id }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    },
    [setSearchParams]
  );

  // The students to show: those whose name contains the search text and who match the chosen
  // instrument and level (a blank choice means "All").
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (instrument && s.instrument !== instrument) return false;
      if (level && s.currentLevel !== level) return false;
      return true;
    });
  }, [query, instrument, level, students]);

  // The full roster entry for the selected student, if anyone is selected.
  const selectedStudent =
    selectedId != null
      ? students.find((s) => s.id === selectedId)
      : undefined;

  // Detail: whenever a student is selected, refetch their row by email (latest sheet data).
  useEffect(() => {
    // Nobody selected (or no email): nothing to load.
    if (!selectedStudent?.sheetEmail) {
      setSheetFetchState({ status: "idle" });
      return;
    }

    const ac = new AbortController();
    const email = selectedStudent.sheetEmail;
    setSheetFetchState({ status: "loading" });

    // Ask the Apps Script for the newest saved answers for this student's email.
    getStudentByEmail(email, { signal: ac.signal })
      .then((profile) => {
        setSheetFetchState({ status: "success", profile });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof Error ? err.message : "Could not load student.";
        setSheetFetchState({ status: "error", message });
      });

    return () => ac.abort();
  }, [selectedStudent?.sheetEmail, sheetRetryToken]);

  // Also load the selected student's lessons from the "Lesson Schedule" tab. This runs again
  // when the student changes, when their profile is retried, or when their lessons are
  // retried (for example after a lesson is cancelled).
  useEffect(() => {
    if (!selectedStudent?.sheetEmail) {
      setScheduleFetchState({ status: "idle" });
      return;
    }

    const ac = new AbortController();
    const email = selectedStudent.sheetEmail;
    setScheduleFetchState({ status: "loading" });

    getStudentSchedule(email, { signal: ac.signal })
      .then((lessons) => {
        setScheduleFetchState({ status: "success", lessons });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof Error ? err.message : "Could not load schedule.";
        setScheduleFetchState({ status: "error", message });
      });

    return () => ac.abort();
  }, [selectedStudent?.sheetEmail, sheetRetryToken, scheduleRetryToken]);

  // Turn the freshly loaded sheet row into the details the profile panel shows. Until it
  // has loaded, there is nothing to show yet.
  const detailStudent = useMemo(() => {
    if (sheetFetchState.status !== "success") return undefined;
    return sheetProfileToStudent(sheetFetchState.profile) ?? undefined;
  }, [sheetFetchState]);

  // All of the selected student's past form submissions (from the roster load), for the
  // form history section of the profile.
  const profileFormSubmissions = useMemo(() => {
    const email = selectedStudent?.sheetEmail?.trim().toLowerCase();
    if (!email) return [];
    return submissionsByEmail[email] ?? [];
  }, [selectedStudent?.sheetEmail, submissionsByEmail]);

  // If the search or filters hide the selected student, close their profile, so the panel
  // never shows someone who isn't in the visible list.
  useEffect(() => {
    if (
      selectedId != null &&
      rosterState.status === "success" &&
      !filtered.some((s) => s.id === selectedId)
    ) {
      setSelection(null);
    }
  }, [filtered, rosterState.status, selectedId, setSelection]);

  // Clicking a student's card opens their profile; clicking the same card again closes it.
  const handleCardClick = (id: string) => {
    if (selectedId === id) setSelection(null);
    else setSelection(id);
  };

  // While the roster is still loading, show only a "please wait" page.
  if (rosterState.status === "loading" || rosterState.status === "idle") {
    return (
      <div className="page page--wide">
        <header className="page-header">
          <h1>Students</h1>
          <p className="page-header__lede">
            Loading your roster from Google Sheets…
          </p>
        </header>
        <div className="card student-detail-empty">
          <p className="muted">Please wait.</p>
        </div>
      </div>
    );
  }

  // If the roster failed to load, show the error and a "Try again" button.
  if (rosterState.status === "error") {
    return (
      <div className="page page--wide">
        <header className="page-header">
          <h1>Students</h1>
          <p className="page-header__lede">
            Could not load the student list from your web app.
          </p>
        </header>
        <div className="card student-detail-panel" role="alert">
          <p className="empty-state">{rosterState.message}</p>
          <p className="muted empty-state">
            Your Apps Script must handle <code>?action=list</code> and return a
            JSON array of rows (see the comment on{" "}
            <code>APPS_SCRIPT_BASE_URL</code> in{" "}
            <code>src/api/appsScriptStudent.ts</code>).
          </p>
          <button
            type="button"
            className="button-ghost"
            onClick={() => setRosterRetry((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // The normal page, once the roster has loaded (JSX again: HTML-like markup with code).
  return (
    <div className="page page--wide">
      {/* Page title and instructions. */}
      <header className="page-header">
        <h1>Students</h1>
        <p className="page-header__lede">
          Click any student to open their full profile inline.
        </p>
      </header>

      {/* Search box and Instrument / Level dropdowns, with a count of students shown. */}
      <div className="filters card">
        <div className="filters__row">
          <div className="field grow">
            <label className="label" htmlFor="dir-search">
              Search
            </label>
            <input
              id="dir-search"
              type="search"
              className="input"
              placeholder="Name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="dir-instrument">
              Instrument
            </label>
            <select
              id="dir-instrument"
              className="select"
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
            >
              <option value="">All</option>
              {instruments.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="dir-level">
              Level
            </label>
            <select
              id="dir-level"
              className="select"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="">All</option>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="muted filters__count">
          Showing {filtered.length} of {students.length}
        </p>
      </div>

      {/* Two columns: the student cards on the left and the profile panel on the right. */}
      <div className="students-split">
        <div>
          {/* One clickable card per student: initials, name, instrument, level, last update. */}
          <div className="student-grid student-grid--compact">
            {filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                className={
                  selectedId === s.id
                    ? "student-card student-card--selected"
                    : "student-card"
                }
                onClick={() => handleCardClick(s.id)}
                aria-expanded={selectedId === s.id}
              >
                <span
                  className="student-avatar student-card__avatar"
                  aria-hidden="true"
                >
                  {studentInitials(s.name, s.contactEmail ?? s.id)}
                </span>
                <span className="student-card__body">
                  <span className="student-card__name">{s.name}</span>
                  <span className="student-card__meta">
                    <span>{s.instrument}</span>
                    <span className="dot" aria-hidden />
                    <span>{s.currentLevel}</span>
                  </span>
                  <span className="student-card__updated muted">
                    Updated {formatLessonDateShort(s.lastUpdated)}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* Nobody to show: explain whether the roster is empty or the filters are too strict. */}
          {filtered.length === 0 && (
            <p className="empty-state">
              {students.length === 0
                ? "No students returned. Check that ?action=list in your Apps Script returns rows with an Email Address column."
                : "No students match these filters. Clear search or set filters to “All.”"}
            </p>
          )}
        </div>

        <div className="students-detail-column">
          {/* The right column shows one of four things: an error if this student's answers */}
          {/* failed to load; their profile panel once loaded; a loading message; or, if */}
          {/* nobody is selected, a hint to pick a student. The "key" makes React start a */}
          {/* fresh panel (with fresh notes and recaps) for each student. */}
          {selectedStudent ? (
            sheetFetchState.status === "error" ? (
              <div className="card student-detail-panel">
                <div className="student-detail-panel__header">
                  <div>
                    <h2 className="student-detail-panel__title">
                      Could not load sheet data
                    </h2>
                    <p className="muted student-detail-panel__meta">
                      {selectedStudent.name}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button-ghost"
                    onClick={() => setSelection(null)}
                    aria-label="Close profile"
                  >
                    Close
                  </button>
                </div>
                <p className="empty-state" role="alert">
                  {sheetFetchState.message}
                </p>
                <button
                  type="button"
                  className="button-ghost"
                  onClick={() => setSheetRetryToken((n) => n + 1)}
                >
                  Try again
                </button>
              </div>
            ) : detailStudent ? (
              <StudentDetailPanel
                key={detailStudent.id}
                student={detailStudent}
                formSubmissions={profileFormSubmissions}
                scheduleFetchState={scheduleFetchState}
                onScheduleRetry={() => setScheduleRetryToken((n) => n + 1)}
                onClose={() => setSelection(null)}
              />
            ) : (
              <div className="card student-detail-empty">
                <h2 className="card__title">Student profile</h2>
                <p className="muted">Loading profile from Google Sheets…</p>
              </div>
            )
          ) : (
            <div className="card student-detail-empty">
              <h2 className="card__title">Student profile</h2>
              <p className="muted">
                Select a student from the list to see goals, experience,
                interests, and teacher notes. Click again to collapse.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
