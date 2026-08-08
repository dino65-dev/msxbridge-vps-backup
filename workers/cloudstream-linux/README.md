# MSXBridge CloudStream Linux Worker

This is a running headless compatibility laboratory, not a fork of the desktop UI.

The worker boundary is already defined by the API contract in `openapi.json`. Production work proceeds in this order:

1. Pin an auditable official CloudStream source commit.
2. Convert `.cs3` DEX to JVM bytecode in a disposable work directory.
3. Scan every converted class for type, field, method and invokedynamic references.
4. Run a plugin in an isolated child JVM with a narrow JSON-RPC protocol.
5. Implement explicit Android compatibility bridges only when a fixture proves they are required.
6. Add Chromium/Playwright only for plugins needing headless WebView behavior.

The default service validates bounded `.cs3` archives from `PLUGIN_DIR` through `POST /v1/plugins/inspect`, and establishes `POST /v1/resolve` as the private API boundary.

`Dockerfile.compat` adds an optional, disabled-by-default sidecar built from the pinned `phisher98/cloudstream-desktop-unofficial` commit `5fdb86d` plus its pinned `recloudstream/cloudstream` submodule. It invokes the upstream `ExtensionLoader.loadAndInit` path only after archive checks and a SHA-256 allowlist match. The sidecar is private, read-only, capability-free, and resource-bounded; it has no published port and is reached only via private admin endpoints. `POST /v1/fixtures/execute` exists only to execute the build-time controlled fixture in verification.

The compatibility engine has been exercised with that fixture through both its test-only and allowlisted normal execution routes. DEX-to-JVM conversion is supplied by the upstream loader, but must be validated against every real operator-authorized `.cs3` archive before it is approved.

No plugin process may receive the API database, admin key, Docker socket, host mounts or direct access to private addresses.
