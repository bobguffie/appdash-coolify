# Custom links and icon overrides

`custom_links.json` is merged with the applications and services discovered from the Coolify API.

The dashboard also includes a visual editor. Set `ADMIN_TOKEN` on the server, open the dashboard, click **Admin Edit Mode**, and enter that token. You can rename cards, change their destination URL, replace their emoji/logo, hide or restore them, add brand-new quick links, and save without editing JSON by hand.

## File location

- **Local development:** `./custom_links.json`, next to `server.js`.
- **Docker Compose:** the `app_data` named volume is mounted at `/app/data`. The image's `custom_links.json` seeds the volume on first start, and the server reads and writes `/app/data/custom_links.json`. Docker manages the volume's permissions, so this works even when the Coolify host directory is locked.
- **Host-visible data (optional):** replace `app_data:/app/data:rw` with `./data:/app/data:rw` and make the dedicated `data/` directory writable by the container user. Do not bind-mount the whole project root; deployment platforms can make that directory read-only.
- **Override:** set `DATA_DIR` to read the file from a different directory. It defaults to `/app/data` when `NODE_ENV=production`, otherwise to the project directory.

The image creates `/app/data` with mode `777`, and `docker-entrypoint.sh` re-applies permissions at container startup. This second step matters because runtime mounts replace the directory permissions baked into the image. If a host mount is explicitly read-only, no `chmod` can fix it; use the named volume or make the mount writable.

To inspect or back up the persisted JSON in the Compose deployment:

```sh
docker compose exec app ls -ld /app/data /app/data/custom_links.json
docker compose exec app cat /app/data/custom_links.json
```

The named volume is runtime state, not the repository copy of `custom_links.json`. Use the command above if you want to export a snapshot to commit.

## Visual editor

1. Set `ADMIN_TOKEN` to a long random value in `.env` / the Coolify environment.
2. Open the dashboard and click **Admin Edit Mode**.
3. Enter the token when prompted. It is kept in page memory only and is never written to local storage.
4. Use the eye button to hide/show a card, edit the **Name**, **URL**, or **Emoji or logo URL** fields. Editing **URL** changes the destination (for example, remove a port such as `:8090` from a discovered app).
5. Click **+ Add Custom Link** in the header to open a blank draft card. Enter a **Name** and **URL**; the **Emoji or logo URL** is optional. The URL hostname becomes the entry key in `custom_links.json`.
6. Click **Save Changes**. The API writes the file and the page reloads immediately. New links are appended; existing links are updated in place.

Hidden cards stay visible while edit mode is active, so you can restore them. If `ADMIN_TOKEN` is unset, the write endpoint is disabled and the dashboard shows that editing is unavailable.

## Matching

An entry matches an automated card when the hostname in `domain` matches the card's hostname.
`www.` is ignored, so `www.example.com` and `example.com` match each other.

- **Matching domain:** only the manual fields you provide (`name`, `url`, `icon`, `hide`) override the automated card. Omitted fields keep the discovered values.
- **New domain:** a new `Manual` card is appended to the dashboard.
- **Hidden entry:** `"hide": true` removes the card from the normal view. It remains available in Admin Edit Mode.

## Format

```json
{
  "links": [
    {
      "domain": "apps.example.com",
      "name": "App Dashboard",
      "url": "https://apps.example.com",
      "icon": "🚀"
    },
    {
      "domain": "example.com",
      "name": "Example",
      "url": "https://example.com",
      "icon": "https://cdn.example.com/logo.png",
      "hide": true
    }
  ]
}
```

`icon` can be:

- an emoji or short text marker, e.g. `"🚀"`
- a direct image URL, e.g. `"https://cdn.example.com/logo.png"`
- a data URI, e.g. `"data:image/svg+xml;base64,..."`

`url` is optional; when omitted it defaults to `https://<domain>`.

Aliases accepted for convenience:

| Field | Aliases |
|-------|---------|
| `domain` | `host` |
| `name` | `title` |
| `url` | `link` |
| `icon` | `logo`, `emoji` |

## API endpoint

The visual editor uses `POST` or `PUT /api/v1/custom-links`.

Authentication: `Authorization: Bearer <ADMIN_TOKEN>` (or `X-Admin-Token`).

```json
{
  "links": [
    { "domain": "apps.example.com", "name": "App Dashboard", "url": "https://apps.example.com", "icon": "🚀", "hide": false },
    { "url": "https://new.example.com:8090", "name": "New App", "icon": "🛠️" }
  ]
}
```

- Updates are matched by domain and merged into the existing file; entries not included are preserved.
- New domains are appended as new manual cards. If `domain` is omitted, it is derived from `url`.
- An empty `name`, `url`, or `icon` removes that override.
- `hide: false` removes the hidden flag.
- The response includes `updated`, `created`, and `links` counts.
- Requests return `401` for a bad token, `503` when `ADMIN_TOKEN` is not configured, and `400` for invalid input.

Use HTTPS in production so the token is not sent in clear text.

The file is read on every request, so edits take effect without restarting the server.