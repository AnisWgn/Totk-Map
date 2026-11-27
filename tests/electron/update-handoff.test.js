// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { waitForUpdateHandoff } from "../../electron/update-handoff.js";

function helper() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

it("rejects a spawned helper that failed before launching the installer", async () => {
  const child = helper();
  const ready = waitForUpdateHandoff(child);
  child.emit("spawn");
  child.stderr.write("Installer access denied");
  child.emit("close", 1);
  await expect(ready).rejects.toThrow("Installer access denied");
});

it("accepts confirmation across pipe chunks", async () => {
  const child = helper();
  const ready = waitForUpdateHandoff(child);
  child.stdout.write("TOTKMAP_");
  child.stdout.write("UPDATE_READY\r\n");
  await ready;
  expect(child.kill).not.toHaveBeenCalled();
});
