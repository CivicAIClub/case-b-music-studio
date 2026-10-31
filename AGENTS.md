# Case B: Music Studio

Music Studio gives Mr. O'Neal, Pomfret's music teacher, one place for student profiles, lesson schedules, Drive resources, lesson recaps, and his payroll time sheet. It replaces scattered materials and manual scheduling messages with a shared record of student progress.

## Club workflow

- This is the standalone `CivicAIClub/case-b-music-studio` repo. Paths start at its root. There is no `projects/` folder. The old `Civic-AI-Github-Repository` is archived; do not edit it.
- Our developers are high school students learning to code together. Prefer clear code over clever code. If a developer cannot explain generated code, say so and explain it in plain English.
- Never push to `main`. Work on a branch and open a pull request (PR). A merge needs one approving review. CI type-checks and builds every PR.
- Use `feature/<short-description>`, `fix/<short-description>`, or `chore/<short-description>`, all lowercase with hyphens and no spaces. The old `case-b/` prefix is retired.
- Make small, frequent commits with plain English messages that say what changed, such as "Add Status column", rather than "stuff".
- Never commit secrets. `.env.local` holds the Apps Script URL and shared secret and is gitignored; `.env.example` must contain placeholders only. If a real credential is pasted into a file, stop and tell the developer.
- Use `.github/pull_request_template.md`: explain what changed, how it was tested, and include screenshots for UI changes.
- Never add `Co-authored-by`, `Generated with`, `Made-with`, `Claude-Session`, or any other AI attribution line to commit messages or PR descriptions. When squash merging, delete any such lines GitHub adds to the merge message.
- For Git, branching, PR, or merge conflict questions, use the [Developer Onboarding Guide](https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md), which also covers common fixes and the club repo list. Do not guess.

## Stack and layout

- Developers: Serena Xu and JT Gannon. Club lead: Cayden Auyang. Serena's original April 2026 UI commits are on `archive/serena-continued-work`. Dr. Burns is a co-teacher on calendar invites.
- Use Vite 6, React 18, strict TypeScript with `noUnusedLocals`, and react-router 6 with `HashRouter`. Deep links must stay after `#` because GitHub Pages serves `/404.html` only at the publishing root.
- Entry: `src/main.tsx`; routes: `src/App.tsx`; pages: `src/pages/`; components: `src/components/`; API clients: `src/api/`; helpers: `src/lib/`; shared types: `src/types.ts`; styles: `src/index.css` with the Pomfret palette, Crimson Pro, and Inter.
- The backend is one Apps Script web app, `apps-script/Code.gs`, bound to the studio Sheet. Tabs are `Form Responses 1`, `Lesson Schedule`, `Lesson Recaps`, and one per student.
- GET routes use query parameters (`?action=list`, `?action=schedule-list`, `?email=`). POST routes use `action` in a `text/plain` JSON body for CORS. Keep the endpoint list and body shapes in the `Code.gs` header in sync with new actions.
- Keep `vite.config.ts` base equal to `/<repo-name>/`, here `/case-b-music-studio/`, for `npm run build`. GitHub Pages now publishes only a "moved" page.

## Access and data rules

- The old web path uses `secret` in every POST body and `&secret=` in every GET, checked against Script Property `SHARED_SECRET` by `isValidSecret_`. Keep this code, but the old public deployment is archived and production `SHARED_SECRET` and `OAUTH_CLIENT_ID` were deleted, so these requests are refused.
- `npm run dev` cannot reach the live script. Use the Apps Script editor's test deployment (`/dev`) for live checks.
- The live site is Mr. O'Neal's Pomfret-only Google deployment. `npm run build:gas` makes one self-contained `dist-gas/Index.html` with no `VITE_*` values. Paste it into the Apps Script HTML file `Index`.
- `doGet` without parameters serves the page to `ALLOWED_USERS`. Each `google.script.run.api(request)` call checks `Session.getActiveUser()` against that list, then uses `readRoute_` or `runPostAction_`. All frontend requests go through `callAppsScript` in `src/api/appsScriptTransport.ts`, which chooses the transport.
- Every `Code.gs` function must end in `_`, except `doGet`, `doPost`, `api`, `authorize`, `setupSheetFormatting`, and `onFormSubmit`. `authorize` and `setupSheetFormatting` must use `requireEditorRun_`; `onFormSubmit` must accept real trigger events only. Never add a public function without a caller check. A test enforces this.
- Local env names are `VITE_APPS_SCRIPT_BASE_URL` and `VITE_APPS_SCRIPT_SHARED_SECRET`, typed in `src/vite-env.d.ts`. Vite exposes them in web builds, so keep that URL private; a public site needs a server-side proxy. The Google-hosted page has no shared secret.
- Script Properties: `MUSIC_STUDIO_SPREADSHEET_ID`, `CLASS_RESOURCES_FOLDER_ID`, `STUDENT_RESOURCES_PARENT_FOLDER_ID`, cached `STUDENT_FOLDER:<email>` IDs, and `ALLOWED_USERS`.
- Payroll properties: `TIMESHEET_SPREADSHEET_ID` (Mr. O'Neal's own copy, ID or URL), `TIMESHEET_START_DATE` (`yyyy-MM-dd`, never offer earlier lessons), and saved spellings in `TIMESHEET_STUDENT:<email>` JSON. `SHARED_SECRET` is only for the old path.
- Never commit any property values or a spreadsheet link. Fetch Lesson Schedule and time sheet links at runtime from `studio-links`. Do not manually edit cached `STUDENT_FOLDER:<email>` IDs.
- New env names go in `.env.example` with placeholders and comments, `src/vite-env.d.ts`, the README table, and both workflows.
- Do not commit `dist/`, `dist-gas/`, `node_modules/`, or `.env.local`.
- Class Resources sync grants viewer access; per-student folders grant editor access. Never lower a Drive permission or delete a folder. Removing a student does not revoke their access or remove their work.

## Lesson and payroll rules

- Keep roster and inline profiles from Sheets. Calendar actions are `preview-event`, `create-event`, and `cancel-event`; creation writes `Calendar Event ID` and changes Status to `Scheduled`. Show the event preview before the teacher confirms scheduling.
- Recaps live in `Lesson Recaps`, keyed by student email, lesson date, and start time. Save drafts in localStorage.
- The payroll actions are `timesheet-status`, `preview-timesheet-row`, `add-timesheet-row`, and `skip-timesheet-row`, shown in the Dashboard's Time sheet card.
- Write only A-G of new time sheet rows. Never write H/I/J, tick `COMPLETED LESSON`, edit or delete existing rows, or change CHAPEL/MISC. or lookup tabs.
- Place a new row below the last row with anything in A-G. A prepared row with only an unticked checkbox counts as empty. Copy the format and dropdowns from the lesson row above. If the landing row has data after G, stop without writing.
- Over 45 minutes means 1.5 hours and Lesson No. `Double`. Only add term labels to tabs that already have them. Remember each student's spelling.
- Mark the Lesson Schedule's auto-managed `Time Sheet` column, for example `Added 10/7/2026 (70 min, logged as 1.5)`. Keep retries safe: a duplicate must not add another payroll row.
- Keep warning-only Lesson Schedule dropdowns for Student Email, Student Name, and Lesson Block. `setupSheetFormatting` sets them; `onFormSubmit` refreshes them. Keep `studio-links` for header links.
- Automated reminders, AI sheet-music tags, and voice-transcribed recaps are future ideas, not shipped features.

## Setup, checks, and updates

Use Node.js 20 or newer and npm. From a fresh clone:

```sh
git clone https://github.com/CivicAIClub/case-b-music-studio.git
cd case-b-music-studio
npm ci
cp .env.example .env.local
npm run dev
```

Open Vite's printed URL, usually `http://localhost:5173`. The two local env values are for a separate secret-path setup; they cannot restore access to the retired live path. See the README for Apps Script folder, calendar, and time sheet setup.

```sh
npm test
npm run build
npm run build:gas
npm run preview
scripts/copy-to-apps-script.sh code
scripts/copy-to-apps-script.sh page
```

- `npm test`, `npm run build`, and `npm run build:gas` must pass before pushing. Preview is optional. The build runs `tsc --noEmit` first; unused variables fail it.
- Tests use `node:test`, `node:vm`, and made-up Google Sheets data in `tests/helpers/`. They compare GET routes against `tests/fixtures/get-routes-golden.json` and build the Google page.
- For setup, set `ALLOWED_USERS` and the required Script Properties in the Apps Script editor; run `authorize` and `setupSheetFormatting`. For the time sheet, share Mr. O'Neal's own copy as Editor with the account the app runs as and set its start date after the last lesson entered by hand.
- For any `Code.gs` change, bump `CODE_VERSION`. Paste matching `Code.gs` and `Index` together with the copy commands and save. The form trigger uses saved code immediately, so keep the files in sync.
- Only Mr. O'Neal may deploy the live app: Deploy > Manage deployments > Edit > New version. Another person's deployment would run as that person. Never archive his deployment. Remind the developer that the live site keeps its old version until he deploys.

## Beginner quick start

Full guide: https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md

1. First time: check Git with `git --version`, set your Git name and GitHub email, accept the club invite, and sign in with GitHub Desktop or `gh auth login`. Clone only your project's repo, open its folder, and read its README setup steps.
2. Start each work session from the latest main, then make a branch:

```sh
git checkout main
git pull origin main
git checkout -b feature/short-description
# Make and check your changes before continuing.
git status
git add .
git commit -m "Describe your change"
git push --set-upstream origin feature/short-description
```

Use `feature/`, `fix/`, or `chore/` as appropriate, with lowercase names and hyphens. Commit small working pieces; do not edit or push main directly.
3. Open a PR on GitHub, fill in the template, and get someone else's approval and passing checks where CI exists. Push review fixes to the same branch. After it is merged, pull main again before starting another branch.
4. If stuck, ask in the case chat, then Keke, then Luke or Cayden. Ask before doing anything drastic.

## Sources

- `README.md`: purpose, setup, shipped phases, data handling, and Google hosting.
- `.cursor/rules/civic-ai-workflow.mdc`: club workflow and where to find help.
- `.cursor/rules/commit-messages.mdc`: commit, PR, and squash merge message rules.
- `.cursor/rules/case-b-music-studio.mdc`: stack, access, data, deployment, and payroll rules.
- Beginner quick start: `developer-onboarding.md` in the `CivicAIClub/docs` repository, linked above.
