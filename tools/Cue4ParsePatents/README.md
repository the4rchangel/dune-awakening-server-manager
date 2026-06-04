# Cue4ParsePatents

Scans Dune Awakening pak files via [CUE4Parse](https://github.com/FabianFG/CUE4Parse) (`GAME_DuneAwakening`) to discover inventory template IDs missing from the wiki-scraped catalog.

## Requirements

- .NET 8 SDK (`~/.dotnet` on WSL; set `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` if `libicu` is missing)
- CUE4Parse source cloned to `~/.cache/CUE4Parse` (NuGet 1.2.2 lacks Dune support)
- Game install: `DuneAwakening/DuneSandbox/Content/Paks`

## Run

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$DOTNET_ROOT:$PATH" DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
cd tools/Cue4ParsePatents
dotnet run -c Release
```

Outputs `vehicle-module-ids.txt`, `missing-vehicle-module-ids.txt`, `da-rec-template-ids.txt`, `item-registry-paths.txt`, etc.

## Central item ID sources (in game files)

| Path | Purpose |
|------|---------|
| `Content/Dune/Systems/Items/BaseItems/DT_BaseItems_*.uasset` | Master item tables (Vehicles, BuildingSets, Placeables, …) |
| `Content/Dune/Systems/Items/CDT_BaseItems.uasset` | Composite table referencing all base item tables |
| `Content/Dune/Systems/TechKnowledge/.../DA_REC_*.uasset` | Tech recipes; row name after `DA_REC_` is often the template ID |
| `Content/Dune/GUI/.../DT_Admin_QuickItems_Presets.uasset` | Admin quick-spawn presets |

Full row export from `DT_BaseItems_*` requires Oodle decompression + UE5 `.usmap` mappings in CUE4Parse (not yet wired up here). Pak string grep on `Systems.pak` works as a fallback for many IDs.
