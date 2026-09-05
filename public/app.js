const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const roleLabels = { owner: "Administrator", editor: "Moderator", support: "Support", auditor: "Nur ansehen", custom: "Benutzerdefiniert" };
const primaryPanels = ["overview", "servers", "monitoring", "settings"];
let dashboard = { servers: [], settings: {}, summary: {}, metrics: {} };
let admin = null;
let csrfToken = null;
let managedServers = [];
let activeDetails = null;
let detailTimer = null;
let draggedId = null;
let liveEvents = null;
let advancedMode = localStorage.getItem("amp_v2_ui_mode") === "advanced";
let metricObserver = null;
const metricRequests = new Set();
const pendingMetricIds = new Set();
let metricBatchTimer = null;

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (["POST", "PATCH", "DELETE"].includes(method) && path !== "login" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return fetch(`api/v1/${path}`, { credentials: "same-origin", ...options, headers });
}

async function message(response) {
  try { return (await response.json()).error || "Die Aktion konnte nicht ausgeführt werden."; } catch { return "Die Aktion konnte nicht ausgeführt werden."; }
}

function text(node, value) { node.textContent = value ?? ""; return node; }
function el(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
function stateInfo(status = {}) {
  if (status.stale) return { label: "Veraltet", className: "unknown" };
  const raw = status.state || "UNKNOWN";
  if (raw === "ONLINE") return { label: "Online", className: "online" };
  if (raw === "REACHABLE") return { label: "Erreichbar", className: "online" };
  if (raw === "MAINTENANCE") return { label: "Wartung", className: "maintenance" };
  if (["OFFLINE", "CONNECTION_REFUSED", "TIMEOUT"].includes(raw)) return { label: "Offline", className: "offline" };
  return { label: "Unbekannt", className: "unknown" };
}
function hasLiveReachability(status = {}) { return !status.stale && ["ONLINE", "REACHABLE"].includes(status.state); }
function relativeTime(value) {
  if (!value) return "noch nicht geprüft";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `vor ${seconds} Sek.`;
  if (seconds < 3600) return `vor ${Math.round(seconds / 60)} Min.`;
  return `vor ${Math.round(seconds / 3600)} Std.`;
}
function endpoint(server) { return server.connection ? `${server.connection.host}:${server.connection.port}` : ""; }
function isAdvanced() { return advancedMode; }
function hasPermission(permission) { return Boolean(admin?.permissions?.includes(permission)); }

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

function updateGroups() {
  const select = $("#group-filter"); const previous = select.value;
  const groups = [...new Set(dashboard.servers.map((server) => server.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  select.replaceChildren(new Option("Alle Gruppen", "all")); groups.forEach((group) => select.add(new Option(group, group))); select.value = groups.includes(previous) ? previous : "all";
}

function visibleServers() {
  const phrase = $("#search").value.trim().toLocaleLowerCase("de"); const category = $("#category-filter").value; const group = $("#group-filter").value; const state = $("#status-filter").value;
  const list = dashboard.servers.filter((server) => {
    const searchable = `${server.name} ${server.category} ${server.group || ""} ${server.description}`.toLocaleLowerCase("de");
    return (!phrase || searchable.includes(phrase)) && (category === "all" || server.category === category) && (group === "all" || server.group === group) && (state === "all" || server.status?.state === state || (state === "OFFLINE" && ["TIMEOUT", "CONNECTION_REFUSED"].includes(server.status?.state)));
  });
  const mode = $("#sort-filter").value;
  return list.sort((a, b) => mode === "name" ? a.name.localeCompare(b.name, "de") : mode === "players" ? Number(b.status?.players || -1) - Number(a.status?.players || -1) : mode === "latency" ? Number(a.status?.latencyMs || 9e9) - Number(b.status?.latencyMs || 9e9) : mode === "status" ? stateInfo(a.status).label.localeCompare(stateInfo(b.status).label, "de") : 0);
}

function metric(label, value) { const box = el("div", "metric"); box.append(el("span", "", label), el("strong", "", value)); return box; }
function linkButton(label, href) { const link = el("a", "button secondary", label); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; return link; }
function connectAddress(server) {
  const connection = server.connection;
  if (!connection) return "";
  const host = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
  if (connection.profile === "teamspeak") return `ts3server://${host}?port=${connection.port}`;
  if (connection.profile === "steam") return `steam://connect/${host}:${connection.port}`;
  return "";
}
function connectButton(server) {
  const href = server.connectUrl || connectAddress(server);
  if (!href) return null;
  const link = el("a", "button", "Verbinden");
  link.href = href;
  link.rel = "noopener noreferrer";
  link.title = server.connectUrl ? "Verbindung mit dem Server herstellen" : "Öffnet die Standardverbindung für diese Serveradresse";
  return link;
}
function copyAddressButton(server) {
  if (!server.connection || server.connectUrl || connectAddress(server)) return null;
  const button = el("button", "button", "Adresse kopieren");
  button.type = "button";
  button.title = "Kopiert die Spielserver-Adresse für einen nicht standardisierten Client";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(endpoint(server));
      button.textContent = "Adresse kopiert";
      window.setTimeout(() => { button.textContent = "Adresse kopieren"; }, 1_800);
    } catch { button.textContent = "Kopieren nicht möglich"; }
  });
  return button;
}

function serverCard(server) {
  const card = el("article", "server-card"); card.dataset.serverId = server.id; card.style.setProperty("--card-accent", server.accentColor || "var(--accent)");
  if (server.bannerUrl) { const banner = document.createElement("img"); banner.className = "server-banner"; banner.src = server.bannerUrl; banner.alt = ""; card.append(banner); }
  const header = el("header", "card-header"); const ident = el("div", "server-ident");
  const icon = server.iconUrl ? document.createElement("img") : el("span", "server-icon", "◆"); icon.className = "server-icon"; if (server.iconUrl) { icon.src = server.iconUrl; icon.alt = ""; }
  const title = el("div"); title.append(el("h2", "server-name", server.name), el("div", "category", server.category || "Allgemein")); ident.append(icon, title);
  const state = stateInfo(server.status); const badge = el("span", `status ${state.className}`, state.label); badge.title = server.status?.detail || state.label; header.append(ident, badge); card.append(header);
  if (server.description) card.append(el("p", "card-description", server.description));
  if (server.notice) card.append(el("p", "notice", `Hinweis: ${server.notice}`));
  const metrics = el("div", "metrics");
  const liveReachability = hasLiveReachability(server.status);
  if (liveReachability && server.display?.showPlayers && server.status?.players !== null && server.status?.players !== undefined) metrics.append(metric("Spieler", `${server.status.players}${server.status.maxPlayers ? ` / ${server.status.maxPlayers}` : ""}`));
  if (liveReachability && server.display?.showPing && server.status?.latencyMs !== null && server.status?.latencyMs !== undefined) metrics.append(metric("Latenz", `${server.status.latencyMs} ms`));
  if (isAdvanced() && server.display?.showVersion && server.status?.map) metrics.append(metric("Map", server.status.map));
  if (isAdvanced() && server.display?.showVersion && server.status?.version) metrics.append(metric("Version", server.status.version));
  if (isAdvanced() && server.uptime?.day !== null && server.uptime?.day !== undefined) metrics.append(metric("Uptime 24 h", `${server.uptime.day} %`));
  if (isAdvanced() && liveReachability) metrics.append(metric("Health", `${server.healthScore ?? 0} / 100`));
  if (metrics.children.length) card.append(metrics);
  const meta = el("p", "card-meta", `${relativeTime(server.status?.checkedAt)} geprüft${server.group ? ` · ${server.group}` : ""}`); meta.title = server.status?.detail || ""; card.append(meta);
  if (isAdvanced() && liveReachability) { const chart = metricChart(dashboard.metrics?.[server.id] || []); if (chart) card.append(chart); }
  const actions = el("div", "card-actions"); actions.append(linkButton("Öffnen", server.communityUrl)); const connect = connectButton(server); const copyAddress = copyAddressButton(server); if (connect) actions.append(connect); else if (copyAddress) actions.append(copyAddress); const details = el("button", "button secondary", "Details"); details.type = "button"; details.addEventListener("click", () => openDetails(server)); actions.append(details);
  if (server.links?.discord) actions.append(linkButton("Discord", server.links.discord)); if (server.links?.website) actions.append(linkButton("Webseite", server.links.website)); card.append(actions);
  return card;
}

function renderServers() {
  const grid = $("#server-grid"); const servers = visibleServers(); grid.replaceChildren(); text($("#filter-summary"), `${servers.length} von ${dashboard.servers.length} Servern angezeigt`);
  if (!servers.length) grid.append(el("p", "empty", dashboard.servers.length ? "Für diesen Filter gibt es keine Server." : "Noch keine öffentlichen Server vorhanden.")); else servers.forEach((server) => grid.append(serverCard(server)));
  observeVisibleCharts();
}

function needsFullStatusRender() {
  return $("#status-filter").value !== "all" || ["players", "latency", "status"].includes($("#sort-filter").value);
}
function replaceServerCard(server) {
  if (needsFullStatusRender()) return renderServers();
  const card = [...$("#server-grid").children].find((item) => item.dataset.serverId === server.id);
  if (card) { card.replaceWith(serverCard(server)); observeVisibleCharts(); }
}
function applyDashboard(value) {
  dashboard = { ...dashboard, ...value, metrics: dashboard.metrics || {} };
  applyBranding(dashboard.settings); updateStats(dashboard.summary); updateCategories(); updateGroups(); renderServers();
}
function applyStatusDelta(value) {
  const index = dashboard.servers.findIndex((server) => server.id === value.serverId);
  if (index < 0) return loadPublic().catch(() => {});
  const server = { ...dashboard.servers[index], status: value.status, uptime: value.uptime || dashboard.servers[index].uptime, healthScore: value.healthScore ?? dashboard.servers[index].healthScore };
  dashboard.servers[index] = server;
  if (value.summary) dashboard.summary = value.summary;
  updateStats(dashboard.summary);
  if (activeDetails?.id === server.id) { activeDetails = server; updateDetailSummary(server); }
  replaceServerCard(server);
}
function metricChart(points) {
  const values = points.map((point) => Number(point.latencyMs)).filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length < 2) return null;
  const maximum = Math.max(...values, 1); const width = 160; const height = 34;
  const path = values.map((value, index) => `${index ? "L" : "M"}${Math.round(index / (values.length - 1) * width)} ${Math.round(height - value / maximum * (height - 4))}`).join(" ");
  const wrap = el("div", "metric-chart"); wrap.append(el("span", "", "Latenzverlauf (24 h)")); const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Latenzverlauf der letzten 24 Stunden"); const line = document.createElementNS("http://www.w3.org/2000/svg", "path"); line.setAttribute("d", path); svg.append(line); wrap.append(svg); return wrap;
}
function metricLoaded(serverId) { return Object.hasOwn(dashboard.metrics, serverId); }
function requestMetrics(serverId, force = false) {
  if (!serverId || metricRequests.has(serverId) || (!force && metricLoaded(serverId))) return;
  metricRequests.add(serverId); pendingMetricIds.add(serverId);
  if (!metricBatchTimer) metricBatchTimer = window.setTimeout(flushMetricRequests, 40);
}
async function flushMetricRequests() {
  metricBatchTimer = null;
  const ids = [...pendingMetricIds].slice(0, 12); ids.forEach((id) => pendingMetricIds.delete(id));
  if (!ids.length) return;
  try {
    const response = await api(`public/metrics?serverIds=${encodeURIComponent(ids.join(","))}&points=120`);
    if (!response.ok) return;
    const metrics = (await response.json()).metrics || {};
    dashboard.metrics = { ...dashboard.metrics, ...metrics };
    if (isAdvanced()) ids.forEach((id) => { const server = dashboard.servers.find((item) => item.id === id); if (server) replaceServerCard(server); });
  } catch {
    // A later visibility event retries the small batch. Rendering must never
    // fail merely because optional chart history is temporarily unavailable.
  } finally {
    ids.forEach((id) => metricRequests.delete(id));
    if (pendingMetricIds.size && !metricBatchTimer) metricBatchTimer = window.setTimeout(flushMetricRequests, 40);
  }
}
function observeVisibleCharts() {
  metricObserver?.disconnect(); metricObserver = null;
  if (!isAdvanced()) return;
  const cards = [...$("#server-grid").querySelectorAll(".server-card")].filter((card) => {
    const server = dashboard.servers.find((item) => item.id === card.dataset.serverId);
    return Boolean(server && hasLiveReachability(server.status) && !metricLoaded(server.id));
  });
  if (!cards.length) return;
  if (!("IntersectionObserver" in window)) { cards.slice(0, 6).forEach((card) => requestMetrics(card.dataset.serverId)); return; }
  metricObserver = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => { metricObserver.unobserve(entry.target); requestMetrics(entry.target.dataset.serverId); });
  }, { rootMargin: "240px 0px" });
  cards.forEach((card) => metricObserver.observe(card));
}
function applyMetricPoint(value) {
  if (!value?.serverId || !value.point || !metricLoaded(value.serverId)) return;
  requestMetrics(value.serverId, true);
}
async function loadPublic() {
  const response = await api("public/servers"); if (!response.ok) throw new Error(await message(response)); applyDashboard(await response.json());
}

function clearDetailTimer() { if (detailTimer) window.clearInterval(detailTimer); detailTimer = null; }
function reloadDetail() { const frame = $("#iframe-shell iframe"); if (frame && activeDetails) frame.src = `${activeDetails.communityUrl}${activeDetails.communityUrl.includes("?") ? "&" : "?"}dashboard_refresh=${Date.now()}`; }
function setDetailRefresh(seconds) { clearDetailTimer(); localStorage.setItem("amp_v2_detail_refresh", String(seconds)); if (Number(seconds) > 0 && activeDetails) detailTimer = window.setInterval(reloadDetail, Number(seconds) * 1000); }
function updateDetailSummary(server) {
  const summary = $("#detail-summary"); summary.replaceChildren(); const state = stateInfo(server.status); summary.append(el("span", `status ${state.className}`, state.label), el("span", "", relativeTime(server.status?.checkedAt)));
  if (hasLiveReachability(server.status) && server.status?.players !== null && server.status?.players !== undefined) summary.append(el("span", "", `${server.status.players}${server.status.maxPlayers ? ` / ${server.status.maxPlayers}` : ""} Spieler`));
  if (isAdvanced()) { summary.append(el("span", "", `Health ${server.healthScore ?? 0} / 100`)); const technical = document.createElement("details"); technical.className = "technical-details"; technical.append(el("summary", "", "Technische Hinweise"), el("p", "", server.status?.detail || "Keine technischen Hinweise vorhanden.")); summary.append(technical); }
}
function openDetails(server) {
  activeDetails = server; text($("#details-title"), server.name); $("#open-community").href = server.communityUrl;
  updateDetailSummary(server);
  $("#iframe-shell").replaceChildren(); const frame = document.createElement("iframe"); frame.title = `${server.name} – AMP Community-Seite`; frame.loading = "lazy"; frame.allow = "fullscreen"; frame.referrerPolicy = "strict-origin-when-cross-origin"; frame.src = server.communityUrl; $("#iframe-shell").append(frame);
  const stored = localStorage.getItem("amp_v2_detail_refresh"); const seconds = stored === null ? Number(dashboard.settings.defaultDetailRefreshSeconds || 0) : Number(stored); $("#detail-refresh").value = String(seconds); setDetailRefresh(seconds); $("#details-dialog").showModal();
  if (isAdvanced()) requestMetrics(server.id);
}
function closeDetails() { clearDetailTimer(); activeDetails = null; $("#iframe-shell").replaceChildren(el("p", "", "Die AMP-Seite wird erst bei Bedarf geladen.")); $("#details-dialog").close(); }

function permitted(panel) {
  if (!admin) return false;
  if (panel === "overview") return hasPermission("dashboard.read");
  if (panel === "servers") return hasPermission("servers.read");
  if (panel === "monitoring") return hasPermission("settings.write") || hasPermission("notifications.test");
  if (panel === "settings") return ["settings.write", "access.write", "logs.read", "logs.export", "backup.export", "backup.import"].some(hasPermission);
  return false;
}
function switchPanel(panel) {
  if (!permitted(panel)) return; $$(".admin-panel").forEach((section) => { section.hidden = section.dataset.panel !== panel; }); $$("#admin-tabs > button").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.panel === panel)));
}
function selectSettingsView(view) {
  const allowed = { general: hasPermission("settings.write"), users: hasPermission("access.write"), permissions: hasPermission("access.write"), audit: hasPermission("logs.read"), backups: hasPermission("backup.export") || hasPermission("backup.import"), system: hasPermission("settings.write") };
  if (!allowed[view]) return;
  $$(".settings-view").forEach((section) => { section.hidden = section.dataset.settingsView !== view; });
  $$("#settings-tabs button").forEach((button) => { button.hidden = !allowed[button.dataset.settingsView]; button.setAttribute("aria-selected", String(button.dataset.settingsView === view)); });
}
function updateAdminUi() {
  $("#admin-button").textContent = admin ? "Verwaltung" : "Anmelden"; text($("#admin-role"), admin ? `${roleLabels[admin.role]} · ${admin.username}` : "VERWALTUNG");
  $$("#admin-tabs > button").forEach((button) => { button.hidden = !permitted(button.dataset.panel); });
  if (admin) switchPanel(primaryPanels.find(permitted) || "overview");
  $("#discover-server").hidden = !hasPermission("servers.discover");
  $("#test-server").hidden = !hasPermission("servers.test");
  $("#server-form").hidden = !hasPermission("servers.write");
  document.body.classList.toggle("advanced-mode", advancedMode);
  $("#ui-mode-toggle").textContent = advancedMode ? "Einfach" : "Erweitert";
  if (admin && permitted("settings")) selectSettingsView(hasPermission("settings.write") ? "general" : hasPermission("access.write") ? "users" : hasPermission("logs.read") ? "audit" : "backups");
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
  if (hasPermission("settings.write")) requests.push(api("admin/settings").then(async (response) => ({ key: "settings", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (hasPermission("access.write")) requests.push(api("admin/admins").then(async (response) => ({ key: "admins", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (hasPermission("logs.read")) requests.push(api("admin/activity").then(async (response) => ({ key: "activity", body: response.ok ? await response.json() : Promise.reject(new Error(await message(response))) })));
  if (hasPermission("settings.write")) requests.push(Promise.all([fetch("health"), fetch("ready")]).then(async ([health, ready]) => ({ key: "system", body: { health: health.ok ? await health.json() : null, ready: ready.ok ? await ready.json() : null } })));
  const loaded = await Promise.all(requests);
  for (const result of loaded) {
    if (result.key === "dashboard") { adminSummary(result.body.summary, result.body.uptime); activityRows($("#admin-activity"), result.body.activity); }
    if (result.key === "servers") { managedServers = result.body.servers; renderManagedServers(); }
    if (result.key === "settings") fillSettings(result.body);
    if (result.key === "admins") renderAdmins(result.body.admins);
    if (result.key === "activity") activityRows($("#activity-list"), result.body.entries);
    if (result.key === "system") text($("#system-status"), result.body.health?.ok && result.body.ready?.ready ? `Bereit · Version ${result.body.health.version} · Überwachung aktiv` : "Der Dienst ist noch nicht vollständig bereit.");
  }
}

async function openAdmin() {
  if (!admin) return $("#login-dialog").showModal();
  text($("#admin-load-message"), "");
  if (!$("#admin-dialog").open) $("#admin-dialog").showModal();
  try {
    await loadAdmin();
    if (admin?.role === "owner" && managedServers.length === 0 && !localStorage.getItem("amp_v2_setup_seen") && !$("#setup-dialog").open) $("#setup-dialog").showModal();
  } catch (error) {
    text($("#admin-load-message"), error.message || "Die Verwaltungsdaten konnten noch nicht geladen werden.");
  }
}

function setServerMessage(value = "", problem = false) { const node = $("#server-message"); node.textContent = value; node.classList.toggle("error", problem); }
function discoveredConnect(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "steam:" && url.hostname.toLowerCase() === "connect") {
      const match = /^\/?(?:\[([^\]]+)\]|([^/:]+)):(\d{1,5})$/.exec(decodeURIComponent(url.pathname));
      if (match) return { connection: { host: match[1] || match[2], port: Number(match[3]), profile: "steam" }, connectUrl: url.toString(), source: "Connect-Link im Iframe" };
    }
    if (url.protocol === "ts3server:" && url.hostname) return { connection: { host: url.hostname, port: Number(url.searchParams.get("port") || url.port || 9987), profile: "teamspeak" }, connectUrl: url.toString(), source: "Connect-Link im Iframe" };
    if (url.protocol === "minecraft:") {
      const endpoint = url.searchParams.get("addExternalServer")?.split("|").at(-1) || "";
      const match = /^(?:\[([^\]]+)\]|([^/:]+)):(\d{1,5})$/.exec(endpoint);
      if (match) return { connection: { host: match[1] || match[2], port: Number(match[3]), profile: "minecraft" }, connectUrl: url.toString(), source: "Connect-Link im Iframe" };
    }
  } catch { /* ignored: this is only a same-origin fallback */ }
  return null;
}
function browserEndpoint(value) {
  const source = String(value || "").trim();
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/i.exec(source);
  const port = Number(match?.[3]);
  return match && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host: match[1] || match[2], port } : null;
}
function browserProfile(value) {
  const source = String(value || "").toLowerCase();
  if (/(teamspeak|ts3|ts5)/.test(source)) return "teamspeak";
  if (/(minecraft|java edition)/.test(source)) return "minecraft";
  if (/(steam|source engine|a2s|arma|ark|rust|valheim|palworld|satisfactory|counter.?strike)/.test(source)) return "steam";
  return "auto";
}
function frameAddressDiscovery(document, communityUrl) {
  const context = document.body?.innerText || "";
  const profile = browserProfile(context);
  const tags = [...document.querySelectorAll("[data-connect],[data-connection],[data-address],[data-server],[data-endpoint],[data-host],a[href]")];
  for (const tag of tags) {
    const values = [tag.getAttribute("href"), tag.dataset.connect, tag.dataset.connection, tag.dataset.address, tag.dataset.server, tag.dataset.endpoint, tag.dataset.host].filter(Boolean);
    for (const value of values) {
      const linked = discoveredConnect(value);
      if (linked) return linked;
      const direct = browserEndpoint(value);
      if (direct) return { connection: { ...direct, profile }, connectUrl: "", source: "Adresse im Community-Iframe" };
    }
    const direct = browserEndpoint(`${tag.dataset.host || tag.dataset.address || tag.dataset.server || ""}:${tag.dataset.port || tag.dataset.gamePort || tag.dataset.queryPort || ""}`);
    if (direct) return { connection: { ...direct, profile }, connectUrl: "", source: "Datenfeld im Community-Iframe" };
  }
  const endpoints = context.match(/(?:\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}):\d{1,5}/gi) || [];
  const page = new URL(communityUrl, window.location.href);
  for (const value of endpoints) {
    const direct = browserEndpoint(value);
    if (!direct || (direct.host.toLowerCase() === page.hostname.toLowerCase() && direct.port === Number(page.port || 443))) continue;
    return { connection: { ...direct, profile }, connectUrl: "", source: "Sichtbare Adresse im Community-Iframe" };
  }
  return null;
}
function applyDiscovery(found) {
  const changes = [];
  const recommendedMonitoring = found.monitoringTarget || found.connection;
  const currentGameHost = $("#server-host").value.trim().toLowerCase();
  const currentGamePort = Number($("#server-port").value || 0);
  const currentMonitorHost = $("#monitor-host").value.trim().toLowerCase();
  const currentMonitorPort = Number($("#monitor-port").value || 0);
  const mirroredAutomaticTarget = Boolean(currentMonitorHost && currentGameHost && currentMonitorHost === currentGameHost && currentMonitorPort === currentGamePort);
  const useRecommendedTarget = Boolean(found.monitoringTarget) && (!currentMonitorHost || !currentMonitorPort || mirroredAutomaticTarget);
  if (found.title && !$("#server-name").value.trim()) { field("#server-name", found.title); changes.push("Name"); }
  if (found.connection?.host && !$("#server-host").value.trim()) { field("#server-host", found.connection.host); changes.push("Spieladresse"); }
  if (found.connection?.port && !$("#server-port").value) { field("#server-port", found.connection.port); changes.push("Port"); }
  if (found.connection?.profile && $("#server-profile").value === "auto") { field("#server-profile", found.connection.profile); changes.push("Abfrageprofil"); }
  if (recommendedMonitoring?.host && (!$("#monitor-host").value.trim() || useRecommendedTarget)) { field("#monitor-host", recommendedMonitoring.host); changes.push("Monitoring-Adresse"); }
  if (recommendedMonitoring?.port && (!$("#monitor-port").value || useRecommendedTarget)) { field("#monitor-port", recommendedMonitoring.port); changes.push(found.monitoringTarget ? "Status-Port" : "Monitoring-Port"); }
  if (recommendedMonitoring?.profile && ($("#monitor-profile").value === "auto" || useRecommendedTarget)) { field("#monitor-profile", recommendedMonitoring.profile); changes.push("Monitoring-Profil"); }
  if (found.monitoringTarget?.strategy === "arma3-query-offset") changes.push("Arma-3-Query-Regel (+1)");
  if (found.monitoringTarget?.strategy === "community-query-port") changes.push("Steam-Query-Port aus Community-Seite");
  if (found.connection?.profile === "teamspeak" && !$("#server-ts-query").value) { field("#server-ts-query", 10011); field("#monitor-ts-query", 10011); changes.push("TeamSpeak-Query-Port"); }
  if (found.connectUrl && !$("#server-connect-url").value.trim()) { field("#server-connect-url", found.connectUrl); changes.push("Verbindungslink"); }
  return changes;
}
async function sameOriginFrameDiscovery(communityUrl) {
  let url;
  try { url = new URL(communityUrl, window.location.href); } catch { return null; }
  if (url.origin !== window.location.origin) return null;
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; window.clearTimeout(timeout); frame.remove(); resolve(value); };
    const timeout = window.setTimeout(() => finish(null), 8_000);
    frame.className = "community-probe-frame";
    frame.title = "";
    frame.addEventListener("load", () => window.setTimeout(() => {
      try {
        const found = frameAddressDiscovery(frame.contentDocument, url.toString());
        if (found) return finish(found);
      } catch { /* foreign frames are intentionally not readable */ }
      finish(null);
    }, 350), { once: true });
    frame.src = url.toString();
    document.body.append(frame);
  });
}
async function discoverServerAddress() {
  const communityUrl = $("#server-community-url").value.trim();
  if (!communityUrl) return setServerMessage("Bitte zuerst die AMP-Community-Adresse eintragen.", true);
  const button = $("#discover-server");
  button.disabled = true;
  button.textContent = "Server wird erkannt …";
  setServerMessage();
  try {
    const response = await api("admin/servers/discover", { method: "POST", body: JSON.stringify({ communityUrl }) });
    if (!response.ok) return setServerMessage(await message(response), true);
    let found = await response.json();
    const frameFound = await sameOriginFrameDiscovery(communityUrl);
    // The server-side extractor validates and classifies the full page. An
    // iframe is merely a fallback for pages whose address appears only after
    // client-side rendering; it must never overwrite a classified result.
    if (!found.connection && frameFound?.connection) found = { ...found, ...frameFound, found: true, confidence: "high" };
    const changes = applyDiscovery(found);
    if (changes.length) {
      const alternatives = Math.max(0, Number(found.candidates?.length || 0) - 1);
      setServerMessage(`${found.source}: ${changes.join(", ")} übernommen${found.application ? ` · erkannt: ${found.application}` : ""}${alternatives ? ` · ${alternatives} weitere Adresse(n) wurden gefunden` : ""}. Bitte vor dem Speichern prüfen.`);
    } else setServerMessage("Auf der Community-Seite wurde keine verwendbare Spieladresse gefunden. Adresse und Port können weiterhin manuell ergänzt werden.", true);
  } catch (error) {
    setServerMessage(error.message || "Die Community-Seite konnte nicht automatisch geprüft werden.", true);
  } finally {
    button.disabled = false;
    button.textContent = "Server erkennen";
  }
}
function resetServerForm() {
  $("#server-form").reset(); $("#server-id").value = ""; $("#server-category").value = "Allgemein"; $("#server-visibility").value = "public"; $("#server-profile").value = "auto"; $("#server-monitoring").checked = true; $("#display-players").checked = $("#display-ping").checked = $("#display-version").checked = true; $("#display-connect").checked = false; $("#server-accent").value = "#42e8a5"; $("#server-options").open = false; text($("#server-form-title"), "Server hinzufügen"); $("#cancel-edit").hidden = true; setServerMessage();
}
function field(id, value) { $(id).value = value ?? ""; }
function editServer(server) {
  field("#server-id", server.id); field("#server-name", server.name); field("#server-slug", server.slug); field("#server-category", server.category); field("#server-group", server.group); field("#server-visibility", server.visibility); field("#server-description", server.description); field("#server-notice", server.notice); field("#server-community-url", server.communityUrl); field("#server-connect-url", server.connectUrl); field("#server-host", server.connection?.host); field("#server-port", server.connection?.port); field("#server-profile", server.connection?.profile || "auto"); field("#server-ts-query", server.connection?.teamSpeakQueryPort); field("#monitor-host", server.monitoringTarget?.host); field("#monitor-port", server.monitoringTarget?.port); field("#monitor-profile", server.monitoringTarget?.profile || "auto"); field("#monitor-ts-query", server.monitoringTarget?.teamSpeakQueryPort); $("#server-monitoring").checked = server.monitoring?.enabled !== false; field("#server-icon", server.iconUrl); $("#server-banner").value = ""; field("#server-accent", server.accentColor || "#42e8a5"); $("#server-options").open = advancedMode;
  ["website", "discord", "wiki", "map", "modpack"].forEach((key) => field(`#link-${key}`, server.links?.[key])); $("#display-players").checked = server.display?.showPlayers !== false; $("#display-ping").checked = server.display?.showPing !== false; $("#display-version").checked = server.display?.showVersion !== false; $("#display-connect").checked = server.display?.showConnect === true; text($("#server-form-title"), `„${server.name}“ bearbeiten`); $("#cancel-edit").hidden = false; switchPanel("servers"); window.setTimeout(() => $("#server-name").focus(), 0);
}
function serverPayload() {
  return { name: $("#server-name").value, slug: $("#server-slug").value, category: $("#server-category").value, group: $("#server-group").value, visibility: $("#server-visibility").value, description: $("#server-description").value, notice: $("#server-notice").value, communityUrl: $("#server-community-url").value, connectUrl: $("#server-connect-url").value, iconUrl: $("#server-icon").value, accentColor: $("#server-accent").value, connection: { host: $("#server-host").value, port: $("#server-port").value, profile: $("#server-profile").value, teamSpeakQueryPort: $("#server-ts-query").value }, monitoringTarget: { host: $("#monitor-host").value, port: $("#monitor-port").value, profile: $("#monitor-profile").value, teamSpeakQueryPort: $("#monitor-ts-query").value }, monitoring: { enabled: $("#server-monitoring").checked }, links: Object.fromEntries(["website", "discord", "wiki", "map", "modpack"].map((key) => [key, $(`#link-${key}`).value])), display: { showPlayers: $("#display-players").checked, showPing: $("#display-ping").checked, showVersion: $("#display-version").checked, showConnect: $("#display-connect").checked } };
}
async function uploadSelectedBanner(payload) {
  const file = $("#server-banner").files?.[0];
  if (!file) return payload;
  if (file.size > 2 * 1024 * 1024) throw new Error("Das Banner darf höchstens 2 MB groß sein.");
  const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Das Bild konnte nicht gelesen werden.")); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
  const response = await api("admin/uploads", { method: "POST", body: JSON.stringify({ dataUrl }) });
  if (!response.ok) throw new Error(await message(response));
  return { ...payload, bannerUrl: (await response.json()).url };
}
function renderManagedServers() {
  const list = $("#server-list"); list.replaceChildren();
  const writable = hasPermission("servers.write");
  managedServers.forEach((server, index) => { const row = el("div", "manage-row"); row.draggable = writable; row.dataset.id = server.id; if (writable) { row.addEventListener("dragstart", () => { draggedId = server.id; }); row.addEventListener("dragover", (event) => event.preventDefault()); row.addEventListener("drop", async (event) => { event.preventDefault(); if (!draggedId || draggedId === server.id) return; const ids = managedServers.map((item) => item.id); const from = ids.indexOf(draggedId), to = ids.indexOf(server.id); ids.splice(to, 0, ids.splice(from, 1)[0]); await reorder(ids); }); }
    const info = el("div"); info.append(el("p", "manage-title", server.name), el("p", "manage-meta", `${server.category} · ${stateInfo(server.status).label}${isAdvanced() ? ` · ${endpoint(server) || "keine Spieladresse"}` : ""}`)); const actions = el("div", "row-actions");
    const button = (label, handler, disabled = false) => { const item = el("button", "small-button", label); item.type = "button"; item.disabled = disabled; item.addEventListener("click", handler); actions.append(item); };
    if (writable) { button("↑", () => move(index, -1), index === 0); button("↓", () => move(index, 1), index === managedServers.length - 1); button("Bearbeiten", () => editServer(server)); if (admin?.role === "owner") button("Duplizieren", () => duplicate(server)); button("Löschen", () => removeServer(server)); } row.append(info, actions); list.append(row); });
}
async function reorder(ids) { const response = await api("admin/servers/reorder", { method: "POST", body: JSON.stringify({ ids }) }); if (!response.ok) return setServerMessage(await message(response), true); await loadAdmin(); await loadPublic(); }
function move(index, direction) { const ids = managedServers.map((item) => item.id); const next = index + direction; if (next < 0 || next >= ids.length) return; [ids[index], ids[next]] = [ids[next], ids[index]]; reorder(ids); }
async function duplicate(server) { const response = await api(`admin/servers/${server.id}/duplicate`, { method: "POST", body: "{}" }); if (!response.ok) return setServerMessage(await message(response), true); await loadAdmin(); }
async function removeServer(server) { if (!confirm(`Server „${server.name}“ wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return; const response = await api(`admin/servers/${server.id}`, { method: "DELETE" }); if (!response.ok) return setServerMessage(await message(response), true); resetServerForm(); await loadAdmin(); await loadPublic(); }

function fillSettings(settings) {
  field("#setting-title", settings.siteTitle); field("#setting-description", settings.siteDescription); field("#setting-accent", settings.accentColor || "#42e8a5"); field("#setting-detail-refresh", settings.defaultDetailRefreshSeconds); field("#setting-monitor-interval", settings.monitoringIntervalSeconds); field("#setting-trusted-domains", (settings.trustedCommunityDomains || []).join("\n")); field("#smtp-host", settings.smtp?.host); field("#smtp-port", settings.smtp?.port || 587); field("#smtp-user", settings.smtp?.username); field("#smtp-from", settings.smtp?.from); field("#smtp-to", settings.smtp?.to); field("#alert-latency", settings.notifications?.latencyThresholdMs || 0); field("#alert-outage", settings.notifications?.outageMinutes || 0); $("#notify-offline").checked = settings.notifications?.notifyOffline !== false; $("#notify-recovered").checked = settings.notifications?.notifyRecovered !== false; $("#smtp-password").value = ""; $("#webhook-urls").value = ""; $("#clear-webhooks").checked = false; $("#smtp-password").placeholder = settings.smtp?.passwordConfigured ? "Passwort ist gespeichert – nur zum Ändern eingeben" : "Passwort eingeben"; $("#webhook-urls").placeholder = settings.webhookCount ? `${settings.webhookCount} Webhook(s) gespeichert – nur zum Ersetzen hier eintragen` : "optional: Discord- oder Webhook-Adresse";
}
function renderAdmins(admins) {
  const list = $("#admin-list"); list.replaceChildren();
  admins.forEach((account) => {
    const row = el("div", "manage-row"); const info = el("div"); const extra = account.role === "custom" ? ` · ${account.permissions?.length || 0} Rechte` : "";
    info.append(el("p", "manage-title", account.username), el("p", "manage-meta", `${roleLabels[account.role] || account.role}${extra}`)); const actions = el("div", "row-actions");
    if (account.username !== admin.username) {
      const role = document.createElement("select"); ["owner", "editor", "support", "auditor", "custom"].forEach((value) => role.add(new Option(roleLabels[value], value, false, value === account.role)));
      role.addEventListener("change", async () => {
        const customPermissions = role.value === "custom" ? (account.permissions?.length ? account.permissions : ["dashboard.read"]) : [];
        const response = await api(`admin/admins/${encodeURIComponent(account.username)}`, { method: "PATCH", body: JSON.stringify({ role: role.value, customPermissions }) });
        if (!response.ok) $("#admin-message").textContent = await message(response); else await loadAdmin();
      });
      actions.append(role); const remove = el("button", "small-button", "Löschen"); remove.type = "button"; remove.addEventListener("click", async () => { if (!confirm(`Benutzer „${account.username}“ wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return; const response = await api(`admin/admins/${encodeURIComponent(account.username)}`, { method: "DELETE" }); if (!response.ok) $("#admin-message").textContent = await message(response); else await loadAdmin(); }); actions.append(remove);
    }
    row.append(info, actions); list.append(row);
  });
}

async function loadSession() { const response = await api("session"); const value = await response.json(); admin = value.authenticated ? { username: value.username, role: value.role, permissions: value.permissions || [] } : null; csrfToken = value.csrfToken || null; updateAdminUi(); }

function selectFormTab(tab) { $$("[data-form-panel]").forEach((panel) => { panel.hidden = panel.dataset.formPanel !== tab; }); $$("[data-form-tab]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.formTab === tab))); }

$("#search").addEventListener("input", renderServers); ["#category-filter", "#group-filter", "#status-filter", "#sort-filter"].forEach((id) => $(id).addEventListener("change", renderServers)); $("#refresh-statuses").addEventListener("click", () => loadPublic().catch((error) => { text($("#live-label"), error.message); }));
function applyTheme(value) { document.documentElement.dataset.theme = value; localStorage.setItem("amp_v2_theme", value); $("#theme-toggle").textContent = value === "light" ? "Dunkel" : "Hell"; }
function setUiMode(value) {
  advancedMode = Boolean(value); localStorage.setItem("amp_v2_ui_mode", advancedMode ? "advanced" : "simple"); document.body.classList.toggle("advanced-mode", advancedMode); $("#ui-mode-toggle").textContent = advancedMode ? "Einfach" : "Erweitert"; updateCustomPermissionUi(); renderServers();
}
$("#theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
$("#ui-mode-toggle").addEventListener("click", () => setUiMode(!advancedMode));
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
$("#logout-button").addEventListener("click", async () => { await api("logout", { method: "POST", body: "{}" }); admin = null; csrfToken = null; updateAdminUi(); $("#admin-dialog").close(); }); $$("#admin-tabs > button").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel))); $$("#settings-tabs button").forEach((button) => button.addEventListener("click", () => selectSettingsView(button.dataset.settingsView))); $$("[data-form-tab]").forEach((button) => button.addEventListener("click", () => selectFormTab(button.dataset.formTab)));
$("#cancel-edit").addEventListener("click", resetServerForm); $("#server-form").addEventListener("submit", async (event) => { event.preventDefault(); const id = $("#server-id").value; try { const response = await api(id ? `admin/servers/${id}` : "admin/servers", { method: id ? "PATCH" : "POST", body: JSON.stringify(await uploadSelectedBanner(serverPayload())) }); if (!response.ok) return setServerMessage(await message(response), true); setServerMessage("Server gespeichert."); resetServerForm(); await loadAdmin(); await loadPublic(); } catch (error) { setServerMessage(error.message || "Der Server konnte nicht gespeichert werden.", true); } });
$("#discover-server").addEventListener("click", discoverServerAddress);
$("#test-server").addEventListener("click", async () => { const id = $("#server-id").value; if (!id) return setServerMessage("Bitte den Server zuerst speichern.", true); const response = await api(`admin/servers/${id}/test`, { method: "POST", body: "{}" }); if (!response.ok) return setServerMessage(await message(response), true); const result = await response.json(); setServerMessage(`${stateInfo(result.status).label}: ${result.status.detail}`); await loadAdmin(); await loadPublic(); });
$("#settings-form").addEventListener("submit", async (event) => { event.preventDefault(); const trustedCommunityDomains = $("#setting-trusted-domains").value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean); const response = await api("admin/settings", { method: "POST", body: JSON.stringify({ siteTitle: $("#setting-title").value, siteDescription: $("#setting-description").value, accentColor: $("#setting-accent").value, defaultDetailRefreshSeconds: Number($("#setting-detail-refresh").value), monitoringIntervalSeconds: Number($("#setting-monitor-interval").value), trustedCommunityDomains }) }); text($("#settings-message"), response.ok ? "Gespeichert." : await message(response)); if (response.ok) await loadPublic(); });
$("#smtp-form").addEventListener("submit", async (event) => { event.preventDefault(); const webhookUrls = $("#webhook-urls").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean); const clearWebhooks = $("#clear-webhooks").checked; const response = await api("admin/settings", { method: "POST", body: JSON.stringify({ smtp: { host: $("#smtp-host").value, port: Number($("#smtp-port").value), username: $("#smtp-user").value, password: $("#smtp-password").value, from: $("#smtp-from").value, to: $("#smtp-to").value }, notifications: { notifyOffline: $("#notify-offline").checked, notifyRecovered: $("#notify-recovered").checked, latencyThresholdMs: Number($("#alert-latency").value), outageMinutes: Number($("#alert-outage").value) }, ...(webhookUrls.length || clearWebhooks ? { webhookUrls: clearWebhooks ? [] : webhookUrls } : {}) }) }); text($("#smtp-message"), response.ok ? "Benachrichtigungseinstellungen gespeichert." : await message(response)); if (response.ok) await loadAdmin(); });
$("#smtp-test").addEventListener("click", async () => { const response = await api("admin/notifications/test", { method: "POST", body: "{}" }); text($("#smtp-message"), response.ok ? "Testbenachrichtigung wurde gesendet." : await message(response)); });
async function download(path, filename) {
  const response = await api(path, { method: "POST", body: "{}" });
  if (!response.ok) throw new Error(await message(response));
  const objectUrl = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = objectUrl; link.download = filename; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
$("#export-backup").addEventListener("click", async () => { try { await download("admin/backup/export", "amp-community-dashboard-v2-backup.json"); text($("#backup-message"), "Sicherung wurde heruntergeladen."); } catch (error) { text($("#backup-message"), error.message); } }); $("#import-backup").addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (!confirm("Die Serverliste wird ersetzt. Vorher wird automatisch eine Sicherung erstellt. Fortfahren?")) return; if (file.size > 512_000) return text($("#backup-message"), "Die Sicherungsdatei ist zu groß."); try { const response = await api("admin/backup/import", { method: "POST", body: await file.text() }); text($("#backup-message"), response.ok ? `Import abgeschlossen. Automatische Sicherung: ${(await response.json()).automaticBackup}` : await message(response)); if (response.ok) { await loadAdmin(); await loadPublic(); } } catch { text($("#backup-message"), "Die Datei ist keine gültige Sicherung."); } });
function selectedCustomPermissions() { return $$("#custom-permissions input[name='permission']:checked").map((input) => input.value); }
function updateCustomPermissionUi() { const custom = $("#new-admin-role").value === "custom"; const visible = advancedMode && custom; $("#custom-permissions").hidden = !visible; if (visible) $("#custom-permissions").open = true; if (custom && !advancedMode) text($("#admin-message"), "Benutzerdefinierte Rechte sind im erweiterten Modus verfügbar."); }
$("#new-admin-role").addEventListener("change", updateCustomPermissionUi);
$("#admin-form").addEventListener("submit", async (event) => { event.preventDefault(); const formElement = event.currentTarget; const role = $("#new-admin-role").value; const response = await api("admin/admins", { method: "POST", body: JSON.stringify({ username: $("#new-admin-name").value, password: $("#new-admin-password").value, role, customPermissions: role === "custom" ? selectedCustomPermissions() : [] }) }); text($("#admin-message"), response.ok ? "Benutzer wurde hinzugefügt." : await message(response)); if (response.ok) { formElement.reset(); updateCustomPermissionUi(); await loadAdmin(); } }); $("#download-log").addEventListener("click", async () => { try { await download("admin/activity/download", "amp-community-dashboard-v2-aenderungsprotokoll.txt"); } catch (error) { text($("#admin-message"), error.message); } });

function closeSetup() { localStorage.setItem("amp_v2_setup_seen", "true"); if ($("#setup-dialog").open) $("#setup-dialog").close(); }
$("#setup-dismiss").addEventListener("click", closeSetup); $("#setup-dismiss-top").addEventListener("click", closeSetup);
$("#setup-add-server").addEventListener("click", () => { closeSetup(); if ($("#admin-dialog").open) switchPanel("servers"); else openAdmin().then(() => switchPanel("servers")); });
$("#setup-notifications").addEventListener("click", () => { closeSetup(); if ($("#admin-dialog").open) switchPanel("monitoring"); else openAdmin().then(() => switchPanel("monitoring")); });

function startLiveUpdates() {
  if (liveEvents) liveEvents.close();
  liveEvents = new EventSource("api/v1/public/events");
  liveEvents.addEventListener("dashboard", (event) => { try { applyDashboard(JSON.parse(event.data)); } catch { /* retry is automatic */ } });
  liveEvents.addEventListener("server-status", (event) => { try { applyStatusDelta(JSON.parse(event.data)); } catch { /* retry is automatic */ } });
  liveEvents.addEventListener("server-metric", (event) => { try { applyMetricPoint(JSON.parse(event.data)); } catch { /* retry is automatic */ } });
  liveEvents.addEventListener("settings-updated", (event) => { try { const value = JSON.parse(event.data); dashboard.settings = value.settings || dashboard.settings; dashboard.version = value.version || dashboard.version; applyBranding(dashboard.settings); } catch { /* retry is automatic */ } });
  liveEvents.addEventListener("resync", () => { loadPublic().catch(() => {}); });
  liveEvents.onerror = () => { text($("#live-label"), "Live-Verbindung wird wiederhergestellt …"); };
}
applyTheme(localStorage.getItem("amp_v2_theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
setUiMode(advancedMode);
function registerWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(dashboard.version || "current")}`).catch(() => {});
}
loadSession().then(async () => { await loadPublic(); registerWorker(); startLiveUpdates(); }).catch((error) => { text($("#live-label"), error.message || "Dashboard nicht erreichbar"); });
