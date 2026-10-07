# Music Studio: handoff

For Mr. O'Neal. The handoff was done on **October 7, 2026**, at your laptop, signed in to your **Pomfret Google account**, with Cayden. This page says how your site is set up, how updates work, and what was done that day.

## Your live site

The Music Studio runs from the studio Sheet's script (*Student Music instrument info* → **Extensions → Apps Script**), on its **Pomfret-only deployment** (*Execute as: Me*, *Who has access: Anyone within Pomfret School*).

On October 7 you didn't make a new deployment. You deployed a **new version of the existing Pomfret-only test deployment** from your own account. So it runs as you (your calendar, your Drive, your copy of the time sheet), and it kept its link.

**This deployment is your live site. Never archive it.** Archiving it switches the Music Studio off, and a replacement would have a different link.

## Updates

When Cayden has a new version of the Music Studio:

1. **Cayden** pastes the new code into the editor (`Code.gs` and the HTML file `Index`), saves, and runs anything the update needs (like `authorize` or `setupSheetFormatting`). **Cayden never deploys:** a deploy from his account would make the site run as him.
2. **You** click **Deploy → Manage deployments**, select the Pomfret-only deployment, click the **pencil** (✏️), choose **Version: New version**, and click **Deploy**. The link stays the same.

Until you click **New version**, the site keeps running the version before. (The sign-up form's trigger is different: it runs the newest saved code as soon as Cayden saves.)

## The October 7 checklist

The steps done that day, in order. Step 4 is how the deployment actually went.

1. **Open the script.** Open the studio Sheet, then **Extensions → Apps Script**. The editor opens in a new tab, with two files on the left: `Code.gs` and `Index`.

2. **Run `authorize` and allow it.** In the function list at the top, choose **authorize**, click **Run**, then **Review permissions**, pick your Pomfret account, and click **Allow**. The *Execution log* at the bottom shows:
   - `Code version: …` (the version pasted in; `2026-10-07 google hosting` on the day)
   - `Runs as:` your Pomfret email
   - `Class Resources:` and `Student Resources parent:` followed by **folder names**.

3. **Script Properties.** In **Project Settings** (the gear on the left) → **Script Properties**, set:
   - `ALLOWED_USERS`: the people who may use the website, as emails separated by commas. **Your own email must be on the list**, or you'd be locked out too.
   - `TIMESHEET_SPREADSHEET_ID`: **your copy of the time sheet** (the "Code Version" copy). The tool writes finished lessons there.
   - `TIMESHEET_START_DATE`: the day after the last lesson typed into the time sheet by hand, written like `2026-10-08`. The website never offers anything earlier.

   Run `authorize` again: those lines should start with `OK`.

4. **Deploy, as you.** Not a new deployment: **Deploy → Manage deployments**, the existing **Pomfret-only test deployment**, **pencil** (✏️), **Version: New version**, **Deploy**, from your account. From then on it runs as you and keeps its link (see *Your live site*).

5. **Switch off the old website.** In **Deploy → Manage deployments**, the **old** deployment (the one open to *Anyone*) was archived. The old GitHub Pages website can't load any data now, and its address shows a "moved" page.

6. **Delete the old settings.** In **Project Settings → Script Properties**, `SHARED_SECRET` and `OAUTH_CLIENT_ID` were deleted. Only the old website used them.

7. **Try it for real.** Open your link, add one real lesson from the **Time sheet** card, and check the new row on your time sheet: the right tab and date, and nothing written past column G.

8. **Later (Cayden, not at the meeting):**
   - Transfers the *Class Resources* and *Student Resources* Drive folders (and the student folders inside) to Mr. O'Neal.
   - Removes his test student: his row in *Form Responses 1*, his own tab, and his test rows in *Lesson Schedule*.
   - Knows that lessons put on the calendar before the handoff stay on **Cayden's** calendar. Cancelling one of those from the website marks it Cancelled on the Sheet but can't delete the event from Cayden's calendar, so Cayden deletes it by hand.

**If something looks wrong**, ask Cayden. Never archive your Pomfret-only deployment to fix it.
