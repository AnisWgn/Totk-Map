import { I18N } from "../../shared/i18n.js";

const t = (key, values) => I18N.t(key, values);

export function SetupScreen() {
  return (
    <section id="setup" aria-labelledby="setupTitle" hidden>
      <div className="setup-drag-strip" aria-hidden="true"></div>
      <div className="setup-layout">
        <header className="setup-header">
          <div className="setup-brand">
            <img src="app-icon.png" alt="" width="42" height="42" />
            Totk-Map
          </div>
          <div className="language-setting">
            <label htmlFor="setupLanguageSelect">{t("Idioma")}</label>
            <select id="setupLanguageSelect" data-language-select="">
              <option value="auto">{t("Automático (Windows)")}</option>
              <option value="es" lang="es">
                {t("Español")}
              </option>
              <option value="en" lang="en">
                {t("English")}
              </option>
            </select>
          </div>
        </header>
        <div className="setup-main">
          <div className="setup-intro">
            <div className="eyebrow">{t("Primer inicio")}</div>
            <h2 id="setupTitle">{t("Prepara tu mapa")}</h2>
            <p>
              {t(
                "Descarga una vez los mapas, iconos y el catálogo de ubicaciones (unos 44 MB). Después podrás usarlos sin conexión.",
              )}
            </p>
          </div>
          <div className="setup-download">
            <h3>{t("Recursos del mapa")}</h3>
            <button id="prepareResources">
              {t("Descargar recursos del mapa")}
            </button>
            <progress
              aria-label={t("Recursos del mapa")}
              id="setupProgress"
              max="100"
              value="0"
            ></progress>
            <p id="setupStatus" role="status">
              {t("Luego podrás elegir tu carpeta de guardados.")}
            </p>
            <p id="setupError" role="alert"></p>
          </div>
        </div>
        <footer className="setup-footer">
          <p className="fine">
            {t(
              "Los recursos se obtienen del repositorio de TotK Unexplored. Totk-Map es una aplicación independiente y conserva los créditos de esos recursos.",
            )}
          </p>
          <button id="setupAboutOpen" className="link-button">
            {t("Acerca de, licencias y créditos")}
          </button>
        </footer>
      </div>
    </section>
  );
}
