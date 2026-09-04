import { DatabaseSync } from "node:sqlite";
import { chmod, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { config, roles } from "./config.mjs";
import { slugify } from "./validation.mjs";

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL, maximum_expires_at INTEGER NOT NULL, csrf_token TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(username) REFERENCES admins(username) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS login_rate_limits (
  scope TEXT NOT NULL, subject_hash TEXT NOT NULL, failures INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL, PRIMARY KEY(scope, subject_hash)
);
CREATE TABLE IF NOT EXISTS status_current (
  server_id TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT NOT NULL,
  latency_ms INTEGER, players INTEGER, max_players INTEGER, version TEXT, map_name TEXT,
  checked_at TEXT NOT NULL, last_success_at TEXT, state_since_at TEXT NOT NULL, failure_count INTEGER NOT NULL DEFAULT 0,
  last_history_at TEXT, FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, state TEXT NOT NULL,
  latency_ms INTEGER, players INTEGER, max_players INTEGER, checked_at TEXT NOT NULL,
  FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS status_history_by_server_time ON status_history(server_id, checked_at);
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL,
  subject TEXT NOT NULL, result TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_by_time ON activity_log(created_at DESC);
CREATE TRIGGER IF NOT EXISTS activity_log_append_only
BEFORE UPDATE ON activity_log BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
`;

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function now() { return new Date().toISOString(); }

function defaultSettings() {
  return {
    schemaVersion: 2,
    siteTitle: "Meine Gameserver",
    siteDescription: "",
    accentColor: "#42e8a5",
    defaultDetailRefreshSeconds: config.defaultRefreshSeconds,
    monitoringIntervalSeconds: config.defaultMonitorSeconds,
    smtp: { host: "", port: config.defaultSmtpPort, username: "", from: "", to: "" }
  };
}

function legacyServer(input, index) {
  const connection = input?.connection && typeof input.connection === "object"
    ? input.connection
    : input?.connectionHost ? { host: input.connectionHost, port: input.connectionPort, profile: input.connectionHint === "teamspeak" ? "teamspeak" : "auto", teamSpeakQueryPort: input.teamSpeakQueryPort || null } : null;
  const name = String(input?.name || "Unbenannter Server").slice(0, 70);
  return {
    id: typeof input?.id === "string" && input.id ? input.id : randomUUID(),
    name,
    slug: slugify(input?.slug || name),
    category: String(input?.category || "Allgemein").slice(0, 40),
    description: String(input?.description || "").slice(0, 300),
    notice: String(input?.notice || "").slice(0, 240),
    visibility: input?.visibility === "hidden" ? "hidden" : input?.visibility === "maintenance" ? "maintenance" : "public",
    communityUrl: String(input?.communityUrl || input?.url || ""),
    connectUrl: String(input?.connectUrl || ""),
    iconUrl: "",
    accentColor: "",
    connection: connection?.host && connection?.port ? { host: connection.host, port: Number(connection.port), profile: connection.profile || (connection.serviceHint === "teamspeak" ? "teamspeak" : "auto"), teamSpeakQueryPort: connection.teamSpeakQueryPort || null } : null,
    links: { website: "", discord: "", wiki: "", map: "", modpack: "" },
    monitoring: { enabled: true, intervalSeconds: 30 },
    display: { showPlayers: true, showPing: true, showVersion: true },
    sortOrder: Number.isInteger(input?.sortOrder) ? input.sortOrder : index,
    createdAt: input?.createdAt || now(),
    updatedAt: now()
  };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

function redactSmtpSecrets(value) {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  if (Array.isArray(value)) return value.reduce((any, item) => redactSmtpSecrets(item) || any, false);
  for (const key of Object.keys(value)) {
    if (key === "smtpPassword" || (key === "password" && ("smtp" in value || "host" in value || "port" in value || "username" in value))) { delete value[key]; changed = true; continue; }
    changed = redactSmtpSecrets(value[key]) || changed;
  }
  return changed;
}

async function redactJsonFile(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!redactSmtpSecrets(value)) return;
    await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
    await chmod(file, 0o600);
  } catch { /* not a JSON backup or not readable */ }
}

async function redactBackupDirectory(directory) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await redactBackupDirectory(file);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) await redactJsonFile(file);
  }
}

export class Store {
  constructor(database, dataDirectory, backupDirectory, secretsDirectory) {
    this.db = database;
    this.dataDirectory = dataDirectory;
    this.backupDirectory = backupDirectory;
    this.secretsDirectory = secretsDirectory;
  }

  getMeta(key) { return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)); }

  getSettings() {
    const stored = this.db.prepare("SELECT payload FROM settings WHERE id = 1").get();
    const base = defaultSettings();
    const value = stored ? parse(stored.payload, {}) : {};
    const settings = { ...base, ...value, smtp: { ...base.smtp, ...(value.smtp || {}) } };
    // Passwords from v2.1 and older are only read here for the one-time
    // migration below. New settings never expose or persist this field.
    return settings;
  }

  saveSettings(settings) {
    const { smtpSecret, ...persisted } = settings;
    const smtp = { ...(persisted.smtp || {}) };
    delete smtp.password;
    persisted.smtp = smtp;
    this.db.prepare("INSERT INTO settings(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(persisted));
    return persisted;
  }

  async getSmtpPassword() {
    try { return (await readFile(config.smtpSecretFile, "utf8")).trim(); } catch { return ""; }
  }

  async setSmtpPassword(value) {
    const password = String(value || "").slice(0, 512);
    await mkdir(this.secretsDirectory, { recursive: true, mode: 0o700 });
    if (!password) { await writeFile(config.smtpSecretFile, "", { mode: 0o600 }); await chmod(config.smtpSecretFile, 0o600); return; }
    const temporary = `${config.smtpSecretFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, password, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, config.smtpSecretFile);
    await chmod(config.smtpSecretFile, 0o600);
  }

  async smtpPasswordConfigured() { return Boolean(await this.getSmtpPassword()); }

  allServers() {
    return this.db.prepare("SELECT * FROM servers ORDER BY sort_order ASC, created_at ASC").all().map((row) => ({ ...parse(row.payload, {}), id: row.id, slug: row.slug, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  findServer(id) { return this.allServers().find((server) => server.id === id) || null; }

  saveServer(server) {
    this.db.prepare(`INSERT INTO servers(id,slug,sort_order,created_at,updated_at,payload) VALUES(:id,:slug,:sortOrder,:createdAt,:updatedAt,:payload)
      ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, sort_order=excluded.sort_order, updated_at=excluded.updated_at, payload=excluded.payload`).run({ id: server.id, slug: server.slug, sortOrder: server.sortOrder, createdAt: server.createdAt, updatedAt: server.updatedAt, payload: JSON.stringify(server) });
    return server;
  }

  removeServer(id) {
    const server = this.findServer(id);
    if (!server) return null;
    this.db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    this.reindexServers();
    return server;
  }

  replaceServers(servers) {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM servers");
      servers.forEach((server, index) => this.saveServer({ ...server, sortOrder: index }));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.allServers();
  }

  reindexServers() {
    this.allServers().forEach((server, index) => this.db.prepare("UPDATE servers SET sort_order = ? WHERE id = ?").run(index, server.id));
  }

  reorder(ids) {
    const servers = this.allServers();
    if (ids.length !== servers.length || new Set(ids).size !== ids.length || !ids.every((id) => servers.some((server) => server.id === id))) throw new Error("Die Sortierung ist ungültig.");
    this.db.exec("BEGIN");
    try { ids.forEach((id, index) => this.db.prepare("UPDATE servers SET sort_order = ? WHERE id = ?").run(index, id)); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.allServers();
  }

  getStatus(id) { return this.db.prepare("SELECT * FROM status_current WHERE server_id = ?").get(id) || null; }

  allStatuses() {
    const output = new Map();
    for (const row of this.db.prepare("SELECT * FROM status_current").all()) output.set(row.server_id, this.statusRow(row));
    return output;
  }

  statusRow(row) {
    return {
      state: row.state, detail: row.detail, latencyMs: row.latency_ms, players: row.players, maxPlayers: row.max_players,
      version: row.version, map: row.map_name, checkedAt: row.checked_at, lastSuccessAt: row.last_success_at,
      stateSinceAt: row.state_since_at, failureCount: row.failure_count
    };
  }

  saveStatus(serverId, status) {
    const previous = this.getStatus(serverId);
    const changed = !previous || previous.state !== status.state;
    const timestamp = status.checkedAt || now();
    const lastSuccess = status.state === "ONLINE" ? timestamp : previous?.last_success_at || null;
    const stateSince = changed ? timestamp : previous?.state_since_at || timestamp;
    const failures = status.state === "ONLINE" ? 0 : (previous?.failure_count || 0) + 1;
    const addHistory = changed || !previous?.last_history_at || Date.parse(timestamp) - Date.parse(previous.last_history_at) >= 5 * 60_000;
    this.db.prepare(`INSERT INTO status_current(server_id,state,detail,latency_ms,players,max_players,version,map_name,checked_at,last_success_at,state_since_at,failure_count,last_history_at)
      VALUES(:serverId,:state,:detail,:latencyMs,:players,:maxPlayers,:version,:map,:checkedAt,:lastSuccessAt,:stateSinceAt,:failureCount,:lastHistoryAt)
      ON CONFLICT(server_id) DO UPDATE SET state=excluded.state,detail=excluded.detail,latency_ms=excluded.latency_ms,players=excluded.players,max_players=excluded.max_players,version=excluded.version,map_name=excluded.map_name,checked_at=excluded.checked_at,last_success_at=excluded.last_success_at,state_since_at=excluded.state_since_at,failure_count=excluded.failure_count,last_history_at=excluded.last_history_at`).run({
      // The status probes may carry internal helper values (for example the raw
      // Steam response). Pass only the values that are actually SQL parameters.
      // Node 22 correctly rejects unknown named parameters here.
      serverId,
      state: status.state,
      detail: status.detail,
      checkedAt: timestamp,
      lastSuccessAt: lastSuccess,
      stateSinceAt: stateSince,
      failureCount: failures,
      lastHistoryAt: addHistory ? timestamp : previous?.last_history_at || null,
      latencyMs: status.latencyMs ?? null,
      players: status.players ?? null,
      maxPlayers: status.maxPlayers ?? null,
      version: status.version ?? null,
      map: status.map ?? null
    });
    if (addHistory) this.db.prepare("INSERT INTO status_history(server_id,state,latency_ms,players,max_players,checked_at) VALUES(?,?,?,?,?,?)").run(serverId, status.state, status.latencyMs ?? null, status.players ?? null, status.maxPlayers ?? null, timestamp);
    return { changed, previous: previous ? this.statusRow(previous) : null, current: this.statusRow(this.getStatus(serverId)) };
  }

  uptime(serverId, hours) {
    const until = Date.now();
    const from = until - hours * 60 * 60_000;
    const rows = this.db.prepare("SELECT state, checked_at FROM status_history WHERE server_id = ? AND checked_at >= ? ORDER BY checked_at ASC").all(serverId, new Date(from).toISOString());
    const prior = this.db.prepare("SELECT state, checked_at FROM status_history WHERE server_id = ? AND checked_at < ? ORDER BY checked_at DESC LIMIT 1").get(serverId, new Date(from).toISOString());
    if (!prior && !rows.length) return null;
    let state = prior?.state || rows[0]?.state || "UNKNOWN";
    let cursor = from;
    let online = 0;
    for (const row of rows) {
      const at = Math.min(until, Date.parse(row.checked_at));
      if (state === "ONLINE") online += Math.max(0, at - cursor);
      cursor = at;
      state = row.state;
    }
    if (state === "ONLINE") online += Math.max(0, until - cursor);
    return Math.round((online / (until - from)) * 10_000) / 100;
  }

  cleanup(retention) {
    const activityBefore = new Date(Date.now() - retention.activityMs).toISOString();
    const historyBefore = new Date(Date.now() - retention.historyMs).toISOString();
    this.db.prepare("DELETE FROM activity_log WHERE created_at < ?").run(activityBefore);
    this.db.prepare("DELETE FROM status_history WHERE checked_at < ?").run(historyBefore);
  }

  addActivity(username, action, subject = "", result = "ok", detail = "") {
    const redact = (value, maximum) => String(value || "")
      .replace(/(pass(?:word)?|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[geschützt]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/g, "[interne Adresse]")
      .slice(0, maximum);
    this.db.prepare("INSERT INTO activity_log(id,created_at,username,action,subject,result,detail) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), now(), redact(username, 32), redact(action, 100), redact(subject, 120), result === "error" ? "error" : "ok", redact(detail, 300));
  }

  latestActivity(limit = 5) { return this.db.prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?").all(limit); }
  allActivity() { return this.db.prepare("SELECT * FROM activity_log ORDER BY created_at DESC").all(); }

  listAdmins() { return this.db.prepare("SELECT username,role,created_at FROM admins ORDER BY username COLLATE NOCASE").all().map((item) => ({ username: item.username, role: item.role, createdAt: item.created_at })); }
  getAdmin(username) { return this.db.prepare("SELECT * FROM admins WHERE username = ?").get(username) || null; }
  addAdmin(admin) { this.db.prepare("INSERT INTO admins(username,salt,hash,role,created_at) VALUES(:username,:salt,:hash,:role,:createdAt)").run(admin); }
  updateAdminRole(username, role) { this.db.prepare("UPDATE admins SET role = ? WHERE username = ?").run(role, username); }
  removeAdmin(username) { this.db.prepare("DELETE FROM admins WHERE username = ?").run(username); }
  adminCount() { return Number(this.db.prepare("SELECT count(*) AS count FROM admins").get().count); }

  createSession(tokenHash, csrfToken, username, idleMs, maximumMs) {
    const started = Date.now();
    this.db.prepare("DELETE FROM sessions WHERE username = ?").run(username);
    this.db.prepare("INSERT INTO sessions(token_hash,username,created_at,last_seen_at,idle_expires_at,maximum_expires_at,csrf_token) VALUES(?,?,?,?,?,?,?)").run(tokenHash, username, started, started, started + idleMs, started + maximumMs, csrfToken);
  }

  getSession(tokenHash, idleMs) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
    const current = Date.now();
    if (!row || row.idle_expires_at <= current || row.maximum_expires_at <= current) { if (row) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash); return null; }
    this.db.prepare("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?").run(current, Math.min(current + idleMs, row.maximum_expires_at), tokenHash);
    return row;
  }
  removeSession(tokenHash) { this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash); }
  removeSessionsFor(username) { this.db.prepare("DELETE FROM sessions WHERE username = ?").run(username); }

  loginRetryAfter(ipHash, usernameHash) {
    const current = Date.now();
    const rows = this.db.prepare("SELECT failures,last_failure_at FROM login_rate_limits WHERE (scope = 'ip' AND subject_hash = ?) OR (scope = 'username' AND subject_hash = ?)").all(ipHash, usernameHash);
    const waits = [1_000, 2_000, 5_000, 15_000, 60_000, 5 * 60_000];
    return rows.reduce((maximum, row) => Math.max(maximum, Math.max(0, Math.ceil((row.last_failure_at + waits[Math.min(row.failures - 1, waits.length - 1)] - current) / 1000))), 0);
  }

  recordLoginFailure(ipHash, usernameHash) {
    const current = Date.now();
    for (const [scope, subjectHash] of [["ip", ipHash], ["username", usernameHash]]) {
      this.db.prepare(`INSERT INTO login_rate_limits(scope,subject_hash,failures,last_failure_at) VALUES(?,?,1,?)
        ON CONFLICT(scope,subject_hash) DO UPDATE SET failures = CASE WHEN login_rate_limits.last_failure_at < ? THEN 1 ELSE MIN(login_rate_limits.failures + 1, 20) END, last_failure_at = excluded.last_failure_at`).run(scope, subjectHash, current, current - 15 * 60_000);
    }
  }

  clearLoginFailures(ipHash, usernameHash) {
    this.db.prepare("DELETE FROM login_rate_limits WHERE (scope = 'ip' AND subject_hash = ?) OR (scope = 'username' AND subject_hash = ?)").run(ipHash, usernameHash);
  }

  cleanupLoginFailures() { this.db.prepare("DELETE FROM login_rate_limits WHERE last_failure_at < ?").run(Date.now() - 15 * 60_000); }

  exportData() {
    const settings = this.getSettings();
    return {
      version: 7, exportedAt: now(), settings: { ...settings, smtp: { ...settings.smtp } },
      servers: this.allServers(), admins: this.listAdmins()
    };
  }

  async snapshotBeforeImport() {
    await mkdir(this.backupDirectory, { recursive: true });
    const file = join(this.backupDirectory, `backup-before-import-${now().replace(/[:.]/g, "-")}.json`);
    await writeFile(file, JSON.stringify(this.exportData(), null, 2), { mode: 0o600 });
    return basename(file);
  }

  async migrateLegacy() {
    if (this.getMeta("v2-migrated") === "true") return;
    const legacyFiles = ["servers.json", "settings.json", "admins.json", "admin.json", "activity-log.json"];
    const source = {};
    for (const file of legacyFiles) source[file] = await readJson(join(this.dataDirectory, file));
    if (legacyFiles.some((file) => source[file] !== null)) {
      const folder = join(this.backupDirectory, `v1-before-v2-${now().replace(/[:.]/g, "-")}`);
      await mkdir(folder, { recursive: true });
      for (const file of legacyFiles) {
        try { await copyFile(join(this.dataDirectory, file), join(folder, file)); } catch { /* file did not exist */ }
      }
    }
    if (this.allServers().length === 0 && Array.isArray(source["servers.json"])) {
      const slugs = new Set();
      source["servers.json"].forEach((raw, index) => {
        const server = legacyServer(raw, index);
        let slug = server.slug;
        let suffix = 2;
        while (slugs.has(slug)) slug = `${server.slug}-${suffix++}`;
        slugs.add(slug);
        this.saveServer({ ...server, slug });
      });
    }
    const oldSettings = source["settings.json"] || {};
    const settings = this.getSettings();
    const legacySmtpPassword = oldSettings.smtpPassword || "";
    this.saveSettings({ ...settings, siteTitle: oldSettings.siteTitle || settings.siteTitle, smtp: {
      ...settings.smtp, host: oldSettings.smtpHost || "", port: Number(oldSettings.smtpPort) || config.defaultSmtpPort, username: oldSettings.smtpUsername || "", from: oldSettings.smtpFrom || "", to: oldSettings.smtpTo || ""
    } });
    if (legacySmtpPassword) await this.setSmtpPassword(legacySmtpPassword);
    const importedAdmins = Array.isArray(source["admins.json"]) ? source["admins.json"] : source["admin.json"] ? [source["admin.json"]] : [];
    if (this.adminCount() === 0) for (const admin of importedAdmins) {
      if (admin?.username && admin?.salt && admin?.hash) this.addAdmin({ username: admin.username, salt: admin.salt, hash: admin.hash, role: roles.has(admin.role) ? admin.role : "owner", createdAt: admin.createdAt || now() });
    }
    if (Array.isArray(source["activity-log.json"])) for (const entry of source["activity-log.json"]) {
      if (entry?.createdAt && entry?.username && entry?.action) this.db.prepare("INSERT OR IGNORE INTO activity_log(id,created_at,username,action,subject,result,detail) VALUES(?,?,?,?,?,?,?)").run(entry.id || randomUUID(), entry.createdAt, entry.username, entry.action, "", "ok", entry.detail || "");
    }
    this.setMeta("v2-migrated", "true");
  }

  async migrateSmtpSecret() {
    if (this.getMeta("smtp-secret-v2.1.1") === "true") return;
    const settings = this.getSettings();
    const oldPassword = String(settings.smtp?.password || "");
    if (oldPassword && !(await this.getSmtpPassword())) await this.setSmtpPassword(oldPassword);
    delete settings.smtp.password;
    this.saveSettings(settings);
    await redactJsonFile(join(this.dataDirectory, "settings.json"));
    await redactBackupDirectory(this.backupDirectory);
    // Old session rows do not have a CSRF secret. Deliberately invalidate them
    // instead of silently accepting a session without CSRF protection.
    this.db.exec("DELETE FROM sessions");
    this.db.exec("VACUUM");
    this.setMeta("smtp-secret-v2.1.1", "true");
  }
}

export async function openStore() {
  await mkdir(config.dataDirectory, { recursive: true });
  await mkdir(config.backupDirectory, { recursive: true });
  await mkdir(config.secretsDirectory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(config.databaseFile);
  try { await chmod(config.databaseFile, 0o600); } catch { /* platform may not support chmod */ }
  database.exec(schema);
  // The column is added separately for databases created by v2.0/v2.1.
  try { database.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT ''"); } catch { /* already migrated */ }
  const store = new Store(database, config.dataDirectory, config.backupDirectory, config.secretsDirectory);
  await store.migrateLegacy();
  await store.migrateSmtpSecret();
  store.cleanup({ activityMs: config.activityRetentionMs, historyMs: config.historyRetentionMs });
  store.cleanupLoginFailures();
  return store;
}
