import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  AdminMomentRecord,
  MomentTag,
} from "../../../packages/contracts/src/moments";
import { ApiError, apiRequest, useApiResource } from "./api";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Modal,
  formatChips,
} from "./components";
import {
  canHideMoment,
  canPublishMoment,
  momentEditorDraft,
  momentMutationBody,
  momentRevisionChanged,
  type MomentDraftIssue,
  type MomentEditorDraft,
  type MomentMutationIntent,
  validateMomentDraft,
} from "./moment-admin-model";
import { SelectControl } from "./select-control";
import type { TournamentSummary } from "./types";
import { type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

interface EditorState {
  record: AdminMomentRecord;
  draft: MomentEditorDraft;
  intent: MomentMutationIntent;
  issues: MomentDraftIssue[];
  error: string | null;
  conflictRecord: AdminMomentRecord | null;
  conflictMissing: boolean;
}

const momentTagText: Record<MomentTag, readonly [string, string]> = {
  FINAL_HAND: ["决胜手", "Final hand"],
  ELIMINATION: ["淘汰", "Elimination"],
  MULTI_ELIMINATION: ["多人淘汰", "Multi-elimination"],
  HEADS_UP_REACHED: ["进入单挑", "Heads-up reached"],
  ALL_IN: ["全下", "All-in"],
  MULTIWAY_ALL_IN: ["多人全下", "Multiway all-in"],
  LARGE_POT: ["大底池", "Large pot"],
  LEAD_CHANGE: ["领先易主", "Lead change"],
  SHORT_STACK_DOUBLE: ["短码翻倍", "Short-stack double"],
  FOUR_BET_PLUS: ["四次加注+", "Four-bet+"],
  OVERBET: ["超池下注", "Overbet"],
  SIDE_POT: ["边池", "Side pot"],
  SPLIT_POT: ["平分底池", "Split pot"],
  MULTIWAY_SHOWDOWN: ["多人摊牌", "Multiway showdown"],
  EQUITY_REVERSAL: ["胜率反转", "Equity reversal"],
  ALL_IN_UNDERDOG_WIN: ["逆袭赢牌", "Underdog win"],
  RARE_MADE_HAND: ["稀有成牌", "Rare made hand"],
  LONG_TANK: ["长考", "Long tank"],
};

function tagLabel(tag: MomentTag, locale: UiLocale): string {
  const labels = momentTagText[tag];
  return uiText(locale, labels[0], labels[1]);
}

function publicationLabel(record: AdminMomentRecord, locale: UiLocale): string {
  if (!record.publication) return uiText(locale, "候选", "Candidate");
  if (record.publication.status === "PUBLISHED") return uiText(locale, "已发布", "Published");
  if (record.publication.status === "HIDDEN") return uiText(locale, "已隐藏", "Hidden");
  return uiText(locale, "草稿", "Draft");
}

function issueLabel(issue: MomentDraftIssue, locale: UiLocale): string {
  const labels: Record<MomentDraftIssue, readonly [string, string]> = {
    SLUG_REQUIRED: ["发布前需要填写分享链接", "A share URL is required before publishing"],
    TITLE_REQUIRED: ["发布前至少填写一个语言的标题", "Add a title in at least one language before publishing"],
    SEQUENCE_REQUIRED: ["发布前需要填写封面与播放区间", "Cover and playback sequences are required before publishing"],
    SEQUENCE_INVALID: ["事件序号必须是正整数", "Event sequences must be positive integers"],
    SEQUENCE_OUTSIDE_WINDOW: ["事件序号必须位于该候选的权威区间内", "Event sequences must stay inside the authoritative moment window"],
    PLAYBACK_ORDER_INVALID: ["播放起点不能晚于终点", "Playback start cannot follow its end"],
  };
  return uiText(locale, labels[issue][0], labels[issue][1]);
}

function mutationError(reason: unknown, locale: UiLocale): string {
  if (!(reason instanceof ApiError)) {
    return reason instanceof Error
      ? reason.message
      : uiText(locale, "操作失败，请重试", "The operation failed. Try again.");
  }
  if (reason.code === "moment_slug_conflict") {
    return uiText(locale, "这个分享链接已经被使用，请换一个", "This share URL is already in use");
  }
  if (reason.code === "tournament_not_completed") {
    return uiText(locale, "赛事尚未结束，暂时不能检测精彩瞬间", "Moments can be detected only after the tournament is complete");
  }
  return locale === "zh-CN"
    ? uiText(locale, "操作未能完成，请重新读取后再试", "The operation could not be completed")
    : reason.message;
}

function createEditor(record: AdminMomentRecord, intent: MomentMutationIntent): EditorState {
  return {
    record,
    draft: momentEditorDraft(record),
    intent,
    issues: [],
    error: null,
    conflictRecord: null,
    conflictMissing: false,
  };
}

export function MomentAdminPage({ csrfToken }: { csrfToken: string }) {
  const { locale, text } = useUiPreferences();
  const [searchParams, setSearchParams] = useSearchParams();
  const tournaments = useApiResource<{ tournaments: TournamentSummary[] }>("/api/public/tournaments");
  const completed = (tournaments.data?.tournaments ?? [])
    .filter((tournament) => tournament.status === "COMPLETED");
  const requestedTournamentId = searchParams.get("tournament");
  const selectedTournament = completed.find((tournament) => tournament.id === requestedTournamentId)
    ?? completed[0]
    ?? null;
  const momentsUrl = selectedTournament
    ? `/api/admin/tournaments/${selectedTournament.id}/moments`
    : null;
  const moments = useApiResource<{ moments: AdminMomentRecord[] }>(momentsUrl);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    if (!selectedTournament || requestedTournamentId === selectedTournament.id) return;
    setSearchParams({ tournament: selectedTournament.id }, { replace: true });
  }, [requestedTournamentId, selectedTournament, setSearchParams]);

  const records = moments.data?.moments ?? [];
  const playerNames = new Map(selectedTournament?.publicState.players.map((player) => [player.id, player.displayName]) ?? []);

  const selectTournament = (tournamentId: string) => {
    setNotice(null);
    setPageError(null);
    setEditor(null);
    setSearchParams({ tournament: tournamentId });
  };

  const generate = async () => {
    if (!selectedTournament) return;
    setBusyAction("generate");
    setPageError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ generatedCount: number }>(
        `/api/admin/tournaments/${selectedTournament.id}/moments/generate`,
        { method: "POST", csrfToken, body: JSON.stringify({}) },
      );
      await moments.refresh();
      setNotice(text(
        `检测完成，共生成 ${result.generatedCount} 个候选`,
        `Detection complete · ${result.generatedCount} candidates`,
      ));
    } catch (reason) {
      setPageError(mutationError(reason, locale));
    } finally {
      setBusyAction(null);
    }
  };

  const refreshAfterConflict = async (current: EditorState, reason: ApiError) => {
    if (!selectedTournament || !momentsUrl) return;
    try {
      const latestPayload = await apiRequest<{ moments: AdminMomentRecord[] }>(momentsUrl);
      moments.setData(latestPayload);
      const latest = latestPayload.moments.find((record) => record.facts.id === current.record.facts.id) ?? null;
      const changed = latest && (
        momentRevisionChanged(current.record, latest)
        || current.record.supersededAt !== latest.supersededAt
      );
      if (!latest || changed) {
        setEditor({
          ...current,
          conflictRecord: latest,
          conflictMissing: !latest,
          error: null,
        });
        return;
      }
      setEditor({ ...current, error: mutationError(reason, locale) });
    } catch (refreshReason) {
      setEditor({ ...current, error: mutationError(refreshReason, locale) });
    }
  };

  const mutateEditor = async (intent: MomentMutationIntent) => {
    if (!editor) return;
    const current = editor;
    const issues = validateMomentDraft(current.record, current.draft, intent);
    if (issues.length > 0) {
      setEditor({ ...current, issues, error: null });
      return;
    }
    const action = intent === "PUBLISH" ? "publish" : "save";
    setBusyAction(`${action}:${current.record.facts.id}`);
    setEditor({ ...current, issues: [], error: null });
    try {
      await apiRequest(
        intent === "PUBLISH"
          ? `/api/admin/moments/${current.record.facts.id}/publish`
          : `/api/admin/moments/${current.record.facts.id}`,
        {
          method: intent === "PUBLISH" ? "POST" : "PATCH",
          csrfToken,
          body: JSON.stringify(momentMutationBody(current.record, current.draft, intent)),
        },
      );
      setEditor(null);
      await moments.refresh();
      setNotice(intent === "PUBLISH"
        ? text("精彩瞬间已发布", "Moment published")
        : text("编辑内容已保存", "Moment changes saved"));
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "moment_publication_conflict") {
        await refreshAfterConflict(current, reason);
      } else {
        setEditor({ ...current, error: mutationError(reason, locale) });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const hide = async (record: AdminMomentRecord) => {
    const publication = record.publication;
    if (!publication) return;
    setBusyAction(`hide:${record.facts.id}`);
    setPageError(null);
    setNotice(null);
    try {
      await apiRequest(`/api/admin/moments/${record.facts.id}/hide`, {
        method: "POST",
        csrfToken,
        body: JSON.stringify({ expectedRevision: publication.revision }),
      });
      await moments.refresh();
      setNotice(text("精彩瞬间已隐藏", "Moment hidden"));
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "moment_publication_conflict") {
        const current = createEditor(record, "SAVE");
        setEditor(current);
        await refreshAfterConflict(current, reason);
      } else {
        setPageError(mutationError(reason, locale));
      }
    } finally {
      setBusyAction(null);
    }
  };

  if (tournaments.loading) return <LoadingBlock label={text("正在读取已完成赛事", "Loading completed tournaments")} />;
  if (tournaments.error) return <ErrorBlock message={tournaments.error} onRetry={() => void tournaments.refresh()} />;

  return (
    <div className="moment-admin-page">
      <div className="admin-heading">
        <div><h1>{text("精彩瞬间", "Moments")}</h1></div>
        {selectedTournament && (
          <Link className="text-button" to={`/tournaments/${selectedTournament.id}/replay`}>
            {text("查看赛事解析", "View match analysis")} ↗
          </Link>
        )}
      </div>

      {completed.length === 0 ? (
        <EmptyState
          title={text("还没有可检测的赛事", "No tournaments ready for detection")}
          body={text("完成一场锦标赛后，即可从完整事件流中检测和发布精彩瞬间。", "Complete a tournament to detect and publish moments from its event history.")}
          action={<Link className="button primary" to="/admin/tournaments/new">{text("创建赛事", "Create tournament")}</Link>}
        />
      ) : (
        <>
          <section className="admin-section moment-toolbar" aria-label={text("精彩瞬间赛事选择", "Moment tournament selection")}>
            <label>
              <span>{text("选择赛事", "Tournament")}</span>
              <SelectControl
                value={selectedTournament?.id ?? ""}
                onChange={selectTournament}
                ariaLabel={text("切换精彩瞬间赛事", "Switch moment tournament")}
                options={completed.map((tournament) => ({
                  value: tournament.id,
                  label: `${tournament.name} · ${new Date(tournament.createdAt).toLocaleDateString(locale)}`,
                }))}
              />
            </label>
            <div className="moment-toolbar-summary">
              <span>{text("候选", "Candidates")}</span>
              <strong>{moments.loading ? "—" : records.length}</strong>
            </div>
            <button
              className="button primary"
              type="button"
              disabled={busyAction !== null || moments.loading}
              onClick={() => void generate()}
            >
              {busyAction === "generate"
                ? text("正在检测…", "Detecting…")
                : records.length > 0
                  ? text("重新检测", "Detect again")
                  : text("检测精彩瞬间", "Detect moments")}
            </button>
          </section>

          {notice && <div className="notice success" role="status">{notice}<button aria-label={text("关闭通知", "Dismiss notification")} onClick={() => setNotice(null)}>×</button></div>}
          {pageError && <div className="notice error" role="alert">{pageError}<button aria-label={text("关闭错误提示", "Dismiss error")} onClick={() => setPageError(null)}>×</button></div>}

          {moments.loading ? <LoadingBlock label={text("正在读取精彩瞬间", "Loading moments")} />
            : moments.error ? <ErrorBlock message={moments.error} onRetry={() => void moments.refresh()} />
              : records.length === 0 ? (
                <EmptyState
                  title={text("尚未检测候选", "No candidates detected")}
                  body={text("点击“检测精彩瞬间”，系统会从赛事事件流中给出候选；不会自动公开。", "Run detection to derive candidates from the event stream. Nothing is published automatically.")}
                />
              ) : (
                <section className="moment-grid" aria-label={text("精彩瞬间候选", "Moment candidates")}>
                  {records.map((record) => {
                    const { facts, publication } = record;
                    const title = locale === "zh-CN"
                      ? publication?.titleZh ?? publication?.titleEn
                      : publication?.titleEn ?? publication?.titleZh;
                    const participantNames = facts.participantPlayerIds
                      .map((playerId) => playerNames.get(playerId) ?? playerId)
                      .join(" · ");
                    const publishable = canPublishMoment(record);
                    const busy = busyAction?.endsWith(facts.id) ?? false;
                    return (
                      <article className={`moment-card moment-status-${publication?.status?.toLowerCase() ?? "candidate"}${record.supersededAt ? " is-superseded" : ""}`} key={facts.id}>
                        <header>
                          <div className="moment-card-kickers">
                            <span>{publicationLabel(record, locale)}</span>
                            {facts.recommendationRank !== null && <b>#{facts.recommendationRank} {text("推荐", "Pick")}</b>}
                            {publication?.isPrimary && <em>{text("主瞬间", "Primary")}</em>}
                            {record.supersededAt && <i>{text("旧版候选", "Superseded")}</i>}
                          </div>
                          <div className="moment-score"><strong>{facts.score}</strong><span>/100</span></div>
                        </header>
                        <div className="moment-card-title">
                          <span>{text("第", "Hand")} {String(facts.handNo).padStart(3, "0")} {text("手", "")}</span>
                          <h2>{title ?? tagLabel(facts.primaryTag, locale)}</h2>
                        </div>
                        <div className="moment-tags">
                          {facts.tags.map((tag) => <span key={tag}>{tagLabel(tag, locale)}</span>)}
                        </div>
                        <dl className="moment-facts">
                          <div><dt>{text("底池", "Pot")}</dt><dd>{formatChips(facts.potChips)} <small>· {facts.potBigBlinds.toFixed(1)} BB</small></dd></div>
                          <div><dt>{text("选手", "Players")}</dt><dd title={participantNames}>{participantNames}</dd></div>
                          <div><dt>{text("事件区间", "Event window")}</dt><dd>{facts.startSequence}—{facts.endSequence}</dd></div>
                        </dl>
                        {publication?.summaryZh || publication?.summaryEn ? (
                          <p className="moment-card-summary">{locale === "zh-CN" ? publication.summaryZh ?? publication.summaryEn : publication.summaryEn ?? publication.summaryZh}</p>
                        ) : null}
                        <footer>
                          <button className="button secondary" type="button" disabled={busyAction !== null} onClick={() => setEditor(createEditor(record, "SAVE"))}>
                            {text("编辑", "Edit")}
                          </button>
                          {publication?.status !== "PUBLISHED" && (
                            <button
                              className="button primary"
                              type="button"
                              disabled={busyAction !== null || !publishable}
                              title={!publishable ? text("旧版未发布候选不能首次发布", "A superseded unpublished candidate cannot be published") : undefined}
                              onClick={() => setEditor(createEditor(record, "PUBLISH"))}
                            >
                              {publication?.status === "HIDDEN" ? text("重新发布", "Republish") : text("发布", "Publish")}
                            </button>
                          )}
                          {canHideMoment(record) && (
                            <button className="button danger" type="button" disabled={busyAction !== null} onClick={() => void hide(record)}>
                              {busy ? text("正在隐藏…", "Hiding…") : text("隐藏", "Hide")}
                            </button>
                          )}
                        </footer>
                      </article>
                    );
                  })}
                </section>
              )}
        </>
      )}

      {editor && (
        <MomentEditor
          state={editor}
          working={busyAction !== null}
          onChange={(draft) => setEditor({ ...editor, draft, issues: [], error: null })}
          onClose={() => setEditor(null)}
          onSave={(intent) => void mutateEditor(intent)}
          onLoadLatest={() => {
            if (editor.conflictRecord) setEditor(createEditor(editor.conflictRecord, editor.intent));
            else setEditor(null);
          }}
        />
      )}
    </div>
  );
}

function MomentEditor({
  state,
  working,
  onChange,
  onClose,
  onSave,
  onLoadLatest,
}: {
  state: EditorState;
  working: boolean;
  onChange: (draft: MomentEditorDraft) => void;
  onClose: () => void;
  onSave: (intent: MomentMutationIntent) => void;
  onLoadLatest: () => void;
}) {
  const { locale, text } = useUiPreferences();
  const { record, draft } = state;
  const publication = record.publication;
  const slugLocked = publication?.publishedAt != null;
  const hasConflict = state.conflictRecord !== null || state.conflictMissing;
  const publishing = state.intent === "PUBLISH";
  const setDraft = <K extends keyof MomentEditorDraft>(key: K, value: MomentEditorDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(state.intent);
  };
  return (
    <Modal
      title={publishing
        ? publication?.status === "HIDDEN" ? text("重新发布精彩瞬间", "Republish moment") : text("发布精彩瞬间", "Publish moment")
        : text("编辑精彩瞬间", "Edit moment")}
      onClose={onClose}
      className="moment-editor-modal"
    >
      <form className="modal-form moment-editor-form" onSubmit={submit}>
        <div className="moment-editor-context">
          <span>{text("第", "Hand")} {String(record.facts.handNo).padStart(3, "0")} {text("手", "")}</span>
          <strong>{tagLabel(record.facts.primaryTag, locale)}</strong>
          <code>{record.facts.startSequence}—{record.facts.endSequence}</code>
        </div>

        {hasConflict && (
          <div className="moment-conflict" role="alert">
            <strong>{text("候选已发生变化", "This candidate has changed")}</strong>
            <p>{state.conflictMissing
              ? text("重新检测已替换这个未发布候选。你的输入仍保留在当前窗口中。", "A new detection replaced this unpublished candidate. Your input remains visible in this dialog.")
              : text("另一项操作已经更新了发布版本。你的输入尚未覆盖最新内容。", "Another operation updated the publication. Your draft has not overwritten the latest version.")}</p>
            <button className="button secondary" type="button" onClick={onLoadLatest}>
              {state.conflictMissing ? text("关闭并查看最新列表", "Close and view latest") : text("载入最新版本", "Load latest version")}
            </button>
          </div>
        )}

        {state.error && <div className="notice error" role="alert"><span>{state.error}</span></div>}
        {state.issues.length > 0 && (
          <div className="moment-editor-issues" role="alert">
            {state.issues.map((issue) => <p key={issue}>{issueLabel(issue, locale)}</p>)}
          </div>
        )}

        <div className="form-grid">
          <label className="full">
            <span>{text("分享链接", "Share URL")}</span>
            <div className={`moment-slug-field${slugLocked ? " is-locked" : ""}`}>
              <span>/moments/</span>
              <input
                value={draft.slug}
                maxLength={120}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                readOnly={slugLocked}
                aria-describedby={slugLocked ? "moment-slug-lock-note" : undefined}
                onChange={(event) => setDraft("slug", event.target.value.toLowerCase())}
                aria-invalid={state.issues.includes("SLUG_REQUIRED") || undefined}
              />
            </div>
            {slugLocked && <small id="moment-slug-lock-note" className="moment-slug-lock-note">{text("首次发布后固定", "Fixed after first publish")}</small>}
          </label>
          <label><span>{text("中文标题", "Chinese title")}</span><input value={draft.titleZh} maxLength={140} onChange={(event) => setDraft("titleZh", event.target.value)} /></label>
          <label><span>{text("英文标题", "English title")}</span><input value={draft.titleEn} maxLength={140} onChange={(event) => setDraft("titleEn", event.target.value)} /></label>
          <label><span>{text("中文摘要", "Chinese summary")}</span><textarea rows={4} value={draft.summaryZh} maxLength={500} onChange={(event) => setDraft("summaryZh", event.target.value)} /></label>
          <label><span>{text("英文摘要", "English summary")}</span><textarea rows={4} value={draft.summaryEn} maxLength={500} onChange={(event) => setDraft("summaryEn", event.target.value)} /></label>
          <div className="moment-sequence-grid full">
            <label><span>{text("播放起点", "Playback start")}</span><input type="number" inputMode="numeric" min={record.facts.startSequence} max={record.facts.endSequence} value={draft.playbackStartSequence} onChange={(event) => setDraft("playbackStartSequence", event.target.value)} /></label>
            <label><span>{text("封面帧", "Cover frame")}</span><input type="number" inputMode="numeric" min={record.facts.startSequence} max={record.facts.endSequence} value={draft.coverSequence} onChange={(event) => setDraft("coverSequence", event.target.value)} /></label>
            <label><span>{text("播放终点", "Playback end")}</span><input type="number" inputMode="numeric" min={record.facts.startSequence} max={record.facts.endSequence} value={draft.playbackEndSequence} onChange={(event) => setDraft("playbackEndSequence", event.target.value)} /></label>
          </div>
          <label className="full"><span>{text("剧透方式", "Spoiler mode")}</span><SelectControl value={draft.spoilerMode} onChange={(value) => setDraft("spoilerMode", value as MomentEditorDraft["spoilerMode"])} options={[
            { value: "SUSPENSE", label: text("保留悬念", "Preserve suspense") },
            { value: "RESULT", label: text("直接展示结果", "Show the result") },
          ]} /></label>
          {(publishing || publication?.status === "PUBLISHED") && (
            <label className="switch-field moment-primary-toggle full">
              <span><b>{text("设为本场主瞬间", "Set as primary moment")}</b><small>{text("每场赛事只保留一个公开主瞬间；新的选择会替换旧选择。", "Each tournament has one public primary moment. This choice replaces the previous one.")}</small></span>
              <input className="native-switch" type="checkbox" checked={draft.isPrimary} onChange={(event) => setDraft("isPrimary", event.target.checked)} />
            </label>
          )}
        </div>

        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>{text("取消", "Cancel")}</button>
          {!hasConflict && publishing && publication?.status !== "PUBLISHED" && (
            <button className="button secondary" type="button" disabled={working} onClick={() => onSave("SAVE")}>{text("保存草稿", "Save draft")}</button>
          )}
          {!hasConflict && (
            <button className="button primary" disabled={working}>
              {working
                ? text("正在保存…", "Saving…")
                : publishing ? text("发布", "Publish") : text("保存修改", "Save changes")}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
