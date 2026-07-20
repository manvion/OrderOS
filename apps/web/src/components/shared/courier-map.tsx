'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { Map as LeafletMap, Marker, Polyline } from 'leaflet';

export interface MapPoint {
  latitude: number;
  longitude: number;
}

/**
 * The live courier map.
 *
 * Leaflet + OpenStreetMap raster tiles. No API key, no per-view billing, no
 * Google contract — which matters, because this map renders on every delivery
 * order across every restaurant on the platform, and a per-load-priced map is a
 * cost that scales exactly with our success.
 *
 * Leaflet touches `window` on import, so it is loaded dynamically inside an effect
 * rather than at module scope. Importing it at the top would break the server
 * render of the tracking page, which is the one page that MUST render fast on a
 * phone on bad signal.
 *
 * The courier marker is moved rather than recreated on each poll, so the pin
 * glides to its new position instead of blinking out and reappearing somewhere
 * else. That difference is most of what makes a tracking map feel alive.
 */
export function CourierMap({
  restaurant,
  dropoff,
  courier,
  trail,
  brandColor,
  className,
}: {
  restaurant: MapPoint | null;
  dropoff: MapPoint | null;
  courier: MapPoint | null;
  /** Breadcrumbs of where the driver has actually been. */
  trail: MapPoint[];
  brandColor: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const courierMarkerRef = useRef<Marker | null>(null);
  const trailRef = useRef<Polyline | null>(null);
  const trailCasingRef = useRef<Polyline | null>(null);
  const hasFittedRef = useRef(false);

  // Stable identity so the effect below doesn't re-run on every poll just because
  // the parent handed us a new array with the same contents.
  const trailKey = useMemo(
    () => trail.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join('|'),
    [trail],
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = await import('leaflet');
      if (cancelled || !containerRef.current) return;

      // --- One-time map setup ---
      if (!mapRef.current) {
        const map = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: true,
          // A map inside a scrolling page that steals the scroll wheel is
          // infuriating on desktop. Drag and pinch still work.
          scrollWheelZoom: false,
        });

        // Basemap. Default: CARTO Voyager — clean and modern but with legible roads,
        // labels and subtle colour (Google/Uber-style), free and no API key. If a
        // MapTiler key is set (NEXT_PUBLIC_MAPTILER_KEY), use MapTiler Streets for a
        // crisper, premium basemap instead — a drop-in upgrade with no code change.
        // `{r}` + detectRetina serve @2x tiles on phones either way.
        const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
        const tileUrl = maptilerKey
          ? `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}{r}.png?key=${maptilerKey}`
          : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

        L.tileLayer(tileUrl, {
          attribution: maptilerKey
            ? '&copy; MapTiler &copy; OpenStreetMap'
            : '&copy; OpenStreetMap &copy; CARTO',
          subdomains: 'abcd',
          detectRetina: true,
          maxZoom: 20,
        }).addTo(map);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        mapRef.current = map;
      }

      const map = mapRef.current;

      // --- Static pins: where the food came from, where it's going ---
      if (restaurant) {
        L.marker([restaurant.latitude, restaurant.longitude], {
          icon: pickupIcon(L),
        }).addTo(map);
      }
      if (dropoff) {
        L.marker([dropoff.latitude, dropoff.longitude], {
          icon: dropoffIcon(L, brandColor),
        }).addTo(map);
      }

      // --- The route so far ---
      // A white "casing" under a solid brand line — the crisp, layered route look of a
      // real ride-hailing map, and it keeps the line legible over any part of the map.
      if (trail.length > 1) {
        const latlngs = trail.map((p) => [p.latitude, p.longitude] as [number, number]);
        if (trailCasingRef.current && trailRef.current) {
          trailCasingRef.current.setLatLngs(latlngs);
          trailRef.current.setLatLngs(latlngs);
        } else {
          trailCasingRef.current = L.polyline(latlngs, {
            color: '#ffffff',
            weight: 8,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round',
          }).addTo(map);
          trailRef.current = L.polyline(latlngs, {
            color: brandColor,
            weight: 4.5,
            opacity: 1,
            lineCap: 'round',
            lineJoin: 'round',
          }).addTo(map);
        }
      }

      // --- The courier ---
      if (courier) {
        const position: [number, number] = [courier.latitude, courier.longitude];

        if (courierMarkerRef.current) {
          // Move the existing marker. Leaflet interpolates nothing for us, but
          // reusing the marker lets CSS transition the icon smoothly instead of
          // the pin vanishing and reappearing.
          courierMarkerRef.current.setLatLng(position);
        } else {
          courierMarkerRef.current = L.marker(position, {
            icon: courierIcon(L, brandColor),
            zIndexOffset: 1000, // always on top of the static pins
          }).addTo(map);
        }
      }

      // --- Framing ---
      // Fit everything once, then leave the viewport alone. Re-fitting on every
      // poll would yank the map out from under a customer who is pinching to look
      // at their own street.
      if (!hasFittedRef.current) {
        const points = [restaurant, dropoff, courier].filter(Boolean) as MapPoint[];

        if (points.length > 1) {
          map.fitBounds(
            L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number])),
            { padding: [56, 56], maxZoom: 16 },
          );
          hasFittedRef.current = true;
        } else if (points.length === 1) {
          map.setView([points[0].latitude, points[0].longitude], 15);
          hasFittedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [restaurant, dropoff, courier, trailKey, brandColor, trail]);

  // Tear the map down only on unmount — not on every prop change, or we'd rebuild
  // the whole thing (and refetch every tile) four times a minute.
  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      courierMarkerRef.current = null;
      trailRef.current = null;
      trailCasingRef.current = null;
    };
  }, []);

  const hasAnything = restaurant || dropoff || courier;
  if (!hasAnything) return null;

  return (
    <div className={className}>
      {/* Leaflet's CSS. Loaded here rather than globally so the ~14KB only lands
          on pages that actually show a map. */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossOrigin=""
      />
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden rounded-2xl border border-border shadow-soft"
        style={{ minHeight: 340, zIndex: 0, background: '#eaeaea' }}
        aria-label="Map showing your delivery driver's location"
        role="img"
      />
    </div>
  );
}

// Clean monochrome glyphs (Material-style paths), drawn in white inside the markers.
const CAR_PATH =
  'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.85 7h10.29l1.04 3H5.81l1.04-3zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z';
const FORK_PATH =
  'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z';

function svg(path: string, color: string, size: number) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}"><path d="${path}"/></svg>`;
}

/** Pickup — a solid dark disc with a utensils glyph. */
function pickupIcon(L: typeof import('leaflet')) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:30px;height:30px;border-radius:50%;
      background:#111827;border:2.5px solid #fff;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 3px 10px rgba(0,0,0,.28);
    ">${svg(FORK_PATH, '#fff', 15)}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

/** Drop-off — a teardrop pin in the brand colour, anchored at its tip. */
function dropoffIcon(L: typeof import('leaflet'), color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="filter:drop-shadow(0 3px 6px rgba(0,0,0,.3));">
      <svg viewBox="0 0 24 34" width="30" height="42">
        <path d="M12 0C5.9 0 1 4.9 1 11c0 7.7 9.5 21.3 10 22 .5-.7 10-14.3 10-22C21 4.9 18.1 0 12 0z"
          fill="${color}" stroke="#fff" stroke-width="1.5"/>
        <circle cx="12" cy="11" r="4" fill="#fff"/>
      </svg>
    </div>`,
    iconSize: [30, 42],
    iconAnchor: [15, 40],
  });
}

/**
 * The courier marker — a car glyph in a brand disc, with a pulsing halo.
 *
 * The pulse is the point: a static dot reads as a stale screenshot; a pulsing one
 * reads as "this is happening right now", which is the whole reason a tracking page
 * exists.
 */
function courierIcon(L: typeof import('leaflet'), color: string) {
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:46px;height:46px;">
        <span style="
          position:absolute;inset:0;border-radius:50%;
          background:${color};opacity:.25;
          animation:dinedirect-pulse 1.8s ease-out infinite;
        "></span>
        <div style="
          position:absolute;inset:7px;border-radius:50%;
          background:${color};border:3px solid #fff;
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 4px 12px rgba(0,0,0,.32);
        ">${svg(CAR_PATH, '#fff', 17)}</div>
      </div>
      <style>
        @keyframes dinedirect-pulse {
          0%   { transform: scale(.7); opacity: .45; }
          70%  { transform: scale(1.7); opacity: 0; }
          100% { transform: scale(1.7); opacity: 0; }
        }
      </style>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });
}
