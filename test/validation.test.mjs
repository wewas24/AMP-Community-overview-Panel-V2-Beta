import test from "node:test";
import assert from "node:assert/strict";
import { normalizeServer, slugify } from "../src/validation.mjs";

test("erstellt einen sicheren, einfachen Standardserver", () => {
  const server = normalizeServer({ name: "Mein Test Server", communityUrl: "https://amp.beispiel.de/c/test", connection: { host: "8.8.8.8", port: 53, profile: "auto" } }, { id: "test-id" }, 0, false);
  assert.equal(server.slug, "mein-test-server");
  assert.equal(server.connection.profile, "auto");
  assert.equal(server.visibility, "public");
});

test("blockiert private Zieladressen ohne ausdrückliche Freigabe", () => {
  assert.throws(() => normalizeServer({ name: "Intern", communityUrl: "https://amp.beispiel.de/c/test", connection: { host: "192.168.1.10", port: 25565 } }, { id: "test-id" }, 0, false), /Private oder lokale/);
});

test("erstellt stabile Slugs", () => {
  assert.equal(slugify("Ärger & Spaß"), "arger-spass");
});
