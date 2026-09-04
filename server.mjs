import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { config, permissions, roles } from "./src/config.mjs";
import { openStore } from "./src/storage.mjs";
import { isTrustedProxyAddress, newSessionToken, passwordMatches, passwordRecord, resolveSafeTarget, secretHash, secureEqual, tokenHash } from "./src/security.mjs";
import { normalizeServer, normalizeSettings, validPassword, validUsername } from "./src/validation.mjs";
import { StatusMonitor } from "./src/status-monitor.mjs";
import { sendEmail } from "./src/mail.mjs";
import { discoverCommunity } from "./src/community-discovery.mjs";

const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const store = await openStore();
const dummyPasswordRecord = await passwordRecord("this-is-not-an-account-password");
const sessionCookieName = config.cookieSecure ? "__Host-amp_dashboard_v2_session" : "amp_dashboard_v2_session";
const publicDirectoryReal = await realpath(config.publicDirectory);

function publicSettings(settings) {
  return { siteTitle: settings.siteTitle, siteDescription: settings.siteDescription, accentColor: settings.accentColor, defaultDetailRefreshSeconds: settings.defaultDetailRefreshSeconds };
}

async function adminSettings(settings) {
  return { ...publicSettings(settings), monitoringIntervalSeconds: settings.monitoringIntervalSeconds, smtp: { host: settings.smtp.host, port: settings.smtp.port, username: settings.smtp.username, from: settings.smtp.from, to: settings.smtp.to, passwordConfigured: await store.smtpPasswordConfigured() } };
}

function publicServer(server, status) {
  // The public overview intentionally never contains an internal host, port or
  // monitoring profile. A connect URI is only supplied after opt-in per card.
  return {
    id: server.id, slug: server.slug, name: server.name, category: server.category, description: server.description,
    notice: server.notice, visibility: server.visibility, communityUrl: server.communityUrl,
    connectUrl: server.display?.showConnect ? server.connectUrl || "" : "", iconUrl: server.iconUrl,
    accentColor: server.accentColor, links: server.links, display: server.display,
    status: status || { state: "UNKNOWN", detail: "Noch nicht geprüft.", checkedAt: null }
  };
}

function adminServer(server, status) {
  return { ...publicServer(server, status), connectUrl: server.connectUrl || "", monitoring: server.monitoring, connection: server.connection, createdAt: server.createdAt, updatedAt: server.updatedAt, sortOrder: server.sortOrder };
}

function frameSources() {
  const origins = new Set(["'self'"]);
  for (const server of store.allServers()) {
    try { origins.add(new URL(server.communityUrl).origin); } catch { /* validated before persistence */ }
  }
  return [...origins].join(" ") || "'none'";
}

function setHeaders(response, frames = "'none'") {
  response.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src ${frames}; img-src 'self' https: data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`);
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

function json(response, status, body, headers = {}) { setHeaders(response); response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }); response.end(JSON.stringify(body)); }
function text(response, status, body, headers = {}) { setHeaders(response); response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers }); response.end(body); }
function error(response, status, message) { json(response, status, { error: message }); }

function getCookie(request, name) {
  for (const item of request.headers.cookie?.split(";") || []) { const [key, ...value] = item.trim().split("="); if (key === name) return value.join("="); }
  return null;
}

function sessionCookie(token, seconds = config.sessionMaximumMs / 1000) {
  return [`${sessionCookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(seconds)}`, config.cookieSecure ? "Secure" : ""].filter(Boolean).join("; ");
}

function clearSessionCookies() {
  return [sessionCookie("", 0), "amp_dashboard_v2_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"];
}

function isTrustedProxy(request) { return isTrustedProxyAddress(request.socket.remoteAddress, config.trustedProxyAddresses); }
function requestIp(request) {
  if (isTrustedProxy(request)) return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
  return String(request.socket.remoteAddress || "unknown");
}
function requestProtocol(request) {
  return isTrustedProxy(request) ? String(request.headers["x-forwarded-proto"] || "https").split(",")[0].trim() : (config.cookieSecure ? "https" : "http");
}
function sameOrigin(request) {
  const origin = String(request.headers.origin || "");
  const host = String(isTrustedProxy(request) ? request.headers["x-forwarded-host"] || request.headers.host : request.headers.host || "").split(",")[0].trim();
  return Boolean(origin && host && secureEqual(origin, `${requestProtocol(request)}://${host}`));
}

function sessionFrom(request) {
  const token = getCookie(request, sessionCookieName);
  if (!token) return null;
  const tokenDigest = tokenHash(token);
  const active = store.getSession(tokenDigest, config.sessionIdleMs);
  if (!active) return null;
  const admin = store.getAdmin(active.username);
  return admin ? { tokenHash: tokenDigest, username: admin.username, role: admin.role, csrfToken: active.csrf_token } : null;
}

function requireSession(request, response, permission = null) {
  const session = sessionFrom(request);
  if (!session) { error(response, 401, "Bitte zuerst anmelden."); return null; }
  if (permission && !permissions[session.role]?.has(permission)) { error(response, 403, "Deine Rolle hat keine Berechtigung für diese Aktion."); return null; }
  return session;
}

function requireMutation(request, response, session) {
  if (!sameOrigin(request) || !secureEqual(request.headers["x-csrf-token"], session.csrfToken)) {
    error(response, 403, "Die Sicherheitsprüfung der Anfrage ist fehlgeschlagen.");
    return false;
  }
  return true;
}

async function body(request, maximum = 128_000) {
  let size = 0; const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > maximum) { request.destroy(); throw new Error("Die Anfrage ist zu groß."); }
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("Ungültige Eingabe."); }
}

function activityText(entries) {
  const lines = ["AMP Community Dashboard v2.1.1 – Änderungsprotokoll", `Erstellt: ${new Date().toISOString()}`, "Aufbewahrung: sieben Tage", ""];
  for (const entry of entries) lines.push(`${entry.created_at} · ${entry.username} · ${entry.action}${entry.subject ? ` · ${entry.subject}` : ""}${entry.detail ? ` – ${entry.detail}` : ""}`);
  return `${lines.join("\n")}\n`;
}

async function smtpSettings() {
  const settings = store.getSettings();
  return { ...settings.smtp, password: await store.getSmtpPassword() };
}

async function statusChanged(server, status, kind) {
  const subject = kind === "offline" ? `Server offline: ${server.name}` : `Server wieder online: ${server.name}`;
  try {
    await sendEmail(await smtpSettings(), subject, `${subject}\n\nStatus: ${status.detail}\nGeprüft: ${status.checkedAt}`);
    store.addActivity("system", kind === "offline" ? "Ausfall-E-Mail gesendet" : "Wiederherstellungs-E-Mail gesendet", server.name);
  } catch {
    store.addActivity("system", "E-Mail-Benachrichtigung fehlgeschlagen", server.name, "error", "Versand oder Sicherheitsprüfung fehlgeschlagen.");
  }
}

const monitor = new StatusMonitor(store, config, statusChanged);

function dashboardPayload() {
  const servers = store.allServers();
  const statuses = store.allStatuses();
  const summary = { total: 0, online: 0, offline: 0, maintenance: 0, unknown: 0, players: 0 };
  for (const server of servers) {
    if (server.visibility === "hidden") continue;
    summary.total += 1;
    const state = statuses.get(server.id)?.state || "UNKNOWN";
    if (state === "ONLINE") summary.online += 1;
    else if (state === "MAINTENANCE") summary.maintenance += 1;
    else if (["OFFLINE", "CONNECTION_REFUSED", "TIMEOUT"].includes(state)) summary.offline += 1;
    else summary.unknown += 1;
    summary.players += Number(statuses.get(server.id)?.players || 0);
  }
  return { summary, servers: servers.filter((server) => server.visibility !== "hidden").map((server) => ({ ...publicServer(server, statuses.get(server.id)), uptime: { day: store.uptime(server.id, 24), week: store.uptime(server.id, 168), month: store.uptime(server.id, 720) } })), settings: publicSettings(store.getSettings()) };
}

function permissionFor(remainder, method) {
  if (remainder === "dashboard") return "dashboard.read";
  if (remainder === "servers" && method === "GET") return "servers.read";
  if (remainder === "servers/discover") return "servers.discover";
  if (/^servers\/[^/]+\/test$/.test(remainder)) return "servers.test";
  if (remainder.startsWith("servers")) return "servers.write";
  if (remainder === "settings") return "settings.write";
  if (remainder === "notifications/test") return "notifications.test";
  if (remainder === "admins" || remainder.startsWith("admins/")) return "access.write";
  if (remainder === "activity") return "logs.read";
  if (remainder === "activity/download") return "logs.export";
  if (remainder === "backup/export") return "backup.export";
  if (remainder === "backup/import") return "backup.import";
  return "dashboard.read";
}

function sameConnection(left, right) {
  const normalize = (value) => value ? { host: value.host || "", port: Number(value.port || 0), profile: value.profile || "auto", teamSpeakQueryPort: Number(value.teamSpeakQueryPort || 0) } : null;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function validateExternalIcon(server) {
  if (!server.iconUrl) return;
  await resolveSafeTarget(new URL(server.iconUrl).hostname, false);
}

async function api(request, response, url) {
  const path = url.pathname;
  if (request.method === "GET" && ["/api/v1/public/servers", "/api/servers"].includes(path)) return json(response, 200, dashboardPayload());
  if (request.method === "GET" && path === "/api/v1/public/statuses") return json(response, 200, { statuses: [...store.allStatuses()].map(([id, status]) => ({ id, status })) });
  if (request.method === "GET" && path === "/api/v1/session") {
    const session = sessionFrom(request);
    return json(response, 200, { authenticated: Boolean(session), username: session?.username || null, role: session?.role || null, csrfToken: session?.csrfToken || null });
  }
  if (request.method === "POST" && path === "/api/v1/login") {
    if (!sameOrigin(request)) return error(response, 403, "Die Sicherheitsprüfung der Anfrage ist fehlgeschlagen.");
    const input = await body(request, 8_192);
    const username = String(input?.username || "").trim();
    const ipHash = secretHash(requestIp(request));
    const usernameHash = secretHash(username.toLowerCase());
    const wait = store.loginRetryAfter(ipHash, usernameHash);
    if (wait > 0) return json(response, 429, { error: `Zu viele Anmeldeversuche. Bitte in ${wait} Sekunden erneut versuchen.`, retryAfterSeconds: wait }, { "Retry-After": String(wait) });
    const account = store.getAdmin(username);
    const valid = await passwordMatches(String(input?.password || ""), account || dummyPasswordRecord);
    if (!account || !valid) { store.recordLoginFailure(ipHash, usernameHash); store.addActivity("system", "Anmeldung fehlgeschlagen", "", "error"); return error(response, 401, "Benutzername oder Passwort ist nicht korrekt."); }
    store.clearLoginFailures(ipHash, usernameHash);
    const token = newSessionToken(); const csrfToken = newSessionToken();
    store.createSession(tokenHash(token), csrfToken, account.username, config.sessionIdleMs, config.sessionMaximumMs);
    store.addActivity(account.username, "Angemeldet");
    return json(response, 200, { username: account.username, role: account.role, csrfToken }, { "Set-Cookie": sessionCookie(token) });
  }
  if (request.method === "POST" && path === "/api/v1/logout") {
    const session = requireSession(request, response); if (!session || !requireMutation(request, response, session)) return;
    store.removeSession(session.tokenHash); store.addActivity(session.username, "Abgemeldet");
    return json(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookies() });
  }
  const match = /^\/api\/v1\/admin(?:\/(.*))?$/.exec(path);
  if (!match) return error(response, 404, "Nicht gefunden.");
  const remainder = match[1] || "";
  const session = requireSession(request, response, permissionFor(remainder, request.method)); if (!session) return;
  if (request.method !== "GET" && !requireMutation(request, response, session)) return;

  if (request.method === "GET" && remainder === "dashboard") {
    const overview = dashboardPayload();
    return json(response, 200, { ...overview, activity: store.latestActivity(5), uptime: Object.fromEntries(overview.servers.map((server) => [server.id, server.uptime])) });
  }
  if (request.method === "GET" && remainder === "servers") return json(response, 200, { servers: store.allServers().map((server) => adminServer(server, store.allStatuses().get(server.id))) });
  if (request.method === "POST" && remainder === "servers") {
    const input = await body(request); const existing = store.allServers();
    if (existing.length >= config.maxServers) return error(response, 400, `Es können maximal ${config.maxServers} Server gespeichert werden.`);
    const next = normalizeServer(input, { id: randomUUID() }, existing.length, config.allowPrivateNetworks);
    if (session.role !== "owner" && next.connection) return error(response, 403, "Nur Vollzugriff darf eine Spielserver-Adresse anlegen oder ändern.");
    await validateExternalIcon(next);
    if (existing.some((server) => server.slug === next.slug)) return error(response, 409, "Dieser Server-Slug ist bereits vergeben.");
    store.saveServer(next); store.addActivity(session.username, "Server erstellt", next.name);
    return json(response, 201, { server: adminServer(next) });
  }
  if (request.method === "POST" && remainder === "servers/discover") {
    const input = await body(request, 8_192);
    const result = await discoverCommunity(input?.communityUrl, config.allowPrivateNetworks);
    store.addActivity(session.username, result.found ? "Spieladresse automatisch ermittelt" : "Keine Spieladresse auf Community-Seite gefunden", "", result.found ? "ok" : "error", result.source);
    return json(response, 200, result);
  }
  const serverId = /^servers\/([^/]+)$/.exec(remainder)?.[1];
  if (serverId && request.method === "PATCH") {
    const old = store.findServer(serverId); if (!old) return error(response, 404, "Server nicht gefunden.");
    const next = normalizeServer(await body(request), old, old.sortOrder, config.allowPrivateNetworks);
    if (session.role !== "owner" && !sameConnection(old.connection, next.connection)) return error(response, 403, "Nur Vollzugriff darf eine Spielserver-Adresse anlegen oder ändern.");
    await validateExternalIcon(next);
    if (store.allServers().some((server) => server.id !== old.id && server.slug === next.slug)) return error(response, 409, "Dieser Server-Slug ist bereits vergeben.");
    store.saveServer(next); store.addActivity(session.username, "Server bearbeitet", next.name);
    return json(response, 200, { server: adminServer(next) });
  }
  if (serverId && request.method === "DELETE") {
    const removed = store.removeServer(serverId); if (!removed) return error(response, 404, "Server nicht gefunden.");
    store.addActivity(session.username, "Server gelöscht", removed.name); return json(response, 200, { ok: true });
  }
  if (request.method === "POST" && remainder === "servers/reorder") {
    const input = await body(request); const servers = store.reorder(Array.isArray(input?.ids) ? input.ids : []); store.addActivity(session.username, "Serverreihenfolge geändert", `${servers.length} Server`); return json(response, 200, { servers });
  }
  const duplicateId = /^servers\/([^/]+)\/duplicate$/.exec(remainder)?.[1];
  if (duplicateId && request.method === "POST") {
    if (session.role !== "owner") return error(response, 403, "Nur Vollzugriff darf Server mit Überwachungsdaten duplizieren.");
    const source = store.findServer(duplicateId); if (!source) return error(response, 404, "Server nicht gefunden.");
    if (store.allServers().length >= config.maxServers) return error(response, 400, `Es können maximal ${config.maxServers} Server gespeichert werden.`);
    const copy = { ...source, id: randomUUID(), name: `${source.name} Kopie`, slug: `${source.slug}-kopie-${Date.now().toString().slice(-4)}`, sortOrder: store.allServers().length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.saveServer(copy); store.addActivity(session.username, "Server dupliziert", source.name); return json(response, 201, { server: adminServer(copy) });
  }
  const testId = /^servers\/([^/]+)\/test$/.exec(remainder)?.[1];
  if (testId && request.method === "POST") {
    const server = store.findServer(testId); if (!server) return error(response, 404, "Server nicht gefunden.");
    const status = await monitor.refreshServer(server, true); store.addActivity(session.username, "Verbindung getestet", server.name, status.state === "ONLINE" ? "ok" : "error"); return json(response, 200, { status });
  }
  if (request.method === "GET" && remainder === "settings") return json(response, 200, await adminSettings(store.getSettings()));
  if (request.method === "POST" && remainder === "settings") {
    const settings = normalizeSettings(await body(request, 16_384), store.getSettings(), config.defaultSmtpPort);
    if (settings.smtpSecret !== undefined) await store.setSmtpPassword(settings.smtpSecret);
    const saved = store.saveSettings(settings); store.addActivity(session.username, "Seiteneinstellungen geändert"); return json(response, 200, await adminSettings(saved));
  }
  if (request.method === "POST" && remainder === "notifications/test") {
    await sendEmail(await smtpSettings(), "Test: AMP Community Dashboard v2.1.1", "Dies ist eine Test-E-Mail vom AMP Community Dashboard v2.1.1.");
    store.addActivity(session.username, "E-Mail-Test gesendet"); return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && remainder === "admins") return json(response, 200, { admins: store.listAdmins() });
  if (request.method === "POST" && remainder === "admins") {
    const input = await body(request, 8_192); const username = String(input?.username || "").trim(); const role = roles.has(input?.role) ? input.role : "editor";
    if (!validUsername(username) || !validPassword(input?.password)) return error(response, 400, "Benutzername oder Passwort erfüllt die Anforderungen nicht.");
    if (store.getAdmin(username)) return error(response, 409, "Dieser Benutzername ist bereits vergeben.");
    store.addAdmin({ username, ...(await passwordRecord(input.password)), role, createdAt: new Date().toISOString() }); store.addActivity(session.username, "Administratorkonto erstellt", username); return json(response, 201, { ok: true });
  }
  const adminName = /^admins\/([^/]+)$/.exec(remainder)?.[1];
  if (adminName && request.method === "PATCH") {
    const name = decodeURIComponent(adminName); const input = await body(request);
    if (name === session.username || !roles.has(input?.role) || !store.getAdmin(name)) return error(response, 400, "Diese Administratorrolle kann nicht geändert werden.");
    store.updateAdminRole(name, input.role); store.removeSessionsFor(name); store.addActivity(session.username, "Administratorrolle geändert", name); return json(response, 200, { ok: true });
  }
  if (adminName && request.method === "DELETE") { const name = decodeURIComponent(adminName); if (name === session.username || store.adminCount() <= 1) return error(response, 400, "Dieses Konto kann nicht entfernt werden."); store.removeAdmin(name); store.removeSessionsFor(name); store.addActivity(session.username, "Administratorkonto entfernt", name); return json(response, 200, { ok: true }); }
  if (request.method === "GET" && remainder === "activity") return json(response, 200, { entries: store.latestActivity(5) });
  if (request.method === "POST" && remainder === "activity/download") { store.addActivity(session.username, "Änderungsprotokoll heruntergeladen"); return text(response, 200, activityText(store.allActivity()), { "Content-Disposition": "attachment; filename=amp-community-dashboard-v2-aenderungsprotokoll.txt" }); }
  if (request.method === "POST" && remainder === "backup/export") { store.addActivity(session.username, "Sicherung heruntergeladen"); return json(response, 200, store.exportData(), { "Content-Disposition": "attachment; filename=amp-community-dashboard-v2-backup.json" }); }
  if (request.method === "POST" && remainder === "backup/import") {
    const input = await body(request, 512_000);
    if (!Array.isArray(input?.servers) || input.servers.length > config.maxServers) return error(response, 400, "Die Sicherung enthält keine zulässige Serverliste.");
    const before = await store.snapshotBeforeImport(); const oldById = new Map(store.allServers().map((server) => [server.id, server])); const slugs = new Set();
    const imported = [];
    for (const [index, item] of input.servers.entries()) { const next = normalizeServer(item, { id: item.id || randomUUID(), createdAt: oldById.get(item.id)?.createdAt }, index, config.allowPrivateNetworks); let slug = next.slug; let number = 2; while (slugs.has(slug)) slug = `${next.slug}-${number++}`; slugs.add(slug); imported.push({ ...next, slug }); }
    store.replaceServers(imported); store.addActivity(session.username, "Sicherung importiert", `${imported.length} Server`, "ok", `Automatische Sicherung: ${before}`);
    // Imported targets are not contacted immediately. The regular, bounded
    // monitoring schedule picks them up, avoiding a bulk network burst.
    return json(response, 200, { servers: imported.length, automaticBackup: before });
  }
  return error(response, 404, "Nicht gefunden.");
}

async function staticFile(request, response, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = resolve(config.publicDirectory, `.${requested}`);
  if (!file.startsWith(config.publicDirectory + sep)) return error(response, 403, "Ungültiger Pfad.");
  try {
    const actualFile = await realpath(file);
    if (!actualFile.startsWith(publicDirectoryReal + sep)) return error(response, 403, "Ungültiger Pfad.");
    const fileInfo = await stat(actualFile); if (!fileInfo.isFile()) throw new Error();
    setHeaders(response, requested === "/index.html" ? frameSources() : "'none'");
    response.writeHead(200, { "Content-Type": contentTypes[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (request.method === "HEAD") return response.end(); createReadStream(actualFile).pipe(response);
  } catch { error(response, 404, "Nicht gefunden."); }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else if (["GET", "HEAD"].includes(request.method || "")) await staticFile(request, response, url);
    else error(response, 405, "Methode nicht erlaubt.");
  } catch (caught) {
    console.error("Anfrage abgewiesen:", caught?.message || caught);
    if (!response.headersSent) error(response, 400, "Die Anfrage konnte nicht verarbeitet werden."); else response.end();
  }
});

server.headersTimeout = config.headersTimeoutMs;
server.requestTimeout = config.requestTimeoutMs;
server.keepAliveTimeout = config.keepAliveTimeoutMs;
server.maxRequestsPerSocket = config.maxRequestsPerSocket;
server.maxConnections = 256;

function scheduleMonitoring() {
  const seconds = Math.max(30, Number(store.getSettings().monitoringIntervalSeconds) || config.defaultMonitorSeconds);
  const timer = setTimeout(async () => { try { await monitor.refresh(); } catch (caught) { console.error("Statusprüfung fehlgeschlagen:", caught?.message || caught); } finally { scheduleMonitoring(); } }, seconds * 1000);
  timer.unref?.();
}
void monitor.refresh();
scheduleMonitoring();
server.listen(config.port, config.host, () => console.log(`AMP Community Dashboard v2.1.1 läuft auf http://${config.host}:${config.port}`));
