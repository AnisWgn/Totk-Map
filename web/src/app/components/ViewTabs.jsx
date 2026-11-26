import { useStoreValue } from "../use-store.js";
import { I18N } from "../../shared/i18n.js";

const baseViews = ["map", "inventory", "quests", "world", "summary"];

const labels = {
  map: "Mapa",
  inventory: "Inventario",
  quests: "Misiones",
  world: "HyruleWorld",
  summary: "Resumen",
};

function updateTabLabel(updateState) {
  if (updateState?.downloadStatus === "downloading") {
    return I18N.t("Descargando actualización ({percent}%)", {
      percent: updateState.downloadPercent ?? 0,
    });
  }
  if (
    updateState?.downloadStatus === "downloaded" ||
    updateState?.downloadStatus === "applying"
  ) {
    return I18N.t("Actualización lista");
  }

  return I18N.t("Nueva actualización disponible");
}

export function ViewTabs({ store }) {
  const view = useStoreValue(store, "view");
  const updateState = useStoreValue(store, "updateState");
  const showUpdateTab = Boolean(
    updateState?.available ||
    updateState?.downloadStatus === "downloading" ||
    updateState?.downloadStatus === "downloaded" ||
    updateState?.downloadStatus === "applying" ||
    view === "update",
  );
  const views = showUpdateTab ? [...baseViews, "update"] : baseViews;

  function navigate(event, current) {
    const index = views.indexOf(current);
    const next = {
      Home: 0,
      End: views.length - 1,
      ArrowRight: (index + 1) % views.length,
      ArrowLeft: (index + views.length - 1) % views.length,
    }[event.key];

    if (next == null) return;
    event.preventDefault();
    store.actions.setSaveView(views[next]);
    document.getElementById(views[next] + "Tab").focus();
  }

  return (
    <nav
      className="view-tabs"
      role="tablist"
      aria-label={I18N.t("Vistas de la partida")}
    >
      {views.map((name) => (
        <button
          key={name}
          id={name + "Tab"}
          className={
            name === "summary"
              ? "summary-tab"
              : name === "update"
                ? "update-tab"
                : undefined
          }
          role="tab"
          aria-selected={view === name}
          aria-controls={name + "Panel"}
          tabIndex={view === name ? 0 : -1}
          onClick={() => store.actions.setSaveView(name)}
          onKeyDown={(event) => navigate(event, name)}
        >
          {name === "update" ? (
            <>
              <i className="update-tab-dot" aria-hidden="true" />
              <span>{updateTabLabel(updateState)}</span>
            </>
          ) : (
            I18N.t(labels[name])
          )}
        </button>
      ))}
    </nav>
  );
}
