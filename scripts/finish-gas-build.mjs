// finish-gas-build.mjs: the last step of `npm run build:gas`.
// Vite has just built the whole website into ONE file, dist-gas/index.html (JavaScript, CSS and
// images all inside it). This script renames it to Index.html (the name of the HTML file in the
// Apps Script editor), removes the favicon link (Google shows its own tab icon, and the file
// isn't there), and checks the result really is self-contained before anyone pastes it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "dist-gas");
const built = path.join(dir, "index.html");
const final = path.join(dir, "Index.html");

function fail(message) {
  console.error("build:gas: " + message);
  process.exit(1);
}

if (!fs.existsSync(built)) fail("dist-gas/index.html is missing. Did vite build --mode gas run?");

let html = fs.readFileSync(built, "utf8");
html = html.replace(/\s*<link rel="icon"[^>]*>/, "");

// Self-contained checks: no script or stylesheet loaded from a file, no other files left over.
if (/<script[^>]+\bsrc=/i.test(html)) fail("the page still loads a script from a file.");
if (/<link[^>]+rel="stylesheet"[^>]+href="(?!https:\/\/fonts\.googleapis\.com)/i.test(html)) {
  fail("the page still loads a stylesheet from a file.");
}
if (/["'(]\.?\/?assets\//.test(html)) fail("the page still points at a file in assets/.");

// Write Index.html (via a temporary name, so the rename also works on Macs, whose disks treat
// index.html and Index.html as the same name).
fs.rmSync(built);
const temp = path.join(dir, "Index.tmp.html");
fs.writeFileSync(temp, html);
fs.renameSync(temp, final);

const others = fs.readdirSync(dir).filter((name) => name !== "Index.html");
if (others.length > 0) fail("dist-gas/ should only hold Index.html, but also has: " + others.join(", "));

console.log(`build:gas: dist-gas/Index.html is ready (${Math.round(fs.statSync(final).size / 1024)} KB, one self-contained file).`);
