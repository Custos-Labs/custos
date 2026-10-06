import { describe, expect, it } from "vitest";

import { SigningKeyProvider } from "./signing-key-provider.js";

describe("SigningKeyProvider", () => {
  it("returns the secret it was constructed with", () => {
    const provider = new SigningKeyProvider({ secret: "a-very-secret-value" });

    expect(provider.currentSecret()).toBe("a-very-secret-value");
  });

  it("recognizes its own current secret as known", () => {
    const provider = new SigningKeyProvider({ secret: "a-very-secret-value" });

    expect(provider.isKnownSecret("a-very-secret-value")).toBe(true);
  });

  it("rejects a secret it was not constructed with", () => {
    const provider = new SigningKeyProvider({ secret: "a-very-secret-value" });

    expect(provider.isKnownSecret("some-other-value")).toBe(false);
  });

  it("rejects an empty secret at construction", () => {
    expect(() => new SigningKeyProvider({ secret: "" })).toThrow(/non-empty secret/);
  });

  it("rejects a whitespace-only secret at construction", () => {
    expect(() => new SigningKeyProvider({ secret: "   " })).toThrow(/non-empty secret/);
  });
});
