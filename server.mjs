import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { config, permissions, roles } from "./src/config.mjs";
import { openStore } from "./src/storage.mjs";
import { LoginLimiter, newSessionToken, passwordMatches, passwordRecord, tokenHash } from "./src/security.mjs";
import { cleanText, normalizeServer, normalizeSettings, validPassword, validUsername } from "./src/validation.mjs";
import { StatusMonitor } from "./src/status-monitor.mjs";
import { sendEmail } from "./src/mail.mjs";

const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const limiter = new LoginLimiter();
const store = await openStore();

function publicSettings(settings) {
  return { siteTitle: settings.siteTitle, siteDescription: settings.siteDescription, accentColor: settings.accentColor, defaultDetailRefreshSeconds: settings.defaultDetailRefreshSeconds };
}

function adminSettings(settings) {
  return { ...publicSettings(settings), monitoringIntervalSeconds: settings.monitoringIntervalSeconds, smtp: { host: settings.smtp.host, port: settings.smtp.port, username: settings.smtp.username, from: settings.smtp.from, to: settings.smtp.to, passwordConfigured: Boolean(settings.smtp.password) } };
}

function publicServer(server, status) {
  return {
    id: server.id, slug: server.slug, name: server.name, category: server.category, description: server.description,
    notice: server.notice, visibility: server.visibility, communityUrl: server.communityUrl, iconUrl: server.iconUrl,
    accentColor: server.accentColor, links: server.links, connection: server.connection ? { host: server.connection.host, port: server.connection.port } : null,
    display: server.display, status: status || { state: "UNKNOWN", detail: "Noch nicht geprüft.", checkedAt: null }
  };
}

function adminServer(server, status) { return { ...publicServer(server, status), monitoring: server.monitoring, connection: server.connection, createdAt: server.createdAt, updatedAt: server.updatedAt, sortOrder: server.sortOrder }; }

function frameSources() {
  const origins = new Set();
  for (const server of store.allServers()) {
    try { origins.add(new URL(server.communityUrl).origin); } catch { /* server is validated before storage */ }
  }
  return [...origins].join(" ") || "'none'";
}

function setHeaders(response, frames = "'none'") {
  response.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src ${frames}; img-src 'self' https: data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`);
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function json(response, status, body, headers = {}) { setHeaders(response); response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }); response.end(JSON.stringify(body)); }
function text(response, status, body, headers = {}) { setHeaders(response); response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers }); response.end(body); }
function error(response, status, message) { json(response, status, { error: message }); }

function getCookie(request, name) {
  for (const item of request.headers.cookie?.split(";") || []) { const [key, ...value] = item.trim().split("="); if (key === name) return value.join("="); }
  return null;
}

function sessionCookie(token, seconds = config.sessionMaximumMs / 1000) {
  return [`amp_dashboard_v2_session=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(seconds)}`, config.cookieSecure ? "Secure" : ""].filter(Boolean).join("; ");
}

function requestIp(request) { return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim(); }
function sameOrigin(request) { const protocol = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim() || (config.cookieSecure ? "https" : "http"); return request.headers.origin === `${protocol}://${request.headers.host}`; }

function sessionFrom(request) {
  const token = getCookie(request, "amp_dashboard_v2_session");
  if (!token) return null;
  const active = store.getSession(tokenHash(token), config.sessionIdleMs);
  if (!active) return null;
  const admin = store.getAdmin(active.username);
  return admin ? { token, tokenHash: tokenHash(token), username: admin.username, role: admin.role } : null;
}

function requireSession(request, response, permission = null) {
  const session = sessionFrom(request);
  if (!session) { error(response, 401, "Bitte zuerst anmelden."); return null; }
  if (permission && !permissions[session.role]?.has(permission)) { error(response, 403, "Deine Rolle hat keine Berechtigung für diese Aktion."); return null; }
  return session;
}

async function body(request, maximum = 128_000) {
  let size = 0; const parts = [];
  for await (const part of request) { size += part.length; if (size > maximum) throw new Error("Die Anfrage ist zu groß."); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("Ungültige Eingabe."); }
}

function activityText(entries) {
  const lines = ["AMP Community Dashboard v2.0 – Änderungsprotokoll", `Erstellt: ${new Date().toISOString()}`, "Aufbewahrung: sieben Tage", ""];
  for (const entry of entries) lines.push(`${entry.created_at} · ${entry.username} · ${entry.action}${entry.subject ? ` · ${entry.subject}` : ""}${entry.detail ? ` – ${entry.detail}` : ""}`);
  return `${lines.join("\n")}\n`;
}

async function statusChanged(server, status, kind) {
  const settings = store.getSettings();
  const subject = kind === "offline" ? `Server offline: ${server.name}` : `Server wieder online: ${server.name}`;
  try {
    await sendEmail(settings.smtp, subject, `${subject}\n\nStatus: ${status.detail}\nGeprüft: ${status.checkedAt}`);
    store.addActivity("system", kind === "offline" ? "Ausfall-E-Mail gesendet" : "Wiederherstellungs-E-Mail gesendet", server.name);
  } catch (mailError) {
    console.error("E-Mail-Benachrichtigung fehlgeschlagen:", mailError.message);
    store.addActivity("system", "E-Mail-Benachrichtigung fehlgeschlagen", server.name, "error", mailError.message);
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

async function api(request, response, url) {
  const path = url.pathname;
  if (request.method === "GET" && ["/api/v1/public/servers", "/api/servers"].includes(path)) return json(response, 200, dashboardPayload());
  if (request.method === "GET" && path === "/api/v1/public/statuses") return json(response, 200, { statuses: [...store.allStatuses()].map(([id, status]) => ({ id, status })) });
  if (request.method === "GET" && path === "/api/v1/session") {
    const session = sessionFrom(request);
    return json(response, 200, { authenticated: Boolean(session), username: session?.username || null, role: session?.role || null });
  }
  if (request.method === "POST" && path === "/api/v1/login") {
    const input = await body(request, 8_192); const username = String(input?.username || "").trim(); const ip = requestIp(request);
    const wait = limiter.retryAfter(ip, username);
    if (wait > 0) return json(response, 429, { error: `Zu viele Anmeldeversuche. Bitte in ${wait} Sekunden erneut versuchen.`, retryAfterSeconds: wait }, { "Retry-After": String(wait) });
    const admin = store.getAdmin(username);
    if (!admin || !passwordMatches(String(input?.password || ""), admin)) { limiter.failed(ip, username); store.addActivity("system", "Anmeldung fehlgeschlagen", username, "error"); return error(response, 401, "Benutzername oder Passwort ist nicht korrekt."); }
    limiter.succeeded(ip, username);
    const token = newSessionToken(); store.createSession(tokenHash(token), admin.username, config.sessionIdleMs, config.sessionMaximumMs); store.addActivity(admin.username, "Angemeldet");
    return json(response, 200, { username: admin.username, role: admin.role }, { "Set-Cookie": sessionCookie(token) });
  }
  if (request.method === "POST" && path === "/api/v1/logout") {
    const session = requireSession(request, response); if (!session) return;
    if (!sameOrigin(request)) return error(response, 403, "Ungültige Anfragequelle.");
    store.removeSession(session.tokenHash); store.addActivity(session.username, "Abgemeldet");
    return json(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }
  const match = /^\/api\/v1\/admin(?:\/(.*))?$/.exec(path);
  if (!match) return error(response, 404, "Nicht gefunden.");
  const remainder = match[1] || "";
  const permission = remainder.startsWith("servers") ? "servers" : remainder.startsWith("settings") ? "settings" : remainder.startsWith("notifications") ? "notifications" : remainder.startsWith("admins") ? "access" : remainder.startsWith("activity") ? "logs" : remainder.startsWith("backup") ? "backup" : "dashboard";
  const session = requireSession(request, response, permission); if (!session) return;
  if (request.method !== "GET" && !sameOrigin(request)) return error(response, 403, "Ungültige Anfragequelle.");

  if (request.method === "GET" && remainder === "dashboard") {
    const overview = dashboardPayload();
    return json(response, 200, { ...overview, activity: store.latestActivity(5), uptime: Object.fromEntries(overview.servers.map((server) => [server.id, server.uptime])) });
  }
  if (request.method === "GET" && remainder === "servers") return json(response, 200, { servers: store.allServers().map((server) => adminServer(server, store.allStatuses().get(server.id))) });
  if (request.method === "POST" && remainder === "servers") {
    const input = await body(request); const existing = store.allServers();
    if (existing.length >= 250) return error(response, 400, "Es können maximal 250 Server gespeichert werden.");
    const next = normalizeServer(input, { id: randomUUID() }, existing.length, config.allowPrivateNetworks);
    if (existing.some((server) => server.slug === next.slug)) return error(response, 409, "Dieser Server-Slug ist bereits vergeben.");
    store.saveServer(next); store.addActivity(session.username, "Server erstellt", next.name); void monitor.refreshServer(next, true);
    return json(response, 201, { server: adminServer(next) });
  }
  const serverId = /^servers\/([^/]+)$/.exec(remainder)?.[1];
  if (serverId && request.method === "PATCH") {
    const old = store.findServer(serverId); if (!old) return error(response, 404, "Server nicht gefunden.");
    const next = normalizeServer(await body(request), old, old.sortOrder, config.allowPrivateNetworks);
    if (store.allServers().some((server) => server.id !== old.id && server.slug === next.slug)) return error(response, 409, "Dieser Server-Slug ist bereits vergeben.");
    store.saveServer(next); store.addActivity(session.username, "Server bearbeitet", next.name); void monitor.refreshServer(next, true);
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
    const source = store.findServer(duplicateId); if (!source) return error(response, 404, "Server nicht gefunden.");
    const copy = { ...source, id: randomUUID(), name: `${source.name} Kopie`, slug: `${source.slug}-kopie-${Date.now().toString().slice(-4)}`, sortOrder: store.allServers().length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.saveServer(copy); store.addActivity(session.username, "Server dupliziert", source.name); return json(response, 201, { server: adminServer(copy) });
  }
  const testId = /^servers\/([^/]+)\/test$/.exec(remainder)?.[1];
  if (testId && request.method === "POST") {
    const server = store.findServer(testId); if (!server) return error(response, 404, "Server nicht gefunden.");
    const status = await monitor.refreshServer(server, true); store.addActivity(session.username, "Verbindung getestet", server.name, status.state === "ONLINE" ? "ok" : "error", status.detail); return json(response, 200, { status });
  }
  if (request.method === "GET" && remainder === "settings") return json(response, 200, adminSettings(store.getSettings()));
  if (request.method === "POST" && remainder === "settings") {
    const settings = normalizeSettings(await body(request, 16_384), store.getSettings(), config.defaultSmtpPort); store.saveSettings(settings); store.addActivity(session.username, "Seiteneinstellungen geändert"); return json(response, 200, adminSettings(settings));
  }
  if (request.method === "POST" && remainder === "notifications/test") {
    const settings = store.getSettings(); await sendEmail(settings.smtp, "Test: AMP Community Dashboard v2.0", "Dies ist eine Test-E-Mail vom AMP Community Dashboard v2.0."); store.addActivity(session.username, "E-Mail-Test gesendet"); return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && remainder === "admins") return json(response, 200, { admins: store.listAdmins() });
  if (request.method === "POST" && remainder === "admins") {
    const input = await body(request, 8_192); const username = String(input?.username || "").trim(); const role = roles.has(input?.role) ? input.role : "editor";
    if (!validUsername(username) || !validPassword(input?.password)) return error(response, 400, "Benutzername oder Passwort erfüllt die Anforderungen nicht.");
    if (store.getAdmin(username)) return error(response, 409, "Dieser Benutzername ist bereits vergeben.");
    store.addAdmin({ username, ...passwordRecord(input.password), role, createdAt: new Date().toISOString() }); store.addActivity(session.username, "Administratorkonto erstellt", username); return json(response, 201, { ok: true });
  }
  const adminName = /^admins\/([^/]+)$/.exec(remainder)?.[1];
  if (adminName && request.method === "PATCH") { const input = await body(request); if (!roles.has(input?.role)) return error(response, 400, "Ungültige Rolle."); store.updateAdminRole(decodeURIComponent(adminName), input.role); store.addActivity(session.username, "Administratorrolle geändert", decodeURIComponent(adminName)); return json(response, 200, { ok: true }); }
  if (adminName && request.method === "DELETE") { const name = decodeURIComponent(adminName); if (name === session.username || store.adminCount() <= 1) return error(response, 400, "Dieses Konto kann nicht entfernt werden."); store.removeAdmin(name); store.removeSessionsFor(name); store.addActivity(session.username, "Administratorkonto entfernt", name); return json(response, 200, { ok: true }); }
  if (request.method === "GET" && remainder === "activity") return json(response, 200, { entries: store.latestActivity(5) });
  if (request.method === "GET" && remainder === "activity/download") return text(response, 200, activityText(store.allActivity()), { "Content-Disposition": "attachment; filename=amp-community-dashboard-v2-aenderungsprotokoll.txt" });
  if (request.method === "GET" && remainder === "backup/export") return json(response, 200, store.exportData(), { "Content-Disposition": "attachment; filename=amp-community-dashboard-v2-backup.json" });
  if (request.method === "POST" && remainder === "backup/import") {
    const input = await body(request); if (!Array.isArray(input?.servers)) return error(response, 400, "Die Sicherung enthält keine Serverliste.");
    const before = await store.snapshotBeforeImport(); const oldById = new Map(store.allServers().map((server) => [server.id, server])); const slugs = new Set();
    const imported = input.servers.map((item, index) => { const next = normalizeServer(item, { id: item.id || randomUUID(), createdAt: oldById.get(item.id)?.createdAt }, index, config.allowPrivateNetworks); let slug = next.slug; let number = 2; while (slugs.has(slug)) slug = `${next.slug}-${number++}`; slugs.add(slug); return { ...next, slug }; });
    store.replaceServers(imported); store.addActivity(session.username, "Sicherung importiert", `${imported.length} Server`, "ok", `Vorherige Sicherung: ${before}`); void monitor.refresh(); return json(response, 200, { servers: imported.length, automaticBackup: before });
  }
  return error(response, 404, "Nicht gefunden.");
}

async function staticFile(request, response, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = resolve(config.publicDirectory, `.${requested}`);
  if (!file.startsWith(config.publicDirectory + sep)) return error(response, 403, "Ungültiger Pfad.");
  try {
    const fileInfo = await stat(file); if (!fileInfo.isFile()) throw new Error();
    setHeaders(response, requested === "/index.html" ? frameSources() : "'none'");
    // Dashboard code must update immediately after a server-side update. The
    // browser may cache static files, so always ask it to validate them first.
    response.writeHead(200, { "Content-Type": contentTypes[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (request.method === "HEAD") return response.end(); createReadStream(file).pipe(response);
  } catch { error(response, 404, "Nicht gefunden."); }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else if (["GET", "HEAD"].includes(request.method || "")) await staticFile(request, response, url);
    else error(response, 405, "Methode nicht erlaubt.");
  } catch (caught) { if (!response.headersSent) error(response, 400, caught.message || "Ungültige Anfrage."); else response.end(); }
});

function scheduleMonitoring() {
  const seconds = Math.max(30, Number(store.getSettings().monitoringIntervalSeconds) || config.defaultMonitorSeconds);
  const timer = setTimeout(async () => { try { await monitor.refresh(); } catch (caught) { console.error("Statusprüfung fehlgeschlagen:", caught); } finally { scheduleMonitoring(); } }, seconds * 1000);
  timer.unref?.();
}
void monitor.refresh();
scheduleMonitoring();
server.listen(config.port, config.host, () => console.log(`AMP Community Dashboard v2.0 läuft auf http://${config.host}:${config.port}`));
