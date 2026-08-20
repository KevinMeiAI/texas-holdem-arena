import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { UiPreferencesProvider } from "./ui-preferences";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/cormorant-garamond/latin-500.css";
import "@fontsource/cormorant-garamond/latin-500-italic.css";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "./styles.css";
import "./hand-fork-admin.css";
import "./decision-branch-page.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <UiPreferencesProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </UiPreferencesProvider>
  </StrictMode>,
);
