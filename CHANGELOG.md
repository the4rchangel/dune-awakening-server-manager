# Changelog

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
