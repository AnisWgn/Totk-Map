import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, ".local", "build", "web");
const destDir = path.join(root, "web-dist");

if (!fs.existsSync(srcDir)) {
  throw new Error(
    "Missing compiled web directory (.local/build/web). Run `npm run build` first.",
  );
}

fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });
console.log(`Prepared web bundle for Electron in ${destDir}`);
