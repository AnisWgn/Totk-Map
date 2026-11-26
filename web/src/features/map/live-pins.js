import L from "leaflet";
import { esc } from "../../shared/utils.js";
import { coordinateString, inLayer, ll, playerLayer } from "./model.js";

const PIN_STYLES = {
  Red: { hex: "#ff5a52", labelKey: "Roja" },
  Blue: { hex: "#4ea6ff", labelKey: "Azul" },
  Yellow: { hex: "#ffd24c", labelKey: "Amarilla" },
  Green: { hex: "#4ce08a", labelKey: "Verde" },
  Purple: { hex: "#b87aff", labelKey: "Morada" },
  LightBlue: { hex: "#5ce6e6", labelKey: "Celeste" },
};

const STAMP_LABELS = {
  Sword: { symbol: "⚔", labelKey: "Espada" },
  Pot: { symbol: "🍲", labelKey: "Olla" },
  Human: { symbol: "👤", labelKey: "Persona" },
  Rhombus: { symbol: "◆", labelKey: "Rombo" },
  Heart: { symbol: "♥", labelKey: "Corazón" },
  Star: { symbol: "★", labelKey: "Estrella" },
  TreasureBox: { symbol: "▣", labelKey: "Cofre del tesoro" },
  Skull: { symbol: "☠", labelKey: "Calavera" },
  Leaf: { symbol: "❧", labelKey: "Hoja kolog" },
  Ore: { symbol: "◈", labelKey: "Mineral" },
};

export const PIN_COLOR_LIST = [
  "Red",
  "Blue",
  "Yellow",
  "Green",
  "Purple",
  "LightBlue",
];

export function pinStyleFor(color) {
  return PIN_STYLES[color] || PIN_STYLES.Red;
}

export function createLivePinController({
  $,
  t,
  fetch,
  request,
  toast,
  setTimeout,
  clearTimeout,
  getMap,
  getLayer,
  getSnapshot,
  getFollowLink,
  getShowLink,
  onLivePositionChanged,
  onSaveModified,
}) {
  let liveState = null,
    liveTimer = null,
    pollingLive = false,
    disposed = false,
    showGamePins = true,
    pinsLayerGroup = null,
    pendingPinTarget = null;

  function isLiveActive() {
    return liveState?.status === "connected" || liveState?.status === "bridge";
  }

  function getLiveState() {
    return liveState;
  }

  function getEffectiveLinkPose() {
    if (isLiveActive() && liveState?.playerPosition) {
      return {
        position: liveState.playerPosition,
        yaw: liveState.playerYaw ?? null,
        isLive: true,
        processName: liveState.processName || "totk.exe",
      };
    }

    const snap = getSnapshot();
    const mapPos = snap?.playerContext?.mapPosition || null;

    return {
      position: mapPos,
      yaw: snap?.mapMarkers?.playerYaw ?? null,
      isLive: false,
      processName: "",
    };
  }

  function getEffectiveMarkers() {
    const snap = getSnapshot();
    const fromSave = snap?.mapMarkers || {};
    const pins =
      isLiveActive() && Array.isArray(liveState?.pins)
        ? liveState.pins
        : fromSave.pins || [];
    const stamps =
      isLiveActive() && Array.isArray(liveState?.stamps)
        ? liveState.stamps
        : fromSave.stamps || [];
    const warpMarkers = fromSave.warpMarkers || [];

    return { pins, stamps, warpMarkers };
  }

  function initMapLayers(map) {
    if (!map) return;
    map.createPane("gamePins").style.zIndex = 615;
    pinsLayerGroup = L.layerGroup().addTo(map);
    map.on("contextmenu", (event) => {
      const layer = getLayer();
      const defaultY = layer === "depths" ? -200 : layer === "sky" ? 1050 : 120;
      openPinPopover({
        position: {
          x: Math.round(event.latlng.lng),
          y: defaultY,
          z: Math.round(-event.latlng.lat),
        },
        slot: "auto",
      });
    });
  }

  function renderGameMarkers() {
    if (!pinsLayerGroup) return;
    pinsLayerGroup.clearLayers();
    if (!showGamePins) return;

    const currentLayer = getLayer();
    const { pins, stamps, warpMarkers } = getEffectiveMarkers();

    for (const warp of warpMarkers) {
      if (!inLayer(warp, currentLayer)) continue;

      const title = t("Teletransportador #{slot}", { slot: warp.slot + 1 });
      const icon = L.divIcon({
        className: "game-warp-marker",
        html: "<span>✦</span>",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const marker = L.marker(ll(warp.position), {
        icon,
        title,
        alt: title,
        pane: "gamePins",
      });
      marker.bindTooltip(
        esc(title) +
          "<br><small>" +
          esc(coordinateString(warp.position)) +
          "</small>",
        { direction: "top" },
      );
      pinsLayerGroup.addLayer(marker);
    }

    for (const stamp of stamps) {
      if (stamp.layer !== currentLayer) continue;

      const meta = STAMP_LABELS[stamp.type] || STAMP_LABELS.Star;
      const title = t("Sello: {type} #{slot}", {
        type: t(meta.labelKey),
        slot: stamp.slot + 1,
      });
      const icon = L.divIcon({
        className: "game-stamp-marker",
        html: `<span>${meta.symbol}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const marker = L.marker(ll(stamp.position), {
        icon,
        title,
        alt: title,
        pane: "gamePins",
      });
      marker.bindTooltip(
        esc(title) +
          "<br><small>" +
          esc(coordinateString(stamp.position)) +
          "</small>",
        { direction: "top" },
      );
      pinsLayerGroup.addLayer(marker);
    }

    for (const pin of pins) {
      if (!inLayer(pin, currentLayer)) continue;

      const style = pinStyleFor(pin.color);
      const colorName = t(style.labelKey);
      const title = t("Baliza {color} #{slot}", {
        color: colorName,
        slot: pin.slot + 1,
      });
      const icon = L.divIcon({
        className: `game-pin-marker pin-${pin.color.toLowerCase()}`,
        html: `<span style="--pin-color:${style.hex}"><i>${pin.slot + 1}</i></span>`,
        iconSize: [28, 34],
        iconAnchor: [14, 30],
      });
      const marker = L.marker(ll(pin.position), {
        icon,
        title,
        alt: title,
        pane: "gamePins",
      });
      marker.bindTooltip(
        esc(title) +
          "<br><small>" +
          esc(coordinateString(pin.position)) +
          "</small>",
        { direction: "top" },
      );
      marker.on("click", () => {
        openPinPopover({
          position: pin.position,
          slot: pin.slot,
          existingColor: pin.color,
        });
      });
      pinsLayerGroup.addLayer(marker);
    }
  }

  function updateLiveUi() {
    const toggle = $("recompLiveToggle");
    const info = $("recompLiveInfo");
    const rescanBtn = $("recompRescan");
    const badge = $("recompLiveBadge");

    const enabled = Boolean(liveState?.enabled);
    const active = isLiveActive();
    const proc = liveState?.processName || "totk.exe";

    if (toggle) toggle.checked = enabled || active;
    if (rescanBtn) rescanBtn.disabled = !enabled && !active;

    if (info) {
      info.textContent = active
        ? t("● Conectado en vivo a {process}", { process: proc })
        : enabled
          ? t("◌ Buscando totk.exe en ejecución…")
          : t("Sincronización en vivo desactivada.");
      info.classList.toggle("live", active);
    }

    if (badge) {
      badge.hidden = !enabled && !active;
      badge.dataset.state = active ? "connected" : "searching";
      badge.textContent = active
        ? t("Recomp Live · {process}", { process: proc })
        : t("Recomp Live · buscando totk.exe…");
    }
  }

  function scheduleLivePoll() {
    clearTimeout(liveTimer);
    if (disposed) return;

    const fast = Boolean(liveState?.enabled || isLiveActive());
    liveTimer = setTimeout(() => pollLive(), fast ? 250 : 60000);
  }

  async function pollLive() {
    if (disposed || pollingLive) return;
    pollingLive = true;

    try {
      const response = await fetch("api/live", { cache: "no-store" });

      if (!response.ok) throw Error();

      const next = await response.json();

      if (!next || typeof next.status !== "string") return;

      const prevPos = liveState?.playerPosition;
      const prevUpdated = liveState?.updatedAt;
      const prevStatus = liveState?.status;

      liveState = next;
      updateLiveUi();

      if (next.updatedAt !== prevUpdated || next.status !== prevStatus) {
        renderGameMarkers();
        onLivePositionChanged?.({
          moved:
            Boolean(next.playerPosition) &&
            (next.playerPosition.x !== prevPos?.x ||
              next.playerPosition.y !== prevPos?.y ||
              next.playerPosition.z !== prevPos?.z),
        });
      }
    } catch {
      // Ignore transient poll errors; main state poll reports disconnect.
    } finally {
      pollingLive = false;
      scheduleLivePoll();
    }
  }

  function openPinPopover({ position, slot = "auto", existingColor = null }) {
    const popover = $("pinPopover");

    if (!popover || !position) return;
    pendingPinTarget = { position, slot, existingColor };
    $("pinPopoverCoords").textContent = coordinateString(position);
    const removeBtn = $("removeGamePin");

    if (removeBtn) {
      removeBtn.hidden = slot === "auto" && !existingColor;
    }
    popover.hidden = false;
  }

  function closePinPopover() {
    const popover = $("pinPopover");

    if (popover) popover.hidden = true;
    pendingPinTarget = null;
  }

  async function submitPin(color) {
    if (!pendingPinTarget) return;

    const target = pendingPinTarget;
    closePinPopover();

    try {
      const response = await fetch("api/set-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot: target.slot,
          color,
          position: target.position,
        }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to place pin.");
      }

      if (data.live) {
        liveState = data.live;
        updateLiveUi();
      }

      if (data.appliedTo === "save") {
        await onSaveModified?.();
      }
      renderGameMarkers();

      if (color === "Invalid") {
        toast(
          data.appliedTo === "save"
            ? t("Baliza eliminada en progress.sav.")
            : t("Baliza eliminada en TotK Recomp."),
        );
      } else {
        const colorLabel = t(pinStyleFor(color).labelKey);
        toast(
          data.appliedTo === "save"
            ? t(
                "Baliza {color} guardada en progress.sav (con copia de seguridad).",
                { color: colorLabel },
              )
            : t("Baliza {color} enviada a TotK Recomp en vivo.", {
                color: colorLabel,
              }),
        );
      }
    } catch (err) {
      toast(err.message);
    }
  }

  function bindControls() {
    if ($("recompLiveToggle")) {
      $("recompLiveToggle").onchange = async () => {
        const enable = $("recompLiveToggle").checked;

        try {
          await request(enable ? "api/live-on" : "api/live-off", {
            method: "POST",
            body: "",
          });
          await pollLive();
        } catch (err) {
          toast(err.message);
        }
      };
    }

    if ($("recompRescan")) {
      $("recompRescan").onclick = async () => {
        try {
          await request("api/live-rescan", { method: "POST", body: "" });
          await pollLive();
        } catch (err) {
          toast(err.message);
        }
      };
    }

    if ($("showGamePins")) {
      $("showGamePins").onchange = () => {
        showGamePins = $("showGamePins").checked;
        renderGameMarkers();
      };
    }

    if ($("closePinPopover")) {
      $("closePinPopover").onclick = closePinPopover;
    }

    if ($("removeGamePin")) {
      $("removeGamePin").onclick = () => submitPin("Invalid");
    }

    document.querySelectorAll("[data-pin-color]").forEach((btn) => {
      btn.onclick = () => submitPin(btn.dataset.pinColor);
    });

    if ($("recompLiveBadge")) {
      $("recompLiveBadge").onclick = () => {
        const map = getMap();
        const pose = getEffectiveLinkPose();

        if (map && getShowLink() && pose.position) {
          const targetLayer = playerLayer(pose.position);

          if (targetLayer !== getLayer()) {
            document.querySelector(`[data-layer="${targetLayer}"]`)?.click();
          }
          map.setView(ll(pose.position), Math.max(map.getZoom(), -1));
        }
      };
    }

    pollLive();
  }

  function dispose() {
    disposed = true;
    clearTimeout(liveTimer);
  }

  return {
    initMapLayers,
    bindControls,
    renderGameMarkers,
    getEffectiveLinkPose,
    getLiveState,
    openPinPopover,
    closePinPopover,
    pollLive,
    dispose,
    get isFollowingLive() {
      return Boolean(getShowLink() && getFollowLink() && isLiveActive());
    },
  };
}
