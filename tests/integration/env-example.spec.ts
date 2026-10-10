import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe(".env.example hygiene", () => {
  it("declares each environment variable key at most once", () => {
    let dir = __dirname;
    let envPath = resolve(dir, ".env.example");
    while (!existsSync(envPath) && dir !== resolve(dir, "..")) {
      dir = resolve(dir, "..");
      envPath = resolve(dir, ".env.example");
    }

    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf8");

    const keys: string[] = [];
    const duplicates: string[] = [];

    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
      if (match && match[1]) {
        const key = match[1];
        if (keys.includes(key)) {
          duplicates.push(key);
        } else {
          keys.push(key);
        }
      }
    }

    expect(duplicates).toEqual([]);
    expect(keys.length).toBeGreaterThan(0);
  });
});
