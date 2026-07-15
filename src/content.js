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
  const OVERLAY_CSS = `
    :host { all: initial; }
    .panel {
      width: 340px; max-height: 70vh; display: flex; flex-direction: column;
      font: 13px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #e6e6e6; background: rgba(20,22,28,0.92);
      border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.45); overflow: hidden;
    }
    .bar { display:flex; align-items:center; gap:6px; padding:6px 8px;
      background: rgba(255,255,255,0.04); cursor: move; user-select: none; }
    .bar .title { flex:1; font-size:12px; color:#9aa0aa; letter-spacing:1px; }
    .bar button { all: unset; cursor:pointer; padding:2px 6px; border-radius:4px;
      font-size:12px; color:#cfd3da; }
    .bar button:hover { background: rgba(255,255,255,0.08); }
    .tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      padding:6px 10px; border-bottom:1px solid rgba(255,255,255,0.06); }
    .tools label { font-size:11px; color:#8b909a; display:flex; align-items:center; gap:4px; }
    .tools input[type=range] { width:70px; accent-color:#6b8afd; }
    .go { all: unset; cursor:pointer; background:#3a56d4; color:#fff; padding:4px 10px;
      border-radius:6px; font-size:12px; }
    .go:hover { background:#4864e6; }
    .status { padding:4px 10px; font-size:11px; color:#8b909a; min-height:14px; }
    .list { overflow:auto; padding:4px 10px 10px; }
    .qa { margin-bottom:10px; border-bottom:1px dashed rgba(255,255,255,0.07); padding-bottom:8px; }
    .qa .q { color:#c7ccd4; font-size:12px; margin-bottom:3px; }
    .qa .q .tag { color:#6b8afd; margin-right:4px; }
    .qa .a { white-space:pre-wrap; color:#eef0f3; background:rgba(255,255,255,0.03);
      border-radius:6px; padding:6px 8px; font-size:12.5px; }
    .qa .a.miss { color:#e0b062; }
    .qa .a.empty { color:#6b7280; font-style:italic; background:transparent; padding:2px 0; }
    .qa .copy { all:unset; cursor:pointer; float:right; font-size:11px; color:#8b909a;
      padding:1px 6px; border-radius:4px; }
    .qa .copy:hover { background:rgba(255,255,255,0.08); color:#cfd3da; }
    .qa .loc { all:unset; cursor:pointer; float:right; font-size:11px; color:#8b909a;
      padding:1px 6px; border-radius:4px; margin-left:4px; }
    .qa .loc:hover { background:rgba(255,255,255,0.08); color:#cfd3da; }
    .qa .a.err { color:#e0736b; background:transparent; }
    .raw { white-space:pre-wrap; }
    /* 移开收起用的小把手：右下角低存在感圆点 */
    .handle {
      position:fixed; right:16px; bottom:16px; width:34px; height:34px;
      display:none; align-items:center; justify-content:center;
      border-radius:50%; background:rgba(20,22,28,0.6); color:#cfd3da;
      font-size:16px; line-height:1; cursor:pointer; user-select:none;
      opacity:0.45; transition:opacity 0.15s ease;
      box-shadow:0 4px 14px rgba(0,0,0,0.4);
    }
    .handle:hover { opacity:1; }
  `;

  const OVERLAY_HTML = `
    <div class="handle" id="handle" title="点开复习面板">≡</div>
    <div class="panel" id="panel">
      <div class="bar" id="bar">
        <span class="title">· 复习面板 ·</span>
        <button id="scan" class="go">扫题作答</button>
        <button id="hide" title="快捷键 Ctrl+Shift+X 秒隐">×</button>
      </div>
      <div class="tools">
        <label>透明 <input type="range" id="opacity" min="0.15" max="1" step="0.05" value="0.95"></label>
        <label>亮度 <input type="range" id="bright" min="0.4" max="1.4" step="0.05" value="1"></label>
        <label><input type="checkbox" id="autocollapse" checked> 移开收起</label>
      </div>
      <div class="status" id="status">按「扫题作答」读取全部题目并一次性生成答案</div>
      <div class="list" id="list"></div>
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
  };

  function ensureOverlay() {
    if (host) return;
    host = document.createElement("div");
    host.id = "__rev_panel_host__";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;top:80px;right:24px;display:none;";
    root = host.attachShadow({ mode: "closed" });
    const wrap = document.createElement("div");
    const st = document.createElement("style");
    st.textContent = OVERLAY_CSS;
    wrap.innerHTML = OVERLAY_HTML;
    root.append(st, wrap);
    (document.body || document.documentElement).appendChild(host);

    els = {
      panel: root.getElementById("panel"),
      handle: root.getElementById("handle"),
      bar: root.getElementById("bar"),
      scan: root.getElementById("scan"),
      hide: root.getElementById("hide"),
      opacity: root.getElementById("opacity"),
      bright: root.getElementById("bright"),
      autoCollapse: root.getElementById("autocollapse"),
      status: root.getElementById("status"),
      list: root.getElementById("list"),
    };
    wireEvents();
    applyVisual();
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

    // 移开收起：鼠标离开面板 → 收起到右下角把手；移到把手 → 展开回面板。
    els.panel.addEventListener("mouseleave", () => {
      if (state.autoCollapse && !state.hidden) setCollapsed(true);
    });
    els.handle.addEventListener("mouseenter", () => setCollapsed(false));
    els.handle.addEventListener("click", () => setCollapsed(false));

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

  // 扫题后先把所有题行渲染出来（答案区显示「作答中…」，复制按钮先隐藏，等答案回来再显示）。
  // 每行 = 复制/定位按钮 + 题号 + 题干 + 答案区。
  function renderQuestionList(questions) {
    els.list.innerHTML = questions
      .map(
        (q) => `
      <div class="qa" data-idx="${q.index}">
        <div class="q"><button class="copy" data-copy="${q.index}" style="display:none">复制</button><button class="loc" data-loc="${q.index}">定位</button><span class="tag">#${q.index}</span><span class="stem">${esc(q.stem).slice(0, 120)}</span></div>
        <div class="a" data-idx="${q.index}">作答中…</div>
      </div>`
      )
      .join("");
    root.querySelectorAll(".loc[data-loc]").forEach((btn) =>
      btn.addEventListener("click", () => locate(Number(btn.dataset.loc)))
    );
    root.querySelectorAll(".copy[data-copy]").forEach((btn) =>
      btn.addEventListener("click", () => onCopy(Number(btn.dataset.copy)))
    );
  }

  // 把整卷单次返回的结果铺进已渲染好的题行里。
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
      const row = root.querySelector(`.qa[data-idx="${q.index}"]`);
      if (!row) return;
      const aEl = row.querySelector(".a");
      const copyBtn = row.querySelector(".copy");
      aEl.className = "a";
      const has = Object.prototype.hasOwnProperty.call(byIndex, q.index);
      // 模型没返回该题
      if (!has) {
        aEl.classList.add("empty");
        aEl.textContent = "（模型未返回该题）";
        if (copyBtn) copyBtn.style.display = "none";
        return;
      }
      const val = String(byIndex[q.index] ?? "");
      answers.set(q.index, val); // 存进 Map 供「复制」复用
      // 空字符串 = 模型判定为个人信息/背景，无需作答：灰色提示、不给复制按钮
      if (val.trim() === "") {
        aEl.classList.add("empty");
        aEl.textContent = "（背景/无需作答）";
        if (copyBtn) copyBtn.style.display = "none";
        return;
      }
      if (/^【笔记未覆盖】/.test(val)) aEl.classList.add("miss");
      aEl.textContent = val;
      if (copyBtn) copyBtn.style.display = "";
    });
  }

  // 兜底：模型没按 JSON 返回时，把 raw 整段显示在列表顶部，给一个「复制全部」。
  function renderRaw(raw) {
    answers.clear();
    els.list.innerHTML = `
      <div class="qa">
        <div class="q"><button class="copy" id="copyall">复制全部</button><span class="tag">原始返回</span></div>
        <div class="a raw"></div>
      </div>`;
    root.querySelector(".a.raw").textContent = raw;
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
    el.style.outline = "2px solid #6b8afd";
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
