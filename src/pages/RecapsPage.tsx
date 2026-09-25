// RecapsPage.tsx: the "Recaps" page, which shows every lesson recap the teacher has written,
// grouped by student. A recap is the teacher's short note after a lesson (a greeting, what
// we did today, homework, and plans for next class).
// Recaps are written from a student's profile on the Students page (StudentDirectory.tsx and
// RecapEditorModal.tsx); this page only reads and displays them.
// The recaps come from the "Lesson Recaps" tab of the studio's Google Sheet, fetched through
// the Google Apps Script web app (apps-script/Code.gs) by listRecaps() in
// src/api/appsScriptRecaps.ts. Each recap is drawn by src/components/LessonRecapBlock.tsx.
// The site is built with React (a toolkit for building web pages out of reusable pieces
// called "components"); this file is the component for the whole Recaps page.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listRecaps } from "../api/appsScriptRecaps";
import { LessonRecapBlock } from "../components/LessonRecapBlock";
import type { LessonRecap } from "../types";

// The three situations the page can be in: still loading, ready (with the list of recaps),
// or failed (with an error message to show).
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; recaps: LessonRecap[] }
  | { kind: "error"; message: string };

/**
 * Standalone "Recaps" tab. Renders every recap in the system, grouped
 * by student, sorted newest first. Read-only — composing happens
 * inside the student profile panel where each recap is naturally
 * tied to one specific past lesson row.
 *
 * Empty state renders a friendly explanation pointing the teacher
 * back to the Students page so they know how to author the first
 * recap.
 */
export function RecapsPage() {
  // "State" = information the page remembers and redraws itself when it changes.
  // Here: where loading stands (it starts at "loading"), and the text typed in the filter box.
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [studentFilter, setStudentFilter] = useState<string>("");

  // "Effect" = something the page does automatically when it first opens or when something
  // changes. This one runs once, when the page opens, and asks the Apps Script for every recap.
  useEffect(() => {
    // An "abort controller" is a cancel switch for the request, used if the teacher leaves
    // the page before Google answers.
    const ac = new AbortController();
    setState({ kind: "loading" });
    listRecaps({ signal: ac.signal })
      .then((recaps) => {
        setState({ kind: "ready", recaps });
      })
      // On failure (other than a request we cancelled on purpose), remember the message.
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Could not load recaps.",
        });
      });
    // Clean-up when the teacher leaves the page: cancel the request if it is still waiting.
    return () => ac.abort();
  }, []);

  // Build the groups shown on screen: one group per student, each holding that student's
  // recaps. "useMemo" means this is only worked out again when the recaps or filter change.
  const groups = useMemo(() => {
    if (state.kind !== "ready") return [];
    // If the teacher typed in the filter box, keep only recaps whose student name or email
    // contains that text (ignoring capital letters).
    const filter = studentFilter.trim().toLowerCase();
    const filtered = filter
      ? state.recaps.filter((r) => {
          const name = r.studentName.toLowerCase();
          const email = r.studentEmail.toLowerCase();
          return name.includes(filter) || email.includes(filter);
        })
      : state.recaps;

    // Group by email; preserve newest-first order within each group
    // since the backend already sorted the array that way.
    const map = new Map<
      string,
      { name: string; email: string; recaps: LessonRecap[] }
    >();
    // Go through each recap and put it in its student's group (matched by email, ignoring
    // capital letters), starting a new group the first time a student appears.
    for (const r of filtered) {
      const key = r.studentEmail.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.recaps.push(r);
      } else {
        map.set(key, {
          name: r.studentName,
          email: r.studentEmail,
          recaps: [r],
        });
      }
    }
    // Sort groups by most-recent recap date desc.
    // Lesson dates are written like "2026-09-25", so sorting them as text also puts them in
    // date order. Each group's first recap is its newest.
    return Array.from(map.values()).sort((a, b) => {
      const ad = a.recaps[0]?.lessonDate ?? "";
      const bd = b.recaps[0]?.lessonDate ?? "";
      return bd.localeCompare(ad);
    });
  }, [state, studentFilter]);

  // Everything below describes what appears on the screen. It is written in "JSX", which
  // looks like HTML (the language of web pages) mixed with bits of code in {curly braces}.
  return (
    <div className="page recaps-page">
      {/* Page title and description. */}
      <header className="page-header">
        <h1>Recaps</h1>
        <p className="page-header__lede">
          Every recap you've saved, grouped by student. Write new ones from
          a student's profile.
        </p>
      </header>

      {/* While loading, show a waiting message. */}
      {state.kind === "loading" && (
        <p className="muted">Loading recaps…</p>
      )}

      {/* If loading failed, show the error. */}
      {state.kind === "error" && (
        <p className="status-error" role="alert">
          {state.message}
        </p>
      )}

      {/* Loaded, but no recaps saved yet: explain how to write the first one. */}
      {state.kind === "ready" && state.recaps.length === 0 && (
        <section className="card">
          <h2 className="card__title">No recaps yet</h2>
          <p className="muted">
            When you save your first recap from a student's profile, the{" "}
            <strong>Lesson Recaps</strong> tab will be auto-created in
            your Google Sheet and the recap will appear here.
          </p>
          <p className="muted">
            <Link to="/students" className="link">
              Go to Students →
            </Link>
          </p>
        </section>
      )}

      {/* Loaded with recaps: show a filter box, then one card per student. */}
      {state.kind === "ready" && state.recaps.length > 0 && (
        <>
          {/* The filter box, with a count of students (and of all recaps when not filtering). */}
          <section className="card recaps-page__filter">
            <label className="label" htmlFor="recaps-filter">
              Filter by student
            </label>
            <input
              id="recaps-filter"
              type="search"
              className="input"
              placeholder="Type a name or email…"
              value={studentFilter}
              onChange={(e) => setStudentFilter(e.target.value)}
              autoComplete="off"
            />
            <p className="muted recaps-page__filter-meta">
              {studentFilter
                ? `${groups.length} student${groups.length === 1 ? "" : "s"} matching`
                : `${groups.length} student${groups.length === 1 ? "" : "s"} · ${state.recaps.length} recap${state.recaps.length === 1 ? "" : "s"} total`}
            </p>
          </section>

          {/* The filter text matched nobody. */}
          {groups.length === 0 && (
            <p className="muted recaps-page__empty">No matches.</p>
          )}

          {/* One card per student: name, email, how many recaps, a link to their profile */}
          {/* on the Students page, and each recap, newest first. */}
          <div className="recaps-page__groups">
            {groups.map((group) => (
              <section
                key={group.email}
                className="card recaps-page__group"
                aria-labelledby={`recaps-group-${group.email}`}
              >
                <header className="recaps-page__group-header">
                  <h2
                    id={`recaps-group-${group.email}`}
                    className="card__title"
                  >
                    {group.name || group.email}
                  </h2>
                  <p className="muted">
                    {group.email} · {group.recaps.length} recap
                    {group.recaps.length === 1 ? "" : "s"} ·{" "}
                    <Link
                      to={`/students?student=${encodeURIComponent(group.email)}`}
                      className="link"
                    >
                      Open profile →
                    </Link>
                  </p>
                </header>
                <ul className="recaps-page__recaps">
                  {/* Each recap is identified by student email + lesson date + start time. */}
                  {group.recaps.map((recap) => (
                    <li
                      key={`${recap.studentEmail}|${recap.lessonDate}|${recap.startTime}`}
                    >
                      <LessonRecapBlock recap={recap} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
