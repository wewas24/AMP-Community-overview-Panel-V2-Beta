import test from "node:test";
import assert from "node:assert/strict";
import { normalizeServer, slugify } from "../src/validation.mjs";

test("erstellt einen sicheren, einfachen Standardserver", () => {
  const server = normalizeServer({ name: "Mein Test Server", communityUrl: "https://amp.beispiel.de/c/test", connectUrl: "steam://connect/8.8.8.8:53", connection: { host: "8.8.8.8", port: 53, profile: "auto" } }, { id: "test-id" }, 0, false);
  assert.equal(server.slug, "mein-test-server");
  assert.equal(server.connection.profile, "auto");
  assert.equal(server.connectUrl, "steam://connect/8.8.8.8:53");
  assert.equal(server.visibility, "public");
});

test("blockiert unsichere Verbindungslinks", () => {
  assert.throws(() => normalizeServer({ name: "Test", communityUrl: "https://amp.beispiel.de/c/test", connectUrl: "javascript:alert(1)" }, { id: "test-id" }, 0, false), /Verbindungslink/);
});

test("blockiert private Zieladressen ohne ausdrückliche Freigabe", () => {
  assert.throws(() => normalizeServer({ name: "Intern", communityUrl: "https://amp.beispiel.de/c/test", connection: { host: "192.168.1.10", port: 25565 } }, { id: "test-id" }, 0, false), /Private oder lokale/);
});

test("erstellt stabile Slugs", () => {
  assert.equal(slugify("Ärger & Spaß"), "arger-spass");
});

test("speichert Community-, Spiel- und Monitoring-Adresse getrennt", () => {
  const server = normalizeServer({
    name: "Getrennte Ziele", communityUrl: "https://amp.beispiel.de/c/test",
    connection: { host: "8.8.8.8", port: 27015, profile: "steam" },
    monitoringTarget: { host: "1.1.1.1", port: 27016, profile: "tcp" }, group: "Öffentlich"
  }, { id: "test-id" }, 0, false);
  assert.equal(server.connection.host, "8.8.8.8");
  assert.equal(server.monitoringTarget.host, "1.1.1.1");
  assert.equal(server.group, "Öffentlich");
});
