import { cleanup, fireEvent, render } from "@testing-library/react";
import L from "leaflet";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "../../web/src/app/components/Sidebar.jsx";
import { MapPanel } from "../../web/src/features/map/MapPanel.jsx";
import { createLivePinController } from "../../web/src/features/map/live-pins.js";
import { I18N } from "../../web/src/shared/i18n.js";

afterEach(() => {
  cleanup();
});

describe("TotK Recomp Live Sync & Map Pin Picker UI", () => {
  it("displays live connection status, renders in-game pins and sends right-click pins to TotK Recomp", async () => {
    I18N.setLanguage("en");
    render(
      <>
        <Sidebar />
        <MapPanel hidden={false} />
      </>,
    );

    const realMap = L.map(document.getElementById("map"), {
      crs: L.CRS.Simple,
      center: [0, 0],
      zoom: 0,
      zoomControl: false,
      attributionControl: false,
    });

    const setPinCalls = [];
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === "api/live") {
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            supported: true,
            status: "connected",
            pid: 9001,
            processName: "totk.exe",
            canWriteMemory: true,
            playerPosition: { x: 320, y: 135, z: -210 },
            playerYaw: 0.5,
            pins: [
              {
                slot: 0,
                color: "Blue",
                position: { x: 100, y: 120, z: -150 },
              },
            ],
            stamps: [],
            updatedAt: "2026-11-26T20:00:00.000Z",
          }),
        };
      }
      if (url === "api/set-pin") {
        const body = JSON.parse(opts.body);
        setPinCalls.push(body);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            appliedTo: "memory",
            slot: 1,
            color: body.color,
            live: {
              enabled: true,
              status: "connected",
              processName: "totk.exe",
              pins: [
                {
                  slot: 1,
                  color: body.color,
                  position: body.position,
                },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const toasts = [];
    const timers = new Set();
    const ctrl = createLivePinController({
      $: (id) => document.getElementById(id),
      t: (k, v) => I18N.t(k, v),
      fetch: fetchMock,
      request: fetchMock,
      toast: (msg) => toasts.push(msg),
      setTimeout: (fn, ms) => {
        const id = globalThis.setTimeout(fn, ms);
        timers.add(id);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
        globalThis.clearTimeout(id);
      },
      getMap: () => realMap,
      getLayer: () => "surface",
      getSnapshot: () => null,
      getFollowLink: () => true,
      getShowLink: () => true,
    });

    try {
      ctrl.initMapLayers(realMap);
      ctrl.bindControls();
      await new Promise((r) => setTimeout(r, 40));

      const badge = document.getElementById("recompLiveBadge");
      expect(badge.hidden).toBe(false);
      expect(badge.textContent).toContain("Recomp Live · totk.exe");
      expect(document.getElementById("recompLiveInfo").textContent).toContain(
        "Connected live to totk.exe",
      );
      expect(document.querySelector(".game-pin-marker")).not.toBeNull();

      // Right-click on map opens the pin color picker popover
      realMap.fire("contextmenu", { latlng: L.latLng(780, 450) });
      const popover = document.getElementById("pinPopover");
      expect(popover.hidden).toBe(false);

      fireEvent.click(document.getElementById("pinPopoverTitle"));
      expect(popover.hidden).toBe(false);
      fireEvent.click(document.getElementById("map"));
      expect(popover.hidden).toBe(true);
      expect(setPinCalls).toHaveLength(0);
      realMap.fire("contextmenu", { latlng: L.latLng(780, 450) });

      // Click Red pin button -> sends POST api/set-pin
      const redBtn = document.querySelector('[data-pin-color="Red"]');
      fireEvent.click(redBtn);
      await new Promise((r) => setTimeout(r, 40));

      expect(setPinCalls).toHaveLength(1);
      expect(setPinCalls[0]).toEqual({
        slot: "auto",
        color: "Red",
        position: { x: 450, y: 120, z: -780 },
      });
      expect(toasts[0]).toContain("Red pin sent to TotK Recomp live.");
    } finally {
      ctrl.dispose();
      realMap.remove();
      for (const id of timers) globalThis.clearTimeout(id);
    }
  });
});
