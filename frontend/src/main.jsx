import React from "react";
import ReactDOM from "react-dom/client";
import { initializeActiveNetwork } from "./config/contracts";
import "./styles.css";

async function bootstrap() {
  await initializeActiveNetwork();
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
