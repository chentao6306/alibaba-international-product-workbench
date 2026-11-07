import { writePrivateSession } from '../server/private-session-storage.js';

export async function saveAccountCookies(username, sessions, destination) {
  if (!username) return false;
  // Persisted account sessions remain available after all seller windows close.
  const cookies = await sessions.fromPartition(`persist:kua-yipu-${username}`).cookies.get({});
  writePrivateSession(destination, cookies);
  return true;
}
