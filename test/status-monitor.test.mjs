import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { config } from "../src/config.mjs";
import { StatusMonitor } from "../src/status-monitor.mjs";

test("zeigt einen TCP-erreichbaren Server trotz fehlender Spieleantwort als erreichbar", async () => {
  const listener = createServer((socket) => socket.end());
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const port = listener.address().port;
    const store = {
      getStatus: () => null,
      saveStatus: (_id, status) => ({ previous: null, current: status }),
      allServers: () => [],
      cleanup: () => {}
    };
    const monitor = new StatusMonitor(store, { ...config, allowPrivateNetworks: true, statusTimeoutMs: 80 });
    const result = await monitor.refreshServer({ id: "tcp-fallback", visibility: "public", connection: { host: "127.0.0.1", port, profile: "steam" }, monitoring: { enabled: true, intervalSeconds: 30 } }, true);
    assert.equal(result.state, "REACHABLE");
    assert.equal(Number.isFinite(result.latencyMs), true);
  } finally {
    listener.close();
    await once(listener, "close");
  }
});
