import { secureEqual } from "./security.mjs";

// Kept independent from Node's request object so the exact browser-facing
// Origin and CSRF rules can be tested without a running dashboard.
export function sameOriginValues(origin, protocol, host) {
  const expected = `${String(protocol || "")}://${String(host || "")}`;
  return Boolean(origin && protocol && host && secureEqual(origin, expected));
}

export function validMutationRequest({ origin, protocol, host, csrfToken, expectedCsrfToken }) {
  return sameOriginValues(origin, protocol, host) && secureEqual(csrfToken, expectedCsrfToken);
}
