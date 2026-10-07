import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

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
