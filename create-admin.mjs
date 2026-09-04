import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { openStore } from "./src/storage.mjs";
import { passwordRecord } from "./src/security.mjs";
import { validPassword, validUsername } from "./src/validation.mjs";

async function password(question) {
  if (!input.isTTY) throw new Error("Für die sichere Passworteingabe wird ein Terminal benötigt.");
  return new Promise((resolve, reject) => {
    let value = ""; let done = false;
    const finish = () => { if (done) return; done = true; input.setRawMode(false); input.pause(); input.off("data", received); output.write("\n"); resolve(value); };
    const received = (chunk) => { for (const character of chunk.toString("utf8")) { if (character === "\u0003") return reject(new Error("Abgebrochen.")); if (character === "\r" || character === "\n") return finish(); if (character === "\u007f" || character === "\b") value = value.slice(0, -1); else value += character; } };
    output.write(question); input.setRawMode(true); input.resume(); input.on("data", received);
  });
}

async function main() {
  const store = await openStore();
  if (store.adminCount()) throw new Error("Es gibt bereits ein Administratorkonto. Es wurde nichts geändert.");
  const readline = createInterface({ input, output });
  const username = (process.argv[2] || await readline.question("Admin-Benutzername: ")).trim(); readline.close();
  if (!validUsername(username)) throw new Error("Der Benutzername muss 3–32 Zeichen lang sein und darf nur Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich enthalten.");
  const first = await password("Passwort (mindestens 12 Zeichen): "); const second = await password("Passwort wiederholen: ");
  if (!validPassword(first)) throw new Error("Das Passwort muss mindestens 12 Zeichen lang sein."); if (first !== second) throw new Error("Die Passwörter stimmen nicht überein.");
  store.addAdmin({ username, ...(await passwordRecord(first)), role: "owner", createdAt: new Date().toISOString() }); store.addActivity(username, "Erstes Administratorkonto erstellt"); console.log(`Administratorkonto „${username}“ wurde erstellt.`);
}
main().catch((error) => { console.error(`Fehler: ${error.message}`); process.exitCode = 1; });
