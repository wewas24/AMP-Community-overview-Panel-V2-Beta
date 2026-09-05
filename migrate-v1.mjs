import { access, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./src/config.mjs";
import { openStore } from "./src/storage.mjs";

const legacyFiles = ["servers.json", "settings.json", "admins.json", "admin.json", "activity-log.json"];
const apply = process.argv.includes("--apply");

async function available(file) { try { await access(file); return true; } catch { return false; } }
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } }

async function main() {
  const sources = await Promise.all(legacyFiles.map(async (name) => ({ name, file: join(config.dataDirectory, name), exists: await available(join(config.dataDirectory, name)) })));
  const servers = await readJson(join(config.dataDirectory, "servers.json"), []);
  const plan = { foundFiles: sources.filter((item) => item.exists).map((item) => item.name), servers: Array.isArray(servers) ? servers.length : 0 };
  if (!apply) {
    console.log("Dry Run – es wurden keine Dateien verändert.");
    console.log(`Gefundene V1-Dateien: ${plan.foundFiles.join(", ") || "keine"}`);
    console.log(`Zu übernehmende Server: ${plan.servers}`);
    console.log("Nach Prüfung mit: node migrate-v1.mjs --apply");
    return;
  }
  if (await available(config.databaseFile)) throw new Error("Es existiert bereits eine V2-Datenbank. Für diese Installation ist keine V1-Migration nötig.");
  const backup = join(config.backupDirectory, `manual-v1-before-migration-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const source of sources.filter((item) => item.exists)) await copyFile(source.file, join(backup, source.name));
  try {
    const store = await openStore();
    const count = store.allServers().length;
    store.db.close();
    if (count !== plan.servers) throw new Error(`Validierung fehlgeschlagen: erwartet ${plan.servers}, übernommen ${count}.`);
    console.log(`Migration abgeschlossen und validiert. Originale V1-Dateien bleiben unverändert. Backup: ${backup}`);
  } catch (error) {
    if (await available(config.databaseFile)) await rename(config.databaseFile, join(backup, "dashboard-v2-failed.sqlite"));
    throw error;
  }
}
main().catch((error) => { console.error(`Migration abgebrochen: ${error.message}`); process.exitCode = 1; });
