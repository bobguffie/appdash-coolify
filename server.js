/**
 * Coolify Web Directory
 * Single-file Express dashboard for applications, services, and manual links
 * running on a Coolify instance.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

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

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function looksLikeDomain(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^(https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:\/.*)?$/i.test(trimmed);
}

function normalizeUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url.replace(/^\/+/, '')}`;
  }
  return url.replace(/\/+$/, '');
}

function domainKey(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return new URL(normalizeUrl(raw)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[/?#]/)[0]
      .toLowerCase();
  }
}

function extractDomains(value, label, output = []) {
  if (value == null || value === '') return output;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return output;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractDomains(JSON.parse(trimmed), label, output);
      } catch {
        // Fall through and treat it as a plain string.
      }
    }

    for (const part of trimmed.split(/[\n,]+/)) {
      const candidate = part.trim();
      if (candidate && looksLikeDomain(candidate)) {
        output.push({ domain: candidate, service: label });
      }
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const entry of value) extractDomains(entry, label, output);
    return output;
  }

  if (typeof value === 'object') {
    const explicit = value.domain || value.fqdn || value.url;
    const explicitLabel = value.name || value.service || value.container || label;
    if (explicit) extractDomains(explicit, explicitLabel, output);

    for (const [key, entry] of Object.entries(value)) {
      if (['domain', 'fqdn', 'url', 'name', 'service', 'container'].includes(key)) continue;

      if (typeof entry === 'string' && looksLikeDomain(entry)) {
        output.push({ domain: entry, service: key || label });
      } else {
        extractDomains(entry, key || label, output);
      }
    }
  }

  return output;
}
function normalizeCoolifyItem(raw, source) {
  if (!raw || typeof raw !== 'object') return [];

  const name = String(raw.name || raw.uuid || 'Unnamed').trim() || 'Unnamed';
  const status = String(raw.status || 'unknown').trim() || 'unknown';
  const domains = [];

  // Compose-specific domains first so service labels are preserved.
  extractDomains(raw.docker_compose_domains, name, domains);
  extractDomains(raw.fqdn, name, domains);
  extractDomains(raw.domains, name, domains);

  const seen = new Set();
  return domains
    .filter(entry => entry && entry.domain)
    .map(entry => {
      const url = normalizeUrl(entry.domain);
      const key = domainKey(url);
      if (!key || seen.has(key)) return null;
      seen.add(key);

      const service = entry.service && entry.service !== name ? entry.service : '';
      return {
        name: service ? `${name} · ${service}` : name,
        url,
        status,
        source,
        icon: null,
        custom: false,
        manualName: false,
      };
    })
    .filter(Boolean);
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = domainKey(item.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

const ACRONYMS = { uk: 'UK', api: 'API', db: 'DB', ai: 'AI', ui: 'UI', seo: 'SEO', cdn: 'CDN', http: 'HTTP', https: 'HTTPS' };

function titleCaseWords(value) {
  return String(value || '').split(/\s+/).map(word => {
    const key = word.toLowerCase();
    return ACRONYMS[key] || word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

/** Prefer an explicit or hostname-derived name when Coolify's own name is unhelpful. */
function displayName(item) {
  if (item.manualName) return item.name;

  const host = domainKey(item.url);
  if (NAME_OVERRIDES[host]) return NAME_OVERRIDES[host];

  const cleaned = titleCaseWords(cleanName(item.name));
  if (!GENERIC_NAME.test(cleaned)) return cleaned;

  const label = host.split('.')[0] || '';
  if (label && !LONG_TOKEN.test(label) && label !== 'www') {
    return titleCaseWords(label);
  }
  return cleaned;
}

function statusInfo(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'manual' || s === 'linked') return { label: 'Manual', tone: 'manual' };
  if (s.includes('unhealthy')) return { label: 'Unhealthy', tone: 'bad' };
  if (s.includes('healthy')) return { label: 'Healthy', tone: 'ok' };
  if (s.includes('running')) return { label: 'Running', tone: 'ok' };
  if (s.includes('restart')) return { label: 'Restarting', tone: 'warn' };
  if (s.includes('exited') || s.includes('stopped') || s.includes('dead')) return { label: 'Stopped', tone: 'bad' };
  if (!s) return { label: 'Unknown', tone: 'warn' };
  return { label: s.replace(/[:_]+/g, ' · '), tone: 'warn' };
}

function initials(name) {
  const w = String(name).split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}

function gradientFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const g = GRADIENTS[h % GRADIENTS.length];
  return 'linear-gradient(135deg,' + g[0] + ',' + g[1] + ')';
}

/** Candidate logo URLs for an app, tried in order, all from the app's own origin. */
function logoSources(item) {
  if (item.icon) return '';
  const origin = normalizeUrl(item.url).replace(/\/+$/, '');
  return [
    origin + '/apple-touch-icon.png',
    origin + '/apple-touch-icon-precomposed.png',
    origin + '/favicon.ico',
  ].join('|');
}

function customIconHtml(item) {
  const icon = item.icon == null ? '' : String(item.icon).trim();
  if (!icon) return '';
  if (/^(https?:\/\/|data:image\/)/i.test(icon)) {
    return '<img class="custom-icon" src="' + esc(icon) + '" alt="" referrerpolicy="no-referrer" loading="lazy">';
  }
  return '<span class="emoji" aria-hidden="true">' + esc(icon) + '</span>';
}
function loadCustomLinks() {
  const filePath = path.join(__dirname, 'custom_links.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('Could not read custom_links.json: ' + err.message);
    }
    return [];
  }

  let entries = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && Array.isArray(parsed.links)) {
    entries = parsed.links;
  } else if (parsed && typeof parsed.links === 'object' && parsed.links !== null) {
    entries = Object.entries(parsed.links).map(([domain, value]) => {
      if (typeof value === 'string') return { domain, name: value };
      return { domain, ...(value || {}) };
    });
  } else if (parsed && typeof parsed === 'object' && (parsed.domain || parsed.url || parsed.link)) {
    entries = [parsed];
  } else if (parsed && typeof parsed === 'object') {
    entries = Object.entries(parsed).map(([domain, value]) => {
      if (typeof value === 'string') return { domain, name: value };
      return { domain, ...(value || {}) };
    });
  }

  return entries
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;

      const domain = String(entry.domain || entry.host || entry.link || entry.url || '').trim();
      const providedUrl = entry.url || entry.link;
      const providedName = entry.name || entry.title;
      const url = normalizeUrl(providedUrl || domain);
      const name = String(providedName || domain || url).trim();
      const iconValue = entry.icon ?? entry.logo ?? entry.emoji ?? null;
      const icon = iconValue == null ? null : String(iconValue).trim();

      if (!url) return null;
      return {
        domain: domain || url,
        url,
        name: name || url,
        icon,
        hasUrl: Boolean(providedUrl),
        hasName: Boolean(providedName),
      };
    })
    .filter(Boolean);
}

function mergeItems(automated, custom) {
  const merged = new Map();

  for (const item of automated) {
    const key = domainKey(item.url);
    if (key && !merged.has(key)) {
      merged.set(key, { ...item });
    }
  }

  for (const entry of custom) {
    const matchKey = domainKey(entry.domain || entry.url);
    if (!matchKey) continue;

    if (merged.has(matchKey)) {
      const existing = merged.get(matchKey);
      if (entry.hasName && entry.name) {
        existing.name = entry.name;
        existing.manualName = true;
      }
      if (entry.hasUrl && entry.url) existing.url = entry.url;
      if (entry.icon != null && entry.icon !== '') existing.icon = entry.icon;
      existing.custom = true;
    } else {
      merged.set(matchKey, {
        name: entry.name || entry.domain || entry.url,
        url: entry.url,
        status: 'manual',
        source: 'custom',
        icon: entry.icon,
        custom: true,
        manualName: true,
      });
    }
  }

  return [...merged.values()];
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
  .notice{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:14px 16px;border-radius:12px;border:1px solid rgba(251,191,36,.25);background:rgba(251,191,36,.08);color:#fde68a;font-size:13px}
  .notice strong{font-weight:650;color:#fef3c7}
  .pill.manual{color:#60a5fa;background:rgba(96,165,250,.11);box-shadow:inset 0 0 0 1px rgba(96,165,250,.22)}
  .name-row{display:flex;align-items:center;gap:8px;min-width:0}
  .name-row .name{min-width:0}
  .manual-badge{flex:none;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;background:rgba(59,130,246,.14);box-shadow:inset 0 0 0 1px rgba(59,130,246,.25);padding:3px 6px;border-radius:5px}
  .avatar .custom-icon{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:10px;background:transparent}
  .avatar .emoji{font-size:34px;line-height:1;position:relative;z-index:1}
`;

function cardHtml(item) {
  const name = displayName(item);
  const host = domainKey(item.url);
  const url = normalizeUrl(item.url);
  const st = statusInfo(item.status);
  const hay = (name + ' ' + host + ' ' + (item.source || '')).toLowerCase();
  const customIcon = customIconHtml(item);
  const avatarContent = customIcon || (
    '<span class="inits">' + esc(initials(name)) + '</span>'
    + '<img class="logo" alt="" referrerpolicy="no-referrer" data-srcs="' + esc(logoSources(item)) + '">'
  );
  const manualBadge = item.custom ? '<span class="manual-badge">Manual</span>' : '';

  return '<a class="card" href="' + esc(url) + '" target="_blank" rel="noopener"'
    + ' data-hay="' + esc(hay) + '" title="' + esc(host) + '">'
    + '<span class="avatar" style="background:' + gradientFor(name) + '">' + avatarContent + '</span>'
    + '<span class="body">'
    + '<span class="name-row"><span class="name">' + esc(name) + '</span>' + manualBadge + '</span>'
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

function page(items = [], errors = []) {
  const cards = items.map(cardHtml).join('');
  const warning = errors.length
    ? '<div class="notice"><strong>Coolify API warning</strong><span>' + errors.map(esc).join(' · ') + '</span></div>'
    : '';
  const empty = items.length === 0
    ? '<div class="empty"><strong>No applications or links found</strong>Deploy something in Coolify or add an entry to custom_links.json.</div>'
    : '';
  const body = warning + cards + empty;

  const searchBar = !items.length ? '' :
    '<div class="search">'
    + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="m10.6 10.6 2.9 2.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input id="q" type="search" placeholder="Filter apps &amp; links" autocomplete="off" aria-label="Filter applications and links">'
    + '</div>';

  const subtitle = '<b>' + items.length + '</b> ' + (items.length === 1 ? 'app or link' : 'apps &amp; links') + (errors.length ? ' · API warning' : ' live');

  return '<!DOCTYPE html>\n<html lang="en">\n<head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="dark">'
    + '<title>Web Directory · Coolify</title>'
    + '<link rel="icon" href="data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6366f1"/><rect x="8" y="9" width="7" height="6" rx="1.5" fill="#fff"/><rect x="17" y="9" width="7" height="6" rx="1.5" fill="#fff" opacity=".65"/><rect x="8" y="17" width="16" height="6" rx="1.5" fill="#fff" opacity=".4"/></svg>') + '">'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">'
    + '<style>' + STYLE + '</style>'
    + '</head><body><div class="wrap">'
    + '<header>'
    + '<div class="brand">'
    + '<span class="mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="7.5" height="7" rx="1.8"/><rect x="13.5" y="4" width="7.5" height="7" rx="1.8" opacity=".6"/><rect x="3" y="13" width="18" height="7" rx="1.8" opacity=".35"/></svg></span>'
    + '<div><h1>Web Directory</h1><p class="sub">' + subtitle + '</p></div>'
    + '</div>'
    + searchBar
    + '</header>'
    + '<main class="grid" id="grid">' + body + '</main>'
    + '<footer>Live from Coolify · applications, services &amp; manual links</footer>'
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
function fetchCoolifyJson(url, token, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error('Invalid Coolify URL: ' + url));
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': 'coolify-web-directory/1.0',
      },
    };

    const req = client.request(options, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchCoolifyJson(next, token, redirects + 1));
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        if (status === 401) {
          return reject(new Error('401 Unauthorized - check COOLIFY_API_TOKEN'));
        }
        if (status !== 200) {
          return reject(new Error('HTTP ' + status + ' from ' + parsed.pathname));
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Invalid JSON from ' + parsed.pathname + ': ' + err.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Coolify API timed out')));
    req.end();
  });
}

function buildCoolifyUrl(instanceUrl, pathname) {
  return instanceUrl.replace(/\/+$/, '') + pathname;
}

app.get('/', async (req, res) => {
  const base = String(process.env.COOLIFY_INSTANCE_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.COOLIFY_API_TOKEN || '').trim();

  if (!base || !token) {
    return res.status(500).send(page([], ['COOLIFY_INSTANCE_URL and COOLIFY_API_TOKEN must be set']));
  }

  const errors = [];
  const automated = [];

  const [appsResult, servicesResult] = await Promise.allSettled([
    fetchCoolifyJson(buildCoolifyUrl(base, '/api/v1/applications'), token),
    fetchCoolifyJson(buildCoolifyUrl(base, '/api/v1/services'), token),
  ]);

  if (appsResult.status === 'fulfilled') {
    for (const app of asArray(appsResult.value)) {
      automated.push(...normalizeCoolifyItem(app, 'application'));
    }
  } else {
    const message = appsResult.reason?.message || 'Unknown error';
    console.error('Applications endpoint failed:', message);
    errors.push('Applications: ' + message);
  }

  if (servicesResult.status === 'fulfilled') {
    for (const service of asArray(servicesResult.value)) {
      automated.push(...normalizeCoolifyItem(service, 'service'));
    }
  } else {
    const message = servicesResult.reason?.message || 'Unknown error';
    console.error('Services endpoint failed:', message);
    errors.push('Services: ' + message);
  }

  const filtered = dedupeItems(automated).filter(item => {
    const status = String(item.status || '').toLowerCase();
    return Boolean(item.url) && !status.startsWith('stopped');
  });

  const items = mergeItems(filtered, loadCustomLinks())
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  res.send(page(items, errors));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('Internal server error');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('Coolify Web Directory running on port ' + PORT);
  });
}

module.exports = {
  app,
  asArray,
  cardHtml,
  customIconHtml,
  dedupeItems,
  displayName,
  domainKey,
  extractDomains,
  fetchCoolifyJson,
  loadCustomLinks,
  logoSources,
  mergeItems,
  normalizeCoolifyItem,
  normalizeUrl,
  page,
  statusInfo,
};