// List the sessions the daemon knows about, newest first, and the model
// profiles it can run.
//   node list-sessions.mjs
import { CtenoSession } from '@cteno/sdk/core';

const session = await CtenoSession.open();
try {
  const sessions = await session.listSessions();
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  console.log(`${sessions.length} sessions`);
  for (const s of sessions.slice(0, 10)) {
    console.log(`${s.active ? '*' : ' '} ${s.id}  ${s.title ?? '(untitled)'}`);
  }

  const profiles = await session.listProfiles();
  console.log(`\n${profiles.length} model profiles:`, profiles.slice(0, 5).map(p => p.id).join(', '),
    profiles.length > 5 ? '…' : '');
} finally {
  session.dispose();
}
