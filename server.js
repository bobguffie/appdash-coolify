/**
 * Coolify Web Directory
 * Single-file Express dashboard for the apps running on a Coolify instance.
 */

require('dotenv').config();

const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const LONG_TOKEN = /^[a-z0-9]{12,}$/i;
const GRADIENTS = [
  ['#6366f1', '#8b5cf6'],
  ['#0ea5e9', '#22d3ee'],
  ['#f59e0b', '#fb923c'],
  ['#10b981', '#34d399'],
  ['#ec4899', '#f472b6'],
  ['#8b5cf6', '#d946ef'],
  ['#14b8a6', '#22d3ee'],
];

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** "bin-reminder-skdc:main-txk1guz40kmbc4o1ds32taqx" -> "Bin Reminder Skdc" */
function cleanName(raw) {
  const head = String(raw || 'Unnamed').split(':')[0];
  const parts = head.split(/[-_\s]+/).filter(Boolean);
  const kept = parts.filter(p => !LONG_TOKEN.test(p));
  const base = (kept.length ? kept : parts).join(' ');
  return base.replace(/\b\w/g, c => c.toUpperCase()) || 'Unnamed';
}

/** Explicit display names, keyed by hostname, where Coolify's auto-name is unhelpful. */
const NAME_OVERRIDES = {
  'crafterssmartbible.120384.xyz': 'Crafters Smart Bible',
};

/** Names Coolify generates that say nothing about the app. */
const GENERIC_NAME = /^(dockerfile|dockerimage|application|app|service|container|unnamed)$/i;

/** Prefer an explicit or hostname-derived name when Coolify's own name is unhelpful. */
function displayName(a) {
  const host = primaryHost(a.fqdn);
  if (NAME_OVERRIDES[host]) return NAME_OVERRIDES[host];

  const cleaned = cleanName(a.name);
  if (!GENERIC_NAME.test(cleaned)) return cleaned;

  const label = host.split('.')[0] || '';
  return label.replace(/\b\w/g, c => c.toUpperCase()) || cleaned;
}

function initials(name) {
  const w = String(name).split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}

/**
 * Coolify can list several hostnames per app, including an internal UUID-style one.
 * Pick the friendliest: skip uuid subdomains and "www", prefer the shortest.
 */
function firstFqdn(fqdn) {
  const list = String(fqdn || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return '';

  const score = (u) => {
    const host = u.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const label = host.split('.')[0].toLowerCase();
    let s = host.length * 0.01;
    if (LONG_TOKEN.test(label)) s += 100;
    if (label === 'www') s += 50;
    return s;
  };

  return list.slice().sort((a, b) => score(a) - score(b))[0];
}

function primaryHost(fqdn) {
  return firstFqdn(fqdn).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function fullUrl(fqdn) {
  const f = firstFqdn(fqdn);
  return /^https?:\/\//i.test(f) ? f : 'https://' + f;
}

function statusInfo(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('healthy')) return { label: 'Healthy', tone: 'ok' };
  if (s.includes('running')) return { label: 'Running', tone: 'ok' };
  if (s.includes('restart')) return { label: 'Restarting', tone: 'warn' };
  if (s.includes('exited') || s.includes('stopped') || s.includes('dead')) return { label: 'Stopped', tone: 'bad' };
  if (!s) return { label: 'Unknown', tone: 'warn' };
  return { label: s.replace(/[:_]+/g, ' \u00b7 '), tone: 'warn' };
}

function gradientFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const g = GRADIENTS[h % GRADIENTS.length];
  return 'linear-gradient(135deg,' + g[0] + ',' + g[1] + ')';
}

/** Candidate logo URLs for an app, tried in order, all from the app's own origin. */
function logoSources(fqdn) {
  const origin = fullUrl(fqdn).replace(/\/+$/, '');
  return [
    origin + '/apple-touch-icon.png',
    origin + '/apple-touch-icon-precomposed.png',
    origin + '/favicon.ico',
  ].join('|');
}

function cardHtml(a) {
  const name = displayName(a);
  const host = primaryHost(a.fqdn);
  const url = fullUrl(a.fqdn);
  const st = statusInfo(a.status);
  const hay = (name + ' ' + host).toLowerCase();

  return '<a class="card" href="' + esc(url) + '" target="_blank" rel="noopener"'
    + ' data-hay="' + esc(hay) + '" title="' + esc(host) + '">'
    + '<span class="avatar" style="background:' + gradientFor(name) + '">'
    + '<span class="inits">' + esc(initials(name)) + '</span>'
    + '<img class="logo" alt="" referrerpolicy="no-referrer" data-srcs="' + esc(logoSources(a.fqdn)) + '">'
    + '</span>'
    + '<span class="body">'
    + '<span class="name">' + esc(name) + '</span>'
    + '<span class="host">' + esc(host) + '</span>'
    + '</span>'
    + '<span class="tail">'
    + '<span class="pill ' + st.tone + '"><span class="dot"></span>' + esc(st.label) + '</span>'
    + '<svg class="arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M6 3h7v7M13 3 4.5 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>'
    + '</span>'
    + '</a>';
}

const STYLE = `
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#07090f; --card:#11141d; --card-hover:#161a26;
    --line:rgba(255,255,255,.07); --line-hi:rgba(129,140,248,.42);
    --text:#e9ebf3; --muted:#868da6; --accent:#818cf8;
    color-scheme:dark;
  }
  html,body{margin:0;min-height:100%}
  body{
    background:var(--bg); color:var(--text);
    font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    font-feature-settings:"cv11","ss01"; -webkit-font-smoothing:antialiased;
    background-image:
      radial-gradient(900px 420px at 15% -12%, rgba(99,102,241,.20), transparent 65%),
      radial-gradient(760px 380px at 88% -6%, rgba(14,165,233,.13), transparent 62%);
    background-repeat:no-repeat;
  }
  .wrap{max-width:1320px;margin:0 auto;padding:60px 26px 80px}

  header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:34px}
  .brand{display:flex;align-items:center;gap:14px}
  .mark{
    width:42px;height:42px;border-radius:13px;flex:none;display:grid;place-items:center;
    background:linear-gradient(140deg,#6366f1,#8b5cf6);
    box-shadow:0 8px 24px -8px rgba(99,102,241,.85), inset 0 1px 0 rgba(255,255,255,.28);
  }
  .mark svg{width:21px;height:21px;color:#fff}
  h1{margin:0;font-size:26px;line-height:1.15;letter-spacing:-.024em;font-weight:650}
  .sub{margin:3px 0 0;font-size:13.5px;color:var(--muted)}
  .sub b{color:#c3c8db;font-weight:600}

  .search{position:relative;flex:1;min-width:220px;max-width:340px}
  .search svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:var(--muted);pointer-events:none}
  .search input{
    width:100%;padding:10px 12px 10px 35px;border-radius:11px;
    border:1px solid var(--line);background:rgba(255,255,255,.035);color:var(--text);
    font:inherit;font-size:13.5px;outline:none;transition:border-color .16s,background .16s;
  }
  .search input::placeholder{color:#6a7189}
  .search input:focus{border-color:var(--line-hi);background:rgba(255,255,255,.06)}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(462px,1fr));gap:20px}

  .card{
    display:flex;align-items:center;gap:19px;
    padding:27px 26px;border-radius:18px;text-decoration:none;color:inherit;
    background:var(--card);border:1px solid var(--line);
    transition:transform .18s ease,border-color .18s ease,background .18s ease,box-shadow .18s ease;
  }
  .card:hover{transform:translateY(-3px);border-color:var(--line-hi);background:var(--card-hover);
    box-shadow:0 14px 34px -18px rgba(0,0,0,.95),0 0 0 1px rgba(129,140,248,.12)}
  .card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

  .avatar{
    position:relative;width:66px;height:66px;border-radius:17px;flex:none;
    display:grid;place-items:center;overflow:hidden;
    font-size:19px;font-weight:700;letter-spacing:.02em;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.3);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.25);
  }
  .avatar .inits{line-height:1}
  .avatar .logo{
    position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
    padding:12px;opacity:0;transition:opacity .22s ease;background:transparent;
  }
  .avatar .logo.on{opacity:1}
  .body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
  .name{font-size:19px;font-weight:600;letter-spacing:-.016em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .host{font-size:14.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

  .tail{display:flex;align-items:center;gap:9px;flex:none}
  .pill{display:inline-flex;align-items:center;gap:7px;padding:6px 13px 6px 11px;border-radius:999px;
    font-size:12.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap}
  .pill .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
  .pill.ok{color:#4ade80;background:rgba(74,222,128,.11);box-shadow:inset 0 0 0 1px rgba(74,222,128,.22)}
  .pill.warn{color:#fbbf24;background:rgba(251,191,36,.11);box-shadow:inset 0 0 0 1px rgba(251,191,36,.22)}
  .pill.bad{color:#f87171;background:rgba(248,113,113,.11);box-shadow:inset 0 0 0 1px rgba(248,113,113,.22)}
  .pill.ok .dot{animation:pulse 2.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

  .arrow{width:19px;height:19px;color:#565d75;flex:none;transition:transform .18s ease,color .18s ease}
  .card:hover .arrow{color:var(--accent);transform:translate(2px,-2px)}

  .empty{grid-column:1/-1;text-align:center;padding:64px 20px;color:var(--muted);
    border:1px dashed rgba(255,255,255,.09);border-radius:14px;font-size:14px}
  .empty strong{display:block;color:#c3c8db;font-size:15px;margin-bottom:5px;font-weight:600}
  .hidden{display:none!important}
  footer{margin-top:34px;font-size:12px;color:#5d6478;text-align:center}

  @media (max-width:640px){
    .wrap{padding:34px 16px 56px}
    header{margin-bottom:24px}
    h1{font-size:20px}
    .search{max-width:none;width:100%}
    .grid{grid-template-columns:1fr;gap:12px}
    .card{padding:17px 16px;gap:14px}
    .avatar{width:46px;height:46px;border-radius:12px;font-size:14px}
    .name{font-size:15.5px}
    .pill{display:none}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

function page(cards, count, error) {
  const body = error
    ? '<div class="empty"><strong>Could not reach Coolify</strong>' + esc(error) + '</div>'
    : (cards || '<div class="empty"><strong>No applications found</strong>Deploy something and it will appear here.</div>');

  const searchBar = error || !count ? '' :
    '<div class="search">'
    + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="m10.6 10.6 2.9 2.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input id="q" type="search" placeholder="Filter apps" autocomplete="off" aria-label="Filter applications">'
    + '</div>';

  const subtitle = error ? 'Connection problem'
    : '<b>' + count + '</b> ' + (count === 1 ? 'application' : 'applications') + ' deployed';

  return '<!DOCTYPE html>\n<html lang="en">\n<head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="dark">'
    + '<title>Applications \u00b7 Coolify</title>'
    + '<link rel="icon" href="data:image/svg+xml,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6366f1"/><rect x="8" y="9" width="7" height="6" rx="1.5" fill="#fff"/><rect x="17" y="9" width="7" height="6" rx="1.5" fill="#fff" opacity=".65"/><rect x="8" y="17" width="16" height="6" rx="1.5" fill="#fff" opacity=".4"/></svg>')
    + '">'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">'
    + '<style>' + STYLE + '</style>'
    + '</head><body><div class="wrap">'
    + '<header>'
    + '<div class="brand">'
    + '<span class="mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="7.5" height="7" rx="1.8"/><rect x="13.5" y="4" width="7.5" height="7" rx="1.8" opacity=".6"/><rect x="3" y="13" width="18" height="7" rx="1.8" opacity=".35"/></svg></span>'
    + '<div><h1>Applications</h1><p class="sub">' + subtitle + '</p></div>'
    + '</div>'
    + searchBar
    + '</header>'
    + '<main class="grid" id="grid">' + body + '</main>'
    + '<footer>Live from Coolify \u00b7 updates on refresh</footer>'
    + '</div>'
    + '<script>'
    + 'document.querySelectorAll("img.logo").forEach(function(img){'
    + 'var list=(img.dataset.srcs||"").split("|").filter(Boolean);'
    + 'function next(){if(!list.length){img.parentNode.removeChild(img);return;}img.src=list.shift();}'
    + 'img.addEventListener("load",function(){img.classList.add("on");});'
    + 'img.addEventListener("error",next);'
    + 'next();});'
    + 'var q=document.getElementById("q");'
    + 'if(q){q.addEventListener("input",function(){'
    + 'var v=q.value.trim().toLowerCase(),n=0;'
    + 'document.querySelectorAll(".card").forEach(function(c){'
    + 'var show=!v||c.dataset.hay.indexOf(v)>-1;'
    + 'c.classList.toggle("hidden",!show);if(show)n++;});});}'
    + '</script>'
    + '</body></html>';
}

function fetchJson(url, token, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchJson(next, token, redirects + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (status !== 200) return reject(new Error('Coolify API returned HTTP ' + status));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Coolify API returned invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Coolify API timed out')));
    req.end();
  });
}

app.get('/', async (req, res) => {
  const base = String(process.env.COOLIFY_INSTANCE_URL || '').replace(/\/+$/, '');
  const token = process.env.COOLIFY_API_TOKEN || '';

  if (!base || !token) {
    res.status(500).send(page('', 0, 'COOLIFY_INSTANCE_URL and COOLIFY_API_TOKEN must be set'));
    return;
  }

  try {
    const apps = await fetchJson(base + '/api/v1/applications', token);
    const list = (Array.isArray(apps) ? apps : [])
      .filter(a => a && a.fqdn && String(a.status || '').toLowerCase() !== 'stopped')
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));

    const cards = list.map(cardHtml).join('');
    res.send(page(cards, list.length, null));
  } catch (err) {
    console.error('Coolify request failed:', err.message);
    res.status(502).send(page('', 0, err.message));
  }
});

app.listen(PORT, () => {
  console.log('Coolify Web Directory running on port ' + PORT);
});
