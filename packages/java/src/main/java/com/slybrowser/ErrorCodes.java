package com.slybrowser;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public final class ErrorCodes {
  public static final List<String> LICENSE_SERVICE = Collections.unmodifiableList(List.of(
      "admin_authorization_forbidden",
      "admin_authorization_invalid",
      "artifact_denied",
      "artifact_not_found",
      "artifact_path_invalid",
      "artifact_unavailable",
      "authorization_required",
      "billing_email_key_required",
      "billing_rate_limited",
      "checkout_idempotency_conflict",
      "checkout_idempotency_expired",
      "checkout_intent_unavailable",
      "checkout_status_unavailable",
      "customer_portal_not_configured",
      "customer_portal_unavailable",
      "download_ticket_expired",
      "email_delivery_status_not_configured",
      "email_delivery_status_unauthorized",
      "feedback_email_failed",
      "feedback_email_not_configured",
      "feedback_rate_limited",
      "idempotency_conflict",
      "internal_error",
      "invalid_json",
      "invalid_request",
      "kernel_update_required",
      "license_email_delivery_unavailable",
      "license_resend_unavailable",
      "license_rotation_unavailable",
      "license_feature_denied",
      "license_file_expired",
      "license_file_authorization_not_configured",
      "license_file_invalid",
      "license_file_kdf_unsupported",
      "license_file_key_unknown",
      "license_file_locked",
      "license_file_payload_invalid",
      "license_file_signature_invalid",
      "license_file_untrusted_origin",
      "license_invalid",
      "license_key_invalid",
      "license_not_found",
      "license_on_hold",
      "license_plan_expired",
      "license_revoked",
      "not_found",
      "paid_license_file_config_required",
      "payment_amount_mismatch",
      "paynow_api_error",
      "paynow_api_rate_limit_queue_full",
      "paynow_api_response_invalid",
      "paynow_api_unreachable",
      "paynow_checkout_intent_missing",
      "paynow_checkout_url_invalid",
      "paynow_event_conflict",
      "paynow_event_replay_incomplete",
      "paynow_payment_event_not_implemented",
      "paynow_pending_event_unavailable",
      "paynow_product_unmapped",
      "paynow_reconciliation_mismatch",
      "paynow_second_confirmation_mismatch",
      "paynow_second_confirmation_required",
      "paynow_sku_not_renewable",
      "paynow_signature_invalid",
      "paynow_signature_required",
      "paynow_store_invalid",
      "paynow_timestamp_invalid",
      "release_version_unavailable",
      "request_too_large",
      "request_rate_limited",
      "sealed_license_invalid",
      "sealed_license_locked",
      "sealed_license_mismatch",
      "sealed_license_unsupported",
      "session_activation_invalid",
      "session_expired",
      "session_invalid",
      "session_limit",
      "session_state_invalid",
      "store_corrupt",
      "version_policy_invalid"));

  public static final Set<String> LICENSE_SERVICE_SET =
      Collections.unmodifiableSet(new LinkedHashSet<>(LICENSE_SERVICE));

  private ErrorCodes() {}

  public static boolean isLicenseServiceErrorCode(String code) {
    return LICENSE_SERVICE_SET.contains(code);
  }
}
