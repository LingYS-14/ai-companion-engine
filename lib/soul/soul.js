/**
 * 灵魂 · 工作台（P3：概览/对话/记忆/知识/意图/设置）。
 * 展示层只读；唯一改写她状态的是「对话」页（走 daemon 代理），
 * 意图页的「回一句」只写人侧回执，不碰她的状态。
 *
 * 为什么单独一页：面板本身只是入口，真正的界面会越做越大。
 * 页面放在宿主同源的 /soul 上，client 半只留 iframe——
 * 以后加页面只改这里，不再动 Cordis 装配。
 *
 * 数据全部来自现成的 GET /plugins/ai-companion-engine/state-v2；
 * 这里不写任何状态、不调 soul_ 工具、不替她推进。意图区只读，
 * 唯一允许的交互是「人对她的问询回一句」，走 ANSWER 端点；
 * 对话页的发送走 chat 代理（daemon 侧唯一写者）。
 */
(function () {
  "use strict";

  var API = "/plugins/ai-companion-engine/state-v2";
    var POLL_MS = 5000;
  var FETCH_TIMEOUT_MS = 7000;

  var state = { data: null, error: null };

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(id, text) {
    var node = byId(id);
    if (node) node.textContent = text;
  }

  function showStatus(kind, text) {
    var pill = byId("status");
    if (!pill) return;
    pill.setAttribute("data-state", kind);
    pill.textContent = text;
  }

  function clockText(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "\u2014";
    var d = new Date(ms);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  function fetchJSON(url) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () {
        ctrl.abort();
      }, FETCH_TIMEOUT_MS);
    }
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .finally(function () {
        if (timer !== null) clearTimeout(timer);
      });
  }

  function renderAvatar(data) {
    var img = byId("avatar");
    var fallback = byId("avatar-fallback");
    if (!img || !fallback) return;
    var src = typeof data.avatarUrl === "string" && data.avatarUrl !== "" ? data.avatarUrl : null;
    if (src === null) {
      img.hidden = true;
      fallback.hidden = false;
      return;
    }
    fallback.hidden = true;
    img.hidden = false;
    img.onerror = function () {
      img.hidden = true;
      fallback.hidden = false;
    };
    // 立绘可能很宽：带一遍 updatedAt 当缓存参数，换卡后不会卡在旧图
    img.src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "v=" + String(data.updatedAt || 0);
  }

  function renderHero(data) {
    setText("name", data.name || "\u2014");
    var bond = data.bond || {};
    var mood = data.mood || {};
    setText(
      "meta",
      "第 " + (data.turns || 0) + " 轮 \u00b7 " + (bond.stageLabel || "\u964c\u751f") + " \u00b7 " + (data.mode || "\u2014"),
    );
    var dot = byId("mood-dot");
    if (dot) dot.style.background = mood.color || "var(--dim)";
    setText("mood-label", mood.label || "\u2014");
    renderAvatar(data);
  }

  function renderTrack(data) {
    var host = byId("stage-track");
    if (!host) return;
    clear(host);
    var bond = data.bond || {};
    var track = data.stageTrack || [];
    for (var i = 0; i < track.length; i += 1) {
      var seg = track[i];
      var cls = "track-seg";
      if (seg.stage === bond.stage) cls += " is-current";
      else if (typeof bond.progress === "number" && bond.progress >= seg.from) cls += " is-done";
      host.appendChild(el("div", cls, seg.label || seg.stage || "?"));
    }
    var progress = typeof bond.progress === "number" ? bond.progress : 0;
    setText("bond-progress", Math.round(progress * 1000) / 10 + "%");
  }

  function renderVitals(data) {
    var host = byId("vitals");
    if (!host) return;
    clear(host);
    var vitals = data.vitals || [];
    for (var i = 0; i < vitals.length; i += 1) {
      var v = vitals[i];
      var card = el("div", "vital card");
      var head = el("div", "vital-label");
      head.appendChild(el("span", null, v.label || v.key || "?"));
      head.appendChild(el("span", null, v.word || ""));
      card.appendChild(head);
      var bar = el("div", "vital-bar");
      var fill = el("div", "vital-fill");
      var pct = typeof v.value === "number" && isFinite(v.value) ? Math.max(0, Math.min(1, v.value)) : 0;
      fill.style.width = Math.round(pct * 100) + "%";
      if (v.color) fill.style.background = v.color;
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el("div", "vital-word", v.word || ""));
      host.appendChild(card);
    }
  }

  function renderMemory(data) {
    var host = byId("recent");
    if (!host) return;
    clear(host);
    var recent = data.recent || [];
    var mem = data.memory || {};
    setText("memory-count", (mem.active || 0) + " 条");
    if (recent.length === 0) {
      host.appendChild(el("div", "empty-cell", "她这里还没有最近记得的事。"));
      return;
    }
    for (var i = 0; i < recent.length; i += 1) {
      var m = recent[i];
      var item = el("div", "item card");
      item.appendChild(el("p", "item-text", "\u300c" + (m.content || "") + "\u300d"));
      var tags = m.tags || [];
      if (tags.length > 0) {
        var tagRow = el("div", "item-tags");
        for (var t = 0; t < tags.length; t += 1) tagRow.appendChild(el("span", "tag", "#" + tags[t]));
        item.appendChild(tagRow);
      }
      host.appendChild(item);
    }
  }

  function renderKnowledge(data) {
    var host = byId("knowledge");
    if (!host) return;
    clear(host);
    var knowledge = data.knowledge || [];
    if (knowledge.length === 0) {
      host.appendChild(el("div", "empty-cell", "她还没记住什么知识。"));
      return;
    }
    for (var i = 0; i < knowledge.length; i += 1) {
      var k = knowledge[i];
      var row = el("div", "know-row card");
      row.appendChild(el("span", "know-dot"));
      row.appendChild(el("span", null, k.content || ""));
      host.appendChild(row);
    }
  }

  function renderIntent(intent) {
    var host = byId("intent");
    if (!host) return;
    clear(host);

    var intentions = intent.intentions || {};
    var items = intentions.items || [];
    var waiting = ((intent.dsh && intent.dsh.waiting) || 0) + ((intent.guardian && intent.guardian.waiting) || 0);
    var gaps = intent.gaps || [];
    var notes = intent.notes || [];

    var head = el("div", "block-head");
    head.appendChild(el("h3", null, "她正想做什么"));
    head.appendChild(el("span", "muted", (intentions.open || 0) + " 件"));
    host.appendChild(head);

    if (items.length === 0) {
      host.appendChild(el("p", "note", "此刻没有开着的心事。"));
    } else {
      for (var i = 0; i < items.length; i += 1) {
        var it = items[i];
        var card = el("div", "intent-card");
        card.appendChild(el("p", "item-text", "\u300c" + (it.goal || "") + "\u300d"));
        var tags = el("div", "item-tags");
        tags.appendChild(el("span", "tag", "#" + (it.kind || "?")));
        if (it.blockedBy) tags.appendChild(el("span", "tag", "\u88ab\u62e6\uff1a" + it.blockedBy));
        if ((it.attempts || 0) > 0) tags.appendChild(el("span", "tag", "\u8bd5\u8fc7 " + it.attempts + " \u6b21"));
        card.appendChild(tags);
        host.appendChild(card);
      }
    }

    var waits = [];
    ((intent.dsh && intent.dsh.items) || []).forEach(function (it) {
      waits.push({ target: "dsh", id: it.id, text: "DSH\uff1a" + (it.text || ""), expired: !!it.expired });
    });
    ((intent.guardian && intent.guardian.items) || []).forEach(function (it) {
      waits.push({
        target: "guardian",
        id: it.requestId,
        text: "\u76d1\u62a4\u4eba\uff1a" + (it.what || ""),
        timedOut: !!it.timedOut,
      });
    });

    if (waiting > 0) {
      host.appendChild(el("p", "note", "在等回音：" + waiting + " 件（DSH / 监护人）"));
      for (var w = 0; w < waits.length; w += 1) {
        var item = waits[w];
        var card2 = el("div", "intent-card");
        card2.appendChild(el("p", "item-text", item.text));
        card2.appendChild(el("span", "tag", item.expired ? "\u5df2\u8fc7\u671f" : item.timedOut ? "\u5df2\u8d85\u65f6" : "\u7b49\u5979\u5f00\u53e3"));
        var row = el("div", "intent-wait");
        row.appendChild(answerButton(item, "answer", "\u56de\u4e00\u53e5"));
        row.appendChild(answerButton(item, "later", "\u7a0d\u540e"));
        row.appendChild(answerButton(item, "decline", "\u5e2e\u4e0d\u4e86"));
        card2.appendChild(row);
        host.appendChild(card2);
      }
    }

    if (gaps.length > 0) {
      var gapText = [];
      for (var g = 0; g < gaps.length && g < 3; g += 1) {
        gapText.push((gaps[g].kind || "?") + "/" + (gaps[g].missingFamily || "?"));
      }
      host.appendChild(el("p", "note", "卡在能力缺口：" + gapText.join("\u3001")));
    }

    for (var i = 0; i < notes.length; i += 1) {
      host.appendChild(el("p", "note", "\u00b7 " + notes[i]));
    }
  }

  function sendAnswer(target, id, action) {
    fetch("/plugins/ai-companion-engine/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: target, id: id, action: action }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (body) {
        window.alert(body && body.detail ? body.detail : "\u5df2\u9001\u51fa");
        load();
      })
      .catch(function (err) {
        window.alert("\u6ca1\u9001\u51fa\u53bb\uff1a" + (err && err.message ? err.message : String(err)));
      });
  }

  function answerButton(waiting, action, label) {
    var btn = el("button", "btn", label);
    btn.type = "button";
    btn.addEventListener("click", function () {
      sendAnswer(waiting.target, waiting.id, action);
    });
    return btn;
  }

  function renderFooter(data) {
    var sleep = data.sleep || {};
    var mem = data.memory || {};
    setText("chip-sleep", "睡点 " + (typeof sleep.hour === "number" ? sleep.hour + ":00" : "\u2014"));
    setText("chip-memory", "记忆 " + (mem.active || 0) + "/" + (mem.total || 0));
    setText("chip-knowledge", "知识 " + (mem.knowledge || 0));
    setText("chip-updated", "更新 " + clockText(data.updatedAt));
  }

  /* ---------- P2：对话（与 QQ 共享同一段历史） ---------- */

  var CHAT_META = "/plugins/ai-companion-engine/chat/meta";
  var CHAT_HISTORY = "/plugins/ai-companion-engine/chat/history";
  var CHAT_SEND = "/plugins/ai-companion-engine/chat/send";
  var CHAT_POLL_MS = 2000;
  var CHAT_SEND_TIMEOUT_MS = 90000;
  var CHAT_MAX_CHARS = 2000;

  var chat = {
    csrf: null,
    pollMs: CHAT_POLL_MS,
    loading: false,
    sleepPhase: null,
    timer: null,
  };

  function chatStatus(text, isError) {
    var node = byId("chat-status");
    if (!node) return;
    node.textContent = text || "";
    node.className = "chat-status" + (isError ? " is-error" : "");
  }

  function chatDisabledReason() {
    if (chat.sleepPhase === "asleep") return "她睡着了（asleep），等醒来再聊。";
    return null;
  }

  function applyChatGating() {
    var input = byId("chat-input");
    var send = byId("chat-send");
    if (!input || !send) return;
    var reason = chatDisabledReason();
    input.disabled = reason !== null;
    send.disabled = reason !== null;
    if (reason !== null) {
      input.placeholder = reason;
      chatStatus(reason, false);
    } else if (input.placeholder.indexOf("睡着") >= 0) {
      input.placeholder = "跟她说点什么…";
      chatStatus("", false);
    }
  }

  function bubbleOf(msg, pending) {
    var who = msg.who === "her" ? "her" : "peer";
    var row = el(
      "div",
      "bubble " + (who === "her" ? "bubble-her" : "bubble-peer") + (pending ? " is-pending" : ""),
      msg.text || "",
    );
    var meta = el("span", "bubble-meta", clockText(msg.atMs));
    if (msg.channel === "qq") meta.appendChild(el("span", "source", "QQ"));
    else if (msg.channel === "web") meta.appendChild(el("span", "source", "网页"));
    row.appendChild(meta);
    return row;
  }

  function renderChat(messages) {
    var host = byId("chat-log");
    if (!host) return;
    clear(host);
    if (!messages || messages.length === 0) {
      host.appendChild(el("div", "chat-empty", "她这里还没有对话。"));
      return;
    }
    for (var i = 0; i < messages.length; i += 1) host.appendChild(bubbleOf(messages[i], false));
    host.scrollTop = host.scrollHeight;
  }

  function chatFetch(url, options) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, CHAT_SEND_TIMEOUT_MS);
      options = Object.assign({}, options, { signal: ctrl.signal });
    }
    return fetch(url, options).finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
  }

  function loadChatMeta() {
    return fetchJSON(CHAT_META)
      .then(function (body) {
        if (body && typeof body.csrf === "string") chat.csrf = body.csrf;
        if (body && typeof body.pollMs === "number" && body.pollMs >= 500) chat.pollMs = body.pollMs;
      })
      .catch(function (err) {
        chatStatus("网页聊天还没接上：" + (err && err.message ? err.message : String(err)), true);
      });
  }

  function loadChatHistory() {
    if (chat.loading) return Promise.resolve();
    chat.loading = true;
    return fetchJSON(CHAT_HISTORY + "?limit=50")
      .then(function (body) {
        renderChat((body && body.messages) || []);
      })
      .catch(function (err) {
        chatStatus("历史读不到：" + (err && err.message ? err.message : String(err)), true);
      })
      .finally(function () {
        chat.loading = false;
      });
  }

  function sendChat(text) {
    var payload = JSON.stringify({ text: text });

    function attempt(retried) {
      chatFetch(CHAT_SEND, {
        method: "POST",
        headers: { "content-type": "application/json", "x-soul-csrf": chat.csrf || "" },
        body: payload,
      })
        .then(function (res) {
          return res.json().then(function (body) {
            return { status: res.status, body: body };
          });
        })
        .then(function (out) {
          if (out.status === 403 && !retried) {
            return loadChatMeta().then(function () {
              attempt(true);
            });
          }
          if (out.body && out.body.ok === true) {
            chatStatus("", false);
            return loadChatHistory();
          }
          var code = (out.body && out.body.code) || "engine-error";
          var message = (out.body && out.body.message) || "没送出去";
          chatStatus("没送出去（" + code + "）：" + message, true);
          var input = byId("chat-input");
          if (input) input.value = text;
        })
        .catch(function (err) {
          chatStatus("没送出去：" + (err && err.message ? err.message : String(err)), true);
          var input = byId("chat-input");
          if (input) input.value = text;
        });
    }

    attempt(false);
  }

  function stopChatPoll() {
    if (chat.timer !== null) {
      clearInterval(chat.timer);
      chat.timer = null;
    }
  }

  function startChatPoll() {
    stopChatPoll();
    loadChatMeta().then(function () {
      loadChatHistory();
      chat.timer = setInterval(function () {
        if (document.hidden) return;
        loadChatHistory();
      }, chat.pollMs);
    });
  }

  function onChatSubmit(event) {
    if (event) event.preventDefault();
    var input = byId("chat-input");
    if (!input || input.disabled) return;
    var text = String(input.value || "").trim();
    if (text === "") return;
    if (text.length > CHAT_MAX_CHARS) {
      chatStatus("最多 " + CHAT_MAX_CHARS + " 字。", true);
      return;
    }
    if (chat.csrf === null) {
      loadChatMeta().then(function () {
        sendChat(text);
      });
    } else {
      sendChat(text);
    }
    input.value = "";
    var host = byId("chat-log");
    if (host) {
      var empty = host.querySelector(".chat-empty");
      if (empty) host.removeChild(empty);
      host.appendChild(bubbleOf({ who: "peer", text: text, atMs: Date.now(), channel: "web" }, true));
      host.scrollTop = host.scrollHeight;
    }
    chatStatus("发出去了，等她说…", false);
  }

  /* ---------- P3：记忆 / 知识 / 意图 / 设置（只读 + 本地主题） ---------- */

  var THEME_KEY = "soul-theme";
  var THEMES = ["dark", "light"];

  function themeApply(theme) {
    var next = THEMES.indexOf(theme) >= 0 ? theme : "dark";
    document.documentElement.setAttribute("data-theme", next);
    var seg = byId("theme-seg");
    if (!seg) return;
    var btns = seg.querySelectorAll("[data-theme-set]");
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute("data-theme-set") === next);
    }
  }

  function themeInit() {
    var saved = null;
    try {
      saved = window.localStorage.getItem(THEME_KEY);
    } catch (err) {
      saved = null;
    }
    themeApply(saved || "dark");
    var seg = byId("theme-seg");
    if (seg) {
      seg.addEventListener("click", function (event) {
        var target = event.target;
        if (!target || typeof target.getAttribute !== "function") return;
        var next = target.getAttribute("data-theme-set");
        if (!next) return;
        try {
          window.localStorage.setItem(THEME_KEY, next);
        } catch (err) {
          /* 存不了就只在这次生效 */
        }
        themeApply(next);
      });
    }
  }

  function statCard(label, value, hint) {
    var card = el("div", "stat card");
    card.appendChild(el("span", "stat-label", label));
    card.appendChild(el("strong", "stat-value", String(value)));
    if (hint) card.appendChild(el("span", "stat-hint", hint));
    return card;
  }

  function pct(value) {
    return typeof value === "number" && isFinite(value) ? Math.round(value * 100) + "%" : "—";
  }

  function renderMemoryPage(data) {
    var mem = data.memory || {};
    var stats = byId("memory-stats");
    if (stats) {
      clear(stats);
      stats.appendChild(statCard("总数", mem.total || 0, "全部写过的事件"));
      stats.appendChild(statCard("活跃", mem.active || 0, "现在还能被想起"));
      stats.appendChild(statCard("已忘", mem.forgotten || 0, "遗忘曲线之下"));
      stats.appendChild(statCard("抑制", mem.suppressed || 0, "被压下去不提"));
      stats.appendChild(statCard("冷档", mem.cold || 0, "归档，不删"));
      stats.appendChild(statCard("知识", mem.knowledge || 0, "学到的条目"));
      stats.appendChild(statCard("平均鲜明", pct(mem.vividness), "越高越清晰"));
    }
    setText("memory-page-total", (mem.active || 0) + " 条活跃 / " + (mem.total || 0) + " 条总数");

    var host = byId("memory-list");
    if (!host) return;
    clear(host);
    var recent = data.recent || [];
    if (recent.length === 0) {
      host.appendChild(el("div", "empty-cell", "她这里还没有最近记得的事。"));
      return;
    }
    for (var i = 0; i < recent.length; i += 1) {
      var m = recent[i];
      var item = el("div", "item card");
      item.appendChild(el("p", "item-text", "「" + (m.content || "") + "」"));
      var meta = el("div", "item-tags");
      var tags = m.tags || [];
      for (var t = 0; t < tags.length; t += 1) meta.appendChild(el("span", "tag", "#" + tags[t]));
      if (typeof m.vividness === "number") meta.appendChild(el("span", "tag", "鲜明 " + pct(m.vividness)));
      item.appendChild(meta);
      host.appendChild(item);
    }
  }

  function renderKnowledgePage(data) {
    var mem = data.memory || {};
    setText("knowledge-page-count", (mem.knowledge || 0) + " 条");
    var host = byId("knowledge-list");
    if (!host) return;
    clear(host);
    var knowledge = data.knowledge || [];
    if (knowledge.length === 0) {
      host.appendChild(el("div", "empty-cell", "她还没学到什么。"));
      return;
    }
    for (var i = 0; i < knowledge.length; i += 1) {
      var k = knowledge[i];
      var card = el("div", "know-card card");
      card.appendChild(el("span", "know-dot"));
      var body = el("div", "know-body");
      body.appendChild(el("p", "item-text", k.content || ""));
      var tags = el("div", "item-tags");
      if (k.type) tags.appendChild(el("span", "tag", "#" + k.type));
      body.appendChild(tags);
      card.appendChild(body);
      host.appendChild(card);
    }
  }

  function renderIntentPage(data) {
    var intent = data.intent || {};
    var intentions = intent.intentions || {};
    var items = intentions.items || [];
    setText("intent-page-open", (intentions.open || 0) + " 件 / 共 " + (intentions.total || 0) + " 件");

    var host = byId("intent-list");
    if (host) {
      clear(host);
      if (items.length === 0) host.appendChild(el("div", "empty-cell", "此刻没有开着的心事。"));
      for (var i = 0; i < items.length; i += 1) {
        var it = items[i];
        var card = el("div", "intent-card card");
        card.appendChild(el("p", "item-text", "「" + (it.goal || "") + "」"));
        if (it.why) card.appendChild(el("p", "note", "因为 " + it.why));
        var tags = el("div", "item-tags");
        if (it.kind) tags.appendChild(el("span", "tag", "#" + it.kind));
        if (it.status) tags.appendChild(el("span", "tag", it.status));
        if (it.blockedBy) tags.appendChild(el("span", "tag", "被拦：" + it.blockedBy));
        if ((it.attempts || 0) > 0) tags.appendChild(el("span", "tag", "试过 " + it.attempts + " 次"));
        card.appendChild(tags);
        host.appendChild(card);
      }
    }

    var waitingHost = byId("intent-waiting");
    if (!waitingHost) return;
    clear(waitingHost);
    var waits = [];
    ((intent.dsh && intent.dsh.items) || []).forEach(function (it) {
      waits.push({ target: "dsh", id: it.id, text: "DSH：" + (it.text || ""), expired: !!it.expired });
    });
    ((intent.guardian && intent.guardian.items) || []).forEach(function (it) {
      waits.push({
        target: "guardian",
        id: it.requestId,
        text: "监护人：" + (it.what || ""),
        timedOut: !!it.timedOut,
      });
    });
    setText("intent-page-waiting", waits.length + " 件");
    if (waits.length === 0) {
      waitingHost.appendChild(el("div", "empty-cell", "没有在等回音的事。"));
      return;
    }
    for (var w = 0; w < waits.length; w += 1) {
      var item2 = waits[w];
      var card2 = el("div", "intent-card card");
      card2.appendChild(el("p", "item-text", item2.text));
      card2.appendChild(el("span", "tag", item2.expired ? "已过期" : item2.timedOut ? "已超时" : "等她开口"));
      var row = el("div", "intent-wait");
      row.appendChild(answerButton(item2, "answer", "回一句"));
      row.appendChild(answerButton(item2, "later", "稍后"));
      row.appendChild(answerButton(item2, "decline", "帮不了"));
      card2.appendChild(row);
      waitingHost.appendChild(card2);
    }
  }

  function kvRow(host, key, value) {
    var row = el("div", "kv-row");
    row.appendChild(el("span", "kv-key", key));
    row.appendChild(el("span", "kv-value", value));
    host.appendChild(row);
  }

  function renderSettings(data) {
    var sleep = data.sleep || {};
    var sleepHost = byId("settings-sleep");
    if (sleepHost) {
      clear(sleepHost);
      var phase = sleep.phase || "—";
      var phaseText =
        phase === "asleep" ? "睡着" : phase === "drowsy" ? "犯困" : phase === "waking" ? "刚醒" : "醒着";
      kvRow(sleepHost, "现在", phaseText + "（" + phase + "）");
      kvRow(sleepHost, "睡点", typeof sleep.hour === "number" ? sleep.hour + ":00" : "—");
      kvRow(
        sleepHost,
        "距离下一睡点",
        typeof sleep.nextInHours === "number" ? sleep.nextInHours.toFixed(1) + " 小时" : "—",
      );
    }
    var about = byId("settings-about");
    if (about) {
      clear(about);
      kvRow(about, "名字", data.name || "—");
      kvRow(about, "模式", data.mode || "—");
      kvRow(about, "轮次", String(data.turns || 0));
      kvRow(about, "数据来源", "GET /plugins/ai-companion-engine/state-v2");
      kvRow(about, "刷新间隔", "5 秒（页面可见时）");
      kvRow(about, "最后更新", clockText(data.updatedAt));
    }
  }

  function render(data) {
    state.data = data;
    state.error = null;
    // 睡眠门只用于 UI 预禁用；权威判定在 daemon（drowsy 仍可聊）。
    var sleep = data.sleep || {};
    chat.sleepPhase = typeof sleep.phase === "string" ? sleep.phase : null;
    applyChatGating();
    showStatus("ok", "\u5df2\u8fde\u63a5");
    setText("clock", clockText(Date.now()));
    renderHero(data);
    renderTrack(data);
    renderVitals(data);
    renderMemory(data);
    renderKnowledge(data);
    if (data.intent === undefined || data.intent === null) {
      var host = byId("intent");
      if (host) {
        clear(host);
        host.appendChild(el("p", "note", "还没读到她的心事（这一拍还没有意图面）。"));
      }
    } else {
      renderIntent(data.intent);
    }
    renderMemoryPage(data);
    renderKnowledgePage(data);
    renderIntentPage(data);
    renderSettings(data);
    renderFooter(data);
  }

  function renderFailure(err) {
    state.error = err;
    showStatus("error", "\u8bfb\u4e0d\u5230\u72b6\u6001");
    setText("clock", clockText(Date.now()));
    setText("chip-updated", "\u8bfb\u53d6\u5931\u8d25\uff1a" + (err && err.message ? err.message : String(err)));
  }

  function load() {
    return fetchJSON(API)
      .then(render)
      .catch(renderFailure);
  }

  function setPage(page) {
    var pages = document.querySelectorAll(".page");
    for (var i = 0; i < pages.length; i += 1) {
      pages[i].classList.toggle("is-active", pages[i].id === "page-" + page);
    }
    var navs = document.querySelectorAll(".nav-item");
    for (var j = 0; j < navs.length; j += 1) {
      navs[j].classList.toggle("is-active", navs[j].getAttribute("data-page") === page);
    }
    // 对话页才轮询历史；离开就停，避免后台白跑。
    if (page === "dialog") startChatPoll();
    else stopChatPoll();
  }

  function onHashChange() {
    var hash = (window.location.hash || "#overview").replace(/^#/, "");
    if (hash === "") hash = "overview";
    setPage(hash);
  }

  function start() {
    themeInit();
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    var refresh = byId("refresh");
    if (refresh) refresh.addEventListener("click", function () { load(); });
    var form = byId("chat-form");
    if (form) form.addEventListener("submit", onChatSubmit);
    load();
    setInterval(function () {
      if (document.hidden) return;
      load();
    }, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      load();
      if (window.location.hash === "#dialog") loadChatHistory();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
