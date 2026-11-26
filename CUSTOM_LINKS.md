# Custom links and icon overrides

`custom_links.json` is merged with the applications and services discovered from the Coolify API.

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