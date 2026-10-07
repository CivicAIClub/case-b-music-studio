// In plain English: when the website is opened from the Google (Pomfret-only) link, the Apps
// Script checks every request against its list of allowed people (ALLOWED_USERS). If it says
// "you don't have access", this file passes that message to the page's frame (AppLayout.tsx),
// which then shows the message in place of the dashboard, so the visitor isn't left looking at
// a row of separate error boxes.
import { useEffect, useState } from "react";

const EVENT_NAME = "music-studio:access-denied";
// The last message, kept in case it arrives before the page frame starts listening.
let lastMessage: string | null = null;

// Called by appsScriptTransport.ts when the script answers "you don't have access".
export function reportAccessDenied(message: string): void {
  lastMessage = message;
  window.dispatchEvent(new CustomEvent<string>(EVENT_NAME, { detail: message }));
}

// For the page frame: gives back the "no access" message once one has arrived, or null.
export function useAccessDeniedMessage(): string | null {
  const [message, setMessage] = useState<string | null>(lastMessage);
  useEffect(() => {
    const onDenied = (e: Event) => setMessage((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT_NAME, onDenied);
    // Catch a message that arrived between the first draw and this listener starting.
    if (lastMessage) setMessage(lastMessage);
    return () => window.removeEventListener(EVENT_NAME, onDenied);
  }, []);
  return message;
}
