import { forwardRef } from "react";
import type { PublicCompetitorProfile } from "../../../packages/contracts/src/competitors";
import { modelTint } from "./components";
import { formatProfilePercent, profileStyleLabel } from "./player-profile-model";
import { ProviderLogo } from "./provider-logo";
import type { UiLocale } from "./ui-preferences";
import { uiText } from "./ui-preferences";

interface PlayerStoryCardProps {
  profile: PublicCompetitorProfile;
  locale: UiLocale;
  fixed?: boolean;
}

export const PlayerStoryCard = forwardRef<HTMLElement, PlayerStoryCardProps>(
  function PlayerStoryCard({ profile, locale, fixed = false }, ref) {
    const { competitor, competition, style, reliability, career, recentResults } = profile;
    const form = recentResults.slice(0, 5);
    const rankingScope = competition.rank === null
      ? uiText(locale, "未上榜", "Unranked")
      : profile.competitiveScope.benchmarkCohortId ?? uiText(locale, "评级组", "Rated cohort");
    return (
      <article
        ref={ref}
        className={`player-story-card${fixed ? " is-fixed" : ""}`}
        aria-label={uiText(locale, `${competitor.displayName} 选手卡片`, `${competitor.displayName} player card`)}
      >
        <header className="player-story-topline">
          <div className="player-story-brand">
            <span aria-hidden="true">A♠</span>
            <div>
              <strong>{uiText(locale, "德扑竞技场", "Hold'em Arena")}</strong>
              <small>{uiText(locale, "模型德扑 · 选手档案", "MODEL POKER · PLAYER DOSSIER")}</small>
            </div>
          </div>
          <div className="player-story-scope">
            <span>{rankingScope}</span>
            {competition.sampleWarning && <em>{uiText(locale, "样本有限", "LIMITED SAMPLE")}</em>}
            <b>{competitor.status === "ACTIVE" ? uiText(locale, "现役", "ACTIVE") : uiText(locale, "退役", "RETIRED")}</b>
          </div>
        </header>

        <div className="player-story-body">
          <section className="player-story-identity">
            <ProviderLogo
              brand={competitor.providerBrand}
              fallback={competitor.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
              fallbackStyle={modelTint(competitor.id)}
              className="player-story-logo"
            />
            <div className="player-story-name">
              <span>{uiText(locale, "竞技选手", "ARENA COMPETITOR")}</span>
              <h2>{competitor.displayName}</h2>
              <p>
                {competitor.currentRevision?.modelId ?? uiText(locale, "暂无当前版本", "No current revision")}
                {competitor.currentRevision ? ` · R${competitor.currentRevision.revisionNumber}` : ""}
              </p>
            </div>
            <div className="player-story-ranking">
              <div><span>{uiText(locale, "排名", "Rank")}</span><strong>{competition.rank === null ? "—" : `#${String(competition.rank).padStart(2, "0")}`}</strong></div>
              <div><span>Rating</span><strong>{competition.rating ?? "—"}</strong></div>
            </div>
          </section>

          <section className="player-story-record">
            <div className="player-story-record-grid">
              <div><span>{uiText(locale, "评级赛事", "Rated")}</span><strong>{competition.tournaments}</strong></div>
              <div><span>{uiText(locale, "冠军", "Titles")}</span><strong>{competition.championships}</strong></div>
              <div><span>{uiText(locale, "前三率", "Top 3")}</span><strong>{formatProfilePercent(competition.topThreeRate, locale)}</strong></div>
              <div><span>{uiText(locale, "有效决策", "Valid")}</span><strong>{formatProfilePercent(reliability.validDecisionRate, locale)}</strong></div>
            </div>
            <div className="player-story-style">
              <header><span>{uiText(locale, "牌风", "Playing style")}</span><strong>{profileStyleLabel(style.profile, locale)}</strong></header>
              <dl>
                <div><dt>VPIP</dt><dd>{formatProfilePercent(style.vpipRate, locale)}</dd></div>
                <div><dt>PFR</dt><dd>{formatProfilePercent(style.pfrRate, locale)}</dd></div>
                <div><dt>3-BET</dt><dd>{formatProfilePercent(style.threeBetRate, locale)}</dd></div>
              </dl>
            </div>
          </section>
        </div>

        <footer className="player-story-footer">
          <div className="player-story-career">
            <span>{uiText(locale, "生涯", "Career")}</span>
            <strong>{career.appearances} {uiText(locale, "场", career.appearances === 1 ? "event" : "events")}</strong>
            <b>{career.handsPlayed.toLocaleString(locale)} {uiText(locale, "手", "hands")}</b>
          </div>
          <div className="player-story-form" aria-label={uiText(locale, "近期战绩", "Recent form")}>
            <span>{uiText(locale, "近期", "Recent")}</span>
            <div>
              {form.length === 0 ? <em>—</em> : form.map((result) => (
                <i className={result.finishingPosition === 1 ? "is-win" : ""} key={result.tournamentId}>
                  <b>#{result.finishingPosition}</b>
                  <small>{result.netBigBlinds > 0 ? "+" : ""}{result.netBigBlinds.toFixed(1)} BB</small>
                </i>
              ))}
            </div>
          </div>
        </footer>
      </article>
    );
  },
);
