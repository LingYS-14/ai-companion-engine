# 贡献指南

感谢你愿意参与！bug 报告、文档修订和代码改动都欢迎：请先开 issue 说明背景与目标，再提 PR。

## 1. 环境要求

- Node.js ≥ 20（CI 使用 Node 22）
- npm（随 Node 安装）
- Python 3（`spec:verify` 与部分审计脚本需要）
- git

## 2. 本地开发步骤

```bash
git clone https://github.com/LingYS-14/ai-companion-engine.git
cd ai-companion-engine
npm ci
npm run build
npm run gate
```

- `npm ci`：按 `package-lock.json` 精确安装依赖，保证与 CI 一致；不要在 PR 里顺手改锁文件，除非确实增减了依赖。
- `npm run build`：`tsc` 编译到 `dist/`，确认类型与产物没问题。
- `npm run gate`：本地跑一遍完整门禁（见下一节），提交前必须全绿。

## 3. 提交前必须跑的门禁

`npm run gate` 是提交前的唯一硬门槛，任何一项失败都不要提交。它依次执行 11 项检查：

| 检查 | 内容 |
| --- | --- |
| `spec:verify` | 规格与实现的对应关系（Python 校验脚本） |
| `spec:lint` | 规格文档格式与引用 |
| `registry:check` | 注册表键全部落地、无孤儿 |
| `superseded:check` | 「谁取代了谁」台账可解析（证据文件/行存在） |
| `matrix:check` | 测试矩阵覆盖 |
| `execution:check` | 执行/幂等规则 |
| `voice:check` | 语音格式 |
| `lint:writers` | 时间/随机数/IO 写入者扫描 |
| `edges:check` | 分层边规则与债务清单不扩大 |
| `typecheck` | `tsc --noEmit` |
| `test:fast` | 全量测试（不含 nightly） |

需要快速定位时，可以单独跑对应子命令（如 `npm run typecheck`、`npm run test:fast`），但最终仍以完整 `npm run gate` 为准。CI 会再跑一遍 `npm ci` → `npm run build` → `npm run gate`，本地全绿不代替 CI 绿。

## 4. PR 流程

1. **从最新 `main` 开分支**，一个 PR 只做一件事，避免混入无关改动。
2. **小步提交**：每个提交保持可读、可回退；提交信息沿用 `feat(scope): …`、`fix(scope): …`、`docs(...)` 等形式，详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
3. **说明改了什么和为什么**：PR 标题写结论，描述里写清动机、影响范围、验证方式（例如贴出 `npm run gate` 的通过结果），以及已知的边界或风险。
4. **等 CI 绿**：PR 上的 `gate` 工作流必须通过；失败就先修，不要绕过或跳过检查。
5. **由人合并**：PR 需要维护者 review，合并由人完成。请勿自行合并，也不要开启 auto-merge。

如果改动涉及规格、注册表或分层规则，还需要同步更新 `docs/` 与 `spec/config/` 中的台账；细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 5. 注意事项

- 不要提交 `data/`、`dist/`、日志、API key 或任何真实用户数据；本仓库不包含聊天记录、QQ 号等隐私信息。发布前的脱敏自检清单见 [docs/SECURITY.md](docs/SECURITY.md)。
- 外部副作用只放在装配层与运行时脚本，纯逻辑写成可测的纯函数；具体约定见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
- issue / PR 里不要贴真实密钥、聊天记录或本机绝对路径。
