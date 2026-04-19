// Shared helper for posting system-typed messages to a room.
//
// Split out of scripts/chat-plan.js and scripts/chat-claim.js, where two
// near-identical local copies both called upsertAgent() with a currentRoom
// override — silently moving the caller into the target room as a side effect
// of posting (see audit #5148, plan #53, task #233).
//
// Posting a system message MUST NOT mutate the caller's current_room. Room
// membership is an explicit action via chat-join.js / chat-leave.js. If
// presence heartbeat needs extending during a post, add a dedicated last_seen
// helper — don't piggyback on upsertAgent.

import { initCursorIfNew, insertMessage, updateCursor } from './db.js';

export function postSystemMessage(identity, room, content) {
  initCursorIfNew(identity.name, identity.projectPath, room);
  const result = insertMessage({
    type: 'system',
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    room,
    content,
  });
  updateCursor(identity.name, identity.projectPath, room, Number(result.id));
  return result;
}
