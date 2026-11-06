import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ClawpageSignIn } from "./components/ClawpageSignIn";
import { locale, t } from "./i18n";
import "./theme.css";
import "./styles.css";

// The page speaks the chosen language: its lang (fonts, screen readers), the tab title and the home-screen name.
document.documentElement.lang = locale;
document.title = t.app.brand.name;
document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", t.app.brand.name);

// The theme the app starts in (MainApp's own first choice), set before the first paint:
// the loading screen then matches the page that came before it, with no flash between.
document.documentElement.dataset.theme ??= matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

// The worker opens the console from the last page that loaded, fast and without a network (public/sw.js),
// and keeps the deployed one for next time. Not in dev, where the page is rebuilt on every change.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined));
}

// A part loaded on first use (diagrams, charts, video) that the server no longer has: the console is
// from a build older than the one deployed since. Load the current one, at most once in a while, so a
// file that is really missing cannot reload the page over and over.
addEventListener("vite:preloadError", (event) => {
  const KEY = "aio-reloaded-for-build";
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) || 0) < 5 * 60_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  <StrictMode>
    {/* Signing in to a clawpage stands apart from the console: no account address, no task inbox. */}
    {location.pathname === "/clawpage-sso" ? <ClawpageSignIn /> : <App />}
  </StrictMode>,
);
