import { stampLabels, stampImage } from "./stamps.js";
import { I18N } from "../../shared/i18n.js";
import { MapQualityControl } from "./MapQualityControl.jsx";

const t = (key, values) => I18N.t(key, values);

export function MapPanel({ hidden }) {
  return (
    <div id="mapPanel" role="tabpanel" aria-labelledby="mapTab" hidden={hidden}>
      <div id="map" aria-label={t("Mapa de Totkmap")}></div>

      <div className="topbar">
        <MapQualityControl />
        <button id="toggleSidebar" className="small-button mobile">
          {t("☰ Filtros")}
        </button>
        <div className="layers" role="group" aria-label={t("Capa del mapa")}>
          <button data-layer="depths">{t("Subsuelo")}</button>
          <button data-layer="surface" className="active">
            {t("Superficie")}
          </button>
          <button data-layer="sky">{t("Cielo")}</button>
        </div>
        <button
          type="button"
          id="toggleCompleted"
          className="completed-toggle-btn active"
          aria-pressed="true"
          title={t(
            "Mostrar u ocultar en semitransparente los iconos ya desbloqueados en tu partida",
          )}
        >
          <i className="completed-toggle-dot" aria-hidden="true"></i>
          <span>{t("Desbloqueados")}</span>
        </button>
        <button
          type="button"
          id="recompLiveBadge"
          className="recomp-live-badge"
          hidden
        ></button>
        <span id="visibleCount">{t("—")}</span>
      </div>

      <div className="map-controls">
        <button id="zoomIn" title={t("Acercar")} aria-label={t("Acercar")}>
          {t("+")}
        </button>
        <button id="zoomOut" title={t("Alejar")} aria-label={t("Alejar")}>
          {t("−")}
        </button>
        <button
          id="fitMap"
          title={t("Ver todo el mapa")}
          aria-label={t("Ver todo el mapa")}
        >
          {t("⛶")}
        </button>
      </div>

      <div className="bottom">
        <label>
          <input type="checkbox" id="showPaths" defaultChecked />
          {t(" Rutas de kologs y cuevas")}
        </label>
        <span id="mouseCoords">{t("Este · Norte")}</span>
      </div>

      <section id="startupLoading" role="status" aria-live="polite">
        <span className="startup-spinner" aria-hidden="true"></span>
        <p>{t("Cargando partida…")}</p>
      </section>

      <section id="welcome" hidden>
        <div className="eyebrow">{t("TU PARTIDA, SIEMPRE AL DÍA")}</div>
        <h2>{t("¿Qué queda por explorar?")}</h2>
        <p>
          {t(
            "Elige la carpeta de guardados de tu cuenta. Autosync se activa automáticamente y actualiza el mapa con cada autoguardado o guardado manual.",
          )}
        </p>

        <div className="load-buttons">
          <button id="welcomeFolder">{t("Seguir carpeta")}</button>
          <button id="welcomeLoad" className="secondary">
            {t("Cargar .sav")}
          </button>
        </div>
        <p className="fine">{t("No convierte ni modifica el guardado.")}</p>
      </section>

      <section id="detail" hidden>
        <button id="closeDetail" aria-label={t("Cerrar detalle")}>
          {t("×")}
        </button>

        <div className="detail-title">
          <img id="detailIcon" alt="" />
          <div>
            <div id="detailCategory" className="eyebrow"></div>
            <h2 id="detailName"></h2>
          </div>
        </div>

        <div id="detailState"></div>
        <p id="detailChests" hidden></p>

        <div className="coords">
          <span>{t("ESTE · NORTE · ALTURA")}</span>
          <strong id="detailCoords"></strong>
          <button id="copyCoords" className="link-button">
            {t("Copiar")}
          </button>
        </div>
        <p id="korokInfo"></p>
        <button id="zoomSelected" className="secondary">
          {t("Centrar y acercar")}
        </button>
        <button type="button" id="pinSelectedPoint" className="secondary">
          {t("Colocar baliza en el juego")}
        </button>
        <a
          id="viewGuide"
          className="guide-button"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("Ver guía en Zelda Dungeon (otra pestaña)")}
        >
          {t("Ver guía")}
        </a>
        <p id="guideHint"></p>

        <details>
          <summary>{t("Verificar contra el guardado")}</summary>
          <div id="diagnostics"></div>
        </details>
      </section>

      <section
        id="pinPopover"
        className="pin-popover"
        role="dialog"
        aria-labelledby="pinPopoverTitle"
        hidden
      >
        <button
          type="button"
          id="closePinPopover"
          className="pin-popover-close"
          aria-label={t("Cerrar selector de baliza")}
        >
          {t("×")}
        </button>
        <div className="eyebrow">{t("BALIZA EN EL JUEGO")}</div>
        <h3 id="pinPopoverTitle">{t("Marcador de mapa")}</h3>
        <p id="pinPopoverCoords" className="pin-popover-coords"></p>
        <section id="localStampPicker">
          <p>{t("Sellos locales · solo en este mapa")}</p>
          <div className="stamp-grid">
            {Object.entries(stampLabels).map(([type, label]) => (
              <button
                key={type}
                data-stamp={type}
                type="button"
                className="secondary"
                title={t(label)}
              >
                <img
                  src={stampImage(type)}
                  alt={t(label)}
                  width="24"
                  height="24"
                />
              </button>
            ))}
          </div>
          <button
            id="removeLocalStamp"
            type="button"
            className="secondary pin-remove-btn"
            hidden
          >
            {t("Quitar sello")}
          </button>
        </section>
        <section id="gamePinPicker">
          <p>{t("Elige un color de baliza")}</p>
          <div className="pin-color-grid">
            <button
              type="button"
              data-pin-color="Red"
              className="pin-color-btn"
              style={{ "--pin-swatch": "#ff5a52" }}
            >
              <i className="beacon-icon" aria-hidden="true" />
              <span>{t("Roja")}</span>
            </button>
            <button
              type="button"
              data-pin-color="Blue"
              className="pin-color-btn"
              style={{ "--pin-swatch": "#4ea6ff" }}
            >
              <i className="beacon-icon" aria-hidden="true" />
              <span>{t("Azul")}</span>
            </button>
            <button
              type="button"
              data-pin-color="Yellow"
              className="pin-color-btn"
              style={{ "--pin-swatch": "#ffd24c" }}
            >
              <i className="beacon-icon" aria-hidden="true" />
              <span>{t("Amarilla")}</span>
            </button>
            <button
              type="button"
              data-pin-color="Green"
              className="pin-color-btn"
              style={{ "--pin-swatch": "#4ce08a" }}
            >
              <i className="beacon-icon" aria-hidden="true" />
              <span>{t("Verde")}</span>
            </button>
            <button
              type="button"
              data-pin-color="Purple"
              className="pin-color-btn"
              style={{ "--pin-swatch": "#b87aff" }}
            >
              <i className="beacon-icon" aria-hidden="true" />
              <span>{t("Morada")}</span>
            </button>
            <button
              type="button"
              data-pin-color="LightBlue"
              className="pin-color-btn"
              style={{ "--pin-swatch": "#5ce6e6" }}
            >
              <i className="beacon-icon" aria-hidden="true" />
              <span>{t("Celeste")}</span>
            </button>
          </div>
          <button
            type="button"
            id="removeGamePin"
            className="secondary pin-remove-btn"
            hidden
          >
            {t("Quitar baliza")}
          </button>
        </section>
      </section>

      <div className="attribution">
        {t("Recursos: TotK Unexplored / ZeldaMods / Nintendo · Leaflet")}
      </div>
    </div>
  );
}
