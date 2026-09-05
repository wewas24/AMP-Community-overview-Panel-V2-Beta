import test from "node:test";
import assert from "node:assert/strict";
import { endpointFromConnectLink, extractCommunityData } from "../src/community-discovery.mjs";

test("übernimmt einen Steam-Connect-Link von einer öffentlichen Community-Seite", () => {
  const result = extractCommunityData('<h1>Mein Server</h1><a href="steam://connect/play.example.net:27015">Verbinden</a>', "https://amp.example.com/c/demo");
  assert.equal(result.found, true);
  assert.equal(result.title, "Mein Server");
  assert.equal(result.connection.host, "play.example.net");
  assert.equal(result.connection.port, 27015);
  assert.equal(result.connection.profile, "steam");
});

test("trennt bei Arma 3 Spiel- und Steam-Query-Port aus der Community-Seite", () => {
  const result = extractCommunityData('<h1>Arma 3</h1><p>Spieladresse: arma.example.net:2302</p><a href="steam://connect/arma.example.net:2303">Verbinden</a>', "https://amp.example.com/c/demo");
  assert.equal(result.application, "Arma 3");
  assert.equal(result.connection.host, "arma.example.net");
  assert.equal(result.connection.port, 2302);
  assert.equal(result.connectUrl, "steam://connect/arma.example.net:2303");
  assert.deepEqual(result.monitoringTarget, {
    host: "arma.example.net",
    port: 2303,
    profile: "steam",
    source: "Steam-Verbindungslink der Community-Seite",
    strategy: "community-query-port"
  });
});

test("ignoriert einen generischen Steam-Link bei einer eindeutig als TeamSpeak bezeichneten Seite", () => {
  const result = extractCommunityData('<h1>TeamSpeak6</h1><a href="steam://connect/voice.example.net:9987">Öffnen</a>', "https://amp.example.com/c/demo");
  assert.equal(result.application, "TeamSpeak");
  assert.equal(result.connection.profile, "teamspeak");
  assert.equal(result.connection.port, 9987);
  assert.equal(result.connectUrl, "");
});

test("erkennt TeamSpeak-Verbindungsdaten", () => {
  const result = endpointFromConnectLink("ts3server://voice.example.net?port=9987");
  assert.equal(result.connection.host, "voice.example.net");
  assert.equal(result.connection.port, 9987);
  assert.equal(result.connection.profile, "teamspeak");
});

test("übernimmt eine sichtbare Spieladresse nur im passenden Kontext", () => {
  const result = extractCommunityData("<p>Zum Verbinden: server.example.net:25565</p>", "https://amp.example.com/c/demo");
  assert.equal(result.found, true);
  assert.equal(result.connection.host, "server.example.net");
  assert.equal(result.connection.port, 25565);
  assert.equal(result.connection.profile, "auto");
});

test("findet Port und Adresse auch in AMP-Datenfeldern ohne sichtbaren Connect-Text", () => {
  const result = extractCommunityData('<h1>Voice</h1><div data-host="voice.example.net" data-port="9987" data-service="TeamSpeak"></div>', "https://amp.example.com/c/demo");
  assert.equal(result.found, true);
  assert.equal(result.connection.host, "voice.example.net");
  assert.equal(result.connection.port, 9987);
  assert.equal(result.connection.profile, "teamspeak");
  assert.equal(result.application, "TeamSpeak");
});

test("findet Spieladressen in eingebetteten Community-Seitendaten", () => {
  const result = extractCommunityData('<script type="application/json">{"serverAddress":"mc.example.net","gamePort":25565,"type":"minecraft"}</script>', "https://amp.example.com/c/demo");
  assert.equal(result.found, true);
  assert.equal(result.connection.host, "mc.example.net");
  assert.equal(result.connection.port, 25565);
  assert.equal(result.connection.profile, "minecraft");
});

test("nimmt eine sichtbare Host-Port-Angabe als Fallback auf", () => {
  const result = extractCommunityData("<p>backend.example.net:2303</p>", "https://amp.example.com/c/demo");
  assert.equal(result.found, true);
  assert.equal(result.connection.host, "backend.example.net");
  assert.equal(result.connection.port, 2303);
  assert.equal(result.confidence, "low");
});

test("ignoriert unsichere oder unpassende Links", () => {
  assert.equal(endpointFromConnectLink("javascript:alert(1)"), null);
  assert.equal(extractCommunityData('<a href="https://example.com">Webseite</a>', "https://amp.example.com/c/demo").found, false);
});
