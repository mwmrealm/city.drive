// Fare engine shared by the browser (live price preview) and the server (authoritative quote).
// Keep this file free of browser/Node specific APIs.

export const TRIP_TYPES = ['oneway', 'roundtrip', 'local'];

/** Whole days between two YYYY-MM-DD strings, inclusive (same day = 1). */
export function tripDays(pickupDate, returnDate) {
    if (!pickupDate || !returnDate) return 1;
    const start = Date.parse(`${pickupDate}T00:00:00Z`);
    const end = Date.parse(`${returnDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
    return Math.min(60, Math.round((end - start) / 86400000) + 1);
}

export function isNightTime(pickupTime, startHour, endHour) {
    const hour = parseInt(String(pickupTime || '').split(':')[0], 10);
    if (!Number.isFinite(hour)) return false;
    return startHour < endHour
        ? hour >= startHour && hour < endHour
        : hour >= startHour || hour < endHour;
}

/**
 * Minimum billed km. Short trips (up to rules.shortTripKm one way) are billed close to the real
 * distance (at least rules.shortTripMinimumKm); longer trips use the normal minimum.
 */
export function minimumFor(rules, oneWayKm) {
    const shortLimit = Number(rules.shortTripKm) || 0;
    if (shortLimit > 0 && oneWayKm <= shortLimit) return Number(rules.shortTripMinimumKm) || 0;
    return Number(rules.minimumBillableKm) || 0;
}

/**
 * @param {object} rules   settings.rules  { minimumBillableKm, tollPerKm, localPackageKm, nightStartHour, nightEndHour }
 * @param {object} car     settings.cars[i] { ratePerKm, driverAllowance, nightAllowance, luggageCarrierCost, name }
 * @param {object} trip    { tripType, distanceKm (one way road km), pickupDate, returnDate, pickupTime, luggageCarrier }
 */
export function computeFare(rules, car, trip) {
    const days = trip.tripType === 'roundtrip' ? tripDays(trip.pickupDate, trip.returnDate) : 1;
    const oneWayKm = Math.max(0, Number(trip.distanceKm) || 0);

    let travelKm;
    let billedKm;
    if (trip.tripType === 'local') {
        travelKm = rules.localPackageKm;
        billedKm = rules.localPackageKm;
    } else if (trip.tripType === 'roundtrip') {
        travelKm = Math.round(oneWayKm * 2);
        billedKm = Math.max(travelKm, minimumFor(rules, oneWayKm) * days);
    } else {
        travelKm = Math.round(oneWayKm);
        billedKm = Math.max(travelKm, minimumFor(rules, oneWayKm));
    }

    const baseFare = Math.round(billedKm * car.ratePerKm);
    const driverAllowance = Math.round(car.driverAllowance * days);
    const isNight = isNightTime(trip.pickupTime, rules.nightStartHour, rules.nightEndHour);
    const nightAllowance = isNight ? Math.round(car.nightAllowance) : 0;
    const luggageCost = trip.luggageCarrier ? Math.round(car.luggageCarrierCost) : 0;
    const tollEstimate = Math.round(billedKm * rules.tollPerKm);
    const total = baseFare + driverAllowance + nightAllowance + luggageCost + tollEstimate;

    return {
        days,
        travelKm,
        billedKm,
        minimumApplied: billedKm > travelKm && trip.tripType !== 'local',
        ratePerKm: car.ratePerKm,
        baseFare,
        driverAllowance,
        isNight,
        nightAllowance,
        luggageCost,
        tollEstimate,
        total
    };
}