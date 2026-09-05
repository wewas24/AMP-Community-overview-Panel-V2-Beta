export function permissionFor(remainder, method) {
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
  if (remainder === "uploads") return "servers.write";
  return "dashboard.read";
}

export function hasPermission(session, permission) {
  return Boolean(session?.permissions?.has(permission));
}
