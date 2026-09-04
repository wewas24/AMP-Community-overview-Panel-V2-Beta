import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { isIP } from "node:net";

const timeoutMs = 12_000;

function configured(smtp) {
  return Boolean(smtp?.host && smtp?.port && smtp?.username && smtp?.password && smtp?.from && smtp?.to);
}

function waitForReply(socket, expected) {
  const accepted = new Set(Array.isArray(expected) ? expected : [expected]);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines = [];
    const timer = setTimeout(() => finish(new Error("Der SMTP-Server antwortet nicht rechtzeitig.")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off("data", data); socket.off("error", error); socket.off("close", close); };
    const finish = (failure, value) => { cleanup(); failure ? reject(failure) : resolve(value); };
    const error = (reason) => finish(reason);
    const close = () => finish(new Error("Die SMTP-Verbindung wurde geschlossen."));
    const data = (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        lines.push(line);
        if (!match || match[2] === "-") continue;
        const code = Number(match[1]);
        if (!accepted.has(code)) return finish(new Error(`SMTP-Server antwortet mit ${code}: ${match[3] || "Unbekannte Antwort"}`));
        return finish(null, { line, text: lines.join("\n") });
      }
    };
    socket.on("data", data); socket.once("error", error); socket.once("close", close);
  });
}

async function command(socket, value, expected) {
  const reply = waitForReply(socket, expected);
  socket.write(`${value}\r\n`);
  return reply;
}

function plainSocket(smtp) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: smtp.host, port: smtp.port });
    const timer = setTimeout(() => finish(new Error("Die Verbindung zum SMTP-Server dauert zu lange.")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off("connect", ready); socket.off("error", failure); };
    const finish = (error, value) => { cleanup(); if (error) { socket.destroy(); reject(error); } else resolve(value); };
    const ready = () => finish(null, socket);
    const failure = (error) => finish(error);
    socket.once("connect", ready); socket.once("error", failure);
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const options = { socket, minVersion: "TLSv1.2", rejectUnauthorized: true };
    if (!isIP(host)) options.servername = host;
    const secure = connectTls(options);
    const timer = setTimeout(() => finish(new Error("Der STARTTLS-Aufbau dauert zu lange.")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); secure.off("secureConnect", ready); secure.off("error", failure); };
    const finish = (error, value) => { cleanup(); if (error) { secure.destroy(); reject(error); } else resolve(value); };
    const ready = () => finish(null, secure);
    const failure = (error) => finish(error);
    secure.once("secureConnect", ready); secure.once("error", failure);
  });
}

export async function sendEmail(smtp, subject, text) {
  if (!configured(smtp)) throw new Error("Bitte SMTP-Server, Zugangsdaten, Absender und Empfänger vollständig eintragen.");
  if (Number(smtp.port) === 465) throw new Error("Port 465 verwendet direktes TLS. Für STARTTLS bitte den Server-Port verwenden, meist 587.");
  let socket;
  try {
    socket = await plainSocket(smtp);
    await waitForReply(socket, 220);
    const firstGreeting = await command(socket, "EHLO amp-community-dashboard", 250);
    if (!/STARTTLS/i.test(firstGreeting.text)) throw new Error("Der SMTP-Server bietet kein STARTTLS an.");
    await command(socket, "STARTTLS", 220);
    socket = await upgrade(socket, smtp.host);
    const greeting = await command(socket, "EHLO amp-community-dashboard", 250);
    const plain = Buffer.from(`\u0000${smtp.username}\u0000${smtp.password}`, "utf8").toString("base64");
    if (/AUTH.*PLAIN/i.test(greeting.text)) await command(socket, `AUTH PLAIN ${plain}`, 235);
    else if (/AUTH.*LOGIN/i.test(greeting.text)) {
      await command(socket, "AUTH LOGIN", 334);
      await command(socket, Buffer.from(smtp.username, "utf8").toString("base64"), 334);
      await command(socket, Buffer.from(smtp.password, "utf8").toString("base64"), 235);
    } else throw new Error("Der SMTP-Server unterstützt keine Anmeldung mit PLAIN oder LOGIN.");
    await command(socket, `MAIL FROM:<${smtp.from}>`, 250);
    await command(socket, `RCPT TO:<${smtp.to}>`, [250, 251]);
    await command(socket, "DATA", 354);
    const safeSubject = Buffer.from(String(subject).replace(/[\r\n]/g, " ").slice(0, 160), "utf8").toString("base64");
    const body = String(text).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const delivered = waitForReply(socket, 250);
    socket.write(`From: <${smtp.from}>\r\nTo: <${smtp.to}>\r\nSubject: =?UTF-8?B?${safeSubject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`);
    await delivered;
    await command(socket, "QUIT", 221).catch(() => undefined);
  } finally { if (socket && !socket.destroyed) socket.destroy(); }
}
