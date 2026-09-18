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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);
