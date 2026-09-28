import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("acpx chat root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
