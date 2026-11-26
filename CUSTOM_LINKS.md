# Custom links and icon overrides

`custom_links.json` is merged with the applications and services discovered from the Coolify API.

## File location

- **Local development:** `./custom_links.json`, next to `server.js`.
- **Docker Compose:** the project directory is mounted at `/app/data`, so the server reads `/app/data/custom_links.json`. Edit `custom_links.json` on the host and the container sees the change.
- **Override:** set `DATA_DIR` to read the file from a different directory. It defaults to `/app/data` when `NODE_ENV=production`, otherwise to the project directory.

## Matching

An entry matches an automated card when the hostname in `domain` matches the card's hostname.
`www.` is ignored, so `www.example.com` and `example.com` match each other.

- **Matching domain:** only the manual fields you provide (`name`, `url`, `icon`) override the automated card. Omitted fields keep the discovered values.
- **New domain:** a new `Manual` card is appended to the dashboard.

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
      "icon": "https://cdn.example.com/logo.png"
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

The file is read on every request, so edits take effect without restarting the server.