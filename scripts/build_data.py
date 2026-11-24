#!/usr/bin/env python3
"""Build data/places.json from the GTADB landmarks dataset.

Source: https://map.gtadb.org (GTA VI Landmarks Data, CC BY 4.0, gtadb.org and
all contributors). Run from the repository root:

    python3 scripts/build_data.py            # download fresh data, then build
    python3 scripts/build_data.py --offline  # rebuild from data/source/

Every matched place in Greater Miami is kept (see BBOX), except homes known
only by a street address, which may be private residences. Places without an
in-game name get "named": false; tours only use properly named places.
"""
import json
import math
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "source" / "gtadb_landmarks.json"
OUT = ROOT / "data" / "places.json"
API = "https://map.gtadb.org/api"

# Greater Miami: south, north, west, east
BBOX = (25.55, 26.0, -80.5, -80.08)

# Names that describe a thing rather than name a place.
GENERIC = {
    "bridge", "parking lot", "gas station", "bus stop", "metro station",
    "parking garage", "lake", "construction site", "park", "runway",
    "tennis court", "church", "public restrooms", "lifeguard tower",
    "empty lot", "covered parking lot", "marina", "fire station", "canal",
    "docks", "electrical", "fence", "hospital", "interchange", "lighthouse",
    "pharmacy", "pool", "railyard", "riverbank", "sculpture", "boardwalk",
    "copyshop", "casino", "farmacia", "piano", "car park", "car wash",
    "electric substation",
}

STREET = re.compile(r"\b(Dr|St|Ave|Blvd|Rd|Way|Hwy|Cswy|Ln|Ct|Pl|Ter|Cir)$")

# GTADB type -> our category (first match wins, in this order)
CATEGORIES = [
    ("hotel", {"hotel"}),
    ("nightlife", {"#nightclub", "#stripclub", "#bar", "#drinks"}),
    ("food", {"restaurant", "#food"}),
    ("shop", {"retail", "#supermarket", "supermarket", "#clothes", "#shoes",
              "#guns", "#hair", "#tattoos", "#electronics", "#pharmacy",
              "#bikeshop", "#gas", "#modshop", "#pay'n'spray", "#carwash"}),
    ("leisure", {"leisure", "events", "landmark", "#racetrack", "#golf",
                 "#gym", "#cinema", "#tennis", "#ferriswheel", "recreation",
                 "point-of-interest"}),
    ("transport", {"transportation", "#airport", "#metromover", "#metro",
                   "#train", "#bus", "#marina", "#airbase"}),
    ("civic", {"government", "public", "#police", "#hospital", "#jail"}),
    ("work", {"office", "industrial", "utilities", "construction",
              "agriculture", "service"}),
    ("home", {"residential", "#safehouse"}),
    ("nature", {"natural"}),
]

TOURS = [
    {"id": "ocean-drive",
     "title": {"en": "Ocean Drive Art Deco", "fr": "L'Art déco d'Ocean Drive"},
     "blurb": {"en": "The pastel hotel strip of Ocean Beach, south to north.",
               "fr": "Les hôtels pastel d'Ocean Beach, du sud au nord."},
     "match": lambda p: "Ocean Dr" in p["real"]["address"], "sort": "north"},
    {"id": "bayfront",
     "title": {"en": "Downtown bayfront", "fr": "Le front de mer de Downtown"},
     "blurb": {"en": "Arena, opera house, market and the big wheel along Biscayne Bay.",
               "fr": "Arena, opéra, marché et grande roue le long de la baie de Biscayne."},
     "match": lambda p: p["district"] in ("Shoreline", "Bayside", "Downtown")
     and p["real"]["name"] and "Biscayne Blvd" in p["real"]["address"],
     "sort": "north"},
    {"id": "tequesta",
     "title": {"en": "Tequesta skyline", "fr": "Les tours de Tequesta"},
     "blurb": {"en": "Brickell's banks and towers, renamed.",
               "fr": "Les banques et gratte-ciel de Brickell, rebaptisés."},
     "match": lambda p: p["district"] in ("Tequesta", "Tequesta Retreat"),
     "sort": "path"},
    {"id": "little-cuba",
     "title": {"en": "Little Cuba", "fr": "Little Cuba"},
     "blurb": {"en": "Calle Ocho and Little Havana, block by block.",
               "fr": "Calle Ocho et Little Havana, rue après rue."},
     "match": lambda p: p["district"] == "Little Cuba", "sort": "path"},
    {"id": "stockyard",
     "title": {"en": "Stockyard street art", "fr": "Le street art de Stockyard"},
     "blurb": {"en": "Wynwood's warehouses and murals.",
               "fr": "Les entrepôts et fresques de Wynwood."},
     "match": lambda p: p["district"] in ("Stockyard", "Vice Decor District"),
     "sort": "path"},
    {"id": "after-dark",
     "title": {"en": "Vice City after dark", "fr": "Vice City by night"},
     "blurb": {"en": "Clubs, bars and casinos.",
               "fr": "Clubs, bars et casinos."},
     "match": lambda p: p["category"] == "nightlife"
     or "casino" in p["name"].lower(), "sort": "path"},
]


def download():
    req = urllib.request.Request(
        API,
        data=json.dumps({"action": "get_landmarks", "game": "6"}).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "LeonidaToMiami-build/1.0"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        data = json.load(res)
    if "landmarks" not in data:
        sys.exit(f"Unexpected GTADB response: {str(data)[:200]}")
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    SOURCE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return data


# Fallback for untyped landmarks: keywords in the game or real name.
KEYWORDS = [
    ("hotel", r"hotel|\binn\b|suites|resort|motel"),
    ("nightlife", r"club|\bbar\b|lounge|casino"),
    ("food", r"caf[eé]|bbq|restaurant|grill|diner|pizza|burger|bean machine|deli|bakery|seafood|taco"),
    ("transport", r"station|garage|parking|airport|hangar|terminal|bridge|tunnel|port\b|marina|shipyard|boatyard"),
    ("civic", r"courthouse|police|community center|library|school|college|church|hospital|museum"),
    ("leisure", r"park\b|plaza|gallery|arena|stadium|field|theat|mural|golf|gym|oceanarium|aquarium"),
    ("home", r"tower|residences|condo|apartments|apts|manor|lofts|villa"),
    ("shop", r"shop|store|market|supermarket|clothing|fashion|footwear|dealership|pawn|tattoo|tires|realty|gadgets|boutique"),
    ("work", r"capital|financial|bank|\bhq\b|center|centre|unlimited|shipping|fm\b"),
]


def category(types, text=""):
    for cat, keys in CATEGORIES:
        if keys & types:
            return cat
    for cat, pattern in KEYWORDS:
        if re.search(pattern, text, re.I):
            return cat
    return "other"


def split_real(address):
    """'Kaseya Center, 601 Biscayne Blvd, Miami, FL 33132, USA' -> name, address"""
    address = re.sub(r",? USA\??$", "", address.rstrip("?").strip())
    parts = [p.strip() for p in address.split(",")]
    if len(parts) > 2 and not parts[0][0].isdigit():
        return parts[0], ", ".join(parts[1:])
    return "", ", ".join(parts)


def distance(a, b):
    lat = math.radians((a[0] + b[0]) / 2)
    dy = (a[0] - b[0]) * 111_320
    dx = (a[1] - b[1]) * 111_320 * math.cos(lat)
    return math.hypot(dx, dy)


def build(landmarks):
    places = []
    for lid, row in landmarks.items():
        ig_address, ig_coords, _, rl_address, rl_coords, _, types = row[:7]
        if not rl_address or not rl_coords:
            continue
        lat, lng = rl_coords
        if not (BBOX[0] < lat < BBOX[1] and BBOX[2] < lng < BBOX[3]):
            continue
        parts = [p.strip() for p in ig_address.split(",")]
        name = parts[0].strip('"').strip()
        named = not re.fullmatch(r"\??\s*(\(.*\))?", name)
        if not named:
            name = ""
        types = set(types)
        if types & {"//doesnt_exist", "//doesnt-exist?", "fictional"}:
            continue
        area = [p for p in parts[1:] if not STREET.search(p)]
        real_name, real_address = split_real(rl_address)
        if not real_name and types & {"residential", "#safehouse"}:
            continue  # address-only home: may be a private residence
        flags = sorted(
            f for f in ("unconfirmed", "demolished", "closed", "enterable")
            if f in types
        )
        if rl_address.rstrip().endswith("?") or parts[0].startswith('"') or "?" in name:
            flags = sorted(set(flags) | {"unconfirmed"})
        places.append({
            "id": lid,
            "name": name,
            "named": named,
            "generic": name.lower() in GENERIC,
            "district": area[0] if area else "",
            "city": area[-1] if len(area) > 1 else "",
            "category": category(types, f"{name} {real_name}"),
            "flags": flags,
            "game": [round(c, 1) for c in ig_coords] if len(ig_coords) == 2 else None,
            "real": {
                "name": real_name,
                "address": real_address,
                "lat": round(lat, 6),
                "lng": round(lng, 6),
            },
        })

    # Collapse repeats of one name on one site (e.g. a dozen aquarium buildings).
    places.sort(key=lambda p: (p["name"], int(p["id"][1:])))
    kept = []
    for p in places:
        if not p["named"] or p["generic"]:
            kept.append(p)
            continue
        dup = next(
            (k for k in kept if k["name"] == p["name"] and distance(
                (k["real"]["lat"], k["real"]["lng"]),
                (p["real"]["lat"], p["real"]["lng"])) < 400),
            None)
        if dup is None:
            kept.append(p)
        elif not dup["real"]["name"] and p["real"]["name"]:
            kept[kept.index(dup)] = p
    return kept


def order(stops, how):
    pos = lambda p: (p["real"]["lat"], p["real"]["lng"])
    if how == "north":
        return sorted(stops, key=pos)
    # nearest-neighbour path starting from the southernmost stop
    rest = sorted(stops, key=pos)
    path = [rest.pop(0)]
    while rest:
        nxt = min(rest, key=lambda p: distance(pos(path[-1]), pos(p)))
        rest.remove(nxt)
        path.append(nxt)
    return path


def build_tours(places):
    tours = []
    for tour in TOURS:
        stops = [p for p in places
                 if p["named"] and not p["generic"] and tour["match"](p)]
        stops = order(stops, tour["sort"])[:14]
        if len(stops) >= 3:
            tours.append({
                "id": tour["id"], "title": tour["title"], "blurb": tour["blurb"],
                "stops": [p["id"] for p in stops],
            })
    return tours


def main():
    if "--offline" in sys.argv:
        data = json.loads(SOURCE.read_text())
    else:
        data = download()
    places = build(data["landmarks"])
    out = {
        "source": "GTA VI Landmarks Data, gtadb.org and all contributors, CC BY 4.0",
        "places": places,
        "tours": build_tours(places),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(places)} places, {len(out['tours'])} tours -> {OUT.relative_to(ROOT)}")
    print("named:", sum(p["named"] for p in places))
    print("categories:", dict(Counter(p["category"] for p in places).most_common()))
    print("tours:", {t["id"]: len(t["stops"]) for t in out["tours"]})


if __name__ == "__main__":
    main()
