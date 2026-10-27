import { createRoot } from "react-dom/client";
import "./theme.css";
import "./measure.css";

// VITE_HOSTED=1 is the Base44 build; the Shell (and the SDK) load only then. Without it: the page the engine serves.
const root = createRoot(document.getElementById("root")!);
if (import.meta.env.VITE_HOSTED === "1") import("./Shell").then((m) => root.render(<m.Shell />));
else import("./App").then((m) => root.render(<m.App />));
