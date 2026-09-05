import test from "node:test";
import assert from "node:assert/strict";
import { permissions } from "../src/config.mjs";
import { hasPermission, permissionFor } from "../src/permissions.mjs";

test("ordnet jedem geschützten API-Endpunkt die erwartete Berechtigung zu", () => {
  const cases = [
    ["dashboard", "GET", "dashboard.read"], ["servers", "GET", "servers.read"], ["servers", "POST", "servers.write"],
    ["servers/discover", "POST", "servers.discover"], ["servers/id", "PATCH", "servers.write"], ["servers/id", "DELETE", "servers.write"],
    ["servers/reorder", "POST", "servers.write"], ["servers/id/duplicate", "POST", "servers.write"], ["servers/id/test", "POST", "servers.test"],
    ["uploads", "POST", "servers.write"], ["settings", "GET", "settings.write"], ["settings", "POST", "settings.write"],
    ["notifications/test", "POST", "notifications.test"], ["admins", "GET", "access.write"], ["admins", "POST", "access.write"],
    ["admins/name", "PATCH", "access.write"], ["admins/name", "DELETE", "access.write"], ["activity", "GET", "logs.read"],
    ["activity/download", "POST", "logs.export"], ["backup/export", "POST", "backup.export"], ["backup/import", "POST", "backup.import"]
  ];
  for (const [path, method, expected] of cases) {
    assert.equal(permissionFor(path, method), expected, `${method} ${path}`);
    assert.equal(permissions.owner.has(expected), true, `owner: ${method} ${path}`);
  }
});

test("direkte API-Aufrufe ohne Sitzung oder ohne Recht bleiben gesperrt", () => {
  assert.equal(hasPermission(null, "servers.write"), false);
  assert.equal(hasPermission({ permissions: permissions.auditor }, "servers.write"), false);
  assert.equal(hasPermission({ permissions: permissions.editor }, "servers.write"), true);
  assert.equal(hasPermission({ permissions: permissions.editor }, "backup.import"), false);
});
