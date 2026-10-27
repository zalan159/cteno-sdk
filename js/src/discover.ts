/**
 * Owner-socket discovery.
 *
 * The daemon derives its host root from the app-data dir as a pure function
 * (its `local_host_root`): a 16-bit hash of the app-data path, rendered as
 * `.d%04x` next to it. The GUI computes it that way before spawning the daemon and the
 * CLI computes it that way before connecting; this module is the third
 * consumer of the same agreement, so it MUST NOT invent its own answer.
 *
 * Rust's `DefaultHasher` is SipHash-1-3 with zero keys and is explicitly NOT
 * a stable cross-version hash, so reimplementing it in JS would be a latent
 * break every toolchain bump. We instead SCAN for the socket files that
 * already exist under each `.d<hash>` host root
 * entries and connect to the one that answers — the socket file is the
 * daemon's own published artifact, which is the durable fact.
 *
 * `CTENO_HOST_ROOT` always wins, matching the daemon's own precedence.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** A candidate owner endpoint: a Unix socket path or a Windows named pipe. */
export interface OwnerEndpoint {
  /** Absolute socket path / pipe name to hand to `connectNodeIpc`. */
  path: string;
  /** Host root this endpoint was found under, for diagnostics. */
  hostRoot: string;
  /** `dev` sockets are `host.dev.sock`; release is `host.sock`. */
  kind: 'dev' | 'release';
}

/** Default app-data parents per platform, matching the daemon's own layout. */
function appDataParents(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return [join(home, 'Library', 'Application Support')];
    case 'win32': {
      const appData = process.env.APPDATA;
      return appData ? [appData] : [];
    }
    default: {
      const xdg = process.env.XDG_DATA_HOME;
      return [xdg ?? join(home, '.local', 'share'), join(home, '.agents')];
    }
  }
}

function socketsUnder(hostRoot: string): OwnerEndpoint[] {
  const found: OwnerEndpoint[] = [];
  for (const [name, kind] of [['host.dev.sock', 'dev'], ['host.sock', 'release']] as const) {
    const path = join(hostRoot, name);
    try {
      // A dead daemon can leave the inode behind, so presence is a candidate,
      // never a liveness claim. `connect` is the only real liveness test.
      if (statSync(path).isSocket()) found.push({ path, hostRoot, kind });
    } catch { /* Absent or unreadable: simply not a candidate. */ }
  }
  return found;
}

/**
 * List owner endpoints this process could try, most specific first.
 *
 * This never connects, never starts a daemon, and never picks for you. On
 * Windows it returns the conventional pipe name unconditionally, because a
 * named pipe is not a filesystem entry that can be scanned the same way.
 */
export function discoverOwnerEndpoints(): OwnerEndpoint[] {
  const explicit = process.env.CTENO_HOST_ROOT;
  if (explicit) return socketsUnder(explicit);

  if (platform() === 'win32') {
    // Named pipes live in the pipe namespace, not on disk. The daemon publishes
    // this exact name; we cannot enumerate variants, so we offer the default.
    return [{
      path: '\\\\.\\pipe\\cteno-host',
      hostRoot: '\\\\.\\pipe',
      kind: 'release',
    }];
  }

  const found: OwnerEndpoint[] = [];
  for (const parent of appDataParents()) {
    let entries: string[];
    try { entries = readdirSync(parent); } catch { continue; }
    for (const entry of entries) {
      // Host roots are `.d<4-hex>` plus optional `-variant` (e.g. `.d7dda`,
      // `.d1234-beta`). Named e2e roots (`.e2everify`) share the prefix rule.
      if (!entry.startsWith('.')) continue;
      found.push(...socketsUnder(join(parent, entry)));
    }
  }
  // Dev sockets first: a developer running both wants the one they are editing.
  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dev' ? -1 : 1));
}
