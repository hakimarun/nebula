// Server-Sent Events hub: live scan progress, new-media notices, sync rooms.
const clients = new Set(); // { res, channels:Set }

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  const client = { res, channels: new Set(String(req.query.ch || 'global').split(',')) };
  clients.add(client);
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch { } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}

function emit(channel, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.channels.has(channel) || c.channels.has('*')) {
      try { c.res.write(payload); } catch { clients.delete(c); }
    }
  }
}

module.exports = { sseHandler, emit };
