import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  PIN_HASH_BY_COLOR,
  STAMP_LAYER_BY_HASH,
  STAMP_TYPE_BY_HASH,
  decodeRawMapPins,
} from "./map-markers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HELPER_PATH = path.resolve(
  __dirname,
  "..",
  "recomp-memory-helper.ps1",
);

function resolveUnpackedPath(candidate) {
  const unpacked = candidate.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
  return fs.existsSync(unpacked) ? unpacked : candidate;
}

function isFiniteCoord(v) {
  return Number.isFinite(v) && Math.abs(v) <= 20000;
}

export class RecompLiveBridge {
  constructor({
    enabled = false,
    platform = process.platform,
    spawnProcess = cp.spawn,
    helperScriptPath = DEFAULT_HELPER_PATH,
    locale,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.helperScriptPath = resolveUnpackedPath(helperScriptPath);
    this.locale = locale;

    this.child = null;
    this.rl = null;
    this.restartTimer = null;
    this.stopped = false;
    this.reqCounter = 0;
    this.pendingReplies = new Map();

    this.status = this.enabled ? "searching" : "disabled";
    this.pid = 0;
    this.processName = "";
    this.canWriteMemory = false;
    this.playerPosition = null;
    this.playerYaw = null;
    this.pins = null;
    this.stamps = null;
    this.updatedAt = "";
    this.error = "";
    this.started = false;
  }

  start() {
    this.started = true;
    this.stopped = false;
    if (this.enabled) {
      this.#startWorker();
    }
  }

  state() {
    return {
      enabled: this.enabled,
      supported: this.platform === "win32",
      status: this.status,
      pid: this.pid,
      processName: this.processName,
      canWriteMemory: this.canWriteMemory,
      playerPosition: this.playerPosition,
      playerYaw: this.playerYaw,
      pins: this.pins,
      stamps: this.stamps,
      updatedAt: this.updatedAt,
      error: this.error,
    };
  }

  setEnabled(nextEnabled) {
    const flag = Boolean(nextEnabled);
    if (this.enabled === flag) return this.state();
    this.enabled = flag;
    this.error = "";
    if (flag) {
      this.status = "searching";
      this.#startWorker();
    } else {
      this.#stopWorker();
      this.#clearLiveData("disabled");
    }
    return this.state();
  }

  rescan() {
    if (!this.enabled) {
      this.setEnabled(true);
      return this.state();
    }
    if (this.child && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.write(JSON.stringify({ cmd: "rescan" }) + "\n");
      } catch {}
    } else {
      this.#startWorker();
    }
    return this.state();
  }

  ingestExternalTelemetry(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid telemetry payload.");
    }
    this.status = "bridge";
    this.processName =
      typeof payload.processName === "string" && payload.processName
        ? payload.processName
        : "TotK Recomp Bridge";
    this.pid = Number.isInteger(payload.pid) ? payload.pid : 0;

    if (payload.playerPosition && typeof payload.playerPosition === "object") {
      const x = Number(payload.playerPosition.x);
      const y = Number(payload.playerPosition.y);
      const z = Number(payload.playerPosition.z);
      if (isFiniteCoord(x) && isFiniteCoord(y) && isFiniteCoord(z)) {
        this.playerPosition = { x, y, z };
      }
    }
    if (payload.playerYaw !== undefined) {
      const yaw = Number(payload.playerYaw);
      this.playerYaw = Number.isFinite(yaw) ? yaw : null;
    }
    if (Array.isArray(payload.pins)) {
      this.pins = payload.pins
        .filter(
          (p) =>
            p &&
            Number.isInteger(p.slot) &&
            p.slot >= 0 &&
            p.slot <= 5 &&
            typeof p.color === "string" &&
            p.color !== "Invalid" &&
            p.position &&
            isFiniteCoord(Number(p.position.x)) &&
            isFiniteCoord(Number(p.position.y)) &&
            isFiniteCoord(Number(p.position.z)),
        )
        .map((p) => ({
          slot: p.slot,
          color: p.color,
          isFit: Boolean(p.isFit),
          position: {
            x: Number(p.position.x),
            y: Number(p.position.y),
            z: Number(p.position.z),
          },
        }));
    }
    if (Array.isArray(payload.stamps)) {
      this.stamps = payload.stamps
        .filter(
          (s) =>
            s &&
            Number.isInteger(s.slot) &&
            s.slot >= 0 &&
            s.slot < 300 &&
            typeof s.type === "string" &&
            s.type !== "Invalid" &&
            s.position &&
            isFiniteCoord(Number(s.position.x)) &&
            isFiniteCoord(Number(s.position.z)),
        )
        .map((s) => ({
          slot: s.slot,
          type: s.type,
          layer:
            s.layer === "sky" || s.layer === "depths" ? s.layer : "surface",
          position: {
            x: Number(s.position.x),
            y: Number(s.position.y ?? 120),
            z: Number(s.position.z),
          },
        }));
    }
    this.updatedAt = new Date().toISOString();
    this.error = "";
    return this.state();
  }

  async writePinInMemory({ slot, color, position }) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 5) {
      throw new Error("Pin slot must be between 0 and 5.");
    }
    const typeHash = PIN_HASH_BY_COLOR.get(color);
    if (typeHash === undefined) {
      throw new Error("Invalid pin color.");
    }
    const x = color === "Invalid" ? 0 : Number(position?.x ?? 0);
    const y = color === "Invalid" ? 0 : Number(position?.y ?? 120);
    const z = color === "Invalid" ? 0 : Number(position?.z ?? 0);
    if (!isFiniteCoord(x) || !isFiniteCoord(y) || !isFiniteCoord(z)) {
      throw new Error("Invalid pin coordinates.");
    }

    // If running in HTTP bridge mode (or tests without PowerShell worker), update bridge state directly
    if (this.status === "bridge" && !this.child) {
      const current = Array.isArray(this.pins) ? [...this.pins] : [];
      const filtered = current.filter((p) => p.slot !== slot);
      if (color !== "Invalid") {
        filtered.push({
          slot,
          color,
          isFit: false,
          position: { x, y, z },
        });
        filtered.sort((a, b) => a.slot - b.slot);
      }
      this.pins = filtered;
      this.updatedAt = new Date().toISOString();
      return { ok: true, mode: "bridge", state: this.state() };
    }

    if (
      !this.child ||
      !this.child.stdin ||
      this.child.stdin.destroyed ||
      this.status !== "connected" ||
      !this.canWriteMemory
    ) {
      return {
        ok: false,
        error: this.locale
          ? this.locale.t(
              "TotK Recomp no está conectado con escritura en memoria activa.",
              "TotK Recomp is not connected with writable live memory.",
            )
          : "TotK Recomp is not connected with writable live memory.",
      };
    }

    const id = ++this.reqCounter;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(id);
        resolve({ ok: false, error: "Memory write timed out." });
      }, 3000);

      this.pendingReplies.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ok: Boolean(msg.ok), error: msg.error || "" });
      });

      try {
        this.child.stdin.write(
          JSON.stringify({ cmd: "setPin", id, slot, typeHash, x, y, z }) + "\n",
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingReplies.delete(id);
        resolve({ ok: false, error: err?.message || "Write failed." });
      }
    });
  }

  stop() {
    this.stopped = true;
    this.#stopWorker();
  }

  #clearLiveData(nextStatus) {
    this.status = nextStatus;
    this.pid = 0;
    this.processName = "";
    this.canWriteMemory = false;
    this.playerPosition = null;
    this.playerYaw = null;
    this.pins = null;
    this.stamps = null;
  }

  #startWorker() {
    if (!this.started || this.stopped || !this.enabled) return;
    if (this.platform !== "win32") {
      this.status = "searching";
      return;
    }
    if (this.child) return;

    clearTimeout(this.restartTimer);
    try {
      const child = this.spawnProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.helperScriptPath,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.child = child;
      this.rl = readline.createInterface({ input: child.stdout });
      this.rl.on("line", (line) => this.#handleWorkerLine(line));

      child.on("error", (err) => {
        this.error = err?.message || "Failed to start memory reader.";
      });

      child.on("close", () => {
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        this.child = null;
        for (const [, pending] of this.pendingReplies) {
          pending({ ok: false, error: "Helper exited." });
        }
        this.pendingReplies.clear();

        if (!this.stopped && this.enabled) {
          this.#clearLiveData("searching");
          this.restartTimer = setTimeout(() => this.#startWorker(), 3000);
        }
      });
    } catch (err) {
      this.error = err?.message || "Failed to launch PowerShell helper.";
    }
  }

  #stopWorker() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      const proc = this.child;
      this.child = null;
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n");
          proc.stdin.end();
        }
      } catch {}
      try {
        proc.kill();
      } catch {}
    }
    for (const [, pending] of this.pendingReplies) {
      pending({ ok: false, error: "Stopped." });
    }
    this.pendingReplies.clear();
  }

  #handleWorkerLine(rawLine) {
    const trimmed = String(rawLine || "").trim();
    if (!trimmed.startsWith("{")) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (msg.reply === "setPin" && msg.id && this.pendingReplies.has(msg.id)) {
      const cb = this.pendingReplies.get(msg.id);
      this.pendingReplies.delete(msg.id);
      cb(msg);
      return;
    }

    if (msg.status === "searching") {
      if (this.status !== "bridge") {
        this.#clearLiveData("searching");
      }
      return;
    }

    if (msg.status === "connected") {
      this.status = "connected";
      this.pid = Number(msg.pid) || 0;
      this.processName = String(msg.processName || "totk.exe");
      this.canWriteMemory = Boolean(msg.canWriteMemory);
      this.error = "";

      if (msg.playerPosition && typeof msg.playerPosition === "object") {
        const x = Number(msg.playerPosition.x);
        const y = Number(msg.playerPosition.y);
        const z = Number(msg.playerPosition.z);
        if (isFiniteCoord(x) && isFiniteCoord(y) && isFiniteCoord(z)) {
          this.playerPosition = { x, y, z };
        }
      }
      if (msg.playerYaw !== undefined) {
        const yaw = Number(msg.playerYaw);
        this.playerYaw = Number.isFinite(yaw) ? yaw : null;
      }

      if (
        Array.isArray(msg.pinTypes) &&
        Array.isArray(msg.pinPositions) &&
        msg.pinTypes.length === 6 &&
        msg.pinPositions.length === 6
      ) {
        const positions = msg.pinPositions.map((arr) => ({
          x: Number(arr[0]),
          y: Number(arr[1]),
          z: Number(arr[2]),
        }));
        this.pins = decodeRawMapPins(msg.pinTypes, positions);
      }

      if (Array.isArray(msg.activeStamps)) {
        const parsedStamps = [];
        for (const row of msg.activeStamps) {
          if (!Array.isArray(row) || row.length < 5) continue;
          const slot = Number(row[0]);
          const type = STAMP_TYPE_BY_HASH.get(Number(row[1]) >>> 0);
          if (!type || type === "Invalid") continue;
          const layer =
            STAMP_LAYER_BY_HASH.get(Number(row[2]) >>> 0) || "surface";
          const x = Number(row[3]);
          const north = Number(row[4]);
          if (!isFiniteCoord(x) || !isFiniteCoord(north)) continue;
          const y = layer === "depths" ? -250 : layer === "sky" ? 1000 : 120;
          parsedStamps.push({
            slot,
            type,
            layer,
            position: { x, y, z: -north },
          });
        }
        this.stamps = parsedStamps;
      }

      this.updatedAt = new Date().toISOString();
    }
  }
}
