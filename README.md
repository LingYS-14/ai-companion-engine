# AI Companion Engine

一个可以长期运行的 AI 伙伴内核：有自己的时间感、能量与睡眠节律、长期记忆、自主意图，以及两条聊天通道（QQ / 网页工作台），默认通过 DeepSeek 的 OpenAI 兼容接口调用模型。

> 这不是聊天机器人框架，而是一个「有状态」的陪伴内核：
> 每 5 分钟一个 tick，由她自己判断要不要开口；记住发生过的事；睡觉时做记忆巩固；
> 你暂时不说话，她也仍然是活的。

## 特性

- **长期记忆**：JSONL 写前日志（WAL）+ SQLite 索引，支持回忆、再巩固、遗忘与冷归档。
- **自主意图**：意图引擎每拍竞争（reach_out / continue_thread / repair…），带 30 分钟同类刹车、重复抑制、lookahead 到点浮现。
- **时间与节律**：事实化时间行、睡眠窗口、能量模型（清醒耗能、睡眠恢复）、由真实作息采样出的昼夜节律。
- **夜间功课**：入睡后自动做 fade（鲜明度衰减）、记忆整合（consolidate）、冷归档，可选 dream shadow。
- **双通道**：QQ（OneBot v11 桥）与网页工作台（`/soul` 面板 + 对话页）共享同一份记忆与历史。
- **模型分层**：对话走 `deepseek-v4-pro`（thinking），自述/主动/学习摘要走 `deepseek-flash`；用量与缓存命中入账。
- **可审计**：11 道工程门禁（规格、注册表、分层边、写入者扫描、类型检查、全量测试等），改动必须过门禁并留台账。

## 快速开始

要求：Node.js ≥ 20、npm；Windows PowerShell 7（仅自治运行时的隐藏启动器需要）。

```bash
npm install
npm run build
npm run test:fast        # 全量测试（不含 nightly）
npm run gate             # 11 道门禁（CI 用）
```

作为 DSH（DeepSeek Harness）插件运行：

1. 把本仓库放到任意目录，`npm install && npm run build`。
2. 把 `cordis.patch.yml` 放进 DSH profile 的补丁目录，按注释改 `dataDir` / `characterId` / `displayName`。
3. 重启 DSH：工具面会出现 `soul_*` 工具（27 个），Web 端出现「工作台」页面（`/soul`）。

独立自治运行时（后台常驻，不依赖 DSH）：

```bash
npm run start      # 启动（Windows：隐藏窗口 powershell）
npm run stop       # 停止
node scripts/autonomy/health.mjs   # 健康检查
```

## 配置

所有配置都可用环境变量覆盖（前缀 `ACE_`），常用项：

| 变量 | 说明 |
| --- | --- |
| `ACE_DATA_DIR` | 数据目录（状态、记忆、日志） |
| `ACE_CHARACTER_ID` | 角色 id（数据文件名的一部分） |
| `ACE_LLM_API_KEY` | 模型 API key（也可用 DPAPI 加密存放） |
| `ACE_LLM_BASE_URL` | OpenAI 兼容端点，默认 `https://api.deepseek.com` |
| `ACE_LLM_MODEL` | 默认（flash）档模型，默认 `deepseek-flash` |
| `ACE_LLM_MODEL_PRO` | 高质量档模型，默认 `deepseek-v4-pro` |
| `ACE_LLM_TIMEOUT_MS` | 单次模型调用超时，默认 90000 |
| `ACE_DREAM_SHADOW` | 是否记录 dream shadow（只写审计文件，不入记忆） |
| `ACE_LOOKAHEAD` | 设为 `0` 关闭「到点浮现」读侧 |

QQ 桥（OneBot v11）配置在 `cordis.patch.yml` 的 `qq` 字段：`enabled` / `dryRun` / `baseUrl` / `wsUrl` / `token` / `peer` 等。

## 架构一览

```
src/
  engine/      纯状态机：能量、睡眠、关系、情绪（无 IO）
  memory/      记忆存储、回忆、再巩固、生命周期
  orchestrator/意图引擎（竞争、刹车、lookahead）、时间观、turn
  dialogue/    提示词组装、身份协议、清理、回声守卫
  autonomy/    自治运行时：LLM、tick 循环、chat-turn、pricing、chat-log
  qq/          QQ 桥：OneBot / 窗口桥、host 控制
  web/         网页搜索/抓取能力（learning 与工具共用）
  plugin/      DSH 插件：工具面、面板、Web 路由、写通道
  ports/       端口接口（brain→spine/tools 的唯一门面）
  assembly/    装配层（把各部分接在一起，不含业务逻辑）
  maintenance/ 夜间功课、selftalk、dream、记忆卫生
  learning/    B 站学习、知识库、好奇心
  firewall/    内容与来源防火墙
  psychology/  依恋、情绪、关系策略
  execution/   幂等、重试、执行原语
  trace/       追踪与观测
  contracts/   纯类型契约
  bili/        B 站 API
  desktop/     桌面观察（只读）
scripts/autonomy/   运行时脚本（main.mjs 是装配点）、部署/启动/健康检查
spec/               规格台账、注册表、分层规则、能力映射
tools/              门禁、审计、报告、维护、意图工具
lib/soul/           工作台前端（静态页）
test/               286 测试文件
```

更详细说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DESIGN.md](docs/DESIGN.md)、[docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 工程门禁

`npm run gate` 依次跑 11 道检查：规格校验、规格 lint、注册表、superseded 台账、测试矩阵、执行规则、语音、写入者扫描、分层边、类型检查、全量测试。任何一项失败都不允许提交。

## 隐私与安全

- 本仓库不包含任何真实用户数据、聊天记录、QQ 号、API key 或本机路径；`data/` 与 `dist/` 不入库。
- API key 建议通过环境变量或 DPAPI 加密文件提供，不要写进仓库。
- QQ 桥只连接你配置的 OneBot 实现；`dryRun: true` 可以只生成不发送。
- 详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 许可

MIT。示例角色卡（`persona/example.json`）与 `assets/avatar.png` 为占位示例，可自由替换。
