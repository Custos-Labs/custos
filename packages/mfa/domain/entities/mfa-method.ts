import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

import type { MfaMethodType } from "../value-objects/mfa-method-type.js";

export type MfaMethodId = Id<"MfaMethodId">;
export type UserId = Id<"UserId">;
export type MfaMethodStatus = "pending" | "active" | "disabled";

interface MfaMethodProps {
  readonly id: MfaMethodId;
  readonly userId: UserId;
  readonly type: MfaMethodType;
  readonly status: MfaMethodStatus;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date | undefined;
}

export class MfaMethod {
  readonly id: MfaMethodId;
  readonly userId: UserId;
  readonly type: MfaMethodType;
  readonly status: MfaMethodStatus;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | undefined;

  private constructor(props: MfaMethodProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.type = props.type;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.lastUsedAt = props.lastUsedAt;
  }

  static enroll(params: { userId: UserId; type: MfaMethodType }): MfaMethod {
    return new MfaMethod({
      id: createId<"MfaMethodId">(),
      userId: params.userId,
      type: params.type,
      status: "pending",
      createdAt: new Date(),
    });
  }

  static reconstitute(props: MfaMethodProps): MfaMethod {
    return new MfaMethod(props);
  }

  activate(): Result<MfaMethod, ValidationError> {
    if (this.status === "active") {
      return Result.err(
        new ValidationError(`Method is already active.`, { status: ["invalid_state"] }),
      );
    }
    return Result.ok(
      new MfaMethod({
        ...this,
        status: "active",
      }),
    );
  }

  disable(): Result<MfaMethod, ValidationError> {
    if (this.status === "disabled") {
      return Result.err(
        new ValidationError(`Method is already disabled.`, { status: ["invalid_state"] }),
      );
    }
    return Result.ok(
      new MfaMethod({
        ...this,
        status: "disabled",
      }),
    );
  }

  recordUse(): Result<MfaMethod, ValidationError> {
    if (this.status === "pending") {
      return Result.err(
        new ValidationError(`A pending MFA method cannot satisfy a challenge.`, {
          status: ["pending_cannot_challenge"],
        }),
      );
    }
    if (this.status === "disabled") {
      return Result.err(
        new ValidationError(`A disabled MFA method cannot satisfy a challenge.`, {
          status: ["disabled_cannot_challenge"],
        }),
      );
    }
    return Result.ok(
      new MfaMethod({
        ...this,
        lastUsedAt: new Date(),
      }),
    );
  }
}
import { createId, type Id } from "@verixa/shared-kernel";
import type { MfaMethodType } from "../value-objects/mfa-method-type.js";
import type { TotpSecret } from "../value-objects/totp-secret.js";

export type MfaMethodId = Id<"MfaMethodId">;
export type MfaMethodStatus = "pending" | "active" | "disabled";

export class MfaMethod {
  private constructor(
    public readonly id: MfaMethodId,
    public readonly userId: Id<"UserId">,
    public readonly type: MfaMethodType,
    public readonly status: MfaMethodStatus,
    public readonly secret: TotpSecret | null,
    public readonly createdAt: Date,
    public readonly lastUsedAt?: Date,
    public readonly failedAttempts: number = 0,
    public readonly lockedUntil?: Date,
    public readonly lastUsedStep?: number,
  ) {}

  static createPendingTotp(
    userId: Id<"UserId">,
    secret: Top secret,
    now: Date = new Date()
  ): MfaMethod {
    return new MfaMethod(
      createId<"MfaMethodId">(),
      userId,
      "totp",
      "pending",
      secret,
      now
    );
  }

  activate(now: Date = new Date()): MfaMethod {
    if (this.status !== "pending") {
      throw new Error("Only pending methods can be activated");
    }
    return new MfaMethod(
      this.id,
      this.userId,
      this.type,
      "active",
      this.secret,
      this.createdAt,
      this.lastUsedAt,
      0, // Reset attempts on success
      undefined,
      this.lastUsedStep
    );
  }

  isLockedAt(now: Date): boolean {
    if (!this.lockedUntil) return false;
    return now < this.lockedUntil;
  }

  recordFailedAttempt(now: Date = new Date()): MfaMethod {
    const attempts = this.failedAttempts + 1;
    // Rate limit configuration could be injected, hardcoded for now
    const lockDurationMs = attempts >= 5 ? 60 * 1000 * Math.pow(2, attempts - 5) : 0;
    
    let lockedUntil: Date | undefined = undefined;
    if (lockDurationMs > 0) {
      lockedUntil = new Date(now.getTime() + Math.min(lockDurationMs, 60 * 60 * 1000));
    }

    return new MfaMethod(
      this.id,
      this.userId,
      this.type,
      this.status,
      this.secret,
      this.createdAt,
      this.lastUsedAt,
      attempts,
      lockedUntil,
      this.lastUsedStep
    );
  }

  recordUse(matchedStep: number, now: Date = new Date()): MfaMethod {
    if (this.status !== "active") {
      throw new Error("Only active methods can be used for verification");
    }
    if (this.lastUsedStep !== undefined && matchedStep <= this.lastUsedStep) {
      throw new Error("Replay detected: step has already been consumed");
    }
    return new MfaMethod(
      this.id,
      this.userId,
      this.type,
      this.status,
      this.secret,
      this.createdAt,
      now, // update lastUsedAt
      0,   // reset failedAttempts
      undefined, // clear lock
      matchedStep
    );
  }
}

export type MfaMethodId = Id<"MfaMethodId">;
export type UserId = Id<"UserId">;

export type MfaMethodType = "totp" | "webauthn" | "backup_codes";
export type MfaMethodStatus = "pending" | "active" | "disabled";

export interface MfaMethodProps {
  id: MfaMethodId;
  userId: UserId;
  type: MfaMethodType;
  status: MfaMethodStatus;
  secret: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class MfaMethod {
  private constructor(private readonly props: MfaMethodProps) {}

  public get id(): MfaMethodId { return this.props.id; }
  public get userId(): UserId { return this.props.userId; }
  public get type(): MfaMethodType { return this.props.type; }
  public get status(): MfaMethodStatus { return this.props.status; }
  public get secret(): string | null { return this.props.secret; }
  public get lastUsedAt(): Date | null { return this.props.lastUsedAt; }
  public get createdAt(): Date { return this.props.createdAt; }
  public get updatedAt(): Date { return this.props.updatedAt; }

  public updateSecret(secret: string): void {
    this.props.secret = secret;
    this.props.updatedAt = new Date();
  }

  public activate(): void {
    this.props.status = "active";
    this.props.updatedAt = new Date();
  }

  public static load(props: MfaMethodProps): MfaMethod {
    return new MfaMethod(props);
  }

  public static create(
    userId: UserId,
    type: MfaMethodType,
    secret: string | null = null
  ): MfaMethod {
    const now = new Date();
    return new MfaMethod({
      id: createId<"MfaMethodId">(),
      userId,
      type,
      status: "pending",
      secret,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

