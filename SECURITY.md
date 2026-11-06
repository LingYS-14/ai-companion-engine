# 安全策略

## 报告安全漏洞

请不要通过公开的 Issue、讨论或 Pull Request 报告安全漏洞。请使用 GitHub 的私密漏洞报告流程（“Report a vulnerability”）：

- 打开 <https://github.com/LingYS-14/ai-companion-engine/security/advisories/new>；
- 或进入仓库的 **Security** 标签页，点击 **Report a vulnerability**。

报告中请尽量包含：

1. **受影响版本**：例如 `0.1.0`，以及运行平台与相关配置；
2. **复现步骤**：最小、可重复的操作序列，必要时附已脱敏的日志或 PoC；
3. **影响**：谁可能利用该问题、可能造成什么后果（如数据泄露、远程执行、权限绕过）。

我们会通过该 Private Security Advisory 与你沟通确认和修复进展。修复发布前，请不要公开漏洞细节。

## 支持的版本

仅最新的 **0.1.x** 发布版本会收到安全修复，更早的版本不再支持。

| 版本 | 支持状态 |
| --- | --- |
| 最新 0.1.x 发布版（当前 `0.1.0`） | ✅ 支持 |
| 更早的版本与预发布版本 | ❌ 不支持，请先升级 |

## 详细安全说明

详细的威胁模型、密钥与数据面/网络面说明、发布前自检清单，以及针对 `scripts/` 下研究脚本的**敏感能力警告**，请见 [docs/SECURITY.md](docs/SECURITY.md)。
