import { useCallback, useEffect, useState } from "react";

/** Owner debug mode: a per-browser switch, kept in localStorage and shared by every view on the page. */
const KEY = "aio.debug";
const EVENT = "aio-debug-change";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useDebugMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  const set = useCallback((value: boolean) => {
    try {
      if (value) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch { /* storage unavailable: the switch lasts for this page only */ }
    setOn(value);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, set];
}
