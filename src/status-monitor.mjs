import { connect, isIP } from "node:net";
import { createSocket } from "node:dgram";
import { config } from "./config.mjs";
import { resolveSafeTarget } from "./security.mjs";

const maximumUdpResponseBytes = 64 * 1024;
const maximumTeamSpeakResponseBytes = 64 * 1024;

function stamp(state, detail, extra = {}) {
  return { state, detail, checkedAt: new Date().toISOString(), ...extra };
}

function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  };
  return Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)).then(() => results);
}

async function tcpProbe(address, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = connect({ host: address, port });
    const finish = (state, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(stamp(state, detail, { latencyMs: Date.now() - started }));
    };
    const timer = setTimeout(() => finish("TIMEOUT", "Der Spielport hat nicht rechtzeitig geantwortet."), config.statusTimeoutMs);
    timer.unref?.();
    // TCP proves that this address and port are reachable, but it does not
    // prove a particular game protocol. Keep that distinction in the UI.
    socket.once("connect", () => finish("REACHABLE", "Der Spielport ist per TCP erreichbar."));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? "CONNECTION_REFUSED" : "QUERY_FAILED", error?.code === "ECONNREFUSED" ? "Der Spielport ist geschlossen." : "Die TCP-Verbindung konnte nicht hergestellt werden."));
  });
}

async function udpProbe(address, port, payload) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = createSocket(isIP(address) === 6 ? "udp6" : "udp4");
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(stamp("TIMEOUT", "Die UDP-Abfrage hat nicht geantwortet.")), config.statusTimeoutMs);
    timer.unref?.();
    socket.once("error", () => finish(stamp("QUERY_FAILED", "Die UDP-Abfrage konnte nicht ausgeführt werden.")));
    socket.once("message", (message) => {
      if (message.length > maximumUdpResponseBytes) return finish(stamp("QUERY_FAILED", "Die Steam-Antwort ist zu groß."));
      finish(stamp("ONLINE", "Der Server antwortet auf die Steam-Abfrage.", { latencyMs: Date.now() - started, response: message }));
    });
    socket.send(payload, port, address, (error) => { if (error) finish(stamp("QUERY_FAILED", "Die UDP-Abfrage konnte nicht gesendet werden.")); });
  });
}

function readCString(buffer, cursor) {
  const end = buffer.indexOf(0, cursor);
  if (end < 0) return { value: "", next: buffer.length };
  return { value: buffer.subarray(cursor, end).toString("utf8"), next: end + 1 };
}

function steamInfo(message) {
  if (!message || message.length < 6 || message[4] !== 0x49) return {};
  let cursor = 6;
  const name = readCString(message, cursor); cursor = name.next;
  const map = readCString(message, cursor); cursor = map.next;
  const folder = readCString(message, cursor); cursor = folder.next;
  const game = readCString(message, cursor); cursor = game.next;
  if (cursor + 4 > message.length) return { map: map.value || null };
  cursor += 2;
  const players = message[cursor++];
  const maxPlayers = message[cursor++];
  cursor += 5;
  const version = readCString(message, cursor).value;
  return { players: Number.isInteger(players) ? players : null, maxPlayers: Number.isInteger(maxPlayers) ? maxPlayers : null, map: map.value || null, version: version || null, serverName: name.value || null, game: game.value || null };
}

async function steamProbe(address, port) {
  const payload = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from("Source Engine Query\0")]);
  const first = await udpProbe(address, port, payload);
  if (first.state !== "ONLINE") return first;
  if (first.response?.[4] === 0x41 && first.response.length >= 9) {
    const challengedPayload = Buffer.concat([payload, first.response.subarray(5, 9)]);
    const second = await udpProbe(address, port, challengedPayload);
    return second.state === "ONLINE" ? { ...second, ...steamInfo(second.response), response: undefined } : second;
  }
  return { ...first, ...steamInfo(first.response), response: undefined };
}

function writeVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  do { const next = current & 0x7f; current >>>= 7; bytes.push(current ? next | 0x80 : next); } while (current);
  return Buffer.from(bytes);
}

function readVarInt(buffer, start = 0) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const offset = start + index;
    if (offset >= buffer.length) return null;
    const byte = buffer[offset];
    value |= (byte & 0x7f) << (7 * index);
    if (!(byte & 0x80)) return { value, next: offset + 1 };
  }
  return { invalid: true };
}

function minecraftPacket(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function minecraftResponse(buffer) {
  const packetLength = readVarInt(buffer);
  if (!packetLength || packetLength.invalid || buffer.length < packetLength.next + packetLength.value) return null;
  const id = readVarInt(buffer, packetLength.next);
  if (!id || id.invalid || id.value !== 0) return { invalid: true };
  const textLength = readVarInt(buffer, id.next);
  if (!textLength || textLength.invalid || textLength.value > 64_000 || buffer.length < textLength.next + textLength.value) return null;
  try { return JSON.parse(buffer.subarray(textLength.next, textLength.next + textLength.value).toString("utf8")); } catch { return { invalid: true }; }
}

async function minecraftProbe(address, port, requestedHost = address) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = connect({ host: address, port });
    const finish = (state, detail, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(stamp(state, detail, { latencyMs: Date.now() - started, ...extra }));
    };
    const timer = setTimeout(() => finish("TIMEOUT", "Die Minecraft-Statusabfrage hat nicht rechtzeitig geantwortet."), config.statusTimeoutMs);
    timer.unref?.();
    socket.once("error", () => finish("QUERY_FAILED", "Die Minecraft-Statusabfrage konnte nicht hergestellt werden."));
    socket.once("connect", () => {
      const hostname = Buffer.from(String(requestedHost).slice(0, 253), "utf8");
      const portValue = Buffer.alloc(2); portValue.writeUInt16BE(port);
      const handshake = Buffer.concat([writeVarInt(760), writeVarInt(hostname.length), hostname, portValue, writeVarInt(1)]);
      socket.write(minecraftPacket(0, handshake));
      socket.write(minecraftPacket(0, Buffer.alloc(0)));
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 65_536) return finish("QUERY_FAILED", "Die Minecraft-Statusantwort ist zu groß.");
      const result = minecraftResponse(received);
      if (!result) return;
      if (result.invalid) return finish("QUERY_FAILED", "Die Antwort ist keine Minecraft-Statusantwort.");
      const players = Number.isInteger(result.players?.online) ? result.players.online : null;
      const maxPlayers = Number.isInteger(result.players?.max) ? result.players.max : null;
      const version = typeof result.version?.name === "string" ? result.version.name.slice(0, 120) : null;
      finish("ONLINE", "Der Minecraft-Java-Server antwortet auf die Statusabfrage.", { players, maxPlayers, version });
    });
  });
}

async function teamSpeakProbe(address, voicePort, queryPort) {
  return new Promise((resolve) => {
    let settled = false;
    let selected = false;
    let response = "";
    const started = Date.now();
    const socket = connect({ host: address, port: queryPort || 10011 });
    const finish = (state, detail, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(stamp(state, detail, { latencyMs: Date.now() - started, ...extra }));
    };
    const timer = setTimeout(() => finish("TIMEOUT", "Der TeamSpeak-ServerQuery-Port antwortet nicht."), config.statusTimeoutMs);
    timer.unref?.();
    socket.once("error", () => finish("QUERY_FAILED", "Der TeamSpeak-ServerQuery-Port ist nicht erreichbar."));
    socket.on("data", (chunk) => {
      if (Buffer.byteLength(response) + chunk.length > maximumTeamSpeakResponseBytes) return finish("QUERY_FAILED", "Die TeamSpeak-Antwort ist zu groß.");
      response += chunk.toString("utf8");
      if (!selected && /TS3|TeamSpeak/i.test(response)) {
        selected = true; response = ""; socket.write(`use port=${voicePort}\nclientlist\n`); return;
      }
      if (!selected || !/error id=\d+/.test(response)) return;
      if (/error id=0 msg=ok/.test(response)) {
        const clients = (response.match(/(?:^|\|)clid=/gm) || []).length;
        finish("ONLINE", "Der TeamSpeak-Voice-Server antwortet auf ServerQuery.", { players: clients, maxPlayers: null });
      } else finish("OFFLINE", "ServerQuery läuft, aber der konfigurierte Voice-Port ist nicht aktiv.");
    });
  });
}

const providers = {
  tcp: (address, target) => tcpProbe(address, target.port),
  steam: (address, target) => steamProbe(address, target.port),
  minecraft: (address, target) => minecraftProbe(address, target.port, target.host),
  teamspeak: (address, target) => teamSpeakProbe(address, target.port, target.teamSpeakQueryPort)
};

async function checkConnection(server, allowPrivateNetworks) {
  if (server.visibility === "maintenance") return stamp("MAINTENANCE", "Der Server befindet sich im Wartungsmodus.");
  if (server.visibility === "disabled" || server.monitoring?.enabled === false) return stamp("DISABLED", "Die Überwachung ist deaktiviert.");
  const target = server.monitoringTarget || server.connection;
  if (!target) return stamp("UNKNOWN", "Keine Monitoring-Adresse hinterlegt.");
  let address;
  try { address = await resolveSafeTarget(target.host, allowPrivateNetworks); }
  catch (error) { return stamp(error.code === "DNS_ERROR" ? "DNS_ERROR" : "QUERY_UNSUPPORTED", error.message); }
  const profile = target.profile || "auto";
  if (profile === "tcp") return tcpProbe(address, target.port);
  if (["steam", "minecraft", "teamspeak"].includes(profile)) {
    const primary = await providers[profile](address, target);
    if (primary.state === "ONLINE") return primary;
    // A protocol reply is ideal because it yields game data. A completed TCP
    // handshake is still a real measured reachability result and must never
    // be shown as "unknown" merely because the richer protocol failed.
    const reachablePort = profile === "teamspeak" ? (target.teamSpeakQueryPort || 10011) : target.port;
    const fallback = await tcpProbe(address, reachablePort);
    return fallback.state === "REACHABLE" ? fallback : primary;
  }
  const tcpPromise = tcpProbe(address, target.port);
  const steamPromise = steamProbe(address, target.port);
  const minecraftPromise = minecraftProbe(address, target.port, target.host);
  const teamSpeakPromise = target.teamSpeakQueryPort || (target.port >= 9987 && target.port <= 9999)
    ? teamSpeakProbe(address, target.port, target.teamSpeakQueryPort) : null;
  const [steam, minecraft, tcp, teamSpeak] = await Promise.all([steamPromise, minecraftPromise, tcpPromise, teamSpeakPromise]);
  if (teamSpeak?.state === "ONLINE") return teamSpeak;
  if (steam.state === "ONLINE") return steam;
  if (minecraft.state === "ONLINE") return minecraft;
  if (tcp.state === "REACHABLE") return tcp;
  if (tcp.state === "CONNECTION_REFUSED") return tcp;
  return steam.state !== "TIMEOUT" ? steam : minecraft.state !== "TIMEOUT" ? minecraft : tcp;
}

export class StatusMonitor {
  constructor(store, options, onChange = async () => {}, onObservation = async () => {}) {
    this.store = store;
    this.options = options;
    this.onChange = onChange;
    this.onObservation = onObservation;
    this.running = null;
    this.stopped = false;
  }

  async refresh() {
    if (this.stopped) return;
    if (this.running) return this.running;
    this.running = (async () => {
      const servers = this.store.allServers();
      await mapLimit(servers, this.options.maxParallelChecks, (server) => this.refreshServer(server));
      this.store.cleanup({ activityMs: this.options.activityRetentionMs, historyMs: this.options.historyRetentionMs });
    })();
    try { return await this.running; } finally { this.running = null; }
  }

  async refreshServer(server, force = false) {
    const previous = this.store.getStatus(server.id);
    const intervalMs = Math.max(30, Number(server.monitoring?.intervalSeconds) || 30) * 1000;
    if (!force && previous?.checked_at && Date.now() - Date.parse(previous.checked_at) < intervalMs) return this.store.statusRow(previous);
    const status = await checkConnection(server, this.options.allowPrivateNetworks);
    const saved = this.store.saveStatus(server.id, status);
    const healthy = new Set(["ONLINE", "REACHABLE"]);
    const changedToOffline = healthy.has(saved.previous?.state) && !healthy.has(saved.current.state);
    const changedToOnline = saved.previous && !healthy.has(saved.previous.state) && healthy.has(saved.current.state);
    if (changedToOffline || changedToOnline) await this.onChange(server, saved.current, changedToOffline ? "offline" : "recovered");
    await this.onObservation(server, saved.current, saved);
    return saved.current;
  }

  stop() { this.stopped = true; }
}
