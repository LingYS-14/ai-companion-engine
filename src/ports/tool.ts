/**
 * ToolPort 的**类型面**（审计 P2-2：`ports/` 只放合同）。
 *
 * F266 之前这个文件同时住着运行时值（`AUTONOMY_TOOL_CATALOG`、`createToolPort`、
 * `availableAffordances`、`describeToolPort`），与"ports 只允许 import type"的纪律自相矛盾。
 * 运行时值已搬进大脑层的 `src/contracts/tool-catalog.ts`：
 *   - 装配点（`scripts/autonomy/main.mjs` 等）从 contracts import 值；
 *   - 工具层与需要类型的模块，继续从这里取类型（type-only re-export，不产生运行时依赖）。
 *
 * 加工具 / 改能力族 / 改可用性来源，都去 contracts 那个文件，这里只暴露形状。
 */

export type { ToolAvailability, ToolCatalogEntry, ToolDescriptor, ToolFamily, ToolPort } from "../contracts/tool-catalog.js";
