import { useStoreValue } from "../../app/use-store.js";
import { I18N } from "../../shared/i18n.js";

const t = (key, values) => I18N.t(key, values);

function formatBytes(bytes) {
  const count = Number(bytes) || 0;

  if (count <= 0) return "0 MB";
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;

  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdatePanel({ store }) {
  const view = useStoreValue(store, "view");
  const update = useStoreValue(store, "updateState");
  const status = update?.downloadStatus || "idle";
  const percent =
    status === "downloaded"
      ? 100
      : Math.max(0, Math.min(100, Number(update?.downloadPercent) || 0));
  const totalBytes = Number(update?.totalBytes || update?.assetSize || 0);
  const downloadedBytes =
    status === "downloaded" ? totalBytes : Number(update?.downloadedBytes || 0);
  const notes = update?.releaseNotes?.trim() || "";
  const isDownloading = status === "downloading";
  const isDownloaded = status === "downloaded";
  const isApplying = status === "applying";
  const hasError = status === "error" || Boolean(update?.downloadError);

  return (
    <section
      id="updatePanel"
      className="update-panel"
      role="tabpanel"
      aria-labelledby="updateTab"
      hidden={view !== "update"}
    >
      <div className="update-panel-inner">
        <header className="update-hero">
          <div className="eyebrow">
            {t("ACTUALIZACIÓN AUTOMÁTICA · TOTKMAP")}
          </div>
          <h2>
            {t("Nueva actualización disponible · v{version}", {
              version: update?.latestVersion || "—",
            })}
          </h2>
          <p className="update-version-meta">
            {t("Versión actual: v{current} → Nueva versión: v{latest}", {
              current: update?.currentVersion || "—",
              latest: update?.latestVersion || "—",
            })}
          </p>
          {totalBytes > 0 && (
            <p className="update-size-meta">
              {t("Tamaño del paquete: {size}", {
                size: formatBytes(totalBytes),
              })}
            </p>
          )}
        </header>

        <article className="update-download-card">
          {(isDownloading || isDownloaded || isApplying || percent > 0) && (
            <div className="update-progress-section">
              <div className="update-progress-header">
                <strong>
                  {isDownloaded || isApplying
                    ? t("Descarga completada (100 %). Lista para instalar.")
                    : t("Descargando paquete de actualización…")}
                </strong>
                <span className="update-percent-badge">{percent}%</span>
              </div>

              <div
                id="updateDownloadProgress"
                className="update-progress-track"
                role="progressbar"
                aria-label={t("Progreso de descarga de la actualización")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ width: `${percent}%` }} />
              </div>

              <div className="update-progress-stats">
                <span>
                  {t("{downloaded} de {total} ({percent}%)", {
                    downloaded: formatBytes(downloadedBytes),
                    total: formatBytes(totalBytes),
                    percent,
                  })}
                </span>
                {isDownloading && Number(update?.downloadSpeed) > 0 && (
                  <span>
                    {t("Velocidad: {speed}/s", {
                      speed: formatBytes(update.downloadSpeed),
                    })}
                  </span>
                )}
              </div>
            </div>
          )}

          {hasError && (
            <p className="update-error" role="alert">
              {update?.downloadError}
            </p>
          )}

          <div className="update-actions">
            {!isDownloading && !isDownloaded && !isApplying && (
              <button
                type="button"
                id="startUpdateDownload"
                onClick={() => store.actions.startUpdateDownload?.()}
              >
                {hasError
                  ? t("Reintentar actualización")
                  : update?.canAutoInstall
                    ? t("Actualizar y reiniciar automáticamente")
                    : t("Descargar actualización")}
              </button>
            )}

            {isDownloading && (
              <button
                type="button"
                id="cancelUpdateDownload"
                className="secondary"
                onClick={() => store.actions.cancelUpdateDownload?.()}
              >
                {t("Cancelar descarga")}
              </button>
            )}

            {(isDownloaded || isApplying) && update?.canAutoInstall && (
              <button
                type="button"
                id="installUpdateButton"
                disabled={isApplying}
                onClick={() => store.actions.applyUpdate?.()}
              >
                {isApplying
                  ? t("Instalando actualización…")
                  : t("Instalar y reiniciar")}
              </button>
            )}

            {update?.downloadUrl &&
              (isDownloaded || !update?.canAutoInstall) && (
                <a
                  className="download-button secondary-link"
                  href={update.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("Descarga directa desde GitHub")}
                </a>
              )}

            {!isDownloading && !isApplying && (
              <button
                type="button"
                className="secondary"
                onClick={() => store.actions.checkUpdates?.(true)}
              >
                {t("Volver a comprobar")}
              </button>
            )}
          </div>

          <p className="update-safe-note">
            {t(
              "Tus carpetas .data (mapas) y .state (preferencias) se conservan automáticamente. Tus partidas no se modifican.",
            )}
          </p>
        </article>

        <article className="update-notes-card">
          <div className="update-notes-header">
            <h3>{t("Novedades de esta versión")}</h3>
            {update?.releaseUrl && (
              <a
                href={update.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("Ver lanzamiento en GitHub")}
              </a>
            )}
          </div>
          <pre className="update-notes-text">
            {notes || t("Esta versión no tiene notas de cambios.")}
          </pre>
        </article>
      </div>
    </section>
  );
}
