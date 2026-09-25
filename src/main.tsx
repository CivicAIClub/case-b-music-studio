// main.tsx: the starting point of the music studio website. When a browser opens the site,
// this is the first of our code to run. Its one job is to find the empty spot on the web page
// (an element named "root" in index.html) and draw the whole app into it.
// The site is built with React (a toolkit for building web pages out of reusable pieces
// called "components"). The top-level component, App (in App.tsx), decides which page to
// show. The site's shared look (colors, fonts, spacing) comes from index.css.
// Bring in React's drawing tools, the page-address "router" (which picks the page to show
// based on the web address), our App, and the site-wide styles.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// HashRouter (not BrowserRouter) because GitHub Pages only honors
// `/404.html` at the publishing root, not at project-site roots like
// /case-b-music-studio/. A BrowserRouter deep link such as
// /case-b-music-studio/students refreshes
// into a real 404 since there's no `students` file on the server.
// HashRouter sidesteps this by encoding the route after `#`, so every
// URL resolves to /case-b-music-studio/index.html and the router parses
// the hash client-side. Cosmetic cost: URLs read like
// /case-b-music-studio/#/students.

// Draw the app into the "root" spot on the page. The "!" tells TypeScript (the checked
// version of JavaScript this site is written in) that we are sure that spot exists.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* StrictMode: an extra safety check, only while developing, that warns about mistakes. */}
    <HashRouter>
      {/* HashRouter (explained above) reads the page address after the "#" sign. */}
      <App />
    </HashRouter>
  </StrictMode>
);
