import type { PublicMomentDto } from "../../../packages/contracts/src/moments";
import { Link } from "react-router-dom";
import { useApiResource } from "./api";
import {
  formatChips,
  modelTint,
  PlayingCard,
} from "./components";
import {
  localizedMomentCopy,
  momentOutcomeProjection,
  momentPublicPlayerIds,
  momentPublicFactsProjection,
  publicMomentTagLabel,
  sortMomentPlayersBySeat,
} from "./moment-presentation";
import { tournamentMomentSourceState } from "./moments-index-model";
import { playerProfilePath } from "./player-profile-model";
import type { ProviderBrand } from "./provider-brand";
import { ProviderLogo } from "./provider-logo";
import type { ArenaPlayer } from "./types";
import { useUiPreferences } from "./ui-preferences";

interface TournamentMomentsProps {
  tournamentId: string;
  players: readonly ArenaPlayer[];
  playerBrands?: Readonly<Record<string, ProviderBrand | null>>;
  playerCompetitorIds?: Readonly<Record<string, string>>;
}

export interface MomentCardPlayer {
  id: string;
  displayName: string;
  seat: number;
  providerBrand?: ProviderBrand | null;
  competitorId?: string | null;
}

interface MomentCardTournament {
  id: string;
  name: string;
}

function MomentPlayers({
  moment,
  players,
  playerBrands,
  playerCompetitorIds,
}: {
  moment: PublicMomentDto;
  players: readonly MomentCardPlayer[];
  playerBrands: Readonly<Record<string, ProviderBrand | null>>;
  playerCompetitorIds: Readonly<Record<string, string>>;
}) {
  const { text } = useUiPreferences();
  const featured = sortMomentPlayersBySeat(momentPublicPlayerIds(moment, false), players);
  if (featured.length === 0) return null;
  return (
    <div className="moment-card-players" aria-label={text("本手选手", "Players in this hand")}>
      {featured.map((player) => {
        const content = <>
          <ProviderLogo
            brand={player.providerBrand ?? playerBrands[player.id] ?? null}
            fallback={player.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
            fallbackStyle={modelTint(player.id)}
            className="moment-player-logo"
          />
          <b title={player.displayName}>{player.displayName}</b>
        </>;
        const competitorId = player.competitorId ?? playerCompetitorIds[player.id];
        return competitorId
          ? <Link className="moment-card-player-link" key={player.id} to={playerProfilePath(competitorId)} aria-label={text(`查看 ${player.displayName} 的选手档案`, `View ${player.displayName} player profile`)}>{content}</Link>
          : <span key={player.id}>{content}</span>;
      })}
    </div>
  );
}

export function TournamentMomentCard({
  moment,
  lead,
  players,
  playerBrands = {},
  playerCompetitorIds = {},
  tournament = null,
  returnToTournament = false,
}: {
  moment: PublicMomentDto;
  lead: boolean;
  players: readonly MomentCardPlayer[];
  playerBrands?: Readonly<Record<string, ProviderBrand | null>>;
  playerCompetitorIds?: Readonly<Record<string, string>>;
  tournament?: MomentCardTournament | null;
  returnToTournament?: boolean;
}) {
  const { locale, text } = useUiPreferences();
  const copy = localizedMomentCopy(moment, locale);
  const outcome = momentOutcomeProjection(moment, players, false);
  const publicFacts = momentPublicFactsProjection(moment, null, false);
  const winnerNames = outcome?.winners.map((player) => player.displayName).join(" / ") ?? null;
  const handLabel = `H${String(moment.handNo).padStart(3, "0")}`;
  const detailState = returnToTournament
    ? tournamentMomentSourceState(moment.tournamentId, moment.handNo)
    : undefined;
  return (
    <article
      className={`tournament-moment-card${lead ? " is-lead" : ""}`}
    >
      <Link
        className="moment-card-primary-link"
        to={`/moments/${moment.slug}`}
        state={detailState}
        aria-label={`${copy.title} · ${text("查看精彩瞬间", "View highlight")}`}
      />
      <div className="moment-card-meta">
        <span>{handLabel}</span>
        <b>{publicMomentTagLabel(moment, locale, false)}</b>
        {moment.isPrimary && <em>{text("精选", "Featured")}</em>}
        {tournament && (
          <Link
            className="moment-card-source"
            to={`/tournaments/${tournament.id}/replay/${moment.handNo}`}
            title={tournament.name}
          >
            {tournament.name}
          </Link>
        )}
      </div>
      <div className="moment-card-copy">
        <h3>{copy.title}</h3>
        {copy.summary && <p>{copy.summary}</p>}
      </div>
      <MomentPlayers
        moment={moment}
        players={players}
        playerBrands={playerBrands}
        playerCompetitorIds={playerCompetitorIds}
      />
      <div className="moment-card-board" aria-label={text("公共牌", "Board")}>
        {Array.from({ length: 5 }, (_, index) => (
          <PlayingCard compact card={publicFacts.board?.[index]} key={index} />
        ))}
      </div>
      {publicFacts.potChips !== null || winnerNames ? (
        <dl className="moment-card-facts">
          {publicFacts.potChips !== null && <div><dt>{text("底池", "Pot")}</dt><dd>{formatChips(publicFacts.potChips)}</dd></div>}
          {publicFacts.potBigBlinds !== null && <div><dt>BB</dt><dd>{publicFacts.potBigBlinds.toFixed(publicFacts.potBigBlinds % 1 === 0 ? 0 : 1)}</dd></div>}
          {winnerNames && <div className="moment-card-result"><dt>{text("赢家", "Winner")}</dt><dd>{winnerNames}</dd></div>}
        </dl>
      ) : <span className="moment-card-suspense">{text("播放揭晓", "Play to reveal")}</span>}
      <span className="moment-card-arrow" aria-hidden="true">↗</span>
    </article>
  );
}

export function TournamentMoments({
  tournamentId,
  players,
  playerBrands = {},
  playerCompetitorIds = {},
}: TournamentMomentsProps) {
  const { text } = useUiPreferences();
  const { data, loading, error } = useApiResource<{ moments: PublicMomentDto[] }>(
    tournamentId ? `/api/public/tournaments/${tournamentId}/moments` : null,
  );
  const moments = data?.moments ?? [];
  if (loading || error || moments.length === 0) return null;

  return (
    <section className="tournament-moments" id="highlights" aria-labelledby="tournament-moments-heading">
      <header className="tournament-moments-heading">
        <h2 id="tournament-moments-heading">{text("精彩瞬间", "Highlights")}</h2>
        <span><b>{moments.length}</b> {text("手", moments.length === 1 ? "hand" : "hands")}</span>
      </header>
      <div className="tournament-moment-grid">
        {moments.map((moment, index) => (
          <TournamentMomentCard
            moment={moment}
            lead={index === 0}
            players={players}
            playerBrands={playerBrands}
            playerCompetitorIds={playerCompetitorIds}
            returnToTournament
            key={moment.id}
          />
        ))}
      </div>
    </section>
  );
}
