import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const projectDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const origin = "https://amp.example.test";

function processResult(child) {
  return new Promise((resolveResult, reject) => {
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveResult({ output, errors }) : reject(new Error(`Testprozess beendet: ${code}\n${errors}`)));
  });
}

async function seedAccounts(dataDirectory) {
  const storageUrl = pathToFileURL(join(projectDirectory, "src", "storage.mjs")).href;
  const securityUrl = pathToFileURL(join(projectDirectory, "src", "security.mjs")).href;
  const script = `
    const { openStore } = await import(${JSON.stringify(storageUrl)});
    const { passwordRecord } = await import(${JSON.stringify(securityUrl)});
    const store = await openStore();
    const createdAt = new Date().toISOString();
    store.addAdmin({ username: "owner", ...(await passwordRecord("ein-sicheres-owner-passwort")), role: "owner", createdAt });
    store.addAdmin({ username: "auditor", ...(await passwordRecord("ein-sicheres-auditor-passwort")), role: "auditor", createdAt });
    store.db.close();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: projectDirectory, env: { ...process.env, DATA_DIRECTORY: dataDirectory } });
  await processResult(child);
}

async function startDashboard(dataDirectory) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: { ...process.env, DATA_DIRECTORY: dataDirectory, PORT: "0", COOKIE_SECURE: "false", ALLOW_PRIVATE_NETWORKS: "false" }
  });
  return new Promise((resolveStart, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => finish(new Error(`Testserver startet nicht rechtzeitig.\n${errors}`)), 12_000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receiveError);
      child.off("error", failure);
      child.off("exit", exited);
      error ? reject(error) : resolveStart(value);
    };
    const receive = (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) finish(null, { child, port: Number(match[1]) });
    };
    const receiveError = (chunk) => { errors += chunk; };
    const failure = (error) => finish(error);
    const exited = (code) => finish(new Error(`Testserver beendet: ${code}\n${errors}`));
    child.stdout.on("data", receive);
    child.stderr.on("data", receiveError);
    child.once("error", failure);
    child.once("exit", exited);
  });
}

async function stopDashboard(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

function forwardedHeaders(ip = "198.51.100.25") {
  return { host: "amp.example.test", origin, "x-forwarded-host": "amp.example.test", "x-forwarded-proto": "https", "x-forwarded-for": ip };
}

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveCall, reject) => {
    const content = body === undefined ? null : JSON.stringify(body);
    const requestHeaders = { ...headers };
    if (content !== null) { requestHeaders["content-type"] = "application/json"; requestHeaders["content-length"] = Buffer.byteLength(content); }
    const pending = request({ hostname: "127.0.0.1", port, path, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        const raw = Buffer.concat(chunks);
        const text = (response.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
        resolveCall({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    pending.once("error", reject);
    pending.end(content || undefined);
  });
}

async function login(port, username, password, ip) {
  const response = await call(port, "/api/v1/login", { method: "POST", headers: forwardedHeaders(ip), body: { username, password } });
  const cookie = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0]?.split(";", 1)[0] : "";
  return { ...response, cookie };
}

test("schützt einen laufenden Server gegen Brute Force, Session-Fixation, CSRF, RBAC und Upload-Angriffe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amp-dashboard-http-security-"));
  let child;
  try {
    const dataDirectory = join(directory, "data");
    await seedAccounts(dataDirectory);
    const started = await startDashboard(dataDirectory);
    child = started.child;
    const { port } = started;

    const unauthenticated = await call(port, "/api/v1/admin/dashboard", { headers: forwardedHeaders() });
    assert.equal(unauthenticated.status, 401);

    const parallelFailures = await Promise.all(Array.from({ length: 10 }, () => login(port, "missing-user", "falsches-passwort", "198.51.100.77")));
    assert.ok(parallelFailures.every((response) => [401, 429].includes(response.status)));
    assert.equal((await login(port, "missing-user", "falsches-passwort", "198.51.100.77")).status, 429);

    const firstLogin = await login(port, "owner", "ein-sicheres-owner-passwort", "198.51.100.88");
    assert.equal(firstLogin.status, 200);
    assert.match(firstLogin.cookie, /^amp_dashboard_v2_session=/);
    const secondLogin = await login(port, "owner", "ein-sicheres-owner-passwort", "198.51.100.88");
    assert.equal(secondLogin.status, 200);
    assert.notEqual(firstLogin.cookie, secondLogin.cookie);
    assert.equal((await call(port, "/api/v1/session", { headers: { ...forwardedHeaders(), cookie: firstLogin.cookie } })).json.authenticated, false);
    assert.equal((await call(port, "/api/v1/session", { headers: { ...forwardedHeaders(), cookie: secondLogin.cookie } })).json.authenticated, true);

    const missingCsrf = await call(port, "/api/v1/admin/servers", { method: "POST", headers: { ...forwardedHeaders(), cookie: secondLogin.cookie }, body: {} });
    assert.equal(missingCsrf.status, 403);
    const foreignOrigin = await call(port, "/api/v1/admin/servers", { method: "POST", headers: { ...forwardedHeaders(), origin: "https://evil.example", cookie: secondLogin.cookie, "x-csrf-token": secondLogin.json.csrfToken }, body: {} });
    assert.equal(foreignOrigin.status, 403);

    const created = await call(port, "/api/v1/admin/servers", { method: "POST", headers: { ...forwardedHeaders(), cookie: secondLogin.cookie, "x-csrf-token": secondLogin.json.csrfToken }, body: { name: "Öffentlicher Testserver", communityUrl: "https://amp.example.com/c/test", connection: { host: "8.8.8.8", port: 27015, profile: "steam" } } });
    assert.equal(created.status, 201);
    const publicServers = await call(port, "/api/v1/public/servers", { headers: forwardedHeaders() });
    assert.equal(publicServers.status, 200);
    assert.equal("connection" in publicServers.json.servers[0], false);
    assert.equal("monitoringTarget" in publicServers.json.servers[0], false);
    const compressedPublicServers = await call(port, "/api/v1/public/servers", { headers: { ...forwardedHeaders(), "accept-encoding": "gzip" } });
    assert.equal(compressedPublicServers.headers["content-encoding"], "gzip");
    assert.match(String(compressedPublicServers.headers.vary), /accept-encoding/i);
    assert.equal(compressedPublicServers.json.servers[0].name, "Öffentlicher Testserver");

    const auditor = await login(port, "auditor", "ein-sicheres-auditor-passwort", "198.51.100.99");
    assert.equal(auditor.status, 200);
    const forbiddenRead = await call(port, "/api/v1/admin/servers", { headers: { ...forwardedHeaders(), cookie: auditor.cookie } });
    assert.equal(forbiddenRead.status, 403);
    const forbiddenWrite = await call(port, "/api/v1/admin/servers", { method: "POST", headers: { ...forwardedHeaders(), cookie: auditor.cookie, "x-csrf-token": auditor.json.csrfToken }, body: {} });
    assert.equal(forbiddenWrite.status, 403);

    const invalidUpload = await call(port, "/api/v1/admin/uploads", { method: "POST", headers: { ...forwardedHeaders(), cookie: secondLogin.cookie, "x-csrf-token": secondLogin.json.csrfToken }, body: { dataUrl: "data:image/png;base64,PHNjcmlwdD4=" } });
    assert.equal(invalidUpload.status, 400);
    assert.equal((await call(port, "/media/..%2Fdashboard-v2.sqlite", { headers: forwardedHeaders() })).status, 404);
  } finally {
    if (child) await stopDashboard(child);
    await rm(directory, { recursive: true, force: true });
  }
});
