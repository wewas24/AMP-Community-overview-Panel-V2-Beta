import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, isTrustedProxyAddress, passwordMatches, passwordRecord, resolveSafeTarget } from "../src/security.mjs";
import { httpsUrl, normalizeServer } from "../src/validation.mjs";

test("blockiert vollständige private, reservierte und dokumentierte IP-Bereiche", async () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.0.1", "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  await assert.rejects(resolveSafeTarget("127.0.0.1", false), /nicht freigegeben/);
});

test("akzeptiert Forwarded-For nur von explizit vertrauten Proxys", () => {
  assert.equal(isTrustedProxyAddress("::ffff:127.0.0.1", ["127.0.0.1", "::1"]), true);
  assert.equal(isTrustedProxyAddress("203.0.113.15", ["127.0.0.1", "::1"]), false);
});

test("nutzt asynchrones Scrypt mit sicherem Vergleich", async () => {
  const record = await passwordRecord("ein-langes-testpasswort");
  assert.equal(await passwordMatches("ein-langes-testpasswort", record), true);
  assert.equal(await passwordMatches("falsches-passwort", record), false);
});

test("blockiert private Icon- und Community-Adressen sowie versteckt Connect-Daten ohne Freigabe", () => {
  assert.throws(() => httpsUrl("https://127.0.0.1/icon.png", "Icon", false), /öffentliche HTTPS-Adresse/);
  const server = normalizeServer({ name: "Test", communityUrl: "https://amp.beispiel.de/c/test", connectUrl: "steam://connect/8.8.8.8:27015", connection: { host: "8.8.8.8", port: 27015 }, display: { showConnect: false } }, { id: "test" }, 0, false);
  assert.equal(server.display.showConnect, false);
});
