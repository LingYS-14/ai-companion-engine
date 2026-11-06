import { defineConfig } from "vitest/config";

/**
 * TS 源码用 NodeNext 约定：源码内相对导入写 `.js` 后缀。
 * tsc 编译后 dist 里确实是 .js，但 vitest 直接跑 src 里的 .ts —— 需要把
 * `./x.js` 解析到 `./x.ts`，否则测试起不来。
 */
export default defineConfig({
  plugins: [
    {
      name: "resolve-js-to-ts",
      enforce: "pre",
      async resolveId(source, importer) {
        if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
        return this.resolve(source.slice(0, -3) + ".ts", importer, { skipSelf: true });
      },
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
