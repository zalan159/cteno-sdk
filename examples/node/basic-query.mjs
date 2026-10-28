// One-shot query: create a session, stream one turn, close it.
//   node basic-query.mjs "What files are in this folder?"
// The SDK starts its bundled daemon on first use. Register a model once first
// (see "5-minute quickstart" in ../../README.md).
import { query } from '@cteno/sdk/core';

const prompt = process.argv[2] ?? 'Reply with one short sentence: what can you help me with?';

for await (const message of query({ prompt, cwd: process.cwd(), permissionMode: 'bypassPermissions' })) {
  // The stream also carries structured frames (thinking, tool calls, task
  // lifecycle) with `kind` set. Plain answer text has no kind, or kind 'message'.
  if (message.type === 'assistant' && (message.kind === undefined || message.kind === 'message')) {
    console.log(message.text);
  }
  if (message.type === 'result') {
    if (message.ok) console.log('[done]');
    else { console.error('turn failed:', message.error); process.exitCode = 1; }
  }
}
