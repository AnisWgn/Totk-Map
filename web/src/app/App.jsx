import { useEffect } from "react";

import { Sidebar } from "./components/Sidebar.jsx";
import { Workspace } from "./components/Workspace.jsx";
import { Dialogs } from "./components/Dialogs.jsx";
import { createAppController } from "./controller.js";

export function App({ store, config }) {
  useEffect(() => {
    const electron = window.electronAPI;

    if (!electron?.isElectron) return undefined;

    const docEl = document.documentElement;
    const platformClass = `electron-${electron.platform || "win32"}`;
    docEl.classList.add("is-electron", platformClass);

    return () => {
      docEl.classList.remove("is-electron", platformClass);
    };
  }, []);

  useEffect(() => createAppController(store, config), [store, config]);

  return (
    <>
      <Sidebar />

      <Workspace store={store} />

      <Dialogs />
    </>
  );
}
