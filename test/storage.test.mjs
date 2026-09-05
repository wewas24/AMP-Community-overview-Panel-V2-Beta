import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tokenHash } from "../src/security.mjs";

test("speichert Statusdaten ohne interne Probe-Antwort", async () => {
  const originalDirectory = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "amp-dashboard-v2-test-"));
  try {
    process.chdir(directory);
    const moduleUrl = pathToFileURL(join(originalDirectory, "src", "storage.mjs"));
    moduleUrl.searchParams.set("test", String(Date.now()));
    const { openStore } = await import(moduleUrl.href);
    const store = await openStore();
    const timestamp = new Date().toISOString();
    store.saveServer({ id: "server-1", slug: "test-server", sortOrder: 0, createdAt: timestamp, updatedAt: timestamp, name: "Testserver" });

    store.saveStatus("server-1", {
      state: "ONLINE",
      detail: "Steam-Abfrage erfolgreich.",
      checkedAt: timestamp,
      latencyMs: 12,
      response: Buffer.from("interne-probe-antwort")
    });

    const status = store.statusRow(store.getStatus("server-1"));
    assert.equal(status.state, "ONLINE");
    assert.equal(status.latencyMs, 12);
    const repeated = store.saveStatus("server-1", {
      state: "ONLINE", detail: "Weiterhin erreichbar.",
      checkedAt: new Date(Date.parse(timestamp) + 30_000).toISOString(), latencyMs: 15
    });
    assert.equal(repeated.changed, false);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM status_history WHERE server_id = ?").get("server-1").count, 1);
    assert.equal(store.metrics("server-1", 24).length, 1);
    store.saveStatus("server-1", { state: "REACHABLE", detail: "TCP erreichbar.", checkedAt: new Date(Date.parse(timestamp) + 60_000).toISOString(), latencyMs: 18 });
    assert.equal(store.getStatus("server-1").last_success_at !== null, true);
    assert.equal(store.uptime("server-1", 24) !== null, true);
    store.saveStatus("server-1", { state: "CONNECTION_REFUSED", detail: "Port geschlossen.", checkedAt: new Date(Date.parse(timestamp) + 90_000).toISOString(), latencyMs: 1 });
    assert.equal(store.statusRow(store.getStatus("server-1")).latencyMs, null);
    store.addAdmin({ username: "custom-user", salt: "salt", hash: "hash", role: "custom", createdAt: timestamp });
    store.setAdminPermissions("custom-user", ["dashboard.read", "servers.write", "not-a-permission"]);
    assert.deepEqual([...store.permissionsFor(store.getAdmin("custom-user"))].sort(), ["dashboard.read", "servers.write"]);
    await store.setSmtpPassword("nur-in-der-secret-datei");
    const exported = store.exportData();
    assert.equal(JSON.stringify(exported).includes("nur-in-der-secret-datei"), false);
    assert.equal(JSON.stringify(store.getSettings()).includes("nur-in-der-secret-datei"), false);
    store.db.close();
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("drosselt Anmeldungen und invalidiert ersetzte oder abgelaufene Sitzungen", async () => {
  const originalDirectory = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "amp-dashboard-v2-auth-test-"));
  try {
    process.chdir(directory);
    const moduleUrl = pathToFileURL(join(originalDirectory, "src", "storage.mjs"));
    moduleUrl.searchParams.set("test", `auth-${Date.now()}`);
    const { openStore } = await import(moduleUrl.href);
    const store = await openStore();
    store.addAdmin({ username: "admin", salt: "test-salt", hash: "test-hash", role: "owner", createdAt: new Date().toISOString() });
    const firstToken = tokenHash("erste-sitzung");
    const nextToken = tokenHash("neue-sitzung");
    store.createSession(firstToken, "csrf-1", "admin", 60_000, 120_000);
    assert.ok(store.getSession(firstToken, 60_000));
    store.createSession(nextToken, "csrf-2", "admin", 60_000, 120_000);
    assert.equal(store.getSession(firstToken, 60_000), null);
    assert.ok(store.getSession(nextToken, 60_000));
    store.db.prepare("UPDATE sessions SET idle_expires_at = 0 WHERE token_hash = ?").run(nextToken);
    assert.equal(store.getSession(nextToken, 60_000), null);

    const ipHash = tokenHash("client-a");
    const usernameHash = tokenHash("admin");
    for (let attempt = 0; attempt < 100; attempt += 1) store.recordLoginFailure(ipHash, usernameHash);
    assert.equal(store.db.prepare("SELECT failures FROM login_rate_limits WHERE scope = 'ip' AND subject_hash = ?").get(ipHash).failures, 20);
    assert.ok(store.loginRetryAfter(ipHash, tokenHash("anderer-name")) > 0);
    assert.ok(store.loginRetryAfter(tokenHash("anderer-client"), usernameHash) > 0);
    store.clearLoginFailures(ipHash, usernameHash);
    assert.equal(store.loginRetryAfter(ipHash, usernameHash), 0);
    store.db.close();
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});
