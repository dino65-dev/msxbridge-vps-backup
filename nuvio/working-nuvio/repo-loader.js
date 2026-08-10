const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CACHE_DIR = '/app/.provider_repos';
const REFRESH_MS = 6 * 60 * 60 * 1000;

let cachedProviders = [];
let lastRefresh = 0;
let loadingPromise = null;

function safeName(v) {
    return String(v || 'provider')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_');
}

function getRepos() {
    return String(process.env.NUVIO_REPOS || '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => x.endsWith('/') ? x : x + '/');
}


function getProviderAllowlist() {
    const raw = String(
        process.env.NUVIO_REPO_PROVIDERS || ''
    );

    return new Set(
        raw
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
            .map(x => safeName(x))
    );
}

async function loadModule(filename, source) {
    const isESM =
        /^\s*import\s/m.test(source) ||
        /^\s*export\s/m.test(source);

    if (isESM) {
        const mjs = filename.replace(/\.js$/, '.mjs');

        /*
         * React-Native Nuvio providers often use
         * cheerio-without-node-native.
         * On our normal Node server, use standard cheerio.
         */
        source = source
            .replace(
                /import\s+cheerio\s+from\s+["']cheerio-without-node-native["'];?/g,
                'import * as cheerio from "cheerio";'
            )
            .replace(
                /from\s+["']cheerio-without-node-native["']/g,
                'from "cheerio"'
            );

        fs.writeFileSync(mjs, source);

        return await import(
            pathToFileURL(mjs).href + '?v=' + Date.now()
        );
    }

    source = source.replace(
        /require\(["']cheerio-without-node-native["']\)/g,
        "require('cheerio')"
    );

    fs.writeFileSync(filename, source);

    delete require.cache[require.resolve(filename)];
    return require(filename);
}

async function refreshProviders() {
    const repos = getRepos();
    const allowedProviders = getProviderAllowlist();

    if (!repos.length) {
        cachedProviders = [];
        return cachedProviders;
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const loaded = [];

    for (let repoIndex = 0; repoIndex < repos.length; repoIndex++) {
        const base = repos[repoIndex];

        try {
            console.log(`[RepoLoader] Loading ${base}`);

            const manifestRes = await fetch(base + 'manifest.json');

            if (!manifestRes.ok) {
                throw new Error(
                    `manifest HTTP ${manifestRes.status}`
                );
            }

            const manifest = await manifestRes.json();

            const entries =
                Array.isArray(manifest)
                    ? manifest
                    : (
                        manifest.scrapers ||
                        manifest.providers ||
                        manifest.items ||
                        []
                    );

            const repoName =
                manifest.name ||
                `repo-${repoIndex + 1}`;

            const repoId = safeName(repoName);

            const repoDir =
                path.join(CACHE_DIR, repoId);

            fs.mkdirSync(repoDir, {
                recursive: true
            });

            for (const entry of entries) {
                if (entry.enabled === false) continue;
                if (!entry.filename) continue;

                const entryId = safeName(
                    entry.id || entry.name
                );

                if (
                    allowedProviders.size &&
                    !allowedProviders.has(entryId)
                ) {
                    continue;
                }

                try {
                    const id = entryId;

                    const sourceUrl =
                        new URL(entry.filename, base).href;

                    console.log(
                        `[RepoLoader] Downloading ${repoName}/${entry.name}`
                    );

                    const sourceRes =
                        await fetch(sourceUrl);

                    if (!sourceRes.ok) {
                        throw new Error(
                            `HTTP ${sourceRes.status}`
                        );
                    }

                    const source =
                        await sourceRes.text();

                    const localFile =
                        path.join(repoDir, `${id}.js`);

                    const mod =
                        await loadModule(
                            localFile,
                            source
                        );

                    const getStreams =
                        mod.getStreams ||
                        mod.default?.getStreams;

                    if (
                        typeof getStreams !== 'function'
                    ) {
                        throw new Error(
                            'getStreams export missing'
                        );
                    }

                    loaded.push({
                        repoId,
                        repoName,
                        id,
                        name:
                            entry.name ||
                            entry.id ||
                            id,
                        supportedTypes:
                            entry.supportedTypes ||
                            ['movie', 'tv'],
                        getStreams
                    });

                    console.log(
                        `[RepoLoader] Loaded ${repoName}/${entry.name}`
                    );

                } catch (providerError) {
                    console.error(
                        `[RepoLoader] Provider failed: ${entry.name}:`,
                        providerError.message
                    );
                }
            }

        } catch (repoError) {
            console.error(
                `[RepoLoader] Repo failed: ${base}:`,
                repoError.message
            );
        }
    }

    cachedProviders = loaded;
    lastRefresh = Date.now();

    console.log(
        `[RepoLoader] ${loaded.length} external provider(s) loaded`
    );

    return cachedProviders;
}

async function getRepoProviders() {
    if (
        cachedProviders.length &&
        Date.now() - lastRefresh < REFRESH_MS
    ) {
        return cachedProviders;
    }

    if (!loadingPromise) {
        loadingPromise =
            refreshProviders().finally(() => {
                loadingPromise = null;
            });
    }

    return loadingPromise;
}

module.exports = {
    getRepoProviders,
    refreshProviders
};
