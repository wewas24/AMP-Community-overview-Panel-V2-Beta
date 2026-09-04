import { resolve } from "node:path";

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3100),
  cookieSecure: process.env.COOKIE_SECURE !== "false",
  allowPrivateNetworks: process.env.ALLOW_PRIVATE_NETWORKS === "true",
  publicDirectory: resolve("public"),
  dataDirectory: resolve("data"),
  databaseFile: resolve("data", "dashboard-v2.sqlite"),
  backupDirectory: resolve("data", "backups"),
  sessionIdleMs: 30 * 60 * 1000,
  sessionMaximumMs: 12 * 60 * 60 * 1000,
  statusIntervalMs: 30_000,
  statusTimeoutMs: 4_000,
  maxParallelChecks: 6,
  activityRetentionMs: 7 * 24 * 60 * 60 * 1000,
  historyRetentionMs: 90 * 24 * 60 * 60 * 1000,
  defaultRefreshSeconds: 0,
  defaultMonitorSeconds: 30,
  defaultSmtpPort: 587
};

export const roles = new Set(["owner", "editor", "auditor"]);
export const permissions = {
  owner: new Set(["dashboard", "servers", "settings", "notifications", "access", "logs", "backup"]),
  editor: new Set(["servers"]),
  auditor: new Set(["logs"])
};

export const publicStates = new Set(["ONLINE", "OFFLINE", "TIMEOUT", "CONNECTION_REFUSED", "DNS_ERROR", "QUERY_FAILED", "QUERY_UNSUPPORTED", "MAINTENANCE", "DISABLED", "UNKNOWN"]);
