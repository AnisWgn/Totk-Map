import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const READY_DIR_PATTERN = /^ready-[0-9]{10}$/;

export function enumerateSaveFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "progress.sav") {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// Recomp can leave a completed transaction in save-tx/ready-* while a lock prevents
// replacing save/<account>. Never follow the mutable save-tx/work directory.
export function resolveSaveFolder(source) {
  const resolved = path.resolve(source);
  const accountName = path.basename(resolved);
  const savesDir = path.dirname(resolved);
  if (!savesDir || path.basename(savesDir) !== "save") return resolved;

  const profileDir = path.dirname(savesDir);
  if (!profileDir || profileDir === savesDir) return resolved;

  const uidPath = path.join(profileDir, "account.uid");
  if (!fs.existsSync(uidPath)) return resolved;

  let uid;
  try {
    uid = fs.readFileSync(uidPath);
  } catch {
    return resolved;
  }
  if (uid.length !== 16) return resolved;

  const activeAccount =
    uid.readBigUInt64LE(8).toString(16).padStart(16, "0") +
    uid.readBigUInt64LE(0).toString(16).padStart(16, "0");
  if (accountName.toLowerCase() !== activeAccount.toLowerCase()) {
    return resolved;
  }

  const transactionsDir = path.join(profileDir, "save-tx");
  if (!fs.existsSync(transactionsDir)) return resolved;

  let readyDirs;
  try {
    readyDirs = fs
      .readdirSync(transactionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && READY_DIR_PATTERN.test(d.name))
      .map((d) => path.join(transactionsDir, d.name))
      .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  } catch {
    return resolved;
  }

  for (const candidate of readyDirs) {
    if (enumerateSaveFiles(candidate).length > 0) {
      return candidate;
    }
  }

  return resolved;
}

function listWindowsDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code++) {
    const letter = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(letter)) {
        drives.push({ name: letter, path: letter });
      }
    } catch {}
  }
  return drives;
}

function listRootEntries() {
  if (process.platform === "win32") {
    return listWindowsDrives();
  }
  const roots = [{ name: "/", path: "/" }];
  const home = os.homedir();
  if (home && home !== "/" && fs.existsSync(home)) {
    roots.unshift({ name: `Home (${path.basename(home)})`, path: home });
  }
  return roots;
}

export function browseDirectories(rawQueryPath, locale) {
  const trimmed = String(rawQueryPath ?? "").trim();
  if (!trimmed) {
    return {
      path: "",
      parent: "",
      folders: listRootEntries(),
    };
  }

  const fullPath = path.resolve(trimmed);
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    throw new Error(
      locale.t("La carpeta no existe.", "The folder does not exist."),
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      locale.t("La carpeta no existe.", "The folder does not exist."),
    );
  }

  const parsed = path.parse(fullPath);
  const parent = fullPath === parsed.root ? "" : path.dirname(fullPath);

  const folders = fs
    .readdirSync(fullPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith("."),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((entry) => ({
      name: entry.name,
      path: path.join(fullPath, entry.name),
    }));

  return {
    path: fullPath,
    parent,
    folders,
  };
}

function hasSlotDirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((d) => d.isDirectory() && d.name.startsWith("slot_"));
  } catch {
    return false;
  }
}

export function getSourceOptions(homeDir, settings) {
  const knownWindows = "C:\\Games\\Zelda TOTK\\profile\\save";
  const candidateRoots = [
    knownWindows,
    path.join(homeDir, "profile", "save"),
    settings.mode === "folder" ? settings.source : "",
  ].filter((dir) => dir && fs.existsSync(dir));

  const uniqueRoots = [...new Set(candidateRoots.map((d) => path.resolve(d)))];
  const accounts = new Set();

  for (const root of uniqueRoots) {
    if (hasSlotDirectories(root)) accounts.add(root);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(root, entry.name);
        if (hasSlotDirectories(sub)) accounts.add(sub);
      }
    } catch {}
  }

  const choices = [];
  const saves = [];
  for (const accountDir of accounts) {
    if (!hasSlotDirectories(accountDir)) continue;
    const accountLabel = path.basename(accountDir);
    choices.push({ name: `Recomp · ${accountLabel}`, path: accountDir });
    for (const save of enumerateSaveFiles(accountDir)) {
      saves.push({
        name: `${accountLabel} / ${path.basename(path.dirname(save))}`,
        path: save,
      });
    }
  }

  return {
    choices,
    saves,
    defaultPath: fs.existsSync(knownWindows) ? knownWindows : "",
  };
}
