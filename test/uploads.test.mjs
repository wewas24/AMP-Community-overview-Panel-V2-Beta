import test from "node:test";
import assert from "node:assert/strict";
import { isUploadFilename, parseUploadedImage } from "../src/uploads.mjs";

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngDataUrl = `data:image/png;base64,${pngHeader.toString("base64")}`;

test("prüft MIME-Typ, Binärsignatur und Größenlimit von Uploads", () => {
  const image = parseUploadedImage(pngDataUrl, 32);
  assert.equal(image.extension, "png");
  assert.throws(() => parseUploadedImage(`data:image/jpeg;base64,${pngHeader.toString("base64")}`, 32), /ungültig/);
  assert.throws(() => parseUploadedImage("data:image/png;base64,PHNjcmlwdD4=", 32), /ungültig/);
  assert.throws(() => parseUploadedImage(`data:image/png;base64,${Buffer.alloc(64, 1).toString("base64")}`, 8), /zu groß/);
});

test("blockiert Path-Traversal und nicht erlaubte Dateiendungen bei Medienabrufen", () => {
  assert.equal(isUploadFilename("banner-123.webp"), true);
  for (const name of ["../secret.png", "banner.png/../secret", "banner.svg", "C:\\secret.png", ".png"]) assert.equal(isUploadFilename(name), false, name);
});
