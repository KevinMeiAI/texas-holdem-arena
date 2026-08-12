export type ParserPolicyVersion = "arena-parser-legacy-v1" | "arena-parser-strict-v1";
export type CorrectionProtocolVersion = "arena-correction-legacy-v1" | "arena-correction-v1";
export type HistoryProtocolVersion = "arena-history-legacy-v1" | "arena-history-v2";

export interface DecisionProtocolBundleDefinition {
  id: string;
  systemPromptVersion: string;
  contextVersion: string;
  outputSchemaVersion: string;
  parserPolicyVersion: ParserPolicyVersion;
  correctionProtocolVersion: CorrectionProtocolVersion;
  historyProtocolVersion: HistoryProtocolVersion;
  adapterProtocolVersion: string;
}

export const LEGACY_DECISION_PROTOCOL_BUNDLE: DecisionProtocolBundleDefinition = Object.freeze({
  id: "arena-native-v10",
  systemPromptVersion: "arena-system-v10",
  contextVersion: "model-context-v3",
  outputSchemaVersion: "arena-output-v2",
  parserPolicyVersion: "arena-parser-legacy-v1",
  correctionProtocolVersion: "arena-correction-legacy-v1",
  historyProtocolVersion: "arena-history-legacy-v1",
  adapterProtocolVersion: "arena-adapters-v1",
});

export const DECISION_PROTOCOL_V11_BUNDLE: DecisionProtocolBundleDefinition = Object.freeze({
  id: "arena-native-v11",
  systemPromptVersion: "arena-system-v11",
  contextVersion: "model-context-v4",
  outputSchemaVersion: "arena-output-v3",
  parserPolicyVersion: "arena-parser-strict-v1",
  correctionProtocolVersion: "arena-correction-v1",
  historyProtocolVersion: "arena-history-v2",
  adapterProtocolVersion: "arena-adapters-v2",
});

export const CURRENT_DECISION_PROTOCOL_BUNDLE_ID = DECISION_PROTOCOL_V11_BUNDLE.id;

const BUNDLES = new Map<string, DecisionProtocolBundleDefinition>([
  [LEGACY_DECISION_PROTOCOL_BUNDLE.id, LEGACY_DECISION_PROTOCOL_BUNDLE],
  [DECISION_PROTOCOL_V11_BUNDLE.id, DECISION_PROTOCOL_V11_BUNDLE],
]);

export function decisionProtocolBundle(id = CURRENT_DECISION_PROTOCOL_BUNDLE_ID): DecisionProtocolBundleDefinition {
  const bundle = BUNDLES.get(id);
  if (!bundle) throw new Error(`Unsupported decision protocol bundle: ${id}`);
  return bundle;
}

export function legacyDecisionProtocolBundle(
  promptVersion: string,
  outputSchemaVersion = "arena-output-v2",
): DecisionProtocolBundleDefinition {
  if (promptVersion === LEGACY_DECISION_PROTOCOL_BUNDLE.systemPromptVersion
    && outputSchemaVersion === LEGACY_DECISION_PROTOCOL_BUNDLE.outputSchemaVersion) {
    return LEGACY_DECISION_PROTOCOL_BUNDLE;
  }
  const promptVersionNumber = Number(promptVersion.match(/^arena-system-v(\d+)$/)?.[1] ?? 0);
  return Object.freeze({
    id: `legacy/${promptVersion}/${outputSchemaVersion}`,
    systemPromptVersion: promptVersion,
    contextVersion: promptVersionNumber <= 1
      ? "model-context-v1"
      : promptVersionNumber >= 7
        ? "model-context-v3"
        : "model-context-v2",
    outputSchemaVersion,
    parserPolicyVersion: "arena-parser-legacy-v1",
    correctionProtocolVersion: "arena-correction-legacy-v1",
    historyProtocolVersion: "arena-history-legacy-v1",
    adapterProtocolVersion: "arena-adapters-v1",
  });
}
