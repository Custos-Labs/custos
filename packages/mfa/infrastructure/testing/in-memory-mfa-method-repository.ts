import type { MfaMethodRepository } from "../../application/ports/mfa-method-repository.js";
import type { MfaMethod, MfaMethodId, UserId } from "../../domain/entities/mfa-method.js";

/**
 * A `Map`-backed `MfaMethodRepository` for unit tests.
 *
 * The methods return `Promise.resolve(...)` rather than being declared `async`
 * because none of them awaits anything — the port is asynchronous for the sake
 * of the real database adapter, not because this implementation is. Saying so
 * explicitly keeps the lint rule meaningful elsewhere, where a missing `await`
 * is a genuine bug.
 */
export class InMemoryMfaMethodRepository implements MfaMethodRepository {
  private readonly methods = new Map<MfaMethodId, MfaMethod>();

  save(method: MfaMethod): Promise<void> {
    this.methods.set(method.id, method);
    return Promise.resolve();
  }

  findById(id: MfaMethodId): Promise<MfaMethod | undefined> {
    return Promise.resolve(this.methods.get(id));
  }

  findActiveByUserId(userId: UserId): Promise<MfaMethod[]> {
    return Promise.resolve(this.byUser(userId).filter((m) => m.status === "active"));
  }

  findPendingByUserId(userId: UserId): Promise<MfaMethod[]> {
    return Promise.resolve(this.byUser(userId).filter((m) => m.status === "pending"));
  }

  findAllByUserId(userId: UserId): Promise<MfaMethod[]> {
    return Promise.resolve(this.byUser(userId));
  }

  delete(id: MfaMethodId): Promise<void> {
    this.methods.delete(id);
    return Promise.resolve();
  }

  /** Test helper: every stored method, regardless of user or status. */
  findAll(): Promise<MfaMethod[]> {
    return Promise.resolve(Array.from(this.methods.values()));
  }

  private byUser(userId: UserId): MfaMethod[] {
    return Array.from(this.methods.values()).filter((m) => m.userId === userId);
  }
}
