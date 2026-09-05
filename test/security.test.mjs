import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, isTrustedProxyAddress, passwordMatches, passwordRecord, resolveSafeTarget } from "../src/security.mjs";
import { httpsUrl, normalizeServer } from "../src/validation.mjs";
import { ensureCommunityPort, validateCommunityResponse } from "../src/community-discovery.mjs";
import { validateWebhookTarget, webhookResponseAccepted } from "../src/webhook.mjs";

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

test("blockiert DNS-Rebinding und bindet erlaubte Ziele an eine geprüfte IP", async () => {
  const rebindingResolver = async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
  await assert.rejects(resolveSafeTarget("rebind.example", false, rebindingResolver), /nicht freigegebene Adresse/);
  const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  assert.equal(await resolveSafeTarget("public.example", false, publicResolver), "8.8.8.8");
});

test("lässt Community-Seiten nur auf freigegebenen HTTPS-Ports und ohne Redirects zu", () => {
  assert.equal(ensureCommunityPort(443, new Set([443, 8443])), 443);
  assert.equal(ensureCommunityPort(8443, new Set([443, 8443])), 8443);
  assert.throws(() => ensureCommunityPort(444, new Set([443, 8443])), /nicht freigegeben/);
  for (const status of [301, 302, 303, 307, 308]) assert.throws(() => validateCommunityResponse(status, "text/html", 0), /leitet weiter/);
  assert.throws(() => validateCommunityResponse(200, "application/json", 0), /keine HTML/);
  assert.throws(() => validateCommunityResponse(200, "text/html", 1_000_001), /zu groß/);
  assert.doesNotThrow(() => validateCommunityResponse(200, "text/html; charset=utf-8", 42));
});

test("normalisiert oder blockiert ungewöhnliche Hostdarstellungen vor Netzwerkzugriff", () => {
  for (const url of ["http://public.example/", "https://127.1/", "https://0177.0.0.1/", "https://2130706433/", "https://[::1]/", "https://[fe80::1%25eth0]/"]) assert.throws(() => httpsUrl(url, "Adresse", false), /öffentliche HTTPS-Adresse/, url);
  assert.equal(httpsUrl("https://amp.example.com./c/test", "Adresse", false), "https://amp.example.com/c/test");
  assert.match(httpsUrl("https://bücher.example/c/test", "Adresse", false), /^https:\/\/xn--/);
});

test("validiert Webhooks mit derselben öffentlichen DNS-Policy und ohne Redirect-Akzeptanz", async () => {
  const privateResolver = async () => [{ address: "::ffff:127.0.0.1", family: 6 }];
  await assert.rejects(validateWebhookTarget("https://webhook.example/hook", false, privateResolver), /nicht freigegeben/);
  const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const target = await validateWebhookTarget("https://webhook.example/hook", false, publicResolver);
  assert.equal(target.address, "8.8.8.8");
  for (const value of ["http://webhook.example/hook", "https://127.0.0.1/hook", "https://webhook.example:8443/hook", "https://user:secret@webhook.example/hook"]) await assert.rejects(validateWebhookTarget(value, false, publicResolver));
  assert.equal(webhookResponseAccepted(204), true);
  assert.equal(webhookResponseAccepted(302), false);
  assert.equal(webhookResponseAccepted(500), false);
});
