const baseUrl = process.argv[2] || "http://127.0.0.1:3101";
const durationMs = 40_000;
const controller = new AbortController();
const startedAt = performance.now();
const abortTimer = setTimeout(() => controller.abort(), durationMs);
let bytes = 0;
let events = 0;
let firstEventAt = null;
let lastEventAt = null;
let remainder = "";

try {
  const response = await fetch(`${baseUrl}/api/v1/public/events`, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE-Verbindung nicht verfügbar (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    remainder += decoder.decode(value, { stream: true });
    const lines = remainder.split("\n");
    remainder = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("event:")) continue;
      events += 1;
      const at = performance.now();
      firstEventAt ??= at;
      lastEventAt = at;
    }
  }
} catch (error) {
  if (error?.name !== "AbortError") throw error;
} finally {
  clearTimeout(abortTimer);
}

const sampledMs = performance.now() - startedAt;
const firstEventMs = firstEventAt === null ? null : Math.round(firstEventAt - startedAt);
const burstMs = firstEventAt === null || lastEventAt === null ? null : Math.round(lastEventAt - firstEventAt);
console.log(JSON.stringify({
  sampledMs: Math.round(sampledMs),
  events,
  bytes,
  firstEventAfterMs: firstEventMs,
  eventBurstMs: burstMs
}, null, 2));
