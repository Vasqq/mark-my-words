import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter-tight/latin-400.css";
import "@fontsource/inter-tight/latin-500.css";
import "@fontsource/inter-tight/latin-600.css";
import "@fontsource/inter-tight/latin-700.css";
const PerplLiveApp = lazy(() => import("./perpl-ui/LiveApp"));
const PerplApp = lazy(() => import("./perpl-ui/App"));
const mode = new URLSearchParams(window.location.search).get("mode");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {mode === "demo" ? (
      <Suspense fallback={null}>
        <PerplApp />
      </Suspense>
    ) : (
      <Suspense fallback={null}>
        <PerplLiveApp />
      </Suspense>
    )}
  </React.StrictMode>,
);
