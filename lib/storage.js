// Storage for bookings, site settings and uploaded images.
// Local development: files in ./data.  Production: Supabase (Postgres) when configured.
import crypto from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withDefaults } from './settings.js';

let dataDirectory = path.resolve('data');
// Accept the URL however it was pasted (extra /rest/v1, trailing slash, spaces): keep only the address part.
const supabaseUrl = () => {
    const raw = (process.env.SUPABASE_URL || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return '';
    try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin; } catch { return raw.replace(/\/+$/, ''); }
};
const supabaseSecretKey = () => process.env.SUPABASE_SECRET_KEY || '';
const supabaseLegacyKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseApiKey = () => supabaseSecretKey() || supabaseLegacyKey();

export function configureStorage({ directory }) {
    dataDirectory = directory;
}

export function hasSupabase() {
    return Boolean(supabaseUrl() && supabaseApiKey());
}

export function storageBackend() {
    return hasSupabase() ? 'supabase' : 'local-file';
}

// All writes go through one queue so concurrent requests cannot overwrite each other.
let mutationQueue = Promise.resolve();
export function runMutation(mutation) {
    const result = mutationQueue.then(mutation);
    mutationQueue = result.catch(() => {});
    return result;
}

const bookingsFile = () => path.join(dataDirectory, 'bookings.ndjson');
const settingsFile = () => path.join(dataDirectory, 'settings.json');
const legacyPricingFile = () => path.join(dataDirectory, 'pricing.json');
const mediaDirectory = () => path.join(dataDirectory, 'media');

async function atomicWrite(file, content) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
}

async function readJsonFile(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

// ---------- Supabase REST helper ----------
async function supabaseRequest(pathname, options = {}) {
    const headers = new Headers({
        apikey: supabaseApiKey(),
        'Content-Type': 'application/json',
        ...options.headers
    });
    if (!supabaseSecretKey() && supabaseLegacyKey()) headers.set('Authorization', `Bearer ${supabaseLegacyKey()}`);
    const response = await fetch(`${supabaseUrl()}/rest/v1/${pathname}`, {
        ...options,
        headers,
        signal: options.signal || AbortSignal.timeout(15000)
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${responseText.slice(0, 400)}`);
    return responseText ? JSON.parse(responseText) : [];
}

const BOOKING_COLUMNS = 'reference,created_at,status,status_updated_at,notification_status,data';

function rowToBooking(row) {
    return {
        ...row.data,
        reference: row.reference,
        createdAt: row.created_at,
        status: row.status,
        statusUpdatedAt: row.status_updated_at,
        notificationStatus: row.notification_status
    };
}

function bookingToRow(booking) {
    return {
        reference: booking.reference,
        created_at: booking.createdAt,
        status: booking.status || 'new',
        status_updated_at: booking.statusUpdatedAt || null,
        notification_status: booking.notificationStatus || 'not_configured',
        data: booking
    };
}

// ---------- Settings ----------
export async function readSettings() {
    if (hasSupabase()) {
        const rows = await supabaseRequest('city_drive_pricing?select=settings&id=eq.1&limit=1');
        if (rows.length) return withDefaults(rows[0].settings);
    }
    const saved = (await readJsonFile(settingsFile())) ?? (await readJsonFile(legacyPricingFile()));
    return withDefaults(saved);
}

export async function writeSettings(settings) {
    if (hasSupabase()) {
        await supabaseRequest('city_drive_pricing?on_conflict=id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ id: 1, settings, updated_at: new Date().toISOString() })
        });
        return;
    }
    await atomicWrite(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
}

// ---------- Bookings ----------
async function readLocalBookings() {
    try {
        const content = await readFile(bookingsFile(), 'utf8');
        return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeLocalBookings(bookings) {
    await atomicWrite(bookingsFile(), bookings.map(booking => JSON.stringify(booking)).join('\n') + (bookings.length ? '\n' : ''));
}

export async function readBookings() {
    if (hasSupabase()) {
        const rows = await supabaseRequest(`city_drive_bookings?select=${BOOKING_COLUMNS}&order=created_at.desc`);
        return rows.map(rowToBooking);
    }
    return readLocalBookings();
}

export async function saveBooking(booking) {
    if (hasSupabase()) {
        await supabaseRequest('city_drive_bookings', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(bookingToRow(booking))
        });
        return;
    }
    await mkdir(dataDirectory, { recursive: true });
    await appendFile(bookingsFile(), `${JSON.stringify(booking)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** Merge `changes` into a booking. Returns the updated booking or null. */
export async function updateBooking(reference, changes) {
    const now = new Date().toISOString();
    if (hasSupabase()) {
        const query = new URLSearchParams({ reference: `eq.${reference}`, select: BOOKING_COLUMNS });
        const rows = await supabaseRequest(`city_drive_bookings?${query}`);
        if (!rows.length) return null;
        const merged = { ...rowToBooking(rows[0]), ...changes };
        if (changes.status && changes.status !== rows[0].status) merged.statusUpdatedAt = now;
        const updated = await supabaseRequest(`city_drive_bookings?${query}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
                status: merged.status,
                status_updated_at: merged.statusUpdatedAt || null,
                data: merged
            })
        });
        return updated.length ? rowToBooking(updated[0]) : null;
    }
    const bookings = await readLocalBookings();
    const booking = bookings.find(item => item.reference === reference);
    if (!booking) return null;
    if (changes.status && changes.status !== booking.status) booking.statusUpdatedAt = now;
    Object.assign(booking, changes);
    await writeLocalBookings(bookings);
    return booking;
}

// ---------- Uploaded images ----------
const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export function sniffImage(buffer) {
    if (buffer.length > 12 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
    return null;
}

/** Store an image and return its public path, e.g. /media/ab12cd.jpg */
export async function saveMedia(buffer) {
    const extension = sniffImage(buffer);
    if (!extension) throw Object.assign(new Error('Upload a PNG, JPG or WebP image.'), { status: 400 });
    const id = `${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24)}.${extension}`;
    if (hasSupabase()) {
        await supabaseRequest('city_drive_media?on_conflict=id', {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify({ id, content_type: MEDIA_TYPES[extension], data: buffer.toString('base64') })
        });
    } else {
        await mkdir(mediaDirectory(), { recursive: true });
        await writeFile(path.join(mediaDirectory(), id), buffer, { mode: 0o600 });
    }
    return `/media/${id}`;
}

export async function readMedia(id) {
    const match = /^[a-f0-9]{24}\.(png|jpg|webp)$/.exec(id);
    if (!match) return null;
    if (hasSupabase()) {
        const query = new URLSearchParams({ id: `eq.${id}`, select: 'content_type,data' });
        const rows = await supabaseRequest(`city_drive_media?${query}`);
        if (!rows.length) return null;
        return { contentType: rows[0].content_type, buffer: Buffer.from(rows[0].data, 'base64') };
    }
    try {
        return { contentType: MEDIA_TYPES[match[1]], buffer: await readFile(path.join(mediaDirectory(), id)) };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

// ---------- Startup ----------
export function validateStorageConfiguration() {
    const hasUrl = Boolean(supabaseUrl());
    const hasKey = Boolean(supabaseApiKey());
    if (hasUrl !== hasKey) {
        throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY, or leave both unset for local file storage.');
    }
    if (process.env.NODE_ENV === 'production' && !hasSupabase()) {
        throw new Error('Production requires Supabase storage. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
    }
}

export async function initializeStorage() {
    if (!hasSupabase()) return;
    await supabaseRequest('city_drive_bookings?select=reference&limit=1');
    const pricingRows = await supabaseRequest('city_drive_pricing?select=id&limit=1');
    try {
        await supabaseRequest('city_drive_media?select=id&limit=1');
    } catch (error) {
        throw new Error(`${error.message}\nThe image table is missing. Re-run supabase/schema.sql in the Supabase SQL Editor.`);
    }

    // One-time import of local development data (never overwrites existing rows).
    const local = await readLocalBookings();
    for (let offset = 0; offset < local.length; offset += 100) {
        await supabaseRequest('city_drive_bookings?on_conflict=reference', {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(local.slice(offset, offset + 100).map(bookingToRow))
        });
    }
    if (!pricingRows.length) {
        const saved = (await readJsonFile(settingsFile())) ?? (await readJsonFile(legacyPricingFile()));
        await writeSettings(withDefaults(saved));
    }
}
