# 开发指南

## 1. 环境

- Node.js ≥ 20，npm。
- Windows：PowerShell 7（运行时的隐藏启动/看门狗脚本需要）。
- 可选：Python 3（`spec:verify` 与部分审计脚本使用）；FFmpeg（B 站视频采样）。

```bash
npm install
npm run build
npm run test:fast
```

## 2. 代码约定

- TypeScript，`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`；不使用 `any`（除非在既有白名单里）。
- 时间必须由装配层传入（`Clock` / `nowMs` / `localHour` 参数），brain 内禁止 `new Date()` / `Date.now()`（`tools/lint/writers.mjs` 会查）。
- 外部副作用只允许出现在装配层与运行时脚本；纯逻辑写成可测的纯函数。
- 一个文件一个主题；`src/engine/` 视为冻结区（新需求优先在插件/编排层实现）。

## 3. 分层与门禁

提交前必须 `npm run gate` 全绿。门禁含义：

| 命令 | 检查 |
| --- | --- |
| `spec:verify` | 规格与实现的对应关系（Python 校验脚本） |
| `spec:lint` | 规格文档格式/引用 |
| `registry:check` | 注册表键全部落地、无孤儿 |
| `superseded:check` | 「谁取代了谁」台账可解析（证据文件/行必须存在） |
| `matrix:check` | 测试矩阵覆盖 |
| `execution:check` | 执行/幂等规则 |
| `voice:check` | 语音格式 |
| `lint:writers` | 时间/随机数/IO 写入者扫描 |
| `edges:check` | R1/R3/R4 分层边 + 债务清单不扩大 |
| `typecheck` | tsc |
| `test:fast` | 全量测试（排除 nightly） |

改动涉及规格/注册表/分层时，还要同步 `docs/` 与 `spec/config/` 台账。

## 4. 测试

```bash
node tools/run-vitest.mjs                       # 全量（含 nightly）
node tools/run-vitest.mjs --exclude "test/nightly/**"   # 与 gate 一致
node tools/run-vitest.mjs test/xxx.test.ts      # 定向
```

测试约定：

- 行为优先于源码字符串；必须锁源码时，锁"调用关系/顺序"而不是整段文本。
- 每个新功能至少一条负向测试（删掉关键接线必须变红）。
- 装配层接线用端到端测试（stub fetch / stub bridge），不要只测单元。

## 5. 加一个功能的标准流程

1. 写规格（`spec/` 或 `docs/`），列清楚边界与验收口径。
2. 独立复核（另一个 agent / 人）通过后再实现。
3. 实现 + 测试 + 负向验证（本地 `tsc`、定向测试、edges）。
4. 实现复核 → 全量门禁（唯一 build+gate 窗口）→ 提交 + 台账。
5. 发布（运行时 `publish-runtime.mjs`），观察 24 小时，再进入下一批。

## 6. 目录新增位置

| 需求 | 放哪 |
| --- | --- |
| 纯状态逻辑 | `src/engine/` |
| 记忆相关 | `src/memory/` |
| 意图/时间/决策 | `src/orchestrator/intent/` |
| 提示词/清洗 | `src/dialogue/` |
| 模型调用 | `src/autonomy/llm.ts` |
| 工具（DSH 工具面） | `src/plugin/` + `src/ports/` |
| 新通道 | `src/qq/` 或 `src/plugin/web/` |
| 夜间任务 | `src/maintenance/` |
| 外部能力 | 独立目录（如 `src/web/`），只依赖 `src/ports` |

## 7. 数据兼容

- 状态文件有版本字段；新增字段必须给默认值并兼容旧文件（读旧写新）。
- 记忆 `encode_ctx` 是开放对象，可加新键，但检索端要容忍缺失。
- 破坏性迁移必须写脚本（`tools/maintenance/`）并在文档里登记回退方式。

## 8. 提交信息

- `feat(scope): F<编号>——<一句话>`；`fix(scope): …`；`docs(...)`。
- 每个 F 编号在 `docs/` 台账里有完整章节（来源、改动、门禁读数、诚实边界、回退）。
