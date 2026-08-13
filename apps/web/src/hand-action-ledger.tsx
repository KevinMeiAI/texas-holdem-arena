import { PlayingCard } from "./components";
import { buildHandActionLedger, HAND_STREETS, type HandCellState, type HandLedgerAction } from "./hand-action-ledger-model";
import type { ArenaEvent, ArenaPlayer } from "./types";
import { type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

const streetLabels = {
  PREFLOP: { title: "pre-flop", note: ["翻牌前", "pre-flop"] },
  FLOP: { title: "flop", note: ["翻牌圈", "flop"] },
  TURN: { title: "turn", note: ["转牌圈", "turn"] },
  RIVER: { title: "river", note: ["河牌圈", "river"] },
} as const;

const emptyLabels: Record<HandCellState, [string, string]> = {
  FOLDED: ["已弃牌", "Folded"],
  ALL_IN: ["已全下", "All-in"],
  NOT_DEALT: ["未发牌", "Not dealt"],
  NO_ACTION: ["无需行动", "No action"],
};

function actionTitle(action: HandLedgerAction, locale: UiLocale): string | undefined {
  if (!action.audit) return undefined;
  const parts = [
    action.audit.providerCalls > 0 ? `${uiText(locale, "模型调用", "Model calls")} ${action.audit.providerCalls}` : null,
    action.audit.protocolFailures > 0 ? `${uiText(locale, "协议纠错", "Protocol corrections")} ${action.audit.protocolFailures}` : null,
    action.audit.usedFallback ? uiText(locale, "由规则兜底执行", "Executed by rules fallback") : null,
    action.audit.decisionSummary ? `${uiText(locale, "决策说明", "Decision")}: ${action.audit.decisionSummary}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(uiText(locale, "；", "; ")) : undefined;
}

function Action({ action, locale }: { action: HandLedgerAction; locale: UiLocale }) {
  return (
    <div className={`hand-action ${action.tone}`} title={actionTitle(action, locale)}>
      {(action.term || action.audit?.protocolFailures || action.audit?.usedFallback) && (
        <div className="hand-action-meta">
          {action.term && <em>{action.term}</em>}
          {Boolean(action.audit?.protocolFailures) && <span>{uiText(locale, "纠错", "Corrected")}</span>}
          {action.audit?.usedFallback && <span className="fallback">{uiText(locale, "兜底", "Fallback")}</span>}
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
  const { locale, text } = useUiPreferences();
  const rows = buildHandActionLedger(players, events, locale);
  return (
    <section className="hand-action-ledger" aria-labelledby="hand-action-ledger-heading">
      <header className="hand-action-ledger-heading">
        <div>
          <h2 id="hand-action-ledger-heading">{text("手牌与行动链", "Hands and actions")}</h2>
        </div>
        <span>{rows.length} {text("位模型", "models")}</span>
      </header>
      <div className="hand-action-scroll" tabIndex={0} aria-label={text("横向滚动查看每条街的模型行动", "Scroll horizontally to view actions by street")}>
        <table className="hand-action-table">
          <colgroup>
            <col className="hand-model-col" />
            <col className="hand-cards-col" />
            {HAND_STREETS.map((street) => <col className="hand-street-col" key={street} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{text("模型", "Model")}</th>
              <th scope="col">{text("手牌", "Cards")}</th>
              {HAND_STREETS.map((street) => (
                <th scope="col" key={street}>
                  {locale === "zh-CN"
                    ? <><b>{streetLabels[street].note[0]}</b><small>{streetLabels[street].title}</small></>
                    : <b>{streetLabels[street].title}</b>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.player.id}>
                <th scope="row">
                  <div className="hand-model-cell">
                    <span className="hand-model-name" title={row.player.displayName}>{row.player.displayName}</span>
                    {row.position && <b className="hand-position" title={row.position === "SB" ? text("小盲位", "Small blind") : text("大盲位", "Big blind")}>{row.position}</b>}
                  </div>
                </th>
                <td><div className="hand-hole-cards" aria-label={`${row.player.displayName} ${text("的手牌", "hole cards")}`}><PlayingCard card={holeCards.get(row.player.id)?.[0]} compact /><PlayingCard card={holeCards.get(row.player.id)?.[1]} compact /></div></td>
                {HAND_STREETS.map((street) => {
                  const cell = row.cells[street];
                  return (
                    <td key={street}>
                      {cell.actions.length > 0 ? (
                        <div className="hand-action-chain">
                          {cell.actions.map((action) => <Action action={action} locale={locale} key={action.eventSequence} />)}
                        </div>
                      ) : <span className={`hand-cell-empty ${cell.state?.toLowerCase().replace("_", "-")}`}>{cell.state ? uiText(locale, ...emptyLabels[cell.state]) : "—"}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="hand-action-legend">
        <span><i className="aggressive" />{text("下注 / 加注", "Bet / raise")}</span>
        <span><i />{text("跟注 / 过牌", "Call / check")}</span>
        <span><i className="fold" />{text("弃牌", "Fold")}</span>
      </footer>
    </section>
  );
}
