import type { PublicMomentDto } from "../../../packages/contracts/src/moments";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApiResource } from "./api";
import { useBroadcastReplayPlayer } from "./broadcast-replay-player";
import { DecisionBranchDiscovery } from "./decision-branch-discovery";
import {
  ErrorBlock,
  EventTape,
  formatArenaPhase,
  formatChips,
  LoadingBlock,
  modelTint,
  PokerTable,
} from "./components";
import {
  localizedMomentCopy,
  momentOutcomeProjection,
  momentPublicFactsProjection,
  momentPublicPlayerIds,
  momentReplayData,
  momentReplayKey,
  publicMomentTagLabel,
  sortMomentPlayersBySeat,
} from "./moment-presentation";
import { momentBackLink } from "./moments-index-model";
import {
  buildMomentStoryCardModel,
  canonicalMomentUrl,
  momentStoryCardFilename,
} from "./moment-story-card-model";
import { playerProfilePath } from "./player-profile-model";
import { MomentStoryCard } from "./moment-story-card";
import { copyMomentLink, downloadMomentStoryCard } from "./moment-share";
import type { ProviderBrand } from "./provider-brand";
import { ProviderLogo } from "./provider-logo";
import { SelectControl } from "./select-control";
import type { ArenaBroadcast, ArenaEvent, ArenaPlayer, ArenaState } from "./types";
import { useUiPreferences } from "./ui-preferences";

const MOMENT_FRAME_INTERVAL_MS = 1_400;
const MOMENT_SETTLEMENT_HOLD_MS = 2_000;
const MOMENT_REPLAY_RATE_OPTIONS = [0.5, 1, 1.5, 2]
  .map((rate) => ({ value: String(rate), label: `${rate}×` }));

interface PublicMomentReplayResponse {
  moment: PublicMomentDto;
  state: ArenaState;
  timeline: ArenaBroadcast[];
  events: ArenaEvent[];
  playerBrands: Record<string, ProviderBrand | null>;
  playerCompetitorIds: Record<string, string>;
  initialFrame: ArenaBroadcast | null;
  coverFrame: ArenaBroadcast | null;
  initialEliminatedPlayerIds: string[];
}

function MomentPlayerLine({
  playerIds,
  players,
  playerBrands,
  playerCompetitorIds,
  label,
}: {
  playerIds: readonly string[];
  players: readonly ArenaPlayer[];
  playerBrands: Readonly<Record<string, ProviderBrand | null>>;
  playerCompetitorIds?: Readonly<Record<string, string>>;
  label: string;
}) {
  const { text } = useUiPreferences();
  const visiblePlayers = sortMomentPlayersBySeat(playerIds, players);
  if (visiblePlayers.length === 0) return null;
  return (
    <div className="moment-player-line" aria-label={label}>
      {visiblePlayers.map((player) => {
        const content = <>
          <ProviderLogo
            brand={playerBrands[player.id] ?? null}
            fallback={player.displayName.trim().slice(0, 1).toLocaleUpperCase() || "?"}
            fallbackStyle={modelTint(player.id)}
            className="moment-player-logo"
          />
          <b title={player.displayName}>{player.displayName}</b>
        </>;
        const competitorId = playerCompetitorIds?.[player.id];
        return competitorId
          ? <Link key={player.id} to={playerProfilePath(competitorId)} aria-label={text(`查看 ${player.displayName} 的选手档案`, `View ${player.displayName} player profile`)}>{content}</Link>
          : <span key={player.id}>{content}</span>;
      })}
    </div>
  );
}

function NeutralMomentStage({ handNo, waiting }: { handNo: number; waiting: boolean }) {
  const { text } = useUiPreferences();
  return (
    <section className="table-broadcast moment-neutral-stage" aria-label={text("回放等待画面", "Replay waiting screen")}>
      <span className="moment-neutral-mark" aria-hidden="true">A♠</span>
      <b>H{String(handNo).padStart(3, "0")}</b>
      <h2>{waiting ? text("正在对齐回放画面", "Aligning replay frame") : text("静态封面暂不可用", "Static cover unavailable")}</h2>
      <p>{waiting ? text("首个可公开画面到达后会继续播放。", "Playback will continue at the first public frame.") : text("仍可播放这一手的公开事件。", "The public hand replay is still available.")}</p>
    </section>
  );
}

export function MomentPage() {
  const { locale, text } = useUiPreferences();
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const normalizedSlug = slug.trim().toLocaleLowerCase("en-US");
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [exportState, setExportState] = useState<"idle" | "exporting" | "exported" | "error">("idle");
  const copyTimerRef = useRef<number | null>(null);
  const exportTimerRef = useRef<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const exportCardRef = useRef<HTMLElement>(null);
  const resource = useApiResource<PublicMomentReplayResponse>(
    normalizedSlug ? `/api/public/moments/${encodeURIComponent(normalizedSlug)}/replay` : null,
  );
  const response = resource.data?.moment.slug.toLocaleLowerCase("en-US") === normalizedSlug
    ? resource.data
    : null;
  const replayIdentity = response ? momentReplayKey(response.moment) : null;
  const replayData = useMemo(() => response ? momentReplayData({
    moment: response.moment,
    timeline: response.timeline,
    events: response.events,
    initialFrame: response.initialFrame,
    initialEliminatedPlayerIds: response.initialEliminatedPlayerIds,
  }) : null, [response]);
  const replayPlayer = useBroadcastReplayPlayer({
    replayKey: replayIdentity,
    dataKey: replayIdentity,
    requested: playbackRequested,
    data: replayData,
    frameIntervalMs: MOMENT_FRAME_INTERVAL_MS,
    settlementHoldMs: MOMENT_SETTLEMENT_HOLD_MS,
  });

  useLayoutEffect(() => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    setPlaybackRequested(false);
    setCopyState("idle");
    setExportState("idle");
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [slug]);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
  }, []);

  const copy = useMemo(
    () => response ? localizedMomentCopy(response.moment, locale) : null,
    [locale, response],
  );
  const storyCard = useMemo(
    () => response ? buildMomentStoryCardModel({
      moment: response.moment,
      state: response.state,
      coverFrame: response.coverFrame,
      playerBrands: response.playerBrands,
      locale,
    }) : null,
    [locale, response],
  );
  useLayoutEffect(() => {
    if (!response) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [response]);
  useEffect(() => {
    if (!response || slug === response.moment.slug) return;
    navigate(`/moments/${response.moment.slug}`, { replace: true, state: location.state });
  }, [location.state, navigate, response, slug]);
  useEffect(() => {
    if (!copy) return;
    const previousTitle = document.title;
    document.title = `${copy.title} · ${text("德扑竞技场", "Hold'em Arena")}`;
    return () => { document.title = previousTitle; };
  }, [copy, text]);

  if (resource.loading || (slug && !response && !resource.error)) {
    return <main className="page-shell moment-page"><LoadingBlock label={text("正在载入精彩瞬间", "Loading highlight")} /></main>;
  }
  if (resource.error || !response || !copy || !storyCard) {
    return (
      <main className="page-shell moment-page">
        <nav className="analysis-back-nav" aria-label={text("精彩瞬间导航", "Highlight navigation")}>
          <Link className="analysis-back-link" to="/moments"><span aria-hidden="true">←</span>{text("返回精彩瞬间", "Back to highlights")}</Link>
        </nav>
        <ErrorBlock message={text("无法找到或载入这个精彩瞬间。", "This highlight could not be found or loaded.")} onRetry={() => void resource.refresh()} />
      </main>
    );
  }

  const { moment, state, playerBrands } = response;
  const backLink = momentBackLink(location.state, moment);
  const replayEnded = replayPlayer.status === "ended";
  const outcome = momentOutcomeProjection(moment, state.players, replayEnded);
  const displayFrame = replayPlayer.active ? replayPlayer.frame : response.coverFrame;
  const publicFacts = momentPublicFactsProjection(moment, displayFrame, replayEnded);
  const waitingForFrame = replayPlayer.active && !replayEnded && replayPlayer.frame === null;
  const displayedEvents = replayPlayer.active ? replayPlayer.visibleEvents : [];
  const idleEliminatedPlayerIds = new Set(response.initialEliminatedPlayerIds);
  const displayedEliminatedPlayerIds = replayPlayer.active
    ? replayPlayer.eliminatedPlayerIds
    : idleEliminatedPlayerIds;
  const displayedStreet = displayFrame?.street ?? null;
  const startReplay = () => {
    setPlaybackRequested(true);
    replayPlayer.start();
  };
  const copyCanonicalLink = async () => {
    setCopyState("copying");
    try {
      await copyMomentLink(canonicalMomentUrl(window.location.origin, moment.slug, locale));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  };
  const downloadStoryCard = async () => {
    const node = exportCardRef.current;
    if (!node) {
      setExportState("error");
      return;
    }
    setExportState("exporting");
    try {
      await downloadMomentStoryCard(node, momentStoryCardFilename(moment));
      setExportState("exported");
    } catch {
      setExportState("error");
    }
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    exportTimerRef.current = window.setTimeout(() => setExportState("idle"), 2_200);
  };
  const shareStatus = copyState === "copied"
    ? text("链接已复制", "Link copied")
    : copyState === "error"
      ? text("无法访问剪贴板", "Clipboard unavailable")
      : exportState === "exported"
        ? text("图片已下载", "Image downloaded")
        : exportState === "error"
          ? text("图片生成失败，请重试", "Image export failed. Try again.")
          : "";

  return (
    <main className="page-shell moment-page">
      <nav className="analysis-back-nav" aria-label={text("精彩瞬间导航", "Highlight navigation")}>
        <Link className="analysis-back-link" to={backLink.to}>
          <span aria-hidden="true">←</span>{backLink.kind === "TOURNAMENT_HAND"
            ? text(`返回第 ${String(moment.handNo).padStart(3, "0")} 手牌解析`, `Back to hand ${String(moment.handNo).padStart(3, "0")}`)
            : text("返回精彩瞬间", "Back to highlights")}
        </Link>
      </nav>

      <header className="moment-hero">
        <div className="moment-hero-copy">
          <div className="moment-hero-kicker">
            <span>H{String(moment.handNo).padStart(3, "0")}</span>
            <b>{publicMomentTagLabel(moment, locale, replayEnded)}</b>
            {moment.isPrimary && <em>{text("精选", "Featured")}</em>}
          </div>
          <h1 ref={headingRef} tabIndex={-1}>{copy.title}</h1>
          {copy.summary && <p>{copy.summary}</p>}
          <MomentPlayerLine
            playerIds={momentPublicPlayerIds(moment, replayEnded)}
            players={state.players}
            playerBrands={playerBrands}
            playerCompetitorIds={response.playerCompetitorIds}
            label={text("本手选手", "Players in this hand")}
          />
        </div>
        <div className="moment-hero-actions">
          <dl>
            <div><dt>{text("底池", "Pot")}</dt><dd>{publicFacts.potChips === null ? "—" : formatChips(publicFacts.potChips)}</dd></div>
            <div><dt>BB</dt><dd>{publicFacts.potBigBlinds === null ? "—" : publicFacts.potBigBlinds.toFixed(publicFacts.potBigBlinds % 1 === 0 ? 0 : 1)}</dd></div>
          </dl>
          <div className="moment-share-buttons">
            <button type="button" className="moment-copy-button" disabled={copyState === "copying"} onClick={() => void copyCanonicalLink()}>
              {copyState === "copying" ? text("复制中…", "Copying…") : copyState === "copied" ? text("已复制", "Copied") : copyState === "error" ? text("复制失败", "Copy failed") : text("复制链接", "Copy link")}
            </button>
            <button type="button" className="moment-copy-button is-secondary" disabled={exportState === "exporting"} onClick={() => void downloadStoryCard()}>
              {exportState === "exporting" ? text("生成中…", "Exporting…") : exportState === "exported" ? text("已下载", "Downloaded") : exportState === "error" ? text("重试下载", "Try again") : text("下载 PNG", "Download PNG")}
            </button>
          </div>
          <span className="moment-copy-status" aria-live="polite">{shareStatus}</span>
        </div>
      </header>

      <section className="moment-story-preview" aria-labelledby="moment-story-preview-heading">
        <header>
          <h2 id="moment-story-preview-heading">{text("分享卡片", "Share card")}</h2>
          <span>PNG · 1200 × 675</span>
        </header>
        <MomentStoryCard model={storyCard} />
      </section>

      {outcome && (
        <section className="moment-outcome" aria-label={text("本手结果", "Hand result")}>
          <span>{text("赢家", outcome.winners.length === 1 ? "Winner" : "Winners")}</span>
          <MomentPlayerLine
            playerIds={outcome.winnerPlayerIds}
            players={state.players}
            playerBrands={playerBrands}
            playerCompetitorIds={response.playerCompetitorIds}
            label={text("获胜选手", "Winning players")}
          />
          <div>
            {outcome.winners.map((winner) => {
              const change = outcome.netChanges[winner.id] ?? 0;
              return <b key={winner.id}>{change > 0 ? "+" : ""}{formatChips(change)}</b>;
            })}
          </div>
        </section>
      )}

      <div className="live-layout moment-stage">
        {waitingForFrame || displayFrame === null
          ? <NeutralMomentStage handNo={moment.handNo} waiting={waitingForFrame} />
          : <PokerTable
              state={state}
              broadcast={displayFrame}
              playerBrands={playerBrands}
              historical
              eliminatedPlayerIds={displayedEliminatedPlayerIds}
              settlement={replayPlayer.settlement}
            />}
        <aside className="broadcast-sidebar moment-replay-sidebar">
          <div className="panel-heading moment-replay-heading">
            <div><h2>{text("片段回放", "Replay")}</h2></div>
            <div className="moment-replay-controls">
              <SelectControl
                className="watch-room-speed-select"
                menuClassName="watch-room-speed-menu"
                value={String(replayPlayer.rate)}
                options={MOMENT_REPLAY_RATE_OPTIONS}
                onChange={(value) => replayPlayer.setRate(Number(value))}
                ariaLabel={text("回放速度", "Playback speed")}
              />
              {replayPlayer.status === "playing"
                ? <button type="button" onClick={replayPlayer.pause}>{text("暂停", "Pause")}</button>
                : replayPlayer.status === "paused"
                  ? <button type="button" onClick={replayPlayer.resume}>{text("继续", "Resume")}</button>
                  : replayPlayer.status === "loading"
                    ? <button type="button" disabled>{text("加载…", "Loading…")}</button>
                    : <button type="button" onClick={startReplay}>{replayEnded ? text("重播", "Replay") : text("播放", "Play")}</button>}
            </div>
          </div>
          {replayPlayer.active && (
            <div className="watch-room-replay-progress">
              <progress
                max={Math.max(1, replayPlayer.steps.length)}
                value={replayPlayer.progress}
                aria-label={text("片段回放进度", "Highlight replay progress")}
              />
              <span><b>H{String(moment.handNo).padStart(3, "0")}</b>{replayPlayer.progress} / {replayPlayer.steps.length}</span>
            </div>
          )}
          <EventTape
            events={displayedEvents}
            players={state.players}
            limit={24}
            emptyLabel={replayPlayer.status === "loading"
              ? text("正在准备这一手。", "Preparing this hand.")
              : text("点击“播放”观看这一手。", "Select Play to watch this hand.")}
          />
          <div className="broadcast-facts">
            <div><span>{text("阶段", "Stage")}</span><b>{displayedStreet === null ? "—" : formatArenaPhase(displayedStreet, locale)}</b></div>
            <div><span>{text("底池", "Pot")}</span><b>{publicFacts.potChips === null ? "—" : formatChips(publicFacts.potChips)}</b></div>
            <div><span>{text("手牌", "Hand")}</span><b>H{String(moment.handNo).padStart(3, "0")}</b></div>
          </div>
        </aside>
      </div>

      <DecisionBranchDiscovery
        apiPath={`/api/public/tournaments/${encodeURIComponent(moment.tournamentId)}/decision-branches?handNo=${moment.handNo}&limit=4`}
        title={text("这一手的决策分叉", "Decision branches from this hand")}
      />

      <footer className="moment-footer-link">
        <span>{text("完整行动链、筹码走势与模型决策", "Full action chain, stack history, and model decisions")}</span>
        <Link to={`/tournaments/${moment.tournamentId}/replay/${moment.handNo}`}>{text("查看赛事解析", "View match analysis")} →</Link>
      </footer>
      <div className="moment-story-export-host" aria-hidden="true">
        <MomentStoryCard ref={exportCardRef} model={storyCard} fixed />
      </div>
    </main>
  );
}
