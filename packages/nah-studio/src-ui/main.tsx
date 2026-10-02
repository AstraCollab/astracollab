import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { StudioProvider } from "./store";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    {/* Above the shell, because the agent list is not a view — every view reads it. */}
    <StudioProvider>
      <App />
    </StudioProvider>
  </StrictMode>,
);