// Track open UI documents by connection so a delayed disconnect cannot remove
// a newer EventSource reconnection. Closing the last document allows reloads a grace period.
export class PageLifetime {
  constructor() {
    this.pages = new Map();
    this.emptySince = null;
  }

  open(id, connection) {
    this.pages.set(id, connection);
    this.emptySince = null;
  }

  connected(id, connection) {
    return this.pages.has(id) && this.pages.get(id) === connection;
  }

  close(id, connection, nowMs = Date.now()) {
    if (!this.pages.has(id)) return;
    const current = this.pages.get(id);
    if (connection === null || current === connection) {
      this.pages.delete(id);
      if (this.pages.size === 0) {
        this.emptySince = nowMs;
      }
    }
  }

  shouldExit(nowMs = Date.now(), background = false, busyDownloading = false) {
    return (
      !background &&
      !busyDownloading &&
      this.pages.size === 0 &&
      this.emptySince !== null &&
      nowMs - this.emptySince >= 5000
    );
  }
}
