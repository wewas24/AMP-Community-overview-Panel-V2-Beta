import test from "node:test";
import assert from "node:assert/strict";
import { sameOriginValues, validMutationRequest } from "../src/request-guards.mjs";

test("akzeptiert Mutationen nur mit passendem Origin und CSRF-Token", () => {
  const request = { origin: "https://amp.example.com", protocol: "https", host: "amp.example.com", csrfToken: "csrf-secret", expectedCsrfToken: "csrf-secret" };
  assert.equal(sameOriginValues(request.origin, request.protocol, request.host), true);
  assert.equal(validMutationRequest(request), true);
  assert.equal(validMutationRequest({ ...request, origin: "https://fremd.example" }), false);
  assert.equal(validMutationRequest({ ...request, csrfToken: "falsch" }), false);
  assert.equal(validMutationRequest({ ...request, origin: "" }), false);
});
