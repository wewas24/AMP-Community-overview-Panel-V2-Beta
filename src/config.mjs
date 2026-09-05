import { resolve } from "node:path";

const requestedHost = process.env.HOST || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const dataDirectory = resolve(process.env.DATA_DIRECTORY || "data");

export const config = {
  // A public Node listener bypasses the HTTPS proxy and its protection. It is
  // only allowed when an operator explicitly opts in for a controlled setup.
  host: loopbackHosts.has(requestedHost) || process.env.ALLOW_PUBLIC_BIND === "true" ? requestedHost : "127.0.0.1",
  port: Number(process.env.PORT || 3100),
  cookieSecure: process.env.COOKIE_SECURE !== "false",
  allowPrivateNetworks: process.env.ALLOW_PRIVATE_NETWORKS === "true",
  publicDirectory: resolve("public"),
  dataDirectory,
  databaseFile: resolve(dataDirectory, "dashboard-v2.sqlite"),
  backupDirectory: resolve(dataDirectory, "backups"),
  secretsDirectory: resolve(dataDirectory, "secrets"),
  smtpSecretFile: resolve(dataDirectory, "secrets", "smtp-password"),
  webhookSecretFile: resolve(dataDirectory, "secrets", "webhook-urls.json"),
  uploadsDirectory: resolve(dataDirectory, "uploads"),
  sessionIdleMs: 30 * 60 * 1000,
  sessionMaximumMs: 12 * 60 * 60 * 1000,
  statusIntervalMs: 30_000,
  statusTimeoutMs: 4_000,
  maxParallelChecks: 6,
  maxServers: 250,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100,
  maxUploadBytes: 2 * 1024 * 1024,
  trustedProxyAddresses: (process.env.TRUSTED_PROXY_ADDRESSES || "127.0.0.1,::1").split(",").map((value) => value.trim()).filter(Boolean),
  activityRetentionMs: 7 * 24 * 60 * 60 * 1000,
  historyRetentionMs: 90 * 24 * 60 * 60 * 1000,
  defaultRefreshSeconds: 0,
  defaultMonitorSeconds: 30,
  defaultSmtpPort: 587,
  smtpAllowedPorts: new Set((process.env.SMTP_ALLOWED_PORTS || "25,587,2525").split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0 && value <= 65535)),
  communityAllowedPorts: new Set((process.env.COMMUNITY_ALLOWED_PORTS || "443,8443").split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0 && value <= 65535))
};

export const permissionCodes = ["dashboard.read", "servers.read", "servers.write", "servers.test", "servers.discover", "settings.write", "notifications.test", "access.write", "logs.read", "logs.export", "backup.export", "backup.import"];
export const roles = new Set(["owner", "editor", "support", "auditor", "custom"]);
export const permissions = {
  owner: new Set(["dashboard.read", "servers.read", "servers.write", "servers.test", "servers.discover", "settings.write", "notifications.test", "access.write", "logs.read", "logs.export", "backup.export", "backup.import"]),
  editor: new Set(["servers.read", "servers.write"]),
  support: new Set(["dashboard.read", "servers.read", "logs.read"]),
  auditor: new Set(["dashboard.read"]),
  custom: new Set()
};

export const publicStates = new Set(["ONLINE", "REACHABLE", "OFFLINE", "TIMEOUT", "CONNECTION_REFUSED", "DNS_ERROR", "QUERY_FAILED", "QUERY_UNSUPPORTED", "MAINTENANCE", "DISABLED", "UNKNOWN"]);
