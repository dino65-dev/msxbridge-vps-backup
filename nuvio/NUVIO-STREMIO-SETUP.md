# Nuvio + MovieBox CloudStream Bridge

This directory contains the working integration used to expose
CloudStream's MovieBox provider through a self-hosted Nuvio/Stremio
addon.

The bridge resolves MovieBox streams but does **not** relay the video
through the VPS.

## Architecture

```text
Stremio
   |
   v
Nuvio
   |
   | private Docker request
   v
nuvio-moviebox-bridge
   |
   v
cloudstream-compat
   |
   v
MovieBox CloudStream provider
   |
   v
MovieBox CDN URL
   |
   +----------------------+
                          |
                          v
                    returned to Stremio
                          |
                          v
                     TV / client
                          |
                          v
                    MovieBox CDN

The video should therefore normally travel:

```text
TV -> MovieBox CDN
```

not:

```text
TV -> VPS -> MovieBox CDN
```

## Important WARP workaround

Some Nuvio installations use `proxy-bootstrap.js` to globally route
Axios and `fetch()` through a Cloudflare WARP SOCKS proxy.

For example:

```text
socks5h://warp-proxy:1080
```

This causes a problem for private Docker traffic.

A request such as:

```text
http://nuvio-moviebox-bridge:8090
```

must NOT go through WARP.

Otherwise Nuvio fails with:

```text
Socks5 proxy rejected connection - HostUnreachable
```

`MovieBoxBridgeProvider.js` intentionally uses Node's native:

```js
http.request()
```

or:

```js
https.request()
```

for the Nuvio -> MovieBox bridge hop.

No proxy agent is used for this request.

This allows:

```text
Nuvio
    -> direct Docker network
    -> MovieBox bridge
```

while the rest of the Nuvio process can continue using the existing
WARP setup.

## Requirements

* Docker
* Docker Compose
* Node.js-based NuvioStreams addon
* `stremio-net` Docker network
* TMDB API key
* CloudStream compatibility worker
* MovieBox `.cs3` provider
* MovieBox bridge token

## Docker networks

Nuvio and the MovieBox bridge must both be connected to:

```text
stremio-net
```

Check:

```bash
sudo docker network inspect stremio-net \
  --format \
  '{{range $k,$v := .Containers}}{{println $v.Name}}{{end}}'
```

Example:

```text
infra-nuvio-moviebox-bridge-1
nuviostreams
mediaflow-proxy
warp-proxy
```

The Compose-generated container names may be different.

The preferred bridge hostname is the Compose service alias:

```text
nuvio-moviebox-bridge
```

so Nuvio uses:

```text
http://nuvio-moviebox-bridge:8090
```

rather than depending on a generated container name.

## Start the CloudStream bridge

From this repository:

```bash
sudo docker compose \
  -f infra/compose.vps.yml \
  --profile cloudstream-compat \
  up --build -d \
  cloudstream-plugin-init \
  cloudstream-compat \
  nuvio-moviebox-bridge
```

Check:

```bash
sudo docker ps \
  --format 'table {{.Names}}\t{{.Status}}' |
grep -E 'cloudstream|moviebox'
```

Typical names:

```text
infra-cloudstream-compat-1
infra-nuvio-moviebox-bridge-1
```

## Bridge health test

```bash
sudo docker run --rm \
  --network stremio-net \
  curlimages/curl \
  -fsS \
  http://nuvio-moviebox-bridge:8090/healthz
```

## Install into NuvioStreams

By default the installer expects:

```text
~/NuvioStreamsAddon
```

Run:

```bash
./nuvio/install-into-nuviostreams.sh
```

For a custom Nuvio location:

```bash
NUVIO_DIR=/path/to/NuvioStreamsAddon \
  ./nuvio/install-into-nuviostreams.sh
```

The installer:

1. backs up the existing MovieBox provider;
2. installs `MovieBoxBridgeProvider.js`;
3. reads the bridge token from this repository's `.env`;
4. writes the private bridge URL to `.nuvio-runtime.env`;
5. keeps AllWish and StreamFlix external repositories;
6. removes external MovieBox from the repo loader;
7. checks the `stremio-net` network.

## Rebuild Nuvio

Example:

```bash
cd ~/NuvioStreamsAddon

sudo docker build \
  -t nuviostreams .
```

Recreate your Nuvio container using the same Caddy/domain/network
configuration you normally use.

After recreation, connect Nuvio to:

```bash
sudo docker network connect \
  stremio-net \
  nuviostreams
```

Check:

```bash
sudo docker inspect nuviostreams \
  --format \
'{{range $n,$v := .NetworkSettings.Networks}}{{println $n}}{{end}}'
```

Expected:

```text
seafile-net
stremio-net
```

Your reverse-proxy network may have a different name.

## Test through Nuvio

The Matrix uses TMDB ID:

```text
603
```

Run:

```bash
./nuvio/test-moviebox.sh
```

A healthy result looks like:

```text
[MovieBoxBridge] 18 stream(s) for movie/603
MovieBox streams: 18
1080p   sacdn.hakunaymatata.com
1080p   hcdn3.hakunaymatata.com
...
MovieBox bridge: PASS
```

The exact number of streams and CDN hostnames can change.

## Stremio proxy headers

Some direct stream URLs require provider-specific HTTP headers.

The Nuvio Stremio stream object should preserve them using:

```js
const buildBehaviorHints = (stream) => {
    const hints = {
        notWebReady: true
    };

    const headers =
        stream &&
        stream.headers;

    if (
        headers &&
        typeof headers === 'object' &&
        Object.keys(headers).length > 0
    ) {
        hints.proxyHeaders = {
            request: headers
        };
    }

    return hints;
};
```

and the final Stremio stream mapping should use:

```js
behaviorHints:
    buildBehaviorHints(stream)
```

instead of discarding the provider headers.

A snapshot of the working Nuvio files used on the VPS is available
under:

```text
nuvio/working-nuvio/
```

These snapshots are intended primarily as reference because upstream
Nuvio code can change.

## External provider loader

The working setup also uses:

```text
Phisher -> AllWish
Yoru    -> StreamFlix
```

MovieBox is intentionally NOT loaded from those generic external
provider repositories.

MovieBox instead uses:

```text
Nuvio
 -> MovieBoxBridgeProvider.js
 -> CloudStream compatibility bridge
```

## MediaFlow / WARP

MovieBox CDN streams should normally stay direct.

Do NOT add MovieBox CDN hosts such as:

```text
hakunaymatata.com
```

to `MEDIAFLOW_PROXY_HOSTS` unless testing proves that a particular
MovieBox URL is IP-bound.

Desired path:

```text
Stremio -> MovieBox CDN
```

ShowBox/FebBox can still use the separate MediaFlow + WARP path when
required.

## Stremio manifest

MovieBox-only test:

```text
https://YOUR_DOMAIN/nuvio/region=IN1/providers=moviebox/manifest.json
```

Combined setup:

```text
https://YOUR_DOMAIN/nuvio/region=IN1/providers=moviebox,streamflix,allwish,showbox/manifest.json
```

Recommended practical preference:

```text
1. MovieBox 1080p
2. StreamFlix 1080p
3. MovieBox 720p
4. AllWish
5. ShowBox fallback
```

## Security

Never commit:

```text
.env
.nuvio-runtime.env
API keys
bridge tokens
device tokens
signed MovieBox URLs
signed FebBox URLs
```

The bridge is intentionally private and should not expose port 8090
publicly.

Only containers on the private Docker networks should be able to
reach it.
