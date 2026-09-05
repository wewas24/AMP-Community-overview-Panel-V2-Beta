import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventHub } from "../src/events.mjs";

class FakeResponse extends EventEmitter {
  constructor() { super(); this.writes = []; this.acceptWrites = true; }
  writeHead() {}
  write(value) { this.writes.push(value); return this.acceptWrites; }
  end() { this.emit("close"); }
}

test("SSE liefert Statusdeltas ohne vollständiges Dashboard", () => {
  const hub = new EventHub();
  const request = new EventEmitter();
  const response = new FakeResponse();
  hub.subscribe(request, response);
  hub.publish("server-status", { serverId: "one", status: { state: "ONLINE" } }, { key: "server-status:one" });
  assert.equal(response.writes.some((entry) => entry.includes("event: server-status")), true);
  assert.equal(response.writes.some((entry) => entry.includes("event: dashboard")), false);
});

test("SSE fasst langsame Clients zusammen und fordert Nachsynchronisierung an", () => {
  const hub = new EventHub();
  const request = new EventEmitter();
  const response = new FakeResponse();
  hub.subscribe(request, response);
  response.acceptWrites = false;
  hub.publish("server-status", { serial: 0 }, { key: "server-status:0" });
  for (let serial = 1; serial <= 70; serial += 1) hub.publish("server-status", { serial }, { key: `server-status:${serial}` });
  response.acceptWrites = true;
  response.emit("drain");
  assert.equal(response.writes.some((entry) => entry.includes("event: resync")), true);
});

test("SSE ersetzt wartende Statuswerte desselben Servers", () => {
  const hub = new EventHub();
  const request = new EventEmitter();
  const response = new FakeResponse();
  hub.subscribe(request, response);
  response.acceptWrites = false;
  hub.publish("server-status", { state: "ONLINE" }, { key: "server-status:one" });
  hub.publish("server-status", { state: "OFFLINE" }, { key: "server-status:one" });
  response.acceptWrites = true;
  response.emit("drain");
  const updates = response.writes.filter((entry) => entry.includes("event: server-status"));
  assert.equal(updates.at(-1).includes("OFFLINE"), true);
  assert.equal(updates.some((entry) => entry.includes('"state":"ONLINE"')), true);
});
