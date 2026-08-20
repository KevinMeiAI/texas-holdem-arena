import type { AdminHandFork } from "../../../../../packages/contracts/src/index.js";
import type {
  HandForkPersistenceRecord,
  HandForkSourcePayloadV1,
  PgHandForkRepository,
} from "../hand-forks/hand-fork-repository.js";
import { adminHandForkFromPersistence } from "../hand-forks/hand-fork-view.js";

export interface CompletedDecisionBranchSource {
  fork: AdminHandFork;
  arenaState: unknown;
}

export interface DecisionBranchSourceReader {
  getCompletedSource(handForkId: string): Promise<CompletedDecisionBranchSource | null>;
}

interface DecisionBranchHandForkStore {
  getFork(id: string, includeDetail?: boolean): Promise<HandForkPersistenceRecord | null>;
  loadSourcePayload(forkId: string): Promise<HandForkSourcePayloadV1>;
}

export class PgDecisionBranchSourceReader implements DecisionBranchSourceReader {
  constructor(
    private readonly handForks: Pick<PgHandForkRepository, "getFork" | "loadSourcePayload">
      | DecisionBranchHandForkStore,
  ) {}

  async getCompletedSource(handForkId: string): Promise<CompletedDecisionBranchSource | null> {
    const record = await this.handForks.getFork(handForkId, true);
    if (!record || record.status !== "COMPLETED") return null;
    const payload = await this.handForks.loadSourcePayload(handForkId);
    return {
      fork: adminHandForkFromPersistence(record, payload),
      // This value remains private at this boundary. Only the strict snapshot
      // projection may consume it; public reads use the frozen publication.
      arenaState: structuredClone(payload.baseRequest.userPayload),
    };
  }
}
