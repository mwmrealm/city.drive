// Site settings: defaults, validation and sanitising. One settings document drives the
// public website (cars, prices, contact details, routes, FAQs) and is edited from /admin.

export const DEFAULT_SETTINGS = {
    site: {
        businessName: 'City Drive',
        tagline: 'Explore Local. Travel Premium.',
        heroBadge: 'Premium intercity & outstation car service',
        heroTitle: 'Your Trusted Partner For Intercity Travel',
        heroText: 'Top-rated car service connecting Chennai, Bengaluru, Coimbatore, Madurai, and all major cities. Enjoy a comfortable ride with our professional fleet.',
        phonePrimary: '7358002724',
        phoneAlternate: '9600991160',
        whatsapp: '917358002724',
        instagram: 'City_Drive2724',
        logo: '/assets/logo.jpg'
    },
    cars: [
        { id: 'cng_sedan', name: 'CNG Sedan', subtitle: '4 Seater (Economy)', description: 'Maruti Dzire CNG / Hyundai Aura', image: '/assets/car-cng-sedan.png', ratePerKm: 14, driverAllowance: 400, nightAllowance: 300, luggageCarrierCost: 300, active: true },
        { id: 'sedan', name: 'Sedan', subtitle: '4 Seater (Comfort)', description: 'Dzire / Etios / Amaze (Petrol)', image: '/assets/car-sedan.jpg', ratePerKm: 17, driverAllowance: 400, nightAllowance: 300, luggageCarrierCost: 300, active: true },
        { id: 'suv', name: 'SUV', subtitle: '7 Seater (Spacious)', description: 'Ertiga / Innova / Marazzo', image: '/assets/car-suv.png', ratePerKm: 20, driverAllowance: 400, nightAllowance: 300, luggageCarrierCost: 300, active: true }
    ],
    rules: {
        minimumBillableKm: 130,
        tollPerKm: 1.5,
        fallbackIntercityKm: 220,
        localPackageKm: 80,
        nightStartHour: 22,
        nightEndHour: 6
    },
    routes: [
        { origin: 'Chennai', destination: 'Bengaluru', distanceKm: 345, duration: '6.5 hrs' },
        { origin: 'Chennai', destination: 'Pondicherry', distanceKm: 165, duration: '3.5 hrs' },
        { origin: 'Bengaluru', destination: 'Chennai', distanceKm: 345, duration: '6.5 hrs' },
        { origin: 'Bengaluru', destination: 'Mysore', distanceKm: 145, duration: '3.0 hrs' },
        { origin: 'Chennai', destination: 'Coimbatore', distanceKm: 510, duration: '8.5 hrs' },
        { origin: 'Chennai', destination: 'Madurai', distanceKm: 460, duration: '7.5 hrs' }
    ],
    faqs: [
        { question: 'How are night charges calculated?', answer: 'If your pickup time falls between {nightStart} and {nightEnd}, a flat night allowance for the selected car is added to the fare.' },
        { question: 'Is there any return kilometer fee for one-way drops?', answer: 'No! City Drive only charges for the distance from your pickup point to drop point.' },
        { question: 'Are Toll and State Permits included?', answer: 'Toll gate fees and state entry permits are estimated based on your distance route and billed as actuals during your journey.' },
        { question: 'What is the minimum billing distance?', answer: 'For one-way intercity drops, the minimum billing distance is {minKm} KM per day.' },
        { question: 'How is a round trip billed?', answer: 'Round trips are billed for the full distance there and back (minimum {minKm} KM for each day of the trip), plus the driver allowance for every day.' }
    ]
};

export const LIMITS = { cars: 12, routes: 60, faqs: 30 };

const IMAGE_PATH = /^\/(media|assets)\/[A-Za-z0-9._-]{1,80}$/;

function text(value, max, fallback = '') {
    return typeof value === 'string' ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max) : fallback;
}

function digits(value, max) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '').slice(0, max) : '';
}

function num(value, min, max, label, errors) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isFinite(number) || number < min || number > max) {
        errors.push(`${label} must be a number between ${min} and ${max}.`);
        return min;
    }
    return number;
}

/** Fill any missing parts of a saved document with defaults (used when reading storage). */
export function withDefaults(saved) {
    const base = structuredClone(DEFAULT_SETTINGS);
    if (!saved || typeof saved !== 'object') return base;

    // Legacy format: { cars: { cng_sedan: {ratePerKm,...}, ... }, minimumBillableKm, ... }
    const legacy = saved.cars && !Array.isArray(saved.cars);
    if (legacy) {
        base.cars = base.cars.map(car => ({ ...car, ...(saved.cars[car.id] || {}) }));
        for (const key of Object.keys(base.rules)) {
            if (Number.isFinite(saved[key])) base.rules[key] = saved[key];
        }
        return base;
    }

    if (saved.site) base.site = { ...base.site, ...saved.site };
    if (Array.isArray(saved.cars) && saved.cars.length) base.cars = saved.cars;
    if (saved.rules) base.rules = { ...base.rules, ...saved.rules };
    if (Array.isArray(saved.routes)) base.routes = saved.routes;
    if (Array.isArray(saved.faqs)) base.faqs = saved.faqs;
    return base;
}

/**
 * Validate and normalise settings submitted from the admin dashboard.
 * Returns { settings } or { error }.
 */
export function sanitizeSettings(input) {
    if (!input || typeof input !== 'object') return { error: 'Settings are missing.' };
    const errors = [];
    const defaults = DEFAULT_SETTINGS;

    const s = input.site || {};
    const site = {
        businessName: text(s.businessName, 60) || defaults.site.businessName,
        tagline: text(s.tagline, 100),
        heroBadge: text(s.heroBadge, 100),
        heroTitle: text(s.heroTitle, 120) || defaults.site.heroTitle,
        heroText: text(s.heroText, 400),
        phonePrimary: digits(s.phonePrimary, 10),
        phoneAlternate: digits(s.phoneAlternate, 10),
        whatsapp: digits(s.whatsapp, 15),
        instagram: text(s.instagram, 40).replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, ''),
        logo: IMAGE_PATH.test(s.logo || '') ? s.logo : defaults.site.logo
    };
    if (site.phonePrimary.length !== 10) errors.push('Primary phone must be a 10 digit number.');
    if (site.phoneAlternate && site.phoneAlternate.length !== 10) errors.push('Alternate phone must be a 10 digit number (or empty).');
    if (site.whatsapp.length < 10) errors.push('WhatsApp number must include the country code, e.g. 917358002724.');

    if (!Array.isArray(input.cars) || input.cars.length === 0) errors.push('Add at least one car.');
    const rawCars = Array.isArray(input.cars) ? input.cars.slice(0, LIMITS.cars) : [];
    const seen = new Set();
    const cars = rawCars.map((car, index) => {
        const name = text(car?.name, 40);
        if (!name) errors.push(`Car ${index + 1} needs a name.`);
        let id = text(car?.id, 30).toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `car_${index + 1}`;
        while (seen.has(id)) id = `${id.slice(0, 26)}_${index + 1}`;
        seen.add(id);
        const label = name || `Car ${index + 1}`;
        return {
            id,
            name,
            subtitle: text(car?.subtitle, 60),
            description: text(car?.description, 120),
            image: IMAGE_PATH.test(car?.image || '') ? car.image : '',
            ratePerKm: num(car?.ratePerKm, 0, 1000, `${label}: rate per km`, errors),
            driverAllowance: num(car?.driverAllowance, 0, 200000, `${label}: driver allowance`, errors),
            nightAllowance: num(car?.nightAllowance, 0, 200000, `${label}: night allowance`, errors),
            luggageCarrierCost: num(car?.luggageCarrierCost, 0, 200000, `${label}: roof carrier`, errors),
            active: car?.active !== false
        };
    });
    if (cars.length && !cars.some(car => car.active)) errors.push('At least one car must be active so customers can book.');

    const r = input.rules || {};
    const rules = {
        minimumBillableKm: num(r.minimumBillableKm, 1, 10000, 'Minimum billable distance', errors),
        tollPerKm: num(r.tollPerKm, 0, 10000, 'Toll per km', errors),
        fallbackIntercityKm: num(r.fallbackIntercityKm, 1, 10000, 'Unknown route estimate', errors),
        localPackageKm: num(r.localPackageKm, 1, 10000, 'Local package km', errors),
        nightStartHour: num(r.nightStartHour, 0, 23, 'Night start hour', errors),
        nightEndHour: num(r.nightEndHour, 0, 23, 'Night end hour', errors)
    };
    if (rules.nightStartHour === rules.nightEndHour) errors.push('Night start and end hours must be different.');
    for (const key of ['nightStartHour', 'nightEndHour']) rules[key] = Math.round(rules[key]);

    const routes = (Array.isArray(input.routes) ? input.routes.slice(0, LIMITS.routes) : []).map((route, index) => {
        const origin = text(route?.origin, 60);
        const destination = text(route?.destination, 60);
        if (!origin || !destination) errors.push(`Route ${index + 1} needs both a start and an end.`);
        return {
            origin,
            destination,
            distanceKm: num(route?.distanceKm, 1, 5000, `Route ${index + 1} distance`, errors),
            duration: text(route?.duration, 20)
        };
    });

    const faqs = (Array.isArray(input.faqs) ? input.faqs.slice(0, LIMITS.faqs) : [])
        .map(faq => ({ question: text(faq?.question, 160), answer: text(faq?.answer, 600) }))
        .filter(faq => faq.question && faq.answer);

    if (errors.length) return { error: errors[0], errors };
    return { settings: { site, cars, rules, routes, faqs } };
}

/** What the public website is allowed to see. */
export function publicSettings(settings) {
    return {
        site: settings.site,
        cars: settings.cars.filter(car => car.active),
        rules: settings.rules,
        routes: settings.routes,
        faqs: settings.faqs
    };
}
