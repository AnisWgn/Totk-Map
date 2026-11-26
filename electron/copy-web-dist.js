import cp from "node:child_process";
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

let version = "1.0.0";
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (pkg.version) version = pkg.version;
} catch {}

let commitSha = process.env.GITHUB_SHA || "";
if (!commitSha) {
  try {
    commitSha = cp
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
      .trim();
  } catch {}
}

const buildInfo = {
  version,
  commitSha,
  repository: process.env.HYRULESYNC_REPO || "AnisWgn/Totk-Map",
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(
  path.join(destDir, "build-info.json"),
  JSON.stringify(buildInfo, null, 2),
  "utf8",
);

console.log(
  `Prepared web bundle for Electron in ${destDir} (v${version}${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ""})`,
);
