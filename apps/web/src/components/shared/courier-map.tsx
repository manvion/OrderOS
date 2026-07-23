'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { Map as MlMap, Marker } from 'maplibre-gl';
import { storefrontApi } from '@/lib/api';

export interface MapPoint {
  latitude: number;
  longitude: number;
}

/**
 * The live courier map — MapLibre GL + OpenStreetMap.
 *
 * A fully open, key-free stack:
 *  - RENDERING: MapLibre GL JS (vector maps, GPU-drawn, crisp at every zoom).
 *  - TILES/STYLE: OpenFreeMap — OpenStreetMap data served as vector tiles with no API
 *    key and no request limits, so this map renders on every delivery across every
 *    restaurant at zero marginal cost.
 *  - ROUTING: OSRM, through our own API (see {@link fetchRoute}) — cached server-side so
 *    a leg is one call no matter how many people watch it.
 *  - GEOCODING: Nominatim, server-side (see GeocodingService).
 *
 * MapLibre touches `window` on import, so it's loaded dynamically inside an effect
 * rather than at module scope — importing it at the top would break the server render
 * of the tracking page, the one page that must render fast on a phone on bad signal.
 *
 * The courier marker GLIDES to each new fix rather than teleporting, and the route
 * FOLLOWS THE STREETS (a brand line ahead, a muted line behind for ground covered) —
 * the exact read a customer gets from a ride-hailing app.
 */

// OpenStreetMap data, rendered with the colourful "Liberty" style. No key, no limits.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export function CourierMap({
  restaurant,
  dropoff,
  courier,
  trail,
  brandColor,
  className,
  slug,
}: {
  restaurant: MapPoint | null;
  dropoff: MapPoint | null;
  courier: MapPoint | null;
  /** Breadcrumbs of where the driver has actually been. */
  trail: MapPoint[];
  brandColor: string;
  className?: string;
  /**
   * The tenant slug. When set, the route is fetched through our own API (reliable,
   * cached, street-following). Without it the map falls back to calling the public
   * router directly — kept only so contexts without a slug still draw something.
   */
  slug?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const pickupMarkerRef = useRef<Marker | null>(null);
  const dropoffMarkerRef = useRef<Marker | null>(null);
  const courierMarkerRef = useRef<Marker | null>(null);
  const hasFittedRef = useRef(false);
  // The origin the currently-drawn route was computed FROM, rounded — so we re-route
  // only once the driver has genuinely moved on, one OSRM call per meaningful move.
  const routedFromRef = useRef<string | null>(null);
  // Smooth courier motion: glide the marker frame-by-frame between the 4s fixes.
  const courierAnimRef = useRef<number | null>(null);
  const courierPosRef = useRef<[number, number] | null>(null);

  // Stable identity so the effect doesn't re-run on every poll just because the parent
  // handed a new array with the same contents.
  const trailKey = useMemo(
    () => trail.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join('|'),
    [trail],
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      if (cancelled || !containerRef.current) return;

      // --- One-time map setup ---
      if (!mapRef.current) {
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: MAP_STYLE,
          center: [
            (courier ?? dropoff ?? restaurant)?.longitude ?? 0,
            (courier ?? dropoff ?? restaurant)?.latitude ?? 0,
          ],
          zoom: 12,
          attributionControl: { compact: true },
          // A map inside a scrolling page that steals the scroll wheel is infuriating on
          // desktop. Drag and pinch still work.
          scrollZoom: false,
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
        mapRef.current = map;

        // Sources + layers can only be added once the style has loaded. Set up empty
        // route/trail sources now; the poll below just swaps their data.
        map.on('load', () => {
          if (cancelled) return;
          map.addSource('trail', emptyLineSource());
          map.addSource('route', emptyLineSource());

          // Where the driver has already been — muted, under the road ahead.
          map.addLayer({
            id: 'trail-line',
            type: 'line',
            source: 'trail',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#9ca3af', 'line-width': 4, 'line-opacity': 0.7 },
          });
          // The road ahead: a white casing under a solid brand line, legible over any map.
          map.addLayer({
            id: 'route-casing',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 },
          });
          map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': brandColor, 'line-width': 5 },
          });

          readyRef.current = true;
          void draw();
        });
      }

      if (readyRef.current) void draw();
    })();

    // Everything that changes on a poll: pins, the routed line, the courier, framing.
    async function draw() {
      const maplibregl = (await import('maplibre-gl')).default;
      const map = mapRef.current;
      if (cancelled || !map || !readyRef.current) return;

      // --- Static pins ---
      if (restaurant && !pickupMarkerRef.current) {
        pickupMarkerRef.current = new maplibregl.Marker({ element: pickupEl(), anchor: 'center' })
          .setLngLat([restaurant.longitude, restaurant.latitude])
          .addTo(map);
      }
      if (dropoff && !dropoffMarkerRef.current) {
        dropoffMarkerRef.current = new maplibregl.Marker({ element: dropoffEl(brandColor), anchor: 'bottom' })
          .setLngLat([dropoff.longitude, dropoff.latitude])
          .addTo(map);
      }

      // --- Trail (ground covered) ---
      if (trail.length > 1) {
        setLine(map, 'trail', trail);
      }

      // --- The road ahead: routed line to the door ---
      const routeStart = courier ?? restaurant;
      if (routeStart && dropoff) {
        const fromKey = roundKey(routeStart);
        const moved =
          routedFromRef.current === null || (courier != null && routedFromRef.current !== fromKey);
        if (moved) {
          routedFromRef.current = fromKey;
          const latlngs = await fetchRoute(routeStart, dropoff, slug);
          if (cancelled || !mapRef.current) return;
          setLineLatLng(map, 'route', latlngs);
        }
      }

      // --- The courier ---
      if (courier) {
        const target: [number, number] = [courier.longitude, courier.latitude];
        if (courierMarkerRef.current) {
          animateCourier(courierMarkerRef.current, courierPosRef, courierAnimRef, target);
        } else {
          courierMarkerRef.current = new maplibregl.Marker({ element: courierEl(brandColor), anchor: 'center' })
            .setLngLat(target)
            .addTo(map);
          courierPosRef.current = target;
        }
      }

      // --- Framing: fit ONCE, then leave the viewport alone ---
      if (!hasFittedRef.current) {
        // Frame the leg that matters — the courier and the door. Including the pickup once
        // the driver is halfway across town is what forced the map to zoom out until the
        // street names vanished.
        const focus = (courier ? [courier, dropoff] : [restaurant, dropoff, courier]).filter(
          Boolean,
        ) as MapPoint[];
        if (focus.length > 1) {
          const bounds = new maplibregl.LngLatBounds();
          for (const p of focus) bounds.extend([p.longitude, p.latitude]);
          map.fitBounds(bounds, { padding: 56, maxZoom: 16, animate: false });
          hasFittedRef.current = true;
        } else if (focus.length === 1) {
          map.jumpTo({ center: [focus[0].longitude, focus[0].latitude], zoom: 15 });
          hasFittedRef.current = true;
        }
      }
    }

    return () => {
      cancelled = true;
    };
  }, [restaurant, dropoff, courier, trailKey, brandColor, trail, slug]);

  // Tear down only on unmount — not on every prop change, or we'd rebuild the whole map
  // (and refetch every tile) four times a minute.
  useEffect(() => {
    return () => {
      if (courierAnimRef.current !== null) cancelAnimationFrame(courierAnimRef.current);
      courierAnimRef.current = null;
      courierPosRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      readyRef.current = false;
      pickupMarkerRef.current = null;
      dropoffMarkerRef.current = null;
      courierMarkerRef.current = null;
    };
  }, []);

  const hasAnything = restaurant || dropoff || courier;
  if (!hasAnything) return null;

  return (
    <div className={className}>
      {/* MapLibre's CSS. Loaded here rather than globally so it only lands on pages that
          actually show a map. */}
      <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden rounded-2xl border border-border shadow-soft"
        style={{ minHeight: 340, background: '#eaeaea' }}
        aria-label="Map showing your delivery driver's location and route to you"
        role="img"
      />
    </div>
  );
}

/** An empty GeoJSON LineString source, ready for the poll to fill with coordinates. */
function emptyLineSource() {
  return {
    type: 'geojson' as const,
    data: {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: [] as Array<[number, number]> },
    },
  };
}

/** Point a GeoJSON line source at a set of [lat,lng] map points (converting to [lng,lat]). */
function setLine(map: MlMap, id: string, points: MapPoint[]) {
  setLineLatLng(
    map,
    id,
    points.map((p) => [p.latitude, p.longitude] as [number, number]),
  );
}

/** Point a GeoJSON line source at [lat,lng] pairs. */
function setLineLatLng(map: MlMap, id: string, latlngs: Array<[number, number]>) {
  const source = map.getSource(id) as { setData: (d: unknown) => void } | undefined;
  if (!source) return;
  source.setData({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: latlngs.map(([lat, lng]) => [lng, lat]),
    },
  });
}

/**
 * Glide the courier marker from where it currently is to a new fix, at a constant speed
 * over a window just under the 4s poll, so the car reads as continuously on the move.
 * A negligible delta (a stopped car, GPS jitter at a light) settles in place.
 */
function animateCourier(
  marker: Marker,
  posRef: React.MutableRefObject<[number, number] | null>,
  animRef: React.MutableRefObject<number | null>,
  target: [number, number],
): void {
  if (animRef.current !== null) {
    cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }

  const cur = marker.getLngLat();
  const from: [number, number] = posRef.current ?? [cur.lng, cur.lat];
  const dLng = target[0] - from[0];
  const dLat = target[1] - from[1];

  // ~1e-6 deg ≈ 0.1m: below this it's noise, not travel.
  if (Math.abs(dLng) < 1e-6 && Math.abs(dLat) < 1e-6) {
    marker.setLngLat(target);
    posRef.current = target;
    return;
  }

  const DURATION_MS = 3500;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / DURATION_MS);
    const lng = from[0] + dLng * p;
    const lat = from[1] + dLat * p;
    marker.setLngLat([lng, lat]);
    posRef.current = [lng, lat];
    if (p < 1) {
      animRef.current = requestAnimationFrame(step);
    } else {
      animRef.current = null;
      posRef.current = target;
    }
  };
  animRef.current = requestAnimationFrame(step);
}

// Re-route only once the driver has moved on by ~11m — a real change of position,
// coarse enough that GPS jitter at a red light doesn't trigger a fresh routing call.
function roundKey(p: MapPoint): string {
  return `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;
}

/**
 * Driving geometry between two points as [lat, lng] pairs following the roads.
 *
 * OSRM through our own API (cached, street-following) when a slug is present; otherwise
 * the public OSRM server directly. On ANY failure we return a straight line so the
 * customer always sees a track to their door rather than a blank map.
 */
async function fetchRoute(
  from: MapPoint,
  to: MapPoint,
  slug?: string,
): Promise<Array<[number, number]>> {
  const straightLine: Array<[number, number]> = [
    [from.latitude, from.longitude],
    [to.latitude, to.longitude],
  ];

  const cacheKey = `${roundKey(from)}->${roundKey(to)}`;
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  try {
    if (slug) {
      const { geometry } = await storefrontApi.route(
        slug,
        `${from.latitude},${from.longitude}`,
        `${to.latitude},${to.longitude}`,
      );
      if (!geometry || geometry.length < 2) return straightLine;
      routeCache.set(cacheKey, geometry);
      return geometry;
    }

    const base = process.env.NEXT_PUBLIC_OSRM_URL ?? 'https://router.project-osrm.org';
    // OSRM wants lng,lat — the opposite order to everything else here.
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`;

    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return straightLine;

    const body = (await res.json()) as {
      code: string;
      routes?: Array<{ geometry: { coordinates: Array<[number, number]> } }>;
    };
    const coordinates = body.routes?.[0]?.geometry.coordinates;
    if (body.code !== 'Ok' || !coordinates || coordinates.length < 2) return straightLine;

    // GeoJSON is [lng, lat]; we keep [lat, lng] to match everything else.
    const latlngs = coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
    routeCache.set(cacheKey, latlngs);
    return latlngs;
  } catch {
    return straightLine;
  }
}

// Routes don't change between renders for the same origin/destination; a customer flips
// between cart, checkout and tracker. Cache for the life of the tab.
const routeCache = new Map<string, Array<[number, number]>>();

// --- Marker elements (plain DOM, so they work as MapLibre custom markers) ------------

const CAR_PATH =
  'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.85 7h10.29l1.04 3H5.81l1.04-3zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z';
const FORK_PATH =
  'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z';

function svg(path: string, color: string, size: number) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}"><path d="${path}"/></svg>`;
}

function el(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.firstElementChild as HTMLElement;
}

/** Pickup — a solid dark disc with a utensils glyph. */
function pickupEl(): HTMLElement {
  return el(
    `<div style="width:30px;height:30px;border-radius:50%;background:#111827;border:2.5px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.28);">${svg(FORK_PATH, '#fff', 15)}</div>`,
  );
}

/** Drop-off — a teardrop pin in the brand colour, anchored at its tip. */
function dropoffEl(color: string): HTMLElement {
  return el(
    `<div style="filter:drop-shadow(0 3px 6px rgba(0,0,0,.3));"><svg viewBox="0 0 24 34" width="30" height="42"><path d="M12 0C5.9 0 1 4.9 1 11c0 7.7 9.5 21.3 10 22 .5-.7 10-14.3 10-22C21 4.9 18.1 0 12 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="11" r="4" fill="#fff"/></svg></div>`,
  );
}

/** The courier — a car glyph in a brand disc, with a pulsing halo. */
function courierEl(color: string): HTMLElement {
  return el(
    `<div style="position:relative;width:46px;height:46px;">
      <span style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:.25;animation:dinedirect-pulse 1.8s ease-out infinite;"></span>
      <div style="position:absolute;inset:7px;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.32);">${svg(CAR_PATH, '#fff', 17)}</div>
      <style>@keyframes dinedirect-pulse{0%{transform:scale(.7);opacity:.45;}70%{transform:scale(1.7);opacity:0;}100%{transform:scale(1.7);opacity:0;}}</style>
    </div>`,
  );
}
