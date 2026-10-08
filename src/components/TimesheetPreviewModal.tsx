// In plain English: this file is the pop-up window (a "modal") the teacher sees after clicking
// "Preview" on the Dashboard's Time sheet card. It shows the exact row that will be added to
// the payroll time sheet for one lesson (date, lesson number, first and last name, block, hours,
// music subject), lets the teacher change any of those values, lists anything worth checking in
// plain words, and then asks the Apps Script (apps-script/Code.gs) to add the row. The messages to
// Google are sent by src/api/appsScriptTimesheet.ts. Columns H, I and J (the COMPLETED LESSON box
// he ticks, the signature and the pay date) are never shown or written.
// Like the other pop-ups, it is written with React: each function below describes what to show,
// and React redraws it whenever the information it remembers ("state") changes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTimesheetRow,
  previewTimesheetRow,
  sameTimesheetCell,
  type TimesheetAddResult,
  type TimesheetCell,
  type TimesheetFields,
  type TimesheetPreview,
} from "../api/appsScriptTimesheet";
import type { LessonRowKey } from "../api/appsScriptCalendar";
import { formatLessonDateLong } from "../lib/dateUtils";

// The pop-up is always in exactly one of these situations:
//   loading   = asking Google for the preview,
//   loadError = the preview couldn't be loaded (the message says why),
//   ready     = the row is shown and can be changed; "checking" while "Check again" runs, and
//               "addError" holds the reason the last add didn't work,
//   adding    = waiting for Google to add the row,
//   added     = done.
type ModalState =
  | { kind: "loading" }
  | { kind: "loadError"; message: string }
  | {
      kind: "ready";
      preview: TimesheetPreview;
      fields: TimesheetFields;
      checking: boolean;
      addError: string | null;
    }
  | { kind: "adding"; preview: TimesheetPreview; fields: TimesheetFields }
  | { kind: "added"; result: TimesheetAddResult; sheetUrl: string };

// How long to wait for "Add" before saying it took too long. Adding can create a new tab, so it
// gets longer than the calendar pop-up's 30 seconds.
const ADD_TIMEOUT_MS = 60 * 1000;

// The pop-up itself. The Time sheet card hands it:
//   lessonKey   = which lesson (student email, date, start time), or nothing when closed,
//   studentName = the name to show in the header while loading,
//   onClose     = what to do when the teacher closes it,
//   onAdded     = what to do after the row is added (the card hides the lesson and refreshes).
export function TimesheetPreviewModal({
  lessonKey,
  studentName,
  onClose,
  onAdded,
}: {
  lessonKey: LessonRowKey | null;
  studentName: string;
  onClose: () => void;
  onAdded: (key: LessonRowKey) => void;
}) {
  const [state, setState] = useState<ModalState>({ kind: "loading" });
  // A way to cancel the request that is on its way (used when the pop-up closes).
  const abortRef = useRef<AbortController | null>(null);

  // Ask Google for the preview of this lesson's row.
  const load = useCallback((key: LessonRowKey) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: "loading" });
    previewTimesheetRow(key, undefined, { signal: ac.signal })
      .then((preview) => {
        setState({ kind: "ready", preview, fields: preview.fields, checking: false, addError: null });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          kind: "loadError",
          message: err instanceof Error ? err.message : "Could not load the preview.",
        });
      });
  }, []);

  // Whenever a lesson is opened, load its preview. When the pop-up closes, cancel the request.
  useEffect(() => {
    if (!lessonKey) return;
    load(lessonKey);
    return () => abortRef.current?.abort();
  }, [lessonKey, load]);

  // While the pop-up is open, the Escape key closes it.
  useEffect(() => {
    if (!lessonKey) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lessonKey, onClose]);

  // While the pop-up is open, the page behind it doesn't scroll.
  useEffect(() => {
    if (!lessonKey) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [lessonKey]);

  // Change one of the six values (only while the row is shown).
  const setField = useCallback(<K extends keyof TimesheetFields>(field: K, value: TimesheetFields[K]) => {
    setState((s) => (s.kind === "ready" ? { ...s, fields: { ...s.fields, [field]: value }, addError: null } : s));
  }, []);

  // "Check again": ask for a fresh preview using the names, block, hours and subject on screen.
  // The lesson number isn't sent, so the script recounts it for those names.
  const checkAgain = useCallback(() => {
    if (!lessonKey || state.kind !== "ready") return;
    const { lessonNo: _lessonNo, ...rest } = state.fields;
    void _lessonNo;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...state, checking: true, addError: null });
    previewTimesheetRow(lessonKey, rest, { signal: ac.signal })
      .then((preview) => {
        setState({ kind: "ready", preview, fields: preview.fields, checking: false, addError: null });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState((s) =>
          s.kind === "ready"
            ? { ...s, checking: false, addError: err instanceof Error ? err.message : "Could not check again." }
            : s
        );
      });
  }, [lessonKey, state]);

  // "Add to time sheet": send the row exactly as shown. If Google takes too long, say so (and that
  // trying again is safe, because the script never adds the same lesson twice).
  const add = useCallback(() => {
    if (!lessonKey || state.kind !== "ready") return;
    const { preview, fields } = state;
    setState({ kind: "adding", preview, fields });
    const ac = new AbortController();
    abortRef.current = ac;
    const timeoutId = window.setTimeout(() => {
      ac.abort();
      setState({
        kind: "ready",
        preview,
        fields,
        checking: false,
        addError:
          "Adding took too long, so it may or may not have gone in. Close this, refresh the page, and " +
          "check the time sheet. Trying again is safe: the same lesson is never added twice.",
      });
    }, ADD_TIMEOUT_MS);
    addTimesheetRow(lessonKey, fields, { signal: ac.signal })
      .then((result) => {
        window.clearTimeout(timeoutId);
        setState({ kind: "added", result, sheetUrl: preview.sheetUrl });
        onAdded(lessonKey);
      })
      .catch((err: unknown) => {
        window.clearTimeout(timeoutId);
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          kind: "ready",
          preview,
          fields,
          checking: false,
          addError: err instanceof Error ? err.message : "Could not add the row. Try again.",
        });
      });
  }, [lessonKey, onAdded, state]);

  // Closed: show nothing.
  if (!lessonKey) return null;

  // The lesson line under the title: the student, then the date and time.
  const subtitle = `${formatLessonDateLong(lessonKey.lessonDate)} · ${lessonKey.startTime}`;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="timesheet-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card timesheet-modal">
        <div className="modal-card__header">
          <div>
            <h2 id="timesheet-modal-title" className="modal-card__title">
              {state.kind === "added" ? "Added to the time sheet" : "Add to time sheet"}
            </h2>
            <p className="muted modal-card__subtitle">{studentName || lessonKey.studentEmail}</p>
            <p className="muted modal-card__subtitle modal-card__subtitle--small">{subtitle}</p>
          </div>
          <button type="button" className="button-ghost" onClick={onClose} aria-label="Close time sheet preview">
            Close
          </button>
        </div>

        {state.kind === "loading" && <p className="muted modal-card__loading">Loading the row…</p>}

        {state.kind === "loadError" && (
          <div role="alert" className="modal-card__error">
            <p className="status-error">{state.message}</p>
            <div className="modal-card__actions">
              <button type="button" className="button button--ghost" onClick={() => load(lessonKey)}>
                Try again
              </button>
              <button type="button" className="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {(state.kind === "ready" || state.kind === "adding") && (
          <RowEditor
            preview={state.preview}
            fields={state.fields}
            busy={state.kind === "adding" || (state.kind === "ready" && state.checking)}
            adding={state.kind === "adding"}
            checking={state.kind === "ready" && state.checking}
            addError={state.kind === "ready" ? state.addError : null}
            onField={setField}
            onCheckAgain={checkAgain}
            onAdd={add}
            onCancel={onClose}
          />
        )}

        {state.kind === "added" && <AddedNotice result={state.result} sheetUrl={state.sheetUrl} onDone={onClose} />}
      </div>
    </div>
  );
}

// The row itself: where it goes, the seven values (the date can't be changed), the warnings,
// and the buttons. When the lesson is already on the tab, it shows that row instead.
function RowEditor({
  preview,
  fields,
  busy,
  adding,
  checking,
  addError,
  onField,
  onCheckAgain,
  onAdd,
  onCancel,
}: {
  preview: TimesheetPreview;
  fields: TimesheetFields;
  busy: boolean;
  adding: boolean;
  checking: boolean;
  addError: string | null;
  onField: <K extends keyof TimesheetFields>(field: K, value: TimesheetFields[K]) => void;
  onCheckAgain: () => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const lists = preview.lists;
  // Changing a name or the hours can change the lesson number (and whether this lesson is
  // already on the tab), so offer "Check again".
  const needsRecheck =
    fields.firstName.trim() !== String(preview.fields.firstName).trim() ||
    fields.lastName.trim() !== String(preview.fields.lastName).trim() ||
    !sameTimesheetCell(fields.hours, preview.fields.hours);

  return (
    <div className="modal-card__body timesheet-modal__body">
      {/* Where the row goes. */}
      <p className="timesheet-modal__where">
        Goes on tab <strong>{preview.tab}</strong> of <strong>{preview.sheetTitle}</strong>, right under the last
        filled-in row.
        {preview.createsTab && (
          <>
            {" "}
            That tab doesn&rsquo;t exist yet: it will be created
            {preview.insertBefore ? <> just before <strong>{preview.insertBefore}</strong></> : null}, with the same
            header, layout and dropdowns.
          </>
        )}
        {preview.addsTermLabel && (
          <>
            {" "}
            A <strong>{preview.termLabel}</strong> label row goes just above it.
          </>
        )}
      </p>

      {preview.duplicate ? (
        <>
          <ExistingRow preview={preview} />
          {preview.lengthLine && <p className="timesheet-form__length">{preview.lengthLine}</p>}
        </>
      ) : (
        <div className="timesheet-form">
          <div className="timesheet-field">
            <span className="label">$ (date)</span>
            <span className="timesheet-field__fixed">{String(preview.row[0])}</span>
          </div>
          <CellSelect
            label="Lesson No."
            value={fields.lessonNo}
            list={lists.lessonNo}
            disabled={busy}
            onChange={(v) => onField("lessonNo", v)}
          />
          <NameInput label="Student First Name" value={fields.firstName} disabled={busy} onChange={(v) => onField("firstName", v)} />
          <NameInput label="Student Last Name" value={fields.lastName} disabled={busy} onChange={(v) => onField("lastName", v)} />
          <CellSelect label="Block" value={fields.block} list={lists.block} disabled={busy} onChange={(v) => onField("block", v)} />
          <CellSelect
            label="Total Hours"
            value={fields.hours}
            list={lists.hours}
            extras={[1.5]}
            disabled={busy}
            onChange={(v) => onField("hours", v)}
          />
          <CellSelect
            label="Music Subject"
            value={fields.subject}
            list={lists.instrument}
            disabled={busy}
            onChange={(v) => onField("subject", v)}
          />
          {/* How long the lesson really was, and what it's logged as (never written on the sheet). */}
          {preview.lengthLine && <p className="timesheet-form__length">{preview.lengthLine}</p>}
          {(preview.info ?? []).map((line) => (
            <p key={line} className="muted timesheet-form__note">
              {line}
            </p>
          ))}
          <p className="muted timesheet-form__note">
            Only columns A to G are filled in. COMPLETED LESSON, Dir. of Music Sign. and Paid on paydate stay
            as they are, for you, the signature and the business office.
          </p>
        </div>
      )}

      {/* Anything worth checking, in plain words. */}
      {preview.warnings.length > 0 && (
        <div className="timesheet-warnings" role="note">
          <p className="timesheet-warnings__title">Check before adding</p>
          <ul>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {needsRecheck && !preview.duplicate && (
        <div className="timesheet-modal__recheck">
          <p className="muted">
            You changed the name or the hours. Check again to recount the lesson number and look for this
            lesson on the time sheet.
          </p>
          <button type="button" className="button button--ghost" onClick={onCheckAgain} disabled={busy}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      )}

      {addError && (
        <p className="status-error" role="alert">
          {addError}
        </p>
      )}

      {adding && <p className="muted modal-card__loading">Adding the row to the time sheet…</p>}

      <div className="modal-card__actions">
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={adding}>
          Cancel
        </button>
        <button type="button" className="button" onClick={onAdd} disabled={busy}>
          {adding ? "Adding…" : preview.duplicate ? "Mark as added (no new row)" : "Add to time sheet"}
        </button>
      </div>
    </div>
  );
}

// When the lesson is already on the tab: show that row, read-only.
function ExistingRow({ preview }: { preview: TimesheetPreview }) {
  const dup = preview.duplicate;
  if (!dup) return null;
  const titles = ["$", "Lesson No.", "First Name", "Last Name", "Block", "Total Hours", "Music Subject"];
  return (
    <div className="timesheet-existing">
      <p className="modal-card__notice">
        This lesson is already on {preview.tab} (row {dup.rowNumber}). Nothing new will be added; the lesson
        will just be marked as added on the Lesson Schedule.
      </p>
      <dl className="timesheet-existing__row">
        {titles.map((title, i) => (
          <div key={title}>
            <dt>{title}</dt>
            <dd>{String(dup.cells[i] ?? "") || "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// A dropdown filled from one of the time sheet's lists. Values keep their type (the number 1 is
// sent as a number, not the text "1"). `extras` adds choices that aren't on the list (1.5 for a
// double), and a value already chosen that isn't on the list still shows, marked as such.
function CellSelect({
  label,
  value,
  list,
  extras = [],
  disabled,
  onChange,
}: {
  label: string;
  value: TimesheetCell;
  list: TimesheetCell[];
  extras?: TimesheetCell[];
  disabled: boolean;
  onChange: (v: TimesheetCell) => void;
}) {
  const choices = useMemo(() => {
    const out = list.slice();
    for (const extra of extras) if (!out.some((o) => sameTimesheetCell(o, extra))) out.push(extra);
    if (value !== "" && !out.some((o) => sameTimesheetCell(o, value))) out.push(value);
    return out;
  }, [list, extras, value]);
  const selected = value === "" ? "" : String(choices.findIndex((o) => sameTimesheetCell(o, value)));
  const onList = (c: TimesheetCell) => list.some((o) => sameTimesheetCell(o, c));
  return (
    <label className="timesheet-field">
      <span className="label">{label}</span>
      <select
        className="select"
        value={selected}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? "" : choices[Number(e.target.value)]!)}
      >
        <option value="">Pick one…</option>
        {choices.map((c, i) => (
          <option key={`${i}-${String(c)}`} value={String(i)}>
            {String(c)}
            {onList(c) ? "" : " (not on the list)"}
          </option>
        ))}
      </select>
    </label>
  );
}

// A text box for a first or last name.
function NameInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="timesheet-field">
      <span className="label">{label}</span>
      <input
        className="input"
        type="text"
        value={value}
        maxLength={80}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
    </label>
  );
}

// The success message: which tab and row, plus a link to open the time sheet.
function AddedNotice({
  result,
  sheetUrl,
  onDone,
}: {
  result: TimesheetAddResult;
  sheetUrl: string;
  onDone: () => void;
}) {
  return (
    <div className="modal-card__success">
      <p className="modal-card__notice modal-card__notice--ok" role="status" aria-live="polite">
        {result.alreadyThere
          ? `Already on ${result.tab}, row ${result.rowNumber}, so no new row was added. The lesson is now marked as added.`
          : `Added to ${result.tab}, row ${result.rowNumber}`}
      </p>
      {!result.alreadyThere && (result.createdTab || result.labelRowNumber) && (
        <p className="muted">
          {result.createdTab ? `The ${result.tab} tab was created. ` : ""}
          {result.labelRowNumber ? `A term label row went in at row ${result.labelRowNumber}.` : ""}
        </p>
      )}
      <p>
        <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className="link">
          Open time sheet ↗
        </a>
      </p>
      <div className="modal-card__actions">
        <button type="button" className="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
