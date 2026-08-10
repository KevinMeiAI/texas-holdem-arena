import { type FormEvent, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { apiRequest, useApiResource } from "./api";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Modal,
  StatusBadge,
  formatChips,
} from "./components";
import type { AdminSession, ArenaState, ModelConfig, ProviderConnection, TournamentSummary } from "./types";

interface AuthPayload { session: AdminSession; csrfToken: string }
interface EmptyAuthPayload { session: null; csrfToken: null }

export function AdminArea() {
  const session = useApiResource<AuthPayload | EmptyAuthPayload>("/api/auth/session");
  if (session.loading) return <main className="admin-gate"><LoadingBlock label="正在确认控制室权限" /></main>;
  if (!session.data?.session || !session.data.csrfToken) {
    return <LoginScreen onLogin={(payload) => session.setData(payload)} />;
  }
  const authenticated = session.data;
  return (
    <div className="admin-shell">
      <aside className="admin-rail">
        <Link className="admin-wordmark" to="/"><span>A♠</span><div><strong>德扑竞技场</strong><small>赛事控制室</small></div></Link>
        <nav aria-label="控制室导航">
          <NavLink to="/admin" end>总览</NavLink>
          <NavLink to="/admin/models">模型与 API</NavLink>
          <NavLink to="/admin/tournaments/new">创建赛事</NavLink>
          <Link to="/tournaments">赛事档案</Link>
        </nav>
        <div className="admin-identity"><span>{authenticated.session.email.slice(0, 1).toUpperCase()}</span><div><strong>{authenticated.session.email}</strong><small>本机管理员</small></div></div>
        <button className="rail-logout" onClick={async () => {
          await apiRequest("/api/auth/logout", { method: "POST", csrfToken: authenticated.csrfToken });
          session.setData(null);
        }}>退出登录</button>
      </aside>
      <main className="admin-main">
        <Routes>
          <Route path="/admin" element={<AdminDashboard csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/models" element={<ModelsAdmin csrfToken={authenticated.csrfToken} />} />
          <Route path="/admin/tournaments/new" element={<NewTournament csrfToken={authenticated.csrfToken} />} />
        </Routes>
      </main>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (payload: AuthPayload) => void }) {
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
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally { setWorking(false); }
  };
  return (
    <main className="login-screen">
      <Link className="back-home" to="/">← 返回直播间</Link>
      <section className="login-editorial"><h1>进入赛事<br /><span>控制室</span></h1><p>API 密钥在写入前由 AES-256-GCM 加密；浏览器不会再次读到密钥原文。</p><div className="login-proof"><span>Argon2id</span><span>HttpOnly 会话</span><span>CSRF 防护</span></div></section>
      <form className="login-form" onSubmit={submit}>
        <header><span>A♠</span><div><p>本机管理</p><h2>身份验证</h2></div></header>
        <label><span>管理员邮箱</span><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="button primary wide" disabled={working}>{working ? "验证中…" : "进入控制室"}</button>
        <small>仅限本机管理员。会话有效期为 7 天。</small>
      </form>
    </main>
  );
}

function AdminDashboard({ csrfToken }: { csrfToken: string }) {
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
    } catch (reason) { setCommandError(reason instanceof Error ? reason.message : "赛事指令执行失败"); }
  };
  return (
    <>
      <div className="admin-heading"><div><h1>赛事控制台</h1><p>查看当前单桌赛事并处理运行状态</p></div><Link className="button primary" to="/admin/tournaments/new">创建锦标赛</Link></div>
      <div className="admin-metrics"><article><span>历史赛事</span><b>{tournaments.data?.tournaments.length ?? "—"}</b><small>全部已保存</small></article><article><span>当前状态</span>{state ? <StatusBadge status={state.status} /> : <b className="metric-status">空闲</b>}<small>单桌运行</small></article><article><span>已完成手数</span><b>{state?.completedHands ?? 0}</b><small>当前赛事</small></article><article><span>模型席位</span><b>{state?.players.length ?? 0}</b><small>支持 2—9 席</small></article></div>
      <section className="admin-live-card">
        <header><div><h2>{state?.name ?? "没有正在进行的赛事"}</h2><p>{state ? "当前牌桌" : "牌桌空闲"}</p></div>{state && <StatusBadge status={state.status} />}</header>
        {state ? <>
          <div className="control-state"><div><span>当前牌局</span><b>第 {String(state.hand?.handNo ?? state.completedHands).padStart(3, "0")} 手</b></div><div><span>盲注</span><b>{formatChips(state.hand?.blinds.smallBlind)} / {formatChips(state.hand?.blinds.bigBlind)}</b></div><div><span>行动席位</span><b>{state.players.find((player) => player.id === state.hand?.currentActorId)?.displayName ?? "—"}</b></div></div>
          <div className="control-actions">
            {state.status === "RUNNING" && <button className="button secondary" onClick={() => void command("pause")}>暂停</button>}
            {state.status === "PAUSED_INFRA" && <button className="button primary" onClick={() => void command("resume")}>继续</button>}
            {!(["COMPLETED", "CANCELLED"] as string[]).includes(state.status) && <button className="button danger" onClick={() => void command("cancel")}>取消赛事</button>}
            <Link className="text-button" to="/">打开直播间 ↗</Link>
          </div>
          {commandError && <p className="form-error">{commandError}</p>}
        </> : <EmptyState title="牌桌空闲" body="配置至少两个模型，即可开启一场完整的单桌锦标赛。" action={<Link className="button primary" to="/admin/tournaments/new">配置新赛事</Link>} />}
      </section>
      <section className="ops-notes"><div><h3>模型故障不罚牌</h3><p>429、5xx、网络或超时重试后，赛事停在同一决策点。</p></div><div><h3>隐私由服务端投影</h3><p>未结束牌局的隐藏底牌不会发送给观众浏览器。</p></div><div><h3>每次落库皆可验证</h3><p>事件哈希链、CAS 版本与快照共同守住权威状态。</p></div></section>
    </>
  );
}

type ProviderDraft = { label: string; providerType: string; providerProfile: string; defaultOutputMode: string; baseUrl: string; apiKey: string };
type ModelDraft = { displayName: string; providerConnectionId: string; modelId: string; outputMode: string; parameters: string };
const emptyProvider: ProviderDraft = { label: "", providerType: "openai-responses", providerProfile: "auto", defaultOutputMode: "auto", baseUrl: "", apiKey: "" };
const emptyModel: ModelDraft = { displayName: "", providerConnectionId: "", modelId: "", outputMode: "inherit", parameters: "{}" };

const outputModeLabel = (mode: string) => ({
  auto: "自动选择",
  inherit: "继承 Provider",
  json_schema: "JSON Schema",
  json_object: "JSON Object",
  prompt: "仅提示词约束",
}[mode] ?? mode);

const providerProfileLabel = (profile: string) => ({
  auto: "自动识别",
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  zhipu: "智谱 GLM",
  generic: "通用兼容",
}[profile] ?? profile);

function ModelsAdmin({ csrfToken }: { csrfToken: string }) {
  const providers = useApiResource<{ providers: ProviderConnection[] }>("/api/admin/providers");
  const models = useApiResource<{ models: ModelConfig[] }>("/api/admin/models");
  const [providerDialog, setProviderDialog] = useState<{ draft: ProviderDraft; editing?: ProviderConnection } | null>(null);
  const [modelDialog, setModelDialog] = useState<{ draft: ModelDraft; editing?: ModelConfig } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "provider" | "model"; id: string; label: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflighting, setPreflighting] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([providers.refresh(), models.refresh()]); };

  if (providers.loading || models.loading) return <LoadingBlock label="正在读取模型配置" />;
  if (providers.error || models.error) return <ErrorBlock message={providers.error ?? models.error ?? "服务暂时不可用"} onRetry={() => void refresh()} />;
  return (
    <>
      <div className="admin-heading"><div><h1>模型与 API</h1><p>集中管理连接、密钥和参赛模型</p></div><div className="button-row"><button className="button secondary" onClick={() => setProviderDialog({ draft: emptyProvider })}>新增 Provider</button><button className="button primary" disabled={(providers.data?.providers.length ?? 0) === 0} onClick={() => setModelDialog({ draft: { ...emptyModel, providerConnectionId: providers.data!.providers[0]!.id } })}>新增模型</button></div></div>
      {notice && <div className="notice success" role="status">{notice}<button aria-label="关闭通知" onClick={() => setNotice(null)}>×</button></div>}
      {error && <div className="notice error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError(null)}>×</button></div>}
      <section className="admin-section"><div className="admin-section-title"><div><h2>API 连接</h2></div><p>密钥只写不读 · 仅显示末四位</p></div>
        {(providers.data?.providers.length ?? 0) === 0 ? <EmptyState title="尚未配置 Provider" body="先连接 OpenAI、Anthropic、Gemini 或兼容端点。" /> : <div className="provider-grid">{providers.data!.providers.map((provider) => <article className="provider-card" key={provider.id}><header><span className="provider-glyph">{provider.label.slice(0, 2).toUpperCase()}</span><div><h3>{provider.label}</h3><p>{provider.providerType}</p></div><i className={provider.hasApiKey ? "ready" : "local"} /></header><dl><div><dt>兼容档案</dt><dd>{providerProfileLabel(provider.providerProfile)}</dd></div><div><dt>默认输出</dt><dd>{outputModeLabel(provider.defaultOutputMode)}</dd></div><div><dt>服务端点</dt><dd>{provider.baseUrl || "官方服务"}</dd></div><div><dt>API 密钥</dt><dd>{provider.hasApiKey ? `•••• ${provider.keyLastFour}` : "无需密钥"}</dd></div></dl><footer><button onClick={() => setProviderDialog({ editing: provider, draft: { label: provider.label, providerType: provider.providerType, providerProfile: provider.providerProfile, defaultOutputMode: provider.defaultOutputMode, baseUrl: provider.baseUrl ?? "", apiKey: "" } })}>编辑</button><button onClick={() => setConfirmDelete({ kind: "provider", id: provider.id, label: provider.label })}>删除</button></footer></article>)}</div>}
      </section>
      <section className="admin-section"><div className="admin-section-title"><div><h2>模型列表</h2></div><p>赛事席位使用已冻结的模型配置</p></div>
        {(models.data?.models.length ?? 0) === 0 ? <EmptyState title="还没有模型" body="一个 Provider 可以创建多个模型配置；每场比赛至少选择两个。" /> : <div className="model-table"><div className="model-table-head"><span>显示名 / 模型</span><span>Provider</span><span>有效输出</span><span>状态</span><span /></div>{models.data!.models.map((model) => <article key={model.id}><div className="model-cell-main"><span className="model-monogram">{model.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{model.displayName}</strong><small>{model.modelId}</small></div></div><span data-label="Provider">{model.providerLabel}</span><code className={model.outputModeSupported ? "" : "policy-issue"} data-label="有效输出" title={model.outputModeMessage ?? `${providerProfileLabel(model.effectiveProviderProfile)} · ${outputModeLabel(model.outputMode)}`}>{outputModeLabel(model.effectiveOutputMode)}{model.outputModeSupported ? "" : " · 配置冲突"}</code><button className={`enable-toggle ${model.enabled ? "on" : ""}`} aria-label={`${model.enabled ? "停用" : "启用"} ${model.displayName}`} onClick={async () => { await apiRequest(`/api/admin/models/${model.id}`, { method: "PATCH", csrfToken, body: JSON.stringify({ enabled: !model.enabled }) }); await models.refresh(); }}><i /></button><div className="row-actions"><button disabled={preflighting === model.id} onClick={async () => { setPreflighting(model.id); setError(null); setNotice(null); try { const response = await apiRequest<{ result: { ok: boolean; latencyMs: number; effectiveMode: string; checks: { expectedOutput: string; ok: boolean; message: string }[] } }>(`/api/admin/models/${model.id}/preflight`, { method: "POST", csrfToken }); if (response.result.ok) setNotice(`${model.displayName} 预检通过 · ${outputModeLabel(response.result.effectiveMode)} · 两类决策共 ${response.result.latencyMs}ms`); else setError(`${model.displayName} 预检失败：${response.result.checks.filter((check) => !check.ok).map((check) => `${check.expectedOutput}: ${check.message}`).join("；")}`); } catch (reason) { setError(reason instanceof Error ? reason.message : "模型预检失败"); } finally { setPreflighting(null); } }}>{preflighting === model.id ? "检测中" : "预检"}</button><button onClick={() => setModelDialog({ editing: model, draft: { displayName: model.displayName, providerConnectionId: model.providerConnectionId, modelId: model.modelId, outputMode: model.outputMode, parameters: JSON.stringify(model.parameters, null, 2) } })}>编辑</button><button onClick={() => setConfirmDelete({ kind: "model", id: model.id, label: model.displayName })}>删除</button></div></article>)}</div>}
      </section>
      {providerDialog && <ProviderModal value={providerDialog} onClose={() => setProviderDialog(null)} onSave={async (draft, editing) => { const payload: Record<string, unknown> = { label: draft.label, providerType: draft.providerType, providerProfile: draft.providerProfile, defaultOutputMode: draft.defaultOutputMode, baseUrl: draft.baseUrl || null }; if (draft.apiKey || !editing) payload.apiKey = draft.apiKey || null; await apiRequest(editing ? `/api/admin/providers/${editing.id}` : "/api/admin/providers", { method: editing ? "PATCH" : "POST", csrfToken, body: JSON.stringify(payload) }); setProviderDialog(null); setNotice(editing ? "Provider 已更新" : "Provider 已创建"); await refresh(); }} />}
      {modelDialog && <ModelModal value={modelDialog} providers={providers.data?.providers ?? []} onClose={() => setModelDialog(null)} onSave={async (draft, editing) => { const payload = { displayName: draft.displayName, providerConnectionId: draft.providerConnectionId, modelId: draft.modelId, outputMode: draft.outputMode, parameters: JSON.parse(draft.parameters) as unknown }; await apiRequest(editing ? `/api/admin/models/${editing.id}` : "/api/admin/models", { method: editing ? "PATCH" : "POST", csrfToken, body: JSON.stringify(payload) }); setModelDialog(null); setNotice(editing ? "模型配置已更新" : "模型配置已创建"); await refresh(); }} />}
      {confirmDelete && <Modal title={`删除 ${confirmDelete.label}？`} onClose={() => setConfirmDelete(null)}><div className="confirm-body"><p>{confirmDelete.kind === "provider" ? "仍被模型使用的 Provider 会被服务端拒绝删除。" : "历史赛事不会被删除；当前赛事使用的冻结配置不受影响。"}</p><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setConfirmDelete(null)}>取消</button><button className="button danger" type="button" onClick={async () => { try { await apiRequest(`/api/admin/${confirmDelete.kind === "provider" ? "providers" : "models"}/${confirmDelete.id}`, { method: "DELETE", csrfToken }); setNotice(`${confirmDelete.label} 已删除`); setConfirmDelete(null); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); setConfirmDelete(null); } }}>确认删除</button></div></div></Modal>}
    </>
  );
}

function ProviderModal({ value, onClose, onSave }: { value: { draft: ProviderDraft; editing?: ProviderConnection }; onClose: () => void; onSave: (draft: ProviderDraft, editing?: ProviderConnection) => Promise<void> }) {
  const [draft, setDraft] = useState(value.draft);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return <Modal title={value.editing ? "编辑 Provider" : "新增 Provider"} onClose={onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); setWorking(true); setError(null); try { await onSave(draft, value.editing); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存连接失败"); } finally { setWorking(false); } }}><div className="form-grid"><label><span>名称</span><input autoComplete="organization" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} required autoFocus /></label><label><span>接口协议</span><select value={draft.providerType} onChange={(event) => setDraft({ ...draft, providerType: event.target.value })}><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-gemini">Google Gemini</option><option value="openai-compatible">OpenAI-compatible</option><option value="mock-scripted">本机模拟策略</option></select></label><label><span>供应商兼容档案 <small>决定自动模式</small></span><select value={draft.providerProfile} onChange={(event) => setDraft({ ...draft, providerProfile: event.target.value })}><option value="auto">自动识别</option><option value="openai">OpenAI</option><option value="anthropic">Claude</option><option value="gemini">Gemini</option><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option><option value="zhipu">智谱 GLM</option><option value="generic">通用兼容端点</option></select></label><label><span>默认输出方式 <small>模型可单独覆盖</small></span><select value={draft.defaultOutputMode} onChange={(event) => setDraft({ ...draft, defaultOutputMode: event.target.value })}><option value="auto">自动选择（推荐）</option><option value="json_schema">JSON Schema</option><option value="json_object">JSON Object</option><option value="prompt">仅提示词约束</option></select></label><label className="full"><span>Base URL <small>可选</small></span><input type="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label><label className="full"><span>API Key <small>{value.editing ? "留空则保持不变" : "本机模拟可留空"}</small></span><input type="password" autoComplete="new-password" placeholder={value.editing && value.editing.hasApiKey ? `当前 •••• ${value.editing.keyLastFour}` : "sk-…"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label></div><p className="form-help">自动策略：OpenAI、Claude、Gemini 与 Kimi K3 优先使用 JSON Schema；DeepSeek、智谱及通用兼容端点使用 JSON Object。</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={working}>{working ? "保存中…" : "保存连接"}</button></div></form></Modal>;
}

function ModelModal({ value, providers, onClose, onSave }: { value: { draft: ModelDraft; editing?: ModelConfig }; providers: ProviderConnection[]; onClose: () => void; onSave: (draft: ModelDraft, editing?: ModelConfig) => Promise<void> }) {
  const [draft, setDraft] = useState(value.draft);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return <Modal title={value.editing ? "编辑模型" : "新增模型"} onClose={onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); setWorking(true); setError(null); try { const parsed = JSON.parse(draft.parameters) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("参数必须是 JSON 对象"); await onSave(draft, value.editing); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存模型失败"); } finally { setWorking(false); } }}><div className="form-grid"><label><span>显示名称</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} required autoFocus /></label><label><span>Provider</span><select value={draft.providerConnectionId} onChange={(event) => setDraft({ ...draft, providerConnectionId: event.target.value })}>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label}</option>)}</select></label><label className="full"><span>模型 ID</span><input placeholder="gpt-5 / claude-sonnet-4-5 / gemini-2.5-pro" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} required /></label><label className="full"><span>输出策略 <small>显式选择不兼容模式时，预检会报配置错误</small></span><select value={draft.outputMode} onChange={(event) => setDraft({ ...draft, outputMode: event.target.value })}><option value="inherit">继承 Provider（推荐）</option><option value="auto">按模型自动选择</option><option value="json_schema">强制 JSON Schema</option><option value="json_object">强制 JSON Object</option><option value="prompt">仅提示词约束</option></select></label><label className="full"><span>原生参数 JSON</span><textarea rows={6} spellCheck={false} value={draft.parameters} onChange={(event) => setDraft({ ...draft, parameters: event.target.value })} /></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={working}>{working ? "保存中…" : "保存模型"}</button></div></form></Modal>;
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
  const models = useApiResource<{ models: ModelConfig[] }>("/api/admin/models");
  const navigate = useNavigate();
  const [name, setName] = useState(`模型锦标赛 · ${new Date().toLocaleDateString("zh-CN")}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [initialStack, setInitialStack] = useState(20_000);
  const [handsPerLevel, setHandsPerLevel] = useState(10);
  const [runTwice, setRunTwice] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (models.loading) return <LoadingBlock label="正在读取可用模型" />;
  if (models.error) return <ErrorBlock message={models.error} onRetry={() => void models.refresh()} />;
  const enabledModels = models.data?.models.filter((model) => model.enabled) ?? [];
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 9 ? [...current, id] : current);
  return (
    <>
      <div className="admin-heading"><div><h1>创建锦标赛</h1><p>选择 2—9 个模型，统一使用平台冻结的竞技协议</p></div><Link className="text-button" to="/admin">放弃并返回</Link></div>
      {enabledModels.length < 2 ? <EmptyState title="至少需要两个可用模型" body="先添加并启用模型配置，再回到这里创建比赛。" action={<Link className="button primary" to="/admin/models">配置模型</Link>} /> : <form className="tournament-form" onSubmit={async (event) => { event.preventDefault(); if (selected.length < 2) { setError("请选择 2—9 个不同模型"); return; } setWorking(true); setError(null); try { const result = await apiRequest<{ tournamentId: string }>("/api/admin/tournaments", { method: "POST", csrfToken, body: JSON.stringify({ name, modelConfigIds: selected, initialStack, handsPerLevel, blindLevels, runItTwiceEnabled: runTwice }) }); navigate(`/?tournament=${result.tournamentId}`); } catch (reason) { setError(reason instanceof Error ? reason.message : "锦标赛创建失败"); } finally { setWorking(false); } }}>
        <section className="form-section"><header><div><h2>赛事身份</h2><p>名称会出现在直播、档案与榜单样本中。</p></div></header><label className="field-large"><span>赛事名称</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label></section>
        <section className="form-section"><header><div><h2>选择模型席位</h2><p>正式座位与初始按钮由赛事随机种子决定。</p></div><b>已选 {selected.length} / 9</b></header><div className="model-picker">{enabledModels.map((model) => <button className={selected.includes(model.id) ? "selected" : ""} type="button" onClick={() => toggle(model.id)} key={model.id}><span className="model-monogram">{model.displayName.slice(0, 1)}</span><div><strong>{model.displayName}</strong><small>{model.providerLabel} · {model.modelId}</small></div><i>{selected.includes(model.id) ? "✓" : "+"}</i></button>)}</div></section>
        <section className="form-section"><header><div><h2>锦标赛结构</h2><p>无补码、筹码归零即淘汰；盲注按完成手数升级。</p></div></header><div className="structure-grid"><label><span>初始筹码</span><input type="number" min={100} max={10_000_000} value={initialStack} onChange={(event) => setInitialStack(Number(event.target.value))} /></label><label><span>每级手数</span><input type="number" min={1} max={1000} value={handsPerLevel} onChange={(event) => setHandsPerLevel(Number(event.target.value))} /></label><label className="switch-field"><span><b>多次发牌协商（Run It Twice）</b><small>全下锁定后依次投票</small></span><button className={`enable-toggle ${runTwice ? "on" : ""}`} aria-label={`${runTwice ? "关闭" : "开启"}多次发牌协商`} type="button" onClick={() => setRunTwice(!runTwice)}><i /></button></label></div><div className="blind-preview"><span>盲注级别</span>{blindLevels.slice(0, 7).map((level, index) => <b key={index}>{level.smallBlind}/{level.bigBlind}{level.bigBlindAnte ? " + 大盲前注" : ""}</b>)}<em>另有 7 级</em></div></section>
        {error && <p className="form-error standalone">{error}</p>}
        <div className="launch-bar"><div><span>席位准备</span><strong>{selected.length >= 2 ? `${selected.length} 个模型 · ${formatChips(initialStack)} 起始筹码` : "请选择至少两个模型"}</strong></div><button className="button primary launch" disabled={working || selected.length < 2}>{working ? "正在锁定配置…" : "锁定并开始赛事 →"}</button></div>
      </form>}
    </>
  );
}
