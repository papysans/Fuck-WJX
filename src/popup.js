const $ = (id) => document.getElementById(id);

async function load() {
  const { config = {}, notes = "" } = await chrome.storage.local.get(["config", "notes"]);
  $("notes").value = notes;
  $("baseUrl").value = config.baseUrl || "";
  $("apiKey").value = config.apiKey || "";
  $("model").value = config.model || "";
  $("temperature").value = config.temperature ?? 0.3;
}

function msg(text, isErr) {
  const el = $("msg");
  el.textContent = text;
  el.className = "msg" + (isErr ? " err" : "");
  if (text) setTimeout(() => (el.textContent = ""), 2500);
}

async function save() {
  const config = {
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    temperature: Number($("temperature").value) || 0.3,
  };
  await chrome.storage.local.set({ config, notes: $("notes").value });
  msg("已保存 ✓");
}

// 先保存，再给当前标签页的 content 发指令
async function sendToTab(type) {
  await save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return msg("找不到当前标签页", true);
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    window.close();
  } catch {
    msg("请在问卷星答题页使用", true);
  }
}

// 导出：把 config + notes 打包成 JSON 文件下载
async function exportConfig() {
  const { config = {}, notes = "" } = await chrome.storage.local.get(["config", "notes"]);
  const blob = new Blob([JSON.stringify({ config, notes }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "review-panel-config.json";
  a.click();
  URL.revokeObjectURL(url);
  msg("已导出 ✓");
}

// 导入：读取选中的 JSON 文件，写回 storage 并重填表单
async function importConfig(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const src = data && typeof data === "object" ? data : {};
    const write = {};
    if (src.config && typeof src.config === "object") write.config = src.config;
    if (typeof src.notes === "string") write.notes = src.notes;
    if (!("config" in write) && !("notes" in write)) {
      return msg("文件缺少 config / notes 字段", true);
    }
    await chrome.storage.local.set(write);
    await load();
    msg("已导入 ✓");
  } catch {
    msg("导入失败：文件不是合法 JSON", true);
  }
}

$("save").addEventListener("click", save);
$("open").addEventListener("click", () => sendToTab("TOGGLE_OVERLAY"));
$("scan").addEventListener("click", () => sendToTab("SCAN_NOW"));
$("export").addEventListener("click", exportConfig);
$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // 允许再次选同一文件
  importConfig(file);
});

load();
