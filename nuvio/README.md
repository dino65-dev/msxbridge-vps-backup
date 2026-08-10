# Nuvio MovieBox Bridge

This integration reuses MSXBridge's existing verified CloudStream compatibility sidecar and the pinned Phisher MovieBoxProvider instead of depending on the unreliable JavaScript MovieBox provider.

## Flow

```text
NuvioStreamsAddon
  -> nuvio-moviebox-bridge:8090
  -> cloudstream-compat:8082
  -> MovieBoxProvider.cs3
  -> direct MovieBox stream URLs
```

The bridge is private: it has no published host port and is reachable by Nuvio only through `stremio-net`.

## Deploy

Ensure the local `.env` contains `TMDB_API_KEY` and `NUVIO_MOVIEBOX_BRIDGE_TOKEN`, then:

```bash
docker compose -f infra/compose.vps.yml --profile cloudstream-compat \
  up --build -d cloudstream-plugin-init cloudstream-compat nuvio-moviebox-bridge
```

Health check from `stremio-net`:

```bash
docker run --rm --network stremio-net curlimages/curl \
  -fsS http://nuvio-moviebox-bridge:8090/healthz
```

Copy `MovieBoxBridgeProvider.js` into the Nuvio project's `providers/` directory and give Nuvio these variables:

```text
NUVIO_MOVIEBOX_BRIDGE_URL=http://nuvio-moviebox-bridge:8090
NUVIO_MOVIEBOX_BRIDGE_TOKEN=<same value as MSXBridge .env>
```

The adapter exports Nuvio's normal `getStreams(tmdbId, mediaType, seasonNum, episodeNum)` contract and returns direct stream URLs plus required request headers.
