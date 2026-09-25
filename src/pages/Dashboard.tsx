// Dashboard.tsx: the home page the teacher sees first when opening the studio website.
// The site is built with React (a toolkit for building web pages out of reusable pieces
// called "components"). This file is one component: a function that describes what the page
// shows. It gathers information from the studio's Google Sheet through the Google Apps Script
// web app (a small program Google runs for us, in apps-script/Code.gs):
//   1. The student roster (the "Form Responses 1" tab): a total count, a quick search, and a
//      list of what changed in students' form answers since the teacher's last visit.
//   2. The lesson schedule (the "Lesson Schedule" tab): lessons still waiting to be put on
//      Google Calendar ("pending"), and upcoming lessons.
//   3. Shared Google Drive folders, plus handy links to the Sheet and the sign-up Google Form.
// The code that actually talks to Google lives in src/api/ (appsScriptStudent.ts,
// appsScriptSchedule.ts, appsScriptCalendar.ts). The boxed sections come from src/components/.
// The "import" lines below borrow those pieces, plus React's built-in helpers, from other files.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getScheduleList } from "../api/appsScriptSchedule";
import { getAllStudents } from "../api/appsScriptStudent";
import { sheetProfileToStudent } from "../api/studentFromSheet";
import {
  cancelCalendarEvent,
  type LessonRowKey,
} from "../api/appsScriptCalendar";
import {
  lessonStableKey,
  upcomingLessonsSorted,
} from "../lib/lessonScheduleUtils";
import {
  computeProfileUpdatesSinceLastVisit,
  loadProfileSnapshots,
  saveProfileSnapshots,
  type DashboardProfileUpdate,
} from "../lib/studentProfileSnapshots";
import {
  EXTERNAL_LINKS,
  EXTERNAL_LINK_ORDER,
} from "../lib/externalLinks";
import { LessonRow } from "../components/LessonRow";
import { PendingLessonsSection } from "../components/PendingLessonsSection";
import { EventPreviewModal } from "../components/EventPreviewModal";
import { ClassResourcesSection } from "../components/ClassResourcesSection";
import { StudentFoldersSyncCard } from "../components/StudentFoldersSyncCard";
import type { ScheduledLesson, Student } from "../types";

// Shorten a long piece of text so it fits neatly on the page. Given some text and a maximum
// length (160 characters unless told otherwise), it gives back the text without extra spaces
// at the ends, cut short with "…" if it was too long.
function clipText(s: string, max = 160): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

// The Dashboard component itself. React runs this function to draw the page, and runs it
// again (a "redraw") whenever any of the page's remembered information changes.
export function Dashboard() {
  // "State" = information the page remembers and redraws itself when it changes. Each
  // useState line creates one piece of memory plus a "set" function to change it.
  // First: what the teacher typed in the search box, the list of students, and an error
  // message if the roster could not be loaded.
  const [query, setQuery] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The "Recent student updates" summary: whether this is the first visit from this browser
  // (so there is nothing to compare against yet), and the list of changes found.
  const [recentUpdates, setRecentUpdates] = useState<{
    isBaselineVisit: boolean;
    updates: DashboardProfileUpdate[];
  } | null>(null);
  // Where the roster load stands: "idle" (still waiting), "ok", or "error".
  const [rosterLoadStatus, setRosterLoadStatus] = useState<
    "idle" | "ok" | "error"
  >("idle");

  // The same kind of memory for the lesson schedule: its loading status, any error message,
  // and the list of lessons that came back from the "Lesson Schedule" tab.
  const [scheduleLoadStatus, setScheduleLoadStatus] = useState<
    "idle" | "loading" | "ok" | "error"
  >("loading");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleLessons, setScheduleLessons] = useState<ScheduledLesson[]>([]);

  /**
   * Phase 2: lesson currently open in the preview modal. Identified by
   * composite key so the modal can re-fetch a fresh preview on each
   * open without needing a Lesson ID column on the sheet.
   */
  const [pendingPreviewKey, setPendingPreviewKey] = useState<
    LessonRowKey | null
  >(null);

  /**
   * Bumped after a successful event creation to trigger the schedule
   * effect to re-run. Cheaper than threading an explicit refetch
   * function through the modal.
   */
  const [scheduleRefreshToken, setScheduleRefreshToken] = useState(0);

  // From all lessons, keep only the upcoming ones (scheduled for today or later), soonest
  // first, and at most 20 of them. "useMemo" means this list is only worked out again when
  // the schedule changes, not on every redraw.
  const upcomingForDashboard = useMemo(() => {
    return upcomingLessonsSorted(scheduleLessons).slice(0, 20);
  }, [scheduleLessons]);

  // "Effect" = something the page does automatically when it first opens or when something
  // changes. This one loads the lesson schedule when the page opens, and loads it again
  // whenever scheduleRefreshToken goes up (after a lesson is booked or cancelled).
  useEffect(() => {
    // An "abort controller" is a cancel switch for the request: if the teacher leaves the
    // page before Google answers, the request is cancelled so its answer is simply dropped.
    const ac = new AbortController();
    setScheduleLoadStatus("loading");
    setScheduleError(null);
    // Ask the Apps Script for every lesson on the "Lesson Schedule" tab. When the answer
    // arrives, remember the lessons and mark the schedule as loaded.
    getScheduleList({ signal: ac.signal })
      .then((list) => {
        setScheduleLessons(list);
        setScheduleLoadStatus("ok");
      })
      // If something went wrong, empty the list and remember a message to show the teacher.
      // A request we cancelled on purpose (see above) is not a real error, so it is ignored.
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setScheduleLessons([]);
        setScheduleError(
          err instanceof Error ? err.message : "Could not load schedule."
        );
        setScheduleLoadStatus("error");
      });
    // This "clean-up" step runs when the teacher leaves the page (or just before the effect
    // runs again) and cancels any request still waiting for an answer.
    return () => ac.abort();
  }, [scheduleRefreshToken]);

  // Called when the teacher clicks "Preview & schedule" on a pending lesson. It remembers
  // which lesson it was (student email + lesson date + start time), and that makes the
  // preview pop-up at the bottom of the page open. "useCallback" just keeps this same
  // function from one redraw to the next.
  const openPreviewFor = useCallback((lesson: ScheduledLesson) => {
    setPendingPreviewKey({
      studentEmail: lesson.studentEmail,
      lessonDate: lesson.lessonDate,
      startTime: lesson.startTime,
    });
  }, []);

  // Called by the preview pop-up after a Google Calendar event was created. Raising the
  // counter makes the schedule effect above load the schedule again, so the lesson moves
  // from "pending" to "upcoming".
  const handleEventCreated = useCallback(() => {
    setScheduleRefreshToken((n) => n + 1);
  }, []);

  // Called when the teacher clicks Cancel on an upcoming lesson. It asks the Apps Script
  // (through appsScriptCalendar.ts) to delete the lesson's Google Calendar event and mark
  // the lesson "Cancelled" on the sheet.
  const handleCancelLesson = useCallback(async (lesson: ScheduledLesson) => {
    try {
      await cancelCalendarEvent({
        studentEmail: lesson.studentEmail,
        lessonDate: lesson.lessonDate,
        startTime: lesson.startTime,
      });
      // Re-fetch the schedule so the row's status flips to "Cancelled" and
      // it drops out of the Upcoming list.
      setScheduleRefreshToken((n) => n + 1);
    } catch (err) {
      // If cancelling failed, show a pop-up message with the reason.
      const message =
        err instanceof Error ? err.message : "Could not cancel the lesson.";
      window.alert("Cancel failed: " + message);
    }
  }, []);

  // Same roster as the Students page (Apps Script ?action=list) for count + quick search.
  // Snapshots are saved here only so “what changed” means since your last Dashboard visit.
  // This effect runs only once, when the page first opens (its list of "things to watch",
  // the [] at the end, is empty).
  useEffect(() => {
    const ac = new AbortController();
    // Ask the Apps Script for the whole roster: the newest form answers for each student.
    getAllStudents({ signal: ac.signal })
      .then(({ students: profiles }) => {
        // Compare today's roster with the copy saved in this browser on the last visit. That
        // copy lives in "localStorage", a small storage area the browser keeps on this
        // computer only. The comparison finds new students and changed answers; keep 12 at most.
        const previous = loadProfileSnapshots();
        const { isBaselineVisit, updates } =
          computeProfileUpdatesSinceLastVisit(previous, profiles);

        setRecentUpdates({
          isBaselineVisit,
          updates: updates.slice(0, 12),
        });

        // Save today's roster as the new "last visit" copy for next time.
        saveProfileSnapshots(profiles);

        // Turn each sheet row into the student format the page uses (rows with no email are
        // skipped), then sort by name from A to Z, ignoring capital letters.
        const list: Student[] = [];
        for (const p of profiles) {
          const s = sheetProfileToStudent(p);
          if (s) list.push(s);
        }
        list.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
        // Remember the students and mark the roster as loaded, clearing any old error.
        setStudents(list);
        setLoadError(null);
        setRosterLoadStatus("ok");
      })
      // On failure (but not a request we cancelled on purpose), clear everything and
      // remember the error message.
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStudents([]);
        setRecentUpdates(null);
        setLoadError(
          err instanceof Error ? err.message : "Could not load roster."
        );
        setRosterLoadStatus("error");
      });
    // Clean-up: cancel the request if the teacher leaves before it finishes.
    return () => ac.abort();
  }, []);

  // The quick-search results: students whose name or email contains what the teacher typed
  // (ignoring capital letters), up to 8 of them. An empty search box shows no results list.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return students
      .filter((s) => {
        if (s.name.toLowerCase().includes(q)) return true;
        const email = (s.contactEmail ?? s.id).toLowerCase();
        return email.includes(q);
      })
      .slice(0, 8);
  }, [query, students]);

  // Everything below describes what appears on the screen. It is written in "JSX", which
  // looks like HTML (the language of web pages) mixed with bits of code in {curly braces}.
  return (
    <div className="page">
      {/* Page title and a one-line description. */}
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-header__lede">
          Roster, schedule, and shared materials, all powered by your
          Google Sheet.
        </p>
      </header>

      {/* A grid of "cards" (boxed sections) that make up the dashboard. */}
      <div className="grid-dashboard">
        {/* Card: the total number of students, or "?" plus the error if loading failed. */}
        <section className="card card--stat dashboard-hero">
          <span className="dashboard-hero__eyebrow">Total students</span>
          <p className="dashboard-hero__value">
            {loadError ? "?" : students.length}
          </p>
          <p className="muted dashboard-hero__caption">
            {loadError ? loadError : "Loaded live from your Google Sheet"}
          </p>
        </section>

        {/* Card: a search box to jump straight to one student's profile. */}
        <section className="card">
          <h2 className="card__title">Find a student</h2>
          <label className="label" htmlFor="dash-search">
            Search by name or email
          </label>
          <input
            id="dash-search"
            type="search"
            className="input"
            placeholder="Type a name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {/* If the roster failed to load, point to where the problem might be. */}
          {loadError && (
            <p className="muted empty-state">
              Open the Students page for details, or add <code>?action=list</code>{" "}
              to your Apps Script (see <code>src/api/appsScriptStudent.ts</code>).
            </p>
          )}
          {/* While there is text in the search box, list the matching students. */}
          {/* Each result links to the Students page with that student's profile open. */}
          {query.trim() && !loadError && (
            <ul className="search-results">
              {searchResults.length === 0 && (
                <li className="muted">No matches</li>
              )}
              {searchResults.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/students?student=${encodeURIComponent(s.id)}`}
                    className="link-block"
                  >
                    <span className="strong">{s.name}</span>
                    <span className="muted">
                      {s.instrument} · {s.currentLevel}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Card: "Recent student updates", what changed since this browser's last visit. */}
        <section className="card span-2">
          <h2 className="card__title">Recent student updates</h2>
          <p className="muted profile-updates-intro">
            Changes since your last visit, saved per browser.
          </p>
          {/* Still loading: show a waiting message. */}
          {rosterLoadStatus === "idle" && !loadError && (
            <p className="muted">Loading roster and update summary…</p>
          )}
          {loadError && (
            <p className="placeholder-text">Load the roster to see updates.</p>
          )}
          {/* First visit from this browser: nothing to compare yet, so explain that. */}
          {rosterLoadStatus === "ok" &&
            recentUpdates?.isBaselineVisit && (
            <p className="placeholder-text">
              Baseline saved for each student. Open the dashboard again after your
              students submit new form responses (or you edit the Sheet) to see
              what changed.
            </p>
          )}
          {/* Compared with last time, but nothing changed. */}
          {rosterLoadStatus === "ok" &&
            recentUpdates &&
            !recentUpdates.isBaselineVisit &&
            recentUpdates.updates.length === 0 && (
              <p className="placeholder-text">
                No profile fields changed since your last visit.
              </p>
            )}
          {/* Compared and found changes: list each student with a link to their profile. */}
          {rosterLoadStatus === "ok" &&
            recentUpdates &&
            !recentUpdates.isBaselineVisit &&
            recentUpdates.updates.length > 0 && (
              <ul className="profile-updates-list">
                {recentUpdates.updates.map((item) => (
                  <li key={item.profile.email} className="profile-updates-list__item">
                    {/* A brand-new student gets a "New on roster" line. A student already */}
                    {/* seen before gets each changed answer shown as "before → after". */}
                    {item.kind === "new_on_roster" ? (
                      <>
                        <p className="profile-updates-list__title">
                          <Link
                            to={`/students?student=${encodeURIComponent(item.profile.email)}`}
                            className="link-block"
                          >
                            <span className="strong">New on roster</span>
                            <span className="muted">
                              {" "}
                              · {item.profile.name || item.profile.email}
                            </span>
                          </Link>
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="profile-updates-list__title">
                          <Link
                            to={`/students?student=${encodeURIComponent(item.profile.email)}`}
                            className="link-block"
                          >
                            <span className="strong">
                              {item.profile.name || item.profile.email}
                            </span>
                            <span className="muted"> · profile changes</span>
                          </Link>
                        </p>
                        <ul className="profile-updates-list__changes">
                          {item.changes.map((c) => (
                            <li key={c.label}>
                              <span className="profile-updates-list__field">
                                {c.label}
                              </span>
                              <span className="muted profile-updates-list__delta">
                                <span className="profile-updates-list__before">
                                  {clipText(c.before)}
                                </span>
                                {" → "}
                                <span className="profile-updates-list__after">
                                  {clipText(c.after)}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </section>

        {/* Card: lessons typed into the "Lesson Schedule" tab but not yet on the calendar. */}
        {/* Clicking "Preview & schedule" there opens the preview pop-up (see bottom). */}
        <PendingLessonsSection
          lessons={scheduleLessons}
          onPreview={openPreviewFor}
        />

        {/* Card: upcoming lessons, soonest first, each with a Cancel option. */}
        <section className="card span-2">
          <h2 className="card__title">Upcoming lessons</h2>
          <p className="muted profile-updates-intro">
            Scheduled or rescheduled lessons, today onward.
          </p>
          {scheduleLoadStatus === "loading" && (
            <p className="muted">Loading schedule…</p>
          )}
          {/* Loading failed: show the error and a hint about what the Apps Script needs. */}
          {scheduleLoadStatus === "error" && scheduleError && (
            <div role="alert">
              <p className="empty-state">{scheduleError}</p>
              <p className="muted empty-state">
                Add <code>?action=schedule-list</code> to your Apps Script and a
                tab named <code>Lesson Schedule</code> (see{" "}
                <code>src/api/appsScriptSchedule.ts</code>).
              </p>
            </div>
          )}
          {scheduleLoadStatus === "ok" && upcomingForDashboard.length === 0 && (
            <p className="placeholder-text">No upcoming scheduled lessons.</p>
          )}
          {/* Loaded: one row per lesson (LessonRow.tsx). */}
          {scheduleLoadStatus === "ok" && upcomingForDashboard.length > 0 && (
            <div className="lesson-rows">
              {upcomingForDashboard.map((lesson, i) => (
                <LessonRow
                  key={lessonStableKey(lesson, i)}
                  lesson={lesson}
                  variant="link"
                  onCancel={handleCancelLesson}
                />
              ))}
            </div>
          )}
        </section>

        {/* Card: the shared "Class Resources" Google Drive folder for all students. */}
        <ClassResourcesSection />

        {/* Card: a button to create every student's personal Drive folder in one go. */}
        <StudentFoldersSyncCard />

        {/* Card: quick links to the Google Sheet and Google Form, opened in a new tab. */}
        <section
          className="card span-2 quick-links-card"
          aria-labelledby="quick-links-h"
        >
          <h2 id="quick-links-h" className="card__title">
            Quick links
          </h2>
          <p className="muted profile-updates-intro">
            Open the source spreadsheet or Google Form in a new tab.
          </p>
          <ul className="quick-links">
            {EXTERNAL_LINK_ORDER.map((key) => {
              // Look up the label, web address, and description for this link.
              const link = EXTERNAL_LINKS[key];
              return (
                <li key={key}>
                  <a
                    className="quick-links__item"
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="quick-links__title">
                      <span className="strong">{link.label}</span>
                      <span
                        className="quick-links__icon"
                        aria-hidden="true"
                      >
                        ↗
                      </span>
                    </span>
                    <span className="muted quick-links__desc">
                      {link.description}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* The "Preview & schedule" pop-up. It stays hidden until a pending lesson is picked. */}
      {/* Closing it clears the choice; a successful booking reloads the schedule. */}
      <EventPreviewModal
        lessonKey={pendingPreviewKey}
        onClose={() => setPendingPreviewKey(null)}
        onCreated={handleEventCreated}
      />
    </div>
  );
}
