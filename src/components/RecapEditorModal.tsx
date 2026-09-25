// In plain English: this file is the pop-up window (a "modal") the teacher uses to write or
// edit a lesson recap, the short note the teacher writes after each lesson. A recap has four
// parts: a greeting (which automatically starts with "Hi <first name>,"), what we did today,
// homework, and plans for next class. It is opened from a student's profile on the Students
// page (src/pages/StudentDirectory.tsx). When it opens, it asks the Apps Script (the small
// program Google runs for the studio's sheet, apps-script/Code.gs) for any recap already saved
// for that lesson; when the teacher clicks Save, the recap is stored in the sheet's
// "Lesson Recaps" tab. The messages to Google are sent by src/api/appsScriptRecaps.ts.
// While the teacher types, a draft copy is kept in the browser's own storage, so accidentally
// closing the tab doesn't lose the work.
// This file is written with React, the tool that builds this website's pages out of reusable
// pieces called "components"; each describes what to show, and React redraws it when its
// information changes.
// Borrow React's built-in helpers, the recap functions, and a date-formatting helper.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getLessonRecap,
  saveLessonRecap,
  type LessonRecapFields,
  type LessonRecapKey,
} from "../api/appsScriptRecaps";
import type { LessonRecap } from "../types";
import { formatLessonDateLong } from "../lib/dateUtils";

// Which lesson the pop-up is open for: the lesson's identity (student email, date, start
// time), the student's name, and optionally the lesson's focus and end time for the header.
/** Open target — null when the modal is closed. */
export type RecapEditorTarget = {
  key: LessonRecapKey;
  studentName: string;
  /** Optional context shown in the modal header. */
  lessonFocus?: string;
  endTime?: string;
};

// The pop-up is always in exactly one of these situations (its "state"):
//   loading = asking Google for any saved recap,
//   ready   = form shown ("existed" says whether a recap was already saved),
//   saving  = waiting for Google to store it,
//   saved   = done ("mode" says whether it was new or an update),
//   error   = something went wrong; the teacher's typing is kept.
type ModalState =
  | { kind: "loading" }
  | { kind: "ready"; existed: boolean; fields: LessonRecapFields }
  | { kind: "saving"; fields: LessonRecapFields }
  | {
      kind: "saved";
      saved: LessonRecap;
      fields: LessonRecapFields;
      mode: "created" | "updated";
    }
  | { kind: "error"; message: string; fields: LessonRecapFields };

// A blank recap, used when nothing has been written yet.
const EMPTY_FIELDS: LessonRecapFields = {
  greeting: "",
  todayWe: "",
  homework: "",
  nextClass: "",
};

// The start of the label that drafts are saved under in the browser's storage. The "v1"
// lets the draft format change later without mixing up old drafts.
const STORAGE_PREFIX = "caseB.recapDraft.v1:";

// The pop-up itself. The Students page hands it three things (called "props" in React):
//   target  = which lesson's recap to edit, or nothing if the pop-up is closed,
//   onClose = what to do when the teacher closes it,
//   onSaved = what to do after a successful save (the page updates its list of recaps).
/**
 * Two-step modal for composing or editing a lesson recap. On open:
 *   1. Fetch any existing recap for this lesson key.
 *   2. Pre-fill form from the recap (or from a local-storage draft if
 *      there's a never-saved one — typing then closing the tab won't
 *      lose the work).
 *   3. Save → POST → success state with a "View" button that closes
 *      and a "Done" button that returns the saved recap to the parent.
 *
 * The "Hi {Name}," opener is rendered as a non-editable header inside
 * the greeting field's label so the teacher knows the personalisation
 * is automatic.
 */
export function RecapEditorModal({
  target,
  onClose,
  onSaved,
}: {
  /** When non-null, the modal is open for this lesson recap. */
  target: RecapEditorTarget | null;
  onClose: () => void;
  /**
   * Fires after a successful save with the freshly-stored recap so the
   * parent can refresh its listing without a separate fetch.
   */
  onSaved: (recap: LessonRecap) => void;
}) {
  // "State" is React's word for information a component remembers between redraws; changing
  // it updates the screen. Here it holds the pop-up's situation and the text in the form.
  // A "ref" (abortRef) is a memory slot that doesn't cause a redraw; it holds a way to cancel
  // the request that loads a saved recap.
  const [state, setState] = useState<ModalState>({ kind: "loading" });
  const abortRef = useRef<AbortController | null>(null);

  // The label for this lesson's draft in the browser's storage: the prefix plus the
  // student's email, lesson date, and start time. "useMemo" tells React to work this out again
  // only when the lesson changes.
  const targetStorageKey = useMemo(() => {
    if (!target) return null;
    return (
      STORAGE_PREFIX +
      `${target.key.studentEmail}|${target.key.lessonDate}|${target.key.startTime}`
    );
  }, [target]);

  // Save the teacher's typing as a draft in "localStorage" (a small storage space each
  // website gets inside the teacher's own browser). If every box is empty, delete the draft
  // instead. "useCallback" tells React to keep reusing the same function between redraws.
  const writeDraft = useCallback(
    (fields: LessonRecapFields) => {
      if (!targetStorageKey) return;
      try {
        if (
          !fields.greeting &&
          !fields.todayWe &&
          !fields.homework &&
          !fields.nextClass
        ) {
          window.localStorage.removeItem(targetStorageKey);
          return;
        }
        window.localStorage.setItem(
          targetStorageKey,
          JSON.stringify(fields)
        );
      } catch {
        // localStorage full / disabled — non-fatal, drafts just don't persist.
      }
    },
    [targetStorageKey]
  );

  // Read back this lesson's draft, if there is one. Any missing part becomes empty text.
  // If the draft can't be read, act as if there is none.
  const readDraft = useCallback((): LessonRecapFields | null => {
    if (!targetStorageKey) return null;
    try {
      const raw = window.localStorage.getItem(targetStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<LessonRecapFields>;
      return {
        greeting: typeof parsed.greeting === "string" ? parsed.greeting : "",
        todayWe: typeof parsed.todayWe === "string" ? parsed.todayWe : "",
        homework: typeof parsed.homework === "string" ? parsed.homework : "",
        nextClass: typeof parsed.nextClass === "string" ? parsed.nextClass : "",
      };
    } catch {
      return null;
    }
  }, [targetStorageKey]);

  // Delete this lesson's draft (done after a successful save).
  const clearDraft = useCallback(() => {
    if (!targetStorageKey) return;
    try {
      window.localStorage.removeItem(targetStorageKey);
    } catch {
      // ignored
    }
  }, [targetStorageKey]);

  // Load any recap already saved for this lesson, then decide what to put in the form:
  //   - a saved recap exists: show it, unless there is an unsaved draft that differs from it,
  //     in which case show the draft (the teacher's newer, unsaved edits);
  //   - no saved recap: show the draft if there is one, otherwise empty boxes.
  const load = useCallback(
    (key: LessonRecapKey) => {
      // Cancel any earlier load still on its way, and set up a way to cancel this one.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      // Show "Loading recap..." and ask Google for the saved recap.
      setState({ kind: "loading" });
      getLessonRecap(key, { signal: ac.signal })
        .then((existing) => {
          const draft = readDraft();
          if (existing) {
            const fields: LessonRecapFields = {
              greeting: existing.greeting,
              todayWe: existing.todayWe,
              homework: existing.homework,
              nextClass: existing.nextClass,
            };
            // If a local draft exists and differs from the saved recap,
            // prefer the draft — it's the teacher's in-progress edit.
            if (
              draft &&
              (draft.greeting !== fields.greeting ||
                draft.todayWe !== fields.todayWe ||
                draft.homework !== fields.homework ||
                draft.nextClass !== fields.nextClass)
            ) {
              setState({ kind: "ready", existed: true, fields: draft });
            } else {
              setState({ kind: "ready", existed: true, fields });
            }
          } else {
            setState({
              kind: "ready",
              existed: false,
              fields: draft ?? EMPTY_FIELDS,
            });
          }
        })
        // If loading failed (and not because we cancelled it), show the error but keep any
        // draft in the form so the teacher can keep working.
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setState({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Could not load recap.",
            fields: readDraft() ?? EMPTY_FIELDS,
          });
        });
    },
    [readDraft]
  );

  // "useEffect" tells React to run code after the pop-up appears, and again whenever the
  // listed information changes. Here: whenever a lesson is opened, load its recap. The
  // "return" part is clean-up: when the pop-up closes, cancel the request.
  useEffect(() => {
    if (!target) return;
    load(target.key);
    return () => abortRef.current?.abort();
  }, [target, load]);

  // While the pop-up is open, pressing the Escape key closes it.
  // Esc to close
  useEffect(() => {
    if (!target) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  // While the pop-up is open, stop the page behind it from scrolling; restore it afterward.
  // Body scroll lock
  useEffect(() => {
    if (!target) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [target]);

  // Runs every time the teacher types in one of the four boxes: update that box's text and
  // save a fresh draft. Typing is only accepted while the form is showing (or after an error).
  const updateField = useCallback(
    (field: keyof LessonRecapFields, value: string) => {
      setState((s) => {
        if (s.kind !== "ready" && s.kind !== "error") return s;
        const fields = { ...s.fields, [field]: value };
        writeDraft(fields);
        if (s.kind === "error") {
          return { ...s, fields };
        }
        return { ...s, fields };
      });
    },
    [writeDraft]
  );

  // Runs when the teacher clicks Save. It switches to "saving" and sends the recap to
  // Google. If that works, it deletes the draft, shows the success screen, and hands the saved
  // recap to the Students page. If not, it shows the error with the teacher's text still there.
  const onSave = useCallback(() => {
    if (!target) return;
    setState((s) => {
      if (s.kind !== "ready" && s.kind !== "error") return s;
      const fields = s.fields;
      saveLessonRecap(target.key, fields)
        .then((saved) => {
          clearDraft();
          const mode: "created" | "updated" =
            s.kind === "ready" && s.existed ? "updated" : "created";
          setState({ kind: "saved", saved, fields, mode });
          onSaved(saved);
        })
        .catch((err: unknown) => {
          setState({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Could not save recap.",
            fields,
          });
        });
      return { kind: "saving", fields };
    });
  }, [clearDraft, onSaved, target]);

  // If no lesson is chosen, the pop-up is closed, so show nothing.
  if (!target) return null;

  // The small line under the student's name: lesson date · start–end time · lesson focus.
  // The end time and the focus are added only when they are known.
  const headerSubtitle = `${formatLessonDateLong(target.key.lessonDate)} · ${target.key.startTime}${
    target.endTime ? `–${target.endTime}` : ""
  }${target.lessonFocus ? ` · ${target.lessonFocus}` : ""}`;

  // What the pop-up looks like. The part below is JSX: HTML-like markup that React turns into
  // the real page; pieces in curly braces {} are filled in from the code above.
  // Clicking the dark background around the card (but not the card itself) closes the pop-up.
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recap-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* The white card in the middle of the screen. */}
      <div className="modal-card recap-modal-card">
        {/* Header: a title that matches the situation, the student's name, the lesson details */}
        {/* line, and a ✕ button that closes the pop-up. */}
        <div className="modal-card__header">
          <div>
            <h2 id="recap-modal-title" className="modal-card__title">
              {state.kind === "saved"
                ? "Recap saved"
                : state.kind === "ready" && state.existed
                  ? "Edit recap"
                  : "Write recap"}
            </h2>
            <p className="muted modal-card__subtitle">
              {target.studentName || target.key.studentEmail}
            </p>
            <p className="muted modal-card__subtitle modal-card__subtitle--small">
              {headerSubtitle}
            </p>
          </div>
          <button
            type="button"
            className="button-ghost modal-card__close"
            onClick={onClose}
            aria-label="Close recap editor"
          >
            ✕
          </button>
        </div>

        {/* The main area (loading message, form, or success message), drawn by ModalBody below. */}
        <ModalBody
          state={state}
          target={target}
          onChange={updateField}
          onClose={onClose}
          onSave={onSave}
          onRetryLoad={() => load(target.key)}
        />
      </div>
    </div>
  );
}

// The main area of the pop-up, which changes with the situation: a loading message, a
// success message, or the four-box recap form. It is given the current situation, the lesson,
// and the functions to call when the teacher types, closes, saves, or asks to reload.
function ModalBody({
  state,
  target,
  onChange,
  onClose,
  onSave,
  onRetryLoad,
}: {
  state: ModalState;
  target: RecapEditorTarget;
  onChange: (field: keyof LessonRecapFields, value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onRetryLoad: () => void;
}) {
  // Still loading: just show "Loading recap...".
  if (state.kind === "loading") {
    return (
      <div className="modal-card__body">
        <p className="muted">Loading recap…</p>
      </div>
    );
  }

  // Saved: confirm it, and offer a Done button that closes the pop-up.
  if (state.kind === "saved") {
    return (
      <div className="modal-card__body">
        <p
          className="modal-card__notice modal-card__notice--ok"
          role="status"
          aria-live="polite"
        >
          {state.mode === "created"
            ? "Recap saved. The student profile now has it under this lesson."
            : "Recap updated."}
        </p>
        <div className="modal-card__actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // Otherwise show the form, filled with the current text. While saving, the boxes and
  // buttons are grayed out so nothing changes in the middle of a save.
  const fields = state.fields;
  const isSaving = state.kind === "saving";
  const isError = state.kind === "error";

  // The student's first name for the automatic "Hi <name>," opener ("there" if unknown).
  const greetingName =
    target.studentName.trim().split(/\s+/)[0] || "there";

  // The form. Clicking the Save button saves the recap (unless a save is already running).
  // "preventDefault" stops the browser's built-in habit of reloading the page on submit.
  return (
    <form
      className="modal-card__body recap-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isSaving) onSave();
      }}
    >
      {/* If something went wrong: show the message and a button to reload from Google. */}
      {isError && (
        <div className="modal-card__error" role="alert">
          <p className="status-error">{state.message}</p>
          <button
            type="button"
            className="button button--ghost"
            onClick={onRetryLoad}
          >
            Reload from server
          </button>
        </div>
      )}

      {/* Box 1: the greeting. Its label shows how it will begin ("Hi <first name>,"). */}
      {/* The light gray example text in each box disappears as soon as the teacher types. */}
      <label className="recap-editor__field">
        <span className="recap-editor__label">
          Greeting{" "}
          <span className="muted recap-editor__hint">
            (rendered as <em>“Hi {greetingName},”</em> + your text)
          </span>
        </span>
        {/* Each box shows the current text and reports every keystroke back to be saved. */}
        <textarea
          className="recap-editor__textarea recap-editor__textarea--short"
          rows={2}
          value={fields.greeting}
          onChange={(e) => onChange("greeting", e.target.value)}
          placeholder="excellent lesson, ventured into &ldquo;Meaning of You&rdquo;"
          disabled={isSaving}
        />
      </label>

      {/* Box 2: what the lesson covered today. */}
      <label className="recap-editor__field">
        <span className="recap-editor__label">Today we</span>
        <textarea
          className="recap-editor__textarea"
          rows={6}
          value={fields.todayWe}
          onChange={(e) => onChange("todayWe", e.target.value)}
          placeholder={`Went through Chromatic Exercise #2\nReviewed Exercise 10 P. 16\nStarted "Meaning of You"`}
          disabled={isSaving}
        />
      </label>

      {/* Box 3: homework for the student. */}
      <label className="recap-editor__field">
        <span className="recap-editor__label">HOMEWORK</span>
        <textarea
          className="recap-editor__textarea"
          rows={5}
          value={fields.homework}
          onChange={(e) => onChange("homework", e.target.value)}
          placeholder={`Review Exercise 10 P. 16 (DUE 5/4)\nSubmit a video on "Bye Love"`}
          disabled={isSaving}
        />
      </label>

      {/* Box 4: plans for the next class. */}
      <label className="recap-editor__field">
        <span className="recap-editor__label">Next Class</span>
        <textarea
          className="recap-editor__textarea"
          rows={4}
          value={fields.nextClass}
          onChange={(e) => onChange("nextClass", e.target.value)}
          placeholder={`Review P. 16 "Bye Love"\nContinue "Meaning of You"`}
          disabled={isSaving}
        />
      </label>

      {/* Bottom buttons: Cancel closes without saving; the main button saves. Its wording */}
      {/* changes: "Save changes" when editing an existing recap, "Saving..." while saving. */}
      <div className="modal-card__actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={onClose}
          disabled={isSaving}
        >
          Cancel
        </button>
        <button type="submit" className="button" disabled={isSaving}>
          {isSaving
            ? "Saving…"
            : state.kind === "ready" && state.existed
              ? "Save changes"
              : "Save recap"}
        </button>
      </div>
    </form>
  );
}
