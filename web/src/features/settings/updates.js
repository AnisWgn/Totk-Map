export function createUpdateController({
  $,
  t,
  fetch,
  setTimeout,
  clearTimeout,
  publish = () => {},
  toast = () => {},
}) {
  let checkingUpdates = false,
    updateTimer,
    latestUpdate = null;

  function scheduleNextPoll(state) {
    clearTimeout(updateTimer);

    const fast = Boolean(
      state?.busy || state?.downloadStatus === "downloading",
    );

    updateTimer = setTimeout(() => checkUpdates(), fast ? 250 : 60000);
  }

  async function checkUpdates(manual = false) {
    if (checkingUpdates) return;
    checkingUpdates = true;
    clearTimeout(updateTimer);

    const checkBtn = $("checkUpdates");

    if (checkBtn) checkBtn.disabled = true;

    try {
      if (manual) {
        const response = await fetch("api/check-updates", {
          method: "POST",
          body: "",
        });

        if (!response.ok) throw Error();
      }

      const response = await fetch("api/updates", { cache: "no-store" });

      if (!response.ok) throw Error();

      const state = await response.json();
      latestUpdate = state;
      publish({ updateState: state });

      if ($("viewChanges")) $("viewChanges").disabled = !state.releaseUrl;
      if ($("aboutChanges")) $("aboutChanges").disabled = !state.releaseUrl;
      if ($("aboutVersion"))
        $("aboutVersion").textContent = "Totkmap " + state.currentVersion;
      if ($("updateNotice")) $("updateNotice").hidden = !state.available;
      if ($("updateMessage")) {
        $("updateMessage").textContent = state.available
          ? t("Nueva versión disponible: v{version}", {
              version: state.latestVersion,
            })
          : "";
      }

      const canDownload = Boolean(state.available && state.downloadUrl);

      for (const id of ["downloadUpdate", "aboutDownloadUpdate"]) {
        const download = $(id);

        if (!download) continue;
        download.hidden = !canDownload;
        download.removeAttribute("href");
        if (canDownload) download.href = state.downloadUrl;
      }

      if ($("aboutUpdateInstructions"))
        $("aboutUpdateInstructions").hidden = !canDownload;

      if ($("updateStatus")) {
        $("updateStatus").textContent = state.busy
          ? t("Buscando actualizaciones…")
          : state.error ||
            (state.available
              ? t("Nueva versión disponible: v{version}", {
                  version: state.latestVersion,
                })
              : state.latestVersion
                ? t("Tienes la última versión.")
                : t("Todavía no hay versiones publicadas."));
      }

      scheduleNextPoll(state);
    } catch {
      if ($("updateStatus")) {
        $("updateStatus").textContent = t(
          "No se pudieron buscar actualizaciones. Puedes reintentar.",
        );
      }
      updateTimer = setTimeout(() => checkUpdates(), 60000);
    } finally {
      checkingUpdates = false;
      if ($("checkUpdates")) $("checkUpdates").disabled = false;
    }
  }

  async function postUpdateAction(endpoint) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: "",
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || t("No se pudo completar la acción."));
      }
      await checkUpdates(false);
    } catch (error) {
      toast(error.message);
      await checkUpdates(false);
    }
  }

  function startUpdateDownload() {
    return postUpdateAction("api/download-update");
  }

  function cancelUpdateDownload() {
    return postUpdateAction("api/cancel-update");
  }

  function applyUpdate() {
    return postUpdateAction("api/apply-update");
  }

  function showChanges() {
    if (!latestUpdate?.releaseUrl) return;
    $("changesVersion").textContent = "Totkmap v" + latestUpdate.latestVersion;
    $("changesText").textContent =
      latestUpdate.releaseNotes?.trim() ||
      t("Esta versión no tiene notas de cambios.");
    $("changesLink").href = latestUpdate.releaseUrl;
    $("changesDialog").showModal();
  }

  return {
    checkUpdates,
    showChanges,
    startUpdateDownload,
    cancelUpdateDownload,
    applyUpdate,
  };
}
