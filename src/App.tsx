// App.tsx: the "map" of the music studio website. It decides which page to show based on
// the web address the teacher is visiting. main.tsx starts the site and hands over to this file.
// The site is built with React (a toolkit for building web pages out of reusable pieces
// called "components"). Dashboard, StudentDirectory, and RecapsPage (in src/pages/) are the
// three page-sized components. Every page is wrapped in AppLayout
// (src/components/AppLayout.tsx), which draws the shared header and navigation buttons at the
// top; the chosen page appears underneath it.
// Because the site uses a "hash" address (see main.tsx), the addresses below appear after
// a "#" in the browser, e.g. .../#/students.
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { Dashboard } from "./pages/Dashboard";
import { StudentDirectory } from "./pages/StudentDirectory";
import { RecapsPage } from "./pages/RecapsPage";

// The App component. Given nothing, it gives back the list of addresses ("routes") and the
// page that goes with each one.
export default function App() {
  return (
    <Routes>
      {/* Every page shares the common layout (top bar and navigation). */}
      <Route element={<AppLayout />}>
        {/* The home address shows the Dashboard. */}
        <Route index element={<Dashboard />} />
        {/* "students" shows the student list and profiles. */}
        <Route path="students" element={<StudentDirectory />} />
        {/* "recaps" shows every saved lesson recap. */}
        <Route path="recaps" element={<RecapsPage />} />
        {/* Any other (mistyped or old) address sends the visitor back to the Dashboard. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
