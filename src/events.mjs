const maximumPendingEvents = 64;

function eventMessage(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Bounded SSE fan-out. A slow browser never receives an unbounded queue:
 * status updates are collapsed per server and a very slow client receives one
 * resync instruction instead of an ever-growing history.
 */
export class EventHub {
  constructor() { this.clients = new Set(); }

  get clientCount() { return this.clients.size; }

  subscribe(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const client = { response, pending: new Map(), paused: false, needsResync: false, closed: false, heartbeat: null };
    response.write("retry: 5000\n\n");
    this.clients.add(client);
    const close = () => this.remove(client);
    client.heartbeat = setInterval(() => { if (!client.paused) this.write(client, ": keep-alive\n\n"); }, 20_000);
    client.heartbeat.unref?.();
    request.once("close", close); response.once("close", close);
    response.on("drain", () => this.flush(client));
  }

  remove(client) {
    if (!client || client.closed) return;
    client.closed = true;
    clearInterval(client.heartbeat);
    client.pending.clear();
    this.clients.delete(client);
  }

  write(client, message) {
    if (client.closed) return false;
    try {
      const accepted = client.response.write(message);
      if (!accepted) client.paused = true;
      return accepted;
    } catch {
      this.remove(client);
      return false;
    }
  }

  queue(client, name, payload, key) {
    if (client.needsResync) return;
    const eventKey = key || `${name}:${Date.now()}`;
    client.pending.set(eventKey, { name, payload });
    if (client.pending.size > maximumPendingEvents) {
      client.pending.clear();
      client.needsResync = true;
    }
  }

  flush(client) {
    if (client.closed || !client.paused) return;
    client.paused = false;
    if (client.needsResync) {
      client.needsResync = false;
      if (!this.write(client, eventMessage("resync", { reason: "slow-client" }))) return;
    }
    while (!client.paused && client.pending.size) {
      const [key, event] = client.pending.entries().next().value;
      client.pending.delete(key);
      if (!this.write(client, eventMessage(event.name, event.payload))) return;
    }
  }

  publish(name, payload, { key = "" } = {}) {
    if (!this.clients.size) return;
    const message = eventMessage(name, payload);
    for (const client of this.clients) {
      if (client.paused) { this.queue(client, name, payload, key); continue; }
      this.write(client, message);
    }
  }

  close() {
    for (const client of [...this.clients]) {
      try { client.response.end(); } catch { /* already closed */ }
      this.remove(client);
    }
  }
}
