import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import type {
  DecisionBranchPublication,
} from "../../../packages/contracts/src/decision-branches";
import type { AdminHandFork } from "../../../packages/contracts/src/hand-forks";
import { ApiError, apiRequest, useApiResource } from "./api";
import { Modal } from "./components";
import {
  decisionBranchEditorDraft,
  decisionBranchMutationBody,
  decisionBranchRevisionChanged,
  validateDecisionBranchDraft,
  type DecisionBranchDraftIssue,
  type DecisionBranchEditorDraft,
  type DecisionBranchMutationIntent,
} from "./decision-branch-admin-model";
import { type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

interface BranchEditorState {
  publication: DecisionBranchPublication;
  draft: DecisionBranchEditorDraft;
  intent: DecisionBranchMutationIntent;
  issues: DecisionBranchDraftIssue[];
  error: string | null;
  conflictPublication: DecisionBranchPublication | null;
}

function publicationLabel(
  publication: DecisionBranchPublication,
  locale: UiLocale,
): string {
  const labels: Record<DecisionBranchPublication["status"], readonly [string, string]> = {
    DRAFT: ["草稿", "Draft"],
    PUBLISHED: ["已发布", "Published"],
    HIDDEN: ["已隐藏", "Hidden"],
  };
  return uiText(locale, ...labels[publication.status]);
}

function issueLabel(issue: DecisionBranchDraftIssue, locale: UiLocale): string {
  const labels: Record<DecisionBranchDraftIssue, readonly [string, string]> = {
    SLUG_REQUIRED: ["发布前需要填写公开链接", "A public URL is required before publishing"],
    SLUG_INVALID: ["链接只能使用小写字母、数字和单个连字符", "Use lowercase letters, numbers, and single hyphens only"],
    TITLE_REQUIRED: ["发布前至少填写一个语言的标题", "Add a title in at least one language before publishing"],
  };
  return uiText(locale, ...labels[issue]);
}

function errorLabel(code: string, locale: UiLocale): string {
  const labels: Record<string, readonly [string, string]> = {
    decision_branch_not_found: ["发布记录不存在或已被移除", "The publication does not exist or was removed"],
    decision_branch_slug_conflict: ["这个公开链接已经被使用，请换一个", "This public URL is already in use"],
    decision_branch_conflict: ["发布版本已经变化，请载入最新版本", "The publication changed. Load the latest version"],
    decision_branch_source_unavailable: ["只有完整完成的决策复测可以公开", "Only a completed decision rerun can be published"],
    decision_branch_identity_unavailable: ["赛事选手身份信息不完整，暂时无法公开", "Tournament player identities are incomplete"],
    decision_branch_source_unsafe: ["公开快照未通过安全检查", "The public snapshot did not pass its safety check"],
    decision_branch_failed: ["发布服务暂时不可用，请稍后重试", "The publication service is temporarily unavailable"],
  };
  const label = labels[code];
  return label
    ? uiText(locale, ...label)
    : uiText(locale, "操作未能完成，请重试", "The operation could not be completed. Try again.");
}

function mutationError(reason: unknown, locale: UiLocale): string {
  return errorLabel(reason instanceof ApiError ? reason.code : "decision_branch_failed", locale);
}

function editorState(
  publication: DecisionBranchPublication,
  intent: DecisionBranchMutationIntent,
): BranchEditorState {
  return {
    publication,
    draft: decisionBranchEditorDraft(publication),
    intent,
    issues: [],
    error: null,
    conflictPublication: null,
  };
}

export function DecisionBranchPublicationPanel({
  fork,
  csrfToken,
}: {
  fork: AdminHandFork;
  csrfToken: string;
}) {
  const { locale, text } = useUiPreferences();
  const resource = useApiResource<{ decisionBranch: DecisionBranchPublication | null }>(
    fork.status === "COMPLETED"
      ? `/api/admin/hand-forks/${encodeURIComponent(fork.id)}/decision-branch`
      : null,
  );
  const publication = resource.data?.decisionBranch ?? null;
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<BranchEditorState | null>(null);

  if (fork.status !== "COMPLETED") return null;

  const setPublication = (next: DecisionBranchPublication) => {
    resource.setData({ decisionBranch: next });
  };

  const createDraft = async () => {
    setWorking("create");
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{
        decisionBranch: DecisionBranchPublication;
        created: boolean;
      }>("/api/admin/decision-branches", {
        method: "POST",
        csrfToken,
        body: JSON.stringify({ sourceHandForkId: fork.id }),
      });
      setPublication(response.decisionBranch);
      setEditor(editorState(
        response.decisionBranch,
        response.decisionBranch.status === "PUBLISHED" ? "SAVE" : "PUBLISH",
      ));
    } catch (reason) {
      setError(mutationError(reason, locale));
    } finally {
      setWorking(null);
    }
  };

  const refreshConflict = async (current: BranchEditorState, reason: ApiError) => {
    try {
      const response = await apiRequest<{ decisionBranch: DecisionBranchPublication }>(
        `/api/admin/decision-branches/${encodeURIComponent(current.publication.id)}`,
      );
      setPublication(response.decisionBranch);
      if (decisionBranchRevisionChanged(current.publication, response.decisionBranch)) {
        setEditor({
          ...current,
          error: null,
          conflictPublication: response.decisionBranch,
        });
      } else {
        setEditor({ ...current, error: mutationError(reason, locale) });
      }
    } catch (refreshReason) {
      setEditor({ ...current, error: mutationError(refreshReason, locale) });
    }
  };

  const mutate = async (intent: DecisionBranchMutationIntent) => {
    if (!editor) return;
    const current = editor;
    const issues = validateDecisionBranchDraft(current.draft, intent, current.publication.status);
    if (issues.length > 0) {
      setEditor({ ...current, issues, error: null });
      return;
    }
    setWorking(intent.toLowerCase());
    setEditor({ ...current, issues: [], error: null });
    try {
      const response = await apiRequest<{ decisionBranch: DecisionBranchPublication }>(
        intent === "PUBLISH"
          ? `/api/admin/decision-branches/${current.publication.id}/publish`
          : `/api/admin/decision-branches/${current.publication.id}`,
        {
          method: intent === "PUBLISH" ? "POST" : "PATCH",
          csrfToken,
          body: JSON.stringify(decisionBranchMutationBody(current.publication, current.draft)),
        },
      );
      setPublication(response.decisionBranch);
      setEditor(null);
      setNotice(intent === "PUBLISH"
        ? text("决策分叉已发布", "Decision branch published")
        : text("发布内容已保存", "Publication changes saved"));
      setError(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "decision_branch_conflict") {
        await refreshConflict(current, reason);
      } else {
        setEditor({ ...current, error: mutationError(reason, locale) });
      }
    } finally {
      setWorking(null);
    }
  };

  const hide = async () => {
    if (!publication) return;
    setWorking("hide");
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{ decisionBranch: DecisionBranchPublication }>(
        `/api/admin/decision-branches/${publication.id}/hide`,
        {
          method: "POST",
          csrfToken,
          body: JSON.stringify({ expectedRevision: publication.revision }),
        },
      );
      setPublication(response.decisionBranch);
      setNotice(text("决策分叉已隐藏", "Decision branch hidden"));
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "decision_branch_conflict") {
        try {
          const response = await apiRequest<{ decisionBranch: DecisionBranchPublication }>(
            `/api/admin/decision-branches/${encodeURIComponent(publication.id)}`,
          );
          setPublication(response.decisionBranch);
          setError(text(
            "发布版本已变化，已载入最新状态，请确认后重试",
            "The publication changed. The latest status is loaded; review it and try again.",
          ));
        } catch (refreshReason) {
          setError(mutationError(refreshReason, locale));
        }
      } else {
        setError(mutationError(reason, locale));
      }
    } finally {
      setWorking(null);
    }
  };

  return <>
    <section className="decision-branch-publication" aria-labelledby="decision-branch-publication-title">
      <header>
        <div>
          <span>DECISION BRANCH</span>
          <h2 id="decision-branch-publication-title">{text("公开决策分叉", "Publish decision branch")}</h2>
        </div>
        {publication && <strong className={`decision-branch-publication-status is-${publication.status.toLowerCase()}`}>
          <i />{publicationLabel(publication, locale)} <small>r{publication.revision}</small>
        </strong>}
      </header>
      <div className="decision-branch-publication-body">
        <div>
          <p>{text(
            "公开同一可见输入下的决策分布，不推演后续牌局。",
            "Publish decisions from the same visible input, without simulating the rest of the hand.",
          )}</p>
          {publication?.slug && <code>/branches/{publication.slug}</code>}
        </div>
        <div className="decision-branch-publication-actions">
          {!publication && !resource.error && <button className="button primary" type="button" disabled={working !== null || resource.loading} onClick={() => void createDraft()}>
            {working === "create" ? text("正在创建…", "Creating…") : text("创建发布草稿", "Create publication draft")}
          </button>}
          {publication?.status === "PUBLISHED" && publication.slug && <Link className="button secondary" to={`/branches/${publication.slug}`}>
            {text("查看公开页", "View public page")}
          </Link>}
          {publication && <button className={publication.status === "PUBLISHED" ? "button secondary" : "button primary"} type="button" disabled={working !== null} onClick={() => setEditor(editorState(publication, publication.status === "PUBLISHED" ? "SAVE" : "PUBLISH"))}>
            {publication.status === "PUBLISHED"
              ? text("编辑", "Edit")
              : publication.status === "HIDDEN"
                ? text("编辑并重新发布", "Edit & republish")
                : text("编辑并发布", "Edit & publish")}
          </button>}
          {publication?.status === "PUBLISHED" && <button className="button secondary" type="button" disabled={working !== null} onClick={() => void hide()}>
            {working === "hide" ? text("正在隐藏…", "Hiding…") : text("隐藏", "Hide")}
          </button>}
        </div>
      </div>
      {resource.loading && <div className="decision-branch-publication-message">{text("正在读取发布状态…", "Loading publication status…")}</div>}
      {resource.error && <div className="decision-branch-publication-message is-error" role="alert"><span>{errorLabel(
        resource.errorCode ?? "decision_branch_failed",
        locale,
      )}</span><button type="button" onClick={() => void resource.refresh()}>{text("重试", "Retry")}</button></div>}
      {notice && <div className="decision-branch-publication-message is-success" role="status">{notice}</div>}
      {error && <div className="decision-branch-publication-message is-error" role="alert">{error}</div>}
    </section>
    {editor && <DecisionBranchEditor
      state={editor}
      working={working !== null}
      onChange={(draft) => setEditor({ ...editor, draft, issues: [], error: null })}
      onClose={() => setEditor(null)}
      onSave={(intent) => void mutate(intent)}
      onLoadLatest={() => {
        const latest = editor.conflictPublication;
        if (latest) setEditor(editorState(latest, latest.status === "PUBLISHED" ? "SAVE" : "PUBLISH"));
      }}
    />}
  </>;
}

function DecisionBranchEditor({
  state,
  working,
  onChange,
  onClose,
  onSave,
  onLoadLatest,
}: {
  state: BranchEditorState;
  working: boolean;
  onChange: (draft: DecisionBranchEditorDraft) => void;
  onClose: () => void;
  onSave: (intent: DecisionBranchMutationIntent) => void;
  onLoadLatest: () => void;
}) {
  const { locale, text } = useUiPreferences();
  const { publication, draft } = state;
  const slugLocked = publication.publishedAt !== null;
  const publishing = state.intent === "PUBLISH";
  const hasConflict = state.conflictPublication !== null;
  const setDraft = <K extends keyof DecisionBranchEditorDraft>(
    key: K,
    value: DecisionBranchEditorDraft[K],
  ) => onChange({ ...draft, [key]: value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(state.intent);
  };

  return <Modal
    title={publishing
      ? publication.status === "HIDDEN"
        ? text("重新发布决策分叉", "Republish decision branch")
        : text("发布决策分叉", "Publish decision branch")
      : text("编辑决策分叉", "Edit decision branch")}
    onClose={onClose}
    className="decision-branch-editor-modal"
  >
    <form className="modal-form decision-branch-editor-form" noValidate onSubmit={submit}>
      <div className="decision-branch-editor-context">
        <span>{publication.snapshot.source.tournamentName}</span>
        <strong>H{String(publication.snapshot.source.handNo).padStart(3, "0")}</strong>
        <code>r{publication.revision}</code>
      </div>

      {hasConflict && <div className="decision-branch-conflict" role="alert">
        <strong>{text("发布版本已变化", "The publication has changed")}</strong>
        <p>{text(
          "另一项操作已经更新了这份发布记录。你的输入尚未覆盖最新版本。",
          "Another operation updated this publication. Your draft has not overwritten the latest version.",
        )}</p>
        <button className="button secondary" type="button" onClick={onLoadLatest}>{text("载入最新版本", "Load latest version")}</button>
      </div>}
      {state.error && <div className="notice error" role="alert"><span>{state.error}</span></div>}
      {state.issues.length > 0 && <div className="decision-branch-editor-issues" role="alert">
        {state.issues.map((issue) => <p key={issue}>{issueLabel(issue, locale)}</p>)}
      </div>}

      <div className="form-grid">
        <label className="full">
          <span>{text("公开链接", "Public URL")}</span>
          <div className={`decision-branch-slug-field${slugLocked ? " is-locked" : ""}`}>
            <span>/branches/</span>
            <input
              value={draft.slug}
              maxLength={120}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              readOnly={slugLocked}
              onChange={(event) => setDraft("slug", event.target.value.toLowerCase())}
              aria-invalid={state.issues.includes("SLUG_REQUIRED") || state.issues.includes("SLUG_INVALID") || undefined}
            />
          </div>
          {slugLocked && <small>{text("首次发布后固定", "Fixed after first publish")}</small>}
        </label>
        <label><span>{text("中文标题", "Chinese title")}</span><input value={draft.titleZh} maxLength={140} onChange={(event) => setDraft("titleZh", event.target.value)} /></label>
        <label><span>{text("英文标题", "English title")}</span><input value={draft.titleEn} maxLength={140} onChange={(event) => setDraft("titleEn", event.target.value)} /></label>
        <label><span>{text("中文摘要", "Chinese summary")}</span><textarea rows={4} value={draft.summaryZh} maxLength={500} onChange={(event) => setDraft("summaryZh", event.target.value)} /></label>
        <label><span>{text("英文摘要", "English summary")}</span><textarea rows={4} value={draft.summaryEn} maxLength={500} onChange={(event) => setDraft("summaryEn", event.target.value)} /></label>
      </div>

      <div className="modal-actions">
        <button className="button secondary" type="button" onClick={onClose}>{text("取消", "Cancel")}</button>
        {!hasConflict && publishing && publication.status !== "PUBLISHED" && <button className="button secondary" type="button" disabled={working} onClick={() => onSave("SAVE")}>{publication.status === "HIDDEN"
          ? text("保存修改", "Save changes")
          : text("保存草稿", "Save draft")}</button>}
        {!hasConflict && <button className="button primary" disabled={working}>
          {working
            ? text("正在保存…", "Saving…")
            : publishing
              ? publication.status === "HIDDEN" ? text("重新发布", "Republish") : text("发布", "Publish")
              : text("保存修改", "Save changes")}
        </button>}
      </div>
    </form>
  </Modal>;
}
