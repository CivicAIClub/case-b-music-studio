# Music Studio: handoff checklist

For Mr. O'Neal, at your own laptop, signed in to your **Pomfret Google account** (use a browser window signed in to only that account). Cayden sits with you. It takes about 20 minutes. The old website keeps working until step 6, so nothing breaks while you go.

**Before you start:** you need edit access to the studio Sheet (*Student Music instrument info*) and to your real payroll time sheet.

1. **Open the script.** Open the studio Sheet, then **Extensions → Apps Script**. The editor opens in a new tab, with two files on the left: `Code.gs` and `Index`.

2. **Run `authorize` and allow it.** In the function list at the top, choose **authorize**, click **Run**, then **Review permissions**, pick your Pomfret account, and click **Allow**. The *Execution log* at the bottom should show:
   - `Code version: 2026-10-07 google hosting`
   - `Runs as:` your Pomfret email
   - `Class Resources:` and `Student Resources parent:` followed by **folder names**. If either says `(error: …)` or `(not configured)`, stop here: Cayden shares that folder with you as Editor, then run `authorize` again.
   - `ALLOWED_USERS` and the two `TIMESHEET_…` lines may say `PROBLEM` for now. Step 3 fixes them.

3. **Script Properties.** Click **Project Settings** (the gear on the left), scroll to **Script Properties**, click **Edit script properties**, and set:
   - `ALLOWED_USERS`: the people who may use the website, as emails separated by commas. You decide. Suggested: `roneal@pomfret.org, rburns@pomfret.org, cauyang.27@pomfret.org`. **Your own email must be on the list**, or you'll be locked out too.
   - `TIMESHEET_SPREADSHEET_ID`: your **real** time sheet. Paste its whole web address.
   - `TIMESHEET_START_DATE`: the day after the last lesson you typed into the time sheet by hand, written like `2026-10-08`. The website never offers anything earlier.

   Click **Save script properties**, then run `authorize` again: those three lines should now start with `OK`.

4. **Deploy your own copy.** Click **Deploy → New deployment**, click the gear next to *Select type*, and choose **Web app**. Set **Execute as: Me** (your email) and **Who has access: Anyone within Pomfret School**, then click **Deploy** (and **Authorize access** if asked). Copy the **Web app URL**, open it, check the Dashboard loads, and **bookmark it**. This is the Music Studio from now on.

5. **The sign-up form trigger.** Click **Triggers** (the alarm clock on the left), then **+ Add Trigger**: function `onFormSubmit`, deployment **Head**, event source **From spreadsheet**, event type **On form submit**. Click **Save** and allow it. Then Cayden deletes **his own** `onFormSubmit` trigger from his account (each person only sees their own triggers). With two, every sign-up would be copied twice.

6. **Switch off the old website.** Click **Deploy → Manage deployments**, select the **old** deployment (the one open to *Anyone*, not your new one), and click **Archive**. The old GitHub Pages website can't load any data after this. If you can't archive it, Cayden does it from his account.

7. **Delete the old password.** In **Project Settings → Script Properties**, delete `SHARED_SECRET`. Only the old website used it.

8. **Try it for real.** Open your new link, add one real lesson from the **Time sheet** card, and check the new row on your real time sheet: the right tab and date, columns H and I left blank.

9. **Later (Cayden, not at the meeting):**
   - Transfers the *Class Resources* and *Student Resources* Drive folders (and the student folders inside) to Mr. O'Neal.
   - Removes his test student: his row in *Form Responses 1*, his own tab, and his test rows in *Lesson Schedule*.
   - Knows that lessons put on the calendar before today stay on **Cayden's** calendar. Cancelling one of those from the new website marks it Cancelled on the Sheet but can't delete the event from Cayden's calendar, so Cayden deletes it by hand.

**If something looks wrong at any step**, stop and ask Cayden. Until step 6 the old website still works, so you can keep using it.
