// In plain English: this file is the pop-up window (a "modal") the teacher sees after
// clicking "Preview & schedule" on a pending lesson on the Dashboard. It shows what the Google
// Calendar event will look like (title, date and time, who is invited, description), lets the
// teacher add or remove people from the invite list, and then asks the Apps Script (the small
// program Google runs for the studio's sheet, apps-script/Code.gs) to create the event and send
// the invites. The messages to Google are sent by src/api/appsScriptCalendar.ts. Once the event
// is created, the Dashboard (src/pages/Dashboard.tsx) is told so it can reload the schedule.
// This file is written with React, the tool that builds this website's pages out of reusable
// pieces called "components". Each component is a function that describes what should appear
// on screen, and React redraws it whenever its information changes.
// Borrow React's built-in helpers (explained where they are used) and the calendar functions.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCalendarEvent,
  previewCalendarEvent,
  type EventPreview,
  type LessonRowKey,
} from "../api/appsScriptCalendar";

// The pop-up is always in exactly one of these situations (its "state"):
//   loading  = asking Google for the preview,
//   ready    = preview shown; the teacher can edit the invite list and confirm,
//   creating = waiting for Google to create the event,
//   created  = done (or the lesson was already on the calendar),
//   error    = something went wrong; show the message.
type ModalState =
  | { kind: "loading" }
  | { kind: "ready"; preview: EventPreview }
  | { kind: "creating"; preview: EventPreview }
  | { kind: "created"; preview: EventPreview; eventLink: string | null; alreadyScheduled: boolean }
  | { kind: "error"; message: string; preview?: EventPreview };

// A simple pattern for "looks like an email": some text, an @, more text, a dot, more text.
// It catches obvious typos but can't tell whether the address really exists.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The pop-up itself. The Dashboard hands it three things (called "props" in React):
//   lessonKey = which lesson to preview (student email, date, start time), or nothing if closed,
//   onClose   = what to do when the teacher closes the pop-up,
//   onCreated = what to do after an event is created (the Dashboard reloads its schedule).
/**
 * Two-step modal for the Phase 2 calendar workflow:
 *   1. Open with `lessonKey` set → fetches preview from Apps Script.
 *   2. Teacher reviews title, time, attendees, description. Attendees can
 *      be edited inline (add new, remove existing — at least one required).
 *   3. "Create event" → POST `create-event` with the (possibly-edited)
 *      attendee list → invites go out.
 *   4. Success state shows the calendar link + a "Done" button.
 *
 * The modal handles its own loading/error states. The parent only needs
 * to track which lesson is open and call `onCreated` after a successful
 * create so the schedule list can refetch.
 */
export function EventPreviewModal({
  lessonKey,
  onClose,
  onCreated,
}: {
  /** When non-null, the modal is open for this lesson. Null closes it. */
  lessonKey: LessonRowKey | null;
  onClose: () => void;
  /** Fires after a successful create so the parent can refetch the schedule. */
  onCreated: () => void;
}) {
  // "State" is React's word for information a component remembers between redraws; changing
  // it makes the screen update. This pop-up remembers: which situation it is in, the invite
  // list, what is typed in the "add email" box, and any message about a bad email.
  // A "ref" (abortRef) is a memory slot that doesn't cause a redraw. Here it holds a way to
  // cancel whichever request to Google is currently on its way.
  const [state, setState] = useState<ModalState>({ kind: "loading" });
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [attendeeError, setAttendeeError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Ask Google for a preview of this lesson's event. "useCallback" tells React to keep reusing
  // this same function instead of making a new copy on every redraw.
  const loadPreview = useCallback(
    (key: LessonRowKey) => {
      // Cancel any earlier request still on its way, and set up a way to cancel this new one.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      // Show "Loading preview..." and clear old messages while we wait.
      setState({ kind: "loading" });
      setAttendeeError(null);
      previewCalendarEvent(key, { signal: ac.signal })
        // When the preview arrives, show it and fill the invite list with Google's suggestions.
        .then((preview) => {
          setState({ kind: "ready", preview });
          setAttendees(preview.attendees);
          setAttendeeInput("");
        })
        // If it failed (and not because we cancelled it ourselves), show the error message.
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setState({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Could not load preview.",
          });
        });
    },
    []
  );

  // "useEffect" tells React to run some code after the pop-up appears, and again whenever the
  // listed information changes. Here: whenever a lesson is opened, load its preview. The
  // "return" part is clean-up: when the pop-up closes, cancel the request.
  useEffect(() => {
    if (!lessonKey) return;
    loadPreview(lessonKey);
    return () => abortRef.current?.abort();
  }, [lessonKey, loadPreview]);

  // While the pop-up is open, pressing the Escape key closes it.
  // Esc to close (any state).
  useEffect(() => {
    if (!lessonKey) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lessonKey, onClose]);

  // While the pop-up is open, stop the page behind it from scrolling; restore it afterward.
  // Body scroll lock while open.
  useEffect(() => {
    if (!lessonKey) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [lessonKey]);

  // If no lesson is chosen, the pop-up is closed, so show nothing at all.
  if (!lessonKey) return null;

  // The invite list can only be edited while the preview is showing (not while sending).
  const isEditable = state.kind === "ready";

  // Runs when the teacher clicks "Add" (or presses Enter) in the "add email" box.
  // It checks each typed address and adds the good, new ones to the invite list.
  const handleAddAttendee = () => {
    const raw = attendeeInput.trim();
    // Complain if the box is empty.
    if (!raw) {
      setAttendeeError("Enter an email to add.");
      return;
    }
    // Tolerate pasted lists like "a@x.com, b@y.com; c@z.com\nd@w.com" —
    // teachers will paste from emails / course rosters more often than
    // they type one at a time. Split on common delimiters, then validate
    // each piece independently so one bad address doesn't drop the
    // others.
    const candidates = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (candidates.length === 0) {
      setAttendeeError("Enter an email to add.");
      return;
    }

    // Sort each typed address into one of three piles: doesn't look like an email, already on
    // the list (ignoring capital letters), or good to add.
    const existingLower = new Set(attendees.map((a) => a.toLowerCase()));
    const additions: string[] = [];
    const invalid: string[] = [];
    const duplicates: string[] = [];
    for (const v of candidates) {
      const lower = v.toLowerCase();
      if (!EMAIL_RE.test(v)) {
        invalid.push(v);
        continue;
      }
      if (existingLower.has(lower) || additions.some((a) => a.toLowerCase() === lower)) {
        duplicates.push(v);
        continue;
      }
      additions.push(v);
    }

    // Add the good ones to the list and empty the box.
    if (additions.length > 0) {
      setAttendees([...attendees, ...additions]);
      setAttendeeInput("");
    }
    // Then show one message: bad addresses come first; otherwise "already on the list" if
    // nothing new was added; otherwise clear any old message because everything went fine.
    if (invalid.length > 0) {
      setAttendeeError(
        invalid.length === 1
          ? `"${invalid[0]}" doesn't look like a valid email.`
          : `These don't look like valid emails: ${invalid.join(", ")}`
      );
    } else if (additions.length === 0 && duplicates.length > 0) {
      setAttendeeError(
        duplicates.length === 1
          ? "That email is already on the list."
          : "Those emails are already on the list."
      );
    } else {
      setAttendeeError(null);
    }
  };

  // Runs when the teacher clicks the "×" next to an address. The last person on the list
  // can't be removed, because a calendar invite needs at least one attendee.
  const handleRemoveAttendee = (email: string) => {
    if (attendees.length <= 1) {
      setAttendeeError("At least one attendee is required.");
      return;
    }
    setAttendees(attendees.filter((a) => a !== email));
    setAttendeeError(null);
  };

  // Runs when the teacher clicks "Create event & send invites". It asks Google to create
  // the calendar event with the current invite list, then shows success or an error.
  const handleConfirm = () => {
    // Only works while the preview is showing, and only with at least one attendee.
    if (state.kind !== "ready") return;
    if (attendees.length === 0) {
      setAttendeeError("At least one attendee is required.");
      return;
    }
    // Remember the preview and switch the pop-up to its "creating" situation.
    const preview = state.preview;
    setState({ kind: "creating", preview });

    // Set up a way to cancel this request (used by the Cancel button and the time limit).
    const ac = new AbortController();
    abortRef.current = ac;

    // Hard cap on how long the modal sits in "Creating event…". Apps
    // Script's web app typically responds in 2-4s, but cold starts and
    // transient Google network blips can stretch to 20s+. Past 30s,
    // surface a "took too long" error so the teacher can retry instead
    // of staring at a spinner. The aborted fetch will reject with
    // AbortError, which the catch below ignores; we set the error
    // state explicitly here.
    const timeoutId = window.setTimeout(() => {
      ac.abort();
      setState({
        kind: "error",
        message:
          "Creating the event took too long. The lesson may or may not have been scheduled. Refresh and check before retrying.",
        preview,
      });
    }, 30 * 1000);

    // Send the request. On success: stop the time-limit clock, show the success screen, and
    // tell the Dashboard so it can reload. On failure (other than a deliberate cancel): show the
    // error message, keeping the preview.
    createCalendarEvent(lessonKey, { attendees }, { signal: ac.signal })
      .then((res) => {
        window.clearTimeout(timeoutId);
        setState({
          kind: "created",
          preview,
          eventLink: res.eventLink,
          alreadyScheduled: res.alreadyScheduled,
        });
        onCreated();
      })
      .catch((err: unknown) => {
        window.clearTimeout(timeoutId);
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Could not create the event. Try again.",
          preview,
        });
      });
  };

  // Runs when the teacher clicks Cancel while the event is being created: stop waiting and
  // go back to the preview. Google may already have created the event by then.
  const handleCancelCreating = () => {
    if (state.kind !== "creating") return;
    abortRef.current?.abort();
    setState({ kind: "ready", preview: state.preview });
  };

  // What the pop-up looks like. The part below is JSX: HTML-like markup that React turns into
  // the real page. Pieces in curly braces {} are filled in from the code above, and a line like
  // {state.kind === "loading" && (...)} means "show this part only in that situation".
  // Clicking the dark background around the card (but not the card itself) closes the pop-up.
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="event-preview-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* The white card in the middle of the screen that holds everything. */}
      <div className="modal-card">
        {/* Top row: a title that changes with the situation, and a Close button. */}
        <div className="modal-card__header">
          <h2 id="event-preview-title" className="modal-card__title">
            {state.kind === "created"
              ? state.alreadyScheduled
                ? "Already scheduled"
                : "Event created"
              : "Preview lesson event"}
          </h2>
          <button
            type="button"
            className="button-ghost"
            onClick={onClose}
            aria-label="Close preview"
          >
            Close
          </button>
        </div>

        {/* While loading: a short "Loading preview..." message. */}
        {state.kind === "loading" && (
          <p className="muted modal-card__loading">Loading preview…</p>
        )}

        {/* If something went wrong: the error message, a "Try again" button that reloads the */}
        {/* preview, and a Close button. */}
        {state.kind === "error" && (
          <div role="alert" className="modal-card__error">
            <p className="empty-state">{state.message}</p>
            <div className="modal-card__actions">
              <button
                type="button"
                className="button-ghost"
                onClick={() => loadPreview(lessonKey)}
              >
                Try again
              </button>
              <button type="button" className="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {/* Once the preview has arrived: the event details (drawn by PreviewBody, below). */}
        {(state.kind === "ready" ||
          state.kind === "creating" ||
          state.kind === "created") && (
          <PreviewBody
            preview={state.preview}
            attendees={attendees}
            editable={isEditable}
            attendeeInput={attendeeInput}
            attendeeError={attendeeError}
            onAttendeeInputChange={(v) => {
              setAttendeeInput(v);
              if (attendeeError) setAttendeeError(null);
            }}
            onAddAttendee={handleAddAttendee}
            onRemoveAttendee={handleRemoveAttendee}
          />
        )}

        {/* If this lesson is already on the calendar, say confirming won't make a copy. */}
        {state.kind === "ready" && state.preview.alreadyScheduled && (
          <p className="modal-card__notice">
            This lesson already has a calendar event. Creating again is a no-op:
            the existing event will be returned.
          </p>
        )}

        {/* While the preview is showing: Cancel, and the main button that creates the event. */}
        {/* The main button is grayed out if the invite list is empty. */}
        {state.kind === "ready" && (
          <div className="modal-card__actions">
            <button type="button" className="button-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={handleConfirm}
              disabled={attendees.length === 0}
            >
              {state.preview.alreadyScheduled
                ? "Confirm (no duplicate)"
                : "Create event & send invites"}
            </button>
          </div>
        )}

        {/* While creating: a waiting message and a Cancel button. The "<>" below is an unseen */}
        {/* wrapper that groups the two pieces together. */}
        {state.kind === "creating" && (
          <>
            <p className="muted modal-card__loading">
              Creating event and sending Google Calendar invites…
            </p>
            <div className="modal-card__actions">
              <button
                type="button"
                className="button-ghost"
                onClick={handleCancelCreating}
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {/* When done: a success message, a link to open the event in Google Calendar (if Google */}
        {/* sent one), and a Done button. */}
        {state.kind === "created" && (
          <div className="modal-card__success">
            <p>
              {state.alreadyScheduled
                ? "This lesson was already on the calendar. No duplicate created."
                : "Invites have been sent to all attendees."}
            </p>
            {state.eventLink && (
              <p>
                <a
                  href={state.eventLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link"
                >
                  Open in Google Calendar ↗
                </a>
              </p>
            )}
            <div className="modal-card__actions">
              <button type="button" className="button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// The middle section of the pop-up that lists the event details: title, when, which
// calendar, who is invited, and the description. It is given the preview from Google, the
// current invite list, whether editing is allowed, and the functions to call when the teacher
// types, adds, or removes an email.
function PreviewBody({
  preview,
  attendees,
  editable,
  attendeeInput,
  attendeeError,
  onAttendeeInputChange,
  onAddAttendee,
  onRemoveAttendee,
}: {
  preview: EventPreview;
  attendees: string[];
  editable: boolean;
  attendeeInput: string;
  attendeeError: string | null;
  onAttendeeInputChange: (v: string) => void;
  onAddAttendee: () => void;
  onRemoveAttendee: (email: string) => void;
}) {
  // Turn the start and end times (sent as standard date-time text) into real dates.
  const start = new Date(preview.startISO);
  const end = new Date(preview.endISO);
  // Check whether the lesson starts and ends on the same day (almost always true).
  const isSameDay =
    start.toDateString() === end.toDateString();

  // Write the date and times in a friendly local style, like "Monday, May 4, 2026" and
  // "2:30 PM".
  const dateLabel = start.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const startLabel = start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  // If the lesson somehow ends on a different day, include the end date too.
  const endLabel = isSameDay
    ? end.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    : end.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  // A "definition list": each row pairs a label (like "Title") with its value.
  return (
    <dl className="dl modal-card__body">
      <div>
        <dt>Title</dt>
        <dd className="strong">{preview.title}</dd>
      </div>
      {/* When: the date on one line, and the start and end times on the next. */}
      <div>
        <dt>When</dt>
        <dd>
          {dateLabel}
          <br />
          {startLabel} – {endLabel}
        </dd>
      </div>
      <div>
        <dt>Calendar</dt>
        <dd>{preview.calendarName}</dd>
      </div>
      {/* Attendees: the invite list, which the teacher can edit (drawn by AttendeesField). */}
      <div>
        <dt>Attendees</dt>
        <dd>
          <AttendeesField
            attendees={attendees}
            editable={editable}
            input={attendeeInput}
            error={attendeeError}
            onInputChange={onAttendeeInputChange}
            onAdd={onAddAttendee}
            onRemove={onRemoveAttendee}
          />
          {/* A reminder shown only while editing is allowed. */}
          {editable && (
            <p className="muted attendees-field__hint">
              Pre-filled with the student plus your default invitees. Add or
              remove emails for this lesson only. The defaults stay the same
              next time.
            </p>
          )}
        </dd>
      </div>
      {/* Description: shown with its line breaks kept exactly as written. */}
      <div>
        <dt>Description</dt>
        <dd>
          <pre className="modal-card__description">{preview.description}</pre>
        </dd>
      </div>
    </dl>
  );
}

// The invite list: each email appears as a small "chip" with an × button to remove it, plus
// a box and "Add" button for adding more. It is given the list, whether editing is allowed,
// what is typed in the box, any error message, and the functions for typing, adding, removing.
function AttendeesField({
  attendees,
  editable,
  input,
  error,
  onInputChange,
  onAdd,
  onRemove,
}: {
  attendees: string[];
  editable: boolean;
  input: string;
  error: string | null;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (email: string) => void;
}) {
  // The × buttons only work while editing is allowed and more than one person is listed.
  const canRemove = editable && attendees.length > 1;
  return (
    <div className="attendees-field">
      {/* If the list is empty, say so; otherwise show one chip per email. React needs a unique */}
      {/* "key" for each item in a list so it can tell them apart; the email itself is used. */}
      {attendees.length === 0 ? (
        <p className="muted">No attendees yet. Add at least one below.</p>
      ) : (
        <ul className="attendees-field__list">
          {attendees.map((email) => (
            <li key={email} className="attendees-field__chip">
              <span className="attendees-field__email">{email}</span>
              {editable && (
                <button
                  type="button"
                  className="attendees-field__remove"
                  onClick={() => onRemove(email)}
                  aria-label={`Remove ${email}`}
                  title={
                    canRemove
                      ? `Remove ${email}`
                      : "At least one attendee is required"
                  }
                  disabled={!canRemove}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The "add email" box and button, shown only while editing. Pressing Enter in the box */}
      {/* adds the email, the same as clicking Add. */}
      {editable && (
        <div className="attendees-field__add">
          <input
            type="email"
            className="attendees-field__input"
            placeholder="Add another email…"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAdd();
              }
            }}
            aria-label="Add attendee email"
          />
          <button
            type="button"
            className="button-ghost attendees-field__add-btn"
            onClick={onAdd}
            disabled={input.trim() === ""}
          >
            Add
          </button>
        </div>
      )}

      {/* Any problem message (like a bad email). role="alert" makes screen readers announce it. */}
      {error && (
        <p className="attendees-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
