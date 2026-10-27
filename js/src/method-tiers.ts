/**
 * Which owner-RPC methods the SDK promises to keep working.
 *
 * The owner socket exposes every method the desktop app itself uses. That is
 * deliberate — see `core.ts` for why there is no authorization layer here. But
 * "you *can* call it" and "we promise it will still exist next release" are
 * different claims, and a third party building a product needs the second one.
 *
 * This module is the machine-readable form of the daemon's RPC method
 * inventory grading (2026-09-04). It changes no
 * behaviour: `call()` reaches every method either way. It only tells you which
 * side of the line you are standing on.
 *
 * Tiers:
 *
 * - `stable`   — product semantics a downstream consumer legitimately needs:
 *                sessions, agent execution, scheduling, traces, workspace
 *                reads. Breaking these requires a major version.
 * - `internal` — daemon implementation detail: credentials, plugin install,
 *                the CEF browser pane, protocol handshake, dashboard
 *                placeholders. Reachable, unversioned, may change without
 *                notice. Depending on one is a choice, not an accident.
 * - `unknown`  — not in the inventory. Either newer than this table, or a typo.
 */

export type MethodTier = 'stable' | 'internal' | 'unknown';

/**
 * Methods that constitute the supported product surface.
 *
 * Mirrors the stable table of the daemon's RPC method inventory. Names
 * are unscoped — the machine id is added by `CtenoSession.call()`.
 */
export const STABLE_METHODS: readonly string[] = Object.freeze([
  // Session lifecycle and queries
  'list-sessions',
  'get-session',
  'create-fork-thread',
  'create-side-chat',
  'list-workdir-worktrees',
  'rewind-session',
  'get-session-messages',
  'close-session',
  'compact-session',
  'kill-session',
  'delete-session',
  'list-archived-sessions',
  'search-sessions',
  'unarchive-session',
  'set-session-pinned',
  'set-session-sort-key',
  'set-session-name',
  // Session workdir reads (read-only by design; writes stay per-session)
  'session-read-file',
  'session-file-stat',
  'session-file-stream-open',
  'session-list-directory',
  'session-get-directory-tree',
  // Threads and messages
  'create-thread',
  'send-thread-message',
  'send-message',
  // Trace and artifacts
  'get-session-trace',
  'list-session-events',
  'list-session-artifacts',
  // SubAgents
  'list-subagents',
  'get-subagent',
  // Agent definitions
  'list-agents',
  'get-agent',
  'create-agent',
  'delete-agent',
  // Scheduled tasks
  'create-scheduled-task',
  'list-scheduled-tasks',
  'toggle-scheduled-task',
  'delete-scheduled-task',
  'update-scheduled-task',
  'run-scheduled-task-now',
  // Background tasks and runs
  'list-background-tasks',
  'list-work-items',
  'get-background-task',
  'list-runs',
  'get-run',
  'stop-run',
  'get-run-logs',
  // Workspace
  'workspace-read',
  'workspace-list',
  'workspace-stat',
  'workspace-git-file-diff',
  'get-local-usage',
  // Attachments
  'attachment-begin-upload',
  'attachment-put-chunk',
  'attachment-commit',
  // Model profiles — you need these to pick a model
  'list-profiles',
  // Agent ⇔ RPC parity: run one tool for a session through execute_tool (hooks apply)
  'invoke-tool',
]);

/**
 * Prefixes for whole internal families.
 *
 * These are families rather than fixed names because the daemon adds members
 * over time (`browser-pane-*` especially) and a new member is still internal.
 */
const INTERNAL_PREFIXES: readonly string[] = Object.freeze([
  'browser-',        // CEF pane: in-process UI state, not a cross-machine contract
  'auth-',           // credential persistence and refresh
  'secret-prompt-',  // transient in-memory secret entry
  'license-',        // commercial licensing state
  'disk-',           // platform maintenance
  'legacy-data-',    // migration internals
  'install-host-plugin-',
  'uninstall-host-plugin-',
  'a2a-',            // protocol still stabilising
  'market-',         // marketplace still stabilising
  '__rpc.',          // transport handshake
  '__test.',         // test-only
]);

/** Individually-named internal methods that do not share a family prefix. */
const INTERNAL_METHODS: ReadonlySet<string> = new Set([
  'managed-llm-keys-save',
  'cloud-http-request',
  'host-happy-server-url',
  'subscription-status',
  'connect-subscription',
  'disconnect-subscription',
  'check-subscription',
  'list-host-plugins',
  'start-host-plugin-auth',
  'check-host-plugin-auth-status',
  'list-hook-points',
  'plugin-auth-session-audit',
  'plugin-server-config',
  'get-host-plugin-page',
  'plugin-rpc',
  'start-plugin-page-bridge',
  'stop-plugin-page-bridge',
  'desktop-update-start',
  'set-project-permission-mode',
  'get-project-permission-mode',
  'set-selected-target-machine',
  'get-selected-target-machine',
  'get-machine-snapshot',
  'list-local-rpc-methods',
  'list_available_vendors',
  'get-local-host-info',
  'update-attention-state',
  'get-market-config',
  'set-market-config',
  'reset-market-config',
  'get-model-config',
  'set-model-config',
  'reset-model-config',
  'apply-server-market-defaults',
  // Dashboard placeholders: transitional UI, explicitly not settled
  'get-agent-latest-text',
  'get-agent-artifacts',
  'get-target-page',
  'target-page-response',
  'get-goal-tree-page',
  'get-dashboard',
  'list-notifications',
  'mark-notification-read',
]);

const STABLE_SET: ReadonlySet<string> = new Set(STABLE_METHODS);

/**
 * Classify an unscoped method name.
 *
 * Pass the bare name (`'list-sessions'`), not the scoped form
 * (`'machine:list-sessions'`); a scoped name is normalised for you.
 */
export function methodTier(method: string): MethodTier {
  const bare = method.includes(':') ? method.slice(method.lastIndexOf(':') + 1) : method;
  if (STABLE_SET.has(bare)) return 'stable';
  if (INTERNAL_METHODS.has(bare)) return 'internal';
  for (const prefix of INTERNAL_PREFIXES) {
    if (bare.startsWith(prefix)) return 'internal';
  }
  return 'unknown';
}

/** True when the SDK promises to keep this method working across minor versions. */
export function isStableMethod(method: string): boolean {
  return methodTier(method) === 'stable';
}
