import type { PrismaClient } from "@verixa/database";
import { PrismaUserRepository } from "@verixa/identity";

import type {
  CredentialsRepositories,
  CredentialsUnitOfWork,
} from "../../application/ports/credentials-unit-of-work.js";

import { mapUnitOfWorkError } from "./credentials-error-mapper.js";
import { PrismaCredentialRepository } from "./prisma-credential-repository.js";
import {
  PrismaEmailVerificationTokenRepository,
  PrismaPasswordResetTokenRepository,
} from "./prisma-verification-token-repositories.js";

/**
 * `CredentialsUnitOfWork` over Prisma's interactive transactions.
 *
 * Constructs an identity repository alongside a credentials one on the *same*
 * transaction client — possible only because every repository in this
 * codebase takes its client as a constructor argument rather than creating
 * one. That single convention is what lets two bounded contexts share a
 * transaction without either knowing about the other.
 */
export class PrismaCredentialsUnitOfWork implements CredentialsUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(work: (repositories: CredentialsRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction((tx) => {
        const client = tx as unknown as PrismaClient;

        const repositories: CredentialsRepositories = {
          users: new PrismaUserRepository(client),
          credentials: new PrismaCredentialRepository(client),
          emailVerificationTokens: new PrismaEmailVerificationTokenRepository(
            client.emailVerificationToken,
          ),
          passwordResetTokens: new PrismaPasswordResetTokenRepository(client.passwordResetToken),
        };

        return work(repositories);
      });
    } catch (error) {
      mapUnitOfWorkError(error);
    }
  }
}
