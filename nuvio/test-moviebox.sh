#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${NUVIO_CONTAINER:-nuviostreams}"

echo "Testing MovieBox through Nuvio..."
echo

sudo docker exec \
  -i "$CONTAINER" \
  node <<'NODE'
const {
    getMovieBoxStreams
} = require(
    './providers/moviebox.js'
);

(async () => {
    const streams =
        await getMovieBoxStreams(
            '603',
            'movie'
        );

    console.log(
        'MovieBox streams:',
        streams.length
    );

    const hosts =
        new Map();

    for (const s of streams) {
        let host = '?';

        try {
            host =
                new URL(
                    s.url
                ).hostname;
        } catch {}

        console.log(
            String(
                s.quality || '?'
            ).padEnd(8),
            host
        );

        hosts.set(
            host,
            (hosts.get(host) || 0) + 1
        );
    }

    console.log();
    console.log('Hosts:');

    for (
        const [host, count]
        of hosts
    ) {
        console.log(
            `  ${host}: ${count}`
        );
    }

    if (streams.length === 0) {
        console.error();
        console.error(
            'ERROR: MovieBox returned 0 streams.'
        );

        process.exit(1);
    }

    console.log();
    console.log(
        'MovieBox bridge: PASS'
    );
})();
NODE
