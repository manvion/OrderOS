#!/bin/sh
# Download (once) a regional OpenStreetMap extract, preprocess it (once), then serve.
#
# OSRM_PBF_URL  — a Geofabrik-style .osm.pbf covering your delivery area, e.g.
#                 https://download.geofabrik.de/north-america/canada/quebec-latest.osm.pbf
#                 Pick the SMALLEST region that covers where you deliver: the smaller the
#                 extract, the less RAM/disk the preprocessing needs and the faster it is.
# OSRM_PROFILE  — routing profile (default car). One of car / bicycle / foot.
set -e

DATA_DIR=/data
PBF="$DATA_DIR/region.osm.pbf"
OSRM="$DATA_DIR/region.osrm"
PROFILE="/opt/${OSRM_PROFILE:-car}.lua"
READY="$DATA_DIR/.ready"

mkdir -p "$DATA_DIR"

if [ ! -f "$PBF" ]; then
  if [ -z "$OSRM_PBF_URL" ]; then
    echo "OSRM_PBF_URL is not set. Point it at a regional .osm.pbf (e.g. Geofabrik)." >&2
    exit 1
  fi
  echo "==> Downloading extract: $OSRM_PBF_URL"
  wget --no-verbose -O "$PBF" "$OSRM_PBF_URL"
fi

# Preprocess once. `.ready` is written only after customize finishes, so an interrupted
# preprocess (container killed mid-build) is retried rather than served half-done.
if [ ! -f "$READY" ]; then
  echo "==> Preprocessing with $PROFILE (extract -> partition -> customize)"
  osrm-extract -p "$PROFILE" "$PBF"
  osrm-partition "$OSRM"
  osrm-customize "$OSRM"
  touch "$READY"
  echo "==> Preprocessing complete"
fi

echo "==> Serving osrm-routed (MLD) on :5000"
exec osrm-routed --algorithm mld --port 5000 "$OSRM"
