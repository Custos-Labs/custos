import { Result, ValidationError } from "@verixa/shared-kernel";

import type {
  AccessTokenPayload,
  TokenSigner,
} from "../../application/ports/token-signer.js";

/**
 * A `TokenSigner` that issues opaque `test.<payload-json-base64>` tokens and
 * verifies them by decoding, instead of real JWTs. Exists so use cases never
 * need a signing key in unit tests — only that `verify` round-trips what
 * `sign` produced and rejects anything else.
 */
export class InMemoryTokenSigner implements TokenSigner {
  private readonly issued = new Map<string, AccessTokenPayload>();

  async sign(payload: AccessTokenPayload, _ttlSeconds: number): Promise<string> {
    const token = `test.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
    this.issued.set(token, payload);
    return token;
  }

  async verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>> {
    const payload = this.issued.get(token);
    if (payload === undefined) {
      return Result.err(new ValidationError("Invalid token.", { token: ["invalid"] }));
    }
    return Result.ok(payload);
  }
}
