import { Result, ValidationError } from "@verixa/shared-kernel";

export type MfaMethodTypeValue = "totp" | "webauthn" | "backup-codes";

const VALID_TYPES = new Set<string>(["totp", "webauthn", "backup-codes"]);

export class MfaMethodType {
  readonly value: MfaMethodTypeValue;

  private constructor(value: MfaMethodTypeValue) {
    this.value = value;
  }

  static create(raw: string): Result<MfaMethodType, ValidationError> {
    if (!VALID_TYPES.has(raw)) {
      return Result.err(
        new ValidationError(`Invalid MFA method type: ${raw}.`, { type: ["invalid_type"] }),
      );
    }
    return Result.ok(new MfaMethodType(raw as MfaMethodTypeValue));
  }

  equals(other: MfaMethodType): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
export type MfaMethodType = "totp" | "webauthn" | "backup-codes";
