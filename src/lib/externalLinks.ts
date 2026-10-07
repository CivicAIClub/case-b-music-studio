// In plain English: the Google links in the site's header and in the Dashboard's "Quick links"
// card. Both read them from useExternalLinks() below, so they always match:
//   - Lesson Schedule: the studio Sheet, opened on its Lesson Schedule tab (where lessons are added),
//   - Time sheet:      the payroll time sheet the tool writes to (Mr. O'Neal's copy),
//   - Form:            the sign-up form's public link, to share with students,
//   - Edit form:       the form's editor, for the teacher.
// The two spreadsheet links are never written in this repo: the Apps Script sends them when the
// page opens (the "studio-links" request, made once and shared). A link it doesn't send, like the
// time sheet before it's connected, isn't shown.
import { useEffect, useState } from "react";
import { getStudioLinks, type StudioLinks } from "../api/appsScriptStudioLinks";

export type ExternalLinkKey = "lessonSchedule" | "timesheet" | "studentForm" | "editForm";

export type ExternalLink = {
  key: ExternalLinkKey;
  /** The full name, shown on the Dashboard and as the header pill's tooltip. */
  label: string;
  /** The short name on the header pill. */
  shortLabel: string;
  description: string;
  href: string;
};

/** The emoji in front of each header pill (decorative, so screen readers skip it). */
export const EXTERNAL_LINK_EMOJI: Record<ExternalLinkKey, string> = {
  lessonSchedule: "📋",
  timesheet: "🧾",
  studentForm: "📝",
  editForm: "✏️",
};

/** Order used for both the header pills and the Dashboard list. */
const EXTERNAL_LINK_ORDER: ExternalLinkKey[] = ["lessonSchedule", "timesheet", "studentForm", "editForm"];

// What each link says (where it goes is filled in by useExternalLinks).
const EXTERNAL_LINK_TEXT: Record<ExternalLinkKey, Omit<ExternalLink, "key" | "href">> = {
  lessonSchedule: { label: "Lesson Schedule", shortLabel: "Lesson Schedule", description: "Where you add lessons" },
  timesheet: { label: "Time sheet", shortLabel: "Time sheet", description: "Your copy, where finished lessons go" },
  studentForm: { label: "Student sign-up form", shortLabel: "Form", description: "Public link to share with students" },
  editForm: { label: "Edit form questions", shortLabel: "Edit form", description: "Teacher-only Google Forms editor" },
};

// The sign-up form's two links never change, so they live here.
const FORM_LINKS = {
  studentForm: "https://docs.google.com/forms/d/e/1FAIpQLSfoJXjw5W8hH4grRfy9rUFVPmafU-_GH3Z4K8vBIN2ayz1fXw/viewform",
  editForm: "https://docs.google.com/forms/d/17D6ohIyOseo9Y5bkypZ7qvoThLaDqxNOEyskwZy5OYw/edit",
};

const NO_STUDIO_LINKS: StudioLinks = { lessonScheduleUrl: null, timesheetUrl: null };

// The "studio-links" request, made once per page load and shared by the header and the
// Dashboard. If it fails (for example, someone not on ALLOWED_USERS), the two links stay hidden.
let studioLinksRequest: Promise<StudioLinks> | null = null;
let studioLinksLoaded: StudioLinks | null = null;

function loadStudioLinksOnce(): Promise<StudioLinks> {
  if (!studioLinksRequest) {
    studioLinksRequest = getStudioLinks()
      .catch(() => NO_STUDIO_LINKS)
      .then((links) => {
        studioLinksLoaded = links;
        return links;
      });
  }
  return studioLinksRequest;
}

// For the header and the Dashboard: the links to show, in order. The two spreadsheet links
// appear once the script has sent them.
export function useExternalLinks(): ExternalLink[] {
  const [studio, setStudio] = useState<StudioLinks>(studioLinksLoaded ?? NO_STUDIO_LINKS);
  useEffect(() => {
    let active = true;
    void loadStudioLinksOnce().then((links) => {
      if (active) setStudio(links);
    });
    return () => {
      active = false;
    };
  }, []);
  const hrefs: Record<ExternalLinkKey, string | null> = {
    lessonSchedule: studio.lessonScheduleUrl,
    timesheet: studio.timesheetUrl,
    studentForm: FORM_LINKS.studentForm,
    editForm: FORM_LINKS.editForm,
  };
  return EXTERNAL_LINK_ORDER.flatMap((key) => {
    const href = hrefs[key];
    return href ? [{ key, href, ...EXTERNAL_LINK_TEXT[key] }] : [];
  });
}
