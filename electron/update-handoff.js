// A successful spawn only means powershell.exe exists, not that it ran our script.
export function waitForUpdateHandoff(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let diagnostic = "";
    const timer = setTimeout(
      () => fail(new Error("Update helper did not confirm startup.")),
      timeoutMs,
    );
    function cleanup() {
      clearTimeout(timer);
      child.off("error", fail);
      child.off("close", closed);
      child.stdout.off("data", read);
      child.stderr.off("data", readError);
    }
    function fail(error) {
      cleanup();
      child.kill();
      reject(error);
    }
    function closed(code) {
      fail(
        new Error(
          diagnostic.trim() ||
            `Update helper exited before installation (${code}).`,
        ),
      );
    }
    function readError(chunk) {
      diagnostic = (diagnostic + chunk).slice(-2048);
    }
    function read(chunk) {
      output = (output + chunk).slice(-2048);
      if (!/^TOTKMAP_UPDATE_READY\r?$/m.test(output)) return;
      cleanup();
      child.stdout.unref?.();
      child.stderr.unref?.();
      resolve();
    }
    child.on("error", fail);
    child.on("close", closed);
    child.stdout.on("data", read);
    child.stderr.on("data", readError);
  });
}
