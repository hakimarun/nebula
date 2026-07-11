// Watch-together: lightweight sync rooms. Host + guests exchange play/pause/
// seek events; transport is the SSE hub (down) + POST (up). No extra deps.
const crypto = require('crypto');
const { emit } = require('./events');

const rooms = new Map(); // code -> { mediaId, hostId, members: Map<clientId,{name,at}>, state, createdAt }

function code4() {
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
}

function createRoom(mediaId, hostName) {
  let code;
  do { code = code4(); } while (rooms.has(code));
  const hostId = crypto.randomBytes(6).toString('hex');
  rooms.set(code, {
    mediaId, hostId,
    members: new Map([[hostId, { name: hostName || 'Host', at: Date.now() }]]),
    state: { playing: false, position: 0, updatedAt: Date.now() },
    createdAt: Date.now(),
  });
  return { code, clientId: hostId };
}

function joinRoom(code, name) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room) return null;
  const clientId = crypto.randomBytes(6).toString('hex');
  room.members.set(clientId, { name: name || 'Guest', at: Date.now() });
  emit('room:' + code.toUpperCase(), 'members', membersOf(room));
  return { clientId, mediaId: room.mediaId, state: room.state, members: membersOf(room) };
}

const membersOf = (room) => [...room.members.values()].map((m) => m.name);

/** Relay a control event from one member to all others in the room. */
function control(code, clientId, action, position) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room || !room.members.has(clientId)) return false;
  room.members.get(clientId).at = Date.now();
  room.state = { playing: action === 'play', position: Number(position) || 0, updatedAt: Date.now() };
  emit('room:' + String(code).toUpperCase(), 'control', { action, position: room.state.position, from: room.members.get(clientId).name });
  return true;
}

function leaveRoom(code, clientId) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room) return;
  room.members.delete(clientId);
  if (!room.members.size || clientId === room.hostId) {
    rooms.delete(String(code).toUpperCase());
    emit('room:' + String(code).toUpperCase(), 'closed', {});
  } else {
    emit('room:' + String(code).toUpperCase(), 'members', membersOf(room));
  }
}

// reap stale rooms (6h)
setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.createdAt > 6 * 3600e3) rooms.delete(code);
  }
}, 600e3);

module.exports = { createRoom, joinRoom, control, leaveRoom, rooms };
