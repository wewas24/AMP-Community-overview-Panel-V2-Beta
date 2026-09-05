import { randomUUID } from "node:crypto";
import { openStore } from "../src/storage.mjs";
import { normalizeServer } from "../src/validation.mjs";

const requestedCount = Number.parseInt(process.argv[2] || "", 10);
if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 250) {
  throw new Error("Bitte eine Serveranzahl zwischen 1 und 250 angeben.");
}

const store = await openStore();
if (store.allServers().length > 0) {
  store.db.close();
  throw new Error("Die Phase-0-Datenbank ist nicht leer. Das Skript schützt vorhandene Testdaten vor dem Überschreiben.");
}

const now = Date.now();
const createdAt = new Date(now).toISOString();
const fiveMinutes = 5 * 60_000;
const addMetric = store.db.prepare("INSERT INTO metrics_history(server_id,latency_ms,players,max_players,checked_at) VALUES(?,?,?,?,?)");

store.db.exec("BEGIN");
try {
  const settings = store.getSettings();
  store.saveSettings({
    ...settings,
    siteTitle: `Phase 0 – ${requestedCount} synthetische Server`,
    siteDescription: "Lokaler Leistungstest. Es werden keine echten Spielserver abgefragt.",
    monitoringIntervalSeconds: 30,
    trustedCommunityDomains: [],
    smtp: { host: "", port: 587, username: "", from: "", to: "" },
    notifications: { notifyOffline: false, notifyRecovered: false, latencyThresholdMs: 0, outageMinutes: 0 }
  });

  for (let index = 1; index <= requestedCount; index += 1) {
    const id = randomUUID();
    const server = normalizeServer({
      name: `Synthetischer Server ${String(index).padStart(3, "0")}`,
      slug: `phase0-server-${index}`,
      category: index % 3 === 0 ? "Sandbox" : index % 2 === 0 ? "Minecraft" : "Allgemein",
      description: "Ausschließlich für den lokalen Phase-0-Leistungstest.",
      communityUrl: `https://example.invalid/c/phase0-${index}`,
      visibility: "public",
      // There is deliberately no monitoring target. After the first local
      // cycle, the normal monitor exercises its status and SSE path without
      // ever opening a connection to a real game server.
      monitoring: { enabled: true, intervalSeconds: 30 },
      display: { showPlayers: true, showPing: true, showVersion: true }
    }, { id, createdAt }, index - 1, false);

    store.saveServer(server);
    store.saveStatus(id, {
      state: "ONLINE",
      detail: "Synthetischer Teststatus; keine Netzwerkprüfung.",
      latencyMs: 12 + (index % 78),
      players: index % 48,
      maxPlayers: 64,
      version: "phase-0",
      map: "synthetic",
      checkedAt: createdAt
    });

    // 24 Stunden realistisch verdichtete Metriken: ein Wert pro fünf Minuten.
    for (let point = 1; point < 288; point += 1) {
      const measuredAt = new Date(now - (288 - point) * fiveMinutes).toISOString();
      addMetric.run(id, 12 + ((index + point) % 78), (index + point) % 48, 64, measuredAt);
    }
  }
  store.db.exec("COMMIT");
} catch (error) {
  store.db.exec("ROLLBACK");
  throw error;
} finally {
  store.db.close();
}

console.log(`Phase-0-Datenbank mit ${requestedCount} synthetischen Servern erzeugt.`);
