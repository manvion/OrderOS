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

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap',
          maxZoom: 19,
        }).addTo(map);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        mapRef.current = map;
      }

      const map = mapRef.current;

      // --- Static pins: where the food came from, where it's going ---
      if (restaurant) {
        L.marker([restaurant.latitude, restaurant.longitude], {
          icon: dotIcon(L, '#0f172a', '🍔'),
        }).addTo(map);
      }
      if (dropoff) {
        L.marker([dropoff.latitude, dropoff.longitude], {
          icon: dotIcon(L, brandColor, '📍'),
        }).addTo(map);
      }

      // --- The route so far ---
      if (trail.length > 1) {
        const latlngs = trail.map((p) => [p.latitude, p.longitude] as [number, number]);
        if (trailRef.current) {
          trailRef.current.setLatLngs(latlngs);
        } else {
          trailRef.current = L.polyline(latlngs, {
            color: brandColor,
            weight: 4,
            opacity: 0.65,
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
            { padding: [48, 48], maxZoom: 15 },
          );
          hasFittedRef.current = true;
        } else if (points.length === 1) {
          map.setView([points[0].latitude, points[0].longitude], 14);
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
        className="h-full w-full rounded-2xl"
        style={{ minHeight: 260, zIndex: 0 }}
        aria-label="Map showing your delivery driver's location"
        role="img"
      />
    </div>
  );
}

/** A small circular pin. Used for the restaurant and the drop-off. */
function dotIcon(L: typeof import('leaflet'), color: string, emoji: string) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:34px;height:34px;border-radius:50%;
      background:#fff;border:3px solid ${color};
      display:flex;align-items:center;justify-content:center;
      font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.25);
    ">${emoji}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

/**
 * The courier pin, with a pulsing halo.
 *
 * The pulse is the entire point: a static dot on a map reads as a stale
 * screenshot. A pulsing one reads as "this is happening right now", which is the
 * feeling a tracking page exists to create.
 */
function courierIcon(L: typeof import('leaflet'), color: string) {
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:44px;height:44px;">
        <span style="
          position:absolute;inset:0;border-radius:50%;
          background:${color};opacity:.28;
          animation:dinedirect-pulse 1.8s ease-out infinite;
        "></span>
        <div style="
          position:absolute;inset:6px;border-radius:50%;
          background:${color};border:3px solid #fff;
          display:flex;align-items:center;justify-content:center;
          font-size:15px;box-shadow:0 3px 10px rgba(0,0,0,.3);
        ">🚗</div>
      </div>
      <style>
        @keyframes dinedirect-pulse {
          0%   { transform: scale(.7); opacity: .45; }
          70%  { transform: scale(1.6); opacity: 0; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      </style>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}
