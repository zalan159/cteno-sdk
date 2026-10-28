// Several turns on one session, then read its history back.
//   node multi-turn.mjs
import { CtenoSession } from '@cteno/sdk/core';

const session = await CtenoSession.open();
try {
  const profiles = await session.listProfiles();
  console.log('profiles:', profiles.map(p => p.id).join(', ') || '(daemon default)');

  const id = await session.create({ cwd: process.cwd(), title: 'sdk multi-turn example' });
  for (const prompt of ['Pick a random fruit and remember it.', 'Which fruit did you pick?']) {
    const result = await session.run({ sessionId: id, prompt });
    console.log(`> ${prompt}\n${result.ok ? result.text : `error: ${result.error}`}\n`);
  }

  const history = await session.history(id);
  console.log(`history has ${history.length} messages`);
  await session.close(id);
} finally {
  session.dispose();
}
