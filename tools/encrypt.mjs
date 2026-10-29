// Encrypts the private trip info so it can live in a public repo.
// Usage: node tools/encrypt.mjs <trip.json> <passcode> [--new-salt]  → writes trip.enc.json
// The existing salt is reused by default so the shared list (encrypted with the
// same derived key) stays readable. Pass --new-salt when changing the passcode.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [, , src, passcode, flag] = process.argv;
const OUT = new URL("../trip.enc.json", import.meta.url);
if (!src || !passcode) {
  console.error("Usage: node tools/encrypt.mjs <trip.json> <passcode> [--new-salt]");
  process.exit(1);
}

const b64 = (buf) => Buffer.from(buf).toString("base64");

const prev = flag !== "--new-salt" && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const ITERATIONS = prev ? prev.iterations : 310000;
const salt = prev ? Buffer.from(prev.salt, "base64") : crypto.getRandomValues(new Uint8Array(16));
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
  OUT,
  JSON.stringify({ v: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) }, null, 2) + "\n"
);
console.log("Wrote trip.enc.json");
