// Distance resolution for fare quotes.
// Order of trust: Google Routes API (server key) -> sanity-checked browser distance
// -> admin route table -> admin "unknown route" default.

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
                const route = await googleRoute(pickup, dropoff);
                return {
                    distanceKm: route.km,
                    durationMinutes: route.durationMinutes,
                    polyline: route.polyline,
                    source: 'google'
                };
            } catch (error) {
                console.error('Google Routes lookup failed, using fallback:', error.message);
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
