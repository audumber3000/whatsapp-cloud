// Branded festival image compositor.
//
// Model: the user uploads the FULL festival poster artwork per festival. This
// module overlays ONLY the deterministic branded strip (logo + business name +
// phone + address, from the Brand Kit) along the bottom of that poster.
// Nothing else is drawn — no border, no badge, no generated background.
//
// Rendering uses a DEDICATED Puppeteer browser, separate from the WhatsApp
// client browsers, so heavy WA sessions and image rendering never interfere.

const puppeteer = require('puppeteer');

const BASE_WIDTH = 1080; // strip is designed against this width; height follows the poster
const FONT_STACK = `'Poppins','Segoe UI','Noto Sans','Noto Sans Devanagari','Helvetica Neue',Arial,sans-serif`;

let browserPromise = null;

async function getBrowser() {
    if (browserPromise) {
        try {
            const b = await browserPromise;
            if (b.connected) return b;
        } catch (e) { /* relaunch */ }
    }
    const executablePath = process.env.CHROME_PATH || undefined;
    browserPromise = puppeteer.launch({
        executablePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
    });
    const b = await browserPromise;
    b.on('disconnected', () => { browserPromise = null; });
    return b;
}

// Serialize renders so concurrent festival posts don't spawn many pages.
let queue = Promise.resolve();
function runExclusive(task) {
    const result = queue.then(task, task);
    queue = result.then(() => {}, () => {});
    return result;
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function logoMarkup(brand, size) {
    if (brand.logo_data) {
        return `<img src="${brand.logo_data}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;background:#fff;flex:0 0 auto;" />`;
    }
    const initial = escapeHtml((brand.clinic_name || '?').trim().charAt(0).toUpperCase());
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#f1f5f9;color:${escapeHtml(brand.primary_color || '#075E54')};display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.45)}px;font-weight:800;flex:0 0 auto;">${initial}</div>`;
}

// The branded strip — full width, no rounding/margins, sits flush at the bottom
// as an overlay. Colours come from the Brand Kit so it stays on-brand.
function brandFooter(brand) {
    const primary = escapeHtml(brand.primary_color || '#075E54');
    const name = escapeHtml(brand.clinic_name || 'Write Your Business Name Here');
    const phone = escapeHtml(brand.phone || '');
    const address = escapeHtml(brand.address || '');
    return `
      <div style="font-family:${FONT_STACK};box-shadow:0 -10px 30px rgba(0,0,0,0.22);">
        <div style="display:flex;align-items:center;gap:20px;background:#ffffff;padding:22px 32px;">
          ${logoMarkup(brand, 86)}
          <div style="flex:1;min-width:0;">
            <div style="color:${primary};font-size:39px;font-weight:800;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
            ${brand.tagline ? `<div style="color:#64748b;font-size:23px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(brand.tagline)}</div>` : ''}
          </div>
          ${phone ? `<div style="display:flex;align-items:center;gap:11px;padding-left:24px;border-left:3px solid #e2e8f0;flex:0 0 auto;">
            <span style="font-size:31px;">📞</span>
            <span style="color:#0f172a;font-size:31px;font-weight:700;white-space:nowrap;">${phone}</span>
          </div>` : ''}
        </div>
        ${address ? `<div style="background:${primary};padding:15px 32px;display:flex;align-items:center;gap:11px;">
          <span style="font-size:26px;">📍</span>
          <span style="color:#ffffff;font-size:25px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${address}</span>
        </div>` : ''}
      </div>`;
}

/**
 * Overlay the branded strip on the festival's uploaded poster.
 * @param {object} brand    brand_kits row
 * @param {object} festival festivals row (uses festival.poster_image data-URI)
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generateFestivalImage(brand, festival) {
    const poster = festival && festival.poster_image ? festival.poster_image : null;

    return runExclusive(async () => {
        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            // Render at a fixed width; height follows the poster's aspect ratio.
            let W = BASE_WIDTH, H = Math.round(BASE_WIDTH * 1.25); // default 4:5 when no poster
            if (poster) {
                await page.setViewport({ width: BASE_WIDTH, height: BASE_WIDTH, deviceScaleFactor: 1 });
                const dims = await page.evaluate((src) => new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
                    im.onerror = () => res(null);
                    im.src = src;
                }), poster);
                if (dims && dims.w && dims.h) {
                    H = Math.round(BASE_WIDTH * (dims.h / dims.w));
                }
            }

            const background = poster
                ? `<img src="${poster}" style="position:absolute;inset:0;width:${W}px;height:${H}px;object-fit:cover;" />`
                : `<div style="position:absolute;inset:0;background:#e9edf2;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:40px;font-family:${FONT_STACK};">Upload your festival poster</div>`;

            const html = `<!doctype html><html><head><meta charset="utf-8">
                <style>*{margin:0;padding:0;box-sizing:border-box;}</style></head>
                <body style="margin:0;width:${W}px;height:${H}px;position:relative;overflow:hidden;">
                  ${background}
                  <div style="position:absolute;left:0;right:0;bottom:0;">${brandFooter(brand || {})}</div>
                </body></html>`;

            await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
            await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
            return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
        } finally {
            await page.close().catch(() => {});
        }
    });
}

async function shutdown() {
    if (browserPromise) {
        try { const b = await browserPromise; await b.close(); } catch (e) {}
        browserPromise = null;
    }
}

module.exports = { generateFestivalImage, shutdown, BASE_WIDTH };
