import { ServiceError } from "./errors.js";
import type {
  PayNowFirstPaymentRecorder,
  PayNowFirstPaymentVerifier,
  PayNowPendingFirstPaymentQueue,
} from "./paynow.js";

export interface RetryPendingFirstPaymentsOptions {
  limit?: number;
  now?: number;
  visibilityTimeoutSeconds?: number;
  maxAttempts?: number;
}

export interface RetryPendingFirstPaymentsResult {
  claimed: number;
  processed: number;
  duplicate: number;
  retried: number;
  failed: number;
  skipped: number;
}

function retryErrorCode(error: unknown): string {
  if (error instanceof ServiceError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "paynow_pending_retry_failed";
}

function retryErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return undefined;
}

function isTemporaryVerificationFailure(error: unknown): boolean {
  return error instanceof ServiceError &&
    error.status >= 500 &&
    (error.code === "paynow_api_unreachable" ||
      error.code === "paynow_api_error" ||
      error.code === "paynow_api_response_invalid");
}

async function verifyPendingPayment(
  verifier: PayNowFirstPaymentVerifier,
  payment: Parameters<PayNowFirstPaymentVerifier["verifyFirstPayment"]>[0],
): Promise<
  | { kind: "first"; verified: NonNullable<Awaited<ReturnType<PayNowFirstPaymentVerifier["verifyFirstPayment"]>>> }
  | { kind: "renewal"; verified: NonNullable<Awaited<ReturnType<NonNullable<PayNowFirstPaymentVerifier["verifyRenewalPayment"]>>>> }
  | undefined
> {
  const firstPayment = await verifier.verifyFirstPayment(payment);
  if (firstPayment) return { kind: "first", verified: firstPayment };
  if (!verifier.verifyRenewalPayment) return undefined;
  const renewalPayment = await verifier.verifyRenewalPayment(payment);
  return renewalPayment ? { kind: "renewal", verified: renewalPayment } : undefined;
}

export async function retryPendingFirstPayments(
  queue: PayNowPendingFirstPaymentQueue & PayNowFirstPaymentRecorder,
  verifier: PayNowFirstPaymentVerifier,
  options: RetryPendingFirstPaymentsOptions = {},
): Promise<RetryPendingFirstPaymentsResult> {
  const now = Math.max(0, Math.floor(options.now ?? Date.now() / 1000));
  const maxAttempts = options.maxAttempts;
  const result: RetryPendingFirstPaymentsResult = {
    claimed: 0,
    processed: 0,
    duplicate: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };

  const claimOptions: RetryPendingFirstPaymentsOptions = { now };
  if (options.limit !== undefined) claimOptions.limit = options.limit;
  if (options.visibilityTimeoutSeconds !== undefined) {
    claimOptions.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds;
  }
  if (maxAttempts !== undefined) claimOptions.maxAttempts = maxAttempts;
  const tasks = await queue.claimPendingFirstPayments(claimOptions);
  result.claimed = tasks.length;

  for (const task of tasks) {
    try {
      const verified = await verifyPendingPayment(verifier, task.payment);
      if (!verified) {
        await queue.markPendingFirstPaymentProcessed({
          eventId: task.eventId,
          payloadSha256: task.payloadSha256,
          now,
        });
        result.skipped += 1;
        continue;
      }
      if (verified.kind === "renewal" && !queue.recordVerifiedRenewalPayment) {
        await queue.markPendingFirstPaymentProcessed({
          eventId: task.eventId,
          payloadSha256: task.payloadSha256,
          now,
        });
        result.skipped += 1;
        continue;
      }
      const recorded = verified.kind === "first"
        ? await queue.recordVerifiedFirstPayment({
            ...verified.verified,
            sourceEventId: task.eventId,
            sourceEventType: task.eventType,
            sourcePayloadSha256: task.payloadSha256,
            now,
          })
        : await queue.recordVerifiedRenewalPayment!({
            ...verified.verified,
            sourceEventId: task.eventId,
            sourceEventType: task.eventType,
            sourcePayloadSha256: task.payloadSha256,
            now,
          });
      await queue.markPendingFirstPaymentProcessed({
        eventId: task.eventId,
        payloadSha256: task.payloadSha256,
        now,
      });
      if (recorded.status === "duplicate") {
        result.duplicate += 1;
      } else {
        result.processed += 1;
      }
    } catch (error) {
      const errorMessage = retryErrorMessage(error);
      const failure: Parameters<PayNowPendingFirstPaymentQueue["markPendingFirstPaymentFailed"]>[0] = {
        eventId: task.eventId,
        payloadSha256: task.payloadSha256,
        errorCode: retryErrorCode(error),
        now,
      };
      if (errorMessage !== undefined) failure.errorMessage = errorMessage;
      if (isTemporaryVerificationFailure(error)) {
        if (maxAttempts !== undefined) failure.maxAttempts = maxAttempts;
      } else {
        failure.maxAttempts = 1;
      }
      const status = await queue.markPendingFirstPaymentFailed(failure);
      if (status === "failed") {
        result.failed += 1;
      } else {
        result.retried += 1;
      }
    }
  }

  return result;
}
