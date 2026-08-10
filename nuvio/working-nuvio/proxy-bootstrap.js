const axios = require('axios');
const nodeFetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxyUrl =
    process.env.WARP_SOCKS ||
    'socks5h://warp-proxy:1080';

const agent = new SocksProxyAgent(proxyUrl);

/*
 * Axios -> WARP
 */
axios.defaults.proxy = false;
axios.defaults.httpAgent = agent;
axios.defaults.httpsAgent = agent;

/*
 * global fetch() -> WARP
 *
 * Yoru providers use fetch(), so Node's built-in fetch would
 * otherwise bypass our Axios SOCKS configuration.
 *
 * This replaces global fetch with node-fetch v2, which is
 * already a dependency of NuvioStreamsAddon.
 */
global.fetch = function(url, options = {}) {
    return nodeFetch(url, {
        ...options,
        agent
    });
};

console.log(
    `[proxy-bootstrap] Axios + fetch WARP SOCKS enabled: ${proxyUrl}`
);
