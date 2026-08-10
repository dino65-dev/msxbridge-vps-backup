function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    const base = String(process.env.NUVIO_MOVIEBOX_BRIDGE_URL || 'http://nuvio-moviebox-bridge:8090').replace(/\/$/, '');
    const token = process.env.NUVIO_MOVIEBOX_BRIDGE_TOKEN || '';
    const body = {
        tmdbId: String(tmdbId),
        mediaType: mediaType === 'series' ? 'tv' : mediaType,
        season: seasonNum == null ? null : Number(seasonNum),
        episode: episodeNum == null ? null : Number(episodeNum)
    };
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(`${base}/v1/streams`, {
        method: 'POST', headers, body: JSON.stringify(body)
    }).then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `MovieBox bridge HTTP ${response.status}`);
        const streams = Array.isArray(payload.streams) ? payload.streams : [];
        console.log(`[MovieBoxBridge] ${streams.length} stream(s) for ${body.mediaType}/${body.tmdbId}` + (body.mediaType === 'tv' ? ` S${body.season}E${body.episode}` : ''));
        return streams;
    }).catch(error => {
        console.error('[MovieBoxBridge] provider error:', error.message);
        return [];
    });
}

module.exports = { getStreams };
