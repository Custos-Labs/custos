import { PrismaClientKnownRequestError } from "@verixa/database";
import { ConflictError } from "@verixa/shared-kernel";

/** Unique constraint violation. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Anti-corruption layer at the credentials persistence boundary — mirrors
 * `packages/identity/infrastructure/persistence/error-mapper.ts`. Prisma's
 * vocabulary stops here; above this line there are only domain errors.
 *
 * Only unique violations are translated: they are the one failure a caller
 * can act on (a concurrent registration lost the race). Anything else is
 * rethrown untouched — there is no sensible `err` branch for "the database
 * is unreachable", and flattening it would discard what the operator needs.
 */
export function mapUnitOfWorkError(error: unknown): never {
  if (error instanceof PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
    throw new ConflictError("A unique constraint was violated.");
  }
  throw error;
}
