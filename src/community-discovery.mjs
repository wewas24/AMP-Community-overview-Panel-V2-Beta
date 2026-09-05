import { request } from "node:https";
import { isIP } from "node:net";
import { resolveSafeTarget } from "./security.mjs";
import { config } from "./config.mjs";
import { cleanText, httpsUrl, validHost } from "./validation.mjs";

const maximumBytes = 1_000_000;
const maximumCandidates = 12;
const timeoutMs = 8_000;
const lastRequests = new Map();

function decodeHtml(value) {
  return String(value || "")
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function textOnly(value) {
  return decodeHtml(String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function hostAndPort(host, port) {
  const normalizedHost = String(host || "").trim().replace(/^\[|\]$/g, "");
  const numericPort = Number(port);
  if (!validHost(normalizedHost) || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) return null;
  return { host: normalizedHost, port: numericPort };
}

export function endpointFromText(value) {
  const source = decodeHtml(String(value || "").trim()).replace(/^\/+|\/+$/g, "");
  const ipv6 = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(source);
  const standard = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i.exec(source);
  const match = ipv6 || standard;
  return match ? hostAndPort(match[1], match[2]) : null;
}

function profileFromText(value) {
  const source = String(value || "").toLowerCase();
  if (/(?:teamspeak|ts3|ts5)/.test(source)) return "teamspeak";
  if (/(?:minecraft|mc-java|java edition)/.test(source)) return "minecraft";
  if (/(?:steam|source engine|a2s|arma|ark|rust|valheim|palworld|satisfactory|cs2|counter.?strike)/.test(source)) return "steam";
  return "auto";
}

function applicationFromProfile(profile, context = "") {
  const source = String(context || "").toLowerCase();
  if (/(?:teamspeak|ts3|ts5)/.test(source) || profile === "teamspeak") return "TeamSpeak";
  if (/(?:minecraft|mc-java|java edition)/.test(source) || profile === "minecraft") return "Minecraft Java";
  if (/(?:arma)/.test(source)) return "Arma / Steam";
  if (/(?:steam|source engine|a2s|ark|rust|valheim|palworld|satisfactory|cs2|counter.?strike)/.test(source) || profile === "steam") return "Steam / Source";
  return "";
}

function confidenceFromScore(score) {
  if (score >= 90) return "high";
  if (score >= 55) return "medium";
  return "low";
}

function addCandidate(list, connection, options = {}) {
  if (!connection?.host || !connection?.port) return;
  const profile = options.profile || connection.profile || profileFromText(options.context);
  const item = {
    connection: { host: connection.host, port: connection.port, profile },
    connectUrl: options.connectUrl || "",
    source: options.source || "Adresse auf der Community-Seite",
    score: Number(options.score) || 0,
    application: options.application || applicationFromProfile(profile, options.context),
    confidence: confidenceFromScore(Number(options.score) || 0)
  };
  const key = `${item.connection.host.toLowerCase()}:${item.connection.port}`;
  const existing = list.find((candidate) => `${candidate.connection.host.toLowerCase()}:${candidate.connection.port}` === key);
  if (!existing) { list.push(item); return; }
  if (item.score > existing.score || (item.connectUrl && !existing.connectUrl)) Object.assign(existing, item);
}

export function endpointFromConnectLink(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "steam:" && url.hostname.toLowerCase() === "connect") {
      const connection = endpointFromText(decodeURIComponent(url.pathname.replace(/^\/+/, "")));
      return connection ? { connection: { ...connection, profile: "steam" }, connectUrl: url.toString(), source: "Steam-Verbindungslink", application: "Steam / Source" } : null;
    }
    if (url.protocol === "ts3server:") {
      const connection = hostAndPort(url.hostname, url.searchParams.get("port") || url.port || 9987);
      return connection ? { connection: { ...connection, profile: "teamspeak" }, connectUrl: url.toString(), source: "TeamSpeak-Verbindungslink", application: "TeamSpeak" } : null;
    }
    if (url.protocol === "minecraft:") {
      const address = url.searchParams.get("addExternalServer")?.split("|").at(-1) || `${url.hostname}${url.port ? `:${url.port}` : ""}`;
      const connection = endpointFromText(address);
      return connection ? { connection: { ...connection, profile: "minecraft" }, connectUrl: url.toString(), source: "Minecraft-Verbindungslink", application: "Minecraft Java" } : null;
    }
  } catch { /* not a supported connection URL */ }
  return null;
}

function firstTitle(html) {
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  return cleanText(textOnly(heading).replace(/\s*[|–-]\s*(AMP|Community).*$/i, ""), "", 70);
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return decodeHtml(match?.[1] || match?.[2] || match?.[3] || "");
}

function endpointCandidates(value) {
  const source = decodeHtml(String(value || ""));
  const pattern = /(?:\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}):\d{1,5}/gi;
  const found = [];
  for (const match of source.matchAll(pattern)) {
    const connection = endpointFromText(match[0]);
    if (connection) found.push({ connection, index: match.index || 0, raw: match[0] });
  }
  return found;
}

function likelyCommunityEndpoint(connection, communityUrl, context) {
  const url = new URL(communityUrl);
  const sameHost = connection.host.toLowerCase() === url.hostname.toLowerCase();
  const httpsPort = Number(url.port || 443);
  return sameHost && connection.port === httpsPort && !/(?:connect|verbinden|join|spiel|game|server.?adresse|ip.?adresse|port)/i.test(context);
}

function scanAttributeCandidates(source, communityUrl, candidates) {
  const tags = source.match(/<(?:a|button|div|span|input|meta)[^>]*>/gi) || [];
  for (const tag of tags) {
    const context = `${tag} ${attribute(tag, "title")} ${attribute(tag, "aria-label")}`;
    const profile = profileFromText(context);
    for (const field of ["data-connect", "data-connection", "data-address", "data-server", "data-endpoint", "data-ip", "data-host", "value", "content"]) {
      const raw = attribute(tag, field);
      const link = endpointFromConnectLink(raw);
      if (link) addCandidate(candidates, link.connection, { ...link, score: 94, context });
      for (const item of endpointCandidates(raw)) {
        if (!likelyCommunityEndpoint(item.connection, communityUrl, context)) addCandidate(candidates, item.connection, { profile, source: "Datenfeld auf der Community-Seite", score: 76, context });
      }
    }
    const host = attribute(tag, "data-host") || attribute(tag, "data-address") || attribute(tag, "data-server") || attribute(tag, "data-ip");
    const port = attribute(tag, "data-port") || attribute(tag, "data-game-port") || attribute(tag, "data-query-port");
    const connection = hostAndPort(host, port);
    if (connection && !likelyCommunityEndpoint(connection, communityUrl, context)) addCandidate(candidates, connection, { profile, source: "Datenfelder auf der Community-Seite", score: 82, context });
  }
}

function scanJson(value, communityUrl, candidates, context = "", depth = 0, visited = { count: 0 }) {
  if (depth > 6 || visited.count++ > 500 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const link = endpointFromConnectLink(value);
    if (link) addCandidate(candidates, link.connection, { ...link, score: 92, context: `${context} ${value}` });
    for (const item of endpointCandidates(value)) if (!likelyCommunityEndpoint(item.connection, communityUrl, `${context} ${value}`)) addCandidate(candidates, item.connection, { profile: profileFromText(`${context} ${value}`), source: "Seitendaten der Community-Seite", score: 72, context: `${context} ${value}` });
    return;
  }
  if (Array.isArray(value)) { value.slice(0, 100).forEach((item) => scanJson(item, communityUrl, candidates, context, depth + 1, visited)); return; }
  if (typeof value !== "object") return;
  const host = value.host || value.hostname || value.ip || value.address || value.server || value.serverAddress || value.endpoint;
  const port = value.port || value.gamePort || value.queryPort || value.serverPort;
  const connection = hostAndPort(host, port);
  const nextContext = `${context} ${Object.keys(value).join(" ")} ${value.name || ""} ${value.type || ""}`;
  if (connection && !likelyCommunityEndpoint(connection, communityUrl, nextContext)) addCandidate(candidates, connection, { profile: profileFromText(nextContext), source: "Seitendaten der Community-Seite", score: 84, context: nextContext });
  Object.values(value).slice(0, 100).forEach((item) => scanJson(item, communityUrl, candidates, nextContext, depth + 1, visited));
}

function scanEmbeddedJson(source, communityUrl, candidates) {
  const scripts = source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const body = script[1]?.trim() || "";
    if (!body || body.length > 512_000 || !/^[{[]/.test(body)) continue;
    try { scanJson(JSON.parse(body), communityUrl, candidates); } catch { /* page script is not JSON */ }
  }
}

export function extractCommunityData(html, communityUrl) {
  const source = String(html || "");
  const candidates = [];
  const links = [...source.matchAll(/\bhref\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))/gi)];
  for (const link of links) {
    const raw = decodeHtml(link[1] || link[2] || link[3] || "");
    const found = endpointFromConnectLink(raw);
    if (found) addCandidate(candidates, found.connection, { ...found, score: 100, context: raw });
  }
  scanAttributeCandidates(source, communityUrl, candidates);
  scanEmbeddedJson(source, communityUrl, candidates);

  const content = textOnly(source);
  for (const item of endpointCandidates(content)) {
    const context = content.slice(Math.max(0, item.index - 160), item.index + item.raw.length + 160);
    if (likelyCommunityEndpoint(item.connection, communityUrl, context)) continue;
    const explicit = /(?:connect|verbinden|join|server.?adresse|ip.?adresse|spielserver|game.?server|port)/i.test(context);
    addCandidate(candidates, item.connection, { profile: profileFromText(context), source: explicit ? "Spieladresse auf der Community-Seite" : "Adresse auf der Community-Seite", score: explicit ? 64 : 42, context });
  }

  const ordered = candidates.sort((left, right) => right.score - left.score).slice(0, maximumCandidates);
  const best = ordered[0];
  if (!best) return { found: false, title: firstTitle(source), application: "", confidence: "none", connection: null, connectUrl: "", source: "Auf der Community-Seite wurde keine Spieladresse gefunden", candidates: [] };
  return { found: true, title: firstTitle(source), application: best.application, confidence: best.confidence, connection: best.connection, connectUrl: best.connectUrl, source: best.source, candidates: ordered.map(({ score, ...candidate }) => candidate) };
}

function allowedCommunityDomain(communityUrl, trustedDomains = []) {
  const domains = Array.isArray(trustedDomains) ? trustedDomains : [];
  if (!domains.length) return true;
  const host = new URL(communityUrl).hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function readPublicPage(rawUrl, allowPrivateNetworks) {
  const communityUrl = httpsUrl(rawUrl, "Die AMP-Community-Adresse", false);
  const url = new URL(communityUrl);
  const port = Number(url.port || 443);
  if (!config.communityAllowedPorts.has(port)) throw new Error("Der HTTPS-Port der Community-Seite ist nicht freigegeben.");
  const address = await resolveSafeTarget(url.hostname, allowPrivateNetworks);
  const family = isIP(address);
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    const requestOptions = {
      protocol: "https:", hostname: url.hostname, port, path: `${url.pathname}${url.search}`,
      method: "GET", maxHeaderSize: 8_192,
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity", "User-Agent": "AMP-Community-Dashboard/2.4.0" },
      servername: isIP(url.hostname) ? undefined : url.hostname,
      // Node requests custom lookups with { all: true }. Returning a pinned
      // literal address in that form prevents a second DNS lookup and closes
      // the DNS-rebinding window immediately before the TLS connection.
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)
    };
    const pending = request(requestOptions, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return reject(new Error("Die Community-Seite leitet weiter. Bitte die endgültige HTTPS-Adresse eintragen.")); }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`Die Community-Seite antwortet mit HTTP ${response.statusCode || "Fehler"}.`)); }
      const type = String(response.headers["content-type"] || "").toLowerCase();
      if (type && !type.includes("text/html") && !type.includes("application/xhtml+xml")) { response.resume(); return reject(new Error("Die Adresse liefert keine HTML-Community-Seite.")); }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > maximumBytes) { response.destroy(); return reject(new Error("Die Community-Seite ist für die automatische Prüfung zu groß.")); }
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maximumBytes) { response.destroy(new Error("Die Community-Seite ist für die automatische Prüfung zu groß.")); return; }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    pending.once("error", (error) => reject(error?.message === "Zeitüberschreitung beim Abrufen der Community-Seite." ? error : new Error("Die öffentliche Community-Seite konnte nicht abgerufen werden.")));
    pending.setTimeout(timeoutMs, () => pending.destroy(new Error("Zeitüberschreitung beim Abrufen der Community-Seite.")));
    pending.end();
  });
}

export async function discoverCommunity(communityUrl, allowPrivateNetworks, trustedDomains = []) {
  const canonical = httpsUrl(communityUrl, "Die AMP-Community-Adresse", false);
  if (!allowedCommunityDomain(canonical, trustedDomains)) throw new Error("Diese Community-Domain ist nicht in den vertrauenswürdigen Domains freigegeben.");
  const last = lastRequests.get(canonical) || 0;
  if (Date.now() - last < 5_000) throw new Error("Bitte vor einer weiteren automatischen Prüfung kurz warten.");
  lastRequests.set(canonical, Date.now());
  const html = await readPublicPage(canonical, allowPrivateNetworks);
  return { ...extractCommunityData(html, canonical), communityUrl: canonical };
}
