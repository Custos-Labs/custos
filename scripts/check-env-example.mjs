#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.example");
const content = readFileSync(envPath, "utf8");

const keys = [];
const duplicates = [];
for (const line of content.split("\n")) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (match) {
    const key = match[1];
    if (keys.includes(key)) {
      duplicates.push(key);
    } else {
      keys.push(key);
    }
  }
}

if (duplicates.length > 0) {
  console.error(`Duplicate keys found in .env.example: ${duplicates.join(", ")}`);
  process.exit(1);
} else {
  console.log(`No duplicate keys in .env.example (${keys.length} keys checked).`);
}
