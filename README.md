# HyruleSync — Client lourd Electron (TOTK Map)

Application desktop autonome (**Electron.js + Node.js + React**) permettant de suivre en temps réel la progression de sauvegarde (`progress.sav`) sur *The Legend of Zelda: Tears of the Kingdom* (formats 1.0, 1.1/1.2 et 1.4 / Recomp), avec carte interactive SD/HD, inventaire, quêtes, encyclopédie et autosync en arrière-plan.

Aucune installation de compilateur C# / `.NET Framework` ni ouverture de navigateur externe n'est requise : le lecteur de sauvegardes, l'autosync, le cache de tuiles HD et l'interface tournent directement dans Electron.

---

## Prérequis

- **Node.js 22.12+** et **npm**

Installation des dépendances :

```bash
npm install
```

---

## Commandes principales

| Commande | Description |
| --- | --- |
| `npm run electron:dev` | Lance le client lourd Electron en mode développement avec rechargement à chaud (Vite HMR + backend Node intégré). |
| `npm start` | Compile l'interface React puis ouvre directement l'application desktop Electron. |
| `npm run electron:build` | Génère les exécutables Windows autonomes dans `outputs/electron/` (**`.exe` portable** + **installateur NSIS**). |
| `npm run check` | Vérifie le code avec ESLint, exécute toute la suite de tests Vitest (React + backend Node + Electron) et compile le bundle web. |

---

## Packaging Windows (`.exe`)

Pour compiler le client lourd Windows prêt à distribuer :

```bash
npm run electron:build
```

Deux fichiers sont générés dans `outputs/electron/` :

1. **`HyruleSync-v1.0.0-portable.exe`** — Version portable sans installation (conserve `.data/` et `.state/` à côté de l'exécutable si le dossier est accessible en écriture).
2. **`HyruleSync-Setup-v1.0.0.exe`** — Installateur Windows classique (raccourcis Bureau / Menu Démarrer, données stockées proprement dans `%APPDATA%\HyruleSync`).

---

## Fonctionnalités intégrées au client lourd

- **Fenêtre desktop native (`BrowserWindow`)** avec thème sombre natif, verrouillage d'instance unique et ouverture sécurisée des guides externes (*Zelda Dungeon*, *GitHub*) dans le navigateur système.
- **Sélecteur de dossier natif Windows** via IPC sécurisé (`preload.cjs` / `contextIsolation`) pour choisir rapidement le dossier de sauvegardes TOTK.
- **Icône dans la zone de notification (System Tray)** permettant d'ouvrir la fenêtre, choisir un dossier de sauvegardes, mettre en pause/reprendre l'Autosync ou garder l'application active en arrière-plan à la fermeture.
- **Lecture 100 % en lecture seule** des fichiers `progress.sav` (aucune sauvegarde n'est jamais modifiée).

---

## Structure Electron

```text
electron/
  main.js                  # Processus principal Electron (fenêtre, tray, instance unique, IPC, liens externes)
  preload.cjs              # Pont sécurisé contextBridge (sélecteurs natifs de dossiers/fichiers)
  copy-web-dist.js         # Préparation du bundle Vite pour le packaging Electron
  server-cli.js            # Lanceur autonome du serveur local Node (tests & aperçu)
  backend/
    index.js               # Serveur local loopback et routes API
    save-reader.js         # Parseur binaire progress.sav (MurmurHash3, GUID 64-bit, coordonnées, sanctuaires)
    readers.js             # Lecteurs d'inventaire, quêtes, encyclopédie, personnages et collections
    catalog.js             # Catalogue des 21 catégories, 152 sanctuaires, 166 coffres et 15 tours
    save-sync.js           # Autosync, gestion des slots et transactions Recomp (save-tx/ready-*)
    save-sources.js        # Exploration de dossiers et détection automatique des comptes
    map-resources.js       # Téléchargement et vérification SHA-256 des ressources de carte (.data/)
    hd-map-tiles.js        # Cache mémoire/disque et validation WebP des tuiles HD ZeldaMods
    locale.js              # Gestion des langues (EN / ES / Auto)
    updates.js             # Vérification des mises à jour GitHub Releases
    page-lifetime.js       # Suivi de session des vues actives
```

Pour plus de détails fonctionnels sur l'utilisation de la carte, consultez [`docs/USAGE.md`](docs/USAGE.md) et [`THIRD_PARTY.md`](THIRD_PARTY.md).
