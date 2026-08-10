function hostMatches(host, base) {
    return (
        host === base ||
        host.endsWith('.' + base)
    );
}

function needsMediaFlow(stream) {
    if (!stream?.url) return false;

    const provider =
        String(
            stream.provider ||
            stream.name ||
            ''
        ).toLowerCase();

    /*
     * ShowBox / FebBox streams are commonly
     * tied to the IP which generated the URL.
     */
    if (provider.includes('showbox')) {
        return true;
    }

    let host = '';

    try {
        host =
            new URL(stream.url)
                .hostname
                .toLowerCase();
    } catch (_) {
        return false;
    }

    const configured =
        String(
            process.env.MEDIAFLOW_PROXY_HOSTS ||
            'shegu.net,febbox.com'
        )
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);

    return configured.some(
        base => hostMatches(host, base)
    );
}

function wrapWithMediaFlow(stream) {
    const base =
        String(
            process.env.MEDIAFLOW_PUBLIC_URL || ''
        ).replace(/\/+$/, '');

    const password =
        process.env.MEDIAFLOW_API_PASSWORD;

    if (
        !base ||
        !password ||
        !stream?.url
    ) {
        return stream;
    }

    /*
     * FAST PATH:
     * don't relay ordinary provider streams
     * through the VPS.
     */
    if (!needsMediaFlow(stream)) {
        return stream;
    }

    if (stream.url.startsWith(base + '/')) {
        return stream;
    }

    const original =
        String(stream.url);

    const isHls =
        /\.m3u8(?:\?|$)/i.test(original);

    const endpoint =
        isHls
            ? '/proxy/hls/manifest.m3u8'
            : '/proxy/stream';

    const params =
        new URLSearchParams();

    params.set('d', original);
    params.set(
        'api_password',
        password
    );

    const headers =
        stream.headers || {};

    for (
        const [rawKey, rawValue]
        of Object.entries(headers)
    ) {
        if (
            rawValue === undefined ||
            rawValue === null
        ) continue;

        const key =
            String(rawKey)
                .toLowerCase();

        if (key === 'referer') {
            params.set(
                'h_referer',
                String(rawValue)
            );
        }

        else if (key === 'origin') {
            params.set(
                'h_origin',
                String(rawValue)
            );
        }

        else if (key === 'user-agent') {
            params.set(
                'h_user-agent',
                String(rawValue)
            );
        }

        else if (key === 'cookie') {
            params.set(
                'h_cookie',
                String(rawValue)
            );
        }
    }

    return {
        ...stream,

        url:
            `${base}${endpoint}?` +
            params.toString(),

        /*
         * Headers are already encoded into
         * MediaFlow's URL, so Stremio should
         * not send them to MediaFlow itself.
         */
        headers: undefined
    };
}

module.exports = {
    wrapWithMediaFlow
};
