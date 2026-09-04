import { request } from "node:https";
import { isIP } from "node:net";
import { resolveSafeTarget } from "./security.mjs";
import { config } from "./config.mjs";
import { cleanText, httpsUrl, validHost } from "./validation.mjs";

const maximumBytes = 1_000_000;
const timeoutMs = 8_000;
const lastRequests = new Map();

function decodeHtml(value) {
  return String(value || "").replace(/&(?:amp|#38);/gi, "&").replace(/&(?:quot|#34);/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");
}

function textOnly(value) {
  return decodeHtml(String(value || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export function endpointFromText(value) {
  const source = decodeHtml(String(value || "").trim()).replace(/^\/+|\/+$/g, "");
  const ipv6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/i.exec(source);
  const standard = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i.exec(source);
  const match = ipv6 || standard;
  if (!match) return null;
  const host = match[1];
  const port = Number(match[2]);
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function endpointFromConnectLink(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "steam:" && url.hostname.toLowerCase() === "connect") {
      const connection = endpointFromText(decodeURIComponent(url.pathname.replace(/^\/+/, "")));
      return connection ? { connection: { ...connection, profile: "steam" }, connectUrl: url.toString(), source: "Steam-Verbindungslink" } : null;
    }
    if (url.protocol === "ts3server:") {
      const host = url.hostname;
      const port = Number(url.searchParams.get("port") || url.port || 9987);
      if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      return { connection: { host, port, profile: "teamspeak" }, connectUrl: url.toString(), source: "TeamSpeak-Verbindungslink" };
    }
    if (url.protocol === "minecraft:") {
      const address = url.searchParams.get("addExternalServer")?.split("|").at(-1) || `${url.hostname}${url.port ? `:${url.port}` : ""}`;
      const connection = endpointFromText(address);
      return connection ? { connection: { ...connection, profile: "minecraft" }, connectUrl: url.toString(), source: "Minecraft-Verbindungslink" } : null;
    }
  } catch { /* not a supported connection URL */ }
  return null;
}

function firstTitle(html) {
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  return cleanText(textOnly(heading).replace(/\s*[|–-]\s*(AMP|Community).*$/i, ""), "", 70);
}

export function extractCommunityData(html, communityUrl) {
  const source = String(html || "");
  const links = [...source.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  for (const link of links) {
    const raw = decodeHtml(link[1] || link[2] || link[3] || "");
    const found = endpointFromConnectLink(raw);
    if (found) return { found: true, title: firstTitle(source), confidence: "high", ...found };
  }

  const content = textOnly(source);
  const pattern = /(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}):\d{1,5}/gi;
  for (const match of content.matchAll(pattern)) {
    const position = match.index || 0;
    const context = content.slice(Math.max(0, position - 120), position + match[0].length + 120).toLowerCase();
    if (!/(connect|verbinden|join|server.?adresse|ip.?adresse|spielserver)/i.test(context)) continue;
    const connection = endpointFromText(match[0]);
    if (connection) return { found: true, title: firstTitle(source), confidence: "medium", connection: { ...connection, profile: "auto" }, connectUrl: "", source: "Adresse auf der Community-Seite" };
  }
  return { found: false, title: firstTitle(source), confidence: "none", connection: null, connectUrl: "", source: "Kein öffentlicher Connect-Link gefunden" };
}

async function readPublicPage(rawUrl, allowPrivateNetworks) {
  const communityUrl = httpsUrl(rawUrl, "Die AMP-Community-Adresse", false);
  const url = new URL(communityUrl);
  const port = Number(url.port || 443);
  if (!config.communityAllowedPorts.has(port)) throw new Error("Der HTTPS-Port der Community-Seite ist nicht freigegeben.");
  const address = await resolveSafeTarget(url.hostname, allowPrivateNetworks);
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    const requestOptions = {
      protocol: "https:", hostname: url.hostname, port, path: `${url.pathname}${url.search}`,
      method: "GET", maxHeaderSize: 8_192, headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity", "User-Agent": "AMP-Community-Dashboard/2.1.1" },
      servername: isIP(url.hostname) ? undefined : url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address) || 4)
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
    pending.once("error", () => reject(new Error("Die öffentliche Community-Seite konnte nicht abgerufen werden.")));
    pending.setTimeout(timeoutMs, () => pending.destroy(new Error("Zeitüberschreitung beim Abrufen der Community-Seite.")));
    pending.end();
  });
}

export async function discoverCommunity(communityUrl, allowPrivateNetworks) {
  const canonical = httpsUrl(communityUrl, "Die AMP-Community-Adresse", false);
  const last = lastRequests.get(canonical) || 0;
  if (Date.now() - last < 5_000) throw new Error("Bitte vor einer weiteren automatischen Prüfung kurz warten.");
  lastRequests.set(canonical, Date.now());
  const html = await readPublicPage(canonical, allowPrivateNetworks);
  return { ...extractCommunityData(html, canonical), communityUrl: canonical };
}
