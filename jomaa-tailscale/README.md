# jomaa-tailscale

jerry on Tailscale: a subnet router for the home LAN (`192.168.1.0/24`) and an
exit node. No router ports are opened.

```
laptop/phone ── tailnet ──▶ jerry (tag:jerry) ──▶ 192.168.1.0/24     (admins only)
                                              └──▶ internet             (admins and family)
```

| Who | Reaches |
|-----|---------|
| Tailnet admins | Everything: the LAN, jerry, and the exit node |
| `group:family` | The internet through jerry's exit node, nothing else |

[`policy.json`](policy.json) is the tailnet policy. Terraform fills
`group:family` from `terraform.tfvars`, which is gitignored so emails stay out
of this public repo. The policy's `tests` block makes Tailscale reject any
version where family members can reach the router or jerry. jerry's route and
exit node are approved automatically through `autoApprovers`, and tagged
devices don't expire.

jerry forwards IPv4 and IPv6. NetworkManager handles IPv6 router
advertisements on jerry, so forwarding doesn't cost jerry its own IPv6 address.

## Set up

On the laptop, with a Tailscale account and an API key from the admin console
(Settings → Keys):

```bash
export TAILSCALE_API_KEY=tskey-api-...
cp jomaa-tailscale/terraform.tfvars.example jomaa-tailscale/terraform.tfvars   # add family emails
terraform -chdir=jomaa-tailscale init
terraform -chdir=jomaa-tailscale apply
```

`apply` writes the policy and issues a one-day, single-use auth key for jerry.
Hand the key to jerry, then run the setup there:

```bash
terraform -chdir=jomaa-tailscale output -raw jerry_auth_key \
  | ssh jerry 'mkdir -p ~/.local/share/jomaa-tailscale && umask 077 && cat > ~/.local/share/jomaa-tailscale/authkey'
ssh -t jerry python3 .local/share/jomaa-deploy/current/jomaa-tailscale/setup_server.py
```

The setup installs Tailscale from its Ubuntu repository, keeps IPv4 and IPv6
forwarding on in `/etc/sysctl.d/99-jomaa-tailscale.conf`, turns on UDP GRO forwarding
for faster forwarded traffic (kept on across reboots by
`/etc/NetworkManager/dispatcher.d/50-jomaa-tailscale-gro`), joins as `jerry` with
`tag:jerry` (reauthenticating if it was already logged in), advertises the LAN
and the exit node, and deletes the key file. It
asks for jerry's sudo password. Terraform state stays in `jomaa-tailscale/`
and is gitignored.

Each `apply` replaces a used or expired key, so rerunning both steps rejoins
jerry.

## Add someone

Add their email to `family` in `terraform.tfvars`, run `apply`, and invite them
from the admin console (Users → Invite users). On their device they turn on
Tailscale and pick **jerry** under Exit node.

## Check

```bash
ssh jerry tailscale status
tailscale ping jerry        # from a laptop away from home
ping 192.168.1.1            # the router, through jerry (admins)
```

## Remove it

On jerry: `sudo tailscale logout`, `sudo apt-get remove tailscale`, and delete
`/etc/sysctl.d/99-jomaa-tailscale.conf` and
`/etc/NetworkManager/dispatcher.d/50-jomaa-tailscale-gro`. On the laptop:
`terraform -chdir=jomaa-tailscale destroy`.

## Test

```bash
cd jomaa-tailscale && python3 -m unittest
```
