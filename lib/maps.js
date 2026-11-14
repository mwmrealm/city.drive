// Distance resolution for fare quotes.
// Order of trust: Google Routes API (server key) -> OpenStreetMap OSRM (free, default)
// -> sanity-checked browser distance -> straight-line estimate.
// Without coordinates: admin route table -> admin "unknown route" default.

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a, b) {
    const rad = degrees => (degrees * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function validPoint(point) {
    return Boolean(point)
        && Number.isFinite(point.lat) && Number.isFinite(point.lng)
        && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

// Rough bounding box of India (incl. islands). Keeps quotes within the service country.
export function insideIndia(point) {
    return point.lat >= 6 && point.lat <= 37.5 && point.lng >= 68 && point.lng <= 98;
}

export function serverMapsKey() {
    return process.env.GOOGLE_MAPS_SERVER_KEY || '';
}

export function browserMapsKey() {
    return process.env.GOOGLE_MAPS_API_KEY || '';
}

/** 'google' when a browser key is set, 'osm' (free OpenStreetMap) otherwise, 'off' to disable maps. */
export function mapProvider() {
    if ((process.env.MAPS_PROVIDER || '').toLowerCase() === 'off') return 'off';
    return browserMapsKey() ? 'google' : 'osm';
}

// OSRM_URL=off disables the free road-distance service; set it to your own OSRM server if you host one.
export function osrmUrl() {
    const value = (process.env.OSRM_URL || 'https://router.project-osrm.org').trim().replace(/\/+$/, '');
    return value.toLowerCase() === 'off' ? '' : value;
}

export function routingProvider() {
    if (serverMapsKey()) return 'google';
    return osrmUrl() && mapProvider() !== 'off' ? 'osrm' : 'none';
}

/** Free road route via OpenStreetMap's OSRM service. Returns { km, durationMinutes, polyline } or throws. */
export async function osrmRoute(origin, destination) {
    const base = osrmUrl();
    if (!base) throw new Error('OSRM is disabled.');
    const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
    const response = await fetch(`${base}/route/v1/driving/${coordinates}?overview=full&geometries=polyline&alternatives=false&steps=false`, {
        headers: { 'User-Agent': 'CityDriveBooking/2.0 (taxi booking site)' },
        signal: AbortSignal.timeout(9000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 'Ok' || !body.routes?.length) {
        throw new Error(body.message || body.code || `OSRM returned ${response.status}`);
    }
    const route = body.routes[0];
    return { km: route.distance / 1000, durationMinutes: Math.round(route.duration / 60), polyline: route.geometry || '' };
}

// Remember recent routes for an hour so repeated price checks do not hit the routing service again.
const routeCache = new Map();
const CACHE_MS = 60 * 60 * 1000;
function cacheKey(a, b) {
    const round = value => value.toFixed(4);
    return `${round(a.lat)},${round(a.lng)}>${round(b.lat)},${round(b.lng)}`;
}
async function cachedRoute(origin, destination, fetcher, label) {
    const key = `${label}:${cacheKey(origin, destination)}`;
    const hit = routeCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await fetcher(origin, destination);
    if (routeCache.size > 500) routeCache.delete(routeCache.keys().next().value);
    routeCache.set(key, { at: Date.now(), value });
    return value;
}

/** Road route via the Google Routes API. Returns { km, durationMinutes, polyline } or throws. */
export async function googleRoute(origin, destination) {
    const key = serverMapsKey();
    if (!key) throw new Error('GOOGLE_MAPS_SERVER_KEY is not set.');
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
        },
        body: JSON.stringify({
            origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
            destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_UNAWARE',
            units: 'METRIC'
        }),
        signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Routes API returned ${response.status}`);
    const route = body.routes?.[0];
    if (!route?.distanceMeters) throw new Error('No driving route found between these points.');
    return {
        km: route.distanceMeters / 1000,
        durationMinutes: Math.round(parseInt(String(route.duration || '0s'), 10) / 60),
        polyline: route.polyline?.encodedPolyline || ''
    };
}

function sameName(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findListedRoute(routes, from, to) {
    return routes.find(route =>
        (sameName(route.origin, from) && sameName(route.destination, to))
        || (sameName(route.destination, from) && sameName(route.origin, to))
    );
}

/**
 * Work out the one-way road distance for a quote.
 * @returns {{ distanceKm:number, source:string, durationMinutes?:number, polyline?:string, note?:string }}
 */
export async function resolveDistance({ pickup, dropoff, clientDistanceKm, settings }) {
    const hasPoints = validPoint(pickup) && validPoint(dropoff);

    if (hasPoints) {
        if (serverMapsKey()) {
            try {
                const route = await cachedRoute(pickup, dropoff, googleRoute, 'google');
                return { distanceKm: route.km, durationMinutes: route.durationMinutes, polyline: route.polyline, source: 'google' };
            } catch (error) {
                console.error('Google Routes lookup failed, trying OpenStreetMap:', error.message);
            }
        }
        if (osrmUrl() && mapProvider() !== 'off') {
            try {
                const route = await cachedRoute(pickup, dropoff, osrmRoute, 'osrm');
                return { distanceKm: route.km, durationMinutes: route.durationMinutes, polyline: route.polyline, source: 'osrm' };
            } catch (error) {
                console.error('OSRM route lookup failed, using fallback:', error.message);
            }
        }

        const straight = haversineKm(pickup, dropoff);
        if (Number.isFinite(clientDistanceKm) && clientDistanceKm > 0
            && clientDistanceKm >= straight * 0.95 && clientDistanceKm <= straight * 3 + 20) {
            return { distanceKm: clientDistanceKm, source: 'customer-map' };
        }
        // Roads are rarely straight; 1.3x is a common planning factor for Indian highways.
        return { distanceKm: straight * 1.3, source: 'straight-line-estimate' };
    }

    const listed = pickup?.name && dropoff?.name ? findListedRoute(settings.routes, pickup.name, dropoff.name) : null;
    if (listed) return { distanceKm: listed.distanceKm, source: 'route-table' };
    return { distanceKm: settings.rules.fallbackIntercityKm, source: 'default-estimate' };
}

export function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return '';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours ? `${hours} hr${hours > 1 ? 's' : ''}${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}
