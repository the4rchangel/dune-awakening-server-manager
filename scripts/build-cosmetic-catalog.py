#!/usr/bin/env python3
"""Build public/data/cosmetic-catalog.json from game pak strings + known unlock IDs."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "cosmetic-catalog.json"
DEFAULT_PAK = Path(
    "/mnt/c/Program Files (x86)/Steam/steamapps/common/DuneAwakening/DuneSandbox/Content/Paks/Systems.pak"
)

# Hand-curated labels for IDs that auto-label poorly (from live DB / prior testing).
MANUAL: dict[str, tuple[str, str]] = {
    "AllDyepackChoam": ("CHOAM Dye Pack", "Dye Packs"),
    "AllDyepackMaula": ("Maula Dye Pack", "Dye Packs"),
    "AllDyePackBonusUniversal01": ("Universal Bonus Dye Pack", "Dye Packs"),
    "RedDesertGlobal": ("Red Desert Global Dye", "Dye Packs"),
    "SmugglerGlobal": ("Smuggler Global Dye", "Dye Packs"),
    "Watershippers Global": ("Watershippers Global Dye", "Dye Packs"),
    "FVehDyePackUltimate01": ("Ultimate Vehicle Dye Pack", "Dye Packs"),
    "SandbikeDyePackDeluxe01": ("Deluxe Sandbike Dye Pack", "Dye Packs"),
    "SunsetDyeGlobal": ("Sunset Global Dye", "Dye Packs"),
    "Beta_Sword": ("Beta Sword Skin", "Weapon Skins"),
    "MTX_Frameblade_Knife": ("Frameblade Knife Skin", "Weapon Skins"),
    "MTX_Smuggler_Kindjal": ("Smuggler Kindjal Skin", "Weapon Skins"),
    "MTX_Smug_Rifle": ("Smuggler Rifle Skin", "Weapon Skins"),
    "MTX_Taligari_Rifle": ("Taligari Rifle Skin", "Weapon Skins"),
    "MTX_Taligari_SMG": ("Taligari SMG Skin", "Weapon Skins"),
    "MTX_GunnerSniper_Rifle": ("Gunner Sniper Rifle Skin", "Weapon Skins"),
    "MTX_Gunner_Battlerifle": ("Gunner Battle Rifle Skin", "Weapon Skins"),
    "MTX_WaterS_Drillshot": ("Water Shipper Drillshot Skin", "Weapon Skins"),
    "MTX_WaterS_Rapier": ("Water Shipper Rapier Skin", "Weapon Skins"),
    "MTX_WaterS_Light_Orni": ("Water Shipper Light Ornithopter", "Vehicle Skins"),
    "MTX_Buggy_Nomad": ("Nomad Buggy Skin", "Vehicle Skins"),
    "MTX_WaterFat_Ornithopter_01": ("Water Fat Ornithopter Skin", "Vehicle Skins"),
}

FACTIONS = {
    "Atre": "Atreides",
    "Atreides": "Atreides",
    "Hark": "Harkonnen",
    "Harkonnen": "Harkonnen",
    "Choam": "CHOAM",
    "CHOAM": "CHOAM",
    "Frem": "Fremen",
    "Fremen": "Fremen",
    "Smug": "Smuggler",
    "Smuggler": "Smuggler",
    "Ecaz": "Ecaz",
    "Morit": "Moritani",
    "Moritani": "Moritani",
    "Agrosaz": "Agrosaz",
    "Alexin": "Alexin",
    "Dyvetz": "Dyvetz",
    "Hagal": "Hagal",
    "Hurata": "Hurata",
    "Imota": "Imota",
    "Kenola": "Kenola",
    "Kirab": "Kirab",
    "Lindaren": "Lindaren",
    "MaasK": "Maas K",
    "Maros": "Maros",
    "Maula": "Maula",
    "Mikarrol": "Mikarrol",
    "Mutelli": "Mutelli",
    "Novebruns": "Novebruns",
    "Ordos": "Ordos",
    "PolarGuards": "Polar Guards",
    "RedD": "Red Duke",
    "Richese": "Richese",
    "SandF": "Sand Fisher",
    "Scav": "Scavenger",
    "Slav": "Slav",
    "SmugTech": "Smuggler Tech",
    "Sor": "Sor",
    "Spinette": "Spinette",
    "Talgari": "Taligari",
    "Taligari": "Taligari",
    "Thorvald": "Thorvald",
    "Tseida": "Tseida",
    "Varota": "Varota",
    "Vernius": "Vernius",
    "Wallach": "Wallach",
    "WaterFat": "Water Fat",
    "WaterS": "Water Shipper",
    "Wayku": "Wayku",
    "Wydras": "Wydras",
    "Graben": "Graben",
    "Sard": "Sardaukar",
    "Sardaukar": "Sardaukar",
    "Gunner": "Gunner",
    "Frameblade": "Frameblade",
    "Nomad": "Nomad",
    "Ultimate": "Ultimate",
    "Universal": "Universal",
    "Bonus": "Bonus",
    "Deluxe": "Deluxe",
    "Frem": "Fremen",
}

PIECES = {
    "Top": "Chest",
    "Bottom": "Pants",
    "Bottoms": "Pants",
    "Boots": "Boots",
    "Gloves": "Gloves",
    "Helmet": "Helmet",
    "Headwear": "Helmet",
    "Footwear": "Boots",
}

ARMOR_WORDS = (
    "Armor", "Stillsuit", "Scout", "Assault", "Heavy", "Light", "Formal",
    "Trenchcoat", "MovieSuit", "Caladan", "Garment", "Cloth",
)
WEAPON_WORDS = (
    "Rifle", "SMG", "Knife", "Kindjal", "Drillshot", "Rapier", "Sword",
    "Pistol", "Shotgun", "Battlerifle", "Sniper", "Fireballer", "Minotaur",
    "Frameblade", "Orni", "Ornithopter",
)
VEHICLE_PAINT_WORDS = (
    "Buggy", "Sandbike", "Ornithopter", "Sandcrawler", "Transport", "1MGC", "Orni",
)
TYPO = re.compile(
    r"(Ornitopther|TransportOrnithop$|HeavyArmorlmet|HeavyArmor_Bot$|LightArmor_Bot$|"
    r"Atreula_|hkula_|_Bot$|Hkula_|Smug_Ornithopter_Transport$)",
    re.I,
)
VEHICLE_WORDS = (
    "Buggy", "Sandbike", "Ground", "Flying", "Orni", "Ornithopter",
    "CargoContainer", "Vehicle", "Sandcrawler", "Transport",
)

NOISE = re.compile(
    r"(_DESC$|_NAME$|_Data$|_MeshData$|_Icon$|_Texture$|_Material$|"
    r"GUI|Widget|Blueprint|Placeable|Preview|Banner|Store|Bundle|Popup|"
    r"Emote|Quest|NPC|Audio|Anim|Sequence|Shader|Physics|Skeleton|"
    r"Variant_Data|Placeholder|DebugRGB|Patent|Placable|Localization|"
    r"StringTable|Loc_|Tooltip|Thumbnail|Loading|Cinematic|VO_|FX_|VFX)",
    re.I,
)


def grep_ids(pattern: str, pak: Path) -> set[str]:
    if not pak.is_file():
        return set()
    proc = subprocess.run(
        ["grep", "-a", "-oE", pattern, str(pak)],
        capture_output=True,
        text=True,
        check=False,
    )
    return {line.strip() for line in proc.stdout.splitlines() if line.strip()}


def is_noise(cid: str) -> bool:
    if len(cid) < 4 or cid.endswith("_"):
        return True
    if cid.startswith("DA_"):
        return True
    if TYPO.search(cid):
        return True
    if NOISE.search(cid):
        return True
    if cid.count("_") < 1 and cid not in MANUAL:
        return True
    return False


def unlock_mode(cid: str) -> str:
    """Swatch_* are inventory consumables — not customization-library unlock IDs."""
    if cid.startswith("Swatch_"):
        return "inventory"
    return "customization"


def categorize(cid: str) -> str:
    if cid.startswith("DyePack_") or "Dyepack" in cid or "DyePack" in cid or cid.endswith("Global"):
        return "Dye Packs"
    if cid.startswith("VehicleVariant_"):
        return "Vehicle Variants"
    if cid.startswith("MaterialVariant_"):
        if any(w in cid for w in VEHICLE_PAINT_WORDS) and not any(w in cid for w in ARMOR_WORDS):
            return "Vehicle Paints"
        if any(w in cid for w in WEAPON_WORDS):
            return "Weapon Paints"
        if any(w in cid for w in ARMOR_WORDS):
            return "Armor Paints"
        return "Material Variants"
    if cid.startswith("Swatch_Vehicle_"):
        return "Swatch Tokens (Inventory)"
    if cid.startswith("Swatch_Wpn_"):
        return "Swatch Tokens (Inventory)"
    if cid.startswith("Swatch_Cloth_"):
        return "Swatch Tokens (Inventory)"
    if cid.startswith("Swatch_"):
        return "Swatch Tokens (Inventory)"
    upper = cid.upper()
    if any(w.upper() in upper for w in VEHICLE_WORDS) and "Armor" not in cid:
        if cid.endswith("_MeshVariant"):
            return "Vehicle Skins"
        return "Vehicle Skins"
    if any(w in cid for w in WEAPON_WORDS) and not cid.endswith("_MeshVariant"):
        return "Weapon Skins"
    if cid.endswith("_MeshVariant") or any(w in cid for w in ARMOR_WORDS):
        return "Armor Skins"
    if cid.startswith("WaterS_") or cid.startswith("Beta_"):
        if any(w in cid for w in WEAPON_WORDS):
            return "Weapon Skins"
        return "Armor Skins"
    if cid.startswith("MTX_"):
        return "Premium (MTX)"
    return "Other"


def expand_token(token: str) -> str:
    if token in FACTIONS:
        return FACTIONS[token]
    if token in PIECES:
        return PIECES[token]
    if token.isupper() and len(token) <= 4:
        return token
    # CamelCase / acronym boundaries
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", token)
    spaced = spaced.replace("_", " ")
    return spaced.strip()


def auto_label(cid: str) -> str:
    if cid in MANUAL:
        return MANUAL[cid][0]

    body = cid
    if body.startswith("MTX_"):
        body = body[4:]
    if body.startswith("DyePack_"):
        faction = body[len("DyePack_") :]
        return f"{expand_token(faction)} Dye Pack"
    if body.startswith("Swatch_Vehicle_"):
        rest = body[len("Swatch_Vehicle_") :].replace("_", " ")
        return f"Vehicle Swatch Token — {rest}"
    if body.startswith("Swatch_Wpn_"):
        rest = body[len("Swatch_Wpn_") :].replace("_", " ")
        return f"Weapon Swatch Token — {rest}"
    if body.startswith("Swatch_Cloth_"):
        rest = body[len("Swatch_Cloth_") :].replace("_", " ")
        return f"Armor Swatch Token — {rest}"
    if body.startswith("MaterialVariant_"):
        body = body[len("MaterialVariant_") :]
        label = " ".join(expand_token(t) for t in body.split("_") if t)
        return f"{label} Paint"
    if body.startswith("VehicleVariant_"):
        body = body[len("VehicleVariant_") :]
        label = " ".join(expand_token(t) for t in body.split("_") if t)
        return f"{label} Vehicle Variant"
    if body.endswith("_MeshVariant"):
        body = body[: -len("_MeshVariant")]

    tokens = [t for t in body.split("_") if t]
    words = [expand_token(t) for t in tokens]
    label = " ".join(words)

    if categorize(cid) == "Weapon Skins" and "Skin" not in label:
        label += " Skin"
    if categorize(cid) == "Vehicle Skins" and "Skin" not in label and "Ornithopter" not in label:
        label += " Skin"
    return label


def should_include(cid: str) -> bool:
    if is_noise(cid):
        return False
    if cid in MANUAL:
        return True
    if cid.startswith("MaterialVariant_") or cid.startswith("VehicleVariant_"):
        return True
    if cid.startswith("Swatch_"):
        return True
    if cid.startswith("DyePack_") or cid.endswith("Global") or "Dyepack" in cid or "DyePack" in cid:
        return True
    if cid.endswith("_MeshVariant"):
        return True
    if cid.startswith("MTX_"):
        if cid.endswith("_MeshVariant"):
            return True
        if any(w in cid for w in WEAPON_WORDS + VEHICLE_WORDS):
            return True
        if any(w in cid for w in ARMOR_WORDS) and any(p in cid for p in PIECES):
            return True
        return False
    if cid.startswith("WaterS_") or cid.startswith("Beta_"):
        return True
    return False


def prefer_mesh_variant(ids: set[str]) -> set[str]:
    """Drop base armor IDs when a MeshVariant sibling exists."""
    out = set(ids)
    for cid in list(ids):
        if cid.endswith("_MeshVariant"):
            base = cid[: -len("_MeshVariant")]
            if base in out and categorize(base) == "Armor Skins":
                out.discard(base)
        elif any(p in cid for p in PIECES) and f"{cid}_MeshVariant" in out:
            out.discard(cid)
    return out


def collect_ids(pak: Path) -> set[str]:
    ids: set[str] = set(MANUAL.keys())
    ids |= grep_ids(r"[A-Za-z0-9_]+_MeshVariant", pak)
    ids |= grep_ids(r"MTX_[A-Za-z][A-Za-z0-9_]{4,80}", pak)
    ids |= grep_ids(r"MaterialVariant_[A-Za-z0-9_]+", pak)
    ids |= grep_ids(r"VehicleVariant_[A-Za-z0-9_]+", pak)
    ids |= grep_ids(r"Swatch_[A-Za-z0-9_]+", pak)
    ids |= grep_ids(
        r"(AllDyepack[A-Za-z0-9_]+|AllDyePack[A-Za-z0-9_]+|"
        r"RedDesertGlobal|SmugglerGlobal|SunsetDyeGlobal|"
        r"FVehDyePack[A-Za-z0-9_]+|SandbikeDyePack[A-Za-z0-9_]+|DyePack_[A-Za-z0-9_]+)",
        pak,
    )
    ids |= grep_ids(r"(WaterS_[A-Za-z0-9_]+|Beta_Sword)", pak)
    ids = {i for i in ids if should_include(i)}
    return prefer_mesh_variant(ids)


def build_catalog(pak: Path) -> dict:
    ids = collect_ids(pak)
    cosmetics: dict[str, dict[str, str]] = {}
    for cid in sorted(ids, key=str.lower):
        if cid in MANUAL:
            name, category = MANUAL[cid]
        else:
            name = auto_label(cid)
            category = categorize(cid)
        cosmetics[cid] = {
            "name": name,
            "category": category,
            "unlock": unlock_mode(cid),
        }

    unlockable = sum(1 for c in cosmetics.values() if c["unlock"] == "customization")
    return {
        "_meta": {
            "total": len(cosmetics),
            "unlockable": unlockable,
            "source": "Dune Awakening Systems.pak string extraction + curated unlock IDs",
            "pak": str(pak) if pak.is_file() else "not found — used curated subset only",
        },
        "cosmetics": cosmetics,
    }


def main() -> int:
    pak = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PAK
    data = build_catalog(pak)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({data['_meta']['total']} cosmetics)")
    cats: dict[str, int] = {}
    for info in data["cosmetics"].values():
        cats[info["category"]] = cats.get(info["category"], 0) + 1
    for cat, n in sorted(cats.items(), key=lambda x: (-x[1], x[0])):
        print(f"  {cat}: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
