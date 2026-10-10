import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { locale, t } from "./i18n";
import "./theme.css";
import "./styles.css";

// The page speaks the chosen language: its lang (fonts, screen readers) and the tab title.
document.documentElement.lang = locale;
document.title = t.app.brand.name;

// The theme the app starts in (MainApp's own first choice), set before the first paint:
// the loading screen then matches the page that came before it, with no flash between.
document.documentElement.dataset.theme ??= matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
