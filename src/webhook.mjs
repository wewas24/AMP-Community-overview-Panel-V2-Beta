import { request } from "node:https";
import { isIP } from "node:net";
import { resolveSafeTarget } from "./security.mjs";

const timeoutMs = 10_000;
const maximumResponseBytes = 32 * 1024;

export async function sendWebhook(urlValue, message, allowPrivateNetworks = false) {
  const url = new URL(String(urlValue || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new Error("Webhook-Adresse muss eine öffentliche HTTPS-Adresse auf Port 443 sein.");
  const address = await resolveSafeTarget(url.hostname, allowPrivateNetworks);
  const payload = Buffer.from(JSON.stringify({ content: String(message || "").slice(0, 1_900) }), "utf8");
  return new Promise((resolve, reject) => {
    const pending = request({ protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: "POST", maxHeaderSize: 8_192,
      headers: { "Content-Type": "application/json", "Content-Length": payload.length, "User-Agent": "AMP-Community-Dashboard/2.2" },
      servername: isIP(url.hostname) ? undefined : url.hostname,
      lookup: (_host, _options, callback) => callback(null, address, isIP(address) || 4)
    }, (response) => {
      let received = 0;
      response.on("data", (chunk) => { received += chunk.length; if (received > maximumResponseBytes) response.destroy(); });
      response.once("end", () => response.statusCode && response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error("Webhook-Dienst hat die Nachricht abgelehnt.")));
      response.once("error", () => reject(new Error("Webhook-Dienst ist nicht erreichbar.")));
    });
    pending.once("error", () => reject(new Error("Webhook-Dienst ist nicht erreichbar.")));
    pending.setTimeout(timeoutMs, () => pending.destroy());
    pending.end(payload);
  });
}
