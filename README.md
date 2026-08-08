# MSXBridge

MSXBridge is a server-driven bridge for older Samsung Tizen TVs running Media Station X (MSX). The television renders small MSX JSON pages and plays a signed, compatibility-ranked stream; the VPS handles everything expensive.

## Current implementation

The first vertical slice is runnable now:

- secure device enrollment and MSX Start Object generation;
- compact StreamFlix-inspired native MSX home, Movies, Series, Search, details, source and Continue Watching pages;
- SQLite watch state and capability profiles;
- signed direct/proxy playback-session URLs;
- internal playback decision/ranking contract;
- bounded upstream URL validation and media proxy with Range support;
- private admin API plus a minimal browser console;
- pinned MovieBox v26 CloudStream adapter, Caddy, FFmpeg and a non-public Linux compatibility worker.

MovieBox runs only in the private compatibility sidecar. The TV receives server-owned content IDs and signed playback URLs, never plugin classes, plugin preferences, provider credentials, or upstream media URLs. Configured Stremio addons remain an optional second resolver; `notWebReady` sources are proxied rather than discarded.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Use `POST /admin/devices` with the `x-admin-key` from `.env` to create a device. Enter the returned `startUrl` in MSX: **Settings → Start Parameter → Setup**. MSX requires HTTPS for a secure start parameter in production.

## Production deployment

Set `PUBLIC_DOMAIN` and `PUBLIC_BASE_URL` to the same HTTPS host, then set long random values for `ADMIN_API_KEY` and `TOKEN_HMAC_SECRET` before starting `infra/compose.yml`. Caddy deliberately exposes only `/healthz`, `/d/*`, `/play/*`, and `/subtitle/*`; its certificate key type is RSA-2048 for older clients. The admin API is intentionally not internet-routable and binds only to the VPS loopback interface at port 3000. Reach it through a private VPN listener or an SSH tunnel such as `ssh -N -L 3000:127.0.0.1:3000 user@vps`.

For a VPS already running the Lucas Lorentz Caddy Docker Proxy, use `infra/compose.vps.yml` instead. It adds the single public handler `https://dinmay.dpdns.org/msxbridge/*`, strips that prefix before proxying to the API, requests an RSA-2048 certificate key, and leaves the existing `/` service untouched. Its stable MSX start URL is `https://dinmay.dpdns.org/msxbridge/start.json`.

The optional `cloudstream-compat` Compose profile packages the `phisher98/cloudstream-desktop-unofficial` compatibility loader at pinned commit `5fdb86d`. Its production Compose file downloads exactly `MovieBoxProvider.cs3` v26 from `phisherrepo` and verifies SHA-256 `43e4593be338e8c1ebe10ab9043e19cb2c9b79e64dea2c40b5e38d6f84a344e9` before the sidecar starts. The loader copies those exact verified bytes into `/tmp/plugin-runtime` because its DEX/JAR conversion needs a writable directory; the source plugin volume remains read-only. The sidecar is constrained with no published ports, a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, PID/memory/CPU limits, and a hash allowlist.

```bash
docker compose -f infra/compose.vps.yml --profile cloudstream-compat up --build -d
```

The profile includes a controlled fixture endpoint for deployment verification. MovieBox is the only adapter enabled by the TV API; other `.cs3` archives remain inspection-only until an explicit adapter and hash review are added.

With the profile running, the private admin plane proxies only these internal checks: `GET /admin/cloudstream/health`, `POST /admin/cloudstream/plugins/inspect`, `POST /admin/cloudstream/plugins/execute`, and `POST /admin/cloudstream/fixtures/execute`. An operator-provided archive must already be present in the `cloudstream-plugins` volume and have its exact SHA-256 in `PLUGIN_ALLOWLIST_SHA256`; the API cannot upload an archive or weaken that gate.

## Samsung 2017 playback path

The private `POST /api/resolve` endpoint now creates an asynchronous source-resolution job. Poll `GET /api/resolve/:jobId` for early ranked sources and Samsung playback plans. Sources are deduplicated, probed with `ffprobe` when practical, and ranked as `direct`, `proxy`, `remux`, `transcode`, or `unsupported`.

`remux` and `transcode` plans are executed as signed HLS. Compatible H.264/AAC sources stay on the direct/proxy path at source resolution. Selected SRT, VTT, or ASS tracks are normalized to a signed UTF-8 SRT endpoint and attached to the native Samsung player with MSX's `tizen:subtitle:*` properties, so subtitles do not force video re-encoding. Sources provides fixed-offset timing controls from two seconds early to two seconds late. Unsupported video still uses the stable H.264/AAC HLS adaptation path without a subtitle filter. Manual burn-in remains available per title as a compatibility fallback and retains the one-TV transcode guard. **Samsung 2017 diagnostics** contains controlled MP4, HLS, native soft-SRT, and burned-in subtitle tests.

The supplied StreamFlix TV HTML reference is a standalone HTML5 demo rather than an MSX content object. Its off-black/red TV visual direction and clear remote-first labels are reflected in the native MSX interface, but its custom `<video>` player is intentionally not embedded because doing so would bypass Samsung AVPlay.

## License

GPL-3.0-or-later. This project is intended for content the operator owns or is authorized to access.
