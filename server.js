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
const crypto = require('crypto');

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
  return /^(https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed);
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
function customLinksPath() {
  const dataDir = process.env.DATA_DIR
    || (process.env.NODE_ENV === 'production' ? '/app/data' : __dirname);
  return path.join(dataDir, 'custom_links.json');
}

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1'
    || String(value).toLowerCase() === 'true';
}

function customLinkEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.links)) return parsed.links;
  if (parsed && parsed.links && typeof parsed.links === 'object') {
    return Object.entries(parsed.links).map(([domain, value]) => {
      if (typeof value === 'string') return { domain, name: value };
      return { domain, ...(value || {}) };
    });
  }
  if (parsed && typeof parsed === 'object' && (parsed.domain || parsed.url || parsed.link)) {
    return [parsed];
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed).map(([domain, value]) => {
      if (typeof value === 'string') return { domain, name: value };
      return { domain, ...(value || {}) };
    });
  }
  return [];
}

function readCustomLinkEntries({ strict = false } = {}) {
  const filePath = customLinksPath();
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    if (strict) throw err;
    console.warn('Could not read ' + filePath + ': ' + err.message);
    return [];
  }

  try {
    return customLinkEntries(JSON.parse(source));
  } catch (err) {
    if (strict) {
      throw new Error('Existing custom_links.json is not valid JSON: ' + err.message);
    }
    console.warn('Could not parse ' + filePath + ': ' + err.message);
    return [];
  }
}

function loadCustomLinks() {
  return readCustomLinkEntries()
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;

      const domain = String(entry.domain || entry.host || entry.link || entry.url || '').trim();
      const providedUrl = entry.url || entry.link;
      const providedName = entry.name || entry.title;
      const url = normalizeUrl(providedUrl || domain);
      const name = String(providedName || domain || url).trim();
      const iconValue = entry.icon ?? entry.logo ?? entry.emoji ?? null;
      const icon = iconValue == null ? null : String(iconValue).trim();
      const hide = isTruthyFlag(entry.hide);

      if (!url) return null;
      return {
        domain: domain || url,
        url,
        name: name || url,
        icon,
        hide,
        hasUrl: Boolean(providedUrl),
        hasName: Boolean(providedName),
        hasIcon: Boolean(icon),
        hasHide: hide,
      };
    })
    .filter(Boolean);
}

function mergeItems(automated, custom) {
  const merged = new Map();

  for (const item of automated) {
    const key = domainKey(item.url);
    if (key && !merged.has(key)) {
      merged.set(key, {
        ...item,
        editDomain: key,
        isHidden: false,
        hasCustomName: false,
        hasCustomIcon: false,
        hasCustomUrl: false,
      });
    }
  }

  for (const entry of custom) {
    const matchKey = domainKey(entry.domain || entry.url);
    if (!matchKey) continue;

    if (merged.has(matchKey)) {
      const existing = merged.get(matchKey);
      existing.editDomain = matchKey;
      if (entry.hasName && entry.name) {
        existing.name = entry.name;
        existing.manualName = true;
        existing.hasCustomName = true;
      }
      if (entry.hasUrl && entry.url) {
        existing.url = entry.url;
        existing.hasCustomUrl = true;
      }
      if (entry.icon != null && entry.icon !== '') {
        existing.icon = entry.icon;
        existing.hasCustomIcon = true;
      }
      if (entry.hasHide) existing.isHidden = true;
      existing.custom = Boolean(entry.hasName || entry.hasUrl || entry.hasIcon || entry.hasHide);
    } else {
      merged.set(matchKey, {
        name: entry.name || entry.domain || entry.url,
        url: entry.url,
        status: 'manual',
        source: 'custom',
        icon: entry.icon,
        custom: true,
        manualName: true,
        editDomain: matchKey,
        hasCustomName: Boolean(entry.hasName && entry.name),
        hasCustomIcon: Boolean(entry.hasIcon || entry.icon),
        hasCustomUrl: Boolean(entry.hasUrl),
        isHidden: Boolean(entry.hasHide),
      });
    }
  }

  return [...merged.values()];
}
const MAX_LINK_UPDATES = 500;
const MAX_NAME_LENGTH = 200;
const MAX_ICON_LENGTH = 8192;
const MAX_URL_LENGTH = 2048;

class BadRequestError extends Error {}

function adminEditingEnabled() {
  return Boolean(String(process.env.ADMIN_TOKEN || '').trim());
}

function adminTokenFromRequest(req) {
  const auth = String(req.get('authorization') || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return String(req.get('x-admin-token') || '').trim();
}

function tokensMatch(provided, expected) {
  const left = Buffer.from(String(provided), 'utf8');
  const right = Buffer.from(String(expected), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_TOKEN || '').trim();
  if (!expected) {
    return res.status(503).json({ error: 'Admin editing is disabled. Set ADMIN_TOKEN on the server.' });
  }
  const provided = adminTokenFromRequest(req);
  if (!provided || !tokensMatch(provided, expected)) {
    return res.status(401).json({ error: 'Invalid admin token.' });
  }
  return next();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cleanTextField(value, maxLength, label) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestError(label + ' must be text.');
  }
  const text = String(value).trim();
  if (text.length > maxLength) {
    throw new BadRequestError(label + ' is too long.');
  }
  if (/[\u0000-\u0008\u000a-\u000c\u000e-\u001f]/.test(text)) {
    throw new BadRequestError(label + ' contains invalid control characters.');
  }
  return text;
}

function linkUpdatesFromBody(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') {
    throw new BadRequestError('Request body must be a JSON object.');
  }
  if (Array.isArray(body.links)) return body.links;
  if (body.links && typeof body.links === 'object') {
    return Object.entries(body.links).map(([domain, value]) => {
      if (typeof value === 'string') return { domain, name: value };
      return { domain, ...(value && typeof value === 'object' ? value : {}) };
    });
  }
  if (body.domain || body.host || body.url) return [body];
  throw new BadRequestError('Request body must include a links array.');
}

function normalizeLinkUpdate(raw, index) {
  const label = 'links[' + index + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError(label + ' must be an object.');
  }

  const rawDomain = raw.domain || raw.host || raw.url || raw.link;
  if (!rawDomain || !looksLikeDomain(String(rawDomain))) {
    throw new BadRequestError(label + '.domain must be a valid hostname.');
  }
  const key = domainKey(rawDomain);
  if (!key) throw new BadRequestError(label + '.domain must be a valid hostname.');

  const update = { key, domain: key };

  if (hasOwn(raw, 'name') || hasOwn(raw, 'title')) {
    update.hasName = true;
    update.name = cleanTextField(raw.name ?? raw.title, MAX_NAME_LENGTH, label + '.name');
  }

  if (hasOwn(raw, 'icon') || hasOwn(raw, 'logo') || hasOwn(raw, 'emoji')) {
    update.hasIcon = true;
    update.icon = cleanTextField(raw.icon ?? raw.logo ?? raw.emoji, MAX_ICON_LENGTH, label + '.icon');
  }

  if (hasOwn(raw, 'url') || hasOwn(raw, 'link')) {
    update.hasUrl = true;
    const rawUrl = cleanTextField(raw.url ?? raw.link, MAX_URL_LENGTH, label + '.url');
    if (rawUrl) {
      const url = normalizeUrl(rawUrl);
      let parsed;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed || !/^https?:$/i.test(parsed.protocol)) {
        throw new BadRequestError(label + '.url must be an http(s) URL.');
      }
      update.url = url;
    } else {
      update.url = '';
    }
  }

  if (hasOwn(raw, 'hide')) {
    update.hasHide = true;
    const hide = raw.hide;
    if (hide === true || hide === 1 || hide === '1' || String(hide).toLowerCase() === 'true') {
      update.hide = true;
    } else if (hide === false || hide === 0 || hide === '0' || hide == null || String(hide).toLowerCase() === 'false') {
      update.hide = false;
    } else {
      throw new BadRequestError(label + '.hide must be true or false.');
    }
  }

  if (!update.hasName && !update.hasIcon && !update.hasUrl && !update.hasHide) {
    throw new BadRequestError(label + ' must include at least one of name, icon, url, or hide.');
  }

  return update;
}

function saveCustomLinkUpdates(updates) {
  const existing = readCustomLinkEntries({ strict: true });
  const byKey = new Map();
  const entries = [];

  for (const entry of existing) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rawDomain = entry.domain || entry.host || entry.link || entry.url || '';
    const key = domainKey(rawDomain);
    if (!key) continue;
    const copy = { ...entry };
    if (!copy.domain) copy.domain = key;
    entries.push(copy);
    if (!byKey.has(key)) byKey.set(key, copy);
  }

  let updated = 0;
  let createdCount = 0;
  for (const update of updates) {
    const existingEntry = byKey.get(update.key);
    const created = !existingEntry;
    const entry = existingEntry || { domain: update.domain };

    if (update.hasName) {
      if (update.name) {
        entry.name = update.name;
        delete entry.title;
      } else {
        delete entry.name;
        delete entry.title;
      }
    }
    if (update.hasIcon) {
      if (update.icon) {
        entry.icon = update.icon;
        delete entry.logo;
        delete entry.emoji;
      } else {
        delete entry.icon;
        delete entry.logo;
        delete entry.emoji;
      }
    }
    if (update.hasUrl) {
      if (update.url) {
        entry.url = update.url;
        delete entry.link;
      } else {
        delete entry.url;
        delete entry.link;
      }
    }
    if (update.hasHide) {
      if (update.hide) entry.hide = true;
      else delete entry.hide;
    }

    if (created) {
      const meaningful = Boolean(entry.name || entry.title || entry.url || entry.link
        || entry.icon || entry.logo || entry.emoji || entry.hide === true);
      if (!meaningful) continue;
      byKey.set(update.key, entry);
      entries.push(entry);
      createdCount += 1;
    }
    updated += 1;
  }

  const filePath = customLinksPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ links: entries }, null, 2) + '\n', 'utf8');
  return { updated, created: createdCount, links: entries.length };
}

function handleCustomLinksSave(req, res) {
  try {
    const rawUpdates = linkUpdatesFromBody(req.body);
    if (rawUpdates.length > MAX_LINK_UPDATES) {
      throw new BadRequestError('Too many link updates in one request.');
    }
    const updates = rawUpdates.map(normalizeLinkUpdate);
    const result = saveCustomLinkUpdates(updates);
    return res.json({ ok: true, updated: result.updated, created: result.created, links: result.links });
  } catch (err) {
    if (err instanceof BadRequestError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Could not save custom links:', err);
    return res.status(500).json({ error: 'Could not save custom links. Check that DATA_DIR is writable.' });
  }
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
    .add-link{width:100%;justify-content:center}
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
  .card-wrap{display:flex;flex-direction:column;min-width:0}
  .card-wrap .card{width:100%}
  .card-wrap.is-new .card{border-style:dashed;border-color:rgba(129,140,248,.5);
    background:linear-gradient(180deg,rgba(129,140,248,.08),rgba(17,20,29,.9))}
  .card-wrap.is-new .name{color:#dbe2ff}
  .card-wrap.is-new .host{color:#8f9bc7}
  .draft-badge{color:#c7d2fe!important;background:rgba(129,140,248,.16)!important;
    box-shadow:inset 0 0 0 1px rgba(129,140,248,.3)!important}
  .card-wrap.is-hidden{display:none}
  .card-wrap.filtered{display:none!important}
  body.editing .card-wrap.is-hidden{display:flex}
  body.editing .card-wrap.is-hidden .card{opacity:.52;border-style:dashed;filter:grayscale(.5)}
  body.editing .card{pointer-events:none}
  body.editing .card .arrow{display:none}
  .hidden-flag{display:none;flex:none;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#fbbf24;background:rgba(251,191,36,.12);box-shadow:inset 0 0 0 1px rgba(251,191,36,.26);padding:3px 6px;border-radius:5px}
  .card-wrap.is-hidden .hidden-flag{display:inline-flex}

  .admin-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
    padding:13px 16px;margin:-18px 0 22px;border-radius:13px;border:1px solid var(--line);
    background:rgba(255,255,255,.025)}
  .admin-bar[data-admin-enabled="0"]{opacity:.84}
  .admin-copy{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:12.5px}
  .admin-copy strong{color:#c3c8db;font-size:13px;letter-spacing:-.01em}
  .admin-actions{display:none;align-items:center;gap:9px;flex-wrap:wrap;margin-left:auto}
  body.editing .admin-actions{display:flex}
  .btn{appearance:none;border:1px solid var(--line);background:rgba(255,255,255,.045);
    color:var(--text);border-radius:9px;padding:8px 13px;font:inherit;font-size:12.5px;font-weight:600;
    cursor:pointer;transition:border-color .16s,background .16s,color .16s,opacity .16s}
  .btn:hover{border-color:var(--line-hi);background:rgba(255,255,255,.075)}
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btn.primary{color:#fff;border-color:rgba(129,140,248,.55);background:linear-gradient(135deg,#6366f1,#8b5cf6);
    box-shadow:0 8px 18px -12px rgba(99,102,241,.9)}
  .btn.primary:hover{background:linear-gradient(135deg,#7377f5,#9a6ef8)}
  .btn.ghost{color:var(--muted);background:transparent}
  .btn[disabled]{opacity:.45;cursor:not-allowed;transform:none}
  .add-link{display:none;align-items:center;gap:7px;padding:10px 15px;font-size:13px;
    border-color:rgba(129,140,248,.55);background:rgba(129,140,248,.13);color:#c7d2fe;
    box-shadow:0 8px 22px -18px rgba(99,102,241,.95)}
  .add-link:hover{border-color:rgba(129,140,248,.82);background:rgba(129,140,248,.21);color:#e0e7ff}
  body.editing .add-link{display:inline-flex}
  .edit-status{font-size:12px;color:var(--muted);min-width:112px;text-align:right}
  body.has-edits .edit-status{color:#fbbf24}

  .editor{display:none;margin-top:10px;padding:14px 15px 15px;border-radius:13px;
    border:1px solid rgba(129,140,248,.18);background:rgba(9,12,20,.72)}
  body.editing .editor{display:block}
  .editor-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
  .editor-kicker{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#737b94}
  .hide-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
    background:rgba(255,255,255,.04);color:#c3c8db;border-radius:7px;padding:5px 9px;
    font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}
  .hide-btn:hover{border-color:var(--line-hi);background:rgba(255,255,255,.07)}
  .hide-btn svg{width:14px;height:14px}
  .hide-btn .eye-off{display:none}
  .hide-btn.is-off{color:#fbbf24;border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.09)}
  .hide-btn.is-off .eye-open{display:none}
  .hide-btn.is-off .eye-off{display:inline}
  .remove-btn{display:inline-flex;align-items:center;border:1px solid rgba(248,113,113,.3);
    background:rgba(248,113,113,.08);color:#fca5a5;border-radius:7px;padding:5px 9px;
    font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}
  .remove-btn:hover{border-color:rgba(248,113,113,.55);background:rgba(248,113,113,.14);color:#fecaca}
  .editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:10px}
  .field{display:flex;flex-direction:column;gap:5px;min-width:0}
  .field.field-wide{grid-column:1/-1}
  .field span{font-size:10.5px;font-weight:600;letter-spacing:.045em;text-transform:uppercase;color:#737b94}
  .field input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);
    background:rgba(255,255,255,.035);color:var(--text);font:inherit;font-size:13px;outline:none}
  .field input::placeholder{color:#5f6780}
  .field input:focus{border-color:var(--line-hi);background:rgba(255,255,255,.06)}
  .new-hint{margin:9px 0 0;color:#737b94;font-size:11.5px;line-height:1.45}
  .card-wrap.dirty .card{border-color:rgba(251,191,36,.55)}
  .card-wrap.dirty .editor{box-shadow:inset 0 0 0 1px rgba(251,191,36,.16)}

  #toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,18px);z-index:40;
    max-width:min(520px,calc(100vw - 32px));padding:11px 16px;border-radius:10px;
    border:1px solid var(--line);background:#171b27;color:var(--text);font-size:13px;
    box-shadow:0 18px 40px -18px rgba(0,0,0,.9);opacity:0;pointer-events:none;
    transition:opacity .18s,transform .18s}
  #toast.on{opacity:1;transform:translate(-50%,0)}
  #toast.error{border-color:rgba(248,113,113,.4);color:#fecaca;background:#25161a}
  #toast.ok{border-color:rgba(74,222,128,.35);color:#bbf7d0;background:#122019}

  dialog.modal:not([open]){display:none}
  dialog.modal{border:1px solid var(--line);border-radius:16px;padding:0;background:var(--card);
    color:var(--text);width:min(430px,calc(100vw - 32px));box-shadow:0 30px 80px -28px rgba(0,0,0,.95)}
  dialog.modal::backdrop{background:rgba(3,5,10,.74);backdrop-filter:blur(4px)}
  .modal-body{padding:22px}
  .modal-body h2{margin:0 0 6px;font-size:17px;letter-spacing:-.02em}
  .modal-body p{margin:0 0 15px;color:var(--muted);font-size:12.5px;line-height:1.5}
  .modal-body input{width:100%;padding:10px 11px;border-radius:9px;border:1px solid var(--line);
    background:rgba(255,255,255,.035);color:var(--text);font:inherit;font-size:13.5px;outline:none}
  .modal-body input:focus{border-color:var(--line-hi);background:rgba(255,255,255,.06)}
  .modal-error{min-height:17px;margin-top:7px;color:#fca5a5;font-size:12px}
  .modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
  body.editing .empty.all-hidden{display:none}

  @media (max-width:760px){
    .admin-bar{margin-top:-8px}
    .admin-actions{width:100%;margin-left:0}
    .edit-status{text-align:left;margin-right:auto}
    .editor-grid{grid-template-columns:1fr}
  }

`;

function cardHtml(item) {
  const isNew = Boolean(item.isNew);
  const name = isNew ? 'New custom link' : displayName(item);
  const url = isNew ? '' : normalizeUrl(item.url);
  const host = isNew ? '' : domainKey(url);
  const editDomain = isNew ? '' : (item.editDomain || host);
  const st = statusInfo(item.status);
  const hay = (name + ' ' + host + ' ' + (item.source || '') + (isNew ? ' new custom link draft' : '')).toLowerCase();
  const customIcon = isNew ? '' : customIconHtml(item);
  const iconValue = isNew || item.icon == null ? '' : String(item.icon);
  const isHidden = Boolean(item.isHidden);
  const avatarContent = isNew
    ? '<span class="inits">+</span>'
    : customIcon || (
      '<span class="inits">' + esc(initials(name)) + '</span>'
      + '<img class="logo" alt="" referrerpolicy="no-referrer" data-srcs="' + esc(logoSources(item)) + '">'
    );
  const manualBadge = isNew
    ? '<span class="manual-badge draft-badge">Draft</span>'
    : item.custom ? '<span class="manual-badge">Manual</span>' : '';
  const hiddenBadge = '<span class="hidden-flag">Hidden</span>';
  const displayHost = isNew ? 'Enter a URL' : host;
  const editorKicker = isNew ? 'New custom link' : 'Card settings';
  const nameValue = isNew ? '' : name;
  const hideControl = isNew
    ? '<button type="button" class="remove-btn" data-remove-new title="Remove this draft">Remove</button>'
    : '<button type="button" class="hide-btn' + (isHidden ? ' is-off' : '') + '" data-hide'
      + ' aria-pressed="' + (isHidden ? 'true' : 'false') + '" title="' + (isHidden ? 'Show this card' : 'Hide this card') + '">'
      + '<svg class="eye-open" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8s-2.4 4.3-6.5 4.3S1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.35"/>'
      + '<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.35"/>'
      + '</svg>'
      + '<svg class="eye-off" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<path d="m2 2 12 12M6.3 4.1A6.9 6.9 0 0 1 8 3.7c4.1 0 6.5 4.3 6.5 4.3a11.4 11.4 0 0 1-2.1 2.5M9.7 11.9A6.9 6.9 0 0 1 8 12.3C3.9 12.3 1.5 8 1.5 8a11.4 11.4 0 0 1 2.1-2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>'
      + '</svg>'
      + '<span data-hide-label>' + (isHidden ? 'Show' : 'Hide') + '</span></button>';
  const newHint = isNew
    ? '<p class="new-hint">Name and URL are required. The URL hostname becomes the key in custom_links.json.</p>'
    : '';

  return '<div class="card-wrap' + (isNew ? ' is-new' : '') + (isHidden ? ' is-hidden' : '') + '"'
    + ' data-domain="' + esc(editDomain) + '"'
    + ' data-display-domain="' + esc(host) + '"'
    + ' data-name="' + esc(nameValue) + '"'
    + ' data-url="' + esc(url) + '"'
    + ' data-icon="' + esc(iconValue) + '"'
    + ' data-hidden="' + (isHidden ? '1' : '0') + '"'
    + ' data-original-hidden="' + (isHidden ? '1' : '0') + '"'
    + ' data-has-name="' + (item.hasCustomName ? '1' : '0') + '"'
    + ' data-has-url="' + (item.hasCustomUrl ? '1' : '0') + '"'
    + ' data-has-icon="' + (item.icon ? '1' : '0') + '"'
    + ' data-is-new="' + (isNew ? '1' : '0') + '"'
    + ' data-hay="' + esc(hay) + '">'
    + '<a class="card" href="' + esc(isNew ? '#' : url) + '" target="_blank" rel="noopener" title="' + esc(isNew ? 'New custom link' : host) + '"'
    + (isNew ? ' aria-disabled="true"' : '') + '>'
    + '<span class="avatar" style="background:' + gradientFor(name) + '">' + avatarContent + '</span>'
    + '<span class="body">'
    + '<span class="name-row"><span class="name">' + esc(name) + '</span>' + manualBadge + hiddenBadge + '</span>'
    + '<span class="host">' + esc(displayHost) + '</span>'
    + '</span>'
    + '<span class="tail">'
    + '<span class="pill ' + st.tone + '"><span class="dot"></span>' + esc(st.label) + '</span>'
    + '<svg class="arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M6 3h7v7M13 3 4.5 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>'
    + '</span>'
    + '</a>'
    + '<div class="editor" aria-label="Edit settings for ' + esc(name) + '">'
    + '<div class="editor-top"><span class="editor-kicker">' + editorKicker + '</span>' + hideControl + '</div>'
    + '<div class="editor-grid">'
    + '<label class="field"><span>Name</span><input type="text" data-field="name" value="' + esc(nameValue) + '" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Card name"></label>'
    + '<label class="field"><span>URL</span><input type="text" data-field="url" value="' + esc(url) + '" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://app.example.com"></label>'
    + '<label class="field field-wide"><span>Emoji or logo URL</span><input type="text" data-field="icon" value="' + esc(iconValue) + '" maxlength="8192" autocomplete="off" spellcheck="false" placeholder="🚀 or https://…"></label>'
    + '</div>'
    + newHint
    + '</div>'
    + '</div>';
}

const CLIENT_SCRIPT = String.raw`
(function(){
  'use strict';
  var body = document.body;
  var bar = document.getElementById('admin-bar');
  var adminEnabled = Boolean(bar && bar.getAttribute('data-admin-enabled') === '1');
  var editToggle = document.getElementById('edit-toggle');
  var saveButton = document.getElementById('save-links');
  var discardButton = document.getElementById('cancel-edits');
  var statusEl = document.getElementById('edit-status');
  var dialog = document.getElementById('admin-dialog');
  var form = document.getElementById('admin-form');
  var tokenInput = document.getElementById('admin-token');
  var adminError = document.getElementById('admin-error');
  var adminCancel = document.getElementById('admin-cancel');
  var addButton = document.getElementById('add-link');
  var grid = document.getElementById('grid');
  var newTemplate = document.getElementById('new-card-template');
  var toastEl = document.getElementById('toast');
  var adminToken = '';
  var toastTimer = null;
  var allowLeave = false;

  function showToast(message, tone) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = 'on' + (tone ? ' ' + tone : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = ''; }, tone === 'error' ? 6000 : 3500);
  }

  function initialsFor(name) {
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }

  function parseLinkUrl(value) {
    var raw = String(value || '').trim();
    if (!raw) return null;
    var candidate = /^https?:\/\//i.test(raw)
      ? raw
      : 'https://' + raw.replace(/^\/+/, '');
    var parsed;
    try {
      parsed = new URL(candidate);
    } catch (err) {
      return null;
    }
    if (!/^https?:$/i.test(parsed.protocol) || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(parsed.hostname)) {
      return null;
    }
    return {
      domain: parsed.hostname.replace(/^www\./i, '').toLowerCase(),
      url: candidate.replace(/\/+$/, '')
    };
  }

  function domainFromUrl(value) {
    var parsed = parseLinkUrl(value);
    return parsed ? parsed.domain : '';
  }

  function initLogos(root) {
    (root || document).querySelectorAll('img.logo').forEach(function(img){
      if (img.getAttribute('data-bound') === '1') return;
      img.setAttribute('data-bound', '1');
      var list = (img.getAttribute('data-srcs') || '').split('|').filter(Boolean);
      function next() {
        if (!list.length) {
          if (img.parentNode) img.parentNode.removeChild(img);
          return;
        }
        img.src = list.shift();
      }
      img.addEventListener('load', function(){ img.classList.add('on'); });
      img.addEventListener('error', next);
      next();
    });
  }

  function changeFor(wrap) {
    var nameInput = wrap.querySelector('[data-field="name"]');
    var urlInput = wrap.querySelector('[data-field="url"]');
    var iconInput = wrap.querySelector('[data-field="icon"]');
    if (!nameInput || !urlInput || !iconInput) return null;

    var isNew = wrap.getAttribute('data-is-new') === '1';
    var originalName = wrap.getAttribute('data-name') || '';
    var originalUrl = wrap.getAttribute('data-url') || '';
    var originalIcon = wrap.getAttribute('data-icon') || '';
    var hasName = wrap.getAttribute('data-has-name') === '1';
    var hasUrl = wrap.getAttribute('data-has-url') === '1';
    var hasIcon = wrap.getAttribute('data-has-icon') === '1';
    var hidden = wrap.getAttribute('data-hidden') === '1';
    var originalHidden = wrap.getAttribute('data-original-hidden') === '1';
    var nameValue = nameInput.value.trim();
    var urlValue = urlInput.value.trim();
    var iconValue = iconInput.value.trim();

    if (isNew) {
      if (!nameValue && !urlValue && !iconValue) return null;
      return {
        domain: domainFromUrl(urlValue),
        name: nameValue,
        url: urlValue,
        icon: iconValue
      };
    }

    var entry = null;

    function ensure() {
      if (!entry) entry = { domain: wrap.getAttribute('data-domain') || '' };
    }

    if (nameValue !== originalName) {
      if (nameValue || hasName) {
        ensure();
        entry.name = nameValue;
      }
    }
    if (urlValue !== originalUrl) {
      if (urlValue || hasUrl) {
        ensure();
        entry.url = urlValue;
      }
    }
    if (iconValue !== originalIcon) {
      if (iconValue || hasIcon) {
        ensure();
        entry.icon = iconValue;
      }
    }
    if (hidden !== originalHidden) {
      ensure();
      entry.hide = hidden;
    }
    return entry;
  }

  function collectChanges() {
    var changes = [];
    document.querySelectorAll('.card-wrap').forEach(function(wrap){
      var change = changeFor(wrap);
      if (change) changes.push(change);
    });
    return changes;
  }

  function updateDirty() {
    var changes = collectChanges();
    body.classList.toggle('has-edits', changes.length > 0);
    document.querySelectorAll('.card-wrap').forEach(function(wrap){
      wrap.classList.toggle('dirty', Boolean(changeFor(wrap)));
    });
    if (statusEl) {
      statusEl.textContent = changes.length
        ? changes.length + (changes.length === 1 ? ' unsaved change' : ' unsaved changes')
        : 'No unsaved changes';
    }
    if (saveButton) saveButton.disabled = changes.length === 0;
    return changes;
  }

  function validateChanges() {
    var wraps = document.querySelectorAll('.card-wrap');
    for (var i = 0; i < wraps.length; i += 1) {
      var wrap = wraps[i];
      var change = changeFor(wrap);
      if (!change) continue;
      var isNew = wrap.getAttribute('data-is-new') === '1';
      if (isNew && !change.name) {
        return { message: 'Enter a name for the new custom link.', wrap: wrap, field: 'name' };
      }
      if (isNew && !change.url) {
        return { message: 'Enter a URL for the new custom link.', wrap: wrap, field: 'url' };
      }
      if (change.url && !parseLinkUrl(change.url)) {
        return {
          message: 'Enter a valid http(s) URL. Example: https://app.example.com:8090',
          wrap: wrap,
          field: 'url'
        };
      }
    }
    return null;
  }

  function focusField(wrap, field) {
    if (!wrap || !field) return;
    var input = wrap.querySelector('[data-field="' + field + '"]');
    if (!input) return;
    if (wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function(){ input.focus(); }, 200);
  }

  function previewName(wrap) {
    var input = wrap.querySelector('[data-field="name"]');
    var nameEl = wrap.querySelector('.name');
    if (!input || !nameEl) return;
    var value = input.value.trim();
    var isNew = wrap.getAttribute('data-is-new') === '1';
    var host = wrap.getAttribute('data-display-domain') || '';
    var urlInput = wrap.querySelector('[data-field="url"]');
    var parsedUrl = urlInput ? parseLinkUrl(urlInput.value) : null;
    if (parsedUrl) host = parsedUrl.domain;
    nameEl.textContent = value || (isNew ? 'New custom link' : host);
    var hay = (value + ' ' + host + (isNew ? ' new custom link' : '')).toLowerCase();
    wrap.setAttribute('data-hay', hay);

    if (isNew) {
      var iconInput = wrap.querySelector('[data-field="icon"]');
      if (!iconInput || !iconInput.value.trim()) {
        var avatar = wrap.querySelector('.avatar');
        if (avatar) {
          avatar.innerHTML = '<span class="inits">' + initialsFor(value || 'New custom link') + '</span>';
        }
      }
    }
  }

  function previewUrl(wrap) {
    var input = wrap.querySelector('[data-field="url"]');
    var hostEl = wrap.querySelector('.host');
    if (!input || !hostEl) return;
    var value = input.value.trim();
    var isNew = wrap.getAttribute('data-is-new') === '1';
    var parsed = parseLinkUrl(value);
    if (!value) {
      hostEl.textContent = isNew ? 'Enter a URL' : (wrap.getAttribute('data-display-domain') || '');
    } else {
      hostEl.textContent = parsed ? parsed.domain : 'Invalid URL';
    }
    var nameInput = wrap.querySelector('[data-field="name"]');
    var nameValue = nameInput ? nameInput.value.trim() : '';
    var hay = (nameValue + ' ' + (parsed ? parsed.domain : '') + (isNew ? ' new custom link' : '')).toLowerCase();
    wrap.setAttribute('data-hay', hay);
  }

  function previewIcon(wrap) {
    var input = wrap.querySelector('[data-field="icon"]');
    var avatar = wrap.querySelector('.avatar');
    if (!input || !avatar) return;
    if (!avatar.getAttribute('data-original-html')) {
      avatar.setAttribute('data-original-html', avatar.innerHTML);
    }
    var original = avatar.getAttribute('data-original-html');
    var value = input.value.trim();
    var isNew = wrap.getAttribute('data-is-new') === '1';
    avatar.innerHTML = '';

    if (!value) {
      if (wrap.getAttribute('data-has-icon') === '1' || isNew) {
        var nameInput = wrap.querySelector('[data-field="name"]');
        var fallbackName = (nameInput && nameInput.value.trim())
          || wrap.getAttribute('data-name')
          || (isNew ? 'New custom link' : '');
        avatar.innerHTML = '<span class="inits">' + initialsFor(fallbackName) + '</span>';
      } else {
        avatar.innerHTML = original;
        initLogos(avatar);
      }
      return;
    }

    if (/^(https?:\/\/|data:image\/)/i.test(value)) {
      var img = document.createElement('img');
      img.className = 'custom-icon';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.src = value;
      img.addEventListener('error', function(){
        if (img.parentNode) img.parentNode.removeChild(img);
        avatar.innerHTML = original;
        initLogos(avatar);
      });
      avatar.appendChild(img);
    } else {
      var span = document.createElement('span');
      span.className = 'emoji';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = value;
      avatar.appendChild(span);
    }
  }

  function enterEditMode() {
    if (!adminEnabled) {
      showToast('Admin editing is disabled. Set ADMIN_TOKEN on the server.', 'error');
      return;
    }
    body.classList.add('editing');
    if (editToggle) {
      editToggle.setAttribute('aria-pressed', 'true');
      editToggle.textContent = 'Exit Edit Mode';
    }
    updateDirty();
  }

  function exitEditMode() {
    var changes = collectChanges();
    if (changes.length && !window.confirm('Discard unsaved changes?')) return;
    if (changes.length) {
      allowLeave = true;
      window.location.reload();
      return;
    }
    document.querySelectorAll('.card-wrap.is-new').forEach(function(node){ node.remove(); });
    body.classList.remove('editing');
    body.classList.remove('has-edits');
    adminToken = '';
    if (editToggle) {
      editToggle.setAttribute('aria-pressed', 'false');
      editToggle.textContent = 'Admin Edit Mode';
    }
    updateDirty();
  }

  function addNewCard() {
    if (!grid || !newTemplate || !newTemplate.content) {
      showToast('Could not open the new-link form.', 'error');
      return;
    }
    var existingDraft = grid.querySelector('.card-wrap.is-new');
    if (existingDraft) {
      focusField(existingDraft, 'name');
      showToast('Finish or remove the current new link first.', 'info');
      return;
    }
    var fragment = newTemplate.content.cloneNode(true);
    var node = fragment.querySelector('.card-wrap');
    if (!node) return;
    var avatar = node.querySelector('.avatar');
    if (avatar) avatar.setAttribute('data-original-html', avatar.innerHTML);
    grid.insertBefore(fragment, grid.firstChild);
    initLogos(node);
    updateDirty();
    focusField(node, 'name');
  }

  function saveChanges() {
    var changes = updateDirty();
    if (!changes.length) {
      showToast('No changes to save.', 'info');
      return;
    }
    var invalid = validateChanges();
    if (invalid) {
      showToast(invalid.message, 'error');
      focusField(invalid.wrap, invalid.field);
      return;
    }
    if (!adminToken) {
      openDialog();
      return;
    }
    if (!saveButton) return;
    var oldLabel = saveButton.textContent;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';

    fetch('/api/v1/custom-links', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + adminToken
      },
      body: JSON.stringify({ links: changes }),
      cache: 'no-store'
    }).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(data){
        if (!response.ok) {
          var error = new Error(data.error || ('Save failed (' + response.status + ')'));
          error.status = response.status;
          throw error;
        }
        return data;
      });
    }).then(function(data){
      allowLeave = true;
      adminToken = '';
      body.classList.remove('editing');
      var saved = data.updated || changes.length;
      var created = Number(data.created) || 0;
      var message = 'Saved ' + saved + ' change' + (saved === 1 ? '' : 's');
      if (created) message += ' · ' + created + ' new link' + (created === 1 ? '' : 's');
      showToast(message + '. Reloading…', 'ok');
      setTimeout(function(){ window.location.reload(); }, 350);
    }).catch(function(error){
      saveButton.disabled = false;
      saveButton.textContent = oldLabel;
      if (error.status === 401) {
        adminToken = '';
        showToast('Admin token was rejected. Enter it again.', 'error');
        openDialog();
      } else {
        showToast(error.message || 'Could not save changes.', 'error');
      }
    });
  }

  function openDialog() {
    if (!dialog || dialog.open) return;
    if (adminError) adminError.textContent = '';
    if (tokenInput) tokenInput.value = '';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    setTimeout(function(){ if (tokenInput) tokenInput.focus(); }, 30);
  }

  function closeDialog() {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  if (form) {
    form.addEventListener('submit', function(event){
      event.preventDefault();
      var value = tokenInput ? tokenInput.value.trim() : '';
      if (!value) {
        if (adminError) adminError.textContent = 'Enter the admin token to continue.';
        if (tokenInput) tokenInput.focus();
        return;
      }
      adminToken = value;
      if (adminError) adminError.textContent = '';
      closeDialog();
      enterEditMode();
    });
  }

  if (adminCancel) {
    adminCancel.addEventListener('click', function(){
      if (adminError) adminError.textContent = '';
      closeDialog();
    });
  }

  if (editToggle) {
    editToggle.addEventListener('click', function(){
      if (body.classList.contains('editing')) exitEditMode();
      else if (!adminEnabled) showToast('Admin editing is disabled. Set ADMIN_TOKEN on the server.', 'error');
      else if (!adminToken) openDialog();
      else enterEditMode();
    });
  }

  if (saveButton) saveButton.addEventListener('click', saveChanges);
  if (addButton) addButton.addEventListener('click', addNewCard);

  if (discardButton) {
    discardButton.addEventListener('click', function(){
      var changes = collectChanges();
      if (!changes.length) {
        exitEditMode();
        return;
      }
      if (!window.confirm('Discard unsaved changes?')) return;
      allowLeave = true;
      window.location.reload();
    });
  }

  document.addEventListener('input', function(event){
    var input = event.target;
    if (!input || !input.getAttribute || !input.getAttribute('data-field')) return;
    var wrap = input.closest('.card-wrap');
    if (!wrap) return;
    if (input.getAttribute('data-field') === 'name') previewName(wrap);
    if (input.getAttribute('data-field') === 'url') previewUrl(wrap);
    if (input.getAttribute('data-field') === 'icon') previewIcon(wrap);
    updateDirty();
  });

  document.addEventListener('click', function(event){
    var removeButton = event.target && event.target.closest
      ? event.target.closest('[data-remove-new]')
      : null;
    if (removeButton) {
      var draft = removeButton.closest('.card-wrap');
      if (draft) {
        event.preventDefault();
        draft.remove();
        updateDirty();
      }
      return;
    }

    var button = event.target && event.target.closest ? event.target.closest('[data-hide]') : null;
    if (!button) return;
    var wrap = button.closest('.card-wrap');
    if (!wrap) return;
    event.preventDefault();
    var hidden = wrap.getAttribute('data-hidden') !== '1';
    wrap.setAttribute('data-hidden', hidden ? '1' : '0');
    wrap.classList.toggle('is-hidden', hidden);
    button.classList.toggle('is-off', hidden);
    button.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    button.setAttribute('title', hidden ? 'Show this card' : 'Hide this card');
    var label = button.querySelector('[data-hide-label]');
    if (label) label.textContent = hidden ? 'Show' : 'Hide';
    updateDirty();
  });

  window.addEventListener('beforeunload', function(event){
    if (allowLeave || !body.classList.contains('editing')) return;
    if (!collectChanges().length) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.querySelectorAll('.card-wrap .avatar').forEach(function(avatar){
    avatar.setAttribute('data-original-html', avatar.innerHTML);
  });
  initLogos(document);

  var q = document.getElementById('q');
  if (q) {
    q.addEventListener('input', function(){
      var value = q.value.trim().toLowerCase();
      document.querySelectorAll('.card-wrap').forEach(function(card){
        var show = !value || (card.getAttribute('data-hay') || '').indexOf(value) > -1;
        card.classList.toggle('filtered', !show);
      });
    });
  }
})();
`;

function page(items = [], errors = [], options = {}) {
  const adminEnabled = Boolean(options.adminEnabled);
  const visibleCount = items.filter(item => !item.isHidden).length;
  const cards = items.map(cardHtml).join('');
  const newCardTemplate = '<template id="new-card-template">'
    + cardHtml({ isNew: true, url: '', status: 'manual', source: 'custom', custom: true })
    + '</template>';
  const warning = errors.length
    ? '<div class="notice"><strong>Coolify API warning</strong><span>' + errors.map(esc).join(' · ') + '</span></div>'
    : '';
  const hiddenHelp = adminEnabled
    ? 'Enable Admin Edit Mode to restore them.'
    : 'Set ADMIN_TOKEN on the server, then enable Admin Edit Mode to restore them.';
  const empty = items.length === 0
    ? '<div class="empty"><strong>No applications or links found</strong>Deploy something in Coolify or add an entry to custom_links.json.</div>'
    : visibleCount === 0
      ? '<div class="empty all-hidden"><strong>All cards are hidden</strong>' + hiddenHelp + '</div>'
      : '';
  const body = warning + cards + empty;

  const searchBar = !visibleCount ? '' :
    '<div class="search">'
    + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="m10.6 10.6 2.9 2.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input id="q" type="search" placeholder="Filter apps &amp; links" autocomplete="off" aria-label="Filter applications and links">'
    + '</div>';

  const subtitle = '<b>' + visibleCount + '</b> ' + (visibleCount === 1 ? 'app or link' : 'apps &amp; links') + (errors.length ? ' · API warning' : ' live');

  const adminBar = '<div class="admin-bar" id="admin-bar" data-admin-enabled="' + (adminEnabled ? '1' : '0') + '">'
    + '<div class="admin-copy"><strong>Admin</strong><span>'
    + (adminEnabled ? 'Edit card names, URLs, logos, and visibility, or add new links.' : 'Set ADMIN_TOKEN on the server to enable visual editing.')
    + '</span></div>'
    + '<button type="button" class="btn" id="edit-toggle" aria-pressed="false" title="'
    + (adminEnabled ? 'Unlock visual editing' : 'Set ADMIN_TOKEN on the server to enable editing')
    + '">Admin Edit Mode</button>'
    + '<div class="admin-actions">'
    + '<span class="edit-status" id="edit-status">No unsaved changes</span>'
    + '<button type="button" class="btn primary" id="save-links" disabled>Save Changes</button>'
    + '<button type="button" class="btn ghost" id="cancel-edits">Discard</button>'
    + '</div></div>';

  const adminDialog = '<dialog class="modal" id="admin-dialog">'
    + '<form class="modal-body" id="admin-form">'
    + '<h2>Unlock Admin Editor</h2>'
    + '<p>Enter the <code>ADMIN_TOKEN</code> configured on the server. It stays in memory for this page only.</p>'
    + '<input type="password" id="admin-token" autocomplete="off" spellcheck="false" placeholder="Admin token" aria-label="Admin token">'
    + '<div class="modal-error" id="admin-error"></div>'
    + '<div class="modal-actions">'
    + '<button type="button" class="btn ghost" id="admin-cancel">Cancel</button>'
    + '<button type="submit" class="btn primary">Unlock Editor</button>'
    + '</div></form></dialog>';

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
    + (adminEnabled ? '<button type="button" class="btn add-link" id="add-link" title="Add a new custom quick link">+ Add Custom Link</button>' : '')
    + '</header>'
    + adminBar
    + '<main class="grid" id="grid">' + body + '</main>'
    + newCardTemplate
    + '<footer>Live from Coolify · applications, services &amp; manual links</footer>'
    + adminDialog
    + '<div id="toast" role="status" aria-live="polite"></div>'
    + '</div>'
    + '<script>' + CLIENT_SCRIPT + '</script>'
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

const saveLinkBody = express.json({ limit: '256kb', type: 'application/json' });
app.post('/api/v1/custom-links', requireAdmin, saveLinkBody, handleCustomLinksSave);
app.put('/api/v1/custom-links', requireAdmin, saveLinkBody, handleCustomLinksSave);

app.get('/', async (req, res) => {
  const base = String(process.env.COOLIFY_INSTANCE_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.COOLIFY_API_TOKEN || '').trim();

  if (!base || !token) {
    return res.status(500).send(page([], ['COOLIFY_INSTANCE_URL and COOLIFY_API_TOKEN must be set'], {
      adminEnabled: adminEditingEnabled(),
    }));
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

  res.send(page(items, errors, { adminEnabled: adminEditingEnabled() }));
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('Coolify Web Directory running on port ' + PORT);
  });
}

module.exports = {
  app,
  adminEditingEnabled,
  asArray,
  cardHtml,
  customIconHtml,
  customLinkEntries,
  customLinksPath,
  dedupeItems,
  displayName,
  domainKey,
  extractDomains,
  fetchCoolifyJson,
  handleCustomLinksSave,
  isTruthyFlag,
  loadCustomLinks,
  logoSources,
  mergeItems,
  normalizeCoolifyItem,
  normalizeLinkUpdate,
  normalizeUrl,
  page,
  readCustomLinkEntries,
  requireAdmin,
  saveCustomLinkUpdates,
  statusInfo,
};