export class EventHub {
  constructor() { this.clients = new Set(); }

  subscribe(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write("retry: 5000\n\n");
    this.clients.add(response);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
    heartbeat.unref?.();
    const close = () => { clearInterval(heartbeat); this.clients.delete(response); };
    request.once("close", close); response.once("close", close);
  }

  publish(name, payload) {
    const message = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try { client.write(message); } catch { this.clients.delete(client); }
    }
  }

  close() {
    for (const client of this.clients) { try { client.end(); } catch { /* already closed */ } }
    this.clients.clear();
  }
}
