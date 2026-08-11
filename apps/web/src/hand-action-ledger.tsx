import { PlayingCard } from "./components";
import { buildHandActionLedger, HAND_STREETS, type HandCellState, type HandLedgerAction } from "./hand-action-ledger-model";
import type { ArenaEvent, ArenaPlayer } from "./types";

const streetLabels = {
  PREFLOP: { title: "pre-flop", note: "翻牌前" },
  FLOP: { title: "flop", note: "翻牌圈" },
  TURN: { title: "turn", note: "转牌圈" },
  RIVER: { title: "river", note: "河牌圈" },
} as const;

const emptyLabels: Record<HandCellState, string> = {
  FOLDED: "已弃牌",
  ALL_IN: "已全下",
  NOT_DEALT: "未发牌",
  NO_ACTION: "无需行动",
};

function actionTitle(action: HandLedgerAction): string | undefined {
  if (!action.audit) return undefined;
  const parts = [
    action.audit.providerCalls > 0 ? `模型调用 ${action.audit.providerCalls} 次` : null,
    action.audit.protocolFailures > 0 ? `协议纠错 ${action.audit.protocolFailures} 次` : null,
    action.audit.usedFallback ? "由规则兜底执行" : null,
    action.audit.decisionSummary ? `决策说明：${action.audit.decisionSummary}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("；") : undefined;
}

function Action({ action }: { action: HandLedgerAction }) {
  return (
    <div className={`hand-action ${action.tone}`} title={actionTitle(action)}>
      {(action.term || action.audit?.protocolFailures || action.audit?.usedFallback) && (
        <div className="hand-action-meta">
          {action.term && <em>{action.term}</em>}
          {Boolean(action.audit?.protocolFailures) && <span>纠错</span>}
          {action.audit?.usedFallback && <span className="fallback">兜底</span>}
        </div>
      )}
      <strong>{action.label}</strong>
    </div>
  );
}

export function HandActionLedger({ players, events, holeCards }: {
  players: ArenaPlayer[];
  events: ArenaEvent[];
  holeCards: ReadonlyMap<string, unknown[]>;
}) {
  const rows = buildHandActionLedger(players, events);
  return (
    <section className="hand-action-ledger" aria-labelledby="hand-action-ledger-heading">
      <header className="hand-action-ledger-heading">
        <div>
          <h2 id="hand-action-ledger-heading">手牌与行动链</h2>
          <p>模型按座位顺序排列；同一格由上至下阅读</p>
        </div>
        <span>{rows.length} 位模型</span>
      </header>
      <div className="hand-action-scroll" tabIndex={0} aria-label="横向滚动查看每条街的模型行动">
        <table className="hand-action-table">
          <colgroup>
            <col className="hand-model-col" />
            <col className="hand-cards-col" />
            {HAND_STREETS.map((street) => <col className="hand-street-col" key={street} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col">手牌</th>
              {HAND_STREETS.map((street) => (
                <th scope="col" key={street}><b>{streetLabels[street].title}</b><small>{streetLabels[street].note}</small></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.player.id}>
                <th scope="row">
                  <span className="model-monogram">{row.player.displayName.slice(0, 1)}</span>
                  <span className="hand-model-name">{row.player.displayName}</span>
                  {row.position && <b className="hand-position" title={row.position === "SB" ? "小盲位" : "大盲位"}>{row.position}</b>}
                </th>
                <td><div className="hand-hole-cards" aria-label={`${row.player.displayName} 的手牌`}><PlayingCard card={holeCards.get(row.player.id)?.[0]} compact /><PlayingCard card={holeCards.get(row.player.id)?.[1]} compact /></div></td>
                {HAND_STREETS.map((street) => {
                  const cell = row.cells[street];
                  return (
                    <td key={street}>
                      {cell.actions.length > 0 ? (
                        <div className="hand-action-chain">
                          {cell.actions.map((action) => <Action action={action} key={action.eventSequence} />)}
                        </div>
                      ) : <span className={`hand-cell-empty ${cell.state?.toLowerCase().replace("_", "-")}`}>{cell.state ? emptyLabels[cell.state] : "—"}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="hand-action-legend">
        <span><i className="aggressive" />主动动作</span>
        <span><i />跟注 / 过牌</span>
        <span>术语只标注可由权威事件可靠判断的 <b>Open、3-Bet、C-Bet、Jam</b></span>
      </footer>
    </section>
  );
}
