# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and both packages use
[Semantic Versioning](https://semver.org/). From 2.10.11 on, the SDK version follows
the version of the Cteno daemon it bundles; see the compatibility table in the README.

## [Unreleased]

## [2.10.16] - 2026-10-30

Bundles the Cteno 2.10.16 daemon. No SDK API changes.

### Changed
- The bundled daemon shares MCP connections across sessions, reads the global MCP config
  it writes (`<data>/mcp_servers.yaml`), cascades session delete/archive to subagent and DAG
  descendants, and ships `cteno-host-cli doctor`.

## [2.10.15] - 2026-10-30

Bundles the Cteno 2.10.15 daemon. No SDK API changes.

### Changed
- The bundled daemon catches up reconnecting clients by transcript cursor, supports starting a
  fresh Jelly conversation (`conversation.start-fresh.v1`), and drives the built-in browser
  through the engine's native input path.

## [2.10.14] - 2026-10-29

First release with one version for the SDK and Cteno: 2.10.14 bundles the Cteno 2.10.14
daemon. 2.10.13 was the only SDK-only release (it bundled the 2.10.12 daemon); Cteno itself
skipped 2.10.13.

### Fixed
- A turn's result reports what really happened: a failed or interrupted turn is no longer
  returned as `ok: true` with empty text, and environment, model and configuration errors are
  raised explicitly instead of timing out or silently falling back.
- `configureModel()` with an explicit versioned `baseUrl` keeps the path you gave; existing
  configurations are migrated.
- The daemon fails at startup when it cannot bind its socket, instead of running without one.


## [2.10.12] - not published

The client code was published here as source only. Everything listed under 0.2.0 below is
included; 0.2.0 and 2.10.11 were never published.

### Changed
- Version numbers now follow the bundled Cteno daemon (0.2.0 → 2.10.12).
- `@cteno/sdk` only depends on the platform packages that are actually published
  (`cteno.platforms` in `js/package.json`).

### Known issues (Cteno 2.10.11 daemon, fixed in 2.10.12)
- **First request after a daemon restart can run without tools.** Restarting the daemon
  on an existing data directory and sending a request right after `open()` can run that
  first turn with no tools: an empty reply, or the model not offered the tool it needs.
  It does not grant permissions; tools are never run without approval. Workaround on
  2.10.11: wait a few seconds after `open()` before the first request.
- **Intel Mac daemon does not start on its own.** The 2.10.11 x86_64 `cteno-host-cli`
  lacks an `LC_RPATH` for the system Swift runtime and exits at launch unless
  `DYLD_LIBRARY_PATH=/usr/lib/swift` is set.

### Planned for 2.10.12
- The daemon accepts sessions only after its tool registry is ready; a turn that
  arrives earlier fails with the transient error
  `host not ready: tool registry is still initializing; retry shortly` instead of
  running without tools.
- Intel Mac binaries carry `LC_RPATH /usr/lib/swift`; a release gate checks every
  macOS binary for unresolved `@rpath` references.
- Bundled daemon packages on npm / PyPI: macOS arm64 and x64, Linux x64 (glibc ≥ 2.34),
  Windows x64. Linux arm64 stays unsupported for now.

## [0.2.0] - not published

### Added
- **Bundled daemon.** `npm install @cteno/sdk` / `pip install cteno-sdk` now install a
  local Cteno daemon for the platform (`@cteno/sdk-<os>-<arch>` optional dependencies,
  platform wheels). `CtenoSession.open()` attaches to it or starts it: local mode, no
  desktop app, no account. It is isolated from an installed Cteno app (own data
  directory, socket, machine id, logs) and replaced automatically when the SDK is
  upgraded. `stopDaemon()` / `stop_daemon()` stop it.
- `configureModel()` / `configure_model()`: register your own model key (BYOK).
- `canUseTool` / `can_use_tool`: approve or deny tool calls from code. Without it,
  tools that are not read-only are denied immediately instead of waiting for a person.

### Changed
- **`open()` no longer connects to a Cteno desktop app's daemon.** Pass its
  `socketPath` explicitly to keep the 0.1 behaviour. Discovery (`@cteno/sdk/discover`)
  is still available but unused by `open()`.

### Fixed
- Socket discovery now finds every owner socket the daemon publishes
  (`host[.<tag>].sock`), including a headless `cteno-host-cli serve`
  (`host.host.sock`). Previously only `host.sock`/`host.dev.sock` were found, so a
  headless daemon on Linux needed an explicit socket path.
- `listSessions()` / `list-sessions` rows now read title and workdir from the
  daemon's `metadata` (they were always `undefined` before).
- Creating a session with an agent spec on a daemon older than 2.10.10 now fails
  up front with an upgrade message, instead of creating the session and then failing
  with `unknown hook event: ClientTool`.
- A relative `cwd` (e.g. `'.'`) is now resolved against the caller's directory.
  Before, the daemon resolved it against its own working directory (usually `~`).

### Added
- Examples: `list-sessions`, `run-task`, `stream-events` (Node), `quickstart`,
  `sessions` (Python), with an `examples/node/package.json` so they run in place.
- README rewrite with requirements, quickstart with expected output, common tasks,
  troubleshooting and compatibility; Chinese README (`README.zh-CN.md`).
- Manual `publish.yml` workflow (npm with provenance, PyPI trusted publishing).

## [0.1.0] - 2026-10-27

Initial public release.

### Added
- `@cteno/sdk` (Node ≥ 20): `query()`, `CtenoSession` (create / send / run / abort /
  history / trace / listSessions / listProfiles / close), per-session agent spec with
  client tools, terminal tools, structured output, limits, imported history and tenant
  isolation, hook subscriptions, owner-socket discovery, Unix-socket / named-pipe and
  injected Socket.IO transports, stable/internal method tiers.
- `cteno-sdk` (Python ≥ 3.9, stdlib only): the same session, agent-spec and client-tool
  surface over the owner socket.
- Examples for Node and Python; CI with unit tests and secret scanning.
