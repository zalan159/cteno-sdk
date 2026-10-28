/**
 * The SDK's own daemon.
 *
 * `@cteno/sdk` ships a headless `cteno-host-cli` per platform (as an optional
 * dependency `@cteno/sdk-<os>-<arch>`, the esbuild/biome pattern). `open()`
 * attaches to the instance this user already started, or starts one.
 *
 * The instance is ISOLATED from an installed Cteno desktop app, by
 * construction rather than by convention:
 *
 * - data, host root (socket), logs, home data (chat/memory/skills) and the
 *   vault all live under one instance root, `CTENO_ISOLATED_ROOT`, which the
 *   daemon honours as a single switch;
 * - the daemon runs in local mode (`CTENO_ENV=host`), never logs in, and gets
 *   no cloud server URL unless the caller supplies one;
 * - discovery never scans the app's `.d*` host roots. Reaching any daemon
 *   other than the SDK's own takes an explicit `socketPath`.
 *
 * Lifetime: the daemon is detached and shared by every SDK process of the
 * same instance root (like a language server). It stays up after your
 * process exits so the next `open()` is instant; `stopDaemon()` ends it.
 * Concurrent first starts are serialised by the daemon's own host lock: the
 * loser exits and both callers attach to the winner.
 *
 * Upgrade: a running daemon OLDER than the bundled one is stopped and the
 * bundled one started; an equal or newer one is kept. `CTENO_SDK_KEEP_DAEMON=1`
 * always keeps the running daemon.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { connectNodeIpc } from './node.js';
import { SdkError } from './index.js';

/** Platform package for a Node `process.platform`/`process.arch` pair. */
export function platformPackageName(platform: string = osPlatform(), arch: string = osArch()): string | null {
  const key = `${platform}-${arch}`;
  return PLATFORM_PACKAGES[key] ?? null;
}

const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': '@cteno/sdk-darwin-arm64',
  'darwin-x64': '@cteno/sdk-darwin-x64',
  'linux-x64': '@cteno/sdk-linux-x64',
  'linux-arm64': '@cteno/sdk-linux-arm64',
  'win32-x64': '@cteno/sdk-win32-x64',
};

/** Where the bundled daemon came from, for diagnostics. */
export interface DaemonBinary {
  /** Absolute path to `cteno-host-cli[.exe]`. */
  path: string;
  /** Directory holding the binary and its sidecars (`rg`, `cteno-wiki`, …). */
  binDir: string;
  /** Resource root with `tools/`, `skills/`, `agents/`. */
  resourceDir: string;
  /** Daemon version the platform package declares. */
  version: string | null;
  source: 'env' | 'package';
}

/**
 * Locate the bundled daemon.
 *
 * `CTENO_SDK_DAEMON_PATH` wins (a custom build, or an air-gapped install that
 * ships the binary separately); otherwise the platform package npm installed.
 */
export function resolveDaemonBinary(): DaemonBinary {
  const exe = osPlatform() === 'win32' ? 'cteno-host-cli.exe' : 'cteno-host-cli';
  const explicit = process.env.CTENO_SDK_DAEMON_PATH;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new SdkError('TRANSPORT', `CTENO_SDK_DAEMON_PATH points at a missing file: ${explicit}`);
    }
    const binDir = dirname(explicit);
    const root = existsSync(join(binDir, '..', 'skills')) ? join(binDir, '..') : binDir;
    return { path: explicit, binDir, resourceDir: root, version: null, source: 'env' };
  }
  const name = platformPackageName();
  if (!name) {
    throw new SdkError('TRANSPORT',
      `No bundled Cteno daemon for ${osPlatform()}-${osArch()}. Supported: ${Object.keys(PLATFORM_PACKAGES).join(', ')}. ` +
      'Set CTENO_SDK_DAEMON_PATH to a cteno-host-cli you built, or pass socketPath to use a daemon you run yourself.');
  }
  const require = createRequire(import.meta.url);
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${name}/package.json`);
  } catch {
    throw new SdkError('TRANSPORT',
      `The platform package ${name} is not installed. It is an optional dependency of @cteno/sdk; ` +
      'reinstall without --no-optional / --omit=optional, or install it explicitly: npm install ' + name);
  }
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string; cteno?: { daemonVersion?: string } };
  const binDir = join(root, 'bin');
  const path = join(binDir, exe);
  if (!existsSync(path)) {
    throw new SdkError('TRANSPORT', `${name} is installed but has no ${exe} (corrupt install?): ${path}`);
  }
  return { path, binDir, resourceDir: root, version: manifest.cteno?.daemonVersion ?? manifest.version ?? null, source: 'package' };
}

/**
 * Root of the SDK's daemon instance. One root = one daemon.
 *
 * Deliberately NOT the desktop app's directory (`~/Library/Application
 * Support/com.cteno-host.gui`, `%APPDATA%\com.cteno-host.gui`, …): this root
 * holds the SDK daemon's own database, machine id, credentials and sockets.
 */
export function defaultInstanceRoot(): string {
  if (process.env.CTENO_SDK_HOME) return process.env.CTENO_SDK_HOME;
  const home = homedir();
  switch (osPlatform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'cteno-sdk');
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'cteno-sdk');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'cteno-sdk');
  }
}

/** Fixed layout under an instance root. The daemon reads the same three env vars. */
export interface InstanceLayout {
  root: string;
  /** `CTENO_APP_DATA_DIR`: db, profiles.json, machine_id.txt, auth.json. */
  dataDir: string;
  /** `CTENO_HOST_ROOT`: the owner socket and lock files. */
  hostRoot: string;
  /** Daemon stdout/stderr. */
  logFile: string;
  /** Owner endpoint the daemon binds (Unix socket path or Windows pipe name). */
  endpoint: string;
}

/** Endpoint tag of `CTENO_ENV=host`; the socket is `host.host.sock`. */
const ENV_TAG = 'host';

export function instanceLayout(root: string = defaultInstanceRoot()): InstanceLayout {
  const dataDir = join(root, 'data');
  const hostRoot = join(root, 'run');
  return {
    root,
    dataDir,
    hostRoot,
    logFile: join(root, 'logs', 'daemon.log'),
    endpoint: osPlatform() === 'win32' ? isolatedPipeName(root, ENV_TAG) : join(hostRoot, `host.${ENV_TAG}.sock`),
  };
}

/**
 * Windows pipe name of an isolated instance. Mirrors the daemon's
 * `isolated_pipe_name` (FNV-1a 64 of the root string): pipes share one
 * machine-wide namespace, so the root has to be in the name.
 */
export function isolatedPipeName(root: string, envTag = ''): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(root, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const hex = hash.toString(16).padStart(16, '0');
  return envTag ? `\\\\.\\pipe\\cteno-sdk-${hex}-${envTag}` : `\\\\.\\pipe\\cteno-sdk-${hex}`;
}

export interface DaemonOptions {
  /** Instance root. Default: {@link defaultInstanceRoot}. */
  home?: string;
  /** How long to wait for a freshly spawned daemon to answer. Default 60s. */
  startTimeoutMs?: number;
  /**
   * Extra environment for a daemon this call starts (ignored when attaching
   * to one that is already running). Useful for `CTENO_HAPPY_SERVER_URL`
   * when you deliberately want cloud features.
   */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DaemonHandle {
  layout: InstanceLayout;
  binary: DaemonBinary | null;
  /** True when this call spawned the process; false when it attached. */
  started: boolean;
  pid: number | null;
  /** Version the daemon reports (`__rpc.hello` `daemon_version`), when known. */
  version: string | null;
}

/** Does something answer on this endpoint? A reply, not a socket file, is proof. */
async function answers(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  return (await probe(endpoint, timeoutMs)) !== null;
}

/** `{version}` of the daemon answering on `endpoint`, or null when nothing answers. */
async function probe(endpoint: string, timeoutMs = 1500): Promise<{ version: string | null } | null> {
  try {
    const transport = await connectNodeIpc(endpoint, { timeoutMs });
    try {
      await transport.request('list-local-rpc-methods', {}, { timeoutMs });
      let version: string | null = null;
      try {
        const hello = await transport.request('__rpc.hello', {}, { timeoutMs }) as { daemon_version?: unknown } | null;
        if (hello && typeof hello.daemon_version === 'string') version = hello.daemon_version;
      } catch { /* very old daemon: no version */ }
      return { version };
    } finally {
      transport.close();
    }
  } catch {
    return null;
  }
}

/**
 * Compare dotted versions numerically (`2.10.10` > `2.9.28`). Missing parts
 * count as 0; pre-release suffixes are ignored. Exported for tests.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Should a running daemon be replaced by the bundled one? Only when it is
 * strictly OLDER (or reports no version): a newer daemon already speaks every
 * RPC this SDK uses (backward compatibility), and replacing it would make two
 * SDK versions sharing one instance root restart each other forever.
 */
export function needsUpgrade(running: string | null, bundled: string | null): boolean {
  if (!bundled) return false;
  if (!running) return true;
  return compareVersions(running, bundled) < 0;
}

/** Environment for the bundled daemon. Exported for tests. */
export function daemonEnvironment(
  layout: InstanceLayout,
  binary: DaemonBinary,
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // Nothing the parent inherited from a Cteno app may steer this daemon:
    // its data dir, host root, owner pid, vault, cloud URL, edition. The
    // daemon gets exactly the CTENO_* this function sets below.
    if (/^CTENO_/i.test(key) || /^EXPO_PUBLIC_CTENO_/i.test(key)) continue;
    if (key === 'SECRET_VAULT_DIR' || key === 'FNOX_AGE_KEY' || key === 'FNOX_AGE_KEY_FILE') continue;
    env[key] = value;
  }
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [binary.binDir, env[pathKey]].filter(Boolean).join(delimiter);
  Object.assign(env, {
    CTENO_ISOLATED_ROOT: layout.root,
    CTENO_APP_DATA_DIR: layout.dataDir,
    CTENO_HOST_ROOT: layout.hostRoot,
    CTENO_ENV: ENV_TAG,
    CTENO_DAEMON_LOG: layout.logFile,
    CTENO_BUILTIN_TOOLS_DIR: join(binary.resourceDir, 'tools'),
    CTENO_BUILTIN_SKILLS_DIR: join(binary.resourceDir, 'skills'),
    CTENO_BUILTIN_AGENTS_DIR: join(binary.resourceDir, 'agents'),
    CTENO_BUILTIN_PLUGINS_DIR: join(binary.resourceDir, 'plugins'),
    CTENO_SDK_MANAGED: '1',
  });
  // No account: this daemon is never logged in, so it has no cloud identity,
  // no relay and no machine registration. A server URL inherited from a
  // Cteno app was stripped above; pass one in `extra` only if you mean it.
  Object.assign(env, extra);
  return env;
}

/**
 * Attach to the SDK's daemon for `home`, starting it if needed.
 *
 * Never connects to, inspects, or reuses the desktop app's daemon.
 */
export async function ensureDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const layout = instanceLayout(options.home);
  const running = await probe(layout.endpoint);
  let binary: DaemonBinary | null = null;
  if (running) {
    // Upgrade: a daemon left behind by an older SDK version is replaced by
    // the bundled one. Sessions and data persist on disk; clients attached
    // to the old process reconnect on their next open().
    try { binary = resolveDaemonBinary(); } catch { binary = null; }
    const keep = process.env.CTENO_SDK_KEEP_DAEMON === '1';
    if (keep || !binary || !needsUpgrade(running.version, binary.version)) {
      return { layout, binary: null, started: false, pid: null, version: running.version };
    }
    await stopDaemon({ home: options.home });
  }

  binary ??= resolveDaemonBinary();
  for (const dir of [layout.dataDir, layout.hostRoot, dirname(layout.logFile)]) mkdirSync(dir, { recursive: true });
  // Nothing answers, so a lock whose pid is dead is stale (a daemon that
  // exited without cleanup). Older daemons cannot always tell on their own
  // (no `ps` in minimal containers), so clear it here.
  for (const lock of [join(layout.hostRoot, 'host.lock'), join(layout.dataDir, 'host.owner.lock')]) {
    if (existsSync(lock) && !lockHeld(lock)) rmSync(lock, { force: true });
  }
  // Rotate a runaway log before handing it to a new process; the daemon also
  // caps the file it is told about (CTENO_DAEMON_LOG).
  const log = openSync(layout.logFile, 'a');
  let child;
  try {
    child = spawn(binary.path, ['serve'], {
      env: daemonEnvironment(layout, binary, process.env, options.env),
      cwd: layout.root,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
  } finally {
    closeSync(log);
  }
  let exited: { code: number | null; signal: string | null } | null = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.once('error', () => { exited = { code: null, signal: 'spawn-error' }; });
  child.unref();

  const deadline = Date.now() + (options.startTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new SdkError('CANCELLED', 'Daemon start cancelled');
    if (await answers(layout.endpoint)) {
      // `exited` set here means we lost a start race and the winner answered.
      return { layout, binary, started: exited === null, pid: exited === null ? child.pid ?? null : null, version: binary.version };
    }
    if (exited) {
      // Lost the host-lock race to a concurrent open() (or to a daemon still
      // shutting down): wait for the winner. Anything else is a real failure,
      // reported with the log tail.
      const deadlineForWinner = Math.min(deadline, Date.now() + 15_000);
      while (Date.now() < deadlineForWinner) {
        if (await answers(layout.endpoint)) return { layout, binary, started: false, pid: null, version: null };
        await sleep(200);
      }
      throw new SdkError('TRANSPORT',
        `The bundled Cteno daemon exited during startup (${describeExit(exited)}). Log: ${layout.logFile}\n${logTail(layout.logFile)}`);
    }
    await sleep(200);
  }
  throw new SdkError('TIMEOUT',
    `The bundled Cteno daemon did not answer within ${options.startTimeoutMs ?? 60_000}ms. Log: ${layout.logFile}\n${logTail(layout.logFile)}`);
}

/** Ask the SDK's daemon for `home` to exit. Resolves false when none was running. */
export async function stopDaemon(options: { home?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const layout = instanceLayout(options.home);
  let transport;
  try {
    transport = await connectNodeIpc(layout.endpoint, { timeoutMs: 1500 });
  } catch {
    return false;
  }
  try {
    await transport.request('__rpc.shutdown', { reason: 'cteno-sdk stopDaemon' }, { timeoutMs: 5000 });
  } catch { /* The daemon may close the connection as it exits. */ } finally {
    transport.close();
  }
  // Stopped means the PROCESS is gone, not just the socket: after closing the
  // socket the daemon still drains subprocesses while holding its host lock,
  // and a daemon started in that window would lose the lock and exit.
  const locks = [join(layout.hostRoot, 'host.lock'), join(layout.dataDir, 'host.owner.lock')];
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (!(await answers(layout.endpoint, 500)) && !locks.some(lockHeld)) return true;
    await sleep(200);
  }
  throw new SdkError('TIMEOUT', `The SDK daemon at ${layout.endpoint} did not stop`);
}

/** Is `host.lock` held by a live process? A stale file (dead pid) is not held. */
export function lockHeld(lockPath: string): boolean {
  let pid: number;
  try { pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10); } catch { return false; }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  // A zombie (exited, not yet reaped by its parent) is not a lock holder.
  try {
    const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop()!.trim().split(/\s+/)[0];
    return state !== 'Z' && state !== 'X';
  } catch { return true; }
}

function describeExit(exit: { code: number | null; signal: string | null }): string {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

function logTail(path: string, bytes = 2000): string {
  try {
    const size = statSync(path).size;
    const text = readFileSync(path, 'utf8');
    return text.slice(Math.max(0, text.length - bytes)) || `(log empty, ${size} bytes)`;
  } catch {
    return '(no log)';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
