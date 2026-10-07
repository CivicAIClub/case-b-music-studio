// Checks `npm run build:gas`, the website built for Google hosting: ONE self-contained HTML file
// (dist-gas/Index.html) that never contains the Apps Script /exec URL or the shared secret, even
// when they are set on the computer doing the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./helpers/gas-sandbox.js";

test("build:gas makes one self-contained Index.html with no URL or secret in it", () => {
  const env = Object.assign({}, process.env, {
    VITE_APPS_SCRIPT_BASE_URL: "https://canary-url.example/exec",
    VITE_APPS_SCRIPT_SHARED_SECRET: "canary-secret-value-123",
  });
  execFileSync("npm", ["run", "--silent", "build:gas"], { cwd: REPO_ROOT, env, stdio: "pipe" });

  const dir = path.join(REPO_ROOT, "dist-gas");
  assert.deepEqual(fs.readdirSync(dir), ["Index.html"]);
  const html = fs.readFileSync(path.join(dir, "Index.html"), "utf8");

  // Never the web path's settings.
  assert.ok(!html.includes("canary-url.example"), "the /exec URL leaked into the page");
  assert.ok(!html.includes("canary-secret-value-123"), "the shared secret leaked into the page");
  // Self-contained: the app's code is inline, the logo is inline, nothing loads from a file.
  assert.equal((html.match(/<script\b[^>]*\bsrc=/gi) || []).length, 0);
  assert.ok(/<script type="module"[^>]*>[\s\S]{100000,}<\/script>/.test(html), "the app's code should be inline");
  assert.ok(html.includes("data:image/png;base64,"), "the logo should be inline");
  assert.ok(!/["'(]\.?\/?assets\//.test(html));
  assert.ok(!html.includes('rel="icon"'));
  // It talks to Apps Script through google.script.run's api().
  assert.ok(html.includes("google.script.run") || html.includes(".script.run"));
});
