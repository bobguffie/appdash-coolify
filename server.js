/**
 * Coolify Web Directory – server.js
 * 
 * - Loads environment variables from .env
 * - Creates an Express app that proxies the Coolify API
 * - Handles 302 redirects (Coolify may redirect to login/HTTPS)
 * - Filters apps to show only those with an FQDN and that are not stopped
 * - Renders a dark‑mode Tailwind‑CSS grid of glass‑morphic cards
 * - Embeds **inline SVG icons** so the page works when opened from `file://`
 */

require('dotenv').config();

const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Return a small inline SVG depending on the app name.
 * The SVGs are data‑uri‑free – they are just raw SVG markup that the browser
 * can render immediately.  If the name does not match any of the known apps
 * a generic “initial‑letter” circle is returned.
 *
 * Known names (case‑insensitive):
 *   • Bin Reminder         → trash‑can icon
 *   • Docker             → docker whale icon
 *   • Grantham Lora      → book‑style icon
 *   • Powergrid          → power‑grid icon
 *
 * @param {string} name – app name from the Coolify API
 * @returns {string} SVG markup (escaped for HTML)
 */
function getIconSvg(name) {
  const lower = (name || '').toLowerCase();

  // ----- Bin Reminder -------------------------------------------------
  if (lower.includes('bin')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 3a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5zM6 3.5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 .5.5h5A.5.5 0 0 0 6 3.5zm.5.5a.5.5 0 0 1-.5-.5h-3a.5.5 0 0 1-.5.5v3a.5.5 0 0 1 0 1h3a.5.5 0 0 1 .5-.5z"/>
            </svg>`;
  }

  // ----- Docker -------------------------------------------------------
  if (lower.includes('docker')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M0 12V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm6.5-5.5a1.5 1.5 0 1 1-1.127.47L11 8.28l1.438 1.773A1.5 1.5 0 0 1 12.5 9.5v-4a1.5 1.5 0 0 1 1.5-1.5h-2zM2.5 9.5a1.5 1.5 0 1 1-1.124-.47L1 8.28l1.44 1.773A1.5 1.5 0 0 1 2.5 12v-4z"/>
            </svg>`;
  }

  // ----- Grantham Lora ------------------------------------------------
  if (lower.includes('grantham lora')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0a8 8 0 1 0 8 8A8.06 8.06 0 0 0 8 0zm7.146 7.146-5.647 5.646.708.707A1 1 0 0 1 13 7.5l-5.5 2.25a.5.5 0 0 1-.632-.308l-5.5-2.25.708-.707z"/>
            </svg>`;
  }

  // ----- Powergrid ----------------------------------------------------
  if (lower.includes('powergrid')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M0 0hv4h16vH0zm0 14H4v-4h8v-4h4v4h2v4H0v-4zM4.5 3.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm4.5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm4.5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-9 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
            </svg>`;
  }

  // ----- Fallback: generic initial‑letter circle ----------------------
  const first = (name || '')[0].toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7"/>
            <text x="8" y="10" text-anchor="middle" font-size="12" fill="white">${first}</text>
          </svg>`;
}

/**
 * Helper – builds one glass‑morphic card (incl. inline SVG icon)
 *
 * @param {object} app – a single Coolify application object
 * @returns {string} HTML for one card
 */
function buildCard(app) {
  const rawName = app.name || 'Unnamed';
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
  const url = app.fqdn.replace('https://', '');
  const status = (app.status || '').toLowerCase();
  const isRunning = status === 'running';
  const badgeClass = isRunning ? 'bg-green-500' : 'bg-amber-500';
  const badgeText = isRunning ? 'Running' : status.charAt(0).toUpperCase() + status.slice(1);
  const iconSvg = getIconSvg(app.name); // <-- inline SVG

  return `
    <div class="col-span-1 sm:col-span-2 md:col-span-3 lg:col-span-4 p-4 bg-white/20 backdrop-blur-sm rounded-xl shadow-xl">
      <!-- Icon -->
      <div class="w-6 h-6 rounded-md mb-2 flex items-center justify-center mr-2">
        ${iconSvg}
      </div>

      <h3 class="text-lg font-medium text-white mb-1">${name}</h3>
      <p class="text-sm text-white/70 mb-2 truncate">${url}</p>

      <div class="inline-flex items-center mb-3">
        <span class="w-2 h-2 rounded-full ${badgeClass} mr-2"></span>
        <span class="text-sm text-white/80">${badgeText}</span>
      </div>

      <a href="${app.fqdn}" class="inline-block text-white hover:underline text-sm font-medium" target="_blank" rel="noopener">
        Visit Site
      </a>
    </div>`;
}

/**
 * GET /
 * – Calls the Coolify API (`/api/v1/applications`)
 * – Performs manual 302 redirect handling
 * – Filters & maps the result into glass‑morphic cards (with inline SVGs)
 * – Returns a full HTML page (Tailwind via CDN)
 */
app.get('/', (req, res) => {
  const instanceUrl = process.env.COOLIFY_INSTANCE_URL?.replace(/\/+$/, '') || '';
  const token = process.env.COOLIFY_API_TOKEN || '';

  if (!instanceUrl || !token) {
    return res.status(500).send(
      'Please set COOLIFY_INSTANCE_URL and COOLIFY_API_TOKEN in .env'
    );
  }

  // -------------------------------------------------------------------------
  // Build the request options for the Coolify API
  // -------------------------------------------------------------------------
  const parsed = new URL(instanceUrl);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + '/api/v1/applications',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    // Disable automatic redirect following – we handle 302 ourselves.
    maxRedirects: 0,
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';

    apiRes.on('data', chunk => (data += chunk));
    apiRes.on('end', () => {
      // -------------------------------------------------------------------------
      // 302 redirect handling (Coolify may redirect to login/HTTPS)
      // -------------------------------------------------------------------------
      if (apiRes.statusCode !== 200) {
        if (apiRes.statusCode === 302 && apiRes.headers.location) {
          const location = apiRes.headers.location;
          // Resolve relative URLs against our instance base
          const parsedLoc = new URL(location, `${instanceUrl}/`);

          const redirectOpts = {
            hostname: parsedLoc.hostname,
            path: parsedLoc.pathname + parsedLoc.search,
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
            maxRedirects: 0,
          };

          const redirectReq = https.request(redirectOpts, (redirectRes) => {
            let rdata = '';
            redirectRes.on('data', chunk => (rdata += chunk));
            redirectRes.on('end', () => {
              // ------- sanity check for redirected payload -------
              if (!rdata.trim() || !rdata.startsWith('{')) {
                console.warn(
                  'Redirect response does not look like JSON, first 200 chars:',
                  rdata.slice(0, 200)
                );
                return res.status(500).send(
                  'Coolify API returned unexpected response after redirect'
                );
              }
              try {
                const apps = JSON.parse(rdata);
                // Keep only apps that have an FQDN and are not stopped
                const filtered = apps.filter(a => a.fqdn && a.status !== 'stopped');

                // Map each app to a card (inline SVG included)
                const cards = filtered.map(buildCard).join('');

                // Empty‑state when no apps match the filter
                const emptyState = filtered.length === 0
                  ? `<p class="text-center text-white/60 text-sm font-medium">No active applications found.</p>`
                  : '';

                // Assemble the final HTML page (Tailwind via CDN)
                const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Coolify Web Directory</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    .bg-dark { background-color: #0f0f23; }
    .truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body class="bg-dark min-h-screen flex items-center justify-center">
  <div class="max-w-7xl w-full grid gap-6 px-6 py-12 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 xl:gap-8">
    ${cards}
  </div>
  ${emptyState}
</body>
</html>`;

                res.send(html);
              } catch (parseErr) {
                console.error('Failed to parse redirected API response:', parseErr);
                res.status(500).send('Error parsing Coolify API response');
              }
            });
          });

          redirectReq.on('error', err => {
            console.error('Error following Coolify redirect:', err);
            res.status(500).send('Error contacting Coolify API');
          });
          redirectReq.end();
          return; // we already handled the redirect, skip normal processing
        }

        // Non‑200, non‑302 status – give a helpful message
        return res.status(500).send(`Coolify API error: ${apiRes.statusCode}`);
      }

      // -------------------------------------------------------------------------
      // Normal 200‑response processing
      // -------------------------------------------------------------------------
      // Basic sanity checks before trying to parse JSON
      if (!data.trim()) {
        return res.status(500).send('Coolify API returned an empty response');
      }
      if (!data.startsWith('{')) {
        console.warn(
          'Coolify API response does not start with “{”, first 200 chars:',
          data.slice(0, 200)
        );
        return res.status(500).send('Coolify API returned unexpected response format');
      }

      try {
        const apps = JSON.parse(data);
        const filtered = apps.filter(a => a.fqdn && a.status !== 'stopped');

        // Map each app to a card (inline SVG included)
        const cards = filtered.map(buildCard).join('');

        const emptyState = filtered.length === 0
          ? `<p class="text-center text-white/60 text-sm font-medium">No active applications found.</p>`
          : '';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Coolify Web Directory</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    .bg-dark { background-color: #0f0f23; }
    .truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body class="bg-dark min-h-screen flex items-center justify-center">
  <div class="max-w-7xl w-full grid gap-6 px-6 py-12 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 xl:gap-8">
    ${cards}
  </div>
  ${emptyState}
</body>
</html>`;

        res.send(html);
      } catch (parseErr) {
        console.error('Failed to parse Coolify API response:', parseErr);
        // Log a snippet of the raw body helps debugging when the API returns
        // unexpected content (e.g., HTML login page) instead of JSON.
        console.warn('Raw response snippet (first 200 chars):', data?.slice(0, 200));
        res.status(500).send('Error parsing Coolify API response. Check server logs for details.');
      }
    });
  });

  apiReq.on('error', err => {
    console.error('Error contacting Coolify API:', err);
    res.status(500).send('Error contacting Coolify API');
  });
  apiReq.end();
});

// -------------------------------------------------------------------------
// Start the HTTP server
// -------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Coolify Web Directory running at http://localhost:${PORT}`);
});
