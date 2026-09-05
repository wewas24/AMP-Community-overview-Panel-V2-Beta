import { isIP } from "node:net";
import { isPrivateAddress } from "./security.mjs";

const profiles = new Set(["auto", "tcp", "steam", "teamspeak", "minecraft"]);
const visibilityValues = new Set(["public", "maintenance", "hidden", "disabled"]);

export function cleanText(value, fallback = "", maximum = 255) {
  const text = typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ") : "";
  return (text || fallback).slice(0, maximum);
}

export function validUsername(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{3,32}$/.test(value);
}

export function validPassword(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 512;
}

export function slugify(value) {
  const slug = String(value || "").replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 56);
  return slug || "server";
}

export function validHost(value) {
  const host = String(value || "").trim().replace(/^\[|\]$/g, "");
  return isIP(host) || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}

export function connectionFromInput(input, allowPrivateNetworks) {
  const source = input && typeof input === "object" ? input : {};
  const host = String(source.host || "").trim().replace(/^\[|\]$/g, "");
  const port = Number(source.port);
  if (!host && !source.port) return null;
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Bitte eine gültige Spielserver-Adresse und einen Port zwischen 1 und 65.535 eingeben.");
  if (!allowPrivateNetworks && isIP(host) && isPrivateAddress(host)) throw new Error("Private oder lokale Spielserver-Adressen sind nicht freigegeben.");
  const teamSpeakQueryPort = source.teamSpeakQueryPort === "" || source.teamSpeakQueryPort === null || source.teamSpeakQueryPort === undefined ? null : Number(source.teamSpeakQueryPort);
  if (teamSpeakQueryPort !== null && (!Number.isInteger(teamSpeakQueryPort) || teamSpeakQueryPort < 1 || teamSpeakQueryPort > 65535)) throw new Error("Der TeamSpeak-Query-Port muss zwischen 1 und 65.535 liegen.");
  return { host, port, profile: profiles.has(source.profile) ? source.profile : "auto", teamSpeakQueryPort };
}

export function httpsUrl(value, label, optional = true) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw && optional) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (isIP(url.hostname) && isPrivateAddress(url.hostname))) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} muss eine öffentliche HTTPS-Adresse ohne Zugangsdaten sein.`);
  }
}

export function connectionLink(value, optional = true) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw && optional) return "";
  try {
    const url = new URL(raw);
    // Browser game launchers commonly use their own schemes. Keep the list
    // intentionally small so a stored link can never execute page script.
    if (!["https:", "steam:", "ts3server:", "minecraft:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new Error("Der Verbindungslink muss mit https://, steam://, ts3server:// oder minecraft:// beginnen.");
  }
}

export function emailAddress(value, label, optional = true) {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email && optional) return "";
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) throw new Error(`${label} ist ungültig.`);
  return email;
}

export function normalizeServer(input, existing = {}, sortOrder = 0, allowPrivateNetworks = false) {
  const name = cleanText(input?.name, "", 70);
  if (!name) throw new Error("Der Servername darf nicht leer sein.");
  const slugInput = cleanText(input?.slug, "", 60);
  const linksInput = input?.links && typeof input.links === "object" ? input.links : {};
  const displayInput = input?.display && typeof input.display === "object" ? input.display : {};
  const monitoringInput = input?.monitoring && typeof input.monitoring === "object" ? input.monitoring : {};
  const iconUrl = httpsUrl(input?.iconUrl, "Das Server-Icon", true);
  return {
    id: existing.id,
    name,
    slug: slugify(slugInput || name),
    category: cleanText(input?.category, "Allgemein", 40),
    group: cleanText(input?.group, "", 40),
    description: cleanText(input?.description, "", 300),
    notice: cleanText(input?.notice, "", 240),
    visibility: visibilityValues.has(input?.visibility) ? input.visibility : "public",
    communityUrl: httpsUrl(input?.communityUrl || input?.url, "Die AMP-Community-Adresse", false),
    connectUrl: connectionLink(input?.connectUrl, true),
    iconUrl,
    bannerUrl: typeof input?.bannerUrl === "string" ? (/^\/media\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/i.test(input.bannerUrl) ? input.bannerUrl : "") : existing.bannerUrl || "",
    accentColor: /^#[0-9a-f]{6}$/i.test(input?.accentColor || "") ? input.accentColor : "",
    connection: connectionFromInput(input?.connection || { host: input?.connectionHost, port: input?.connectionPort, profile: input?.profile, teamSpeakQueryPort: input?.teamSpeakQueryPort }, allowPrivateNetworks),
    monitoringTarget: connectionFromInput(input?.monitoringTarget || { host: input?.monitoringHost, port: input?.monitoringPort, profile: input?.monitoringProfile, teamSpeakQueryPort: input?.monitoringTeamSpeakQueryPort }, allowPrivateNetworks) || existing.monitoringTarget || null,
    links: {
      website: httpsUrl(linksInput.website, "Die Webseite", true),
      discord: httpsUrl(linksInput.discord, "Der Discord-Link", true),
      wiki: httpsUrl(linksInput.wiki, "Der Wiki-Link", true),
      map: httpsUrl(linksInput.map, "Der Karten-Link", true),
      modpack: httpsUrl(linksInput.modpack, "Der Modpack-Link", true)
    },
    monitoring: { enabled: monitoringInput.enabled !== false, intervalSeconds: Number.isInteger(Number(monitoringInput.intervalSeconds)) ? Math.min(3600, Math.max(30, Number(monitoringInput.intervalSeconds))) : 30 },
    display: {
      showPlayers: displayInput.showPlayers !== false,
      showPing: displayInput.showPing !== false,
      showVersion: displayInput.showVersion !== false,
      // A game address can be operationally sensitive. It is only sent to
      // visitors after an owner explicitly enables the public connect button.
      showConnect: displayInput.showConnect === true || existing.display?.showConnect === true
    },
    sortOrder,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeSettings(input, previous, defaultSmtpPort) {
  const next = {
    ...previous,
    siteTitle: input?.siteTitle === undefined ? previous.siteTitle : cleanText(input.siteTitle, "Meine Gameserver", 70),
    siteDescription: input?.siteDescription === undefined ? previous.siteDescription : cleanText(input.siteDescription, "", 160),
    accentColor: input?.accentColor === undefined ? previous.accentColor : (/^#[0-9a-f]{6}$/i.test(input.accentColor || "") ? input.accentColor : "#42e8a5"),
    defaultDetailRefreshSeconds: input?.defaultDetailRefreshSeconds === undefined ? previous.defaultDetailRefreshSeconds : Math.max(0, Math.min(3600, Number(input.defaultDetailRefreshSeconds) || 0)),
    monitoringIntervalSeconds: input?.monitoringIntervalSeconds === undefined ? previous.monitoringIntervalSeconds : Math.max(30, Math.min(3600, Number(input.monitoringIntervalSeconds) || 30))
  };
  const smtp = input?.smtp && typeof input.smtp === "object" ? input.smtp : {};
  next.smtp = { ...previous.smtp };
  delete next.smtp.password;
  next.smtpSecret = undefined;
  if (input?.smtp !== undefined) {
    next.smtp.host = smtp.host === undefined ? previous.smtp.host : cleanText(smtp.host, "", 253).replace(/^\[|\]$/g, "");
    next.smtp.port = smtp.port === undefined || smtp.port === "" ? previous.smtp.port : Number(smtp.port);
    next.smtp.username = smtp.username === undefined ? previous.smtp.username : cleanText(smtp.username, "", 253);
    next.smtpSecret = smtp.password === undefined || smtp.password === "" ? undefined : String(smtp.password).slice(0, 512);
    next.smtp.from = smtp.from === undefined ? previous.smtp.from : emailAddress(smtp.from, "Die Absenderadresse", true);
    next.smtp.to = smtp.to === undefined ? previous.smtp.to : emailAddress(smtp.to, "Die Empfängeradresse", true);
    if (next.smtp.host && !validHost(next.smtp.host)) throw new Error("Der SMTP-Server ist ungültig.");
    if (!Number.isInteger(next.smtp.port) || next.smtp.port < 1 || next.smtp.port > 65535) next.smtp.port = defaultSmtpPort;
  }
  const notifications = input?.notifications && typeof input.notifications === "object" ? input.notifications : {};
  next.notifications = {
    ...previous.notifications,
    notifyOffline: notifications.notifyOffline === undefined ? previous.notifications?.notifyOffline !== false : notifications.notifyOffline === true,
    notifyRecovered: notifications.notifyRecovered === undefined ? previous.notifications?.notifyRecovered !== false : notifications.notifyRecovered === true,
    latencyThresholdMs: notifications.latencyThresholdMs === undefined ? previous.notifications?.latencyThresholdMs || 0 : Math.max(0, Math.min(60_000, Number(notifications.latencyThresholdMs) || 0)),
    outageMinutes: notifications.outageMinutes === undefined ? previous.notifications?.outageMinutes || 0 : Math.max(0, Math.min(24 * 60, Number(notifications.outageMinutes) || 0))
  };
  return next;
}
