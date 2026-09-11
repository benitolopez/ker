# Deploy ker for one user

> **Nothing here has been tested.** No part of this runbook has been run on a real machine:
> not the VPS setup, not Tailscale, not Docker or nginx. It was written from how ker behaves in
> code and in its automated tests, which cover authentication and both execution modes but never
> touch a server, a proxy, or a phone. Package names, paths, flags, and versions may be wrong,
> and steps may be missing. Treat it as a description of how the deployment is meant to work and
> expect to debug it. The checklist at the end is what would make it verified.

This setup puts the control plane on a VPS, Caddy in front of it, the execution node on your
laptop, and the GUI in your laptop and phone browsers. ker listens on loopback; Caddy handles
certificates and TLS. It is one machine without a WAF or a DDoS shield. Every paired device has
full access to this single-user deployment.

## 1. Prepare the VPS

Use a supported Debian or Ubuntu LTS installation with a non-root administrator who can use
`sudo` and already signs in with an SSH key. Keep that SSH session open until a second key-only
login succeeds. The commands assume SSH on port 22; substitute your actual SSH port if different.

```sh
sudo apt update
sudo apt install git curl ca-certificates ufw unattended-upgrades caddy
sudo tee /etc/ssh/sshd_config.d/00-ker.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
sudo sshd -t
sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication'
sudo systemctl reload ssh
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo dpkg-reconfigure -plow unattended-upgrades
```

Confirm the effective SSH settings match the snippet before closing your original connection. Allow the same ports in
the provider firewall, and keep 5537 closed externally. See Ubuntu's [OpenSSH configuration
guide](https://ubuntu.com/server/docs/how-to/security/openssh-server/), [firewall
guide](https://documentation.ubuntu.com/server/how-to/security/firewalls/index.html), and
[automatic updates guide](https://ubuntu.com/server/docs/how-to/software/automatic-updates/).

## 2. Point DNS at the VPS

Create an `A` record for `ker.example.com` pointing to the VPS IPv4 address. Publish an `AAAA`
record only if IPv6 also reaches this VPS. Substitute your real hostname throughout this guide.

## 3. Configure Caddy

The distro package installs the service. If your distro does not provide Caddy, use its
[official Debian/Ubuntu package instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
On a fresh Caddy installation, write `/etc/caddy/Caddyfile` as follows. Add this site to the
existing file instead if the proxy already hosts other sites.

```sh
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
ker.example.com {
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:5537
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy obtains and renews a publicly trusted certificate and redirects HTTP to HTTPS. Its
[automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https) describes DNS and
port requirements. Its [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
preserves `Host` for this HTTP upstream, supports WebSocket upgrades, and flushes SSE responses
immediately. Do not rewrite `Host` to `127.0.0.1`.

## 4. Install ker under its own user

Install Node 24 and npm system-wide using the [Node download instructions](https://nodejs.org/en/download).
The service uses `/usr/local/bin:/usr/bin:/bin`; a Node installation visible only in your
interactive shell will not be found. Verify the runtime in that path:

```sh
env PATH=/usr/local/bin:/usr/bin:/bin node --version
env PATH=/usr/local/bin:/usr/bin:/bin npm --version
sudo useradd --create-home --shell /bin/bash ker
sudo install -d -o ker -g ker /opt/ker
sudo -H -u ker git clone https://github.com/benitolopez/ker.git /opt/ker
sudo -H -u ker /bin/sh -c 'cd /opt/ker && npm ci && npm run build'
sudo tee /usr/local/bin/ker >/dev/null <<'EOF'
#!/bin/sh
exec /usr/bin/env node /opt/ker/packages/cli/dist/cli.js "$@"
EOF
sudo chmod 755 /usr/local/bin/ker
```

This is a source checkout: the workspace packages are not published on npm yet. Keep the full
checkout and its dependencies in place. Use a revision containing remote authentication.
The build produces the GUI assets served by ker; a missing GUI build returns a build hint.

## 5. Start the control plane with systemd

```sh
sudo tee /etc/systemd/system/ker.service >/dev/null <<'EOF'
[Unit]
Description=ker control plane
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ker
Group=ker
WorkingDirectory=/opt/ker
Environment=HOME=/home/ker
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/ker server --public-url https://ker.example.com
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now ker
sudo journalctl -u ker -n 30 --no-pager
curl --fail https://ker.example.com/health
curl -i https://ker.example.com/projects
```

Health should include `"auth":"device"`; the unauthenticated projects request should return
401. Health checks may use GET or HEAD on `/health`.
The default bind is `127.0.0.1:5537`. The catalog and canonical sessions live in
`/home/ker/.ker`. Provider credentials belong on the execution node; the split server does not
need an API key or provider login.

`server` and `daemon` accept `--host`, `--port`, and `--public-url`; their environment fallbacks
are `KER_HOST`, `KER_PORT`, and `KER_PUBLIC_URL`. Flags win. The public URL must be an HTTPS
origin with no credentials, path, query, or fragment. A trailing `/` is accepted. Without a
public URL, only a loopback bind is allowed and ker uses local process trust.

## 6. Pair the first browser

Run on the VPS as the service user, after the server has started:

```sh
sudo -H -u ker /usr/local/bin/ker pair
```

Open the printed link in your laptop browser, name the device, and choose **Pair this device**.
The link is single-use and expires in 15 minutes. Its code is in the URL fragment, so normal
HTTP access logs do not contain it. Treat the link as a credential while it is valid.

ker stores a hash of each random device token. The browser receives an HttpOnly, Secure,
SameSite=Strict cookie lasting up to 400 days, refreshed when Devices is listed. All private
API calls require that cookie or an `Authorization: Bearer <token>` header. Cookie writes also
require the matching public `Origin`. The shell, assets, health, OpenAPI description, pairing
claim, and node socket upgrade remain public; the socket authenticates its first frame.

Open the public HTTPS URL even from the VPS. A direct request to the loopback URL has the
wrong `Host` and returns 403. `ker pair` reads the catalog directly, so it needs no HTTP token.
If you override `KER_CATALOG_PATH`, use the same value for the service and the pairing command.

## 7. Pair the phone

In the laptop GUI, open **Devices → Pair device** and scan the QR with the phone. Open the
link in the browser you intend to use for ker, give it a name, and pair. Both browsers should
list the devices and label their own row **This device**. Each browser profile is a separate
device. Already-paired browsers can continue without consuming a new link.

## 8. Enroll the laptop node

Install this ker revision and Node 24 on the laptop, then configure its provider credential
as described in [the README](../README.md#authentication). In the paired GUI choose
**Nodes → Enroll node** and run the displayed command from the laptop checkout:

```sh
npx ker node --server https://ker.example.com --token <token-from-the-GUI>
```

The node connects over `wss` through Caddy. The returned secret and server URL are stored in
`~/.ker/node.json`; subsequent starts need only `npx ker node`. Run one node process per node
identity and spool directory. Use **Add folder** in the GUI to register a checkout on that
node, then create a session for that folder.

Public certificates require no extra setup. A private CA requires
`NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem` in the node process environment; never disable
certificate verification. Details are in [the node protocol](node-protocol.md).

CLI prompt, monitor, and session commands still target a local-trust server on loopback.
Use the GUI to drive this remote deployment.

## 9. Revoke or recover access

Devices → Revoke asks for confirmation. A revoked browser gets 401 on its next API request
and sees the not-paired screen; self-revocation also clears its cookie. An already-open event
stream is not forcibly disconnected. Node revocation in Nodes closes its active socket and
refuses later authentication.

If every browser is lost or revoked, run `sudo -H -u ker /usr/local/bin/ker pair` on the VPS
again. This is the same bootstrap path, with no shared password or recovery token to manage.

## 10. Back up the state

Back up `/home/ker/.ker` nightly and before every upgrade, and copy the result off the VPS.
For a consistent copy of the SQLite catalog and session logs, stop ker while taking it:

```sh
sudo install -d -m 700 /var/backups/ker
KER_BACKUP="/var/backups/ker/state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sudo systemctl stop ker
sudo tar -C /home/ker -czf "$KER_BACKUP" .ker
sudo chmod 600 "$KER_BACKUP"
sudo systemctl start ker
```

Configure your backup system to schedule this and transfer the archive to private off-machine
storage. Include custom catalog/session locations if you changed the defaults. Retain the
service unit, Caddyfile, and installed Git revision with each backup. A project export is useful
for moving projects but does not back up device credentials or deployment settings.

## 11. Upgrade and roll back

Take and verify the backup above **before opening the catalog with new code**. Stop ker, update
the checkout, install and build as its user, then start it:

```sh
sudo systemctl stop ker
sudo -H -u ker git -C /opt/ker pull --ff-only
sudo -H -u ker /bin/sh -c 'cd /opt/ker && npm ci && npm run build'
sudo systemctl start ker
sudo journalctl -u ker -n 30 --no-pager
curl --fail https://ker.example.com/health
```

The catalog migrates automatically from v4 to v5. This migration renames `enrollment_token` to
`one_time_token`, adds its token kind, and adds device and setting tables. Existing enrollment
tokens remain node tokens. Protocol is v26; store v6 and node protocol v1 are unchanged.

**Rollback requires the pre-upgrade catalog backup.** v4 refuses a v5 catalog and expects the
old table name. Stop ker, retain a separate copy of the current state, restore the pre-upgrade
state and code revision, reinstall/build, and start. Never lower `user_version` on the migrated
database. Restoring the whole state backup also discards work performed after that backup.
Upgrade the GUI and client with the server to keep protocol versions aligned.

## 12. Laptop-only variant with Tailscale

Install Tailscale on the laptop and phone, connect them to the same tailnet, and enable tailnet
HTTPS certificates. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
exposes the local service only inside the tailnet:

```sh
tailscale serve --bg 5537
tailscale serve status
npx ker daemon --public-url https://<machine>.<tailnet>.ts.net
```

Use the exact HTTPS origin printed by Serve as `--public-url`, then run `npx ker pair` in
another terminal under the same OS user. Pair the phone as above. Serve's [`--bg` mode](https://tailscale.com/docs/reference/tailscale-cli/serve)
persists across Tailscale restarts; the ker daemon still needs its own running process. This
variant has no public internet endpoint. The laptop must remain awake for work to execute.

## 13. Docker and nginx variants

In Docker, bind ker to `0.0.0.0` inside its container with the same `--public-url`. Put Caddy in
a sibling container on a private network and proxy to `ker:5537`. Publish only Caddy's ports;
persist ker's catalog and sessions and Caddy's certificate data in volumes. `ker pair` must run
inside the ker container with the service user's home and catalog path.

For nginx, configure your certificate and HTTPS server first. Use this location inside that
server block; preserve the public host, disable SSE buffering, and forward WebSocket headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:5537;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

`$http_host` retains an explicit port when the public origin uses one; `$host` also works for
the standard `https://ker.example.com` origin. See nginx's [WebSocket proxy
guide](https://nginx.org/en/docs/http/websocket.html) and [buffering directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering).

## Troubleshooting and live acceptance

- **403 forbidden:** check the public URL, proxy `Host`, and browser `Origin`. ker ignores
  forwarded-host headers and does not grant remote requests trust because the proxy is local.
- **401 unauthorized:** pair this browser, or check whether its device was revoked. Test
  `/health` to distinguish an authentication problem from an unreachable server.
- **No catalog at <path>; start the server first:** run `ker pair` as the service user with
  the same catalog path, after the server's first start. Pairing does not create a missing catalog.
- **Pairing needs a server started with --public-url:** start remote mode first and run
  `ker pair` under the service user with the same catalog path.
- **502 from Caddy:** check `systemctl status ker` and its journal; confirm the upstream port.
- **No live updates or node offline:** check SSE buffering and WebSocket upgrade forwarding.

Complete these on the real deployment before treating the runbook as verified:

- [ ] Pair the laptop, QR-pair the phone, and check **This device** on each.
- [ ] Enroll the node over `wss`, add a folder, and start and drive a session from the phone.
- [ ] Close and reopen the laptop lid mid-turn; confirm reconnect and transcript recovery.
- [ ] Restart ker on the VPS mid-turn; confirm the node finishes and drains its spool.
- [ ] Revoke the phone, observe the not-paired screen, and pair it again through `ker pair`.
- [ ] Export and import while the node is offline; check Stop, Compact, export/import, and
  Add folder at phone width.
- [ ] Correct any deployment command that needed adjustment and exercise backup restoration.
