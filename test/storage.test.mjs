import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
    store.db.close();
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});
