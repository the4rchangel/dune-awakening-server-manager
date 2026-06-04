# Changelog

## 1.0.4 — 2026-06-02

### Tech tree — Unlock All Recipes fix

- **Root cause** — The old endpoint only flipped `UnlockedState` on recipes already present in the character save (~128 entries). The in-game tech tree has **356** nodes (`DA_GRP_*` groups + `DA_REC_*` recipes) that were never added to the save, so they stayed locked even after “Unlock All.”
- **`public/data/tech-recipe-catalog.json`** — Full tech node list extracted from game pak files via `tools/Cue4ParsePatents` (regenerate with `dotnet run` in that folder).
- **`POST /api/characters/:id/tech/unlock-all`** — Merges every catalog node into `m_TechKnowledgeData` as `Purchased`, preserves existing `RCP_*` / `BLD_*` save entries, and sets `m_TechKnowledgePoints` to 99999.
- **UI** — Tech Tree badge shows `purchased / in save / in game`; unlock result reports how many nodes were added. Reminder to stop battlegroup and relog after changes.

## 1.0.3 — 2026-06-03

### Incomplete bootstrap repair

- **`needsBootstrap` in `/api/status`** — Detects the “No resources found in funcom-seabass-… namespace” state (VM imported but bootstrap never finished).
- **`POST /api/setup/repair`** — Deletes empty seabass namespace(s) when no battlegroup CR exists, then re-runs bootstrap automatically.
- **Dashboard repair panel** — Yellow banner with token/world/region form when incomplete setup is detected.

## 1.0.2 — 2026-06-03

### Setup — delete and start fresh

- **Setup tab → Delete & Start Fresh** — When pre-flight detects an existing `dune-awakening` VM, a reset panel appears on step 1.
- **`POST /api/setup/reset`** — Stops the battlegroup (if reachable), removes the Hyper-V VM, deletes `DuneAwakeningServer` folders on all drives, removes SSH keys, and clears cached manager state.
- Requires typing **DELETE** to confirm. Re-runs pre-flight automatically after reset so you can walk through the wizard again.

## 1.0.1 — 2026-06-03

### Server finder / WAN visibility fixes

- **Reliable visibility IP writes** — `settings.conf` is now written via base64 over SSH instead of fragile `printf` escaping. Line 4 is what the gateway reads at startup as `GameRmqAddress` when registering with Funcom.
- **Stop then start required** — UI and console now clearly state that visibility changes require a full battlegroup **stop → start** (not just restart-in-place). The gateway only publishes the join address on startup.
- **WAN port-forward guide** — When Public (WAN) or custom public IP is selected in **Game Config → Server Visibility**, a port-forward checklist appears:
  - **31982 TCP** — queue/matchmaking (commonly missed; required for server finder)
  - **Director NodePort TCP** — from your Dashboard (e.g. 31402)
  - **7777–7810 UDP** — game traffic  
  All forwards must target the **VM IP**, not the Windows host.
- **Setup wizard** — Same port-forward notice when choosing a public/custom player IP during initial setup.
- **Experimental tab reminder** — Self-hosted worlds appear under **Servers → Experimental** in the game client, not Official or Private.
- **API** — `GET /api/server-visibility` now returns `directorPort`, `isWan`, and structured `portForward` info. `POST` returns restart guidance.

### Other

- Improved **Server Display Name** field hint in Game Config (empty sietch names can hide servers in the browser).
