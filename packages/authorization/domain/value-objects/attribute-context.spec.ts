import { describe, expect, it } from "vitest";

import { readAttribute } from "./attribute-context.js";

describe("readAttribute", () => {
  it("reads a flat, literal dotted key", () => {
    expect(readAttribute({ "subject.role": "admin" }, "subject.role")).toBe("admin");
  });

  it("falls back to nested traversal when no literal key matches", () => {
    expect(readAttribute({ subject: { role: "admin" } }, "subject.role")).toBe("admin");
  });

  it("returns undefined for a missing top-level segment", () => {
    expect(readAttribute({}, "subject.role")).toBeUndefined();
  });

  it("returns undefined for a missing nested segment", () => {
    expect(readAttribute({ subject: { id: "u1" } }, "subject.role")).toBeUndefined();
  });

  it("returns undefined when traversal hits a non-object value", () => {
    expect(readAttribute({ subject: "not-an-object" }, "subject.role")).toBeUndefined();
  });

  it("returns undefined when traversal hits null", () => {
    expect(readAttribute({ subject: null }, "subject.role")).toBeUndefined();
  });

  it("reads a single-segment path", () => {
    expect(readAttribute({ role: "admin" }, "role")).toBe("admin");
  });
});
