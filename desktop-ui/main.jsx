import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import WorkspaceEntry from "./WorkspaceEntry.jsx";
import { createHubClient } from "./hub-client.mjs";
import "./styles.css";
import { Agentation as DevelopmentAgentation } from "agentation";

const Agentation = import.meta.env.MODE === "development" ? DevelopmentAgentation : null;

function consumeConnection() {
  const key = "__AYLACHI_CONNECTION__";
  if (!Object.prototype.hasOwnProperty.call(globalThis, key)) return { client: null, bootstrapError: "Not connected. Start Aylachi through its trusted Hub connection to use chats." };
  let config;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || (!descriptor.writable && !descriptor.configurable)) throw new Error("INVALID_BOOTSTRAP");
    config = descriptor.value;
    if (descriptor.writable) Reflect.set(globalThis, key, undefined);
    if (descriptor.configurable) Reflect.deleteProperty(globalThis, key);
    if (globalThis[key] !== undefined) throw new Error("BOOTSTRAP_RETAINED");
    if (!config || typeof config !== "object" || typeof config.baseUrl !== "string" || typeof config.bearer !== "string") {
      throw new Error("INVALID_BOOTSTRAP");
    }
    return { client: createHubClient(config), bootstrapError: "" };
  } catch {
    return { client: null, bootstrapError: "Connection configuration invalid. Check native connection setup." };
  } finally {
    config = undefined;
  }
}

const connection = consumeConnection();
const root = createRoot(document.getElementById("root"));
root.render(<>
  {connection.client
    ? <WorkspaceEntry client={connection.client} canvasId="fixture" />
    : <App {...connection} cards={[]} />}
  {Agentation && <Agentation appName="Aylachi DEV" />}
</>);
