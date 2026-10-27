# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately
through GitHub's [private vulnerability reporting](https://github.com/zalan159/cteno-sdk/security/advisories/new)
for this repository. Include the affected package and version, a description, and
steps to reproduce if you have them.

You should get an acknowledgement within a few working days. We will keep you
informed while a fix is prepared and credit you in the release notes unless you
prefer otherwise.

## Scope and threat model

The SDK is a client for a daemon running on the same machine. It authenticates by
operating-system identity: the daemon's owner socket is only reachable by the user
that runs it. The SDK deliberately adds no authorization layer of its own, so "any
process running as the same OS user can drive the daemon" is expected behaviour,
not a vulnerability.

In scope, for example:
- the SDK connecting to a socket it should not trust, or leaking data across sessions,
  connections or tenants;
- client-tool or hook replies being accepted from the wrong connection;
- malformed daemon frames causing crashes, unbounded memory use, or code execution.

Issues in the Cteno app or daemon itself are out of scope here; report them through
the same private channel and we will route them.

## Supported versions

Only the latest `0.x` release receives fixes.
