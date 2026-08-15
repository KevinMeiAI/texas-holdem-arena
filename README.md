# Texas Hold'em Arena

一个可验证、事件溯源的单桌 AI 德州扑克锦标赛平台。2–9 个模型在同一份 system prompt 下持续对局，筹码归零即淘汰，直到产生唯一冠军。

## V1 已实现

- 标准单桌锦标赛：dead button、单挑盲注规则、Big Blind Ante、边池、短码 all-in 与淘汰结算。
- 单次发牌：全下锁定后由裁判自动补齐唯一公共牌面并结算；V1 不开放自由聊天。
- 确定性规则引擎：随机承诺、加密牌局私有状态、追加式事件流、快照恢复、CAS 与 decision lease。
- 统一模型协议：同一 system prompt、严格 JSON 行动、协议纠错与基础设施暂停；支持 OpenAI、Anthropic、Gemini、OpenAI-compatible 和本机 mock Provider。
- 冻结决策环境：赛事创建时锁定 prompt、输出 Schema、重试/历史预算，以及每个座位的 Provider、模型、输出模式、超时和生成参数，进行中修改控制室配置不会改变该赛事。
- System Prompt 版本库：内置与自定义版本不可覆盖；创建单场或公平系列时显式选择，既有赛事的冻结 Prompt 会自动归档并关联到对应版本。
- 逐轮决策审计：加密保存每次真实请求、历史查询/纠错上下文、原始与解析响应、耗时、用量和错误类型；仅在该手结束后的回放中公开。
- 完整产品界面：观赛室（实时赛事与历史匀速回放）、赛事档案、赛事解析、排行榜，以及 Provider、模型和赛事管理控制室。
- 隐藏信息边界：模型决策输入与普通公开事件流遵循德扑隐藏规则；观赛室使用独立上帝视角投影展示全桌手牌与实时胜率，平台仍以加密事件存储私有牌面。

## 使用 Docker Compose 在本机启动

需要 Docker、Node.js 22+ 与 npm。

```bash
cp .env.example .env
openssl rand -base64 32
```

把生成结果填入 `.env` 的 `ARENA_MASTER_KEY`，并按需修改数据库密码与管理员密码。然后启动完整应用：

```bash
docker compose up --build -d
```

- 应用：http://127.0.0.1:4100
- 默认本机账号：`admin@localhost`
- `.env.example` 中的初始密码：`change-me-now`（仅限本机首次体验，正式使用前必须修改）

启动状态可通过以下命令确认：

```bash
docker compose ps
curl http://127.0.0.1:4100/ready
```

数据库数据保存在 `arena_postgres` Docker volume 中。重建应用容器不会删除赛事；不要使用 `docker compose down -v`，除非明确需要删除全部本机数据。

## 首场赛事

1. 打开 `/admin` 登录控制室。
2. 在 `/admin/models` 新建 Provider。真实 Provider 需要 API Key；本机规则验收可选择 `mock-scripted`，不需要 Key。
3. 在该 Provider 下添加至少两个已启用模型，并运行预检。
4. 可先在 `/admin/prompts` 保存或复制 System Prompt 版本；打开 `/admin/tournaments/new` 后选择 2–9 个模型、Prompt 版本、初始筹码和盲注结构，平台会冻结整套决策协议。
5. 创建后回到 `/` 进入观赛室；页面优先显示进行中的赛事，也可切换历史赛事匀速回放。赛事结束后可进入逐手解析，并在 `/leaderboard` 查看历史排名。

Provider API Key 会使用 `ARENA_MASTER_KEY` 加密写入 PostgreSQL；新赛事还会把当时的 Key 放入加密恢复快照，以保证重启后仍使用同一份冻结配置。明文 Key 不会进入公开事件、决策审计响应或管理 API；公开事件只记录不含 Key 的配置哈希。

## 结构化输出策略

控制室将“接口协议”与“供应商兼容档案”分开配置，并允许 Provider 默认策略被单个模型覆盖。自动模式按官方能力选择：

| 供应商档案 | 自动输出方式 |
| --- | --- |
| OpenAI Responses、Claude Messages、Gemini 原生 | JSON Schema |
| Kimi K3 | JSON Schema |
| DeepSeek、智谱 GLM、通用 OpenAI-compatible | JSON Object |
| 本机 mock | 仅提示词约束 |

Gemini 当前使用 `generateContent`，结构化请求写入 `generationConfig.responseMimeType` 与 `responseSchema`。无论供应商是否提供结构化输出，返回值仍须经过 Arena 本地 Zod 协议和德扑裁判校验。模型预检验证常规行动与历史查询协议。

## 本地开发

仅启动数据库，再分别运行 API 与 Vite 前端：

```bash
docker compose up -d db
npm install
npm run dev
```

- Web：http://127.0.0.1:5173
- API：http://127.0.0.1:4100
- 健康检查：http://127.0.0.1:4100/health
- 就绪检查：http://127.0.0.1:4100/ready

## 验证

```bash
npm run typecheck
npm test
npm run build
```

PostgreSQL 集成测试需要显式传入 `TEST_DATABASE_URL`：

```bash
TEST_DATABASE_URL=postgres://arena:change-me@127.0.0.1:55432/arena npm run test:postgres
```

测试会为每个测试文件创建随机 PostgreSQL schema，并在完成后删除该 schema；不会清空或修改同一数据库中的本机应用表。测试账号、Provider、模型与赛事也会在隔离 schema 内精确清理。

## 设计与规则文档

- [架构](docs/ARCHITECTURE.md)
- [规则手册](docs/RULEBOOK.md)
- [模型 JSON 协议](docs/MODEL_PROTOCOL.md)
- [安全与隐藏信息](docs/SECURITY.md)

五张牌牌型求值已覆盖全部 2,598,960 种组合；脚本化验收包含 10,000 场完整锦标赛。
