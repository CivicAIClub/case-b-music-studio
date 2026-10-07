/**
 * The ONE function every request to the Apps Script goes through: `callAppsScript`.
 *
 * Two ways to reach the same Apps Script code (apps-script/Code.gs):
 *
 *   1. Google hosting (the page is served by Apps Script itself, signed in with a Pomfret
 *      account): `google.script.run.api(request)`. No shared secret and no /exec URL; the
 *      script checks the visitor's email against its ALLOWED_USERS Script Property.
 *   2. Everywhere else (GitHub Pages, `npm run dev`): today's web requests to the /exec URL in
 *      VITE_APPS_SCRIPT_BASE_URL, carrying VITE_APPS_SCRIPT_SHARED_SECRET. Reads are GETs
 *      (`?action=list&secret=…`), writes are POSTs (text/plain JSON body, see appsScriptPost.ts).
 *
 * The choice is made per call: if `google.script.run` exists, use it. Both ways give back the
 * same JSON, so the callers in src/api/ check the answer the same way either way.
 */
// In plain English: this file is the website's single "phone line" to the Apps Script. When the
// website is opened from Google (the Pomfret-only link), it calls the script directly through
// Google's own bridge (google.script.run). When it is opened from GitHub Pages or a developer's
// computer, it sends web requests with the shared password, exactly as before. Every file in
// src/api/ asks through callAppsScript below, so that choice is made in one place.
import { reportAccessDenied } from "../lib/accessDenied";

/** The four read requests (the GET routes); every other action is a write (a POST). */
const READ_ACTIONS = new Set(["list", "student", "schedule-list", "schedule"]);

/** What a call gives back: the HTTP status (200 on Google) and the reply read as JSON. */
export type AppsScriptReply = {
  status: number;
  /** The reply as JSON, or `undefined` when a web reply wasn't JSON (e.g. a Google error page). */
  json: unknown;
};

export type AppsScriptCallInit = {
  signal?: AbortSignal;
  /** Override the shared secret (web path only); for tests and console smoke checks. */
  secret?: string;
};

// Is this page being served by Apps Script? Then Google has put `google.script.run` on the page.
export function isGoogleHosted(): boolean {
  return typeof window !== "undefined" && !!window.google?.script?.run;
}

// The single entry point. `action` is a read ("list", "student", "schedule-list", "schedule")
// or a write job name (like "create-event"); `params` are its details (like the student email).
export async function callAppsScript(
  action: string,
  params: Record<string, unknown> = {},
  init?: AppsScriptCallInit
): Promise<AppsScriptReply> {
  if (isGoogleHosted()) {
    const json = await runOnGoogle({ ...params, action }, init?.signal);
    // The script said this person isn't on ALLOWED_USERS: tell the whole page (AppLayout shows
    // the message instead of the dashboard), and let the caller report the error as usual.
    if (isRecord(json) && json.accessDenied === true && typeof json.error === "string") {
      reportAccessDenied(json.error);
    }
    return { status: 200, json };
  }
  return READ_ACTIONS.has(action)
    ? webRead(action, params, init)
    : webWrite(JSON.stringify({ ...params, action, secret: init?.secret ?? readSharedSecret() }), init?.signal);
}

// ─── Google hosting ──────────────────────────────────────────────────────────────────────

// Calls api(request) in Code.gs through google.script.run. Google can't cancel a call once it
// has started, so a cancel (closing a window) just stops waiting for the answer.
function runOnGoogle(request: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    window.google!.script!.run!
      .withSuccessHandler((value: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      })
      .withFailureHandler((error: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(message || "The Music Studio script didn't answer. Try again."));
      })
      .api(request);
  });
}

// ─── The web path (GitHub Pages and local development) ─────────────────────────────────

// The script's web address, from the settings file (.env.local) copied into the website when
// it is built. Only the web path needs it, so it is checked only when a web request is made.
export function appsScriptBaseUrl(): string {
  const url = (import.meta.env.VITE_APPS_SCRIPT_BASE_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "VITE_APPS_SCRIPT_BASE_URL is not set. Copy .env.example to .env.local " +
        "and paste your Apps Script /exec URL."
    );
  }
  return url;
}

// The shared secret (the password that proves a web request came from this website), from the
// settings file. If it is missing or blank, stop with a message explaining how to fix it.
export function readSharedSecret(): string {
  const value = import.meta.env.VITE_APPS_SCRIPT_SHARED_SECRET;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "Missing VITE_APPS_SCRIPT_SHARED_SECRET. Add it to .env.local at the repo root (copy .env.example) and restart the dev server."
    );
  }
  return value;
}

// A read request: a GET to the /exec address, with the same query strings as always.
async function webRead(
  action: string,
  params: Record<string, unknown>,
  init?: AppsScriptCallInit
): Promise<AppsScriptReply> {
  const email = encodeURIComponent(String(params.email ?? "").trim());
  const secret = encodeURIComponent(init?.secret ?? readSharedSecret());
  const query =
    action === "student"
      ? `?email=${email}&secret=${secret}`
      : action === "schedule"
        ? `?action=schedule&email=${email}&secret=${secret}`
        : `?action=${encodeURIComponent(action)}&secret=${secret}`;
  const res = await fetch(appsScriptBaseUrl() + query, { method: "GET", signal: init?.signal });
  return { status: res.status, json: parseJson(await res.text()) };
}

// A write request: a POST of the JSON body. It is labeled "plain text" on purpose: with any other
// label the browser first asks Google's script for permission (a "preflight"), which the script
// can't answer. If Google has a brief hiccup (502, 503, 504, or no answer), try once more.
async function webWrite(body: string, signal: AbortSignal | undefined): Promise<AppsScriptReply> {
  const url = appsScriptBaseUrl();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal,
        redirect: "follow",
      });
    } catch (err) {
      // A deliberate cancel is passed along without retrying.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt === 0) {
        await wait(400, signal);
        continue;
      }
      throw new Error(`Could not reach Apps Script at ${url}. Network error or web app URL is wrong.`);
    }
    if (attempt === 0 && (res.status === 502 || res.status === 503 || res.status === 504)) {
      await wait(400, signal);
      continue;
    }
    return { status: res.status, json: parseJson(await res.text()) };
  }
  throw new Error("Apps Script request failed.");
}

// Pause before the retry; stop waiting right away if the request is cancelled meanwhile.
async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const id = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

// Read text as JSON, or give back `undefined` if it isn't JSON.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
