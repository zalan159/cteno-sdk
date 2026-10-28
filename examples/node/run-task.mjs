// Hand the agent a task in a working directory, wait for it to finish, then
// read back what it actually did (tool calls) from the session trace.
//   node run-task.mjs [directory]
import { CtenoSession } from '@cteno/sdk/core';

const cwd = process.argv[2] ?? process.cwd();
const session = await CtenoSession.open();
try {
  const id = await session.create({ cwd, title: 'sdk run-task example', permissionMode: 'bypassPermissions' });
  console.log('session', id);

  const result = await session.run({
    sessionId: id,
    prompt: 'Count the files (not directories) directly in the working directory. Answer with just the number.',
    timeoutMs: 5 * 60_000,
  });
  console.log('ok:', result.ok, result.error ?? '');
  console.log('answer:', result.text);

  console.log('tools used:', result.toolCalls.map(c => c.name).join(', ') || 'none');

  // The persisted trace of the session (messages, tool calls, tool results).
  const trace = await session.trace(id);
  console.log(`trace: ${trace.summary.total} events`);

  await session.close(id);
} finally {
  session.dispose();
}
