# jomaa-static-pages

Static websites and the hub's web device panel. Standalone sites are served at
their own hostnames through the hub's Cloudflare tunnel on jerry.

| Folder | Hostname |
|--------|----------|
| `sarah.jomaa.org/` | https://sarah.jomaa.org |

## Device panel

`device-panel/` contains the web light controller at
https://jomaa.org/lights. It controls rooms and individual devices with
power, brightness, white temperature, and color settings. The fullscreen panel
has a sliding power switch, red and orange tiles, two custom color tiles,
10/50/75/100% brightness presets, and a warm-to-cool temperature bar. It shares the hub's
administrator sign-in and reports individual device failures.

The bottom row selects Living Room, Bedroom, or both. The existing controls
apply to those rooms, and selecting a room does not change its lights.
Clearing both selections disables the controls. The top picker selects one
room or device directly.

The hub serves this panel with its API. `jomaa-home-hub/scripts/build-web.mjs`
copies the panel and its styles into the hub build. Run
`npm run build` from `jomaa-home-hub/` after editing the panel. Changes to this
folder trigger hub verification and deployment through GitHub Actions.
The panel is part of the hub build and does not need a static site route.

```
browser ── https ──▶ Cloudflare ── tunnel ──▶ jerry: serve.py on 127.0.0.1:8090
                                               picks the hostname directory by Host
```

`serve.py` serves files only (no directory listings, no hidden files) to
hostnames discovered from its directory names, and answers 404 for anything else.
`/healthz` returns the server's health independently of the site hostname.

## Edit the portfolio

Each artwork is one entry in `sarah.jomaa.org/artworks.js`. Put the image in
`sarah.jomaa.org/images/` and add an entry with its title, year, medium, size,
series and pixel width and height. The series filter buttons come from the
`series` values. The current images are generated sample art; swap them for
real photos or scans (JPEG or WebP, about 2000 px on the long side). Replace
the contact address `sarah@example.com` in `index.html`.

Preview locally:

```bash
python3 -m http.server 8765 --directory jomaa-static-pages/sarah.jomaa.org
```

## Publish and add sites

Verified pushes to `main` discover hostname directories, deploy their files,
restart the static server, and create the tunnel routes and DNS records.

To publish `new.jomaa.org`, add its files under:

```text
jomaa-static-pages/new.jomaa.org/index.html
jomaa-static-pages/new.jomaa.org/gallery/index.html
```

Push the new directory to `main`. Folder names define the hostnames, and each
site's files define its URL paths. The example also publishes
`https://new.jomaa.org/gallery/`. Removing a hostname directory removes its
public route and managed DNS record at the next deployment.

The static server and deployer use the same directory discovery. Hostname
directories require an `index.html`. Support folders such as `device-panel/`
are excluded. See [`../jomaa-deploy/README.md`](../jomaa-deploy/README.md) for
receiver installation and infrastructure configuration.

```bash
systemctl --user status jomaa-static-pages
journalctl --user -u jomaa-static-pages -f
```

## Test

```bash
cd jomaa-static-pages && python3 -m unittest test_static_pages -v
```
