# Case B: Music Studio Infrastructure

## Client
Mr. O'Neal (Music Teacher)

## Problem
Lesson materials are scattered. Scheduling requires manual back-and-forth. No centralized system to track individual student progress.

## Goal
Build a **Music Student Profile** experience (roster, inline profiles, schedules from Sheets) with room to grow into scheduling and lesson workflows.

## Planned Features
- Music Student Profile database (instruments, genres, current songs, theory level) backed by Google Forms / Sheets
- Automated scheduling reminders/bookings (future)
- AI auto-tagging for sheet music and materials (e.g., "Intermediate / Jazz / Saxophone") (future)
- AI voice transcription for post-lesson summaries that auto-update student profiles (future)

## Team
| Role | Name |
|------|------|
| Developer | Serena Xu |
| Developer | JT Gannon |
| Club lead | Cayden Auyang |

**Live site:** served by Google with Pomfret sign-in (Mr. O'Neal has the link). The old GitHub Pages address, https://civicaiclub.github.io/case-b-music-studio/, now only shows a "moved" page.

**History:** the early UI work (April 2026: UI shell, live Sheets data, Pomfret styling, form-submission history) was written by Serena on the monorepo branch `case-b/continued-work`; those original commits are preserved under her name on the `archive/serena-continued-work` branch of this repo. Later phases were merged through PRs #8–#24 in the old monorepo.

## Setup from a fresh clone

Prerequisites: Node.js 20 or newer and npm.

```bash
git clone https://github.com/CivicAIClub/case-b-music-studio.git
cd case-b-music-studio
npm ci                        # installs exactly what package-lock.json pins
cp .env.example .env.local    # then fill in the two values (see below)
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). To build a production bundle:

```bash
npm run build
npm run preview   # optional local preview of the build
npm test          # runs apps-script/Code.gs against pretend Google Sheets (made-up data)
npm run build:gas # the Google-hosted page: one file, dist-gas/Index.html (see Hosting on Google)
```

**Data:** The app loads **students and schedules from your Google Apps Script** (see API client comments). Mock data is not used for the live roster.

### Auth (shared secret)

> **Since the Oct 7 handoff this path is switched off in production.** The old public deployment was archived, and the `SHARED_SECRET` and `OAUTH_CLIENT_ID` Script Properties were deleted. So the secret-checked routes (GETs with `&secret=`, every `doPost`) refuse every request, and `npm run dev` can't reach the live script. For live checks, use the Apps Script editor's **test deployment** (**Deploy → Test deployments**, the link ending in `/dev`): it serves the newest saved `Code.gs` and `Index` to editors of the script who are on `ALLOWED_USERS`. The secret-route code stays, in case a public deployment is ever needed again. The rest of this section describes how that path works.

Every POST to the Apps Script web app must carry a `secret` field that matches the `SHARED_SECRET` Script Property. Reads (`GET`: roster with student emails, schedule) must carry the same value as a `secret` query parameter (`?action=list&secret=…`); without it `doGet` replies `{ "error": "Unauthorized" }`. Environment variables the frontend needs (both in `.env.local`, documented in `.env.example`):

| Variable | What it is |
|---|---|
| `VITE_APPS_SCRIPT_BASE_URL` | The web app `/exec` URL (see below) |
| `VITE_APPS_SCRIPT_SHARED_SECRET` | Same value as the `SHARED_SECRET` Script Property. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Vite inlines both values into the built JS, so anyone who opens the deployed site in DevTools can read the secret. That is the documented model for this single-teacher tool: treat the deployed URL as private and don't link it publicly. If the site ever needs to be public, move the secret behind a server-side proxy.

> Pomfret sign-in comes from **[Hosting on Google](#hosting-on-google-pomfret-sign-in-only)**: the same site served by Apps Script, checked against the `ALLOWED_USERS` Script Property, with no shared secret in the page. The older Google Sign-In design (ID tokens checked against an `ALLOWED_USER_EMAILS` list) was never built; nothing reads `VITE_GOOGLE_OAUTH_CLIENT_ID` or `OAUTH_CLIENT_ID` (deleted from Script Properties at the handoff).

#### One-time `/exec` URL setup

*(How the old public deployment was set up. It was archived at the handoff.)*

1. Apps Script editor → **Deploy → New deployment** (or Manage deployments → New version).
   - Type: Web app
   - Execute as: Me (Mr. O'Neal in production; calendar invites use his calendar)
   - Who has access: Anyone
2. Copy the `/exec` URL into `.env.local` → `VITE_APPS_SCRIPT_BASE_URL=<the /exec URL>`.

After any change to `apps-script/Code.gs`, **redeploy a new version** (Manage deployments → ✏️ → New version) so the live URL serves the new code. The `/exec` URL itself stays the same.

**Deploy order for the GET secret check:** deploy the website first (merge to `main` and let the Pages workflow finish), *then* redeploy `Code.gs`. The new site sends `&secret=…` on every GET, which the old `Code.gs` simply ignores, so it keeps working in between. Doing it the other way round leaves the live site unable to load the roster or schedule ("Unauthorized") until the site catches up. Anyone running a local copy needs `VITE_APPS_SCRIPT_SHARED_SECRET` in `.env.local` for reads too.

#### Who gets calendar invites

`ALWAYS_INVITE_EMAILS` in `apps-script/Code.gs` lists the people invited to every lesson event in addition to the student (Mr. O'Neal and Dr. Burns). Edit it, save, redeploy a new version. No frontend change needed.

#### Sheet formatting (one-time)

After updating Code.gs in the editor, select `setupSheetFormatting` from the function dropdown and click ▶ Run. This styles every tab (Form Responses 1, Lesson Schedule, Lesson Recaps, all per-student tabs) with the Pomfret palette and applies warning-only protection to the auto-managed `Status`, `Calendar Event ID` and `Time Sheet` columns (adding the last two if they're missing). Idempotent — safe to re-run.

It also gives three Lesson Schedule columns a dropdown, from row 2 to the bottom. Columns are found by their titles, never by position:

- **Student Email:** every student's email from the roster (*Form Responses 1*), once each, A to Z.
- **Student Name:** every student's name from the roster, once each, A to Z.
- **Lesson Block:** the time sheet's `Block` list, with the same items, order and spelling (`1PM  Shadow Block` keeps its two spaces). If the time sheet can't be opened, a built-in copy of that list is used and the log says why.

All three show the list but only warn about anything else typed in; nothing is refused. Rules on every other column (like the existing `Lesson Date` one) are left alone. The log ends with a line like `Lesson Schedule dropdowns (anything else typed in gets a warning, never refused): Student Email: 12 emails; Student Name: 12 names; Lesson Block: 19 blocks from the time sheet`. Each form sign-up (`onFormSubmit`) refreshes the email and name lists; run `setupSheetFormatting` again if the time sheet's Block list changes.

### Phase 2 — Calendar event creation

The Dashboard now shows a **Pending lessons** card for any row in the `Lesson Schedule` tab whose Status is blank (or `Draft`) **and** has no Calendar Event ID. Each row gets a **Preview & schedule** button that opens a modal showing the proposed event (title, time, attendees, description, target calendar). Confirming creates the event on the teacher's primary Google Calendar via `CalendarApp` and sends invites to:

- the student's email (from the row),
- everyone listed in `ALWAYS_INVITE_EMAILS` in `apps-script/Code.gs` (Mr. O'Neal and Dr. Burns).

The teacher can add or remove attendees inline in the preview modal before confirming — at least one attendee is required.

The Apps Script side writes the resulting event ID into a new `Calendar Event ID` column on the sheet (auto-added on first use) and flips Status to `Scheduled`, which moves the row out of Pending and into Upcoming on the next refresh.

**No additional setup required** beyond the auth config above and a redeploy of `apps-script/Code.gs`. Three new POST actions are exposed:

| Action | Body fields | Effect |
|---|---|---|
| `preview-event` | `studentEmail`, `lessonDate`, `startTime` | Returns event metadata without touching the calendar. |
| `create-event`  | same | Creates the event, writes back the ID, sends invites. Idempotent. |
| `cancel-event`  | same | Deletes the event and clears the row's ID. |

To add a test row from the dashboard's perspective, type a new row in the `Lesson Schedule` tab with **Status left blank** (or set to `Draft`). Refresh the Dashboard — it should appear in Pending.

### Phase 3 — Class Resources (shared Drive folder)

The Dashboard renders a **Class Resources** card backed by a single Google Drive folder. Files dropped into that folder show up on the page; the **Sync student access** button grants viewer permission to every email in `Form Responses 1` so students can open the folder without an extra share request.

**One-time setup (in the Apps Script editor):**

1. Create a folder in Drive (a sub-folder of the studio's shared drive is recommended) and copy the id from its URL — the chunk after `https://drive.google.com/drive/folders/`.
2. Project Settings → Script Properties → Add property
   - Property: `CLASS_RESOURCES_FOLDER_ID`
   - Value: the folder id from step 1.
3. Run the `authorize()` function once from the editor (it now also touches `DriveApp` so Drive's consent dialog appears alongside Calendar's).
4. Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy. The `/exec` URL stays the same.

Two new POST actions are exposed:

| Action | Body fields | Effect |
|---|---|---|
| `list-class-resources` | (none beyond `secret`) | Returns folder metadata and its most-recently-modified children for the dashboard card. |
| `sync-class-resources-access` | (none beyond `secret`) | Grants viewer access on the folder to every roster email + `CLASS_RESOURCES_EXTRA_VIEWERS`. Idempotent — already-authorized emails are skipped, malformed addresses are reported under `errors`. |

**Permission scope:** the script grants **viewer** access only; ownership and edit rights stay with you. Removing a student from the roster does **not** revoke their access — that's a manual step in Drive (intentionally, so the script can never accidentally lock people out of in-progress work). Per-student folders with editor access are coming in Phase 4.

### Phase 4 — Student Resources (per-student Drive folders)

Every enrolled student gets their **own** Drive folder where they have **editor** access (so they can upload recordings, annotated PDFs, etc.) — separate from the read-only Class Resources folder. The folder is rendered inside the student's profile panel on the Students page and is auto-created the first time you open that panel for a given student.

**One-time setup (in the Apps Script editor):**

1. Inside the studio's shared drive (or anywhere else you can manage permissions), create a parent folder that will hold every student's sub-folder — e.g. `Student Resources`. Copy its id from the URL.
2. Project Settings → Script Properties → Add property
   - Property: `STUDENT_RESOURCES_PARENT_FOLDER_ID`
   - Value: the folder id from step 1.
3. Re-run `authorize()` from the editor — already-authorized scopes are reused, but the helper will dereference the new parent id and surface any "wrong folder id" errors right in the execution log.
4. Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy.

Three new POST actions are exposed:

| Action | Body fields | Effect |
|---|---|---|
| `list-student-folder` | `studentEmail` | Ensures the per-student folder exists (creates if missing, grants student editor access), returns folder metadata + immediate children. |
| `ensure-student-folder` | `studentEmail` | Same as above without the file listing — used by the bulk sync. |
| `sync-student-folders` | (none beyond `secret`) | Runs `ensure-student-folder` for every roster email. Reports `created` / `existed` / `errors`. Idempotent. |

**Naming convention:** `{Name} — {email}` if the form has a name, otherwise just `{email}`. Folders auto-rename if a student's display name changes via a re-submission. Folder ids are cached in Script Properties under `STUDENT_FOLDER:<email>` so per-student lookups are O(1) — never edit those by hand.

**Permission scope:** student gets **editor**; you stay owner; `STUDENT_RESOURCES_EXTRA_EDITORS` (empty by default) lets you always-add Dr. Burns / a co-teacher. The script never **lowers** a permission and never deletes a folder, so removing a student from the roster leaves their work intact. Bulk sync is exposed on the Dashboard via a "Sync all student folders" admin card.

### Phase 5 — Teacher recaps

Structured per-lesson recap that the teacher writes after each lesson, displayed both inline under the lesson row on the student's profile **and** on a new top-level **Recaps** tab. Format mirrors the structure Mr. O'Neal asked for:

```
Hi {Name}, {greeting body}

Today we:
{multiline list of what was covered}

HOMEWORK:
{multiline list}

Next Class:
{multiline list}
```

The "Hi {Name}," opener is rendered automatically using the student's roster name; the teacher only types the rest of the greeting.

**Storage:** a new `Lesson Recaps` tab in the same Google Sheet, **auto-created on first save** — no manual setup. Schema:

| Student Email | Student Name | Lesson Date | Start Time | Greeting | Today We | Homework | Next Class | Updated At |
|---|---|---|---|---|---|---|---|---|

Composite key `(Student Email, Lesson Date, Start Time)` — same as Phase 2's calendar key, so a recap binds permanently to a specific lesson instance. Upsert semantics: writing twice updates the same row. Drafts in progress are saved to localStorage so closing the tab mid-compose doesn't lose work.

**No new Script Property required** for Phase 5 — the only deploy step is redeploying `Code.gs` so the four new POST actions are exposed.

| Action | Body fields | Effect |
|---|---|---|
| `get-lesson-recap` | `studentEmail`, `lessonDate`, `startTime` | Returns the recap or `null`. Read-only. |
| `save-lesson-recap` | same + `fields: { greeting, todayWe, homework, nextClass }` | Upserts. Auto-creates the tab on first call. |
| `list-recaps-for-student` | `studentEmail` | All recaps for one student, newest first. |
| `list-recaps` | (none beyond `secret`) | Every recap in the system, newest first. |

**Where to compose / view:**
- **Compose / edit:** Students page → click a student → in their **Recent** lessons list, each row gets a `Write recap` button (or `View recap` / `Edit` if one exists). Compose modal pre-fills `Hi {Name},` automatically and persists drafts to localStorage.
- **Browse all:** new **Recaps** tab in the top nav (`/recaps`) — read-only listing grouped by student, with a name/email filter.

### Phase 6 — Time sheet (payroll)

Mr. O'Neal is paid per private lesson and logs every lesson in a payroll time sheet: a separate Google Sheet that the music director signs off and the business office pays from. Since the handoff, the tool writes to **Mr. O'Neal's own copy** of the time sheet (the "Code Version" copy); `TIMESHEET_SPREADSHEET_ID` points at it. The Dashboard's **Time sheet** card (right after Pending lessons) lists every lesson that has ended since the start date, isn't Cancelled, and isn't on the time sheet yet, oldest first. **Preview** shows the exact row that will be added (with dropdowns for Lesson No., Block, Total Hours and Music Subject, text boxes for the names, and warnings in plain words); **Add to time sheet** appends it and says "Added to 2026-2027, row N". **Skip** (after a confirm) marks a lesson that didn't happen or was already typed in by hand. **Open time sheet** links to the sheet; its address reaches the browser only at runtime, from `timesheet-status`.

**The `2026-2027` tab's layout** (row 1, columns A to J): `Date` | `Lesson No.` | `Student First Name` | `Student Last Name` | `Block` | `Total Hours` | `Music Subject` | `COMPLETED LESSON` (H, a checkbox he ticks) | `Dir. of Music Sign.` (I) | `Paid on paydate` (J). It has no term label rows; rows are filled with a color per pay period, column A is bold, and B, E, F and G have strict ("Reject input") dropdowns. He keeps empty rows ready below the last lesson, each holding only an unticked checkbox. Older tabs (`2025-2026` and before) have no checkbox column, so their H and I are the signature and the pay date.

**What the script writes, and what it never touches**

- **Where a row lands:** right below the last row with anything in columns A to G, ignoring every other column. (Google counts a row holding only an unticked checkbox as used; the tool doesn't, so the ready-made rows fill up in order.) If that row exists, its other columns stay as they are; if the tab ends there, a row is added. Either way the row first gets the format (fill color, bold, date format) and the dropdowns and checkbox of the lesson row above it, across every column of the table, never from the title row.
- It writes **columns A to G only**, in one write: the date (a real date), Lesson No., first name, last name, Block, Total Hours, Music Subject. Values are written as the exact item from the time sheet's lookup lists, with the same type (the number `1`, not the text `"1"`). It never writes H, I or J and never ticks the checkbox. If the landing row already has something past G (a ticked box, a signature), it stops and says which cell to clear, without writing anything.
- It never edits or deletes an existing row, never touches the `(CHAPEL/MISC.)` tabs, and only *reads* the lookup tabs (`Lesson No.`, `Block`, `hours`, `Instrument`) and the `First Name` / `Last Name` tabs.
- Year tabs are matched by exact name. If the school year's tab doesn't exist yet, it is created just before the newest year tab, copying that tab's header row, frozen panes, column widths, and every column's dropdown or checkbox (taken from its newest lesson row). No lesson rows are copied.
- **Term labels follow the tab:** a label row (`Fall 2026`, `Winter 2026-27`, `Spring 2027`) goes above a term's first lesson only on a tab that already has one (text in column A naming Fall, Winter or Spring), and not when a label for that term is already typed below the last lesson. `2026-2027` has none, so it never gets one; neither does a brand-new tab. No week or spacer rows.
- **Over 45 minutes counts as a double:** 1.5 hours and Lesson No. `Double`. 45 minutes or less is 0.75, and so is a lesson with no end time (with a warning). Other lengths get a warning in the preview: over 45 and not 90 says it counts as a double; under 45 suggests **Skip** if it's make-up time for a double already logged. The real length is never written on the time sheet: the preview shows it on its own line (`70-minute lesson, logged as 1.5 hours (a double).`), and the Lesson Schedule's note keeps it.
- Lesson numbers follow the sheet's own count, per student and per term: a number sets the count, `Double` adds 2, and `No Show`, `Late Cancel` or a blank leave it alone. Past the end of the list (lesson 10), the cell is left for him to pick.
- **Saved names:** after each add (not a duplicate), the first name, last name and music subject written are saved for that student in the Script Property `TIMESHEET_STUDENT:<lowercase email>` (JSON). The next preview for that student starts from them, ahead of the sign-up form's name and instrument, and says "Name and subject from your last time sheet row for this student." Values changed in the preview still win, and **Check again** recounts the lesson number for them. If saving fails, the log says so and the add still succeeds.
- Each added or skipped lesson gets a note in an auto-managed **Time Sheet** column on the Lesson Schedule: `Added 10/7/2026`, `Added 10/7/2026 (70 min, logged as 1.5)` when the lesson wasn't 45 or 90 minutes long, or `Skipped`. Any note keeps the lesson off the card. If the same date and student are already on the tab, nothing new is appended; only the note is written, so trying again after a failed call is always safe.

**One-time setup (in the Apps Script editor)**

1. Share the time sheet as **Editor** with the Google account the web app runs as (Deploy → Manage deployments shows it under "Execute as"). Since the handoff that's Mr. O'Neal, and the sheet is his own copy.
2. Project Settings → Script Properties → Add property:
   - `TIMESHEET_SPREADSHEET_ID` = the time sheet's ID. Pasting its whole URL also works: the script takes the part between `/d/` and the next `/`.
   - `TIMESHEET_START_DATE` = the first lesson date to offer, written like `2026-10-07`. Use the day after the last lesson that was typed in by hand: the tool never offers anything earlier.

   Never commit either value. If either is missing, the card says "The time sheet isn't connected yet".
3. Paste the new `Code.gs` (see below), save, and run `authorize()`. Its first log line is `Code version: …`, followed by `OK TIMESHEET_SPREADSHEET_ID: "<sheet title>", tab 2026-2027` and `OK TIMESHEET_START_DATE: <date>`, or a `PROBLEM …` line saying what to fix.
4. Run `setupSheetFormatting()` once. It adds the Time Sheet column, grayed out and warning-protected like Calendar Event ID, and the Lesson Schedule dropdowns.
5. Mr. O'Neal: Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy. The link stays the same. (Only he deploys; see [`docs/handoff.md`](docs/handoff.md#updates).)

**Updating:** `Code.gs` and the page (`Index`) are pasted together, so they always match. The form trigger runs the newly saved `Code.gs` straight away; the site changes only when Mr. O'Neal clicks **New version**.

**Pasting Code.gs:** `scripts/copy-to-apps-script.sh` prints the branch, the last commit, `CODE_VERSION`, the line count and the first 12 characters of the file's SHA-256, then copies `apps-script/Code.gs` to the clipboard (macOS `pbcopy`). Paste it over everything in the editor's `Code.gs`. After deploying, `ping` returns `codeVersion`, so you can confirm which version is live.

| Action | Body fields | Effect |
|---|---|---|
| `timesheet-status` | (none beyond `secret`) | Whether the time sheet is connected (and if not, why, in plain words), its link and title, today's school-year tab, the start date, `codeVersion`, and the dropdown lists. Read-only. |
| `preview-timesheet-row` | `studentEmail`, `lessonDate`, `startTime`, optional `overrides` | The exact A-G row, the tab (and whether it will be created), whether a term label row is added, warnings, `info` notes, and `lengthLine` (the lesson's real length). Read-only. |
| `add-timesheet-row` | same + optional `overrides: { lessonNo, firstName, lastName, block, hours, subject }` | Appends the row (or, if it's already there, only marks the lesson). Returns `{ tab, rowNumber, row, alreadyThere }`. |
| `skip-timesheet-row` | `studentEmail`, `lessonDate`, `startTime` | Marks the lesson `Skipped`. Never touches the time sheet. |

**Strict ("Reject input") dropdowns:** Google's documentation says a rule set to reject input rejects invalid data, but it doesn't say whether that also applies to values a script writes. Doubles (now anything over 45 minutes) are written as 1.5. If 1.5 isn't on the `hours` list and Total Hours rejects other values, Google may refuse the row: the preview pop-up then shows a plain-English message naming the value, and nothing is added or marked. Adding 1.5 to the `hours` tab fixes it.

**Tests:** `npm test` runs `Code.gs` in Node (`node:test` and `node:vm`, no extra packages) against pretend Google Sheets with made-up data: lesson numbering, label rows and text dates, exact tab names, the new-tab path, block and instrument mapping, name splitting, duplicates and retries, the start-date cutoff, and that H, I and J are never written. `tests/post-delivery.test.js` covers the landing row (pre-made checkbox rows, a tab that ends at its last lesson, a ticked box in the way), lesson lengths of 30 to 120 minutes and the marks, term labels following the tab, saved names, the Lesson Schedule dropdowns and `studio-links`. CI runs it on every pull request.

## Hosting on Google (Pomfret sign-in only)

The same website can be served by the Apps Script itself, on a Pomfret-only Google link with Google sign-in, instead of on GitHub Pages with a shared password in the page. This is how Mr. O'Neal runs it after the handoff ([`docs/handoff.md`](docs/handoff.md)), and it works the same way as Case A's AutoPlanner.

**How it works**

- `npm run build:gas` builds the whole site into one self-contained file, `dist-gas/Index.html` (JavaScript, CSS and images inlined; never committed). In this build Vite reads no `VITE_*` values, so the `/exec` URL and the shared secret are never in the page (a test checks this).
- In the Apps Script editor that file is the HTML file **Index**. `doGet` with nothing on the address serves it, titled "Music Studio", to anyone on the `ALLOWED_USERS` Script Property, and a short "no access" page with no data to everyone else. The existing GET routes (`?action=…`, `?email=…`) still need the shared secret and answer exactly as before (checked against recorded answers in `tests/fixtures/get-routes-golden.json`).
- The page talks to the script only through `google.script.run.api(request)`. `api()` checks the signed-in visitor (`Session.getActiveUser()`) against `ALLOWED_USERS` on every call. A blank or unlisted email gets "You don't have access to the Music Studio. Ask Mr. O'Neal.", which the page shows in place of the dashboard. Allowed visitors get exactly what the GET routes and `doPost` return (the same code runs), made safe for `google.script.run` (dates become the same text the GET routes send). No shared secret on this path.
- In the frontend, every request goes through `callAppsScript` in `src/api/appsScriptTransport.ts`: `google.script.run` when it exists, otherwise today's web requests with the secret. So `npm run dev` and the GitHub Pages site keep working.
- **Safety rule (the same as Case A):** a page served by Apps Script can call *any* top-level function whose name doesn't end in `_`. So every function in `Code.gs` ends in `_` except `api`, `doGet`, `doPost`, `authorize` and `setupSheetFormatting` (these two refuse unless run from the editor) and `onFormSubmit` (refuses anything but a real trigger event). A test fails if another one appears. Keep it that way.

- **Header links:** the **📋 Lesson Schedule** and **🧾 Time sheet** pills (and the Dashboard's *Quick links*) come from the `studio-links` action, fetched once per page load: the studio Sheet's address plus `#gid=` and the Lesson Schedule tab's ID, and the time sheet built from `TIMESHEET_SPREADSHEET_ID` (null when it isn't set, and then the link is hidden). No spreadsheet address is kept in the repo. **📝 Form** and **✏️ Edit form** are fixed links in `src/lib/externalLinks.ts`.

| Script Property | What it is |
|---|---|
| `ALLOWED_USERS` | Pomfret emails allowed to use the Google-hosted site, separated by commas (capital letters don't matter). Empty means nobody; `authorize` logs a `PROBLEM` line. |
| `TIMESHEET_STUDENT:<email>` | Written by the tool: how each student was last written on the time sheet (see Phase 6). Safe to delete; the next add writes it again. |

**Deploying it (or a test copy)**

1. `scripts/copy-to-apps-script.sh code`, then paste over everything in `Code.gs`. `scripts/copy-to-apps-script.sh page`, then paste over everything in the HTML file `Index` (create it the first time: **+** next to Files → **HTML** → `Index`). Press ⌘S.
2. Set `ALLOWED_USERS` and run `authorize` (it now also logs `Runs as:` and the `ALLOWED_USERS` list).
3. **Deploy → New deployment → Web app**, **Execute as: Me**, **Who has access: Anyone within Pomfret School**. A new deployment gets its own URL. Existing deployments keep running their own version, so the GitHub Pages site is unaffected until its deployment is archived.
4. After later changes: paste both files again, then **Manage deployments → ✏️** on the Pomfret-only deployment → **New version**.

**Since the handoff (Oct 7, 2026):** the live site is Mr. O'Neal's Pomfret-only deployment. He didn't make a new deployment: he deployed a new version of the existing Pomfret-only test deployment from his own account, so it runs as him and kept its link. Never archive it. **Only he clicks Deploy** (a deploy from another account would make the site run as that account): Cayden pastes both files and saves, then Mr. O'Neal clicks **Deploy → Manage deployments → ✏️ → New version → Deploy** ([`docs/handoff.md`](docs/handoff.md#updates)). The old public deployment was archived and `SHARED_SECRET` and `OAUTH_CLIENT_ID` were deleted, so the GitHub Pages path can't load data, and the Pages site shows a "moved" page.

## App structure (prototype)

- **Dashboard** — roster count, student name search (links to Students with profile open), recent updates and upcoming lessons when APIs succeed.
- **Students** — directory with filters; clicking a student opens an **inline profile panel** (no separate profile URL).

## Deploying to GitHub Pages

Since the handoff, the app is served by Google with Pomfret sign-in, so GitHub Pages only shows a "moved" page. `.github/workflows/deploy-pages.yml` runs on every push to `main` and publishes `pages-moved/index.html` (also as `404.html`, so old links land on it) to the `gh-pages` branch. It no longer builds the app or uses the `VITE_APPS_SCRIPT_*` Actions secrets, which can be deleted. Site: https://civicaiclub.github.io/case-b-music-studio/. `npm run build` still builds the app for local checks (`vite.config.ts` keeps `base` at `/case-b-music-studio/`), and `.github/workflows/ci.yml` still type-checks and builds every pull request with placeholder values.

## Working on this repo

- Branch from `main` as `feature/<short-description>`, `fix/<short-description>`, or `chore/<short-description>` (lowercase, hyphens).
- Every change goes through a pull request with at least one approval. `main` cannot be pushed to directly.
- Never commit secrets. `.env.local` is gitignored; `.env.example` holds only placeholders.
- After changing `apps-script/Code.gs`, bump `CODE_VERSION` near its top and paste it (and the page) with `scripts/copy-to-apps-script.sh code` / `page`. Then Mr. O'Neal deploys a **new version** (only he deploys), or the live site keeps running the old code. Check live changes on the editor's test deployment (`/dev`) first.
- `npm test` and `npm run build` must both pass before you push (CI runs both).
- Cursor rules for this project are committed in `.cursor/rules/`. You do not need to paste anything into your IDE settings.
- The full Git walkthrough for beginners is the club's **[Developer Onboarding Guide](https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md)**.

## Status
🟢 Phases 1–6 shipped: dashboard, inline student profiles, calendar event creation, class and per-student Drive resources, teacher lesson recaps, and the payroll time sheet connection. Handed off on Oct 7, 2026: served by Google with Pomfret sign-in from Mr. O'Neal's deployment ([Hosting on Google](#hosting-on-google-pomfret-sign-in-only), [handoff](docs/handoff.md)); GitHub Pages shows a "moved" page. Post-delivery updates: Lesson Schedule dropdowns, doubles over 45 minutes, the landing row for pre-made rows, and the Lesson Schedule and Time sheet links.

## History

This repository was split out of the club monorepo (`CivicAIClub/Civic-AI-Github-Repository`, `projects/case-b-music-studio/`) on 2026-09-18 with full history preserved.
