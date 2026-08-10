# Nuvio MovieBox Bridge

This integration reuses MSXBridge's existing verified CloudStream compatibility sidecar and the pinned Phisher MovieBoxProvider instead of depending on the currently unreliable JavaScript MovieBox provider.

## Architecture

```text
NuvioStreamsAddon
    |
    | POST /v1/streams
    v
nuvio-moviebox-bridge:8090
    |
    | /v1/search -> /v1/details -> /v1/links
    v
cloudstream-compat:8082
    |
    v
MovieBoxProvider.cs3
    |
    v
MovieBox media links
```

The bridge is not published to the Internet. It joins `stremio-net` only so the Nuvio container can call it, while `cloudstream-compat` remains on the private MSXBridge network.

## VPS deployment

Ensure the existing `stremio-net` network exists, then run:

```bash
docker network inspect stremio-net >/dev/null

docker compose -f infra/compose.vps.yml \
  --profile cloudstream-compat \
  up --build -d cloudstream-plugin-init cloudstream-compat nuvio-moviebox-bridge
```

The local `.env` must contain:

```text
TMDB_API_KEY=<your key>
NUVIO_MOVIEBOX_BRIDGE_TOKEN=<long random token>
```

Do not commit `.env`.

## Health check

From any container on `stremio-net`:

```bash
docker run --rm --network stremio-net curlimages/curl \
  -fsS http://nuvio-moviebox-bridge:8090/healthz
```

## Install the provider into NuvioStreamsAddon

Copy `nuvio/MovieBoxBridgeProvider.js` into the Nuvio project:

```bash
cp /path/to/msxbridge-vps-backup/nuvio/MovieBoxBridgeProvider.js \
   /path/to/NuvioStreamsAddon/providers/moviebox-bridge.js
```

Then expose the bridge to the Nuvio container:

```text
NUVIO_MOVIEBOX_BRIDGE_URL=http://nuvio-moviebox-bridge:8090
NUVIO_MOVIEBOX_BRIDGE_TOKEN=<same token as MSXBridge .env>
```

The provider exports the same `getStreams(tmdbId, mediaType, seasonNum, episodeNum)` contract used by Nuvio providers.

### Quick direct provider test

Inside the Nuvio container:

```bash
node - <<'NODE'
const { getStreams } = require('./providers/moviebox-bridge.js');
getStreams('603', 'movie').then(streams => {
  console.log('MovieBoxBridge streams:', streams.length);
  console.log(streams.map(s => ({ name: s.name, quality: s.quality, host: new URL(s.url).hostname })));
});
NODE
```

For TV episodes:

```js
getStreams('<tmdb-id>', 'tv', 1, 1)
```

The bridge searches MovieBox by the TMDB title/year, selects the best matching MovieBox item, resolves the requested episode when applicable, and returns direct links plus required request headers.

## Nuvio addon integration

The existing Nuvio addon still needs to call this provider from its provider-fetch table. A typical import is:

```js
const { getStreams: getMovieBoxBridgeStreams } = require('./providers/moviebox-bridge.js');
```

and the provider function should call:

```js
const streams = await getMovieBoxBridgeStreams(
  tmdbId,
  tmdbTypeFromId,
  seasonNum,
  episodeNum
);
```

Keep these links on the direct-to-client path unless a particular returned host is proven to require server-side proxying. Preserve `stream.headers` through Stremio `behaviorHints.proxyHeaders.request`.

## Security

- The CloudStream `.cs3` remains hash-allowlisted and loaded only inside the constrained compatibility sidecar.
- The Nuvio bridge has no published host port.
- An optional bearer token protects `/v1/streams` even inside the Docker network.
- `TMDB_API_KEY` and bridge credentials stay in local `.env` files only.
