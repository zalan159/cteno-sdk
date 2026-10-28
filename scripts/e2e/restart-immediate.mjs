// Regression (2.10.11): restart the bundled daemon on the SAME data dir and send
// a tool-calling request immediately after open(). The first turn must see a
// non-empty tool list (or report the transient not-ready error and then pass
// on retry) — never run silently with no tools.
// Env: MOCK_URL, MOCK_LOG (the mock-llm request log). Run after consumer.mjs
// has configured a model in the same CTENO_SDK_HOME.
import { CtenoSession, stopDaemon } from '@cteno/sdk/core';
import { readFileSync, writeFileSync } from 'node:fs';

const out = (k, v) => console.log(JSON.stringify({ check: k, ...v }));
const NOT_READY = /host not ready/i;
const rounds = Number(process.env.RESTART_ROUNDS || 3);
let failed = false;
for (let i = 1; i <= rounds; i++) {
  await stopDaemon();
  writeFileSync(process.env.MOCK_LOG, '');
  const s = await CtenoSession.open();
  const started = s.daemon?.started;
  const sid = await s.create({ cwd: '.' });
  let r = await s.run({ sessionId: sid, prompt: 'PROBE_TOOL: run touch restart-probe.txt', timeoutMs: 120_000 });
  let retried = false;
  if (!r.ok && NOT_READY.test(String(r.error))) {
    retried = true;
    await new Promise(res => setTimeout(res, 2000));
    r = await s.run({ sessionId: sid, prompt: 'PROBE_TOOL: run touch restart-probe.txt', timeoutMs: 120_000 });
  }
  const reqs = readFileSync(process.env.MOCK_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const probeTools = reqs.filter(q => q.stream && q.probe !== false).map(q => q.ntools ?? null);
  const emptyToolTurn = reqs.some(q => q.stream && q.ntools === 0 && q.probe === true);
  const ok = started === true && r.ok && r.toolCalls.length > 0 && !emptyToolTurn;
  out('restart-immediate-tools', { ok, round: i, started, retried, tools: r.toolCalls.map(c => c.name), probeTools, error: r.error ?? null });
  s.dispose();
  if (!ok) failed = true;
}
await stopDaemon();
process.exit(failed ? 1 : 0);
