// City Drive public website: live fare, map search / pin / route (OpenStreetMap or Google), booking.
'use strict';

const FALLBACK_CITIES = [
    'Chennai', 'Bengaluru', 'Coimbatore', 'Madurai', 'Trichy', 'Salem', 'Pondicherry', 'Vellore', 'Mysore',
    'Kanchipuram', 'Tirupati', 'Hyderabad', 'Ooty', 'Kodaikanal', 'Thanjavur', 'Tirunelveli', 'Erode', 'Hosur',
    'Nagercoil', 'Dindigul', 'Kochi', 'Trivandrum', 'Mumbai', 'Pune', 'Delhi'
];

const state = {
    config: null,
    tripType: 'oneway',
    carId: null,
    pickup: { name: '' },   // { name, lat?, lng? }
    dropoff: { name: '' },
    route: null,             // { distanceKm, source, durationText, polyline, clientPath }
    routeLoading: false,
    routeError: '',
    lastQuote: null,
    pinMode: null            // 'pickup' | 'dropoff' | null
};

const maps = { ready: false };   // true once a map provider (OpenStreetMap or Google) has started
const mapApi = {};               // filled in by the active provider: suggest, reverse, setMarker, drawPath, ...
let routeSeq = 0;
let routeTimer = null;
const $ = id => document.getElementById(id);

// ---------- helpers ----------
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const inr = value => `₹${Math.round(value).toLocaleString('en-IN')}`;
const formatHour = hour => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const activeCar = () => state.config.cars.find(car => car.id === state.carId) || state.config.cars[0];

function isLiveServerPreview() {
    return ['localhost', '127.0.0.1'].includes(location.hostname) && ['5500', '5501'].includes(location.port);
}
const apiEndpoint = path => `${isLiveServerPreview() ? 'http://localhost:3000' : ''}${path}`;

async function postJson(path, body) {
    const response = await fetch(apiEndpoint(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.message || 'Request failed.'), { status: response.status, data });
    return data;
}

// ---------- start-up ----------
window.addEventListener('DOMContentLoaded', init);

async function init() {
    window.setTimeout(dismissBrandIntro, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 350 : 1850);
    try {
        const response = await fetch(apiEndpoint('/api/config'), { cache: 'no-store' });
        if (!response.ok) throw new Error('config');
        state.config = await response.json();
    } catch {
        $('live-fare').innerHTML = '<p class="text-xs text-red-200">We could not reach the booking server. Please refresh, or call us to book.</p>';
        return;
    }

    state.carId = state.config.cars[0].id;
    applySite();
    renderCarSelectors();
    renderTariffCards();
    renderRouteFilters();
    renderPopularRoutes('all');
    renderFAQs();
    setupForm();
    setupMobileDrawer();
    setTripType('oneway');
    initAssistant();
    if (state.config.maps.enabled) startMaps();
}

function applySite() {
    const site = state.config.site;
    document.title = `${site.businessName} | ${site.tagline || 'Intercity & Outstation Cabs'}`;
    document.querySelectorAll('[data-bind]').forEach(node => { node.textContent = site[node.dataset.bind] || ''; });
    document.querySelectorAll('[data-bind-logo]').forEach(img => { img.src = site.logo; });

    const words = site.businessName.split(' ');
    const last = words.pop();
    const brandHtml = `${esc(words.join(' '))}${words.length ? ' ' : ''}<span class="text-gold-400">${esc(last)}</span>`;
    $('brand-name').innerHTML = brandHtml;
    $('footer-brand-name').innerHTML = brandHtml;

    const pretty = number => `+91 ${number}`;
    document.querySelectorAll('[data-phone]').forEach(link => {
        const number = site[link.dataset.phone === 'primary' ? 'phonePrimary' : 'phoneAlternate'];
        if (!number) { (link.closest('li') || link).classList.add('hidden'); return; }
        link.href = `tel:+91${number}`;
        const label = link.querySelector('span');
        if (label) label.textContent = `${link.dataset.phoneLabel || ''}${pretty(number)}`;
    });
    document.querySelectorAll('[data-phone-text]').forEach(node => { node.textContent = pretty(site.phonePrimary); });
    document.querySelectorAll('[data-whatsapp]').forEach(link => {
        const text = link.dataset.whatsappText ? `?text=${encodeURIComponent(link.dataset.whatsappText)}` : '';
        link.href = `https://wa.me/${site.whatsapp}${text}`;
    });
    document.querySelectorAll('[data-instagram]').forEach(link => {
        if (!site.instagram) { (link.closest('li') || link).classList.add('hidden'); return; }
        link.href = `https://instagram.com/${site.instagram}`;
        const label = link.querySelector('span');
        if (label) label.textContent = `@${site.instagram}`;
    });
    const instaLabel = document.querySelector('[data-instagram-label]');
    if (instaLabel && site.instagram) instaLabel.textContent = `Instagram (@${site.instagram})`;

    const portal = isLiveServerPreview() || location.protocol === 'file:' ? 'http://localhost:3000/admin' : '/admin';
    $('mobile-admin-link').href = portal;
    $('footer-admin-link').href = portal;
}

// ---------- form wiring ----------
function setupForm() {
    const date = $('pickup-date');
    date.min = today();
    date.value = addDays(today(), 1);
    $('return-date').min = date.value;

    $('booking-form').addEventListener('submit', event => { event.preventDefault(); reviewBooking(); });

    for (const which of ['pickup', 'dropoff']) {
        const input = $(which === 'pickup' ? 'pickup-city' : 'drop-city');
        input.addEventListener('input', () => onPlaceTyped(which));
        input.addEventListener('blur', () => window.setTimeout(() => hideSuggestions(which), 150));
        input.addEventListener('keydown', event => { if (event.key === 'Escape') hideSuggestions(which); });
        $(which === 'pickup' ? 'pin-pickup' : 'pin-drop').addEventListener('click', () => togglePinMode(which));
    }
    $('use-location').addEventListener('click', useMyLocation);

    date.addEventListener('change', () => {
        const returnInput = $('return-date');
        returnInput.min = date.value;
        if (!returnInput.value || returnInput.value < date.value) returnInput.value = addDays(date.value, 1);
        renderFare();
    });
    for (const id of ['return-date', 'pickup-time', 'luggage-carrier']) $(id).addEventListener('change', renderFare);
    $('cust-phone').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 10); });
}

const TAB_ACTIVE = 'gold-gradient text-navy-950 shadow-md';
const TAB_IDLE = 'text-slate-600 hover:text-navy-900';

function setTripType(type) {
    state.tripType = type;
    for (const id of ['oneway', 'roundtrip', 'local']) {
        const button = $(`tab-${id}`);
        const base = 'flex-1 py-2.5 px-2 rounded-lg font-bold text-xs transition-all flex items-center justify-center gap-2 ';
        button.className = base + (id === type ? TAB_ACTIVE : TAB_IDLE);
        button.setAttribute('aria-pressed', String(id === type));
    }
    $('drop-city-container').classList.toggle('hidden', type === 'local');
    $('return-date-container').classList.toggle('hidden', type !== 'roundtrip');
    if (type === 'roundtrip' && !$('return-date').value) $('return-date').value = addDays($('pickup-date').value || today(), 1);
    if (type === 'local') setPinMode(null);
    scheduleRoute(0);
}

// ---------- cars ----------
function renderCarSelectors() {
    const container = $('car-type-selector');
    container.innerHTML = state.config.cars.map(car => `
        <button type="button" role="radio" aria-checked="${car.id === state.carId}" data-car="${esc(car.id)}"
             class="text-left cursor-pointer p-3 rounded-xl border-2 transition-all ${car.id === state.carId ? 'border-gold-500 bg-gold-500/10' : 'border-slate-200 bg-slate-50 hover:border-slate-300'}">
            <span class="block text-xs font-black text-navy-900">${esc(car.name)}</span>
            <span class="block text-[10px] text-slate-500 font-bold">${esc(car.subtitle)}</span>
            <span class="block text-xs font-black text-gold-600 mt-1">${inr(car.ratePerKm)} / KM</span>
        </button>`).join('');
    container.querySelectorAll('[data-car]').forEach(button => button.addEventListener('click', () => selectCar(button.dataset.car)));
    container.className = `grid grid-cols-1 gap-3 ${state.config.cars.length >= 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`;
}

function selectCar(id) {
    state.carId = id;
    renderCarSelectors();
    renderFare();
}

function renderTariffCards() {
    const rules = state.config.rules;
    $('tariff-cards-grid').innerHTML = state.config.cars.map(car => `
        <div class="bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-xl hover:border-gold-500 transition-all flex flex-col justify-between">
            <div>
                <div class="h-48 overflow-hidden relative bg-navy-900/5 flex items-center justify-center">
                    ${car.image ? `<img src="${esc(car.image)}" alt="${esc(car.name)}" loading="lazy" class="w-full h-full object-cover hover:scale-105 transition-transform duration-500">` : '<i class="fa-solid fa-car-side text-5xl text-gold-500"></i>'}
                    <span class="absolute top-3 right-3 gold-gradient text-navy-950 font-black text-xs px-3 py-1 rounded-full shadow-md">${inr(car.ratePerKm)}/KM</span>
                </div>
                <div class="p-6">
                    <h3 class="text-xl font-black text-navy-900">${esc(car.name)}</h3>
                    <p class="text-xs font-bold text-gold-600 mb-2">${esc(car.subtitle)}</p>
                    <p class="text-xs text-slate-500 mb-4">${esc(car.description)}</p>
                    <div class="space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-700">
                        <div class="flex justify-between"><span>Driver Allowance:</span><strong>${inr(car.driverAllowance)} / day</strong></div>
                        <div class="flex justify-between"><span>Night Allowance (${formatHour(rules.nightStartHour)} - ${formatHour(rules.nightEndHour)}):</span><strong>+${inr(car.nightAllowance)}</strong></div>
                        ${car.luggageCarrierCost ? `<div class="flex justify-between"><span>Roof Luggage Option:</span><strong>+${inr(car.luggageCarrierCost)}</strong></div>` : ''}
                    </div>
                </div>
            </div>
            <div class="p-6 pt-0">
                <button type="button" data-quick-car="${esc(car.id)}" class="w-full py-3 rounded-xl bg-navy-900 hover:bg-gold-500 hover:text-navy-950 text-white font-bold text-xs transition-all shadow-md">Book ${esc(car.name)}</button>
            </div>
        </div>`).join('');
    document.querySelectorAll('[data-quick-car]').forEach(button => button.addEventListener('click', () => {
        selectCar(button.dataset.quickCar);
        $('estimator').scrollIntoView({ behavior: 'smooth' });
    }));
}

// ---------- routes, FAQs, assistant ----------
function renderRouteFilters() {
    const origins = [...new Set(state.config.routes.map(route => route.origin))].slice(0, 4);
    const filters = [['all', 'All Routes'], ...origins.map(origin => [origin, `From ${origin}`])];
    $('route-filters').innerHTML = filters.map(([key, label], index) => `
        <button type="button" data-route-filter="${esc(key)}" class="route-btn px-4 py-1.5 rounded-lg text-xs font-bold ${index === 0 ? 'gold-gradient text-navy-950' : 'bg-navy-800 text-slate-300 hover:bg-navy-700'}">${esc(label)}</button>`).join('');
    $('route-filters').querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        $('route-filters').querySelectorAll('button').forEach(other => {
            other.className = `route-btn px-4 py-1.5 rounded-lg text-xs font-bold ${other === button ? 'gold-gradient text-navy-950' : 'bg-navy-800 text-slate-300 hover:bg-navy-700'}`;
        });
        renderPopularRoutes(button.dataset.routeFilter);
    }));
}

function renderPopularRoutes(filter) {
    const routes = state.config.routes.filter(route => filter === 'all' || route.origin === filter);
    $('routes-grid').innerHTML = routes.map((route, index) => `
        <div class="bg-navy-800 p-4 rounded-xl border border-navy-700 hover:border-gold-500 transition-all flex items-center justify-between gap-3">
            <div class="min-w-0">
                <h4 class="text-sm font-bold text-white">${esc(route.origin)} <i class="fa-solid fa-arrow-right text-xs text-gold-400 mx-1"></i> ${esc(route.destination)}</h4>
                <p class="text-xs text-slate-400 mt-1">${esc(route.distanceKm)} KM${route.duration ? ` • Approx ${esc(route.duration)}` : ''}</p>
            </div>
            <button type="button" data-route="${state.config.routes.indexOf(route)}" class="px-3 py-2 rounded-lg gold-gradient text-navy-950 font-black text-xs">Book</button>
        </div>`).join('') || '<p class="text-sm text-slate-400">No routes listed yet.</p>';
    $('routes-grid').querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => {
        const route = state.config.routes[Number(button.dataset.route)];
        quickSelectRoute(route.origin, route.destination);
    }));
}

async function quickSelectRoute(origin, destination) {
    setTripType('oneway');
    setPlace('pickup', { name: origin });
    setPlace('dropoff', { name: destination });
    $('estimator').scrollIntoView({ behavior: 'smooth' });
    if (maps.ready) {
        await Promise.all([resolveTyped('pickup'), resolveTyped('dropoff')]);
    }
    scheduleRoute(0);
}

function faqText(answer) {
    const rules = state.config.rules;
    return answer
        .replaceAll('{minKm}', rules.minimumBillableKm)
        .replaceAll('{nightStart}', formatHour(rules.nightStartHour))
        .replaceAll('{nightEnd}', formatHour(rules.nightEndHour))
        .replaceAll('{tollPerKm}', `₹${rules.tollPerKm}`);
}

function renderFAQs() {
    $('faq-container').innerHTML = state.config.faqs.map((faq, index) => `
        <div class="bg-navy-800 rounded-xl border border-navy-700 overflow-hidden">
            <button type="button" data-faq="${index}" class="w-full p-4 text-left font-bold text-sm text-white flex justify-between items-center gap-3" aria-expanded="false">
                <span>${esc(faq.question)}</span>
                <i class="fa-solid fa-chevron-down text-gold-400 transition-transform"></i>
            </button>
            <div class="hidden p-4 pt-3 text-xs text-slate-300 border-t border-navy-700/50">${esc(faqText(faq.answer))}</div>
        </div>`).join('');
    $('faq-container').querySelectorAll('[data-faq]').forEach(button => button.addEventListener('click', () => {
        const answer = button.nextElementSibling;
        answer.classList.toggle('hidden');
        button.querySelector('i').classList.toggle('rotate-180');
        button.setAttribute('aria-expanded', String(!answer.classList.contains('hidden')));
    }));
}

function toggleFloatingMenu() {
    const menu = $('floating-menu');
    menu.classList.toggle('hidden');
    menu.classList.toggle('flex');
    $('floating-btn-icon').className = menu.classList.contains('flex') ? 'fa-solid fa-xmark' : 'fa-solid fa-headset';
}

function setupMobileDrawer() {
    $('mobile-menu-btn').addEventListener('click', () => $('mobile-menu').classList.toggle('hidden'));
}

// ---------- Trip assistant ----------
// Answers from the live website settings (cars, rates, rules, routes, FAQs, contact details).
// It can also price a trip typed like "Chennai to Madurai SUV" using the same server quote as the booking form.
const assistant = { busy: false, lastTrip: null };

const QUICK_CHIPS = [
    ['Fare for a trip', 'fare'], ['Our cars', 'cars'], ['Night charges', 'night'], ['How to book', 'book'], ['Contact', 'contact']
];

function initAssistant() {
    $('ai-chat-form').addEventListener('submit', handleAIQuestion);
    const name = state.config.site.businessName;
    addAIMessage(`Hi! I'm the ${name} trip assistant.\nTell me a trip like “Chennai to Madurai” and I'll price every car for you, or tap a topic below.`);
    $('ai-chips').innerHTML = QUICK_CHIPS.map(([label, key]) =>
        `<button type="button" data-chip="${key}" class="shrink-0 rounded-full border border-gold-500/50 bg-ivory-100 px-3 py-1.5 text-[11px] font-bold text-navy-900 hover:bg-gold-500/20">${esc(label)}</button>`).join('');
    $('ai-chips').querySelectorAll('[data-chip]').forEach(button => button.addEventListener('click', () => {
        const prompts = { fare: 'How do I get a fare for my trip?', cars: 'What cars do you have?', night: 'What are the night charges?', book: 'How do I book?', contact: 'How can I contact you?' };
        askAssistant(prompts[button.dataset.chip]);
    }));
}

function toggleCityDriveAI() {
    const panel = $('ai-chat-panel');
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    $('ai-chat-toggle').setAttribute('aria-expanded', String(opening));
    if (opening) $('ai-chat-input').focus();
}

function handleAIQuestion(event) {
    event.preventDefault();
    const input = $('ai-chat-input');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    askAssistant(question);
}

function addAIMessage(text, fromCustomer = false, actions = []) {
    const box = $('ai-chat-messages');
    const wrap = document.createElement('div');
    wrap.className = fromCustomer ? 'flex justify-end' : 'flex flex-col items-start gap-2';
    const bubble = document.createElement('p');
    bubble.className = (fromCustomer
        ? 'max-w-[88%] rounded-xl rounded-tr-sm bg-navy-900 text-white'
        : 'max-w-[92%] rounded-xl rounded-tl-sm bg-white text-slate-700 shadow-sm') + ' whitespace-pre-line p-3 text-xs leading-relaxed';
    bubble.textContent = text;
    bubble.style.whiteSpace = 'pre-line';
    wrap.append(bubble);
    if (actions.length) {
        const row = document.createElement('div');
        row.className = 'flex flex-wrap gap-2';
        for (const action of actions) {
            const control = document.createElement(action.href ? 'a' : 'button');
            control.className = 'rounded-full gold-gradient px-3.5 py-2 text-[11px] font-extrabold text-navy-950 shadow';
            control.textContent = action.label;
            if (action.href) { control.href = action.href; if (/^https?:/.test(action.href)) { control.target = '_blank'; control.rel = 'noopener'; } }
            else { control.type = 'button'; control.addEventListener('click', action.run); }
            row.append(control);
        }
        wrap.append(row);
    }
    box.append(wrap);
    box.scrollTop = box.scrollHeight;
    return wrap;
}

async function askAssistant(question) {
    if (assistant.busy) return;
    assistant.busy = true;
    addAIMessage(question, true);
    const typing = document.createElement('div');
    typing.className = 'w-fit rounded-xl rounded-tl-sm bg-white px-3 py-3 shadow-sm chat-dots';
    typing.innerHTML = '<span></span><span></span><span></span>';
    $('ai-chat-messages').append(typing);
    $('ai-chat-messages').scrollTop = 1e6;
    let reply;
    try {
        reply = await assistantReply(question);
    } catch (error) {
        console.warn('Assistant error', error);
        reply = { text: 'Sorry, I could not work that out just now. Please use the booking form above, or call us and the manager will help.', actions: contactActions() };
    }
    await new Promise(resolve => window.setTimeout(resolve, 350));
    typing.remove();
    addAIMessage(reply.text, false, reply.actions || []);
    assistant.busy = false;
}

// ----- knowledge helpers -----
const shortName = name => String(name || '').split(',')[0].trim();
const rupees = value => `₹${Math.round(value).toLocaleString('en-IN')}`;
const range = values => { const lo = Math.min(...values), hi = Math.max(...values); return lo === hi ? rupees(lo) : `${rupees(lo)}–${rupees(hi)}`; };
const carsList = () => state.config.cars;
const contactActions = () => {
    const site = state.config.site;
    const actions = [];
    if (site.phonePrimary) actions.push({ label: `📞 Call ${site.phonePrimary}`, href: `tel:+91${site.phonePrimary}` });
    if (site.whatsapp) actions.push({ label: '💬 WhatsApp', href: `https://wa.me/${site.whatsapp}?text=${encodeURIComponent('Hi, I want to book a cab')}` });
    return actions;
};
const openForm = () => { $('ai-chat-panel').classList.add('hidden'); $('ai-chat-toggle').setAttribute('aria-expanded', 'false'); $('estimator').scrollIntoView({ behavior: 'smooth' }); };

const NOT_A_PLACE_FIRST = /^(how|want|need|going|go|ready|back|used|able|me|us|you|it|them|talk|speak|call|pay|know|happy|time|way|trying|plan|planning|like|have|has|get|what|which|when|where|do|can|is|are)$/i;
const NOT_A_PLACE_SECOND = /^(book|pay|call|know|get|go|see|check|reserve|ask|use|travel|cancel|me|you|us|them|it|do|make|find|help|contact|talk|speak)$/i;

function parseTrip(text) {
    const match = /(?:^|\s)(?:from\s+)?([a-z][a-z .'-]{1,38}?)\s+(?:to|->|→|–|—)\s+([a-z][a-z .'-]{1,38}?)(?=\s+(?:in|by|for|with|on|at|using|via|round|return|one|suv|sedan|cng|car|cab|taxi|tomorrow|today)\b|[?.,!]|$)/i.exec(` ${text}`);
    if (!match) return null;
    const from = match[1].trim().replace(/^(?:i want to go|i need|going|trip|fare|price|cost|taxi|cab)\s+(?:from\s+)?/i, '').trim();
    const to = match[2].trim();
    if (from.length < 2 || to.length < 2 || NOT_A_PLACE_FIRST.test(from.split(/\s+/)[0]) || NOT_A_PLACE_SECOND.test(to.split(/\s+/)[0])) return null;
    return { from, to };
}

function findListedPlace(name) {
    const needle = name.toLowerCase();
    const names = new Set([...FALLBACK_CITIES]);
    state.config.routes.forEach(route => { names.add(route.origin); names.add(route.destination); });
    return [...names].find(candidate => candidate.toLowerCase() === needle) || null;
}

async function resolveForAssistant(name) {
    if (maps.ready) {
        const [first] = await mapApi.suggest(name);
        if (first) return first.resolve();
        return null;
    }
    const listed = findListedPlace(name);
    return listed ? { name: listed } : null;
}

async function tripReply(question, trip) {
    const q = question.toLowerCase();
    const roundtrip = /round|return/.test(q);
    const wanted = carsList().filter(car => q.includes(car.name.toLowerCase()) || (car.id && q.includes(car.id.replace(/_/g, ' '))));
    const cars = wanted.length ? wanted : carsList();

    const [from, to] = await Promise.all([resolveForAssistant(trip.from), resolveForAssistant(trip.to)]);
    if (!from || !to) {
        const missing = [!from && trip.from, !to && trip.to].filter(Boolean).join(' or ');
        return {
            text: maps.ready
                ? `I couldn't find “${missing}” on the map. Try the full place name (for example “Chennai Central to Madurai Junction”), or use the booking form above.`
                : `I only know the routes listed on this site, and “${missing}” isn't one of them. Please use the booking form above to search, or call us and the manager will quote the fare.`,
            actions: [{ label: 'Open booking form', run: openForm }, ...contactActions()]
        };
    }

    const date = addDays(today(), 1);
    const quotes = await Promise.all(cars.map(car => postJson('/api/quote', {
        tripType: roundtrip ? 'roundtrip' : 'oneway', carId: car.id, pickupDate: date, returnDate: roundtrip ? date : null, pickupTime: '09:00',
        pickup: from, dropoff: to
    })));
    const first = quotes[0];
    const km = Math.round(first.distanceKm);
    const approximate = ['straight-line-estimate', 'default-estimate'].includes(first.distanceSource);
    const night = cars.map(car => car.nightAllowance);
    const lines = [
        `${shortName(from.name)} → ${shortName(to.name)}`,
        `${approximate ? '≈' : ''}${km} km${first.duration ? ` · about ${first.duration}` : ''} one way${approximate ? ' (approximate)' : ''}`,
        '',
        ...quotes.map((quote, i) => `${cars[i].name}: ${rupees(quote.fare.total)}`),
        '',
        roundtrip
            ? 'Same-day round trip (there and back, driver allowance and tolls included). Extra days add the driver allowance and the minimum km for each day.'
            : 'Daytime one-way fare with driver allowance and estimated tolls.',
        `Night pick-up (${formatHour(state.config.rules.nightStartHour)}–${formatHour(state.config.rules.nightEndHour)}) adds ${range(night)}; a roof carrier adds ${range(cars.map(car => car.luggageCarrierCost))} if you need one.`,
        'The manager confirms availability and the final fare.'
    ];
    assistant.lastTrip = { from, to, roundtrip, carId: cars.length === 1 ? cars[0].id : null };
    return {
        text: lines.join('\n'),
        actions: [{ label: 'Use this trip in the form', run: () => useTripInForm(assistant.lastTrip) }, ...contactActions().slice(0, 1)]
    };
}

function useTripInForm(trip) {
    if (!trip) return;
    setTripType(trip.roundtrip ? 'roundtrip' : 'oneway');
    setPlace('pickup', trip.from);
    setPlace('dropoff', trip.to);
    if (trip.carId) selectCar(trip.carId);
    scheduleRoute(0);
    openForm();
}

function faqMatch(q) {
    const words = new Set(q.split(/\W+/).filter(word => word.length > 3));
    let best = null;
    let bestScore = 0;
    for (const faq of state.config.faqs) {
        const haystack = `${faq.question} ${faq.answer}`.toLowerCase();
        const score = [...words].filter(word => haystack.includes(word)).length;
        if (score > bestScore) { best = faq; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;
}

async function assistantReply(question) {
    const q = question.toLowerCase().trim();
    const { cars, rules, routes, site } = state.config;
    const has = pattern => pattern.test(q);

    if (has(/^(hi|hello|hey|hii+|namaste|vanakkam|good (morning|afternoon|evening))\b/) && q.split(/\s+/).length <= 4) {
        return { text: 'Hello! 👋 Give me a trip like “Chennai to Bengaluru” and I’ll price every car. I can also explain our cars, night charges, tolls and how to book.' };
    }
    if (has(/\b(thanks|thank you|thx|ok thanks|great|perfect)\b/) && q.split(/\s+/).length <= 5) {
        return { text: 'You’re welcome! Tap “Open booking form” whenever you’re ready to book.', actions: [{ label: 'Open booking form', run: openForm }] };
    }

    const trip = parseTrip(question);
    if (trip) return tripReply(question, trip);

    if (has(/\b(phone|call|number|contact|whatsapp|instagram|manager|human|support|talk|speak|reach)\b/)) {
        return {
            text: `You can reach the ${site.businessName} manager 24/7.\n${site.phonePrimary ? `Phone: +91 ${site.phonePrimary}\n` : ''}${site.phoneAlternate ? `Alternate: +91 ${site.phoneAlternate}\n` : ''}${site.instagram ? `Instagram: @${site.instagram}` : ''}`.trim(),
            actions: contactActions()
        };
    }
    if (has(/\b(night|late|midnight|early morning)\b/)) {
        return { text: `Night charges apply when pick-up is between ${formatHour(rules.nightStartHour)} and ${formatHour(rules.nightEndHour)}. It is a flat allowance added once to the fare:\n${cars.map(car => `${car.name}: +${rupees(car.nightAllowance)}`).join('\n')}` };
    }
    if (has(/\b(toll|permit|tax|state entry)\b/)) {
        return { text: `Fares include an estimated toll and permit amount of about ₹${rules.tollPerKm} per billed km. Toll gates and state entry permits are charged as actuals during the journey, so the final amount can differ slightly.` };
    }
    if (has(/\b(minimum|min km|min\.|minimum km|base km)\b/)) {
        return { text: `One-way trips are billed for at least ${rules.minimumBillableKm} km. For round trips the minimum applies for each day of the trip.` };
    }
    if (has(/\b(round|return|two way|back and forth|come back)\b/)) {
        return { text: `Round trips are billed for the distance there and back (at least ${rules.minimumBillableKm} km for each day), plus the driver allowance for every day.\nTry “Chennai to Madurai round trip” and I’ll price it.` };
    }
    if (has(/\b(local|hourly|package|within the city|city ride|city drive)\b/)) {
        return { text: `Local Hourly is a ${rules.localPackageKm} km city package at each car's per-km rate plus the driver allowance:\n${cars.map(car => `${car.name}: about ${rupees(rules.localPackageKm * car.ratePerKm + car.driverAllowance + rules.localPackageKm * rules.tollPerKm)}`).join('\n')}\nChoose “Local Hourly” in the booking form to see your exact fare.`, actions: [{ label: 'Open booking form', run: openForm }] };
    }
    if (has(/\b(luggage|bags?|carrier|roof|suitcase|boot|dicky)\b/)) {
        return { text: `If you have extra luggage, tick “Luggage Carrier Required on Roof” in the booking form. It adds ${cars.map(car => `${rupees(car.luggageCarrierCost)} (${car.name})`).join(', ')}.` };
    }
    if (has(/\b(cars?|vehicles?|fleet|seats?|seater|suv|sedan|cng|innova|ertiga|dzire|etios|amaze|aura|marazzo|capacity|people|family|group|passengers)\b/) && !has(/\b(per km|rate|price|cost|fare|how much)\b/)) {
        return { text: `Our cars:\n${cars.map(car => `• ${car.name} — ${car.subtitle}\n  ${car.description}\n  ${rupees(car.ratePerKm)}/km, driver allowance ${rupees(car.driverAllowance)}/day`).join('\n')}\nTell me your route and I’ll price them.` };
    }
    if (has(/\b(fare|price|cost|rate|rates|charge|charges|how much|per km|tariff|estimate|quote)\b/)) {
        return { text: `Rates per km: ${cars.map(car => `${car.name} ${rupees(car.ratePerKm)}`).join(', ')}. The fare adds the driver allowance, estimated tolls, and night or roof-carrier extras when they apply.\nFor an exact price, type your trip like “Chennai to Madurai” (add “SUV” or “round trip” if you like).` };
    }
    if (has(/\b(book|booking|reserve|reservation|confirm|confirmation|request|how to)\b/)) {
        return {
            text: '1. Enter your pick-up and drop (search, or tap the pin button and tap the map).\n2. Choose date, time and a car — the fare updates live.\n3. Add your name and mobile number and tap “Review Fare & Book”.\n4. Your request goes to the manager, who calls you to confirm. The trip is confirmed only after the manager replies.',
            actions: [{ label: 'Open booking form', run: openForm }]
        };
    }
    if (has(/\b(24|open|available|availability|timing|hours|time|when)\b/)) {
        return { text: 'We take bookings 24 hours a day, every day, including night pick-ups. Availability for your date is confirmed by the manager after you send the request.', actions: contactActions().slice(0, 1) };
    }
    if (has(/\b(pay|payment|upi|cash|advance|deposit|refund|cancel|cancellation|invoice|receipt|gst|bill|discount|offer|coupon)\b/)) {
        return { text: 'Payment, advance, cancellation and billing details are agreed with the manager when they confirm your trip, so I don’t want to guess. Please ask them directly.', actions: contactActions() };
    }
    if (has(/\b(route|routes|city|cities|town|towns|where|outstation|destination|places|intercity)\b/)) {
        return { text: `Popular routes:\n${routes.slice(0, 8).map(route => `• ${route.origin} → ${route.destination} (${route.distanceKm} km)`).join('\n')}\nWe also go to other towns across India. Type any “A to B” and I’ll price it.` };
    }
    const mentioned = [...new Set(routes.flatMap(route => [route.origin, route.destination]))].filter(city => q.includes(city.toLowerCase()));
    if (mentioned.length) {
        const city = mentioned[0];
        const options = routes.filter(route => route.origin === city || route.destination === city).slice(0, 6);
        return { text: `Yes, we serve ${city}. Routes we run often:\n${options.map(route => `• ${route.origin} → ${route.destination} (${route.distanceKm} km)`).join('\n')}\nTell me where you’re going, for example “${city} to ${options[0] ? (options[0].origin === city ? options[0].destination : options[0].origin) : 'Madurai'}”.` };
    }
    const faq = faqMatch(q);
    if (faq) return { text: faqText(faq.question ? faq.answer : '') };

    return {
        text: 'I can price a trip (try “Chennai to Madurai”), explain our cars, night charges, tolls and round trips, and walk you through booking. For anything else, the manager will gladly help.',
        actions: contactActions()
    };
}

// ---------- places: typing and suggestions ----------
const inputFor = which => $(which === 'pickup' ? 'pickup-city' : 'drop-city');
const suggestionsFor = which => $(which === 'pickup' ? 'pickup-suggestions' : 'drop-suggestions');
let suggestTimer = null;
let suggestSeq = 0;

function setPlace(which, place) {
    state[which] = place;
    inputFor(which).value = place.name || '';
    updateMapMarker(which);
}

function onPlaceTyped(which) {
    const text = inputFor(which).value.trim();
    state[which] = { name: text };           // typing clears previously selected coordinates
    updateMapMarker(which);
    state.route = null;
    clearTimeout(suggestTimer);
    suggestTimer = window.setTimeout(() => showSuggestions(which, text), maps.ready ? 220 : 60);
    if (!maps.ready) scheduleRoute(500);
    else renderFare();
}

function hideSuggestions(which) {
    suggestionsFor(which).classList.add('hidden');
}

async function showSuggestions(which, text) {
    const box = suggestionsFor(which);
    if (text.length < (maps.ready ? 2 : 1)) { box.classList.add('hidden'); return; }
    const seq = ++suggestSeq;
    let items = [];
    try {
        items = maps.ready ? await mapApi.suggest(text) : localSuggestions(text);
    } catch (error) {
        console.warn('Place search failed', error);
        items = localSuggestions(text);
    }
    if (seq !== suggestSeq) return;
    if (!items.length) { box.classList.add('hidden'); return; }

    box.replaceChildren(...items.map(item => {
        const row = document.createElement('div');
        row.className = 'px-4 py-2.5 hover:bg-slate-100 cursor-pointer text-xs text-navy-900 border-b border-slate-100 last:border-0';
        row.setAttribute('role', 'option');
        const title = document.createElement('div');
        title.className = 'font-bold';
        title.innerHTML = '<i class="fa-solid fa-location-dot text-gold-600 mr-2"></i>';
        title.append(document.createTextNode(item.main));
        row.append(title);
        if (item.secondary) {
            const second = document.createElement('div');
            second.className = 'text-[10px] text-slate-500 mt-0.5 pl-5';
            second.textContent = item.secondary;
            row.append(second);
        }
        // mousedown fires before the input's blur, so the click is never lost
        row.addEventListener('mousedown', async event => {
            event.preventDefault();
            hideSuggestions(which);
            await choosePlace(which, item);
        });
        return row;
    }));
    box.classList.remove('hidden');
}

function localSuggestions(text) {
    const needle = text.toLowerCase();
    const names = new Set(FALLBACK_CITIES);
    state.config.routes.forEach(route => { names.add(route.origin); names.add(route.destination); });
    return [...names].filter(name => name.toLowerCase().includes(needle)).slice(0, 6).map(name => ({ main: name, secondary: '', name }));
}

async function choosePlace(which, item) {
    if (item.resolve) {
        try {
            const place = await item.resolve();
            setPlace(which, place);
            focusMapOn(which);
        } catch (error) {
            console.warn('Could not load place details', error);
            setPlace(which, { name: item.name || item.main });
        }
    } else {
        setPlace(which, { name: item.name });
    }
    scheduleRoute(0);
}

// If the visitor typed a place but never picked a suggestion, use the best match.
async function resolveTyped(which) {
    const place = state[which];
    if (!maps.ready || !place.name || Number.isFinite(place.lat)) return;
    try {
        const [first] = await mapApi.suggest(place.name);
        if (first) setPlace(which, await first.resolve());
    } catch (error) {
        console.warn('Could not resolve typed place', error);
    }
}

// ---------- fare preview ----------
const placesReady = () => state.tripType === 'local' ? Boolean(state.pickup.name) : Boolean(state.pickup.name && state.dropoff.name);
const coordsReady = () => Number.isFinite(state.pickup.lat) && (state.tripType === 'local' || Number.isFinite(state.dropoff.lat));

function scheduleRoute(delay = 300) {
    clearTimeout(routeTimer);
    routeTimer = window.setTimeout(updateRoute, delay);
}

function tripInput() {
    return {
        tripType: state.tripType,
        pickupDate: $('pickup-date').value,
        returnDate: state.tripType === 'roundtrip' ? $('return-date').value : null,
        pickupTime: $('pickup-time').value,
        luggageCarrier: $('luggage-carrier').checked
    };
}

function quotePayload(extra = {}) {
    const point = place => Number.isFinite(place.lat) ? { name: place.name, lat: place.lat, lng: place.lng } : { name: place.name };
    return {
        ...tripInput(),
        carId: state.carId,
        pickup: point(state.pickup),
        dropoff: state.tripType === 'local' ? { name: 'Local Hourly Package' } : point(state.dropoff),
        ...extra
    };
}

async function updateRoute() {
    const seq = ++routeSeq;
    clearRouteLine();
    state.routeError = '';
    // With maps on, wait for a chosen suggestion or pinned spot before pricing.
    const ready = placesReady() && (state.tripType === 'local' || !maps.ready || coordsReady());
    if (!ready) {
        state.route = null;
        state.routeLoading = false;
        renderFare();
        return;
    }

    state.routeLoading = true;
    renderFare();
    try {
        let quote = await postJson('/api/quote', quotePayload());
        if (seq !== routeSeq) return;
        let clientPath = null;

        // Server could not measure the road itself? Let the browser's map library try (Google only).
        if (needsBrowserRoute(quote)) {
            const clientRoute = await mapApi.browserRoute();
            if (seq !== routeSeq) return;
            if (clientRoute) {
                quote = await postJson('/api/quote', quotePayload({ distanceKm: clientRoute.km }));
                if (seq !== routeSeq) return;
                quote.durationText = quote.durationText || clientRoute.durationText;
                clientPath = clientRoute.path;
            }
        }
        state.route = {
            distanceKm: quote.distanceKm,
            source: quote.distanceSource,
            durationText: quote.duration || quote.durationText || '',
            polyline: quote.polyline,
            clientPath
        };
        drawRoute();
    } catch (error) {
        if (seq !== routeSeq) return;
        state.route = null;
        state.routeError = error.message;
    }
    state.routeLoading = false;
    renderFare();
}

function needsBrowserRoute(quote) {
    return Boolean(maps.ready && mapApi.browserRoute && state.tripType !== 'local' && coordsReady()
        && !['google', 'osrm'].includes(quote.distanceSource));
}

const SOURCE_LABEL = {
    osrm: 'Driving distance from OpenStreetMap',
    google: 'Driving distance from Google Maps',
    'customer-map': 'Driving distance from Google Maps',
    'route-table': 'Standard route distance',
    'straight-line-estimate': 'Approximate distance — final fare confirmed by manager',
    'default-estimate': 'Approximate distance — final fare confirmed by manager'
};

function renderFare() {
    const box = $('live-fare');
    const summary = $('route-summary');
    const car = activeCar();
    $('luggage-price').textContent = car.luggageCarrierCost ? `+${inr(car.luggageCarrierCost)}` : 'Free';
    box.classList.toggle('is-loading', state.routeLoading);

    if (state.routeError) {
        summary.classList.add('hidden');
        box.innerHTML = `<p class="text-xs text-amber-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${esc(state.routeError)}</p>`;
        return;
    }

    const needsRoute = state.tripType !== 'local';
    if (needsRoute && !state.route) {
        summary.classList.add('hidden');
        const message = state.routeLoading ? 'Calculating your route and fare…'
            : maps.ready && placesReady() && !coordsReady() ? 'Pick a suggestion from the list (or pin the spot on the map) to see your fare.'
            : 'Choose pick-up and drop locations to see your fare.';
        box.innerHTML = `<p class="text-xs text-slate-300">${esc(message)}</p>`;
        return;
    }
    if (!needsRoute && !state.pickup.name) {
        summary.classList.add('hidden');
        box.innerHTML = '<p class="text-xs text-slate-300">Choose your pick-up location to see the local package fare.</p>';
        return;
    }

    const trip = { ...tripInput(), distanceKm: state.route?.distanceKm || 0 };
    const fare = computeFare(state.config.rules, car, trip);
    state.lastFare = fare;

    if (needsRoute) {
        summary.classList.remove('hidden');
        const km = Math.round(state.route.distanceKm);
        $('route-distance').textContent = `${km} km${state.route.durationText ? ` • ${state.route.durationText}` : ''}${state.tripType === 'roundtrip' ? ' one way' : ''}`;
        $('route-source').textContent = SOURCE_LABEL[state.route.source] || '';
    } else {
        summary.classList.add('hidden');
    }

    const extras = [];
    if (fare.isNight) extras.push(`Night +${inr(fare.nightAllowance)}`);
    if (fare.luggageCost) extras.push(`Roof carrier +${inr(fare.luggageCost)}`);
    box.innerHTML = `
        <div class="flex items-end justify-between gap-3">
            <div>
                <p class="text-[10px] font-extrabold uppercase tracking-wider text-gold-400">Estimated fare · ${esc(car.name)}</p>
                <p class="text-3xl font-black leading-tight">${inr(fare.total)}</p>
            </div>
            <p class="text-right text-[10px] text-slate-300 leading-snug">${fare.billedKm} km billed${fare.days > 1 ? ` · ${fare.days} days` : ''}<br>Tolls are estimated</p>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/10 pt-3 text-[11px] text-slate-200">
            <span>${fare.billedKm} km × ${inr(fare.ratePerKm)}</span><span class="text-right font-bold">${inr(fare.baseFare)}</span>
            <span>Driver allowance${fare.days > 1 ? ` (${fare.days} days)` : ''}</span><span class="text-right font-bold">${inr(fare.driverAllowance)}</span>
            <span>Est. toll &amp; permit</span><span class="text-right font-bold">${inr(fare.tollEstimate)}</span>
            ${extras.map(extra => `<span class="col-span-2 text-gold-400 font-bold">${esc(extra)}</span>`).join('')}
        </div>`;
}

// ---------- review & book ----------
async function reviewBooking() {
    const error = $('form-error');
    error.textContent = '';
    const name = $('cust-name').value.trim();
    const phone = $('cust-phone').value.trim();
    if (!state.pickup.name) return fail('Please enter a pick-up location.');
    if (state.tripType !== 'local' && !state.dropoff.name) return fail('Please enter a drop location.');
    if (!$('pickup-date').value) return fail('Please choose a pick-up date.');
    if (state.tripType === 'roundtrip' && (!$('return-date').value || $('return-date').value < $('pickup-date').value)) return fail('Choose a return date on or after the pick-up date.');
    if (!name) return fail('Please enter your name.');
    if (!/^\d{10}$/.test(phone)) return fail('Please enter a valid 10 digit mobile number.');

    const button = $('submit-btn');
    button.disabled = true;
    try {
        await Promise.all([resolveTyped('pickup'), state.tripType === 'local' ? null : resolveTyped('dropoff')]);
        let quote = await postJson('/api/quote', quotePayload());
        if (needsBrowserRoute(quote)) {
            const clientRoute = await mapApi.browserRoute();
            if (clientRoute) quote = await postJson('/api/quote', quotePayload({ distanceKm: clientRoute.km }));
        }
        state.lastQuote = quote;
        showFareModal(quote, name, phone);
    } catch (err) {
        fail(err.message);
    } finally {
        button.disabled = false;
    }

    function fail(message) {
        error.textContent = message;
    }
}

function showFareModal(quote, name, phone) {
    const fare = quote.fare;
    const row = (label, value, extra = '') => `<div class="flex justify-between gap-3 ${extra}"><span class="text-slate-600">${label}</span><span class="font-bold text-navy-900">${value}</span></div>`;
    const tripLabel = { oneway: 'One-way drop', roundtrip: 'Round trip', local: 'Local hourly' }[quote.tripType];
    $('modal-error').textContent = '';
    $('modal-breakdown-content').innerHTML = `
        <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs space-y-1">
            <div class="flex justify-between gap-3"><span class="text-slate-500">${esc(tripLabel)}:</span><strong class="text-navy-900 text-right">${esc(quote.pickup.name)} → ${esc(quote.dropoff.name)}</strong></div>
            <div class="flex justify-between gap-3"><span class="text-slate-500">Date &amp; Time:</span><span class="text-navy-900">${esc(quote.pickupDate)} at ${esc(quote.pickupTime)}${quote.returnDate ? ` · return ${esc(quote.returnDate)}` : ''}</span></div>
            <div class="flex justify-between gap-3"><span class="text-slate-500">Passenger:</span><span class="text-navy-900">${esc(name)} (${esc(phone)})</span></div>
            ${quote.tripType !== 'local' ? `<div class="flex justify-between gap-3"><span class="text-slate-500">Route distance:</span><span class="text-navy-900">${Math.round(quote.distanceKm)} km${quote.duration ? ` · ${esc(quote.duration)}` : ''}</span></div>` : ''}
        </div>
        <div class="space-y-2 pt-2 text-xs">
            ${row(`Car class (${esc(quote.carName)})`, `${inr(fare.ratePerKm)} / KM`)}
            ${row(`Base fare (${fare.billedKm} KM × ${inr(fare.ratePerKm)})`, inr(fare.baseFare))}
            ${row(`Driver allowance${fare.days > 1 ? ` (${fare.days} days)` : ''}`, inr(fare.driverAllowance))}
            ${fare.isNight ? row('Night allowance', `+${inr(fare.nightAllowance)}`, 'text-amber-700') : ''}
            ${fare.luggageCost ? row('Roof luggage carrier', `+${inr(fare.luggageCost)}`) : ''}
            ${row('Est. toll &amp; state permit', inr(fare.tollEstimate))}
        </div>
        <div class="p-3.5 rounded-xl gold-gradient text-navy-950 flex justify-between items-center mt-3 shadow-md">
            <div>
                <span class="block text-[10px] font-black uppercase tracking-wider">Total Est. Booking Fare</span>
                <span class="text-[10px] opacity-80">Final fare confirmed by the manager</span>
            </div>
            <span class="text-2xl font-black">${inr(fare.total)}</span>
        </div>`;
    $('fare-modal').classList.remove('hidden');
}

function closeFareModal() {
    $('fare-modal').classList.add('hidden');
}

async function confirmAndSubmitReservation() {
    const quote = state.lastQuote;
    if (!quote) return;
    const confirm = $('confirm-btn');
    confirm.disabled = true;
    $('modal-error').textContent = '';

    const customerName = $('cust-name').value.trim();
    const customerPhone = $('cust-phone').value.trim();
    let result;
    try {
        result = await postJson('/api/bookings', {
            ...quotePayload(quote.distanceSource === 'customer-map' ? { distanceKm: quote.distanceKm } : {}),
            customerName,
            customerPhone
        });
    } catch (error) {
        confirm.disabled = false;
        if (error.status && error.status < 500 && error.status !== 429) {
            $('modal-error').textContent = error.message;   // let the visitor fix the problem
            return;
        }
        result = {
            reference: `CD-${Math.floor(100000 + Math.random() * 900000)}`,
            notificationSent: false,
            offline: true,
            message: 'We could not reach the automatic booking service. Please send your request through WhatsApp.'
        };
    }
    confirm.disabled = false;
    closeFareModal();

    const total = result.estimatedFare || quote.fare.total;
    const modal = $('confirmation-modal');
    modal.classList.remove('hidden');
    $('modal-loading-state').classList.add('hidden');
    $('modal-success-state').classList.remove('hidden');
    $('res-ref-id').textContent = `#${result.reference}`;
    $('res-car-type').textContent = quote.carName;
    $('res-route').textContent = `${quote.pickup.name} → ${quote.dropoff.name}`;
    $('res-total').textContent = inr(total);

    const badge = $('result-badge');
    const whatsapp = $('booking-whatsapp-link');
    if (result.notificationSent) {
        badge.textContent = 'Manager Notified';
        badge.className = 'px-2.5 py-1 rounded bg-emerald-100 text-emerald-900 text-[10px] font-black uppercase tracking-wider';
        $('booking-result-heading').textContent = 'Request Sent to Manager';
        $('booking-notification-message').textContent = 'The manager has received your trip details and will contact you to confirm availability and final fare.';
        whatsapp.classList.add('hidden');
    } else {
        const message = `NEW BOOKING REQUEST ${result.reference}
Trip: ${quote.pickup.name} -> ${quote.dropoff.name}
Date/Time: ${quote.pickupDate} ${quote.pickupTime}${quote.returnDate ? ` (return ${quote.returnDate})` : ''}
Car: ${quote.carName}
Passenger: ${customerName} (${customerPhone})
Estimated fare: ${inr(total)}
Please confirm availability and final fare.`;
        badge.textContent = result.offline ? 'Manual Send Required' : 'Request Saved';
        badge.className = 'px-2.5 py-1 rounded bg-amber-100 text-amber-900 text-[10px] font-black uppercase tracking-wider';
        $('booking-result-heading').textContent = 'Send Your Request';
        $('booking-notification-message').textContent = `${result.message} Your trip is confirmed only after the manager replies.`;
        whatsapp.href = `https://wa.me/${state.config.site.whatsapp}?text=${encodeURIComponent(message)}`;
        whatsapp.classList.remove('hidden');
        whatsapp.classList.add('block');
    }
}

function resetAndFinish() {
    $('confirmation-modal').classList.add('hidden');
    $('booking-form').reset();
    $('pickup-date').value = addDays(today(), 1);
    $('pickup-time').value = '09:00';
    state.pickup = { name: '' };
    state.dropoff = { name: '' };
    state.route = null;
    state.lastQuote = null;
    updateMapMarker('pickup');
    updateMapMarker('dropoff');
    clearRouteLine();
    setTripType('oneway');
    renderFare();
}

function dismissBrandIntro() {
    $('brand-intro')?.classList.add('is-done');
}

// ---------- Map providers ----------
// OpenStreetMap (free) is the default. If GOOGLE_MAPS_API_KEY is set on the server, Google is used instead.
// Each provider fills `mapApi` with the same small set of functions.
async function startMaps() {
    const config = state.config.maps;
    try {
        $('map-panel').classList.remove('hidden');   // visible first so the map can measure its size
        if (config.provider === 'google') await startGoogle(config);
        else await startOsm();
        maps.ready = true;
        for (const id of ['pin-pickup', 'pin-drop', 'use-location']) $(id).classList.remove('hidden');
        if (state.tripType === 'local') $('pin-drop').classList.add('hidden');
        ['pickup', 'dropoff'].forEach(updateMapMarker);
        // If the visitor typed something before the map finished loading, resolve it now.
        if (state.pickup.name || state.dropoff.name) {
            await Promise.all([resolveTyped('pickup'), state.tripType === 'local' ? null : resolveTyped('dropoff')]);
            scheduleRoute(0);
        }
    } catch (error) {
        console.warn('Maps could not start; using the built-in city list.', error);
        maps.ready = false;
        disableMapUi();
    }
}

function disableMapUi() {
    $('map-panel').classList.add('hidden');
    ['pin-pickup', 'pin-drop', 'use-location'].forEach(id => $(id).classList.add('hidden'));
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.append(script);
    });
}

function loadStyle(href) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
}

function placeLabel(properties) {
    const main = properties.name || [properties.housenumber, properties.street].filter(Boolean).join(' ')
        || properties.district || properties.city || properties.state || '';
    const parts = [properties.street && properties.street !== main ? properties.street : '', properties.district,
        properties.city || properties.town || properties.village || properties.county, properties.state]
        .filter(Boolean).filter(part => part !== main);
    const unique = [...new Set(parts)];
    return { main, secondary: unique.join(', '), full: [main, ...unique].filter(Boolean).join(', ').slice(0, 160) };
}

// ----- OpenStreetMap: Leaflet map, Photon place search -----
const PHOTON = 'https://photon.komoot.io';
const INDIA_BBOX = '68.1,6.5,97.4,35.7';

async function startOsm() {
    loadStyle('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js');
    const L = window.L;
    const map = L.map($('map'), { zoomControl: true, scrollWheelZoom: false, attributionControl: false }).setView([13.0827, 80.2707], 6);
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }).addTo(map);
    map.on('click', event => onMapClick({ lat: event.latlng.lat, lng: event.latlng.lng }));
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());
    window.setTimeout(() => map.invalidateSize(), 200);

    const markers = {};
    let line = null;

    mapApi.suggest = async text => {
        const url = `${PHOTON}/api/?q=${encodeURIComponent(text)}&limit=7&lang=en&bbox=${INDIA_BBOX}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Place search failed (${response.status})`);
        const data = await response.json();
        return (data.features || [])
            .filter(feature => !feature.properties.countrycode || feature.properties.countrycode === 'IN')
            .slice(0, 6)
            .map(feature => {
                const label = placeLabel(feature.properties);
                const [lng, lat] = feature.geometry.coordinates;
                return { main: label.main, secondary: label.secondary, name: label.full, resolve: async () => ({ name: label.full, lat, lng }) };
            });
    };
    mapApi.reverse = async point => {
        const response = await fetch(`${PHOTON}/reverse?lat=${point.lat}&lon=${point.lng}&lang=en`);
        if (!response.ok) return '';
        const feature = (await response.json()).features?.[0];
        return feature ? placeLabel(feature.properties).full : '';
    };
    mapApi.setMarker = (which, place, onDrag) => {
        if (markers[which]) { markers[which].remove(); delete markers[which]; }
        if (!place || !Number.isFinite(place.lat)) return;
        const icon = L.divIcon({
            className: '',
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            html: `<div class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs text-white shadow-lg ${which === 'pickup' ? 'bg-emerald-700' : 'bg-red-700'}"><i class="fa-solid ${which === 'pickup' ? 'fa-location-dot' : 'fa-flag-checkered'}"></i></div>`
        });
        const marker = L.marker([place.lat, place.lng], { icon, draggable: true, title: which === 'pickup' ? 'Pick-up (drag to adjust)' : 'Drop (drag to adjust)' }).addTo(map);
        marker.on('dragend', () => { const at = marker.getLatLng(); onDrag({ lat: at.lat, lng: at.lng }); });
        markers[which] = marker;
    };
    mapApi.focus = place => map.setView([place.lat, place.lng], 12);
    mapApi.fitBoth = (a, b) => map.fitBounds([[a.lat, a.lng], [b.lat, b.lng]], { padding: [40, 40] });
    mapApi.clearPath = () => { if (line) { line.remove(); line = null; } };
    mapApi.drawPath = (path, dashed) => {
        mapApi.clearPath();
        line = L.polyline(path.map(point => [point.lat, point.lng]), { color: '#17372F', weight: 5, opacity: 0.9, dashArray: dashed ? '8 10' : null }).addTo(map);
    };
    mapApi.setCrosshair = on => { map.getContainer().style.cursor = on ? 'crosshair' : ''; };
}

// ----- Google Maps: Places (New) search, Routes library -----
async function startGoogle(config) {
    await new Promise((resolve, reject) => {
        window.__cityDriveMapsReady = resolve;
        window.gm_authFailure = () => {
            console.warn('Google Maps rejected the API key (check the key, billing and allowed websites).');
            maps.ready = false;
            disableMapUi();
        };
        loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.apiKey)}&v=weekly&loading=async&callback=__cityDriveMapsReady`).catch(reject);
    });
    const google = window.google;
    const [{ Map }, markerLib, placesLib, geocodingLib] = await Promise.all([
        google.maps.importLibrary('maps'), google.maps.importLibrary('marker'),
        google.maps.importLibrary('places'), google.maps.importLibrary('geocoding')
    ]);
    const geocoder = new geocodingLib.Geocoder();
    const map = new Map($('map'), {
        center: { lat: 13.0827, lng: 80.2707 }, zoom: 6, mapId: config.mapId, gestureHandling: 'cooperative',
        mapTypeControl: false, streetViewControl: false, fullscreenControl: true
    });
    map.addListener('click', event => onMapClick({ lat: event.latLng.lat(), lng: event.latLng.lng() }));
    const markers = {};
    let line = null;
    let token = null;

    mapApi.suggest = async text => {
        const { AutocompleteSuggestion, AutocompleteSessionToken } = placesLib;
        if (!token) token = new AutocompleteSessionToken();
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: text, includedRegionCodes: ['in'], language: 'en', sessionToken: token
        });
        return suggestions.filter(item => item.placePrediction).slice(0, 6).map(item => {
            const prediction = item.placePrediction;
            const full = prediction.text.text.slice(0, 160);
            return {
                main: prediction.mainText?.text || full,
                secondary: prediction.secondaryText?.text || '',
                name: full,
                resolve: async () => {
                    const place = prediction.toPlace();
                    await place.fetchFields({ fields: ['location', 'formattedAddress', 'displayName'] });
                    token = null; // a selection ends the billing session
                    return { name: full, lat: place.location.lat(), lng: place.location.lng() };
                }
            };
        });
    };
    mapApi.reverse = async point => {
        const { results } = await geocoder.geocode({ location: point });
        return results?.[0]?.formatted_address?.slice(0, 160) || '';
    };
    mapApi.setMarker = (which, place, onDrag) => {
        if (markers[which]) { markers[which].map = null; delete markers[which]; }
        if (!place || !Number.isFinite(place.lat)) return;
        const pin = document.createElement('div');
        pin.className = `flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs text-white shadow-lg ${which === 'pickup' ? 'bg-emerald-700' : 'bg-red-700'}`;
        pin.innerHTML = `<i class="fa-solid ${which === 'pickup' ? 'fa-location-dot' : 'fa-flag-checkered'}"></i>`;
        const marker = new markerLib.AdvancedMarkerElement({
            map, position: { lat: place.lat, lng: place.lng }, content: pin, gmpDraggable: true,
            title: which === 'pickup' ? 'Pick-up (drag to adjust)' : 'Drop (drag to adjust)'
        });
        marker.addListener('dragend', () => {
            const at = marker.position;
            onDrag({ lat: typeof at.lat === 'function' ? at.lat() : at.lat, lng: typeof at.lng === 'function' ? at.lng() : at.lng });
        });
        markers[which] = marker;
    };
    mapApi.focus = place => { map.panTo({ lat: place.lat, lng: place.lng }); map.setZoom(12); };
    mapApi.fitBoth = (a, b) => {
        const bounds = new google.maps.LatLngBounds();
        bounds.extend({ lat: a.lat, lng: a.lng });
        bounds.extend({ lat: b.lat, lng: b.lng });
        map.fitBounds(bounds, 48);
    };
    mapApi.clearPath = () => { if (line) { line.setMap(null); line = null; } };
    mapApi.drawPath = (path, dashed) => {
        mapApi.clearPath();
        line = new google.maps.Polyline({
            path, map, strokeColor: '#17372F', strokeOpacity: dashed ? 0 : 0.9, strokeWeight: 5,
            icons: dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '14px' }] : undefined
        });
    };
    mapApi.setCrosshair = on => map.setOptions({ draggableCursor: on ? 'crosshair' : null });
    // Real road distance straight from the browser (used only when the server has no routing of its own).
    mapApi.browserRoute = async () => {
        try {
            const { Route } = await google.maps.importLibrary('routes');
            const { routes } = await Route.computeRoutes({
                origin: { lat: state.pickup.lat, lng: state.pickup.lng },
                destination: { lat: state.dropoff.lat, lng: state.dropoff.lng },
                travelMode: 'DRIVING',
                fields: ['distanceMeters', 'durationMillis', 'path']
            });
            const route = routes?.[0];
            if (!route?.distanceMeters) return null;
            const minutes = Math.round((route.durationMillis || 0) / 60000);
            const hours = Math.floor(minutes / 60);
            return {
                km: route.distanceMeters / 1000,
                durationText: minutes ? (hours ? `${hours} hr${hours > 1 ? 's' : ''}${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`) : '',
                path: (route.path || []).map(point => ({ lat: typeof point.lat === 'function' ? point.lat() : point.lat, lng: typeof point.lng === 'function' ? point.lng() : point.lng }))
            };
        } catch (error) {
            console.warn('Browser route lookup unavailable; using the server estimate.', error);
            return null;
        }
    };
}

// ----- shared map interaction -----
function togglePinMode(which) {
    setPinMode(state.pinMode === which ? null : which);
    if (state.pinMode) $('map-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setPinMode(which) {
    state.pinMode = which;
    $('pin-pickup').setAttribute('aria-pressed', String(which === 'pickup'));
    $('pin-drop').setAttribute('aria-pressed', String(which === 'dropoff'));
    $('map-hint').innerHTML = which
        ? `<i class="fa-solid fa-hand-pointer text-gold-600 mr-1"></i> <strong>Tap the map</strong> to set your ${which === 'pickup' ? 'pick-up' : 'drop'} point.`
        : '<i class="fa-solid fa-hand-pointer text-gold-600 mr-1"></i> Search above, or tap the <i class="fa-solid fa-map-pin text-gold-600"></i> button and then tap the map to mark the exact spot. Drag a marker to fine-tune.';
    if (maps.ready) mapApi.setCrosshair(Boolean(which));
}

async function onMapClick(point) {
    // Without an active pin button, a tap fills the first empty point.
    const target = state.pinMode || (!Number.isFinite(state.pickup.lat) ? 'pickup' : state.tripType !== 'local' && !Number.isFinite(state.dropoff.lat) ? 'dropoff' : null);
    if (!target) return;
    await setPlaceFromLatLng(target, point);
    setPinMode(null);
}

async function setPlaceFromLatLng(which, point) {
    let name = '';
    try { name = await mapApi.reverse(point); } catch (error) { console.warn('Reverse geocoding failed', error); }
    setPlace(which, { name: name || `Pinned location (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})`, lat: point.lat, lng: point.lng });
    scheduleRoute(0);
}

function useMyLocation() {
    if (!navigator.geolocation) return;
    const button = $('use-location');
    button.disabled = true;
    navigator.geolocation.getCurrentPosition(
        async position => {
            button.disabled = false;
            await setPlaceFromLatLng('pickup', { lat: position.coords.latitude, lng: position.coords.longitude });
            focusMapOn('pickup');
        },
        () => { button.disabled = false; $('form-error').textContent = 'We could not get your location. Please type it or pin it on the map.'; },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function updateMapMarker(which) {
    if (!maps.ready) return;
    mapApi.setMarker(which, state[which], point => setPlaceFromLatLng(which, point));
}

function focusMapOn(which) {
    const place = state[which];
    if (!maps.ready || !Number.isFinite(place.lat)) return;
    if (Number.isFinite(state.pickup.lat) && Number.isFinite(state.dropoff.lat) && state.tripType !== 'local') {
        mapApi.fitBoth(state.pickup, state.dropoff);
    } else {
        mapApi.focus(place);
    }
}

function clearRouteLine() {
    if (maps.ready) mapApi.clearPath();
}

function decodePolyline(encoded) {
    const path = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
        for (const axis of ['lat', 'lng']) {
            let result = 0, shift = 0, byte;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            const delta = result & 1 ? ~(result >> 1) : result >> 1;
            if (axis === 'lat') lat += delta; else lng += delta;
        }
        path.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return path;
}

function drawRoute() {
    if (!maps.ready || !state.route || state.tripType === 'local' || !coordsReady()) return;
    let path = state.route.clientPath;
    let dashed = false;
    if (!path && state.route.polyline) path = decodePolyline(state.route.polyline);
    if (!path) {
        path = [{ lat: state.pickup.lat, lng: state.pickup.lng }, { lat: state.dropoff.lat, lng: state.dropoff.lng }];
        dashed = true;
    }
    mapApi.drawPath(path, dashed);
    mapApi.fitBoth(state.pickup, state.dropoff);
}

// Inline handlers in index.html
Object.assign(window, { setTripType, closeFareModal, confirmAndSubmitReservation, resetAndFinish, toggleFloatingMenu, toggleCityDriveAI, dismissBrandIntro });
