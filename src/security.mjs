import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function passwordRecord(password) {
  const salt = randomBytes(16).toString("base64url");
  return { salt, hash: scryptSync(password, salt, 64).toString("base64url") };
}

export function passwordMatches(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const candidate = scryptSync(password, record.salt, 64).toString("base64url");
  return candidate.length === record.hash.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(record.hash));
}

export function tokenHash(token) {
  return createHash("sha256").update(token).digest("base64url");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const octets = value.split(".").map(Number);
    const [first, second] = octets;
    return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  if (isIP(value) === 6) {
    if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(value)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return false;
}

export async function resolveSafeTarget(host, allowPrivateNetworks) {
  const value = String(host || "").trim().replace(/^\[|\]$/g, "");
  if (isIP(value)) {
    if (!allowPrivateNetworks && isPrivateAddress(value)) {
      const error = new Error("Private oder lokale Netzwerkadressen sind nicht freigegeben.");
      error.code = "PRIVATE_ADDRESS";
      throw error;
    }
    return value;
  }
  let addresses;
  try {
    addresses = await lookup(value, { all: true, verbatim: true });
  } catch {
    const error = new Error("Der Hostname konnte nicht aufgelöst werden.");
    error.code = "DNS_ERROR";
    throw error;
  }
  if (!addresses.length || (!allowPrivateNetworks && addresses.some((item) => isPrivateAddress(item.address)))) {
    const error = new Error("Der Hostname zeigt auf eine nicht freigegebene Adresse.");
    error.code = "PRIVATE_ADDRESS";
    throw error;
  }
  return addresses[0].address;
}

export class LoginLimiter {
  constructor() {
    this.byIp = new Map();
    this.byUser = new Map();
    this.global = [];
  }

  cleanup(now) {
    const keep = (entry) => entry.last > now - 5 * 60_000;
    for (const map of [this.byIp, this.byUser]) for (const [key, value] of map) if (!keep(value)) map.delete(key);
    this.global = this.global.filter((time) => time > now - 60_000);
  }

  retryAfter(ip, username) {
    const now = Date.now();
    this.cleanup(now);
    if (this.global.length >= 50) return 60;
    const entry = this.byIp.get(ip) || this.byUser.get(username);
    if (!entry) return 0;
    const waits = [1_000, 2_000, 5_000, 15_000, 60_000];
    const required = waits[Math.min(entry.count - 1, waits.length - 1)];
    return Math.max(0, Math.ceil((entry.last + required - now) / 1000));
  }

  failed(ip, username) {
    const now = Date.now();
    for (const [map, key] of [[this.byIp, ip], [this.byUser, username]]) {
      const old = map.get(key);
      map.set(key, { count: (old?.count || 0) + 1, last: now });
    }
    this.global.push(now);
  }

  succeeded(ip, username) {
    this.byIp.delete(ip);
    this.byUser.delete(username);
  }
}
