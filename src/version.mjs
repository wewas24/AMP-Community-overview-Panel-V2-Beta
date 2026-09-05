import { readFile } from "node:fs/promises";

const packageFile = new URL("../package.json", import.meta.url);
const packageInfo = JSON.parse(await readFile(packageFile, "utf8"));

export const APP_VERSION = String(packageInfo.version || "0.0.0");
