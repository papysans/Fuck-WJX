// content script：跑在问卷星答题页。
// 职责：① 破解反复制/反粘贴 ② 扫题 ③ 注入悬浮窗展示 AI 答案。
// 全程在页面内完成，不新开标签/窗口，不主动触发 blur/visibilitychange（规避切屏检测）。
(function () {
  "use strict";

  /* ============================================================
   * ① 破解反复制 / 反粘贴 / 反选中
   * 原理：capture 阶段先于页面（bubble 阶段）的拦截 handler 执行，
   *      stopImmediatePropagation 掐断页面的 paste/copy 拦截，但不 preventDefault，
   *      浏览器默认的复制/粘贴照常发生。纯客户端、无网络信号，检测不到。
   * ========================================================== */
  function unlockCopyPaste() {
    ["paste", "copy", "cut", "contextmenu", "selectstart"].forEach((type) => {
      document.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
    });
    const style = document.createElement("style");
    style.textContent =
      "*{-webkit-user-select:text !important;-moz-user-select:text !important;user-select:text !important;}";
    (document.head || document.documentElement).appendChild(style);
  }

  /* ============================================================
   * 扫题 + 整卷单次作答的运行时状态
   * ========================================================== */
  const qEls = new Map(); // index → 题目 DOM 元素，供「定位」用
  const answers = new Map(); // index → 答案（可能为空串 = 无需作答），供「复制」复用
  let currentQuestions = []; // 最近一次扫到的题目数组

  /* ============================================================
   * ② 扫题
   * ========================================================== */
  // type 属性数字码 → 题型（仅在 DOM 嗅探失败时兜底）。
  // 实测：1=单行填空(input text) 2=简答(textarea) 3=单选 4=多选 5=量表 6=矩阵 7=排序 8=比重 11=评分
  const TYPE_CODE = {
    "1": "text",
    "2": "text",
    "3": "single",
    "4": "multi",
    "5": "slider",
    "6": "matrix",
    "7": "sort",
    "8": "slider",
    "11": "rating",
  };

  // DOM 实测优先（比 class 嗅探稳），容器 type 属性兜底。
  function detectType(el) {
    if (el.querySelector("textarea")) return "text"; // 简答/填空：本项目主战场
    if (el.querySelector('input[type="text"], input[type="number"]')) return "text";
    if (el.querySelector('input[type="checkbox"]')) return "multi";
    if (el.querySelector('input[type="radio"]')) return "single";
    // 老模板 .ulradiocheck：内部 input.type 区分单/多选
    const ul = el.querySelector(".ulradiocheck");
    if (ul) {
      const input = ul.querySelector("input");
      return input && input.type === "checkbox" ? "multi" : "single";
    }
    if (el.querySelector("table")) return "matrix";
    if (el.querySelector("select")) return "select";
    const code = el.getAttribute("type");
    if (code && TYPE_CODE[code]) return TYPE_CODE[code];
    return "unknown";
  }

  function cleanStem(el) {
    const node =
      el.querySelector(".topichtml") || // 新版模板（干净，不含 * 号）
      el.querySelector(".field-label") ||
      el.querySelector(".field") || // 老模板
      el;
    const text = (node.innerText || node.textContent || "").trim();
    return text.replace(/\s+/g, " ").trim();
  }

  function getOptions(el, type) {
    if (type !== "single" && type !== "multi") return [];
    const inputs = el.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    const opts = [];
    inputs.forEach((input) => {
      let txt = "";
      if (input.id) {
        const label = el.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label) txt = label.innerText || "";
      }
      if (!txt.trim()) {
        const box = input.closest("li, div, label, span");
        if (box) txt = box.innerText || "";
      }
      txt = txt.replace(/\s+/g, " ").trim();
      if (txt) opts.push(txt);
    });
    let result = [...new Set(opts)];
    // 老模板兜底：通用逻辑取不到时退回 .ulradiocheck li
    if (!result.length) {
      result = [
        ...new Set(
          [...el.querySelectorAll(".ulradiocheck li")]
            .map((li) => (li.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        ),
      ];
    }
    return result;
  }

  function scanQuestions() {
    qEls.clear();
    // 兼容两套模板：.field[topic]（新版 ks.wjx.com/vm/*） + .div_question（老版）
    const nodes = document.querySelectorAll(".field[topic], .div_question");
    const seen = new Set();
    const out = [];
    nodes.forEach((el) => {
      if (seen.has(el)) return; // 去重（同一容器可能命中两个选择器）
      seen.add(el);
      const stem = cleanStem(el);
      if (!stem) return; // 过滤布局用的空 field
      const type = detectType(el);
      const topic = Number(el.getAttribute("topic")) || out.length + 1;
      qEls.set(topic, el); // index → DOM，供「定位」用
      out.push({ index: topic, stem, type, options: getOptions(el, type) });
    });
    return out;
  }

  /* ============================================================
   * ③ 悬浮窗（closed Shadow DOM，样式隔离 + 降低页面可探测性）
   * ========================================================== */
  // 「隐形便签」皮肤：两套主题 token 挂在 .wrap 上，[data-theme="dark"] 覆盖。
  // 切换主题时，消费颜色的元素靠 transition 平滑过渡（变量本身不动画）。
  const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap {
      --paper:#F5F4F0; --paper-edge:#ECEAE4; --wash:#EDEBE4;
      --ink:#33322E; --ink-2:#6E6C64; --ink-3:#A8A59C;
      --rule:#E0DDD5; --amber:#9A7B33;
      --sans:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
      --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
    }
    .wrap[data-theme="dark"] {
      --paper:#1E1E1C; --paper-edge:#262624; --wash:#2B2B27;
      --ink:#E5E3DC; --ink-2:#9C998F; --ink-3:#6C685F;
      --rule:#33322E; --amber:#C7A24E;
    }
    /* 丝滑过渡：只对消费颜色的属性动画 */
    .panel, .bar, .bar .name, .bar .go, .bar .ic,
    .tools, .tools label, .seg, .seg button,
    .list, .blk, .blk .num, .blk .stem, .blk .ans, .blk .acts a,
    .foot, .handle {
      transition: background-color .35s ease, color .35s ease,
                  border-color .35s ease, box-shadow .35s ease;
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

    .panel {
      width: 344px; max-height: 70vh; display: flex; flex-direction: column;
      font-family: var(--sans); color: var(--ink); background: var(--paper);
      border: 1px solid var(--rule); border-radius: 5px;
      box-shadow: 0 6px 22px rgba(0,0,0,0.18); overflow: hidden;
    }

    /* 标题栏：极简，默认只露 笔记 / 扫题作答 / ◐ / × */
    .bar {
      display: flex; align-items: center; gap: 8px; padding: 7px 10px;
      background: var(--paper-edge); border-bottom: 1px solid var(--rule);
      cursor: move; user-select: none; flex-shrink: 0;
    }
    .bar .name { flex: 1; font: 500 11px/1 var(--mono); letter-spacing: 1.5px; color: var(--ink-2); }
    .bar .go {
      all: unset; box-sizing: border-box; cursor: pointer;
      font: 500 11px var(--mono); color: var(--ink-2);
      background: transparent; border: 1px solid var(--rule); border-radius: 4px; padding: 3px 9px;
    }
    .bar .go:hover { color: var(--ink); border-color: var(--ink-3); }
    .bar .ic {
      all: unset; box-sizing: border-box; cursor: pointer;
      color: var(--ink-3); font: 12px var(--mono); padding: 2px 5px; border-radius: 4px;
    }
    .bar .ic:hover { color: var(--ink); }

    /* 控制条：默认隐藏，点 ◐ 展开。透明度/亮度/移开收起/主题切换 */
    .tools {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 8px 10px; background: var(--paper-edge);
      border-bottom: 1px solid var(--rule); flex-shrink: 0;
    }
    .tools[hidden] { display: none; }
    .tools label {
      font: 500 10.5px var(--mono); color: var(--ink-2); letter-spacing: .5px;
      display: flex; align-items: center; gap: 5px;
    }
    .tools input[type=range] { width: 62px; accent-color: var(--amber); }
    .tools input[type=checkbox] { accent-color: var(--amber); }
    .seg { display: flex; border: 1px solid var(--rule); border-radius: 4px; overflow: hidden; }
    .seg button {
      all: unset; box-sizing: border-box; cursor: pointer;
      font: 500 10.5px var(--mono); color: var(--ink-3); padding: 3px 9px; background: transparent;
    }
    .seg button.on { background: var(--ink); color: var(--paper); }

    .list { overflow: auto; flex: 1; min-height: 0; }

    /* 题目块＝编辑器行号栏：左 gutter 等宽题号 + 右 body */
    .blk { display: grid; grid-template-columns: 30px 1fr; border-bottom: 1px solid var(--rule); }
    .blk:last-child { border-bottom: 0; }
    .blk .num {
      font: 500 11px/1.9 var(--mono); color: var(--ink-3); text-align: right;
      padding: 11px 8px 0 0; border-right: 1px solid var(--rule); background: rgba(0,0,0,0.02);
    }
    .blk .body { padding: 9px 12px 11px; min-width: 0; }
    .blk .stem { font-size: 11.5px; color: var(--ink-2); line-height: 1.5; margin-bottom: 5px; }
    .blk .ans {
      font-size: 13px; color: var(--ink); line-height: 1.68;
      white-space: pre-wrap; word-break: break-word;
    }
    .blk .ans.miss { color: var(--amber); }
    .blk .ans.miss::before { content: "⚑ "; font-size: 10px; }
    .blk .ans.err { color: #c2564d; }
    .blk .ans.none { font: 500 11px/1.6 var(--mono); color: var(--ink-3); letter-spacing: .5px; white-space: normal; }
    /* 操作行：默认隐藏，块 hover（active-line）才浮现 */
    .blk .acts { margin-top: 7px; display: flex; gap: 14px; opacity: 0; transition: opacity .12s ease; }
    .blk .acts a { font: 500 10.5px var(--mono); color: var(--ink-3); letter-spacing: .5px; cursor: pointer; text-decoration: none; }
    .blk .acts a:hover { color: var(--ink); }
    .blk:hover { background: var(--wash); }
    .blk:hover .acts { opacity: 1; }
    /* 背景/无需作答块：题号与内容压暗，无操作链 */
    .blk.bg .num { opacity: .55; }
    .blk.bg .body { color: var(--ink-3); }
    .blk.bg:hover { background: transparent; }

    .foot {
      padding: 6px 12px; font: 500 10.5px var(--mono); color: var(--ink-3); letter-spacing: .5px;
      background: var(--paper-edge); border-top: 1px solid var(--rule); min-height: 14px; flex-shrink: 0;
    }

    /* 移开收起用的小把手：右下角 30px 圆角方块 */
    .handle {
      position: fixed; right: 24px; bottom: 24px; width: 30px; height: 30px;
      display: none; align-items: center; justify-content: center;
      border-radius: 6px; background: var(--paper); border: 1px solid var(--rule);
      box-shadow: 0 3px 12px rgba(0,0,0,0.25); color: var(--ink-3);
      font: 12px var(--mono); line-height: 1; cursor: pointer; user-select: none;
    }
    .handle:hover { color: var(--ink); }
  `;

  const OVERLAY_HTML = `
    <div class="handle" id="handle" title="展开笔记">≡</div>
    <div class="panel" id="panel">
      <div class="bar" id="bar">
        <span class="name">笔记</span>
        <button id="scan" class="go">扫题作答</button>
        <button id="toggleTools" class="ic" title="面板设置">◐</button>
        <button id="hide" class="ic" title="收起 Ctrl+Shift+X">×</button>
      </div>
      <div class="tools" id="tools" hidden>
        <label>透明 <input type="range" id="opacity" min="0.15" max="1" step="0.05" value="0.95"></label>
        <label>亮度 <input type="range" id="bright" min="0.4" max="1.4" step="0.05" value="1"></label>
        <label><input type="checkbox" id="autocollapse" checked> 移开收起</label>
        <label><input type="checkbox" id="autofill"> 自动填入页面</label>
        <div class="seg" id="themeSeg">
          <button type="button" id="themeLight" title="浅色">浅</button>
          <button type="button" id="themeDark" title="深色">深</button>
        </div>
      </div>
      <div class="list" id="list"></div>
      <div class="foot" id="status">按「扫题作答」读取全部题目并一次性生成答案</div>
    </div>
  `;

  let host = null;
  let root = null;
  let els = {};
  // hidden = 硬开关（整个 host 隐藏，Ctrl+Shift+X）；collapsed = 收起到右下角把手。
  const state = {
    visible: false,
    opacity: 0.95,
    brightness: 1,
    autoCollapse: true,
    hidden: true,
    collapsed: false,
    theme: "light",
    autoFill: false, // 生成后是否自动把答案填进页面文本框（默认关）
  };

  function ensureOverlay() {
    if (host) return;
    host = document.createElement("div");
    host.id = "__rev_panel_host__";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;top:80px;right:24px;display:none;";
    root = host.attachShadow({ mode: "closed" });
    const wrap = document.createElement("div");
    wrap.id = "wrap";
    wrap.className = "wrap";
    wrap.setAttribute("data-theme", state.theme); // 主题 token 载体，切换只改此属性
    const st = document.createElement("style");
    st.textContent = OVERLAY_CSS;
    wrap.innerHTML = OVERLAY_HTML;
    root.append(st, wrap);
    (document.body || document.documentElement).appendChild(host);

    els = {
      wrap: root.getElementById("wrap"),
      panel: root.getElementById("panel"),
      handle: root.getElementById("handle"),
      bar: root.getElementById("bar"),
      scan: root.getElementById("scan"),
      toggleTools: root.getElementById("toggleTools"),
      hide: root.getElementById("hide"),
      tools: root.getElementById("tools"),
      opacity: root.getElementById("opacity"),
      bright: root.getElementById("bright"),
      autoCollapse: root.getElementById("autocollapse"),
      autoFill: root.getElementById("autofill"),
      themeLight: root.getElementById("themeLight"),
      themeDark: root.getElementById("themeDark"),
      status: root.getElementById("status"),
      list: root.getElementById("list"),
    };
    wireEvents();
    applyVisual();
    // 从 storage 读取持久化主题并应用（与 popup 共享 config.theme）
    chrome.storage.local
      .get("config")
      .then(({ config = {} }) => {
        applyTheme(config.theme || "light");
        applyAutoFill(!!config.autoFill);
      })
      .catch(() => applyTheme("light"));
  }

  // 只改 wrap 的 data-theme + 分段按钮高亮；不落盘。
  function applyTheme(theme) {
    state.theme = theme === "dark" ? "dark" : "light";
    if (els.wrap) els.wrap.setAttribute("data-theme", state.theme);
    if (els.themeLight) els.themeLight.classList.toggle("on", state.theme === "light");
    if (els.themeDark) els.themeDark.classList.toggle("on", state.theme === "dark");
  }

  // 切换主题并写回 storage 的 config.theme（与 popup 保持一致）。
  async function setTheme(theme) {
    applyTheme(theme);
    try {
      const { config = {} } = await chrome.storage.local.get("config");
      config.theme = state.theme;
      await chrome.storage.local.set({ config });
    } catch {}
  }

  // 只改 state + checkbox，不落盘（与 applyTheme 对称）。
  function applyAutoFill(on) {
    state.autoFill = !!on;
    if (els.autoFill) els.autoFill.checked = state.autoFill;
  }

  // 切换自动填充并写回 config.autoFill（合并写，不覆盖其它字段；与 popup 保持一致）。
  async function setAutoFill(on) {
    applyAutoFill(on);
    try {
      const { config = {} } = await chrome.storage.local.get("config");
      config.autoFill = state.autoFill;
      await chrome.storage.local.set({ config });
    } catch {}
  }

  // host 始终保持正常 display，靠内部 panel/handle 切换；hidden 时才整体 display:none。
  function applyLayout() {
    if (!host) return;
    host.style.display = state.hidden ? "none" : "";
    if (state.hidden) return;
    els.panel.style.display = state.collapsed ? "none" : "";
    els.handle.style.display = state.collapsed ? "flex" : "none";
  }

  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    applyLayout();
    if (!collapsed) host.style.opacity = String(state.opacity); // 展开恢复到设定透明度
  }

  function applyVisual() {
    if (!host) return;
    host.style.opacity = String(state.opacity);
    els.panel.style.filter = `brightness(${state.brightness})`;
  }

  function wireEvents() {
    // 拖动
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    els.bar.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      host.style.left = r.left + "px"; host.style.top = r.top + "px"; host.style.right = "auto";
      els.bar.setPointerCapture(e.pointerId);
    });
    els.bar.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      host.style.left = ox + (e.clientX - sx) + "px";
      host.style.top = oy + (e.clientY - sy) + "px";
    });
    els.bar.addEventListener("pointerup", () => (dragging = false));

    // 透明度 / 亮度
    els.opacity.addEventListener("input", () => {
      state.opacity = Number(els.opacity.value);
      host.style.opacity = String(state.opacity);
    });
    els.bright.addEventListener("input", () => {
      state.brightness = Number(els.bright.value);
      els.panel.style.filter = `brightness(${state.brightness})`;
    });
    els.autoCollapse.addEventListener("change", () => {
      state.autoCollapse = els.autoCollapse.checked;
      if (!state.autoCollapse) setCollapsed(false); // 关闭时面板常显，不再收起
    });
    els.autoFill.addEventListener("change", () => setAutoFill(els.autoFill.checked));

    // 移开收起：鼠标离开面板 → 收起到右下角把手；移到把手 → 展开回面板。
    els.panel.addEventListener("mouseleave", () => {
      if (state.autoCollapse && !state.hidden) setCollapsed(true);
    });
    els.handle.addEventListener("mouseenter", () => setCollapsed(false));
    els.handle.addEventListener("click", () => setCollapsed(false));

    // ◐ 展开/收起控制条（默认隐藏，保持极简）
    els.toggleTools.addEventListener("click", () => {
      els.tools.hidden = !els.tools.hidden;
    });
    // 主题切换（浅/深），写回 storage
    els.themeLight.addEventListener("click", () => setTheme("light"));
    els.themeDark.addEventListener("click", () => setTheme("dark"));

    els.scan.addEventListener("click", runScan);
    els.hide.addEventListener("click", hideOverlay);
  }

  function showOverlay() {
    ensureOverlay();
    state.hidden = false;
    state.collapsed = false;
    applyLayout();
    host.style.opacity = String(state.opacity);
    state.visible = true;
  }
  function hideOverlay() {
    // × 按钮：硬隐藏整个 host（panel + handle 都不可见）
    if (!host) return;
    state.hidden = true;
    applyLayout();
    state.visible = false;
  }
  function toggleOverlay() {
    // Ctrl+Shift+X 硬开关：整体隐藏/显示，展开时默认显示面板（非收起态）
    ensureOverlay();
    state.hidden = !state.hidden;
    if (!state.hidden) {
      state.collapsed = false;
      host.style.opacity = String(state.opacity);
    }
    applyLayout();
    state.visible = !state.hidden;
  }

  function setStatus(t) {
    if (els.status) els.status.textContent = t;
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.cssText = "position:fixed;left:-9999px;";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // 题号补零成行号感（01、05…），编辑器 gutter 用。
  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // 扫题后先把所有题块渲染出来（答案区显示「作答中…」，操作链默认隐藏、块 hover 才浮现）。
  // 每块＝编辑器行号栏：左 gutter 题号 + 右 body（题干 + 答案 + 「↳定位/⧉复制」操作行）。
  function renderQuestionList(questions) {
    els.list.innerHTML = questions
      .map(
        (q) => `
      <div class="blk" data-idx="${q.index}">
        <div class="num">${pad2(q.index)}</div>
        <div class="body">
          <div class="stem">${esc(q.stem).slice(0, 120)}</div>
          <div class="ans">作答中…</div>
          <div class="acts">
            <a data-loc="${q.index}">↳ 定位</a>
            <a data-copy="${q.index}">⧉ 复制</a>
            <a data-fill="${q.index}" hidden>⇢ 填入</a>
          </div>
        </div>
      </div>`
      )
      .join("");
    root.querySelectorAll(".acts a[data-loc]").forEach((a) =>
      a.addEventListener("click", () => locate(Number(a.dataset.loc)))
    );
    root.querySelectorAll(".acts a[data-copy]").forEach((a) =>
      a.addEventListener("click", () => onCopy(Number(a.dataset.copy)))
    );
    root.querySelectorAll(".acts a[data-fill]").forEach((a) =>
      a.addEventListener("click", () => onFill(Number(a.dataset.fill), a))
    );
  }

  // 把整卷单次返回的结果铺进已渲染好的题块里。
  function fillAnswers(result, questions) {
    if (result && result.mode === "raw") {
      renderRaw(result.raw || "");
      return;
    }
    const byIndex = {};
    (result && result.answers ? result.answers : []).forEach((a) => {
      byIndex[a.index] = a.answer;
    });
    answers.clear();
    questions.forEach((q) => {
      const blk = root.querySelector(`.blk[data-idx="${q.index}"]`);
      if (!blk) return;
      const aEl = blk.querySelector(".ans");
      const acts = blk.querySelector(".acts");
      blk.classList.remove("bg");
      aEl.className = "ans";
      if (acts) acts.style.display = "";
      const has = Object.prototype.hasOwnProperty.call(byIndex, q.index);
      // 模型没返回该题：当背景块处理，无操作链
      if (!has) {
        blk.classList.add("bg");
        aEl.className = "ans none";
        aEl.textContent = "— 模型未返回 —";
        if (acts) acts.style.display = "none";
        return;
      }
      const val = String(byIndex[q.index] ?? "");
      answers.set(q.index, val); // 存进 Map 供「复制」复用
      // 空字符串 = 模型判定为个人信息/背景，无需作答：背景块样式、无操作链
      if (val.trim() === "") {
        blk.classList.add("bg");
        aEl.className = "ans none";
        aEl.textContent = "— 背景 · 作上下文 —";
        if (acts) acts.style.display = "none";
        return;
      }
      if (/^【笔记未覆盖】/.test(val)) aEl.classList.add("miss");
      aEl.textContent = val;
      // 文本可填的题才露出「填入」链（选择题 fillFieldOf 为 null → 保持隐藏）
      const fillLink = blk.querySelector("a[data-fill]");
      if (fillLink) fillLink.hidden = !fillFieldOf(q.index);
    });
    // 开关开启：铺完答案后依次自动填入页面（仅 structured 分支，raw 兜底不填）
    if (state.autoFill) autoFillAll(questions);
  }

  // 兜底：模型没按 JSON 返回时，把 raw 整段显示成一块，给一个「⧉复制全部」。
  function renderRaw(raw) {
    answers.clear();
    els.list.innerHTML = `
      <div class="blk">
        <div class="num">~~</div>
        <div class="body">
          <div class="stem">原始返回</div>
          <div class="ans raw"></div>
          <div class="acts"><a id="copyall">⧉ 复制全部</a></div>
        </div>
      </div>`;
    root.querySelector(".ans.raw").textContent = raw;
    const btn = root.getElementById("copyall");
    if (btn)
      btn.addEventListener("click", () => {
        copyText(raw);
        setStatus("已复制全部内容");
      });
  }

  // 定位：滚动到题目并短暂高亮。scrollIntoView 不触发 window blur，安全。
  function locate(index) {
    const el = qEls.get(index);
    if (!el) {
      setStatus("定位不到第 " + index + " 题的元素");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #9A7B33";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 1500);
  }

  // 复制该题答案（从 answers Map 取）；还没作答完/无需作答则提示，不复制。
  function onCopy(index) {
    if (!answers.has(index)) {
      setStatus("第 " + index + " 题还在作答中，请稍候");
      return;
    }
    const val = String(answers.get(index) ?? "");
    if (!val.trim()) {
      setStatus("第 " + index + " 题无需作答");
      return;
    }
    copyText(val);
    setStatus("已复制第 " + index + " 题答案");
  }

  /* ============================================================
   * ④ 自动填充：把答案写进页面对应文本框（可选）
   * ========================================================== */
  // 文本作答框选择器：textarea / 单行文本 / 数字 / 无 type 的 input（选择题取不到 → null）。
  const FILL_SELECTOR =
    'textarea, input[type="text"], input[type="number"], input:not([type])';

  function fillFieldOf(index) {
    const el = qEls.get(index);
    return el ? el.querySelector(FILL_SELECTOR) : null;
  }

  // 把某题答案填进页面文本框，并派发 input/change 让页面框架（问卷星 jQuery）感知。
  // programmatic 赋值不走 paste，与破反粘贴逻辑无冲突。
  // 缺元素 / 空答案 / 非文本框 → 返回 false（背景题、选择题不填，MVP 不点选项）。
  function fillOne(index) {
    const el = qEls.get(index);
    const raw = answers.get(index);
    if (!el || !raw) return false;
    const text = raw.replace(/^【笔记未覆盖】\s*/, ""); // 剥掉 UI 标记前缀
    if (!text.trim()) return false;
    const field = el.querySelector(FILL_SELECTOR);
    if (!field) return false;
    field.focus();
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
    return true;
  }

  // 单题「填入」：成功则链文字临时变「已填 ✓」1.5s；失败状态栏提示不是文本框。
  function onFill(index, linkEl) {
    if (fillOne(index)) {
      if (linkEl) {
        const prev = linkEl.textContent;
        linkEl.textContent = "已填 ✓";
        setTimeout(() => {
          linkEl.textContent = prev;
        }, 1500);
      }
    } else {
      setStatus("该题不是文本框，未填");
    }
  }

  // 自动填全部：依次填「文本可填且答案非空」的题，题间 ~80ms 降低机械感。
  async function autoFillAll(questions) {
    let n = 0;
    for (const q of questions) {
      if (fillOne(q.index)) {
        n++;
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    setStatus(`已自动填入 ${n} 题`);
  }

  // MV3 后台 SW 可能休眠/扩展刚重载 → 首次 sendMessage 偶发
  // "Could not establish connection"。带一次重试：先发一次唤醒 SW，等 350ms 再重试。
  async function sendBg(message) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (e) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }
        throw e;
      }
    }
  }

  // 扫题作答：扫题 → 先把所有题行渲染出来 → 一次性把整卷送 background 生成 → 结果铺回各行。
  async function runScan() {
    showOverlay();
    const questions = scanQuestions();
    if (!questions.length) {
      currentQuestions = [];
      answers.clear();
      els.list.innerHTML = "";
      setStatus("没扫到题目（确认在答题页且题目已加载）");
      return;
    }
    currentQuestions = questions;
    answers.clear();
    renderQuestionList(questions);
    setStatus(`作答中… 共 ${questions.length} 题`);

    let resp;
    try {
      resp = await sendBg({ type: "ASK_ALL", questions });
    } catch (e) {
      setStatus("扩展通信失败，请在 chrome://extensions 重新加载本扩展并刷新页面(F5)后重试");
      return;
    }
    if (!resp || !resp.ok) {
      setStatus("失败：" + (resp?.error || "未知错误"));
      return;
    }
    fillAnswers(resp.result, questions);
    setStatus(`完成，共 ${questions.length} 题`);
  }

  /* ============================================================
   * 消息 & 快捷键
   * ========================================================== */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOGGLE_OVERLAY") toggleOverlay();
    else if (msg?.type === "SCAN_NOW") runScan();
  });

  // 主题跨端同步：popup 改了 config.theme → 悬浮窗实时跟随（若已挂载）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.config || !host) return;
    const cfg = changes.config.newValue || {};
    if (cfg.theme && cfg.theme !== state.theme) applyTheme(cfg.theme);
    if (typeof cfg.autoFill === "boolean" && cfg.autoFill !== state.autoFill)
      applyAutoFill(cfg.autoFill);
  });

  // content 侧快捷键兜底（防止 chrome.commands 未注册时失效）
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "x") { e.preventDefault(); toggleOverlay(); }
        else if (k === "s") { e.preventDefault(); runScan(); }
      }
    },
    true
  );

  // 破限尽早执行（document_start）
  unlockCopyPaste();
})();
