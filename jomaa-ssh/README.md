# jomaa-ssh

SSH into jerry from anywhere through the hub's Cloudflare tunnel, with no
open router ports:

```bash
ssh jerry
```

```
laptop ── ssh ──▶ cloudflared access ──▶ Cloudflare ── ssh.jomaa.org ──▶ tunnel on jerry
                                                                          │
                                                       sshd on 127.0.0.1:2222 (keys only)
```

The tunnel doesn't go to jerry's normal sshd on port 22, which also accepts
passwords. It goes to a second sshd that runs as `jerry`, listens only on
loopback, and accepts only the keys in `~/.ssh/authorized_keys`. Port 22 on
the home network is unchanged. Anyone who finds `ssh.jomaa.org` can reach
the login prompt, as with any SSH server on the internet, but without a key
they get no further.

## On jerry (once)

Needs the hub's native tunnel (`jomaa-home-hub/scripts/setup_native.py
--tunnel`) and at least one key in `~/.ssh/authorized_keys`.

```bash
python3 jomaa-ssh/setup_server.py
```

This writes the sshd config and a host key to `~/.local/share/jomaa-ssh`,
starts the `jomaa-ssh` user service (it comes back at boot), puts an
`ssh.jomaa.org` rule first in the tunnel's `data/native/tunnel.yml`, restarts
`jomaa-cloudflared`, and creates the DNS record. Rerunning is safe. It prints
the host key; `known_hosts` here must match it.

```bash
systemctl --user status jomaa-ssh
journalctl --user -u jomaa-ssh -f
```

## On each laptop

```bash
python3 jomaa-ssh/setup_client.py
```

Installs `cloudflared` with Homebrew if needed, pins jerry's host key from
`known_hosts`, and adds a `jerry` entry at the top of `~/.ssh/config`. The
laptop's SSH key must be in jerry's `authorized_keys`; add one from home
with `ssh-copy-id jerry@192.168.1.239`.

## Remove it

On jerry: `systemctl --user disable --now jomaa-ssh`, delete
`~/.config/systemd/user/jomaa-ssh.service` and `~/.local/share/jomaa-ssh`,
remove the `# jomaa-ssh` rule from `tunnel.yml`, restart
`jomaa-cloudflared`, and delete the `ssh` DNS record in Cloudflare. On a
laptop, delete the `jomaa-ssh` block from `~/.ssh/config`.

## Test

```bash
cd jomaa-ssh && python3 -m unittest
```
