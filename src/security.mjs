import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const scryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function passwordRecord(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = (await scryptAsync(password, salt, 64, scryptOptions)).toString("base64url");
  return { salt, hash };
}

export async function passwordMatches(password, record) {
  // Always derive a hash. Callers pass a fixed dummy record for unknown users,
  // so an account name can never be inferred from the response time.
  const salt = record?.salt || "0000000000000000000000";
  const stored = record?.hash || "";
  const candidate = (await scryptAsync(String(password || ""), salt, 64, scryptOptions)).toString("base64url");
  return candidate.length === stored.length && Boolean(stored) && timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
}

export function tokenHash(token) {
  return createHash("sha256").update(token).digest("base64url");
}

export function secretHash(value) {
  return createHash("sha256").update(String(value || "")).digest("base64url");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function ipv4Octets(value) {
  if (isIP(value) !== 4) return null;
  return value.split(".").map(Number);
}

function isBlockedIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  // RFC 1918, loopback, link-local, carrier-grade NAT, documentation,
  // benchmarking, multicast and all reserved/broadcast ranges.
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function normalizedIpv6(value) {
  return String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
}

function mappedIpv4(value) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalizedIpv6(value));
  return match ? match[1] : null;
}

function isBlockedIpv6(value) {
  const address = normalizedIpv6(value);
  const mapped = mappedIpv4(address);
  if (mapped) return isBlockedIpv4(mapped);
  // Public IPv6 unicast addresses are within 2000::/3. Everything else is
  // local, unique-local, link-local, multicast, documentation or reserved.
  if (!/^[23]/.test(address)) return true;
  return address.startsWith("2001:db8:");
}

export function isPrivateAddress(address) {
  const value = String(address || "").trim().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) return isBlockedIpv4(value);
  if (isIP(value) === 6) return isBlockedIpv6(value);
  return true;
}

export function isTrustedProxyAddress(address, trusted = []) {
  const value = String(address || "").replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
  return trusted.some((entry) => String(entry).replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "") === value);
}

function rejectedTarget(message, code = "PRIVATE_ADDRESS") {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function resolveSafeTarget(host, allowPrivateNetworks = false, resolver = lookup) {
  const value = String(host || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!value) throw rejectedTarget("Der Hostname fehlt.", "DNS_ERROR");
  if (isIP(value)) {
    if (isPrivateAddress(value) && !allowPrivateNetworks) throw rejectedTarget("Private, lokale oder reservierte Netzwerkadressen sind nicht freigegeben.");
    return value;
  }
  let addresses;
  try {
    addresses = await resolver(value, { all: true, verbatim: true });
  } catch {
    throw rejectedTarget("Der Hostname konnte nicht aufgelöst werden.", "DNS_ERROR");
  }
  if (!addresses.length) throw rejectedTarget("Der Hostname konnte nicht aufgelöst werden.", "DNS_ERROR");
  if (!allowPrivateNetworks && addresses.some((item) => isPrivateAddress(item.address))) {
    throw rejectedTarget("Der Hostname zeigt auf eine nicht freigegebene Adresse.");
  }
  // The caller must use this literal address for the immediately following
  // connection. It deliberately must not hand the hostname to a socket again.
  return addresses[0].address;
}
