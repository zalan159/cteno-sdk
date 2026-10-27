# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and both packages use
[Semantic Versioning](https://semver.org/). Versions are independent of the Cteno
app version; see the compatibility table in the README for the minimum daemon.

## [Unreleased]

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
