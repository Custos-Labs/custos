import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  assertStreamWithinLimit,
  EvidenceTooLargeError,
  MAX_EVIDENCE_BYTES,
} from "./verification.js";

describe("verification evidence size limit (Issue #58)", () => {
  it("rejects an oversized upload without reading the entire body", async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, "a"); // 1 MiB
    let chunksRead = 0;
    async function* body() {
      for (let i = 0; i < 100; i++) {
        // 100 MiB offered
        chunksRead++;
        yield await Promise.resolve(CHUNK);
      }
    }
    const stream = Readable.from(body());

    await expect(assertStreamWithinLimit(stream, 10 * 1024 * 1024)).rejects.toBeInstanceOf(
      EvidenceTooLargeError,
    );

    // 11 chunks cross the 10 MiB line; the remaining 89 are never read.
    expect(chunksRead).toBe(11);
  });

  it("allows a stream within the limit to complete", async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, "a"); // 1 MiB
    let chunksRead = 0;
    async function* body() {
      for (let i = 0; i < 5; i++) {
        // 5 MiB offered
        chunksRead++;
        yield await Promise.resolve(CHUNK);
      }
    }
    const stream = Readable.from(body());

    await expect(assertStreamWithinLimit(stream, MAX_EVIDENCE_BYTES)).resolves.toBeUndefined();
    expect(chunksRead).toBe(5);
  });
});
