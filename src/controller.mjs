import { classifyRecoveryRequestError, classifyTerminalError } from "./policy.mjs";
import {
  analyzeCodexQuota,
  nextQuotaCheckDelayMs,
  quotaWindowLabel,
} from "./quota.mjs";

const STOPPED_GOAL_STATUSES = new Set([
  "paused",
  "budgetLimited",
  "authenticationFailed",
  "unauthorized",
  "complete",
]);
const QUOTA_LIMITED_GOAL_STATUSES = new Set(["usageLimited", "quotaExhausted"]);
const INTERRUPTABLE_GOAL_STATUSES = new Set(["active"]);
const RESUMABLE_GOAL_STATUSES = new Set(["active", "blocked"]);

function newThreadState() {
  return {
    transientTurns: new Map(),
    blockedTurns: new Set(),
    interruptAttempts: new Set(),
    compactionAttempts: new Set(),
    compactedTurns: new Set(),
    quotaLimited: false,
    pending: null,
    activeTurnId: null,
    interruptingTurnId: null,
    attempt: 0,
  };
}

export class GoalWatchdogController {
  constructor({
    sendRequest,
    delaysMs = [30_000, 60_000, 120_000, 300_000],
    interruptAfterMs = 120_000,
    quotaPollMs = 60_000,
    quotaResetGraceMs = 10_000,
    schedule = setTimeout,
    cancel = clearTimeout,
    logger = console,
  }) {
    if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
      throw new Error("delaysMs must contain at least one delay");
    }
    if (!Number.isFinite(interruptAfterMs) || interruptAfterMs < 0) {
      throw new Error("interruptAfterMs must be a non-negative number");
    }
    if (!Number.isFinite(quotaPollMs) || quotaPollMs < 0) {
      throw new Error("quotaPollMs must be a non-negative number");
    }
    if (!Number.isFinite(quotaResetGraceMs) || quotaResetGraceMs < 0) {
      throw new Error("quotaResetGraceMs must be a non-negative number");
    }
    this.sendRequest = sendRequest;
    this.delaysMs = delaysMs;
    this.interruptAfterMs = interruptAfterMs;
    this.quotaPollMs = quotaPollMs;
    this.quotaResetGraceMs = quotaResetGraceMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
    this.threads = new Map();
  }

  handleNotification(message) {
    if (message?.method === "account/rateLimits/updated") {
      this.#wakeQuotaWaiters();
      return;
    }
    if (message?.method === "error") {
      this.#handleError(message);
      return;
    }
    if (message?.method === "thread/compacted" ||
        (message?.method === "item/completed" &&
          message.params?.item?.type === "contextCompaction")) {
      this.#handleContextCompacted(message.params ?? {});
      return;
    }
    if (message?.method?.startsWith("item/")) {
      this.#handleTurnProgress(message.method, message.params ?? {});
      return;
    }
    if (message?.method === "thread/goal/updated") {
      this.#handleGoalUpdated(message.params ?? {});
      return;
    }
    if (message?.method === "thread/goal/cleared") {
      this.#resetThread(message.params?.threadId);
      return;
    }
    if (message?.method === "turn/started") {
      this.#handleTurnStarted(message.params ?? {});
      return;
    }
    if (message?.method === "turn/completed") {
      this.#handleTurnCompleted(message.params ?? {});
    }
  }

  close() {
    for (const [threadId] of this.threads) this.#resetThread(threadId);
  }

  #state(threadId) {
    let state = this.threads.get(threadId);
    if (!state) {
      state = newThreadState();
      this.threads.set(threadId, state);
    }
    return state;
  }

  #handleTurnStarted(params) {
    const threadId = params.threadId;
    const turnId = params.turnId ?? params.turn?.id;
    if (!threadId || !turnId) return;

    let state = this.#state(threadId);
    if (state.quotaLimited) {
      this.#resetThread(threadId);
      state = this.#state(threadId);
      this.logger.info(`Cancelled quota wait for ${threadId}: new turn ${turnId} started`);
    }
    if (["compact-request", "compact-wait"].includes(state.pending?.kind)) {
      if (
        state.pending.compactionTurnId &&
        state.pending.compactionTurnId !== turnId
      ) {
        this.#cancelPending(
          state,
          state.pending.kind,
          `new turn ${turnId} replaced compaction turn ${state.pending.compactionTurnId}`,
        );
      } else {
        state.pending.compactionTurnId = turnId;
        state.activeTurnId = turnId;
        return;
      }
    }
    if (state.pending && state.pending.turnId !== turnId) {
      this.#cancelPending(
        state,
        state.pending.kind,
        `new turn ${turnId} started`,
      );
    }
    if (state.activeTurnId && state.activeTurnId !== turnId) {
      this.#cancelPending(state);
      state.transientTurns.clear();
      state.blockedTurns.clear();
      state.interruptAttempts.clear();
      state.compactionAttempts.clear();
      state.compactedTurns.clear();
      state.interruptingTurnId = null;
    }
    state.activeTurnId = turnId;
  }

  #handleTurnProgress(method, params) {
    const { threadId, turnId } = params;
    if (!threadId || !turnId) return;

    const state = this.threads.get(threadId);
    if (state?.pending?.kind !== "interrupt" || state.pending.turnId !== turnId) return;

    this.#cancelPending(state, "interrupt", `turn progress: ${method}`);
    state.transientTurns.delete(turnId);
  }

  #handleError(message) {
    const classification = classifyTerminalError(message);
    if (classification.recoveryAction === "waitForQuota") {
      const { threadId, turnId } = message.params ?? {};
      if (!threadId) {
        this.logger.warn("Ignored usage-limit error without threadId");
        return;
      }
      const state = this.#state(threadId);
      if (state.activeTurnId && turnId && state.activeTurnId !== turnId) {
        this.logger.info(`Ignored stale usage-limit error for ${threadId}/${turnId}`);
        return;
      }
      this.#startQuotaWait(threadId, state, turnId);
      return;
    }
    if (classification.recoveryAction === "compact") {
      const { threadId, turnId } = message.params ?? {};
      if (threadId && turnId) {
        const state = this.#state(threadId);
        if (
          state.compactionAttempts.has(turnId) ||
          (state.pending?.kind?.startsWith("compact") && state.pending.turnId === turnId)
        ) {
          this.logger.info(`Ignored duplicate context exhaustion for ${threadId}/${turnId}`);
          return;
        }
        if (state.activeTurnId && state.activeTurnId !== turnId) {
          this.logger.info(`Ignored stale context exhaustion for ${threadId}/${turnId}`);
          return;
        }
        this.#cancelPending(state);
        this.#scheduleCompaction(threadId, turnId, state);
      }
      return;
    }
    if (!classification.transient) return;

    const { threadId, turnId } = message.params ?? {};
    if (!threadId || !turnId) {
      this.logger.warn("Ignored transient error without threadId and turnId");
      return;
    }

    const state = this.#state(threadId);
    if (state.activeTurnId && state.activeTurnId !== turnId) {
      this.logger.info(`Ignored stale transient error for ${threadId}/${turnId}`);
      return;
    }
    state.transientTurns.set(turnId, classification);
    this.logger.info(
      `Transient error for ${threadId}/${turnId}: ${classification.reason}`,
    );

    if (classification.willRetry === true && state.blockedTurns.has(turnId)) {
      this.#scheduleIfCorrelated(threadId, turnId, state);
      return;
    }

    if (classification.willRetry === true) {
      this.#scheduleInterrupt(threadId, turnId, state);
      return;
    }

    this.#cancelPending(state, "interrupt");
    this.#scheduleIfCorrelated(threadId, turnId, state);
  }

  #handleGoalUpdated(params) {
    const threadId = params.threadId;
    const turnId = params.turnId;
    const status = params.goal?.status;
    if (!threadId || !status) return;

    const state = this.#state(threadId);
    if (QUOTA_LIMITED_GOAL_STATUSES.has(status)) {
      this.#startQuotaWait(threadId, state, turnId);
      return;
    }
    if (status === "blocked" && turnId) {
      this.#cancelPending(state, "interrupt");
      state.blockedTurns.add(turnId);
      this.#scheduleIfCorrelated(threadId, turnId, state);
      return;
    }

    if (status === "active") {
      if (state.quotaLimited) {
        this.#resetThread(threadId);
        this.logger.info(`Cancelled quota wait for ${threadId}: goal became active`);
        return;
      }
      if (state.pending?.kind === "resume" && state.pending.requireBlocked) {
        this.#cancelPending(state, "resume", "blocked goal became active");
      }
      return;
    }
    if (STOPPED_GOAL_STATUSES.has(status)) this.#resetThread(threadId);
  }

  #handleTurnCompleted(params) {
    const threadId = params.threadId;
    const turn = params.turn;
    const turnId = params.turnId ?? turn?.id;
    if (!threadId || !turnId) return;

    const state = this.threads.get(threadId);
    if (!state) return;
    if (state.activeTurnId === turnId) state.activeTurnId = null;

    if (turn?.status === "completed" && !turn.error) {
      if (state.pending?.kind?.startsWith("compact")) {
        this.logger.info(
          `Successful turn completed for ${threadId}; context recovery remains pending`,
        );
        return;
      }
      this.#clearSuccessfulTurn(state);
      this.logger.info(`Successful turn completed for ${threadId}; retry delay reset`);
      return;
    }

    const interruptionFinished =
      state.interruptingTurnId === turnId &&
      (turn?.status === "interrupted" ||
        turn?.status === "failed" ||
        (turn?.status === "completed" && Boolean(turn.error)));
    if (!interruptionFinished) return;

    state.interruptingTurnId = null;
    state.transientTurns.delete(turnId);
    state.blockedTurns.delete(turnId);
    this.#scheduleResume(threadId, turnId, state, false);
  }

  #clearSuccessfulTurn(state) {
    this.#cancelPending(state);
    state.attempt = 0;
    state.activeTurnId = null;
    state.interruptingTurnId = null;
    state.transientTurns.clear();
    state.blockedTurns.clear();
    state.interruptAttempts.clear();
    state.compactionAttempts.clear();
    state.compactedTurns.clear();
    state.quotaLimited = false;
  }

  #startQuotaWait(threadId, state, turnId = null) {
    if (this.threads.get(threadId) !== state) return;
    if (state.pending?.kind === "quota") {
      state.quotaLimited = true;
      return;
    }
    this.#cancelPending(state);
    state.quotaLimited = true;
    this.#scheduleQuotaCheck(threadId, state, 0, turnId);
    this.logger.info(`Goal ${threadId} reached a usage limit; checking quota availability`);
  }

  #scheduleQuotaCheck(threadId, state, delayMs, turnId = null) {
    if (
      state.pending ||
      !state.quotaLimited ||
      this.threads.get(threadId) !== state
    ) return;
    const pending = {
      kind: "quota",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      await this.#checkQuotaAndMaybeResume(threadId, state, pending);
    }, delayMs);
    state.pending = pending;
  }

  async #checkQuotaAndMaybeResume(threadId, state, pending) {
    try {
      const response = await this.sendRequest("account/rateLimits/read");
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      const analysis = analyzeCodexQuota(response);

      if (!analysis.available) {
        const delayMs = nextQuotaCheckDelayMs(analysis, {
          pollMs: this.quotaPollMs,
          resetGraceMs: this.quotaResetGraceMs,
        });
        this.#releasePending(state, pending);
        this.#scheduleQuotaCheck(threadId, state, delayMs, pending.turnId);
        if (analysis.known) {
          const windows = analysis.exhaustedWindows.map(quotaWindowLabel).join(", ");
          this.logger.info(
            `Quota remains exhausted for ${threadId} (${windows}); check in ${delayMs}ms`,
          );
        } else {
          this.logger.warn(`Quota data is unknown for ${threadId}; check in ${delayMs}ms`);
        }
        return;
      }

      const goalResponse = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      const status = goalResponse?.goal?.status;
      if (!QUOTA_LIMITED_GOAL_STATUSES.has(status)) {
        this.#releasePending(state, pending);
        state.quotaLimited = false;
        this.#resetThread(threadId);
        this.logger.info(
          `Goal ${threadId} is ${status ?? "unknown"}; quota auto-resume cancelled`,
        );
        return;
      }

      await this.sendRequest("thread/goal/set", { threadId, status: "active" });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      state.quotaLimited = false;
      state.attempt = 0;
      this.logger.info(`Official quota recovered; goal ${threadId} resumed automatically`);
    } catch (error) {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      const classification = classifyRecoveryRequestError(error);
      this.logger.error(
        `Failed to check quota or resume ${threadId}: ${classification.reason}: ${error.message}`,
      );
      if (!classification.retry) {
        this.#resetThread(threadId);
        return;
      }
      this.#scheduleQuotaCheck(threadId, state, this.quotaPollMs, pending.turnId);
    }
  }

  #wakeQuotaWaiters() {
    for (const [threadId, state] of this.threads) {
      if (!state.quotaLimited) continue;
      const turnId = state.pending?.turnId ?? null;
      this.#cancelPending(state, "quota", "rate-limit update received");
      this.#scheduleQuotaCheck(threadId, state, 0, turnId);
    }
  }

  #scheduleCompaction(threadId, turnId, state, retry = false) {
    if (state.compactionAttempts.has(turnId) || state.pending) return;
    const delayMs = retry
      ? this.delaysMs[Math.min(state.attempt, this.delaysMs.length - 1)]
      : 0;
    const pending = {
      kind: "compact",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (pending.cancelled || state.pending !== pending) return;
      await this.#compactAndResume(threadId, turnId, state, pending);
    }, delayMs);
    state.pending = pending;
    this.logger.info(`Context exhausted for ${threadId}/${turnId}; compact in ${delayMs}ms`);
  }

  async #compactAndResume(threadId, turnId, state, pending) {
    try {
      const before = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      const beforeStatus = before?.goal?.status;
      if (QUOTA_LIMITED_GOAL_STATUSES.has(beforeStatus)) {
        this.#releasePending(state, pending);
        this.#startQuotaWait(threadId, state, turnId);
        return;
      }
      if (STOPPED_GOAL_STATUSES.has(beforeStatus)) {
        this.#releasePending(state, pending);
        return;
      }
      state.compactionAttempts.add(turnId);
      pending.kind = "compact-request";
      await this.sendRequest("thread/compact/start", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending) || state.compactedTurns.has(turnId)) {
        return;
      }
      pending.kind = "compact-wait";
      pending.handle = this.schedule(() => {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
        this.logger.error(
          `Stopped context recovery for ${threadId}/${turnId}: compaction completion timed out`,
        );
      }, this.delaysMs.at(-1));
      this.logger.info(`Waiting for context compaction completion for ${threadId}`);
    } catch (error) {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      const classification = classifyRecoveryRequestError(error);
      this.logger.error(
        `Failed to compact context for ${threadId}: ${classification.reason}: ${error.message}`,
      );
      if (!classification.retry) {
        return;
      }
      if (![408, 429, 502, 503, 504].includes(error?.code)) {
        this.logger.error(
          `Stopped context recovery for ${threadId}/${turnId}: compaction delivery is uncertain`,
        );
        return;
      }
      state.compactionAttempts.delete(turnId);
      this.#scheduleCompaction(threadId, turnId, state, true);
      state.attempt += 1;
    }
  }

  #handleContextCompacted(params) {
    const threadId = params.threadId;
    if (!threadId) return;
    const state = this.threads.get(threadId);
    const pending = state?.pending;
    if (!pending?.kind?.startsWith("compact")) return;
    if (
      pending.compactionTurnId &&
      params.turnId &&
      params.turnId !== pending.compactionTurnId
    ) return;
    const turnId = pending.turnId;
    state.compactedTurns.add(turnId);
    this.cancel(pending.handle);
    this.#releasePending(state, pending);
    this.#scheduleResumeAfterCompaction(threadId, turnId, state, 0);
  }

  #scheduleResumeAfterCompaction(threadId, turnId, state, delayMs) {
    if (state.pending) return;
    const pending = {
      kind: "compact-resume",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      await this.#resumeAfterCompaction(threadId, turnId, state, pending);
    }, delayMs);
    state.pending = pending;
  }

  async #resumeAfterCompaction(threadId, turnId, state, pending) {
    try {
      const after = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      if (QUOTA_LIMITED_GOAL_STATUSES.has(after?.goal?.status)) {
        this.#releasePending(state, pending);
        this.#startQuotaWait(threadId, state, turnId);
        return;
      }
      if (after?.goal?.status === "blocked") {
        await this.sendRequest("thread/goal/set", { threadId, status: "active" });
      }
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      state.attempt = 0;
      this.logger.info(`Compacted context and resumed goal ${threadId}`);
    } catch (error) {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      const classification = classifyRecoveryRequestError(error);
      this.logger.error(`Failed to resume compacted goal ${threadId}: ${classification.reason}`);
      if (!classification.retry) return;
      const delayMs = this.delaysMs[Math.min(state.attempt, this.delaysMs.length - 1)];
      this.#scheduleResumeAfterCompaction(threadId, turnId, state, delayMs);
      state.attempt += 1;
    }
  }

  #scheduleInterrupt(threadId, turnId, state) {
    if (state.interruptAttempts.has(turnId)) return;
    if (state.interruptingTurnId === turnId || state.pending) return;

    const pending = {
      kind: "interrupt",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (pending.cancelled || state.pending !== pending) return;
      await this.#interruptIfStillEligible(threadId, turnId, state, pending);
    }, this.interruptAfterMs);
    state.pending = pending;
    this.logger.info(
      `Transient retry for ${threadId}/${turnId}; interrupt in ${this.interruptAfterMs}ms`,
    );
  }

  async #interruptIfStillEligible(threadId, turnId, state, pending) {
    if (state.interruptAttempts.has(turnId)) return;
    let interruptSent = false;

    try {
      const response = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      if (!state.transientTurns.has(turnId)) {
        this.#releasePending(state, pending);
        return;
      }
      if (state.activeTurnId && state.activeTurnId !== turnId) {
        this.#releasePending(state, pending);
        return;
      }

      const status = response?.goal?.status;
      if (!INTERRUPTABLE_GOAL_STATUSES.has(status)) {
        this.#releasePending(state, pending);
        this.logger.info(
          `Goal ${threadId} is ${status ?? "unknown"}; automatic interrupt skipped`,
        );
        return;
      }

      state.interruptAttempts.add(turnId);
      state.interruptingTurnId = turnId;
      this.#releasePending(state, pending);
      interruptSent = true;
      await this.sendRequest("turn/interrupt", { threadId, turnId });
      this.logger.info(`Interrupted transient turn ${threadId}/${turnId}`);
    } catch (error) {
      if (!interruptSent) {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
      } else if (state.interruptingTurnId === turnId) {
        state.interruptingTurnId = null;
      }
      this.logger.error(`Failed to interrupt turn ${threadId}/${turnId}: ${error.message}`);
    }
  }

  #scheduleIfCorrelated(threadId, turnId, state) {
    if (state.pending) return;
    if (!state.transientTurns.has(turnId) || !state.blockedTurns.has(turnId)) return;
    this.#scheduleResume(threadId, turnId, state, true);
  }

  #scheduleResume(threadId, turnId, state, requireBlocked) {
    if (state.pending) return;

    const delayIndex = Math.min(state.attempt, this.delaysMs.length - 1);
    const delayMs = this.delaysMs[delayIndex];
    const pending = {
      kind: "resume",
      threadId,
      handle: null,
      cancelled: false,
      requireBlocked,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (pending.cancelled || state.pending !== pending) return;
      await this.#resumeGoal(threadId, turnId, state, requireBlocked, pending);
    }, delayMs);
    state.pending = pending;
    if (requireBlocked) {
      this.logger.info(
        `Goal ${threadId} blocked by a transient error; resume in ${delayMs}ms`,
      );
    } else {
      this.logger.info(`Interrupted turn ${threadId}/${turnId}; resume in ${delayMs}ms`);
    }
  }

  async #resumeGoal(threadId, turnId, state, requireBlocked, pending) {
    let resumeSent = false;

    try {
      const response = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      if (state.activeTurnId && state.activeTurnId !== turnId) {
        this.#releasePending(state, pending);
        return;
      }

      const status = response?.goal?.status;
      if (QUOTA_LIMITED_GOAL_STATUSES.has(status)) {
        this.#releasePending(state, pending);
        this.#startQuotaWait(threadId, state, turnId);
        return;
      }
      const canResume = requireBlocked
        ? status === "blocked"
        : RESUMABLE_GOAL_STATUSES.has(status);
      if (!canResume) {
        this.#releasePending(state, pending);
        this.logger.info(
          `Goal ${threadId} is ${status ?? "unknown"}; automatic resume skipped`,
        );
        return;
      }

      this.#releasePending(state, pending);
      resumeSent = true;
      await this.sendRequest("thread/goal/set", { threadId, status: "active" });
      if (this.threads.get(threadId) !== state) return;
      state.attempt += 1;
      state.transientTurns.delete(turnId);
      state.blockedTurns.delete(turnId);
      state.interruptAttempts.delete(turnId);
      this.logger.info(`Goal ${threadId} resumed automatically`);
    } catch (error) {
      if (!resumeSent) {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
      }
      this.logger.error(`Failed to resume goal ${threadId}: ${error.message}`);
      if (this.threads.get(threadId) !== state) return;
      if (state.activeTurnId && state.activeTurnId !== turnId) return;
      const classification = classifyRecoveryRequestError(error);
      if (!classification.retry) {
        this.logger.error(
          `Stopped goal recovery for ${threadId}/${turnId}: ${classification.reason}`,
        );
        this.#resetThread(threadId);
        return;
      }
      state.attempt += 1;
      state.transientTurns.set(turnId, { transient: true, reason: "resume-rpc-failed" });
      state.blockedTurns.add(turnId);
      this.#scheduleResume(threadId, turnId, state, requireBlocked);
    }
  }

  #isCurrentPending(threadId, state, pending) {
    return (
      !pending.cancelled &&
      state.pending === pending &&
      this.threads.get(threadId) === state
    );
  }

  #releasePending(state, pending) {
    if (state.pending === pending) state.pending = null;
  }

  #cancelPending(state, kind = null, reason = null) {
    if (!state.pending || (kind && state.pending.kind !== kind)) return;
    const pending = state.pending;
    pending.cancelled = true;
    this.cancel(pending.handle);
    state.pending = null;
    if (reason) {
      this.logger.info(
        `Cancelled pending ${pending.kind} for ${pending.threadId}/${pending.turnId}: ${reason}`,
      );
    }
  }

  #resetThread(threadId) {
    if (!threadId) return;
    const state = this.threads.get(threadId);
    if (!state) return;
    this.#cancelPending(state);
    this.threads.delete(threadId);
  }
}
