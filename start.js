// Run City Drive as a normal Node server (your computer, Render, a VPS...).
// On Vercel this file is not used; see api/index.js.
import app, { ensureReady } from './lib/app.js';

const port = Number(process.env.PORT) || 3000;

try {
    await ensureReady();
    if (process.env.SUPABASE_URL) console.log('Supabase storage is ready.');
    app.listen(port, '0.0.0.0', () => console.log(`City Drive is listening on port ${port}`));
} catch (error) {
    console.error(`City Drive could not start: ${error.message}`);
    process.exitCode = 1;
}
