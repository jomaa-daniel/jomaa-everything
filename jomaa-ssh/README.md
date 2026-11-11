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

Needs `openssh-server` and at least one key in `~/.ssh/authorized_keys`.

```bash
python3 jomaa-ssh/setup_server.py
```

This writes the sshd config and a host key to `~/.local/share/jomaa-ssh`
and starts the `jomaa-ssh` user service on loopback port 2222. It prints the
host key; `known_hosts` here must match it.

[`../jomaa-deploy/deploy.json`](../jomaa-deploy/deploy.json) declares the public
`ssh.jomaa.org` route. Repository deployment supplies its tunnel ingress and
DNS record. SSH provisioning manages the local sshd; it does not edit the
tunnel. See [`../jomaa-deploy/README.md`](../jomaa-deploy/README.md) for deployment
installation.

```bash
systemctl --user status jomaa-ssh
journalctl --user -u jomaa-ssh -f
```

## On each laptop

macOS or Linux:

```bash
python3 jomaa-ssh/setup_client.py
```

Windows (PowerShell, with the OpenSSH client built into Windows 10 and 11):

```powershell
powershell -ExecutionPolicy Bypass -File jomaa-ssh\setup_client.ps1
```

Each one gets `cloudflared` if it's missing: Homebrew on macOS, or on Linux
and Windows the release the hub uses, downloaded from GitHub and checked
against its SHA-256 digest (`~/.local/bin` on Linux, `%LOCALAPPDATA%\cloudflared`
on Windows). Then it pins jerry's host key from `known_hosts` and adds a
`jerry` entry at the top of `~/.ssh/config`. The laptop's SSH key must be in
jerry's `authorized_keys`; add one from home with
`ssh-copy-id jerry@192.168.1.239`.

Without the setup, any machine with `cloudflared` can connect in one line:

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" jerry@ssh.jomaa.org
```

## Remove it

On jerry: `systemctl --user disable --now jomaa-ssh`, delete
`~/.config/systemd/user/jomaa-ssh.service` and `~/.local/share/jomaa-ssh`,
remove the SSH route and external service from `jomaa-deploy/deploy.json`,
and push to `main` to remove the public ingress and managed DNS record. On a
laptop, delete the `jomaa-ssh` block from `~/.ssh/config`.

## Test

```bash
cd jomaa-ssh && python3 -m unittest
```
