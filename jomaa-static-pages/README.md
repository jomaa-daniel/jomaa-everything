# jomaa-static-pages

Static websites and the hub's web device panel. Standalone sites are served at
their own hostnames through the hub's Cloudflare tunnel on jerry.

| Folder             | Hostname                |
| ------------------ | ----------------------- |
| `sarah.jomaa.org/` | https://sarah.jomaa.org |

## Device panel

`device-panel/` contains the web light controller at
https://jomaa.org/lights. It controls rooms with power, brightness, white
temperature, and color settings, and shares the hub's administrator sign-in.
The session stays signed in until it expires.

The screen fills the viewport from top to bottom:

- The top row shows the room name on the left and a dot for each device in
  the room on the right: filled for on, hollow for off, yellow after a
  command until that device reaches the requested state, and red when it
  is not answering. Short notes such as "1 of 2 on" or "last known" sit
  beside the dots.
- A round power button glows with the light's color or white temperature at
  its brightness.
- The remaining height is split evenly between a brightness slider, a
  warm-to-cool temperature track, and red, orange, green, pink, and two
  custom color circles. Each band names its control and shows its current
  value; brightness shows "Mixed" when the room's lit devices differ, and
  sliding it sets the whole room to one level. Each control fills its band.
- The bottom edge selects one room at a time. Without rooms, it lists
  devices.

The pencil on a custom circle opens a grid of colors; picking one saves it in
the browser and applies it. After a command the panel re-reads the hub about
once a second until every device confirms or ten seconds pass, then names
devices that didn't get there. It also re-reads the hub when it becomes
visible and every minute.

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
