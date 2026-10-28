// Clean-machine consumer check for @cteno/sdk with the bundled daemon.
// Env: MOCK_URL (OpenAI-compatible base, e.g. http://127.0.0.1:18999/v1).
// Prints one JSON line per check; exits non-zero on the first failure.
import { CtenoSession, query, instanceLayout, stopDaemon } from '@cteno/sdk/core';
import { existsSync, readFileSync } from 'node:fs';

const out = (k, v) => console.log(JSON.stringify({ check: k, ...v }));
const fail = (k, v) => { out(k, { ok: false, ...v }); process.exit(1); };

const layout = instanceLayout();
const t0 = Date.now();
const cteno = await CtenoSession.open();
out('open', { ok: true, started: cteno.daemon?.started, endpoint: cteno.endpoint?.path, ms: Date.now() - t0, root: layout.root });
if (!cteno.endpoint?.path.startsWith(layout.root) && process.platform !== 'win32') fail('endpoint-under-root', { endpoint: cteno.endpoint?.path });

const id = await cteno.configureModel({ baseUrl: process.env.MOCK_URL, model: 'mock-model', apiKey: 'sk-mock-not-secret' });
const profiles = await cteno.listProfiles();
out('configureModel', { ok: profiles.some(p => p.id === id), id, profiles: profiles.map(p => p.id) });
cteno.dispose();

// README quickstart, verbatim.
let text = ''; let ok = false;
for await (const m of query({ prompt: 'Reply with exactly: hello from Cteno', cwd: '.' })) {
  if (m.type === 'assistant' && (m.kind === undefined || m.kind === 'message')) { console.log(m.text); text += m.text; }
  if (m.type === 'result') { ok = m.ok; console.log(m.ok ? '[done]' : `[failed] ${m.error}`); }
}
if (!ok || !text.includes('hello from Cteno')) fail('quickstart', { text });
out('quickstart', { ok: true, text });

// Default permission policy: denied immediately, never stalls.
const s = await CtenoSession.open();
out('reattach', { ok: s.daemon?.started === false });
const sid = await s.create({ cwd: '.' });
const started = Date.now();
const r = await s.run({ sessionId: sid, prompt: 'PROBE_TOOL: run touch sdk-probe.txt', timeoutMs: 120_000 });
const secs = (Date.now() - started) / 1000;
const denied = r.messages.some(m => m.type === 'assistant' && /No approver is attached|denied/i.test(m.text));
const resultsOf = run => run.messages.filter(m => m.type === 'assistant' && m.kind !== undefined && m.kind !== 'message' && m.kind !== 'thinking').map(m => `${m.kind}: ${String(m.text).slice(0, 300)}`);
out('deny-default-frames', { frames: resultsOf(r) });
const denyOk = r.ok && r.toolCalls.length > 0 && secs < 60 && !existsSync('sdk-probe.txt');
out('deny-default', { ok: denyOk, secs, denied, tools: r.toolCalls.map(c => c.name) });
if (!denyOk) fail('deny-default', { secs });

// canUseTool allow path.
const sid2 = await s.create({ cwd: '.' });
const seen = [];
const r2 = await s.run({ sessionId: sid2, prompt: 'PROBE_TOOL: run touch sdk-probe.txt', timeoutMs: 120_000,
  canUseTool: req => { seen.push(req.toolName); return { allow: true }; } });
out('allow-frames', { frames: resultsOf(r2) });
const allowOk = r2.ok && seen.length > 0 && existsSync('sdk-probe.txt');
out('canUseTool-allow', { ok: allowOk, seen });
if (!allowOk) process.exit(1);
s.dispose();

const machineId = readFileSync(`${layout.dataDir}/machine_id.txt`, 'utf8').trim();
out('identity', { ok: true, machineId, dataDir: layout.dataDir });
if (process.env.KEEP_DAEMON !== '1') out('stop', { ok: await stopDaemon() });
