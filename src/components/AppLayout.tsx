// AppLayout.tsx: the frame around every page: the school header, the navigation buttons, and
// the page itself underneath. The header's link pills (Lesson Schedule, Time sheet, Form, Edit
// form) come from src/lib/externalLinks.ts. On the Pomfret-only Google link, if the Apps Script
// says this visitor isn't on its list of allowed people, the frame shows that message instead of
// the page.
import { NavLink, Outlet } from "react-router-dom";
import { SchoolBrandMark } from "./SchoolBrandMark";
import { useAccessDeniedMessage } from "../lib/accessDenied";
import { EXTERNAL_LINK_EMOJI, useExternalLinks } from "../lib/externalLinks";

function navPillClassName({ isActive }: { isActive: boolean }) {
  return isActive ? "nav-pill nav-pill--active" : "nav-pill";
}

export function AppLayout() {
  // Set once the script answers "you don't have access" (see src/lib/accessDenied.ts).
  const accessDenied = useAccessDeniedMessage();
  // The header's link pills; the two spreadsheet links appear once the script has sent them.
  const links = useExternalLinks();
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <header className="app-top">
        <div className="app-top__row">
          <div className="app-top__brand">
            <SchoolBrandMark variant="compact" className="app-top__crest" />
            <div className="app-top__brand-text">
              <span className="app-top__title">Pomfret School</span>
              <span className="app-top__subtitle">Music studio</span>
            </div>
          </div>
          <nav className="app-top__nav" aria-label="Main navigation">
            <NavLink to="/" end className={navPillClassName}>
              <span aria-hidden="true">🎵</span>&nbsp;Dashboard
            </NavLink>
            <NavLink to="/students" className={navPillClassName}>
              <span aria-hidden="true">🎸</span>&nbsp;Students
            </NavLink>
            <NavLink to="/recaps" className={navPillClassName}>
              <span aria-hidden="true">✏️</span>&nbsp;Recaps
            </NavLink>
            <span
              className="app-top__nav-divider"
              aria-hidden="true"
              role="presentation"
            />
            {links.map((link) => (
              <a
                key={link.key}
                className="nav-pill nav-pill--external"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                title={link.label}
                aria-label={`${link.label} (opens in a new tab)`}
              >
                <span aria-hidden="true">{EXTERNAL_LINK_EMOJI[link.key]}</span>&nbsp;{link.shortLabel}
                <span className="nav-pill__external-icon" aria-hidden="true">
                  ↗
                </span>
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main id="main-content" className="main" tabIndex={-1}>
        <div className="main__body">
          {accessDenied ? (
            <section className="card access-denied" role="alert" aria-labelledby="access-denied-h">
              <h1 id="access-denied-h" className="access-denied__title">
                No access
              </h1>
              <p className="access-denied__message">{accessDenied}</p>
              <p className="muted">
                Signed in to more than one Google account? Open the Music Studio in a browser
                window signed in only to your Pomfret account.
              </p>
            </section>
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}
