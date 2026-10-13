import { useEffect } from "react";
import { useDemoEngine } from "./engine/demo";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import ReferenceView from "./view/ReferenceView";
import "@fontsource/inter-tight/latin-800.css";
import "./styles/perpl.css";
export default function PerplApp() {
  const engine = useDemoEngine();
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Mark My Words";
    return () => {
      document.title = previousTitle;
    };
  }, []);
  return <ReferenceView engine={engine} />;
}
