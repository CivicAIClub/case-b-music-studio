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
 * committed to git. GET reads send the same secret as a `secret` query
 * parameter. Both are built in appsScriptTransport.ts, which also holds
 * `readSharedSecret`. On the Google-hosted page there is no secret: the
 * same actions go through google.script.run.api(), which checks the
 * signed-in teacher against ALLOWED_USERS.
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
// Every note goes through callAppsScript (appsScriptTransport.ts): on the Pomfret-only Google
// link it is handed to the script directly (no password needed: Google has signed the teacher
// in); anywhere else it is sent over the web with the shared secret, exactly as before.
import { callAppsScript, type AppsScriptReply } from "./appsScriptTransport";

// A small safety check: is this value a "record" (a bundle of labeled values, like one
// spreadsheet row with column names) rather than a list or nothing at all?
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Optional extras a caller can pass along with a note:
// - "signal": a way to cancel the note midway (for example, if the teacher closes a window).
// - "secret": a different password to use instead of the normal one (only for testing).
export type AppsScriptPostInit = {
  signal?: AbortSignal;
  /**
   * Override the shared secret read from `.env.local`. Useful in tests
   * and one-off browser-console smoke checks. Production code should
   * always rely on the env var. Ignored on the Google-hosted page.
   */
  secret?: string;
};

// The main sending function. It is given:
//   - an "action": a short name for the job the script should do, like "create-event",
//   - a "payload": any extra details that job needs, like which student and which lesson,
//   - the optional extras described just above.
// It sends everything through callAppsScript and gives back the script's reply.
// If anything goes wrong, it stops with an error message the page can show the teacher.
/**
 * Sends a write action to the Apps Script and returns the success
 * payload (without the `ok: true` wrapper).
 *
 * @param action  Routed by the `switch` in `runPostAction_` inside Code.gs
 *                (used by both doPost and api).
 * @param payload Extra fields sent alongside `action` (and, on the web,
 *                `secret`). Must be JSON-serialisable. Reserved keys
 *                (`action`, `secret`) on `payload` are ignored: the
 *                explicit args win.
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

  // If the extra details happen to include their own "action" or "secret", throw those away
  // so they can't overwrite the real ones. The two "void" lines just tell the code checker
  // that ignoring them is on purpose.
  const { action: _ignoredAction, secret: _ignoredSecret, ...rest } = payload;
  void _ignoredAction;
  void _ignoredSecret;

  // Send it (on the web, trying a second time if Google has a brief hiccup), then check the reply.
  const reply = await callAppsScript(trimmedAction, rest, init);
  return processResponse<TResult>(reply);
}

// Make sense of the script's reply. Every reply should be JSON saying "ok: true" (success) or
// "ok: false" plus an error message. On success it gives back the reply's contents; on failure
// it stops with a readable error.
function processResponse<TResult extends Record<string, unknown>>(
  reply: AppsScriptReply
): TResult {
  const { status, json } = reply;
  // If the reply isn't JSON, Google probably sent back an error page, which often happens when
  // Code.gs was changed but not redeployed (republished).
  if (json === undefined) {
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
