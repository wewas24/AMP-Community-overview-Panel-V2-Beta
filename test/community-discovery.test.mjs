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

test("ignoriert unsichere oder unpassende Links", () => {
  assert.equal(endpointFromConnectLink("javascript:alert(1)"), null);
  assert.equal(extractCommunityData('<a href="https://example.com">Webseite</a>', "https://amp.example.com/c/demo").found, false);
});
