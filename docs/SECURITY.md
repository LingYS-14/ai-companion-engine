# 安全与隐私

## 1. 本仓库不含的秘密

发布前已做全量脱敏，仓库里**没有**：

- 真实 QQ 号、用户名、本机绝对路径（示例里用 `10000001` / `user` 占位）；
- 模型 API key / 访问 token（`sk-` 命中只出现在测试正则与占位示例中）；
- 聊天记录、记忆库、日志、`data/` 与 `dist/` 都不入库（见 `.gitignore`）；
- 真实头像/立绘（`assets/avatar.png` 是程序生成的通用占位）。

如果你 fork 后要发布自己的版本，请重复本仓库的脱敏检查（见 §5）。

## 2. 密钥怎么放

优先级从高到低：

1. **环境变量**：`ACE_LLM_API_KEY` 等（推荐；进程环境不落盘）。
2. **DPAPI 加密文件**：Windows 下可用 `scripts/autonomy/secret.mjs` 生成，只有当前用户能解密。
3. 明文配置文件：不推荐，且不要提交。

同一个 key 不要同时用于多个公网服务；发现泄漏立刻轮换。

## 3. 数据面

- `data/` 是私人数据：包含对话记忆、状态、可能含玩家原话。发布或分享前必须排除。
- 单写者模型下，运行时进程持有写锁（`data/.writer-lock.*`）；多进程写会破坏一致性。
- 备份即复制 `data/`；删除历史用 `tools/maintenance/delete-memory.mjs`（WAL 只追加，不留墓碑行）。

## 4. 网络面

| 出站 | 说明 |
| --- | --- |
| 模型 API（默认 `api.deepseek.com`） | 对话内容会发送；按需替换为你信任的端点 |
| QQ OneBot（`baseUrl` / `wsUrl`） | 只连你配置的实现；`token` 走配置，不要写死 |
| B 站公开接口 / 网页搜索 | 学习与网页能力；网页默认关闭，开启后可配额度与域名策略 |

网页抓取有 SSRF 防护：只允许 https、443 端口、无 userinfo，重定向 ≤3，单次 8s / 总 24s 超时，256KB 截断。外部内容一律标记不可信（`[web·untrusted]`），进记忆/知识前经过防火墙与打污点；污点内容不参与对话注入。

## 5. 发布前自检清单

```bash
# 1) 目标目录里跑敏感词扫描（应按预期只命中测试/占位）
grep -rn "sk-[A-Za-z0-9]\{16,\}" . --exclude-dir=node_modules --exclude-dir=.git
grep -rn "你的QQ号\|真实昵称\|C:\\\\Users\\\\" . --exclude-dir=node_modules --exclude-dir=.git

# 2) 确认没有数据/日志进暂存区
git status --porcelain
git ls-files | grep -E "^(data|dist|\.tmp)/" && echo "不该出现"

# 3) 跑门禁
npm run gate
```

## 6. 已知边界（诚实声明）

- 网页抓取只做基础校验，不做 DNS rebinding 防护、robots 合规、内容缓存与并发限制（路线图内）。
- QQ 桥的登录态由外部 OneBot 实现持有，本仓库不存储 cookie/token。
- 模型输出会经过清理与禁区过滤，但不保证 100% 无害；高风险场景请自行加人工复核。
- 示例角色卡与头像仅为占位，不包含任何真实人物形象。
- `scripts/` 下的 QQ 探针脚本（`qqdb_probe.py`、`dbprobe.py`、`qq_mitigations.py`、`whoami_il.py`）是对第三方客户端的**注入/内存研究**，不属于产品功能；公开仓库中保留它们仅为可复现的技术记录。使用前请阅读 README 的「敏感能力警告」，自行评估 QQ 用户协议与当地法律风险；二次分发建议删除。
