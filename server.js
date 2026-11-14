import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const root = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(root, '.env') });

const { computeFare, TRIP_TYPES } = await import('./public/fare.js');
const { publicSettings, sanitizeSettings } = await import('./lib/settings.js');
const maps = await import('./lib/maps.js');
const storage = await import('./lib/storage.js');

const app = express();
const port = Number(process.env.PORT) || 3000;
const publicDirectory = path.join(root, 'public');
storage.configureStorage({
    directory: process.env.DATA_DIRECTORY ? path.resolve(process.env.DATA_DIRECTORY) : path.join(root, 'data')
});

const adminCookieName = 'city_drive_admin';
const adminSessionLifetime = 8 * 60 * 60 * 1000;
const allowedBookingStatuses = new Set(['new', 'contacted', 'assigned', 'completed', 'cancelled']);

app.disable('x-powered-by');
// Render and most hosts sit behind a proxy; this makes rate limiting use the real visitor IP.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));

const allowedLocalPreviewOrigins = new Set([
    'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5501', 'http://127.0.0.1:5501'
]);
app.use((request, response, next) => {
    const origin = request.get('Origin');
    if (allowedLocalPreviewOrigins.has(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
        return response.sendStatus(allowedLocalPreviewOrigins.has(origin) ? 204 : 403);
    }
    return next();
});
app.use(express.json({ limit: '200kb' }));

const limiter = (limit, windowMs = 15 * 60 * 1000, message = 'Too many requests. Please try again shortly.') => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (request, response) => response.status(429).json({ message })
});
const bookingRateLimit = limiter(20, undefined, 'Too many booking requests. Please try again later or call us.');
const quoteRateLimit = limiter(240, undefined, 'Too many price checks. Please wait a few minutes.');
const adminLoginRateLimit = limiter(8, undefined, 'Too many sign-in attempts. Please wait 15 minutes before trying again.');

// ---------- Static pages and files ----------
app.get('/', (request, response) => response.sendFile(path.join(publicDirectory, 'index.html')));
app.get('/admin', (request, response) => response.sendFile(path.join(publicDirectory, 'admin.html')));
for (const script of ['fare.js', 'app.js']) {
    app.get(`/${script}`, (request, response) => {
        response.set('Cache-Control', 'no-cache');
        response.sendFile(path.join(publicDirectory, script));
    });
}
app.get('/admin-sw.js', (request, response) => {
    response.set('Cache-Control', 'no-cache');
    response.sendFile(path.join(publicDirectory, 'admin-sw.js'));
});
app.use('/admin-app', express.static(path.join(publicDirectory, 'admin-app'), { maxAge: '1d' }));
app.use('/assets', express.static(path.join(publicDirectory, 'assets'), { maxAge: '7d' }));
app.get('/media/:id', async (request, response) => {
    const media = await storage.readMedia(request.params.id);
    if (!media) return response.status(404).end();
    response.set({ 'Content-Type': media.contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return response.send(media.buffer);
});

// ---------- Public API ----------
app.get('/api/health', (request, response) => {
    response.json({
        status: 'ok',
        storageBackend: storage.storageBackend(),
        automaticNotificationsConfigured: hasWhatsAppConfiguration(),
        adminDashboardConfigured: hasAdminConfiguration(),
        googleMapsConfigured: Boolean(maps.browserMapsKey()),
        googleRoutingConfigured: Boolean(maps.serverMapsKey())
    });
});

app.get('/api/config', async (request, response) => {
    const settings = await storage.readSettings();
    response.set('Cache-Control', 'no-store');
    response.json({
        ...publicSettings(settings),
        maps: {
            enabled: Boolean(maps.browserMapsKey()),
            apiKey: maps.browserMapsKey(),
            mapId: process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID',
            serverRouting: Boolean(maps.serverMapsKey())
        }
    });
});

app.post('/api/quote', quoteRateLimit, async (request, response) => {
    const settings = await storage.readSettings();
    const result = await buildQuote(request.body ?? {}, settings);
    if (result.error) return response.status(400).json({ message: result.error });
    response.set('Cache-Control', 'no-store');
    return response.json(result.quote);
});

app.post('/api/bookings', bookingRateLimit, async (request, response) => {
    const input = request.body ?? {};
    const settings = await storage.readSettings();
    const customerName = cleanText(input.customerName, 80);
    const customerPhone = cleanText(input.customerPhone, 10);
    if (!customerName || !/^\d{10}$/.test(customerPhone)) {
        return response.status(400).json({ message: 'Please enter your name and a 10 digit mobile number.' });
    }

    const result = await buildQuote(input, settings);
    if (result.error) return response.status(400).json({ message: result.error });
    const quote = result.quote;

    const reference = `CD-${crypto.randomInt(100000, 1000000)}`;
    let notification = { status: 'not_configured', messageId: null };
    const booking = {
        reference,
        createdAt: new Date().toISOString(),
        status: 'new',
        notificationStatus: 'not_configured',
        tripType: quote.tripType,
        pickup: quote.pickup.name,
        dropoff: quote.dropoff.name,
        pickupLat: quote.pickup.lat ?? null,
        pickupLng: quote.pickup.lng ?? null,
        dropoffLat: quote.dropoff.lat ?? null,
        dropoffLng: quote.dropoff.lng ?? null,
        pickupDate: quote.pickupDate,
        returnDate: quote.returnDate || null,
        pickupTime: quote.pickupTime,
        customerName,
        customerPhone,
        carId: quote.carId,
        car: quote.carName,
        luggageCarrier: quote.luggageCarrier,
        estimatedFare: quote.fare.total,
        billedKm: quote.fare.billedKm,
        distanceKm: Math.round(quote.distanceKm * 10) / 10,
        distanceSource: quote.distanceSource,
        breakdown: quote.fare
    };

    if (hasWhatsAppConfiguration()) {
        try {
            notification = await sendManagerWhatsAppAlert(booking);
        } catch (error) {
            console.error(`WhatsApp alert failed for ${reference}:`, error.message);
            notification = { status: 'failed', messageId: null };
        }
    }
    booking.notificationStatus = notification.status;
    await storage.runMutation(() => storage.saveBooking(booking));

    const notificationSent = notification.status === 'sent';
    return response.status(notificationSent ? 201 : 202).json({
        reference,
        notificationSent,
        estimatedFare: booking.estimatedFare,
        message: notificationSent
            ? 'Your request was sent to the City Drive manager. The trip is not confirmed until the manager replies.'
            : 'We recorded your request, but automatic WhatsApp delivery is not available. Please send it through WhatsApp below.'
    });
});

// ---------- Admin API ----------
app.post('/api/admin/login', adminLoginRateLimit, (request, response) => {
    if (!hasAdminConfiguration()) {
        return response.status(503).json({ message: 'Set the admin username, password, and session secret in .env first.' });
    }
    const { username, password } = request.body ?? {};
    if (!constantTimeEquals(username, process.env.ADMIN_USERNAME) || !constantTimeEquals(password, process.env.ADMIN_PASSWORD)) {
        return response.status(401).json({ message: 'Username or password is incorrect.' });
    }
    response.cookie(adminCookieName, createAdminToken(process.env.ADMIN_USERNAME), cookieOptions({ maxAge: adminSessionLifetime }));
    return response.json({ username: process.env.ADMIN_USERNAME });
});

app.post('/api/admin/logout', requireAdmin, (request, response) => {
    response.clearCookie(adminCookieName, cookieOptions());
    response.status(204).end();
});

app.get('/api/admin/session', requireAdmin, (request, response) => response.json({ ok: true }));

app.get('/api/admin/bookings', requireAdmin, async (request, response) => {
    const bookings = await storage.readBookings();
    response.set('Cache-Control', 'no-store');
    response.json(bookings.sort((first, second) => second.createdAt.localeCompare(first.createdAt)));
});

app.get('/api/admin/bookings.csv', requireAdmin, async (request, response) => {
    const bookings = (await storage.readBookings()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const columns = [
        ['reference', 'Reference'], ['createdAt', 'Received'], ['status', 'Status'], ['customerName', 'Customer'],
        ['customerPhone', 'Phone'], ['tripType', 'Trip type'], ['pickup', 'Pickup'], ['dropoff', 'Drop'],
        ['pickupDate', 'Pickup date'], ['pickupTime', 'Pickup time'], ['returnDate', 'Return date'], ['car', 'Car'],
        ['distanceKm', 'Road km'], ['billedKm', 'Billed km'], ['estimatedFare', 'Estimated fare'], ['finalFare', 'Final fare'],
        ['driverName', 'Driver'], ['driverPhone', 'Driver phone'], ['adminNote', 'Note']
    ];
    const escapeCell = value => {
        let cell = String(value ?? '');
        if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`; // stop spreadsheet formula injection
        return `"${cell.replaceAll('"', '""')}"`;
    };
    const lines = [columns.map(([, label]) => escapeCell(label)).join(',')];
    for (const booking of bookings) lines.push(columns.map(([key]) => escapeCell(booking[key])).join(','));
    response.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="city-drive-bookings-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store'
    });
    response.send(`﻿${lines.join('\r\n')}\r\n`);
});

app.patch('/api/admin/bookings/:reference', requireAdmin, async (request, response) => {
    const input = request.body ?? {};
    const changes = {};
    if ('status' in input) {
        if (!allowedBookingStatuses.has(input.status)) return response.status(400).json({ message: 'Choose a valid booking status.' });
        changes.status = input.status;
    }
    if ('driverName' in input) changes.driverName = cleanText(input.driverName, 60);
    if ('driverPhone' in input) {
        const phone = cleanText(String(input.driverPhone ?? '').replace(/\D/g, ''), 10);
        if (phone && phone.length !== 10) return response.status(400).json({ message: 'Driver phone must be 10 digits.' });
        changes.driverPhone = phone;
    }
    if ('finalFare' in input) {
        if (input.finalFare === null || input.finalFare === '') {
            changes.finalFare = null;
        } else {
            const fare = Number(input.finalFare);
            if (!Number.isFinite(fare) || fare < 0 || fare > 5000000) return response.status(400).json({ message: 'Enter a valid final fare.' });
            changes.finalFare = Math.round(fare);
        }
    }
    if ('adminNote' in input) changes.adminNote = cleanText(input.adminNote, 500);
    if (!Object.keys(changes).length) return response.status(400).json({ message: 'Nothing to update.' });

    const booking = await storage.runMutation(() => storage.updateBooking(request.params.reference, changes));
    if (!booking) return response.status(404).json({ message: 'Booking not found.' });
    return response.json(booking);
});

app.get('/api/admin/settings', requireAdmin, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(await storage.readSettings());
});

app.put('/api/admin/settings', requireAdmin, async (request, response) => {
    const { settings, error } = sanitizeSettings(request.body);
    if (error) return response.status(400).json({ message: error });
    await storage.runMutation(() => storage.writeSettings(settings));
    return response.json({ message: 'Saved. The website now uses these settings.', settings });
});

app.post('/api/admin/upload', requireAdmin,
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '3mb' }),
    async (request, response) => {
        if (!Buffer.isBuffer(request.body) || !request.body.length) {
            return response.status(400).json({ message: 'Upload a PNG, JPG or WebP image (max 3 MB).' });
        }
        const url = await storage.saveMedia(request.body);
        return response.status(201).json({ url });
    });

app.use('/api', (request, response) => response.status(404).json({ message: 'API endpoint not found.' }));

app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error(`${request.method} ${request.path} failed:`, error);
    const message = status === 413 ? 'That file is too large.'
        : status >= 500 ? 'Something went wrong on our side. Please try again.'
        : error.message || 'Request could not be processed.';
    return response.status(status).json({ message });
});

// ---------- Quote building ----------
function istToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function cleanPlace(value, fallbackName) {
    const place = value && typeof value === 'object' ? value : {};
    const name = cleanText(place.name ?? place.address, 160) || fallbackName || '';
    const lat = typeof place.lat === 'number' ? place.lat : Number(place.lat);
    const lng = typeof place.lng === 'number' ? place.lng : Number(place.lng);
    return maps.validPoint({ lat, lng }) ? { name, lat, lng } : { name };
}

async function buildQuote(input, settings) {
    const tripType = input.tripType;
    if (!TRIP_TYPES.includes(tripType)) return { error: 'Choose a trip type.' };

    const car = settings.cars.find(item => item.id === input.carId && item.active);
    if (!car) return { error: 'That car is not available. Please choose another.' };

    const pickupDate = input.pickupDate;
    const pickupTime = input.pickupTime;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate || '') || Number.isNaN(Date.parse(`${pickupDate}T00:00:00Z`))) return { error: 'Choose a valid pick-up date.' };
    if (pickupDate < istToday()) return { error: 'Pick-up date cannot be in the past.' };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime || '')) return { error: 'Choose a valid pick-up time.' };

    let returnDate = null;
    if (tripType === 'roundtrip') {
        returnDate = input.returnDate;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate || '') || returnDate < pickupDate) return { error: 'Return date must be on or after the pick-up date.' };
        if (Date.parse(`${returnDate}T00:00:00Z`) - Date.parse(`${pickupDate}T00:00:00Z`) > 59 * 86400000) return { error: 'Round trips are limited to 60 days.' };
    }

    const pickup = cleanPlace(input.pickup);
    const dropoff = tripType === 'local' ? { name: 'Local Hourly Package' } : cleanPlace(input.dropoff);
    if (!pickup.name) return { error: 'Enter a pick-up location.' };
    if (!dropoff.name) return { error: 'Enter a drop location.' };
    for (const point of [pickup, dropoff]) {
        if (maps.validPoint(point) && !maps.insideIndia(point)) return { error: 'Locations must be inside India.' };
    }

    let distance = { distanceKm: 0, source: 'package' };
    if (tripType !== 'local') {
        const clientDistance = Number(input.distanceKm);
        distance = await maps.resolveDistance({
            pickup,
            dropoff,
            clientDistanceKm: Number.isFinite(clientDistance) ? clientDistance : undefined,
            settings
        });
    }

    const luggageCarrier = input.luggageCarrier === true;
    const fare = computeFare(settings.rules, car, { tripType, distanceKm: distance.distanceKm, pickupDate, returnDate, pickupTime, luggageCarrier });
    if (fare.total <= 0 || fare.total > 5000000) return { error: 'We could not price this trip. Please call us.' };

    return {
        quote: {
            tripType,
            carId: car.id,
            carName: car.name,
            pickup,
            dropoff,
            pickupDate,
            returnDate,
            pickupTime,
            luggageCarrier,
            distanceKm: distance.distanceKm,
            distanceSource: distance.source,
            durationMinutes: distance.durationMinutes ?? null,
            duration: maps.formatDuration(distance.durationMinutes),
            polyline: distance.polyline || '',
            fare
        }
    };
}

// ---------- Admin session helpers ----------
function cookieOptions(extra = {}) {
    return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', ...extra };
}

function hasAdminConfiguration() {
    return Boolean(
        process.env.ADMIN_USERNAME
        && process.env.ADMIN_PASSWORD?.length >= 12
        && process.env.ADMIN_SESSION_SECRET?.length >= 32
    );
}

function constantTimeEquals(value, expected) {
    if (typeof value !== 'string' || typeof expected !== 'string') return false;
    const actual = Buffer.from(value);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function createAdminToken(username) {
    const payload = Buffer.from(JSON.stringify({ username, expiresAt: Date.now() + adminSessionLifetime })).toString('base64url');
    const signature = crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function requireAdmin(request, response, next) {
    if (!hasAdminConfiguration()) {
        return response.status(503).json({ message: 'Admin access is not configured. Set the admin values in .env.' });
    }
    const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${adminCookieName}=`));
    const token = cookie?.slice(adminCookieName.length + 1);
    const [payload, signature] = token?.split('.') ?? [];
    if (!payload || !signature) return response.status(401).json({ message: 'Please sign in first.' });

    const expected = crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    if (!constantTimeEquals(signature, expected)) return response.status(401).json({ message: 'Please sign in first.' });

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (session.username !== process.env.ADMIN_USERNAME || session.expiresAt < Date.now()) {
            return response.status(401).json({ message: 'Your admin session expired. Please sign in again.' });
        }
    } catch {
        return response.status(401).json({ message: 'Please sign in first.' });
    }
    return next();
}

// ---------- Helpers ----------
function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function hasWhatsAppConfiguration() {
    return Boolean(
        process.env.WHATSAPP_PHONE_NUMBER_ID
        && process.env.WHATSAPP_ACCESS_TOKEN
        && process.env.CITY_DRIVE_MANAGER_PHONE
        && process.env.WHATSAPP_TEMPLATE_NAME
    );
}

async function sendManagerWhatsAppAlert(booking) {
    const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
    const message = [
        `New booking request ${booking.reference}`,
        `Trip: ${booking.tripType}`,
        `Pickup: ${booking.pickup}`,
        `Drop: ${booking.dropoff}`,
        `Date/time: ${booking.pickupDate} ${booking.pickupTime}`,
        `Car: ${booking.car}`,
        `Customer: ${booking.customerName} (${booking.customerPhone})`,
        `Estimated fare: INR ${booking.estimatedFare.toLocaleString('en-IN')} (${booking.billedKm} km)`,
        'Please contact the customer to confirm availability and final fare.'
    ].join(' | '); // WhatsApp template parameters cannot contain line breaks

    const providerResponse = await fetch(
        `https://graph.facebook.com/${graphVersion}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: process.env.CITY_DRIVE_MANAGER_PHONE.replace(/\D/g, ''),
                type: 'template',
                template: {
                    name: process.env.WHATSAPP_TEMPLATE_NAME,
                    language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
                    components: [{ type: 'body', parameters: [{ type: 'text', text: message }] }]
                }
            }),
            signal: AbortSignal.timeout(10000)
        }
    );
    const result = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) throw new Error(result.error?.message || `WhatsApp API returned ${providerResponse.status}`);
    return { status: 'sent', messageId: result.messages?.[0]?.id || null };
}

async function startServer() {
    storage.validateStorageConfiguration();
    if (storage.hasSupabase()) {
        await storage.initializeStorage();
        console.log('Supabase storage is ready.');
    }
    app.listen(port, '0.0.0.0', () => console.log(`City Drive is listening on port ${port}`));
}

startServer().catch(error => {
    console.error(`City Drive could not start: ${error.message}`);
    process.exitCode = 1;
});
