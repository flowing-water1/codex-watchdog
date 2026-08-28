const TRANSIENT_HTTP_CODES = new Set([429, 502, 503, 504]);
const CONNECTION_FAILURE_KEYS = new Map([
  ["httpConnectionFailed", "http-connection-failed"],
  ["responseStreamConnectionFailed", "response-stream-connection-failed"],
  ["responseStreamDisconnected", "response-stream-disconnected"],
  ["responseTooManyFailedAttempts", "response-too-many-failed-attempts"],
]);

const NON_RECOVERABLE_MESSAGE_PATTERN =
  /\b(?:insufficient[_ -]?quota|api billing|billing (?:exhaust|deplet)|credit.?exhaust|credit.?deplet|unauthori[sz]ed|forbidden|bad request|invalid request|authentication|401|403)\b/i;
const USAGE_LIMIT_MESSAGE_PATTERN =
  /\b(?:usageLimitExceeded|usageLimited|quotaExhausted|usage[ _-]?limit(?: (?:reached|exceeded))?)\b/i;
const PERMANENT_MESSAGE_PATTERN =
  /\b(?:compact(?:ion)?|context window|quota|billing|credit|unauthori[sz]ed|forbidden|bad request|invalid request|authentication)\b/i;
const TRANSIENT_MESSAGE_PATTERN =
  /\b(?:service unavailable|bad gateway|gateway timeout|connection (?:reset|refused)|network (?:error|failure)|timed? out|stream (?:closed|disconnected)|app-server (?:websocket )?disconnected|websocket is not open)\b/i;

function result(transient, reason, statusCode = null, willRetry = false) {
  const classification = { transient, reason, statusCode };
  if (willRetry && transient) classification.willRetry = true;
  return classification;
}

function markCodexRetry(classification, willRetry) {
  if (!willRetry || !classification.transient) return classification;
  return { ...classification, willRetry: true };
}

function compactRecovery() {
  return {
    transient: false,
    reason: "context-window-exhausted",
    statusCode: null,
    recoveryAction: "compact",
  };
}

function quotaRecovery() {
  return {
    transient: false,
    reason: "usage-limit-exceeded",
    statusCode: null,
    recoveryAction: "waitForQuota",
  };
}

function structuredConnectionFailure(info) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;

  for (const [key, reason] of CONNECTION_FAILURE_KEYS) {
    if (!(key in info)) continue;
    const statusCode = info[key]?.httpStatusCode ?? null;
    if (statusCode == null || (Number.isInteger(statusCode) && statusCode < 400)) {
      return result(true, reason, statusCode);
    }
    if (TRANSIENT_HTTP_CODES.has(statusCode)) {
      return result(true, `http-${statusCode}`, statusCode);
    }
    return result(false, `http-${statusCode}`, statusCode);
  }

  return null;
}

export function classifyTerminalError(notification) {
  if (notification?.method !== "error") return result(false, "not-error-notification");

  const params = notification.params ?? {};
  const willRetry = params.willRetry === true;

  const error = params.error ?? {};
  const info = error.codexErrorInfo;
  if (info === "contextWindowExceeded") return compactRecovery();
  const message = [error.message, error.additionalDetails]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/ran out of room in the model'?s context window|context window exceeded/i.test(message)) {
    return compactRecovery();
  }
  if (NON_RECOVERABLE_MESSAGE_PATTERN.test(message)) {
    return result(false, "permanent-error-message");
  }
  if (info === "usageLimitExceeded") return quotaRecovery();

  const structured = structuredConnectionFailure(info);
  if (structured) return markCodexRetry(structured, willRetry);

  if (info === "serverOverloaded") {
    return result(true, "server-overloaded", null, willRetry);
  }

  const hasProvider429 = /(?:^|\D)429(?:\D|$)/.test(message);
  if (USAGE_LIMIT_MESSAGE_PATTERN.test(message) && !hasProvider429) return quotaRecovery();
  if (PERMANENT_MESSAGE_PATTERN.test(message)) {
    return result(false, "permanent-error-message");
  }

  const httpMatch = message.match(/(?:^|\D)(429|502|503|504)(?:\D|$)/);
  if (httpMatch) {
    const statusCode = Number(httpMatch[1]);
    return result(true, `http-${statusCode}`, statusCode, willRetry);
  }
  if (TRANSIENT_MESSAGE_PATTERN.test(message)) {
    return result(true, "transient-network-message", null, willRetry);
  }

  return result(false, "unclassified-terminal-error");
}

export function classifyRecoveryRequestError(error) {
  const serialized = JSON.stringify({ code: error?.code, data: error?.data });
  const message = `${error?.message ?? ""} ${serialized}`;
  if (error?.code === 401 || error?.code === 403 || /auth|unauthori[sz]ed|forbidden/i.test(message)) {
    return { retry: false, reason: "authentication-failed" };
  }
  if (/quota|usage.?limit|budget.?limit|credit.?exhaust/i.test(message)) {
    return { retry: false, reason: "quota-exhausted" };
  }
  if (
    [408, 429, 502, 503, 504].includes(error?.code) ||
    TRANSIENT_MESSAGE_PATTERN.test(message)
  ) {
    return { retry: true, reason: "transient-recovery-request" };
  }
  return { retry: false, reason: "permanent-recovery-request" };
}
