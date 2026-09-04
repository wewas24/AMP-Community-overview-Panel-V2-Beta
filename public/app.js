const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const roleLabels = { owner: "Vollzugriff", editor: "Serververwaltung", auditor: "Protokoll ansehen" };
const rolePanels = { owner: ["overview", "servers", "settings", "monitoring", "access", "logs"], editor: ["servers"], auditor: ["logs"] };
let dashboard = { servers: [], settings: {}, summary: {} };
let admin = null;
let managedServers = [];
let activeDetails = null;
let detailTimer = null;
let draggedId = null;

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  return fetch(`api/v1/${path}`, { credentials: "same-origin", ...options, headers });
}

async function message(response) {
  try { return (await response.json()).error || "Die Aktion konnte nicht ausgeführt werden."; } catch { return "Die Aktion konnte nicht ausgeführt werden."; }
}

function text(node, value) { node.textContent = value ?? ""; return node; }
function el(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
function stateInfo(status = {}) {
  const raw = status.state || "UNKNOWN";
  if (raw === "ONLINE") return { label: "Online", className: "online" };
  if (raw === "MAINTENANCE") return { label: "Wartung", className: "maintenance" };
  if (["OFFLINE", "CONNECTION_REFUSED", "TIMEOUT"].includes(raw)) return { label: "Offline", className: "offline" };
  return { label: "Unbekannt", className: "unknown" };
}
function relativeTime(value) {
  if (!value) return "noch nicht geprüft";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `vor ${seconds} Sek.`;
  if (seconds < 3600) return `vor ${Math.round(seconds / 60)} Min.`;
  return `vor ${Math.round(seconds / 3600)} Std.`;
}
function endpoint(server) { return server.connection ? `${server.connection.host}:${server.connection.port}` : ""; }

function applyBranding(settings) {
  text($("#site-title"), settings.siteTitle || "Meine Gameserver");
  text($("#site-description"), settings.siteDescription || "Serverübersicht und AMP-Details");
  document.title = settings.siteTitle || "Meine Gameserver";
  document.documentElement.style.setProperty("--accent", settings.accentColor || "#42e8a5");
}

function updateStats(summary) {
  text($("#stat-total"), summary.total ?? "–"); text($("#stat-online"), summary.online ?? "–"); text($("#stat-offline"), summary.offline ?? "–"); text($("#stat-maintenance"), summary.maintenance ?? "–"); text($("#stat-players"), summary.players ?? "–");
  text($("#live-label"), `Statusstand ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
}

function updateCategories() {
  const select = $("#category-filter"); const previous = select.value; const categories = [...new Set(dashboard.servers.map((server) => server.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  select.replaceChildren(new Option("Alle Kategorien", "all")); categories.forEach((category) => select.add(new Option(category, category))); select.value = categories.includes(previous) ? previous : "all";
}

function visibleServers() {
  const phrase = $("#search").value.trim().toLocaleLowerCase("de"); const category = $("#category-filter").value; const state = $("#status-filter").value;
  const list = dashboard.servers.filter((server) => {
    const searchable = `${server.name} ${server.category} ${server.description}`.toLocaleLowerCase("de");
    return (!phrase || searchable.includes(phrase)) && (category === "all" || server.category === category) && (state === "all" || server.status?.state === state || (state === "OFFLINE" && ["TIMEOUT", "CONNECTION_REFUSED"].includes(server.status?.state)));
  });
  const mode = $("#sort-filter").value;
  return list.sort((a, b) => mode === "name" ? a.name.localeCompare(b.name, "de") : mode === "players" ? Number(b.status?.players || -1) - Number(a.status?.players || -1) : mode === "latency" ? Number(a.status?.latencyMs || 9e9) - Number(b.status?.latencyMs || 9e9) : mode === "status" ? stateInfo(a.status).label.localeCompare(stateInfo(b.status).label, "de") : 0);
}

function metric(label, value) { const box = el("div", "metric"); box.append(el("span", "", label), el("strong", "", value)); return box; }
function linkButton(label, href) { const link = el("a", "button secondary", label); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; return link; }

function serverCard(server) {
  const card = el("article", "server-card"); card.style.setProperty("--card-accent", server.accentColor || "var(--accent)");
  const header = el("header", "card-header"); const ident = el("div", "server-ident");
  const icon = server.iconUrl ? document.createElement("img") : el("span", "server-icon", "◆"); icon.className = "server-icon"; if (server.iconUrl) { icon.src = server.iconUrl; icon.alt = ""; }
  const title = el("div"); title.append(el("h2", "server-name", server.name), el("div", "category", server.category || "Allgemein")); ident.append(icon, title);
  const state = stateInfo(server.status); const badge = el("span", `status ${state.className}`, state.label); badge.title = server.status?.detail || state.label; header.append(ident, badge); card.append(header);
  if (server.description) card.append(el("p", "card-description", server.description));
  if (server.notice) card.append(el("p", "notice", `Hinweis: ${server.notice}`));
  const metrics = el("div", "metrics");
  if (server.display?.showPlayers && server.status?.players !== null && server.status?.players !== undefined) metrics.append(metric("Spieler", `${server.status.players}${server.status.maxPlayers ? ` / ${server.status.maxPlayers}` : ""}`));
  if (server.display?.showPing && server.status?.latencyMs !== null && server.status?.latencyMs !== undefined) metrics.append(metric("Latenz", `${server.status.latencyMs} ms`));
  if (server.display?.showVersion && server.status?.map) metrics.append(metric("Map", server.status.map));
  if (server.display?.showVersion && server.status?.version) metrics.append(metric("Version", server.status.version));
  if (server.uptime?.day !== null && server.uptime?.day !== undefined) metrics.append(metric("Uptime 24 h", `${server.uptime.day} %`));
  if (metrics.children.length) card.append(metrics);
  const meta = el("p", "card-meta", `${relativeTime(server.status?.checkedAt)} geprüft${endpoint(server) ? ` · ${endpoint(server)}` : ""}`); meta.title = server.status?.detail || ""; card.append(meta);
  const actions = el("div", "card-actions"); const details = el("button", "button", "Details"); details.type = "button"; details.addEventListener("click", () => openDetails(server)); actions.append(details);
  if (server.links?.discord) actions.append(linkButton("Discord", server.links.discord)); if (server.links?.website) actions.append(linkButton("Webseite", server.links.website)); card.append(actions);
  return card;
}

function renderServers() {
  const grid = $("#server-grid"); const servers = visibleServers(); grid.replaceChildren(); text($("#filter-summary"), `${servers.length} von ${dashboard.servers.length} Servern angezeigt`);
  if (!servers.length) grid.append(el("p", "empty", dashboard.servers.length ? "Für diesen Filter gibt es keine Server." : "Noch keine öffentlichen Server vorhanden.")); else servers.forEach((server) => grid.append(serverCard(server)));
}

async function loadPublic() {
  const response = await api("public/servers"); if (!response.ok) throw new Error(await message(response)); dashboard = await response.json(); applyBranding(dashboard.settings); updateStats(dashboard.summary); updateCategories(); renderServers();
}

function clearDetailTimer() { if (detailTimer) window.clearInterval(detailTimer); detailTimer = null; }
function reloadDetail() { const frame = $("#iframe-shell iframe"); if (frame && activeDetails) frame.src = `${activeDetails.communityUrl}${activeDetails.communityUrl.includes("?") ? "&" : "?"}dashboard_refresh=${Date.now()}`; }
function setDetailRefresh(seconds) { clearDetailTimer(); localStorage.setItem("amp_v2_detail_refresh", String(seconds)); if (Number(seconds) > 0 && activeDetails) detailTimer = window.setInterval(reloadDetail, Number(seconds) * 1000); }
function openDetails(server) {
  activeDetails = server; text($("#details-title"), server.name); $("#open-community").href = server.communityUrl; $("#iframe-shell").replaceChildren(); const frame = document.createElement("iframe"); frame.title = `${server.name} – AMP Community-Seite`; frame.loading = "lazy"; frame.allow = "fullscreen"; frame.referrerPolicy = "strict-origin-when-cross-origin"; frame.src = server.communityUrl; $("#iframe-shell").append(frame);
  const stored = localStorage.getItem("amp_v2_detail_refresh"); const seconds = stored === null ? Number(dashboard.settings.defaultDetailRefreshSeconds || 0) : Number(stored); $("#detail-refresh").value = String(seconds); setDetailRefresh(seconds); $("#details-dialog").showModal();
}
function closeDetails() { clearDetailTimer(); activeDetails = null; $("#iframe-shell").replaceChildren(el("p", "", "Die AMP-Seite wird erst bei Bedarf geladen.")); $("#details-dialog").close(); }

function permitted(panel) { return Boolean(admin && rolePanels[admin.role]?.includes(panel)); }
function switchPanel(panel) {
  if (!permitted(panel)) return; $$(".admin-panel").forEach((section) => { section.hidden = section.dataset.panel !== panel; }); $$("#admin-tabs button").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.panel === panel)));
}
function updateAdminUi() {
  $("#admin-button").textContent = admin ? "Verwaltung" : "Anmelden"; text($("#admin-role"), admin ? `${roleLabels[admin.role]} · ${admin.username}` : "VERWALTUNG");
  $$("#admin-tabs button").forEach((button) => { button.hidden = !permitted(button.dataset.panel); }); if (admin) switchPanel(rolePanels[admin.role][0]);
}

function activityRows(target, entries) {
  target.replaceChildren(); if (!entries?.length) { target.append(el("p", "empty", "Noch keine Einträge vorhanden.")); return; }
  entries.forEach((entry) => { const row = el("div", "activity-row"); const content = el("div"); content.append(el("strong", "", entry.action), el("small", "", `${entry.username} · ${new Date(entry.created_at).toLocaleString("de-DE")}${entry.subject ? ` · ${entry.subject}` : ""}${entry.detail ? ` – ${entry.detail}` : ""}`)); row.append(content); target.append(row); });
}

function adminSummary(summary, uptime = {}) {
  const container = $("#admin-summary"); container.replaceChildren(); [["Server", summary.total], ["Online", summary.online], ["Offline", summary.offline], ["Wartung", summary.maintenance], ["Spieler", summary.players]].forEach(([label, value]) => { const item = el("div", "summary-card"); item.append(el("span", "", label), el("strong", "", String(value ?? 0))); container.append(item); });
  const values = Object.values(uptime).map((item) => item?.day).filter((value) => value !== null && value !== undefined); if (values.length) { const item = el("div", "summary-card"); item.append(el("span", "", "Ø Uptime 24 h"), el("strong", "", `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100} %`)); container.append(item); }
}

async function loadAdmin() {
  if (!admin) return;
  const requests = [];
  if (permitted("overview")) requests.push(api("admin/dashboard").then(async (response) => ({ key: "dashboard", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (permitted("servers")) requests.push(api("admin/servers").then(async (response) => ({ key: "servers", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (permitted("settings") || permitted("monitoring")) requests.push(api("admin/settings").then(async (response) => ({ key: "settings", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (permitted("access")) requests.push(api("admin/admins").then(async (response) => ({ key: "admins", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (permitted("logs")) requests.push(api("admin/activity").then(async (response) => ({ key: "activity", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  const loaded = await Promise.all(requests);
  for (const result of loaded) {
    if (result.key === "dashboard") { adminSummary(result.body.summary, result.body.uptime); activityRows($("#admin-activity"), result.body.activity); }
    if (result.key === "servers") { managedServers = result.body.servers; renderManagedServers(); }
    if (result.key === "settings") fillSettings(result.body);
    if (result.key === "admins") renderAdmins(result.body.admins);
    if (result.key === "activity") activityRows($("#activity-list"), result.body.entries);
  }
}

async function openAdmin() {
  if (!admin) return $("#login-dialog").showModal();
  text($("#admin-load-message"), "");
  if (!$("#admin-dialog").open) $("#admin-dialog").showModal();
  try {
    await loadAdmin();
  } catch (error) {
    text($("#admin-load-message"), error.message || "Die Verwaltungsdaten konnten noch nicht geladen werden.");
  }
}

function setServerMessage(value = "", problem = false) { const node = $("#server-message"); node.textContent = value; node.classList.toggle("error", problem); }
function resetServerForm() {
  $("#server-form").reset(); $("#server-id").value = ""; $("#server-category").value = "Allgemein"; $("#server-visibility").value = "public"; $("#server-profile").value = "auto"; $("#server-monitoring").checked = true; $("#display-players").checked = $("#display-ping").checked = $("#display-version").checked = true; $("#server-accent").value = "#42e8a5"; text($("#server-form-title"), "Server hinzufügen"); $("#cancel-edit").hidden = true; setServerMessage();
}
function field(id, value) { $(id).value = value ?? ""; }
function editServer(server) {
  field("#server-id", server.id); field("#server-name", server.name); field("#server-slug", server.slug); field("#server-category", server.category); field("#server-visibility", server.visibility); field("#server-description", server.description); field("#server-notice", server.notice); field("#server-community-url", server.communityUrl); field("#server-host", server.connection?.host); field("#server-port", server.connection?.port); field("#server-profile", server.connection?.profile || "auto"); field("#server-ts-query", server.connection?.teamSpeakQueryPort); $("#server-monitoring").checked = server.monitoring?.enabled !== false; field("#server-icon", server.iconUrl); field("#server-accent", server.accentColor || "#42e8a5");
  ["website", "discord", "wiki", "map", "modpack"].forEach((key) => field(`#link-${key}`, server.links?.[key])); $("#display-players").checked = server.display?.showPlayers !== false; $("#display-ping").checked = server.display?.showPing !== false; $("#display-version").checked = server.display?.showVersion !== false; text($("#server-form-title"), `„${server.name}“ bearbeiten`); $("#cancel-edit").hidden = false; switchPanel("servers"); window.setTimeout(() => $("#server-name").focus(), 0);
}
function serverPayload() {
  return { name: $("#server-name").value, slug: $("#server-slug").value, category: $("#server-category").value, visibility: $("#server-visibility").value, description: $("#server-description").value, notice: $("#server-notice").value, communityUrl: $("#server-community-url").value, iconUrl: $("#server-icon").value, accentColor: $("#server-accent").value, connection: { host: $("#server-host").value, port: $("#server-port").value, profile: $("#server-profile").value, teamSpeakQueryPort: $("#server-ts-query").value }, monitoring: { enabled: $("#server-monitoring").checked }, links: Object.fromEntries(["website", "discord", "wiki", "map", "modpack"].map((key) => [key, $(`#link-${key}`).value])), display: { showPlayers: $("#display-players").checked, showPing: $("#display-ping").checked, showVersion: $("#display-version").checked } };
}
function renderManagedServers() {
  const list = $("#server-list"); list.replaceChildren();
  managedServers.forEach((server, index) => { const row = el("div", "manage-row"); row.draggable = true; row.dataset.id = server.id; row.addEventListener("dragstart", () => { draggedId = server.id; }); row.addEventListener("dragover", (event) => event.preventDefault()); row.addEventListener("drop", async (event) => { event.preventDefault(); if (!draggedId || draggedId === server.id) return; const ids = managedServers.map((item) => item.id); const from = ids.indexOf(draggedId), to = ids.indexOf(server.id); ids.splice(to, 0, ids.splice(from, 1)[0]); await reorder(ids); });
    const info = el("div"); info.append(el("p", "manage-title", server.name), el("p", "manage-meta", `${server.category} · ${stateInfo(server.status).label} · ${endpoint(server) || "keine Spieladresse"}`)); const actions = el("div", "row-actions");
    const button = (label, handler, disabled = false) => { const item = el("button", "small-button", label); item.type = "button"; item.disabled = disabled; item.addEventListener("click", handler); actions.append(item); };
    button("↑", () => move(index, -1), index === 0); button("↓", () => move(index, 1), index === managedServers.length - 1); button("Bearbeiten", () => editServer(server)); button("Duplizieren", () => duplicate(server)); button("Löschen", () => removeServer(server)); row.append(info, actions); list.append(row); });
}
async function reorder(ids) { const response = await api("admin/servers/reorder", { method: "POST", body: JSON.stringify({ ids }) }); if (!response.ok) return setServerMessage(await message(response), true); await loadAdmin(); await loadPublic(); }
function move(index, direction) { const ids = managedServers.map((item) => item.id); const next = index + direction; if (next < 0 || next >= ids.length) return; [ids[index], ids[next]] = [ids[next], ids[index]]; reorder(ids); }
async function duplicate(server) { const response = await api(`admin/servers/${server.id}/duplicate`, { method: "POST", body: "{}" }); if (!response.ok) return setServerMessage(await message(response), true); await loadAdmin(); }
async function removeServer(server) { if (!confirm(`„${server.name}“ wirklich löschen?`)) return; const response = await api(`admin/servers/${server.id}`, { method: "DELETE" }); if (!response.ok) return setServerMessage(await message(response), true); resetServerForm(); await loadAdmin(); await loadPublic(); }

function fillSettings(settings) {
  field("#setting-title", settings.siteTitle); field("#setting-description", settings.siteDescription); field("#setting-accent", settings.accentColor || "#42e8a5"); field("#setting-detail-refresh", settings.defaultDetailRefreshSeconds); field("#setting-monitor-interval", settings.monitoringIntervalSeconds); field("#smtp-host", settings.smtp?.host); field("#smtp-port", settings.smtp?.port || 587); field("#smtp-user", settings.smtp?.username); field("#smtp-from", settings.smtp?.from); field("#smtp-to", settings.smtp?.to); $("#smtp-password").value = ""; $("#smtp-password").placeholder = settings.smtp?.passwordConfigured ? "Passwort ist gespeichert – nur zum Ändern eingeben" : "Passwort eingeben";
}
function renderAdmins(admins) { const list = $("#admin-list"); list.replaceChildren(); admins.forEach((account) => { const row = el("div", "manage-row"); const info = el("div"); info.append(el("p", "manage-title", account.username), el("p", "manage-meta", roleLabels[account.role] || account.role)); const actions = el("div", "row-actions"); if (account.username !== admin.username) { const role = document.createElement("select"); ["owner", "editor", "auditor"].forEach((value) => role.add(new Option(roleLabels[value], value, false, value === account.role))); role.addEventListener("change", async () => { const response = await api(`admin/admins/${encodeURIComponent(account.username)}`, { method: "PATCH", body: JSON.stringify({ role: role.value }) }); if (!response.ok) $("#admin-message").textContent = await message(response); else await loadAdmin(); }); actions.append(role); const remove = el("button", "small-button", "Löschen"); remove.type = "button"; remove.addEventListener("click", async () => { if (!confirm(`Konto „${account.username}“ löschen?`)) return; const response = await api(`admin/admins/${encodeURIComponent(account.username)}`, { method: "DELETE" }); if (!response.ok) $("#admin-message").textContent = await message(response); else await loadAdmin(); }); actions.append(remove); } row.append(info, actions); list.append(row); }); }

async function loadSession() { const response = await api("session"); const value = await response.json(); admin = value.authenticated ? { username: value.username, role: value.role } : null; updateAdminUi(); }

function selectFormTab(tab) { $$("[data-form-panel]").forEach((panel) => { panel.hidden = panel.dataset.formPanel !== tab; }); $$("[data-form-tab]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.formTab === tab))); }

$("#search").addEventListener("input", renderServers); ["#category-filter", "#status-filter", "#sort-filter"].forEach((id) => $(id).addEventListener("change", renderServers)); $("#refresh-statuses").addEventListener("click", () => loadPublic().catch((error) => { text($("#live-label"), error.message); }));
$("#close-details").addEventListener("click", closeDetails); $("#details-dialog").addEventListener("close", () => { if (activeDetails) closeDetails(); }); $("#detail-refresh").addEventListener("change", (event) => setDetailRefresh(event.target.value)); $("#refresh-detail").addEventListener("click", reloadDetail);
$("#admin-button").addEventListener("click", openAdmin); $("#close-login").addEventListener("click", () => $("#login-dialog").close()); $("#close-admin").addEventListener("click", () => $("#admin-dialog").close());
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Browser event objects are cleared after an await. Keep the form itself so
  // that a successful login can safely reset it after loading the dashboard.
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const response = await api("login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    if (!response.ok) return text($("#login-message"), await message(response));
    await loadSession();
    if (!admin) throw new Error("Die Anmeldung wurde nicht im Browser gespeichert. Bitte die Seite über HTTPS öffnen und die Browserdaten dieser Seite aktualisieren.");
    formElement.reset();
    text($("#login-message"), "");
    $("#login-dialog").close();
    await openAdmin();
  } catch (error) {
    text($("#login-message"), error.message || "Die Verwaltung konnte nicht geladen werden.");
  }
});
$("#logout-button").addEventListener("click", async () => { await api("logout", { method: "POST", body: "{}" }); admin = null; updateAdminUi(); $("#admin-dialog").close(); }); $$("#admin-tabs button").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel))); $$("[data-form-tab]").forEach((button) => button.addEventListener("click", () => selectFormTab(button.dataset.formTab)));
$("#cancel-edit").addEventListener("click", resetServerForm); $("#server-form").addEventListener("submit", async (event) => { event.preventDefault(); const id = $("#server-id").value; const response = await api(id ? `admin/servers/${id}` : "admin/servers", { method: id ? "PATCH" : "POST", body: JSON.stringify(serverPayload()) }); if (!response.ok) return setServerMessage(await message(response), true); setServerMessage("Server gespeichert."); resetServerForm(); await loadAdmin(); await loadPublic(); });
$("#test-server").addEventListener("click", async () => { const id = $("#server-id").value; if (!id) return setServerMessage("Bitte den Server zuerst speichern.", true); const response = await api(`admin/servers/${id}/test`, { method: "POST", body: "{}" }); if (!response.ok) return setServerMessage(await message(response), true); const result = await response.json(); setServerMessage(`${stateInfo(result.status).label}: ${result.status.detail}`); await loadAdmin(); await loadPublic(); });
$("#settings-form").addEventListener("submit", async (event) => { event.preventDefault(); const response = await api("admin/settings", { method: "POST", body: JSON.stringify({ siteTitle: $("#setting-title").value, siteDescription: $("#setting-description").value, accentColor: $("#setting-accent").value, defaultDetailRefreshSeconds: Number($("#setting-detail-refresh").value), monitoringIntervalSeconds: Number($("#setting-monitor-interval").value) }) }); text($("#settings-message"), response.ok ? "Gespeichert." : await message(response)); if (response.ok) await loadPublic(); });
$("#smtp-form").addEventListener("submit", async (event) => { event.preventDefault(); const response = await api("admin/settings", { method: "POST", body: JSON.stringify({ smtp: { host: $("#smtp-host").value, port: Number($("#smtp-port").value), username: $("#smtp-user").value, password: $("#smtp-password").value, from: $("#smtp-from").value, to: $("#smtp-to").value } }) }); text($("#smtp-message"), response.ok ? "E-Mail-Einstellungen gespeichert." : await message(response)); if (response.ok) await loadAdmin(); });
$("#smtp-test").addEventListener("click", async () => { const response = await api("admin/notifications/test", { method: "POST", body: "{}" }); text($("#smtp-message"), response.ok ? "Test-E-Mail wurde gesendet." : await message(response)); });
$("#export-backup").addEventListener("click", () => { window.location.assign("api/v1/admin/backup/export"); }); $("#import-backup").addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (!confirm("Die Serverliste wird ersetzt. Vorher wird automatisch eine Sicherung erstellt. Fortfahren?")) return; try { const response = await api("admin/backup/import", { method: "POST", body: await file.text() }); text($("#backup-message"), response.ok ? `Import abgeschlossen. Automatische Sicherung: ${(await response.json()).automaticBackup}` : await message(response)); if (response.ok) { await loadAdmin(); await loadPublic(); } } catch { text($("#backup-message"), "Die Datei ist keine gültige Sicherung."); } });
$("#admin-form").addEventListener("submit", async (event) => { event.preventDefault(); const response = await api("admin/admins", { method: "POST", body: JSON.stringify({ username: $("#new-admin-name").value, password: $("#new-admin-password").value, role: $("#new-admin-role").value }) }); text($("#admin-message"), response.ok ? "Administratorkonto erstellt." : await message(response)); if (response.ok) { event.currentTarget.reset(); await loadAdmin(); } }); $("#download-log").addEventListener("click", () => window.location.assign("api/v1/admin/activity/download"));

loadSession().then(loadPublic).catch((error) => { text($("#live-label"), error.message || "Dashboard nicht erreichbar"); }); window.setInterval(() => { if (!document.hidden) loadPublic().catch(() => {}); }, 30_000);
