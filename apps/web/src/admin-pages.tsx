import { type FormEvent, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { apiRequest, useApiResource } from "./api";
import { ConsistencyTestModal, ConsistencyWorkbench } from "./consistency-admin";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Modal,
  modelTint,
  StatusBadge,
  formatChips,
} from "./components";
import { ProviderLogo } from "./provider-logo";
import { SelectControl } from "./select-control";
import type { AdminSession, ArenaState, ModelConfig, ProviderConnection, SystemPromptVersion, TournamentSummary } from "./types";
import { PreferenceControls, type UiLocale, uiText, useUiPreferences } from "./ui-preferences";

interface AuthPayload { session: AdminSession; csrfToken: string }
interface EmptyAuthPayload { session: null; csrfToken: null }

export function AdminArea() {
  const { text } = useUiPreferences();
  const session = useApiResource<AuthPayload | EmptyAuthPayload>("/api/auth/session");
  if (session.loading) return <main className="admin-gate"><LoadingBlock label={text("正在确认控制室权限", "Checking admin access")} /></main>;
  if (!session.data?.session || !session.data.csrfToken) {
    return <LoginScreen onLogin={(payload) => session.setData(payload)} />;
  }
  const authenticated = session.data;
  return (
    <div className="admin-shell">
      <aside className="admin-rail">
        <Link className="admin-wordmark" to="/"><span>A♠</span><div><strong>{text("德扑竞技场", "Hold'em Arena")}</strong></div></Link>
        <PreferenceControls className="admin-preferences" />
        <nav aria-label={text("控制室导航", "Admin navigation")}>
          <NavLink to="/admin" end>{text("总览", "Overview")}</NavLink>
          <NavLink to="/admin/models">{text("模型与 API", "Models & API")}</NavLink>
          <NavLink to="/admin/prompts">{text("提示词版本", "Prompt versions")}</NavLink>
          <NavLink to="/admin/consistency">{text("一致性检测", "Consistency")}</NavLink>
          <NavLink to="/admin/tournaments/new">{text("创建赛事", "Create")}</NavLink>
          <Link to="/tournaments">{text("赛事档案", "Archive")}</Link>
        </nav>
        <div className="admin-identity"><span>{authenticated.session.email.slice(0, 1).toUpperCase()}</span><div><strong>{authenticated.session.email}</strong><small>{text("本机管理员", "Local admin")}</small></div></div>
        <button className="rail-logout" onClick={async () => {
          await apiRequest("/api/auth/logout", { method: "POST", csrfToken: authenticated.csrfToken });
          session.setData(null);
        }}>{text("退出登录", "Sign out")}</button>
      </aside>
      <main className="admin-main">
        <Routes>
          <Route path="/admin" element={<AdminDashboard csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/models" element={<ModelsAdmin csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/prompts" element={<SystemPromptsAdmin csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/consistency" element={<ConsistencyWorkbench csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/consistency/:batchId" element={<ConsistencyWorkbench csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/tournaments/new" element={<NewTournament csrfToken={authenticated.csrfToken} />} />
        </Routes>
      </main>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (payload: AuthPayload) => void }) {
  const { text } = useUiPreferences();
  const [email, setEmail] = useState("admin@localhost");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      onLogin(await apiRequest<AuthPayload>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("登录失败", "Sign-in failed"));
    } finally { setWorking(false); }
  };
  return (
    <main className="login-screen">
      <div className="login-topbar"><Link className="back-home" to="/">← {text("返回观赛室", "Back to watch room")}</Link><PreferenceControls /></div>
      <section className="login-editorial">
        <h1>{text("进入赛事", "Tournament")}<br /><span>{text("控制室", "Control room")}</span></h1>
        <p>{text("控制室仅面向本机管理员。模型配置、API 密钥与赛事指令只作用于本机部署；发牌种子承诺、每次模型决策与 API 调用全程留痕，可独立验证。", "The control room is for local administrators only. Model configs, API keys and tournament commands apply to this deployment; seed commitments, model decisions and API calls are fully auditable.")}</p>
        <div className="login-proof"><span>{text("本机会话", "Local session")}</span><span>{text("种子承诺可验证", "Verifiable seeds")}</span><span>{text("决策留痕", "Auditable decisions")}</span></div>
      </section>
      <form className="login-form" onSubmit={submit}>
        <header><span>A♠</span><div><h2>{text("身份验证", "Sign in")}</h2></div></header>
        <label><span>{text("管理员邮箱", "Admin email")}</span><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label><span>{text("密码", "Password")}</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="button primary wide" disabled={working}>{working ? text("验证中…", "Signing in…") : text("进入控制室", "Enter control room")}</button>
      </form>
    </main>
  );
}

function AdminDashboard({ csrfToken }: { csrfToken: string }) {
  const { text } = useUiPreferences();
  const live = useApiResource<{ state: ArenaState | null }>("/api/public/live", 1_500);
  const tournaments = useApiResource<{ tournaments: TournamentSummary[] }>("/api/public/tournaments");
  const [commandError, setCommandError] = useState<string | null>(null);
  const state = live.data?.state;
  const command = async (action: "pause" | "resume" | "cancel") => {
    if (!state) return;
    setCommandError(null);
    try {
      await apiRequest(`/api/admin/tournaments/${state.tournamentId}/${action}`, { method: "POST", csrfToken });
      window.setTimeout(() => void live.refresh(), 180);
    } catch (reason) { setCommandError(reason instanceof Error ? reason.message : text("赛事指令执行失败", "Tournament command failed")); }
  };
  return (
    <>
      <div className="admin-heading"><div><h1>{text("赛事控制台", "Tournament control")}</h1></div><Link className="button primary" to="/admin/tournaments/new">{text("创建锦标赛", "Create tournament")}</Link></div>
      <div className="admin-metrics"><article><span>{text("历史赛事", "Tournaments")}</span><b>{tournaments.data?.tournaments.length ?? "—"}</b></article><article><span>{text("当前状态", "Status")}</span>{state ? <StatusBadge status={state.status} /> : <b className="metric-status">{text("空闲", "Idle")}</b>}</article><article><span>{text("已完成手数", "Hands")}</span><b>{state?.completedHands ?? 0}</b></article><article><span>{text("模型席位", "Seats")}</span><b>{state?.players.length ?? 0}</b></article></div>
      <section className="admin-live-card">
        <header><div><h2>{state?.name ?? text("没有正在进行的赛事", "No active tournament")}</h2></div>{state && <StatusBadge status={state.status} />}</header>
        {state ? <>
          <div className="control-state"><div><span>{text("当前牌局", "Current hand")}</span><b>{text("第", "Hand")} {String(state.hand?.handNo ?? state.completedHands).padStart(3, "0")} {text("手", "")}</b></div><div><span>{text("盲注", "Blinds")}</span><b>{formatChips(state.hand?.blinds.smallBlind)} / {formatChips(state.hand?.blinds.bigBlind)}</b></div><div><span>{text("行动席位", "Action")}</span><b>{state.players.find((player) => player.id === state.hand?.currentActorId)?.displayName ?? "—"}</b></div></div>
          <div className="control-actions">
            {state.status === "RUNNING" && <button className="button secondary" onClick={() => void command("pause")}>{text("暂停", "Pause")}</button>}
            {state.status === "PAUSED_INFRA" && <button className="button primary" onClick={() => void command("resume")}>{text("继续", "Resume")}</button>}
            {!(["COMPLETED", "CANCELLED"] as string[]).includes(state.status) && <button className="button danger" onClick={() => void command("cancel")}>{text("取消赛事", "Cancel tournament")}</button>}
            <Link className="text-button" to="/">{text("打开观赛室", "Open watch room")} ↗</Link>
          </div>
          {commandError && <p className="form-error">{commandError}</p>}
        </> : <EmptyState title={text("牌桌空闲", "Table idle")} body={text("至少选择两个模型即可开始。", "Select at least two models to begin.")} action={<Link className="button primary" to="/admin/tournaments/new">{text("配置新赛事", "Set up tournament")}</Link>} />}
      </section>
    </>
  );
}

type ProviderDraft = { label: string; providerType: string; providerProfile: string; defaultOutputMode: string; baseUrl: string; apiKey: string };
type ModelDraft = { displayName: string; providerConnectionId: string; modelId: string; outputMode: string; parameters: string };
const emptyProvider: ProviderDraft = { label: "", providerType: "openai-responses", providerProfile: "auto", defaultOutputMode: "auto", baseUrl: "", apiKey: "" };
const emptyModel: ModelDraft = { displayName: "", providerConnectionId: "", modelId: "", outputMode: "inherit", parameters: "{}" };

const outputModeLabel = (mode: string, locale: UiLocale = "zh-CN") => ({
  auto: uiText(locale, "自动选择", "Automatic"),
  inherit: uiText(locale, "继承 Provider", "Inherit provider"),
  json_schema: "JSON Schema",
  json_object: "JSON Object",
  prompt: uiText(locale, "仅提示词约束", "Prompt only"),
}[mode] ?? mode);

const providerProfileLabel = (profile: string, locale: UiLocale = "zh-CN") => ({
  auto: uiText(locale, "自动识别", "Automatic"),
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  zhipu: uiText(locale, "智谱 GLM", "Zhipu GLM"),
  qwen: uiText(locale, "Qwen / 通义千问", "Qwen"),
  doubao: uiText(locale, "豆包 / 火山方舟", "Doubao / Ark"),
  wenxin: uiText(locale, "文心 / 千帆", "ERNIE / Qianfan"),
  hunyuan: uiText(locale, "腾讯混元", "Tencent Hunyuan"),
  minimax: "MiniMax",
  xai: "xAI / Grok",
  generic: uiText(locale, "通用兼容", "Generic compatible"),
}[profile] ?? profile);

function ModelsAdmin({ csrfToken }: { csrfToken: string }) {
  const { locale, text } = useUiPreferences();
  const providers = useApiResource<{ providers: ProviderConnection[] }>("/api/admin/providers");
  const models = useApiResource<{ models: ModelConfig[] }>("/api/admin/models");
  const [providerDialog, setProviderDialog] = useState<{ draft: ProviderDraft; editing?: ProviderConnection } | null>(null);
  const [modelDialog, setModelDialog] = useState<{ draft: ModelDraft; editing?: ModelConfig } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "provider" | "model"; id: string; label: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflighting, setPreflighting] = useState<string | null>(null);
  const [consistencyModel, setConsistencyModel] = useState<ModelConfig | null>(null);
  const refresh = async () => { await Promise.all([providers.refresh(), models.refresh()]); };

  if (providers.loading || models.loading) return <LoadingBlock label={text("正在读取模型配置", "Loading model configuration")} />;
  if (providers.error || models.error) return <ErrorBlock message={providers.error ?? models.error ?? text("服务暂时不可用", "Service temporarily unavailable")} onRetry={() => void refresh()} />;
  const providerDependents = confirmDelete?.kind === "provider"
    ? (models.data?.models ?? []).filter((model) => model.providerConnectionId === confirmDelete.id)
    : [];
  const providerDeleteBlocked = providerDependents.length > 0;
  return (
    <>
      <div className="admin-heading">
        <div><h1>{text("模型与 API", "Models & API")}</h1></div>
        <div className="button-row">
          <button className="button secondary" onClick={() => setProviderDialog({ draft: emptyProvider })}>{text("新增 Provider", "Add provider")}</button>
          <button className="button primary" disabled={(providers.data?.providers.length ?? 0) === 0} onClick={() => setModelDialog({ draft: { ...emptyModel, providerConnectionId: providers.data!.providers[0]!.id } })}>{text("新增模型", "Add model")}</button>
        </div>
      </div>
      {notice && <div className="notice success" role="status">{notice}<button aria-label={text("关闭通知", "Dismiss notification")} onClick={() => setNotice(null)}>×</button></div>}
      {error && <div className="notice error" role="alert">{error}<button aria-label={text("关闭错误提示", "Dismiss error")} onClick={() => setError(null)}>×</button></div>}
      <section className="admin-section">
        <div className="admin-section-title"><div><h2>{text("API 连接", "API connections")}</h2></div></div>
        {(providers.data?.providers.length ?? 0) === 0 ? (
          <EmptyState title={text("尚未配置 Provider", "No providers configured")} body={text("先连接一个模型服务。", "Connect a model provider first.")} />
        ) : (
          <div className="provider-grid">{providers.data!.providers.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <header><ProviderLogo providerProfile={provider.providerProfile} providerType={provider.providerType} label={provider.label} baseUrl={provider.baseUrl} fallback={provider.label.slice(0, 2).toUpperCase()} /><div><h3>{provider.label}</h3><p>{provider.providerType}</p></div><i className={provider.hasApiKey ? "ready" : "local"} /></header>
              <dl>
                <div><dt>{text("兼容档案", "Profile")}</dt><dd>{providerProfileLabel(provider.providerProfile, locale)}</dd></div>
                <div><dt>{text("默认输出", "Default output")}</dt><dd>{outputModeLabel(provider.defaultOutputMode, locale)}</dd></div>
                <div><dt>{text("服务端点", "Endpoint")}</dt><dd>{provider.baseUrl || text("官方服务", "Official service")}</dd></div>
                <div><dt>API key</dt><dd>{provider.hasApiKey ? `•••• ${provider.keyLastFour}` : text("无需密钥", "No key")}</dd></div>
              </dl>
              <footer><button onClick={() => setProviderDialog({ editing: provider, draft: { label: provider.label, providerType: provider.providerType, providerProfile: provider.providerProfile, defaultOutputMode: provider.defaultOutputMode, baseUrl: provider.baseUrl ?? "", apiKey: "" } })}>{text("编辑", "Edit")}</button><button onClick={() => setConfirmDelete({ kind: "provider", id: provider.id, label: provider.label })}>{text("删除", "Delete")}</button></footer>
            </article>
          ))}</div>
        )}
      </section>
      <section className="admin-section">
        <div className="admin-section-title"><div><h2>{text("模型列表", "Models")}</h2></div></div>
        {(models.data?.models.length ?? 0) === 0 ? (
          <EmptyState title={text("还没有模型", "No models yet")} body={text("创建模型后即可加入赛事。", "Add models to enter a tournament.")} />
        ) : (
          <div className="model-table">
            <div className="model-table-head"><span>{text("显示名 / 模型", "Name / model")}</span><span>Provider</span><span>{text("有效输出", "Output")}</span><span>{text("状态", "Status")}</span><span /></div>
            {models.data!.models.map((model) => (
              <article key={model.id}>
                <div className="model-cell-main"><ProviderLogo providerProfile={model.providerProfile} providerType={model.providerType} label={model.providerLabel} baseUrl={model.providerBaseUrl} modelId={model.modelId} fallback={model.displayName.slice(0, 1).toUpperCase()} fallbackStyle={modelTint(model.id)} /><div><strong>{model.displayName}</strong><small>{model.modelId}</small></div></div>
                <span data-label="Provider">{model.providerLabel}</span>
                <code className={model.outputModeSupported ? "" : "policy-issue"} data-label={text("有效输出", "Output")} title={model.outputModeMessage ?? `${providerProfileLabel(model.effectiveProviderProfile, locale)} · ${outputModeLabel(model.outputMode, locale)}`}>{outputModeLabel(model.effectiveOutputMode, locale)}{model.outputModeSupported ? "" : text(" · 配置冲突", " · Conflict")}</code>
                <button className={`enable-toggle ${model.enabled ? "on" : ""}`} aria-label={`${model.enabled ? text("停用", "Disable") : text("启用", "Enable")} ${model.displayName}`} onClick={async () => { await apiRequest(`/api/admin/models/${model.id}`, { method: "PATCH", csrfToken, body: JSON.stringify({ enabled: !model.enabled }) }); await models.refresh(); }}><i /></button>
                <div className="row-actions">
                  <button disabled={preflighting === model.id} onClick={async () => {
                    setPreflighting(model.id); setError(null); setNotice(null);
                    try {
                      const response = await apiRequest<{ result: { ok: boolean; latencyMs: number; effectiveMode: string; checks: { expectedOutput: string; ok: boolean; message: string }[] } }>(`/api/admin/models/${model.id}/preflight`, { method: "POST", csrfToken });
                      if (response.result.ok) setNotice(`${model.displayName} ${text("预检通过", "passed preflight")} · ${outputModeLabel(response.result.effectiveMode, locale)} · ${response.result.latencyMs}ms`);
                      else setError(`${model.displayName} ${text("预检失败", "preflight failed")}: ${response.result.checks.filter((check) => !check.ok).map((check) => `${check.expectedOutput}: ${check.message}`).join("; ")}`);
                    } catch (reason) { setError(reason instanceof Error ? reason.message : text("模型预检失败", "Model preflight failed")); }
                    finally { setPreflighting(null); }
                  }}>{preflighting === model.id ? text("检测中", "Checking") : text("预检", "Preflight")}</button>
                  <button disabled={preflighting === model.id} onClick={async () => {
                    setPreflighting(model.id); setError(null); setNotice(null);
                    try {
                      const response = await apiRequest<{ result: { ok: boolean; latencyMs: number; effectiveMode: string; checks: { scenario: string; ok: boolean; message: string }[] }; cached: boolean }>(`/api/admin/models/${model.id}/preflight?level=full`, { method: "POST", csrfToken });
                      if (response.result.ok) setNotice(`${model.displayName} ${text("完整协议验收通过", "passed full protocol validation")} · ${response.cached ? text("缓存结果", "cached") : `${response.result.latencyMs}ms`}`);
                      else setError(`${model.displayName} ${text("完整协议验收失败", "full validation failed")}: ${response.result.checks.filter((check) => !check.ok).map((check) => `${check.scenario}: ${check.message}`).join("; ")}`);
                    } catch (reason) { setError(reason instanceof Error ? reason.message : text("完整协议验收失败", "Full protocol validation failed")); }
                    finally { setPreflighting(null); }
                  }}>{text("完整验收", "Full validation")}</button>
                  <button onClick={() => setConsistencyModel(model)}>{text("一致性检测", "Consistency")}</button>
                  <button onClick={() => setModelDialog({ editing: model, draft: { displayName: model.displayName, providerConnectionId: model.providerConnectionId, modelId: model.modelId, outputMode: model.outputMode, parameters: JSON.stringify(model.parameters, null, 2) } })}>{text("编辑", "Edit")}</button>
                  <button onClick={() => setConfirmDelete({ kind: "model", id: model.id, label: model.displayName })}>{text("删除", "Delete")}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {providerDialog && <ProviderModal value={providerDialog} onClose={() => setProviderDialog(null)} onSave={async (draft, editing) => { const payload: Record<string, unknown> = { label: draft.label, providerType: draft.providerType, providerProfile: draft.providerProfile, defaultOutputMode: draft.defaultOutputMode, baseUrl: draft.baseUrl || null }; if (draft.apiKey || !editing) payload.apiKey = draft.apiKey || null; await apiRequest(editing ? `/api/admin/providers/${editing.id}` : "/api/admin/providers", { method: editing ? "PATCH" : "POST", csrfToken, body: JSON.stringify(payload) }); setProviderDialog(null); setNotice(editing ? text("Provider 已更新", "Provider updated") : text("Provider 已创建", "Provider created")); await refresh(); }} />}
      {modelDialog && <ModelModal value={modelDialog} providers={providers.data?.providers ?? []} onClose={() => setModelDialog(null)} onSave={async (draft, editing) => { const payload = { displayName: draft.displayName, providerConnectionId: draft.providerConnectionId, modelId: draft.modelId, outputMode: draft.outputMode, parameters: JSON.parse(draft.parameters) as unknown }; await apiRequest(editing ? `/api/admin/models/${editing.id}` : "/api/admin/models", { method: editing ? "PATCH" : "POST", csrfToken, body: JSON.stringify(payload) }); setModelDialog(null); setNotice(editing ? text("模型配置已更新", "Model updated") : text("模型配置已创建", "Model created")); await refresh(); }} />}
      {consistencyModel && <ConsistencyTestModal model={consistencyModel} csrfToken={csrfToken} onClose={() => setConsistencyModel(null)} />}
      {confirmDelete && <Modal title={`${providerDeleteBlocked ? text("无法删除", "Cannot delete") : text("删除", "Delete")} ${confirmDelete.label}${providerDeleteBlocked ? "" : "?"}`} onClose={() => setConfirmDelete(null)}><div className="confirm-body"><p>{providerDeleteBlocked
        ? text(
          `该 Provider 正被 ${providerDependents.map((model) => model.displayName).join("、")} 使用。请先删除这些模型，或将它们改绑到其他 Provider。`,
          `This provider is used by ${providerDependents.map((model) => model.displayName).join(", ")}. Delete those models first or move them to another provider.`,
        )
        : confirmDelete.kind === "provider"
          ? text("删除后将无法恢复。", "This provider cannot be recovered after deletion.")
          : text("历史赛事不会被删除。", "Historical tournaments will remain.")}</p><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setConfirmDelete(null)}>{text("取消", "Cancel")}</button><button className="button danger" type="button" disabled={providerDeleteBlocked} onClick={async () => { try { await apiRequest(`/api/admin/${confirmDelete.kind === "provider" ? "providers" : "models"}/${confirmDelete.id}`, { method: "DELETE", csrfToken }); setNotice(`${confirmDelete.label} ${text("已删除", "deleted")}`); setConfirmDelete(null); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : text("删除失败", "Delete failed")); setConfirmDelete(null); } }}>{providerDeleteBlocked ? text("正在使用", "In use") : text("确认删除", "Delete")}</button></div></div></Modal>}
    </>
  );
}

function ProviderModal({ value, onClose, onSave }: { value: { draft: ProviderDraft; editing?: ProviderConnection }; onClose: () => void; onSave: (draft: ProviderDraft, editing?: ProviderConnection) => Promise<void> }) {
  const { text } = useUiPreferences();
  const [draft, setDraft] = useState(value.draft);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return <Modal title={value.editing ? text("编辑 Provider", "Edit provider") : text("新增 Provider", "Add provider")} onClose={onClose}>
    <form className="modal-form" onSubmit={async (event) => { event.preventDefault(); setWorking(true); setError(null); try { await onSave(draft, value.editing); } catch (reason) { setError(reason instanceof Error ? reason.message : text("保存连接失败", "Unable to save connection")); } finally { setWorking(false); } }}>
      <div className="form-grid">
        <label><span>{text("名称", "Name")}</span><input autoComplete="organization" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} required autoFocus /></label>
        <label><span>{text("接口协议", "API protocol")}</span><SelectControl value={draft.providerType} onChange={(providerType) => setDraft({ ...draft, providerType })} options={[
          { value: "openai-responses", label: "OpenAI Responses" },
          { value: "anthropic-messages", label: "Anthropic Messages" },
          { value: "google-gemini", label: "Google Gemini" },
          { value: "openai-compatible", label: "OpenAI-compatible" },
          { value: "mock-scripted", label: text("本机模拟策略", "Local mock") },
        ]} /></label>
        <label><span>{text("供应商兼容档案", "Provider profile")}</span><SelectControl value={draft.providerProfile} onChange={(providerProfile) => setDraft({ ...draft, providerProfile })} options={[
          { value: "auto", label: text("自动识别", "Automatic") },
          { value: "openai", label: "OpenAI" },
          { value: "anthropic", label: "Claude" },
          { value: "gemini", label: "Gemini" },
          { value: "deepseek", label: "DeepSeek" },
          { value: "kimi", label: "Kimi" },
          { value: "zhipu", label: text("智谱 GLM", "Zhipu GLM") },
          { value: "qwen", label: text("Qwen / 通义千问", "Qwen") },
          { value: "doubao", label: text("豆包 / 火山方舟", "Doubao / Ark") },
          { value: "wenxin", label: text("文心 / 千帆", "ERNIE / Qianfan") },
          { value: "hunyuan", label: text("腾讯混元", "Tencent Hunyuan") },
          { value: "minimax", label: "MiniMax" },
          { value: "xai", label: "xAI / Grok" },
          { value: "generic", label: text("通用兼容端点", "Generic compatible") },
        ]} /></label>
        <label><span>{text("默认输出方式", "Default output")}</span><SelectControl value={draft.defaultOutputMode} onChange={(defaultOutputMode) => setDraft({ ...draft, defaultOutputMode })} options={[
          { value: "auto", label: text("自动选择", "Automatic") },
          { value: "json_schema", label: "JSON Schema" },
          { value: "json_object", label: "JSON Object" },
          { value: "prompt", label: text("仅提示词约束", "Prompt only") },
        ]} /></label>
        <label className="full"><span>Base URL</span><input type="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
        <label className="full"><span>API Key</span><input type="password" autoComplete="new-password" placeholder={value.editing && value.editing.hasApiKey ? `${text("当前", "Current")} •••• ${value.editing.keyLastFour}` : "sk-…"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>{text("取消", "Cancel")}</button><button className="button primary" disabled={working}>{working ? text("保存中…", "Saving…") : text("保存连接", "Save connection")}</button></div>
    </form>
  </Modal>;
}

function ModelModal({ value, providers, onClose, onSave }: { value: { draft: ModelDraft; editing?: ModelConfig }; providers: ProviderConnection[]; onClose: () => void; onSave: (draft: ModelDraft, editing?: ModelConfig) => Promise<void> }) {
  const { text } = useUiPreferences();
  const [draft, setDraft] = useState(value.draft);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return <Modal title={value.editing ? text("编辑模型", "Edit model") : text("新增模型", "Add model")} onClose={onClose}>
    <form className="modal-form" onSubmit={async (event) => { event.preventDefault(); setWorking(true); setError(null); try { const parsed = JSON.parse(draft.parameters) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(text("参数必须是 JSON 对象", "Parameters must be a JSON object")); await onSave(draft, value.editing); } catch (reason) { setError(reason instanceof Error ? reason.message : text("保存模型失败", "Unable to save model")); } finally { setWorking(false); } }}>
      <div className="form-grid">
        <label><span>{text("显示名称", "Display name")}</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} required autoFocus /></label>
        <label><span>Provider</span><SelectControl value={draft.providerConnectionId} onChange={(providerConnectionId) => setDraft({ ...draft, providerConnectionId })} options={providers.map((provider) => ({ value: provider.id, label: provider.label }))} /></label>
        <label className="full"><span>{text("模型 ID", "Model ID")}</span><input placeholder="gpt-5 / claude-sonnet-4-5 / gemini-2.5-pro" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} required /></label>
        <label className="full"><span>{text("输出策略", "Output strategy")}</span><SelectControl value={draft.outputMode} onChange={(outputMode) => setDraft({ ...draft, outputMode })} options={[
          { value: "inherit", label: text("继承 Provider", "Inherit provider") },
          { value: "auto", label: text("按模型自动选择", "Automatic") },
          { value: "json_schema", label: "JSON Schema" },
          { value: "json_object", label: "JSON Object" },
          { value: "prompt", label: text("仅提示词约束", "Prompt only") },
        ]} /></label>
        <label className="full"><span>{text("原生参数 JSON", "Raw parameters JSON")}</span><textarea rows={6} spellCheck={false} value={draft.parameters} onChange={(event) => setDraft({ ...draft, parameters: event.target.value })} /></label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>{text("取消", "Cancel")}</button><button className="button primary" disabled={working}>{working ? text("保存中…", "Saving…") : text("保存模型", "Save model")}</button></div>
    </form>
  </Modal>;
}

type PromptDraft = { name: string; protocolBundleId: string; systemPrompt: string };

function promptSourceLabel(source: SystemPromptVersion["source"], locale: UiLocale) {
  return source === "BUNDLED" ? uiText(locale, "平台内置", "Bundled")
    : source === "HISTORICAL" ? uiText(locale, "赛事归档", "Historical")
      : uiText(locale, "自定义", "Custom");
}

function SystemPromptsAdmin({ csrfToken }: { csrfToken: string }) {
  const { locale, text } = useUiPreferences();
  const versions = useApiResource<{ versions: SystemPromptVersion[] }>("/api/admin/system-prompts");
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [viewing, setViewing] = useState<SystemPromptVersion | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (versions.loading) return <LoadingBlock label={text("正在读取提示词版本", "Loading prompt versions")} />;
  if (versions.error) return <ErrorBlock message={versions.error} onRetry={() => void versions.refresh()} />;
  const all = versions.data?.versions ?? [];
  const canDuplicate = (version: SystemPromptVersion) => ["arena-native-v10", "arena-native-v11"]
    .includes(version.protocolBundleId);
  const startDraft = (source?: SystemPromptVersion) => setDraft({
    name: source ? `${source.name} · ${text("副本", "Copy")}` : "",
    protocolBundleId: source && ["arena-native-v10", "arena-native-v11"].includes(source.protocolBundleId)
      ? source.protocolBundleId
      : "arena-native-v11",
    systemPrompt: source?.systemPrompt ?? "",
  });
  return <>
    <div className="admin-heading"><div><h1>{text("System Prompt 版本", "System prompt versions")}</h1></div><button className="button primary" onClick={() => startDraft()}>{text("新建版本", "New version")}</button></div>
    {notice && <div className="notice success" role="status">{notice}<button aria-label={text("关闭通知", "Dismiss notification")} onClick={() => setNotice(null)}>×</button></div>}
    {error && <div className="notice error" role="alert">{error}<button aria-label={text("关闭错误提示", "Dismiss error")} onClick={() => setError(null)}>×</button></div>}
    <section className="admin-section prompt-version-list">
      {all.map((version) => <article className={`prompt-version-card${version.status === "ARCHIVED" ? " archived" : ""}`} key={version.id}>
        <header><div><div className="prompt-version-kicker"><span>{promptSourceLabel(version.source, locale)}</span>{version.isDefault && <b>{text("默认", "Default")}</b>}{version.status === "ARCHIVED" && <em>{text("已归档", "Archived")}</em>}</div><h2>{version.name}</h2></div><code>{version.sha256.slice(0, 10)}</code></header>
        <dl><div><dt>{text("执行协议", "Protocol")}</dt><dd>{version.protocolBundleId}</dd></div><div><dt>{text("已用于", "Usage")}</dt><dd>{version.tournamentCount} {text("场赛事", "events")} · {version.seriesCount} {text("个系列", "series")}</dd></div><div><dt>{text("保存时间", "Saved")}</dt><dd>{new Date(version.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</dd></div></dl>
        <p className="prompt-version-preview">{version.systemPrompt}</p>
        <footer><button onClick={() => setViewing(version)}>{text("查看全文", "View")}</button>{canDuplicate(version) && <button onClick={() => startDraft(version)}>{text("复制为新版本", "Duplicate")}</button>}{version.source === "CUSTOM" && <button onClick={async () => { try { await apiRequest(`/api/admin/system-prompts/${version.id}/status`, { method: "PATCH", csrfToken, body: JSON.stringify({ archived: version.status !== "ARCHIVED" }) }); setNotice(version.status === "ARCHIVED" ? text("版本已恢复", "Version restored") : text("版本已归档", "Version archived")); await versions.refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : text("状态更新失败", "Unable to update status")); } }}>{version.status === "ARCHIVED" ? text("恢复", "Restore") : text("归档", "Archive")}</button>}</footer>
      </article>)}
    </section>
    {draft && <PromptVersionModal draft={draft} onClose={() => setDraft(null)} onSave={async (next) => { try { await apiRequest("/api/admin/system-prompts", { method: "POST", csrfToken, body: JSON.stringify(next) }); setDraft(null); setNotice(text("提示词版本已保存", "Prompt version saved")); await versions.refresh(); } catch (reason) { throw reason; } }} />}
    {viewing && <Modal title={viewing.name} onClose={() => setViewing(null)}><div className="prompt-version-view"><div><span>{viewing.protocolBundleId}</span><code>SHA-256 {viewing.sha256}</code></div><pre>{viewing.systemPrompt}</pre><div className="modal-actions"><button className="button secondary" onClick={() => setViewing(null)}>{text("关闭", "Close")}</button>{canDuplicate(viewing) && <button className="button primary" onClick={() => { startDraft(viewing); setViewing(null); }}>{text("复制为新版本", "Duplicate")}</button>}</div></div></Modal>}
  </>;
}

function PromptVersionModal({ draft: initial, onClose, onSave }: { draft: PromptDraft; onClose: () => void; onSave: (draft: PromptDraft) => Promise<void> }) {
  const { text } = useUiPreferences();
  const [draft, setDraft] = useState(initial);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal title={text("保存新的提示词版本", "Save new prompt version")} onClose={onClose}>
    <form className="modal-form prompt-version-form" onSubmit={async (event) => { event.preventDefault(); setWorking(true); setError(null); try { await onSave(draft); } catch (reason) { setError(reason instanceof Error ? reason.message : text("保存提示词失败", "Unable to save prompt")); } finally { setWorking(false); } }}>
      <div className="form-grid">
        <label><span>{text("版本名称", "Version name")}</span><input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required autoFocus /></label>
        <label><span>{text("执行协议", "Protocol")}</span><SelectControl value={draft.protocolBundleId} onChange={(protocolBundleId) => setDraft({ ...draft, protocolBundleId })} options={[
          { value: "arena-native-v11", label: "Arena v11" },
          { value: "arena-native-v10", label: "Arena v10" },
        ]} /></label>
        <label className="full"><span>System Prompt</span><textarea rows={22} spellCheck={false} value={draft.systemPrompt} maxLength={100_000} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} required /></label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>{text("取消", "Cancel")}</button><button className="button primary" disabled={working}>{working ? text("保存中…", "Saving…") : text("保存为新版本", "Save version")}</button></div>
    </form>
  </Modal>;
}

const blindLevels = [
  { smallBlind: 100, bigBlind: 200, bigBlindAnte: 0 },
  { smallBlind: 150, bigBlind: 300, bigBlindAnte: 0 },
  { smallBlind: 200, bigBlind: 400, bigBlindAnte: 400 },
  { smallBlind: 300, bigBlind: 600, bigBlindAnte: 600 },
  { smallBlind: 400, bigBlind: 800, bigBlindAnte: 800 },
  { smallBlind: 600, bigBlind: 1200, bigBlindAnte: 1200 },
  { smallBlind: 800, bigBlind: 1600, bigBlindAnte: 1600 },
  { smallBlind: 1000, bigBlind: 2000, bigBlindAnte: 2000 },
  { smallBlind: 1500, bigBlind: 3000, bigBlindAnte: 3000 },
  { smallBlind: 2000, bigBlind: 4000, bigBlindAnte: 4000 },
  { smallBlind: 3000, bigBlind: 6000, bigBlindAnte: 6000 },
  { smallBlind: 4000, bigBlind: 8000, bigBlindAnte: 8000 },
  { smallBlind: 6000, bigBlind: 12000, bigBlindAnte: 12000 },
  { smallBlind: 10000, bigBlind: 20000, bigBlindAnte: 20000 },
];

function NewTournament({ csrfToken }: { csrfToken: string }) {
  const { locale, text } = useUiPreferences();
  const models = useApiResource<{ models: ModelConfig[] }>("/api/admin/models");
  const prompts = useApiResource<{ versions: SystemPromptVersion[] }>("/api/admin/system-prompts");
  const navigate = useNavigate();
  const [name, setName] = useState(`${uiText(locale, "模型锦标赛", "Model Tournament")} · ${new Date().toLocaleDateString(locale)}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [initialStack, setInitialStack] = useState(20_000);
  const [handsPerLevel, setHandsPerLevel] = useState(10);
  const [decisionTimeoutSeconds, setDecisionTimeoutSeconds] = useState(180);
  const [benchmarkSeries, setBenchmarkSeries] = useState(false);
  const [interfaceTrack, setInterfaceTrack] = useState<"native" | "normalized">("native");
  const [historyMode, setHistoryMode] = useState<"query_only" | "disabled">("query_only");
  const [systemPromptVersionId, setSystemPromptVersionId] = useState("");
  const [blindLevelsExpanded, setBlindLevelsExpanded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (models.loading || prompts.loading) return <LoadingBlock label={text("正在读取赛事配置", "Loading tournament configuration")} />;
  if (models.error || prompts.error) return <ErrorBlock message={models.error ?? prompts.error ?? text("服务暂时不可用", "Service temporarily unavailable")} onRetry={() => void Promise.all([models.refresh(), prompts.refresh()])} />;
  const enabledModels = models.data?.models.filter((model) => model.enabled) ?? [];
  const activePrompts = prompts.data?.versions.filter((version) => version.status === "ACTIVE") ?? [];
  const selectedPrompt = activePrompts.find((version) => version.id === systemPromptVersionId)
    ?? activePrompts.find((version) => version.isDefault)
    ?? activePrompts[0];
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 9 ? [...current, id] : current);
  return (
    <div className="tournament-page">
      <div className="admin-heading"><div><h1>{text("创建锦标赛", "Create tournament")}</h1></div><Link className="text-button" to="/admin">{text("放弃并返回", "Cancel")}</Link></div>
      {enabledModels.length < 2 ? <EmptyState title={text("至少需要两个可用模型", "At least two models required")} body={text("先添加并启用模型。", "Add and enable models first.")} action={<Link className="button primary" to="/admin/models">{text("配置模型", "Configure models")}</Link>} /> : <form className="tournament-form" onSubmit={async (event) => { event.preventDefault(); if (selected.length < 2) { setError(text("请选择 2—9 个不同模型", "Select 2–9 different models")); return; } if (!selectedPrompt) { setError(text("没有可用的 System Prompt 版本", "No active system prompt version")); return; } setWorking(true); setError(null); try { const result = await apiRequest<{ tournamentId: string }>(benchmarkSeries ? "/api/admin/benchmark-series" : "/api/admin/tournaments", { method: "POST", csrfToken, body: JSON.stringify({ name, modelConfigIds: selected, initialStack, handsPerLevel, decisionTimeoutMs: decisionTimeoutSeconds * 1_000, blindLevels, interfaceTrack, historyMode, systemPromptVersionId: selectedPrompt.id }) }); navigate(`/?tournament=${result.tournamentId}`); } catch (reason) { setError(reason instanceof Error ? reason.message : text("锦标赛创建失败", "Unable to create tournament")); } finally { setWorking(false); } }}>
        <section className="form-section"><header><div><h2>{text("赛事身份", "Tournament")}</h2></div></header><label className="field-large"><span>{text("赛事名称", "Name")}</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label></section>
        <section className="form-section"><header><div><h2>System Prompt</h2></div><Link className="text-button" to="/admin/prompts">{text("版本管理", "Manage versions")} →</Link></header><label className="field-large"><span>{text("提示词版本", "Prompt version")}</span><SelectControl value={selectedPrompt?.id ?? ""} onChange={setSystemPromptVersionId} options={activePrompts.map((version) => ({ value: version.id, label: `${version.name}${version.isDefault ? ` · ${text("默认", "Default")}` : ""} · ${version.sha256.slice(0, 8)}` }))} /></label>{selectedPrompt && <div className="selected-prompt-summary"><strong>{selectedPrompt.protocolBundleId}</strong><span>SHA-256 {selectedPrompt.sha256}</span><p>{selectedPrompt.systemPrompt}</p></div>}</section>
        <section className="form-section"><header><div><h2>{text("选择模型席位", "Select models")}</h2></div><b>{text("已选", "Selected")} {selected.length} / 9</b></header><div className="model-picker">{enabledModels.map((model) => <button className={selected.includes(model.id) ? "selected" : ""} type="button" onClick={() => toggle(model.id)} key={model.id}><ProviderLogo providerProfile={model.providerProfile} providerType={model.providerType} label={model.providerLabel} baseUrl={model.providerBaseUrl} modelId={model.modelId} fallback={model.displayName.slice(0, 1)} fallbackStyle={modelTint(model.id)} /><div><strong>{model.displayName}</strong><small>{model.providerLabel} · {model.modelId}</small></div><i>{selected.includes(model.id) ? "✓" : "+"}</i></button>)}</div></section>
        <section className="form-section"><header><div><h2>{text("锦标赛结构", "Structure")}</h2></div></header><div className="structure-grid"><label><span>{text("初始筹码", "Starting stack")}</span><input type="number" min={100} max={10_000_000} value={initialStack} onChange={(event) => setInitialStack(Number(event.target.value))} /></label><label><span>{text("每级手数", "Hands per level")}</span><input type="number" min={1} max={1000} value={handsPerLevel} onChange={(event) => setHandsPerLevel(Number(event.target.value))} /></label><label><span>{text("模型调用超时（秒）", "Model timeout (seconds)")}</span><input type="number" min={30} max={600} step={10} value={decisionTimeoutSeconds} onChange={(event) => setDecisionTimeoutSeconds(Number(event.target.value))} /></label><label><span>{text("接口赛道", "Interface track")}</span><SelectControl value={interfaceTrack} onChange={(next) => setInterfaceTrack(next as "native" | "normalized")} options={[
          { value: "native", label: text("Native · 各模型最佳官方输出", "Native · best official output") },
          { value: "normalized", label: text("Normalized · 统一 Prompt JSON", "Normalized · prompt JSON only") },
        ]} /></label><label><span>{text("历史信息", "History access")}</span><SelectControl value={historyMode} onChange={(next) => setHistoryMode(next as "query_only" | "disabled")} options={[
          { value: "query_only", label: text("允许按需查询", "On-demand queries") },
          { value: "disabled", label: text("关闭历史查询", "Disabled") },
        ]} /></label><label className="switch-field"><span><b>{text("公平轮换系列", "Paired benchmark series")}</b><small>{benchmarkSeries ? text(`${selected.length || 2} 场 · 同牌序 · 轮换座位`, `${selected.length || 2} events · same deals · rotating seats`) : text("单场锦标赛", "Single tournament")}</small></span><input className="native-switch" type="checkbox" checked={benchmarkSeries} onChange={(event) => setBenchmarkSeries(event.target.checked)} /></label></div><div className="blind-preview"><span>{text("盲注级别", "Blind levels")}</span>{(blindLevelsExpanded ? blindLevels : blindLevels.slice(0, 7)).map((level, index) => <b key={index}>{level.smallBlind}/{level.bigBlind}{level.bigBlindAnte ? ` + ${text("大盲前注", "BBA")}` : ""}</b>)}<button className="blind-preview-toggle" type="button" aria-expanded={blindLevelsExpanded} onClick={() => setBlindLevelsExpanded((expanded) => !expanded)}>{blindLevelsExpanded ? text("收起 ↑", "Collapse ↑") : text(`另有 ${blindLevels.length - 7} 级 ↓`, `${blindLevels.length - 7} more ↓`)}</button></div></section>
        {error && <p className="form-error standalone">{error}</p>}
        <div className="launch-bar"><div><span>{text("席位准备", "Seats")}</span><strong>{selected.length >= 2 ? `${selected.length} ${text("个模型", "models")} · ${benchmarkSeries ? text(`${selected.length} 场轮换`, `${selected.length} rotations`) : text("单场", "single")} · ${selectedPrompt?.name ?? "—"} · ${interfaceTrack === "native" ? "Native" : "Normalized"} · ${historyMode === "query_only" ? text("可查历史", "history on") : text("无历史", "history off")} · ${formatChips(initialStack)} · ${decisionTimeoutSeconds} ${text("秒超时", "s timeout")}` : text("请选择至少两个模型", "Select at least two models")}</strong></div><button className="button primary launch" disabled={working || selected.length < 2 || !selectedPrompt}>{working ? text("正在锁定配置…", "Locking…") : `${benchmarkSeries ? text("开始公平系列", "Start paired series") : text("开始赛事", "Start tournament")} →`}</button></div>
      </form>}
    </div>
  );
}
