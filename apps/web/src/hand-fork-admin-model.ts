import type {
  AdminHandFork,
  CreateHandForkRequest,
  HandForkSourceCandidate,
  HandForkSourceErrorCode,
  HandForkTargetSummary,
} from "../../../packages/contracts/src/hand-forks";
import type { TournamentSummary } from "./types";

const ACTION_ORDER = ["fold", "check", "call", "bet", "raise", "all_in"] as const;

export interface HandForkProgress {
  terminal: number;
  total: number;
  ratio: number;
}

export type HandForkCreateParameters = Omit<CreateHandForkRequest, "clientRequestId">;

export interface HandForkCreateAttempt {
  fingerprint: string;
  clientRequestId: string;
}

export function handForkCreateFingerprint(parameters: HandForkCreateParameters): string {
  return JSON.stringify(parameters);
}

export function handForkCreateAttempt(
  previous: HandForkCreateAttempt | null,
  parameters: HandForkCreateParameters,
  createId: () => string,
): HandForkCreateAttempt {
  const fingerprint = handForkCreateFingerprint(parameters);
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, clientRequestId: createId() };
}

export function parseHandForkCreateAttempts(raw: string | null): HandForkCreateAttempt[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const byFingerprint = new Map<string, HandForkCreateAttempt>();
    for (const value of parsed.slice(-12)) {
      if (!value || typeof value !== "object") continue;
      const attempt = value as Partial<HandForkCreateAttempt>;
      if (typeof attempt.fingerprint !== "string" || attempt.fingerprint.length === 0
        || typeof attempt.clientRequestId !== "string" || attempt.clientRequestId.length === 0) continue;
      byFingerprint.set(attempt.fingerprint, {
        fingerprint: attempt.fingerprint,
        clientRequestId: attempt.clientRequestId,
      });
    }
    return [...byFingerprint.values()];
  } catch {
    return [];
  }
}

export function isHandForkActive(status: AdminHandFork["status"]): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

export function handForkProgress(fork: AdminHandFork): HandForkProgress {
  const total = fork.targets.reduce((sum, target) => sum + target.sampleCount, 0);
  const terminal = fork.summary?.terminalTrials
    ?? fork.targets.reduce((sum, target) => sum + target.terminalTrials, 0);
  return {
    terminal,
    total,
    ratio: total === 0 ? 0 : Math.min(1, terminal / total),
  };
}

export function completedHandForkTournaments(tournaments: readonly TournamentSummary[]): TournamentSummary[] {
  return tournaments
    .filter((tournament) => tournament.status === "COMPLETED" && tournament.publicState.completedHands > 0)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function availableHandForkSources(sources: readonly HandForkSourceCandidate[]) {
  return sources.filter((source): source is Extract<HandForkSourceCandidate, { availability: "AVAILABLE" }> => (
    source.availability === "AVAILABLE"
  ));
}

export interface HandForkSourceAuditExclusion {
  reasonCode: HandForkSourceErrorCode;
  count: number;
}

export function handForkSourceAuditExclusions(
  sources: readonly HandForkSourceCandidate[],
): HandForkSourceAuditExclusion[] {
  const counts = new Map<HandForkSourceErrorCode, number>();
  for (const source of sources) {
    if (source.availability !== "UNAVAILABLE") continue;
    counts.set(source.reasonCode, (counts.get(source.reasonCode) ?? 0) + 1);
  }
  return [...counts].map(([reasonCode, count]) => ({ reasonCode, count }));
}

export function actionDistributionEntries(summary: HandForkTargetSummary): [string, number][] {
  const known = ACTION_ORDER
    .map((action) => [action, summary.actionDistribution[action] ?? 0] as [string, number])
    .filter(([, count]) => count > 0);
  const knownActions = new Set(ACTION_ORDER);
  const additional = Object.entries(summary.actionDistribution)
    .filter(([action, count]) => !knownActions.has(action as typeof ACTION_ORDER[number]) && count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return [...known, ...additional];
}
