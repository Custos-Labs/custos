import { mfaMethodRepositoryContract } from "./contracts/mfa-method-repository.contract.js";
import { InMemoryMfaMethodRepository } from "./in-memory-mfa-method-repository.js";

// The same contract the Prisma adapter is held to, so the fake used throughout
// the use-case tests cannot quietly diverge from the real repository.
mfaMethodRepositoryContract(() => new InMemoryMfaMethodRepository());
