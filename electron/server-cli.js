#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBackend } from "./backend/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

let homeDir = process.env.HYRULESYNC_HOME || appRoot;
let previewPort = 0;
let previewMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--home" && i < args.length - 1) {
    homeDir = path.resolve(args[++i]);
  } else if (args[i] === "--preview-port" && i < args.length - 1) {
    previewPort = Number(args[++i]);
    previewMode = true;
  }
}

let shuttingDown = false;
const backend = createBackend({
  appRoot,
  homeDir,
  args,
  preferredPort: previewMode ? previewPort : 0,
  previewMode,
  enablePageLifetimeExit: !previewMode,
  onShouldExit: () => shutdown(0),
});

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await backend.stop();
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

backend
  .start()
  .then(({ url }) => {
    if (previewMode) {
      console.log(
        `HyruleSync server listening on http://0.0.0.0:${backend.port}/`,
      );
    } else if (!args.includes("--quiet")) {
      console.log(`HyruleSync server ready at ${url}`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
