/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Apps Script web app `/exec` URL. Required. See `.env.example`. */
  readonly VITE_APPS_SCRIPT_BASE_URL?: string;
  /**
   * Shared secret sent with every request (GET and POST) to the Apps Script web app.
   * Must match the SHARED_SECRET property in Apps Script Project
   * Settings → Script Properties. Loaded from .env.local — never commit.
   */
  readonly VITE_APPS_SCRIPT_SHARED_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Google hosting: when Apps Script serves the page (HtmlService), Google adds
 * `google.script.run` to it. The page only ever calls `api(request)` in Code.gs
 * (see src/api/appsScriptTransport.ts); everywhere else this is undefined.
 */
interface GoogleScriptRun {
  withSuccessHandler(handler: (value: unknown) => void): GoogleScriptRun;
  withFailureHandler(handler: (error: unknown) => void): GoogleScriptRun;
  api(request: Record<string, unknown>): void;
}

interface Window {
  google?: { script?: { run?: GoogleScriptRun } };
}
