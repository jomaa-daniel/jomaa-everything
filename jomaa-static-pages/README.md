# jomaa-static-pages

Static websites, each served at its own hostname through the hub's Cloudflare
tunnel on jerry.

| Folder | Hostname |
|--------|----------|
| `sarah-portfolio/` | https://sarah.jomaa.org |

```
browser ── https ──▶ Cloudflare ── tunnel ──▶ jerry: serve.py on 127.0.0.1:8090
                                               picks the folder by Host (sites.json)
```

`serve.py` serves files only (no directory listings, no hidden files) to
hostnames listed in `sites.json`, and answers 404 for anything else.

## Edit the portfolio

Each artwork is one entry in `sarah-portfolio/artworks.js`. Put the image in
`sarah-portfolio/images/` and add an entry with its title, year, medium, size,
series and pixel width and height. The series filter buttons come from the
`series` values. The current images are generated sample art; swap them for
real photos or scans (JPEG or WebP, about 2000 px on the long side). Replace
the contact address `sarah@example.com` in `index.html`.

Preview locally:

```bash
python3 -m http.server 8765 --directory jomaa-static-pages/sarah-portfolio
```

## Publish

Jerry serves the copy in `~/jomaa-static-pages`. Copy changes there; the
server reads files on each request, so no restart is needed:

```bash
rsync -a --delete --exclude __pycache__ jomaa-static-pages/ jerry:jomaa-static-pages/
```

## Add a site

Add a folder with an `index.html` and a `"hostname": "folder"` line to
`sites.json`, copy to jerry as above, then on jerry run:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)   # needed for systemctl --user over SSH
python3 ~/jomaa-static-pages/setup_server.py --hub ~/jomaa-everything/jomaa-home-hub
```

It (re)starts the `jomaa-static-pages` user service, puts a tunnel rule for
each new hostname first in the hub's `tunnel.yml`, restarts
`jomaa-cloudflared`, and creates the DNS records. Rerunning is safe. The
tunnel restart drops `ssh jerry` sessions (they ride the same tunnel); rerun
the command after reconnecting if it was cut off before the DNS step.

```bash
systemctl --user status jomaa-static-pages
journalctl --user -u jomaa-static-pages -f
```

## Test

```bash
cd jomaa-static-pages && python3 -m unittest test_static_pages -v
```
