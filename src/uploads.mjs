const allowedExtensions = /^(?:[a-z0-9-]+\.(?:png|jpe?g|webp))$/i;

export function isUploadFilename(value) {
  return allowedExtensions.test(String(value || ""));
}

export function parseUploadedImage(input, maximumBytes) {
  const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=\s]+)$/i.exec(String(input || ""));
  if (!match) throw new Error("Bitte eine PNG-, JPEG- oder WebP-Bilddatei wählen.");
  const content = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!content.length || content.length > maximumBytes) throw new Error("Das Bild ist leer oder zu groß.");
  const type = match[1].toLowerCase();
  const valid = type === "png" ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : type === "jpeg" ? content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff : content.subarray(0, 4).toString() === "RIFF" && content.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error("Die Bilddatei ist ungültig.");
  return { content, extension: type === "jpeg" ? "jpg" : type };
}
