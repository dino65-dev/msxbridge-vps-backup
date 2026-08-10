const http = require('node:http');
const https = require('node:https');

function requestJson(urlString, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);

        const client =
            url.protocol === 'https:'
                ? https
                : http;

        const body =
            options.body
                ? JSON.stringify(options.body)
                : null;

        const headers = {
            'content-type': 'application/json',
            ...(options.headers || {})
        };

        if (body) {
            headers['content-length'] =
                Buffer.byteLength(body);
        }

        const req = client.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port:
                    url.port ||
                    (
                        url.protocol === 'https:'
                            ? 443
                            : 80
                    ),
                path:
                    url.pathname +
                    url.search,
                method:
                    options.method ||
                    'GET',
                headers,

                /*
                 * IMPORTANT:
                 *
                 * No proxy agent here.
                 * This is intentional.
                 *
                 * The Nuvio process globally
                 * routes fetch() through WARP,
                 * but this bridge lives inside
                 * Docker and must be contacted
                 * directly.
                 */
                agent: false
            },
            res => {
                const chunks = [];

                res.on(
                    'data',
                    chunk => chunks.push(chunk)
                );

                res.on(
                    'end',
                    () => {
                        const text =
                            Buffer.concat(chunks)
                                .toString('utf8');

                        let payload = {};

                        try {
                            payload =
                                text
                                    ? JSON.parse(text)
                                    : {};
                        } catch {
                            return reject(
                                new Error(
                                    `MovieBox bridge returned invalid JSON: ${text.slice(0, 200)}`
                                )
                            );
                        }

                        if (
                            res.statusCode < 200 ||
                            res.statusCode >= 300
                        ) {
                            return reject(
                                new Error(
                                    payload.error ||
                                    `MovieBox bridge HTTP ${res.statusCode}`
                                )
                            );
                        }

                        resolve(payload);
                    }
                );
            }
        );

        req.setTimeout(
            30000,
            () => {
                req.destroy(
                    new Error(
                        'MovieBox bridge timeout'
                    )
                );
            }
        );

        req.on('error', reject);

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

async function getStreams(
    tmdbId,
    mediaType,
    seasonNum,
    episodeNum
) {
    const base =
        String(
            process.env.NUVIO_MOVIEBOX_BRIDGE_URL ||
            'http://nuvio-moviebox-bridge:8090'
        ).replace(/\/+$/, '');

    const token =
        process.env
            .NUVIO_MOVIEBOX_BRIDGE_TOKEN ||
        '';

    const body = {
        tmdbId: String(tmdbId),

        mediaType:
            mediaType === 'series'
                ? 'tv'
                : mediaType,

        season:
            seasonNum == null
                ? null
                : Number(seasonNum),

        episode:
            episodeNum == null
                ? null
                : Number(episodeNum)
    };

    const headers = {};

    if (token) {
        headers.authorization =
            `Bearer ${token}`;
    }

    try {
        const payload =
            await requestJson(
                `${base}/v1/streams`,
                {
                    method: 'POST',
                    headers,
                    body
                }
            );

        const streams =
            Array.isArray(
                payload.streams
            )
                ? payload.streams
                : [];

        console.log(
            `[MovieBoxBridge] ${streams.length} stream(s) for ${body.mediaType}/${body.tmdbId}` +
            (
                body.mediaType === 'tv'
                    ? ` S${body.season}E${body.episode}`
                    : ''
            )
        );

        return streams;
    } catch (error) {
        console.error(
            '[MovieBoxBridge] provider error:',
            error.message
        );

        return [];
    }
}

async function getMovieBoxStreams(
    tmdbId,
    mediaType,
    seasonNum,
    episodeNum
) {
    return getStreams(
        tmdbId,
        mediaType,
        seasonNum,
        episodeNum
    );
}

module.exports = {
    getStreams,
    getMovieBoxStreams
};
