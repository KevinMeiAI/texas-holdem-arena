import { forwardRef } from "react";
import { formatArenaPhase, formatChips, modelTint, PlayingCard } from "./components";
import type {
  MomentStoryCardPlayer,
  MomentStoryCardViewModel,
} from "./moment-story-card-model";
import { ProviderLogo } from "./provider-logo";
import { uiText } from "./ui-preferences";

interface MomentStoryCardProps {
  model: MomentStoryCardViewModel;
  fixed?: boolean;
}

function PlayerStoryPanel({
  player,
  locale,
}: {
  player: MomentStoryCardPlayer;
  locale: MomentStoryCardViewModel["locale"];
}) {
  const state = player.allIn
    ? uiText(locale, "全下", "All-in")
    : player.folded
      ? uiText(locale, "弃牌", "Folded")
      : null;
  return (
    <section className="moment-story-player">
      <header>
        <ProviderLogo
          brand={player.providerBrand}
          fallback={player.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
          fallbackStyle={modelTint(player.playerId)}
          className="moment-story-player-logo"
        />
        <div>
          <strong title={player.displayName}>{player.displayName}</strong>
          <span>
            {uiText(locale, "座位", "Seat")} {String(player.seat + 1).padStart(2, "0")}
            {player.position ? ` · ${player.position}` : ""}
          </span>
        </div>
      </header>
      <div className="moment-story-player-hand">
        <div aria-label={`${player.displayName} ${uiText(locale, "手牌", "hole cards")}`}>
          {Array.from({ length: 2 }, (_, index) => (
            <PlayingCard compact card={player.holeCards[index]} key={index} />
          ))}
        </div>
        <strong>{player.equityPercent === null ? "—" : `${Math.round(player.equityPercent)}%`}</strong>
      </div>
      <footer>
        <span>{state ?? uiText(locale, "筹码", "Stack")}</span>
        <b>{player.stack === null ? "—" : formatChips(player.stack)}</b>
      </footer>
    </section>
  );
}

export const MomentStoryCard = forwardRef<HTMLElement, MomentStoryCardProps>(
  function MomentStoryCard({ model, fixed = false }, ref) {
    const { locale } = model;
    const outcome = model.outcome;
    const winnerLine = outcome?.winners.map(({ displayName }) => displayName).join(" / ") ?? null;
    return (
      <article
        ref={ref}
        className={`moment-story-card${fixed ? " is-fixed" : ""}`}
        aria-label={uiText(locale, `${model.handLabel} 分享卡片`, `${model.handLabel} share card`)}
      >
        <header className="moment-story-topline">
          <div className="moment-story-brand">
            <span aria-hidden="true">A♠</span>
            <div>
              <strong>{uiText(locale, "德扑竞技场", "Hold'em Arena")}</strong>
              <small>MODEL POKER · TOURNAMENT MOMENT</small>
            </div>
          </div>
          <div className="moment-story-context">
            <span title={model.tournamentName}>{model.tournamentName}</span>
            <b>{model.handLabel}</b>
            <em>{model.tagLabel}</em>
          </div>
        </header>

        <div className="moment-story-body">
          <section className="moment-story-copy">
            <span className="moment-story-eyebrow">
              {model.spoilerMode === "SUSPENSE"
                ? uiText(locale, "牌局悬念", "THE HAND, UNRESOLVED")
                : uiText(locale, "赛事实录", "TOURNAMENT RECORD")}
            </span>
            <h2>{model.title}</h2>
            {model.summary && <p>{model.summary}</p>}
            <div className="moment-story-board-facts">
              <div>
                <span>{uiText(locale, "阶段", "Street")}</span>
                <b>{model.street ? formatArenaPhase(model.street, locale) : "—"}</b>
              </div>
              <div>
                <span>{uiText(locale, "底池", "Pot")}</span>
                <b>{model.potChips === null ? "—" : formatChips(model.potChips)}</b>
              </div>
              <div>
                <span>BB</span>
                <b>{model.potBigBlinds === null
                  ? "—"
                  : model.potBigBlinds.toFixed(model.potBigBlinds % 1 === 0 ? 0 : 1)}</b>
              </div>
            </div>
          </section>

          <section className="moment-story-table" aria-label={uiText(locale, "牌局画面", "Hand state")}>
            <div className="moment-story-board">
              <span>{uiText(locale, "公共牌", "Board")}</span>
              <div>
                {Array.from({ length: 5 }, (_, index) => (
                  <PlayingCard card={model.board[index]} key={index} />
                ))}
              </div>
            </div>
            <div className="moment-story-players" data-player-count={model.featuredPlayers.length}>
              {model.featuredPlayers.map((player) => (
                <PlayerStoryPanel player={player} locale={locale} key={player.playerId} />
              ))}
              {model.additionalFeaturedCount > 0 && (
                <span className="moment-story-more">
                  +{model.additionalFeaturedCount}
                  <small>{uiText(locale, "位选手", "more")}</small>
                </span>
              )}
            </div>
          </section>
        </div>

        <footer className={`moment-story-result${outcome ? " has-result" : ""}`}>
          {outcome ? (
            <>
              <span>{uiText(locale, "赢家", outcome.winners.length === 1 ? "Winner" : "Winners")}</span>
              <strong title={winnerLine ?? undefined}>{winnerLine ?? "—"}</strong>
              <div>
                {outcome.winners.map(({ playerId }) => {
                  const change = outcome.netChanges[playerId] ?? 0;
                  return <b key={playerId}>{change > 0 ? "+" : ""}{formatChips(change)}</b>;
                })}
              </div>
            </>
          ) : (
            <>
              <span>{uiText(locale, "结果尚未揭晓", "RESULT HIDDEN")}</span>
              <strong>{uiText(locale, "播放这一手，看看谁拿下底池", "Play the hand to reveal the winner")}</strong>
              <b aria-hidden="true">→</b>
            </>
          )}
        </footer>
      </article>
    );
  },
);
