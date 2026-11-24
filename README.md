# Leonida → Miami

An interactive map that pins the named places of GTA VI's Vice City onto the real map of Greater Miami. Click a pin to see the in-game name next to the real building, with a photo, a Street View link and the in-game view on GTADB.

- 236 named places, filterable by category and Vice City district
- Six themed tours (Ocean Drive, Downtown bayfront, Tequesta, Little Cuba, Stockyard, nightlife)
- Discovery counter saved in the browser
- A shareable link per place (`#/place/L187`) and per tour stop (`#/tour/ocean-drive/3`)
- French and English, picked from the browser language and switchable (`?lang=fr`)

## Run it

It is a static site with no build step. Serve the folder over HTTP:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. To publish, enable GitHub Pages on the repository root.

## Update the data

`data/places.json` is generated from the GTADB landmarks dataset:

```bash
python3 scripts/build_data.py
```

Add `--offline` to rebuild from the saved copy in `data/source/` instead of downloading. The script keeps places inside Greater Miami that have a proper in-game name, drops generic labels such as "Bridge" or "Parking Lot", and builds the tours. Tour definitions and the filtering rules are at the top of the script.

## Where things come from

| What | Source | Licence |
|---|---|---|
| Game ↔ real-life matches | [GTA VI Landmarks Data](https://map.gtadb.org/#VI), gtadb.org and all contributors | CC BY 4.0 |
| Base map | [OpenFreeMap](https://openfreemap.org) tiles, © OpenStreetMap contributors | ODbL |
| Map renderer | [MapLibre GL JS](https://maplibre.org) | BSD-3-Clause |
| Place photos | Wikimedia Commons, looked up in the visitor's browser and credited on each card | per image |

No game screenshots are hosted here; each card links to the GTADB entry for the in-game view.

Matches are community findings, not official information, and some are flagged as unconfirmed. This is an unofficial fan project, not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.
