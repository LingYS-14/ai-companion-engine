/**
 * AI Companion Engine —— Client 半（侧边栏「灵魂」入口）。
 *
 * P4-4 P1（工作台）起，client 半**只负责把工作台嵌进来**：
 * 宿主的 webServer 上有同源的 `/soul` 静态页（`lib/soul/*`），这里用 iframe 指过去。
 * 为什么不在 React 树里继续画：界面会越做越大，而客户端半没有构建链——
 * 每加一块都要重写手写 CJS；拆成静态页后，改界面不再碰 Cordis 装配。
 *
 * 热的两个槽位与清理逻辑保持不变（重载时先拆旧实例，否则侧边栏会多出第二个「灵魂」）。
 */

window.__ModuleLoader__.load({
  id: "ai-companion-engine",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var PANEL_ID = "ai-companion-engine";
    var SOUL_PAGE = "/soul";

    function Panel() {
      return h("iframe", {
        src: SOUL_PAGE,
        title: "灵魂 · 工作台",
        style: { width: "100%", height: "100%", border: 0, display: "block" },
      });
    }

    function PanelIcon(props) {
      var size = (props && props.size) || 16;
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          "data-dsh-panel-entry": PANEL_ID,
        },
        // 星芒 + 心：比"人脸"更像这个插件的身份（灵魂 / 光）
        h("path", { d: "M8 1.4v13.2M1.4 8h13.2", opacity: 0.5 }),
        h("path", { d: "M8 3.6l1.2 3.2L12.4 8l-3.2 1.2L8 12.4 6.8 9.2 3.6 8l3.2-1.2z" }),
      );
    }

    // 热重载保护：客户端半在每次插件重载时都会重新 apply，而旧实例的注册
    // 不一定会被宿主拆掉（现象就是侧边栏多出第二个、第三个「灵魂」）。
    // 把清理函数挂在 globalThis 上，重载时先把上一代的注册拆掉再注册。
    var GLOBAL_KEY = "__ase_panel_disposers__";

    function previousDisposers() {
      var g = typeof globalThis !== "undefined" ? globalThis : window;
      var prev = g[GLOBAL_KEY];
      if (Array.isArray(prev)) {
        while (prev.length > 0) {
          var off = prev.pop();
          try {
            if (typeof off === "function") off();
          } catch (e) {
            /* 旧实例拆除失败不该阻止新实例注册 */
          }
        }
      }
      var fresh = [];
      g[GLOBAL_KEY] = fresh;
      return fresh;
    }

    var disposers = previousDisposers();

    function apply(ctx) {
      disposers.push(
        ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_ID, order: 60, label: function () { return "灵魂"; } },
            PanelIcon,
          );
        }),
      );
      disposers.push(
        ctx.slots.inject("main", function () {
          return ctx.slots.register({ name: "main", key: PANEL_ID }, Panel);
        }),
      );
      return function () {
        while (disposers.length > 0) {
          var off = disposers.pop();
          if (typeof off === "function") off();
        }
      };
    }

    exports.name = "ai-companion-engine-panel";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
