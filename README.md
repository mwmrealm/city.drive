# City Drive – cab booking website, live fare calculator and admin app

* **Website** (`/`) – customers search or pin pick-up and drop on a map (free OpenStreetMap, or Google), see the real road distance and a **live fare**, and send a booking request.
* **Admin** (`/admin`) – works on phone and desktop and installs like an app. Manage bookings (assign driver, final fare, notes, CSV export), **cars, prices and photos**, contact details, popular routes and FAQs. Nothing needs code changes.
* **Backend** – Node.js. The server recalculates every fare itself, so a customer cannot change the price from the browser.

```
server.js          API + pages          lib/   storage (Supabase / local), settings, road routing (OSRM / Google)
public/index.html  customer website     public/app.js      website logic (maps, live fare)
public/admin.html  admin app            public/fare.js     fare formula (shared by browser and server)
supabase/schema.sql  database tables
```

## 1. Run it on your computer (2 minutes)

1. Install Node.js 20+.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and fill **ADMIN_USERNAME**, **ADMIN_PASSWORD** (12+ characters) and **ADMIN_SESSION_SECRET** (32+ random characters; the command is in the file).
4. `npm start`, then open http://localhost:3000 and http://localhost:3000/admin.

Without a Google key the website still works with a simple city list and your saved route table. Locally, data is stored in the `data/` folder.

## 2. How the fare is calculated

| | |
|---|---|
| One way | km = road distance (at least the **minimum billable km**) × car rate |
| Round trip | km = distance **there and back**, at least minimum km × number of days |
| Local hourly | the fixed **local package km** × car rate |
| Plus | driver allowance × days, night allowance (if pick-up is in the night hours), roof carrier (if ticked), estimated tolls (billed km × toll per km) |

All numbers are editable in **Admin → Cars & prices**. The manager still confirms the final fare with the customer.

## 3. Maps (free by default)

**Nothing to set up.** The website uses **OpenStreetMap**: customers search places, tap the map to pin pick-up and drop, and the **server measures the real driving distance** with the free OSRM routing service, then applies your prices. No card or account needed.

* Fair use: the free public servers (map tiles, Photon place search, OSRM routing) are meant for light use. A small taxi business is normally fine. If a routing lookup ever fails, the fare falls back to an estimate and the booking still works.
* Indian address search is not as detailed as Google's, so customers may need to drop a pin for small lanes.
* Distances are cached for an hour to keep requests low.

**Optional: switch to Google Maps later** (better address search; needs a Google Cloud account with billing). Add these to `.env` / Render and restart:

1. In https://console.cloud.google.com enable **Maps JavaScript API**, **Places API (New)**, **Geocoding API**, **Routes API**.
2. Create a **browser key** (restrict to your website address + those APIs) -> `GOOGLE_MAPS_API_KEY`.
3. Create a **server key** (restrict to Routes API) -> `GOOGLE_MAPS_SERVER_KEY`.

Admin -> **Setup** shows which map and routing service is active.

## 4. Put it online with Supabase (so admin works from any phone)

1. **Supabase:** create a project → *SQL Editor* → paste all of `supabase/schema.sql` → Run. In *Project Settings → API Keys* copy the **Project URL** and a **Secret key** (`sb_secret_…`).
2. **GitHub:** upload this folder to a private repository (never upload `.env`).
3. **Render:** *New → Web Service* → your repo → Runtime Node, build `npm ci`, start `npm start`. Add the environment variables: `NODE_ENV=production`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, plus the Google keys only if you use Google.
4. Open `https://YOUR-SERVICE.onrender.com/api/health` – `storageBackend` must say `supabase`. Then sign in at `/admin`, change a price, refresh the website.
5. Free Render services sleep after inactivity (first visit can take ~1 minute). For a live business use a paid plan, and enable Supabase backups.

If you already ran an older version, run `supabase/schema.sql` again – it adds the table for uploaded photos and does not touch existing data.

## 5. Install the admin as a phone app

* **iPhone / iPad:** open `https://YOUR-SITE/admin` in **Safari** → Share → **Add to Home Screen**.
* **Android:** open it in Chrome → tap **Install app** (top of the page) or ⋮ → *Install app*.

It must be your https address (not localhost). New booking requests show a banner and a red count on the Bookings tab while the app is open. (Push notifications while the app is closed need a further add-on; WhatsApp alerts below cover that.)

## 6. WhatsApp alerts to the manager (optional)

Create a Meta WhatsApp Business Cloud API app and set the `WHATSAPP_*` variables in `.env.example`. The approved template needs one body placeholder `{{1}}`. Until configured, customers get a prefilled “Send on WhatsApp” button and every request still appears in the admin.

## Notes

* Keep `.env` private. Booking records contain customers' phone numbers; decide how long you keep them.
* Photos uploaded in the admin are resized in the browser and stored in the database (Supabase) or `data/media` locally.
* Round trips are now billed for the return distance and per-day minimums (the earlier version billed them like a one-way trip). Change the rules any time in the admin.
