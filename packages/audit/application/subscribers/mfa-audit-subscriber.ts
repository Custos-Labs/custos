import type { DomainEvent } from "@verixa/shared-kernel";

import type { RecordAuditEventCommand } from "../use-cases/record-audit-event.js";

import { AuditEventSubscriber } from "./audit-event-subscriber.js";

/**
 * Shape of the `mfa.webauthn.clone_suspected` event published by
 * `@verixa/mfa`'s `VerifyWebAuthnAssertion` when an assertion presents a
 * non-increasing signature counter.
 */
export interface WebAuthnCloneSuspectedEvent extends DomainEvent {
  readonly eventName: "mfa.webauthn.clone_suspected";
  readonly credentialId: string;
  readonly userId: string;
  readonly previousCounter: number;
  readonly presentedCounter: number;
}

/**
 * Records a suspected authenticator clone as an audit entry. This is the
 * strongest duplication signal the system produces — it belongs in the
 * tamper-evident log, not just a log line.
 */
export class WebAuthnCloneSuspectedAuditSubscriber extends AuditEventSubscriber<WebAuthnCloneSuspectedEvent> {
  protected mapToAuditCommand(event: WebAuthnCloneSuspectedEvent): RecordAuditEventCommand {
    return {
      action: "mfa.webauthn.clone_suspected",
      actorId: event.userId,
      subjectId: event.userId,
      metadata: {
        credentialId: event.credentialId,
        previousCounter: String(event.previousCounter),
        presentedCounter: String(event.presentedCounter),
      },
    };
  }
}
