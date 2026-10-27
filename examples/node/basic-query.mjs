// One-shot query: create a session, stream one turn, close it.
//   node examples/node/basic-query.mjs "What files are in this folder?"
// Requires a running Cteno daemon and a built/installed @cteno/sdk.
import { query } from '@cteno/sdk/core';

const prompt = process.argv[2] ?? 'List the files in the current directory and describe them in one line each.';

for await (const message of query({ prompt, cwd: process.cwd(), permissionMode: 'bypassPermissions' })) {
  if (message.type === 'assistant') console.log(message.text);
  if (message.type === 'result' && !message.ok) {
    console.error('turn failed:', message.error);
    process.exitCode = 1;
  }
}
