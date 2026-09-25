/**
 * Apps Script POST client (write actions).
 *
 * Reads (roster, schedule) live in:
 *   src/api/appsScriptStudent.ts
 *   src/api/appsScriptSchedule.ts
 *
 * POSTs are gated by a shared secret stored in Script Properties on
 * the Apps Script side and in `.env.local` on this side
 * (`VITE_APPS_SCRIPT_SHARED_SECRET`). The secret is intentionally not
 * committed to git.
 *
 * IMPORTANT: this secret is bundled into the deployed JS — anyone
 * who can open the site in DevTools can read it. Treat the deployed
 * URL as private (don't link it publicly).
 *
 * ──────────────────────────────────────────────────────────────────────
 * Why Content-Type: text/plain
 * ──────────────────────────────────────────────────────────────────────
 * Apps Script web apps don't expose custom CORS headers. A POST with
 * `Content-Type: application/json` is a "non-simple" CORS request and
 * triggers a preflight OPTIONS that Apps Script can't answer, so it
 * fails before the handler runs. Sending the JSON body as `text/plain`
 * keeps the request "simple" — the browser skips the preflight, and the
 * Apps Script side reads the raw string at `e.postData.contents` and
 * `JSON.parse`s it.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Response shape (every POST)
 * ──────────────────────────────────────────────────────────────────────
 *   { ok: true, ...data }     // success
 *   { ok: false, error: "…" } // any failure (auth, bad input, handler threw)
 *
 * `postToAppsScript` resolves with the success payload and rejects with
 * an Error whose `.message` is the server-side `error` string. Callers
 * never have to branch on `ok` themselves.
 */
// In plain English: this file is the website's "mail carrier" for changes. Whenever the
// teacher does something that changes the studio's records (creating a calendar invite, saving
// a lesson recap, sharing Drive folders, and so on), the page hands a short note to this file,
// and this file delivers it to the studio's Apps Script (a small program Google runs for us,
// attached to the studio's Google Sheet; its code lives in apps-script/Code.gs).
// Every note carries a shared secret (a password both sides know) so the script can tell the
// note really came from this website. That password is baked into the website itself, so the
// site's web address is kept semi-private rather than shared publicly.
// Files that send their notes through this one: appsScriptCalendar.ts, appsScriptRecaps.ts,
// appsScriptResources.ts, and appsScriptStudentResources.ts.
// Borrow the script's web address from the file that reads student data.
import { APPS_SCRIPT_BASE_URL } from "./appsScriptStudent";

// A small safety check: is this value a "record" (a bundle of labeled values, like one
// spreadsheet row with column names) rather than a list or nothing at all?
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Look up the shared secret (the password that proves a note came from this website).
// It comes from a settings file (.env.local) and is copied into the website when it is built.
// If it is missing or blank, stop right away with a message explaining how to fix it.
function readSharedSecret(): string {
  const value = import.meta.env.VITE_APPS_SCRIPT_SHARED_SECRET;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "Missing VITE_APPS_SCRIPT_SHARED_SECRET. Add it to .env.local at the repo root (copy .env.example) and restart the dev server."
    );
  }
  return value;
}

// Optional extras a caller can pass along with a note:
// - "signal": a way to cancel the note midway (for example, if the teacher closes a window).
// - "secret": a different password to use instead of the normal one (only for testing).
export type AppsScriptPostInit = {
  signal?: AbortSignal;
  /**
   * Override the shared secret read from `.env.local`. Useful in tests
   * and one-off browser-console smoke checks. Production code should
   * always rely on the env var.
   */
  secret?: string;
};

// The main sending function. It is given:
//   - an "action": a short name for the job the script should do, like "create-event",
//   - a "payload": any extra details that job needs, like which student and which lesson,
//   - the optional extras described just above.
// It packs everything into one message, sends it, and gives back the script's reply.
// If anything goes wrong, it stops with an error message the page can show the teacher.
/**
 * Sends a POST to the Apps Script web app and returns the success
 * payload (without the `ok: true` wrapper).
 *
 * @param action  Routed by the `switch` in `doPost` inside Code.gs.
 * @param payload Extra fields merged into the request body alongside
 *                `action` and `secret`. Must be JSON-serialisable.
 *                Reserved keys (`action`, `secret`) on `payload` are
 *                ignored — the explicit args win.
 */
export async function postToAppsScript<TResult extends Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
  init?: AppsScriptPostInit
): Promise<TResult> {
  // Make sure we were told which job to do; a blank job name is a programming mistake.
  const trimmedAction = action.trim();
  if (!trimmedAction) {
    throw new Error("postToAppsScript requires a non-empty action.");
  }

  // Use the test password if one was given; otherwise use the normal shared secret.
  const secret = init?.secret ?? readSharedSecret();

  // If the extra details happen to include their own "action" or "secret", throw those away
  // so they can't overwrite the real ones. The two "void" lines just tell the code checker
  // that ignoring them is on purpose.
  const { action: _ignoredAction, secret: _ignoredSecret, ...rest } = payload;
  void _ignoredAction;
  void _ignoredSecret;

  // Pack the job name, the password, and the details into JSON (a plain-text format that
  // programs use to send structured information to each other).
  const body = JSON.stringify({
    action: trimmedAction,
    secret,
    ...rest,
  });

  // Send it (trying a second time if Google has a brief hiccup), then read the reply.
  const result = await fetchWithRetry(body, init?.signal);
  return processResponse<TResult>(result.text, result.status);
}

// Actually send the message over the internet to the script's web address.
// If Google has a brief hiccup, wait a moment and try one more time before giving up.
// It gives back the raw text of the reply plus its status number (200 means "OK").
/**
 * fetch wrapper that retries once on a transient failure. Apps Script
 * occasionally returns 502/503/504 from a Google-side blip; a single
 * retry covers the vast majority of those without making the user wait
 * on a manual "Try again". The retry is skipped when the call is
 * aborted (the user explicitly cancelled).
 */
async function fetchWithRetry(
  body: string,
  signal: AbortSignal | undefined
): Promise<{ text: string; status: number }> {
  // Remember the last problem we hit, so we can report it if both tries fail.
  let lastError: unknown = null;
  // Try at most twice: attempt 0 is the first try, attempt 1 is the retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    // If the teacher already cancelled (for example, closed the window), stop here.
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Send the message. It is labeled "plain text" on purpose: with any other label the browser
    // first asks Google's script for permission, and the script can't answer that question
    // (the note at the top of this file explains more). "redirect: follow" is needed because
    // Google hands the reply back from a second web address.
    let res: Response;
    try {
      res = await fetch(APPS_SCRIPT_BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal,
        redirect: "follow",
      });
    } catch (err) {
      // The message never arrived (no internet, a wrong address, and so on).
      // If the teacher cancelled on purpose, pass that along without retrying.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err;
      // After the first failure, wait 0.4 seconds and try again.
      if (attempt === 0) {
        await wait(400, signal);
        continue;
      }
      // The second try failed too, so give up with a helpful message.
      throw new Error(
        `Could not reach Apps Script at ${APPS_SCRIPT_BASE_URL}. Network error or web app URL is wrong.`
      );
    }

    // Status numbers 502, 503, and 504 mean Google's servers had a temporary problem.
    // On the first try, wait a moment and send again instead of bothering the teacher.
    if (
      attempt === 0 &&
      (res.status === 502 || res.status === 503 || res.status === 504)
    ) {
      await wait(400, signal);
      continue;
    }

    // Otherwise we got a real reply (good or bad), so read its text and hand it back.
    const text = await res.text();
    return { text, status: res.status };
  }
  // Only reached in unusual cases; report the last problem we saw.
  throw lastError instanceof Error
    ? lastError
    : new Error("Apps Script request failed.");
}

// Pause for the given number of milliseconds (thousandths of a second) before going on.
// If the note gets cancelled during the pause, stop waiting right away.
async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const id = window.setTimeout(resolve, ms);
    // If a cancel arrives during the pause, stop the timer and report the cancellation.
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(id);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    }
  });
}

// Make sense of the script's reply. It is given the reply text and the status number.
// Every reply should be JSON saying "ok: true" (success) or "ok: false" plus an error message.
// On success it gives back the reply's contents; on failure it stops with a readable error.
function processResponse<TResult extends Record<string, unknown>>(
  text: string,
  status: number
): TResult {
  // Try to read the reply as JSON. If it isn't JSON, Google probably sent back an error page,
  // which often happens when Code.gs was changed but not redeployed (republished).
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Apps Script returned a non-JSON response (HTTP ${status}). Did you redeploy after changing Code.gs?`
    );
  }

  // The reply should be a bundle of labeled values, not a list or a single word.
  if (!isRecord(json)) {
    throw new Error("Apps Script returned an unexpected response shape (expected an object).");
  }

  // The script said something went wrong: pass along its own explanation if it gave one.
  if (json.ok === false) {
    const message =
      typeof json.error === "string" && json.error.trim()
        ? json.error
        : `Apps Script reported failure (HTTP ${status}).`;
    throw new Error(message);
  }

  // A status number outside 200 to 299 also means failure, even if the reply looked fine.
  if (status < 200 || status >= 300) {
    throw new Error(`Apps Script request failed (HTTP ${status}).`);
  }

  // Everything checks out, so hand the reply's contents back to whoever asked.
  return json as TResult;
}

// ──────────────────────────────────────────────────────────────────────
// Concrete actions
// ──────────────────────────────────────────────────────────────────────

// What the script sends back to a "ping" (a simple "are you there?" test message):
// a "pong" answer, the time, the message echoed back, and the name of the connected sheet.
export type PingResult = {
  ok: true;
  pong: true;
  ts: number;
  echo: string | null;
  spreadsheet: string;
};

// Send a "ping" to check that the website can reach the script and the password works.
// An optional message is sent along and comes back unchanged. Useful for testing.
export async function pingAppsScript(
  message?: string,
  init?: AppsScriptPostInit
): Promise<PingResult> {
  return postToAppsScript<PingResult>(
    "ping",
    message != null ? { message } : {},
    init
  );
}
