// Your own agent: replaced system prompt, a tool that runs in this process,
// and a structured result. Needs daemon >= 2.10.10 (capability sdk-session-spec-v1).
//   node examples/node/client-tools.mjs [model-profile-id]
import { CtenoSession } from '@cteno/sdk/core';

const PLACES = [
  { name: 'Quiet Corner Cafe', tags: ['coffee', 'quiet'] },
  { name: 'Riverside Noodles', tags: ['food', 'lunch'] },
  { name: 'Night Owl Books', tags: ['books', 'quiet', 'coffee'] },
];

const session = await CtenoSession.open();
try {
  const id = await session.create({
    model: process.argv[2],
    spec: {
      systemPrompt: 'You are a city guide. Use search_places, then answer with exactly one place.',
      tools: { allow: [] },
      clientTools: [{
        name: 'search_places',
        description: 'Search places by keyword',
        inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
        handler: async ({ keyword }) => PLACES.filter(p => p.tags.includes(String(keyword).toLowerCase())),
      }],
      outputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, why: { type: 'string' } },
        required: ['name', 'why'],
      },
      limits: { maxIterations: 6, maxToolCalls: 4, turnTimeoutMs: 60_000 },
    },
  });

  const result = await session.run({ sessionId: id, prompt: 'Somewhere quiet for coffee?' });
  console.log('ok:', result.ok, result.error ?? '');
  console.log('tool calls:', result.toolCalls.map(c => c.name));
  console.log('output:', result.output ?? result.text);
  await session.close(id);
} finally {
  session.dispose();
}
