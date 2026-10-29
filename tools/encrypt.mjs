// Encrypts the private trip info so it can live in a public repo.
// Usage: node tools/encrypt.mjs <trip.json> <passcode>  → writes trip.enc.json
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [, , src, passcode] = process.argv;
if (!src || !passcode) {
  console.error("Usage: node tools/encrypt.mjs <trip.json> <passcode>");
  process.exit(1);
}

const ITERATIONS = 310000;
const b64 = (buf) => Buffer.from(buf).toString("base64");

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  base,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"]
);
const plain = JSON.stringify(JSON.parse(readFileSync(src, "utf8")));
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));

writeFileSync(
  new URL("../trip.enc.json", import.meta.url),
  JSON.stringify({ v: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) }, null, 2) + "\n"
);
console.log("Wrote trip.enc.json");
