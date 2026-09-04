import { connect, isIP } from "node:net";
import { createSocket } from "node:dgram";
import { config } from "./config.mjs";
import { resolveSafeTarget } from "./security.mjs";

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
    socket.once("connect", () => finish("ONLINE", "Der Spielport antwortet."));
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
    socket.once("message", (message) => finish(stamp("ONLINE", "Der Server antwortet auf die Steam-Abfrage.", { latencyMs: Date.now() - started, response: message })));
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

async function checkConnection(server, allowPrivateNetworks) {
  if (server.visibility === "maintenance") return stamp("MAINTENANCE", "Der Server befindet sich im Wartungsmodus.");
  if (server.visibility === "disabled" || server.monitoring?.enabled === false) return stamp("DISABLED", "Die Überwachung ist deaktiviert.");
  if (!server.connection) return stamp("UNKNOWN", "Keine Spielserver-Adresse hinterlegt.");
  let address;
  try { address = await resolveSafeTarget(server.connection.host, allowPrivateNetworks); }
  catch (error) { return stamp(error.code === "DNS_ERROR" ? "DNS_ERROR" : "QUERY_UNSUPPORTED", error.message); }
  const profile = server.connection.profile || "auto";
  if (profile === "teamspeak") return teamSpeakProbe(address, server.connection.port, server.connection.teamSpeakQueryPort);
  const tcp = await tcpProbe(address, server.connection.port);
  if (profile === "tcp") return tcp;
  const steam = await steamProbe(address, server.connection.port);
  if (steam.state === "ONLINE") return steam;
  if (profile === "steam") return tcp.state === "ONLINE" ? tcp : steam;
  if (server.connection.teamSpeakQueryPort || (server.connection.port >= 9987 && server.connection.port <= 9999)) {
    const teamSpeak = await teamSpeakProbe(address, server.connection.port, server.connection.teamSpeakQueryPort);
    if (teamSpeak.state === "ONLINE") return teamSpeak;
  }
  return tcp.state === "ONLINE" ? tcp : steam.state === "TIMEOUT" ? tcp : steam;
}

export class StatusMonitor {
  constructor(store, options, onChange = async () => {}) {
    this.store = store;
    this.options = options;
    this.onChange = onChange;
    this.running = null;
  }

  async refresh() {
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
    const changedToOffline = saved.previous?.state === "ONLINE" && ["OFFLINE", "TIMEOUT", "CONNECTION_REFUSED"].includes(saved.current.state);
    const changedToOnline = saved.previous && ["OFFLINE", "TIMEOUT", "CONNECTION_REFUSED"].includes(saved.previous.state) && saved.current.state === "ONLINE";
    if (changedToOffline || changedToOnline) await this.onChange(server, saved.current, changedToOffline ? "offline" : "recovered");
    return saved.current;
  }
}
