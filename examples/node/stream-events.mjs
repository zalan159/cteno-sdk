// Watch a turn as it happens: status changes, tool calls, tool results and the
// answer, each as its own event. Also installs a PreToolUse hook on that
// session that vetoes destructive shell commands before they run.
//   node stream-events.mjs
import { CtenoSession } from '@cteno/sdk/core';

const session = await CtenoSession.open();
try {
  const id = await session.create({ cwd: process.cwd(), title: 'sdk stream-events example', permissionMode: 'bypassPermissions' });

  // Hooks need daemon capability hooks-subscribe-v1 (bundled daemon has it).
  const unhook = await session.hooks.on('PreToolUse', null, call => {
    const input = JSON.stringify(call.payload?.tool_input ?? {});
    console.log(`  [hook] PreToolUse ${call.payload?.tool_name ?? '?'}`);
    if (/rm\s+-rf/.test(input)) return { decision: 'deny', reason: 'blocked by SDK policy' };
  }, { sessions: [id] });

  const prompt = 'Run `ls` in the working directory with your shell tool, then tell me how many entries there are.';
  for await (const m of session.send({ sessionId: id, prompt })) {
    if (m.type === 'status') console.log(`[status] ${m.thinking ? 'working' : 'idle'}`);
    else if (m.type === 'user') console.log(`[user] ${m.text}`);
    else if (m.type === 'assistant' && m.kind === 'tool-call') console.log(`[tool-call] ${m.data?.content?.data?.name}`);
    else if (m.type === 'assistant' && m.kind === 'tool-result') console.log('[tool-result]');
    else if (m.type === 'assistant' && (m.kind === undefined || m.kind === 'message')) console.log(`[answer] ${m.text}`);
    else if (m.type === 'result') console.log(`[result] ok=${m.ok}${m.error ? ` error=${m.error}` : ''}`);
    // other kinds (thinking, task_started, context_usage, …) are skipped here
  }

  await unhook();
  await session.close(id);
} finally {
  session.dispose();
}
