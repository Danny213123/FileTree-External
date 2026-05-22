const state = {
  data: null,
  nodes: [],
  nodeById: new Map(),
  expanded: new Set(),
  selectedId: 0,
  sortKey: "size",
  sortDir: -1,
  metric: "size",
  unit: "auto",
  filter: "",
  showFiles: true,
  scanController: null,
  exactDuplicateGroups: null,
};

const palette = [
  "#2180a8",
  "#2f9f7f",
  "#ad7a24",
  "#7f65d8",
  "#a94f5b",
  "#4d88c7",
  "#5d9652",
  "#c5794b",
];

const $ = (id) => document.getElementById(id);

const els = {
  path: $("pathInput"),
  scan: $("scanBtn"),
  cancel: $("cancelBtn"),
  refresh: $("refreshBtn"),
  status: $("statusText"),
  roots: $("rootButtons"),
  metric: $("metricGroup"),
  unit: $("unitGroup"),
  threads: $("threadsInput"),
  exclude: $("excludeInput"),
  hidden: $("hiddenToggle"),
  follow: $("followToggle"),
  files: $("filesToggle"),
  filter: $("filterInput"),
  rows: $("rows"),
  summary: $("summaryPanel"),
  selection: $("selectionPanel"),
  footer: $("footerStats"),
  rowStats: $("rowStats"),
  treemap: $("treemap"),
  extensions: $("extensionList"),
  ages: $("ageList"),
  top: $("topList"),
  duplicates: $("duplicateList"),
  errors: $("errorList"),
  duplicateMin: $("duplicateMinInput"),
  exactDup: $("exactDupBtn"),
  exportCsv: $("exportCsvBtn"),
  exportJson: $("exportJsonBtn"),
  exportHtml: $("exportHtmlBtn"),
  context: $("contextMenu"),
};

window.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  try {
    const config = await getJson("/api/config");
    els.path.value = config.initialPath || "";
    els.threads.value = config.defaultThreads || 8;
    const drives = await getJson("/api/drives");
    renderRoots(drives.roots || []);
    if (els.path.value) {
      await startScan();
    }
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function bindEvents() {
  els.scan.addEventListener("click", startScan);
  els.refresh.addEventListener("click", startScan);
  els.cancel.addEventListener("click", () => {
    if (state.scanController) {
      state.scanController.abort();
      setStatus("Cancelled locally");
    }
  });
  els.metric.addEventListener("click", (event) => {
    const btn = event.target.closest(".segment");
    if (!btn) return;
    els.metric.querySelectorAll(".segment").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.metric = btn.dataset.value;
    renderAll();
  });
  els.unit.addEventListener("click", (event) => {
    const btn = event.target.closest(".segment");
    if (!btn) return;
    els.unit.querySelectorAll(".segment").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.unit = btn.dataset.value;
    renderAll();
  });
  els.files.addEventListener("change", () => {
    state.showFiles = els.files.checked;
    renderRows();
    renderTreemap();
  });
  els.filter.addEventListener("input", () => {
    state.filter = els.filter.value.trim().toLowerCase();
    renderRows();
  });
  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir *= -1;
      } else {
        state.sortKey = key;
        state.sortDir = key === "name" ? 1 : -1;
      }
      renderRows();
    });
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  els.rows.addEventListener("click", handleRowClick);
  els.rows.addEventListener("dblclick", handleRowDblClick);
  els.rows.addEventListener("contextmenu", handleRowContext);
  els.context.addEventListener("click", handleContextAction);
  els.duplicates.addEventListener("click", handlePathButtonClick);
  els.top.addEventListener("click", handlePathButtonClick);
  document.addEventListener("click", (event) => {
    if (!els.context.contains(event.target)) {
      els.context.hidden = true;
    }
  });
  els.exportCsv.addEventListener("click", () => {
    if (state.data) window.location.href = "/api/export.csv";
  });
  els.exportJson.addEventListener("click", () => {
    if (state.data) window.location.href = "/api/export.json";
  });
  els.exportHtml.addEventListener("click", exportHtmlSnapshot);
  els.exactDup.addEventListener("click", runExactDuplicateScan);
}

async function startScan() {
  if (state.scanController) return;
  const params = new URLSearchParams({
    path: els.path.value,
    threads: els.threads.value || "8",
    hidden: els.hidden.checked ? "1" : "0",
    follow: els.follow.checked ? "1" : "0",
    exclude: els.exclude.value || "",
  });

  state.scanController = new AbortController();
  setBusy(true);
  setStatus("Scanning");
  try {
    const response = await fetch(`/api/scan?${params.toString()}`, {
      signal: state.scanController.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text);
    }
    const data = await response.json();
    ingestData(data);
    setStatus(`Scanned ${formatCount(data.nodeCount)} nodes in ${formatDuration(data.elapsedMs)}`);
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus("Scan failed");
      alert(cleanError(error.message || String(error)));
    }
  } finally {
    state.scanController = null;
    setBusy(false);
  }
}

function ingestData(data) {
  state.data = data;
  state.nodes = data.nodes || [];
  state.nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  state.expanded = new Set([0]);
  state.selectedId = 0;
  state.exactDuplicateGroups = null;
  renderAll();
}

function renderAll() {
  renderSummary();
  renderSelection();
  renderRows();
  renderTreemap();
  renderExtensions();
  renderTopFiles();
  renderDuplicates();
  renderErrors();
}

function renderRoots(roots) {
  els.roots.innerHTML = "";
  roots.slice(0, 8).forEach((root) => {
    const button = document.createElement("button");
    button.textContent = root;
    button.title = root;
    button.addEventListener("click", () => {
      els.path.value = root;
      startScan();
    });
    els.roots.appendChild(button);
  });
}

function renderSummary() {
  if (!state.data || !state.nodes.length) {
    els.summary.innerHTML = `<div class="empty">No scan loaded</div>`;
    return;
  }
  const root = state.nodes[0];
  els.summary.innerHTML = [
    statHtml("Size", formatMetric(root.size, "size")),
    statHtml("Allocated", formatMetric(root.allocated, "allocated")),
    statHtml("Files", formatCount(root.files)),
    statHtml("Folders", formatCount(root.folders)),
    statHtml("Nodes", formatCount(state.data.nodeCount)),
    statHtml("Errors", formatCount(state.data.errorCount || 0)),
  ].join("");
  els.footer.textContent = `${root.path} | ${formatMetric(root.size, "size")} | ${formatCount(root.files)} files | ${formatDuration(state.data.elapsedMs)} | ${state.data.threadCount} threads`;
}

function renderSelection() {
  const node = currentNode();
  if (!node) {
    els.selection.innerHTML = "";
    return;
  }
  const percent = percentOfParent(node);
  els.selection.innerHTML = `
    <div class="selection-title">
      <span class="kind ${node.dir ? "dir" : "file"}"></span>
      <strong title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</strong>
    </div>
    <div class="selection-meta">
      <span>Size</span><strong>${formatMetric(node.size, "size")}</strong>
      <span>Allocated</span><strong>${formatMetric(node.allocated, "allocated")}</strong>
      <span>Files</span><strong>${formatCount(node.files)}</strong>
      <span>Folders</span><strong>${formatCount(node.folders)}</strong>
      <span>Parent</span><strong>${percent.toFixed(1)}%</strong>
      <span>Modified</span><strong>${formatDate(node.modified)}</strong>
    </div>
    <div class="selection-actions">
      <button data-selection-action="open">Open</button>
      <button data-selection-action="reveal">Reveal</button>
      <button data-selection-action="copy">Copy path</button>
    </div>
  `;
  els.selection.querySelectorAll("[data-selection-action]").forEach((button) => {
    button.addEventListener("click", () => runNodeAction(button.dataset.selectionAction, node));
  });
}

function renderRows() {
  if (!state.data || !state.nodes.length) {
    els.rows.innerHTML = `<div class="empty">No scan loaded</div>`;
    els.rowStats.textContent = "";
    return;
  }

  const visible = makeVisibilityPredicate();
  const ids = [];
  collectVisibleRows(0, ids, visible);
  const limit = 5000;
  const shown = ids.slice(0, limit);
  els.rows.innerHTML = shown.map((id) => rowHtml(state.nodeById.get(id))).join("");
  els.rowStats.textContent = `${formatCount(shown.length)} shown${ids.length > shown.length ? ` of ${formatCount(ids.length)}` : ""}`;
}

function rowHtml(node) {
  const parentMetric = parentMetricValue(node);
  const metric = metricValue(node);
  const bar = parentMetric > 0 ? Math.min(100, (metric / parentMetric) * 100) : node.parent == null ? 100 : 0;
  const percent = percentOfParent(node);
  const selected = node.id === state.selectedId ? " selected" : "";
  const expanded = state.expanded.has(node.id);
  const twisty = node.dir && node.children.length ? (expanded ? "v" : ">") : "";
  const prependedMetric = formatMetric(metric, state.metric);
  return `
    <div class="row${selected}" data-id="${node.id}">
      <div class="cell name-cell" style="--depth:${node.depth};--bar-width:${bar}%">
        <button class="twisty" data-toggle="${node.id}">${twisty}</button>
        <span class="kind ${node.dir ? "dir" : "file"}"></span>
        <span class="name-text" title="${escapeHtml(node.path)}">${escapeHtml(prependedMetric)}  ${escapeHtml(node.name)}</span>
      </div>
      <div class="cell num">${formatMetric(node.size, "size")}</div>
      <div class="cell num">${formatMetric(node.allocated, "allocated")}</div>
      <div class="cell num">${formatCount(node.files)}</div>
      <div class="cell num">${formatCount(node.folders)}</div>
      <div class="cell percent-cell" style="--percent:${Math.min(100, percent)}"><span>${percent.toFixed(1)}%</span></div>
      <div class="cell num">${formatDate(node.modified)}</div>
    </div>
  `;
}

function makeVisibilityPredicate() {
  const memo = new Map();
  const filter = state.filter;
  function visible(id) {
    if (memo.has(id)) return memo.get(id);
    const node = state.nodeById.get(id);
    if (!node) return false;
    const direct = (!filter || nodeMatchesFilter(node, filter)) && (state.showFiles || node.dir);
    const child = node.dir && node.children.some((childId) => visible(childId));
    const result = direct || child;
    memo.set(id, result);
    return result;
  }
  return visible;
}

function collectVisibleRows(id, out, visible) {
  const node = state.nodeById.get(id);
  if (!node || !visible(id)) return;
  out.push(id);
  if (node.dir && (state.expanded.has(id) || state.filter)) {
    sortedChildren(node).forEach((child) => collectVisibleRows(child.id, out, visible));
  }
}

function sortedChildren(node) {
  return node.children
    .map((id) => state.nodeById.get(id))
    .filter(Boolean)
    .filter((child) => state.showFiles || child.dir)
    .sort(compareNodes);
}

function compareNodes(left, right) {
  const dirBias = Number(right.dir) - Number(left.dir);
  if (dirBias !== 0 && state.sortKey === "name") return dirBias;
  const a = sortValue(left, state.sortKey);
  const b = sortValue(right, state.sortKey);
  if (a < b) return -1 * state.sortDir;
  if (a > b) return 1 * state.sortDir;
  return left.name.localeCompare(right.name);
}

function sortValue(node, key) {
  switch (key) {
    case "name":
      return node.name.toLowerCase();
    case "allocated":
      return node.allocated;
    case "files":
      return node.files;
    case "folders":
      return node.folders;
    case "percent":
      return percentOfParent(node);
    case "modified":
      return node.modified;
    default:
      return node.size;
  }
}

function handleRowClick(event) {
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const id = Number(toggle.dataset.toggle);
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderRows();
    return;
  }
  const row = event.target.closest(".row");
  if (!row) return;
  selectNode(Number(row.dataset.id));
}

function handleRowDblClick(event) {
  const row = event.target.closest(".row");
  if (!row) return;
  const id = Number(row.dataset.id);
  const node = state.nodeById.get(id);
  if (!node) return;
  if (node.dir) {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
    } else {
      state.expanded.add(id);
    }
    renderRows();
  } else {
    runNodeAction("open", node);
  }
}

function handleRowContext(event) {
  const row = event.target.closest(".row");
  if (!row) return;
  event.preventDefault();
  selectNode(Number(row.dataset.id));
  els.context.style.left = `${event.clientX}px`;
  els.context.style.top = `${event.clientY}px`;
  els.context.hidden = false;
}

function handleContextAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const node = currentNode();
  if (node) runNodeAction(button.dataset.action, node);
  els.context.hidden = true;
}

function selectNode(id) {
  state.selectedId = id;
  renderRows();
  renderSelection();
  renderTreemap();
}

async function runNodeAction(action, node) {
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(node.path);
      setStatus("Path copied");
    } catch (_) {
      setStatus(node.path);
    }
    return;
  }
  if (action === "delete") {
    if (!confirm(`Are you sure you want to permanently delete this item?\n\n${node.path}`)) {
      return;
    }
    setStatus("Deleting...");
    try {
      const response = await fetch(`/api/delete?path=${encodeURIComponent(node.path)}`);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text);
      }
      setStatus("Item deleted");
      await startScan();
    } catch (error) {
      alert(`Failed to delete item:\n${cleanError(error.message || String(error))}`);
      setStatus("Delete failed");
    }
    return;
  }
  const endpoint = action === "reveal" ? "/api/reveal" : action === "properties" ? "/api/properties" : "/api/open";
  await fetch(`${endpoint}?path=${encodeURIComponent(node.path)}`);
}

function renderTreemap() {
  const node = currentNode();
  if (!node || !node.children.length) {
    els.treemap.innerHTML = `<div class="empty">No children</div>`;
    return;
  }
  const items = sortedChildren(node)
    .filter((child) => metricValue(child) > 0)
    .slice(0, 160);
  if (!items.length) {
    els.treemap.innerHTML = `<div class="empty">No sized children</div>`;
    return;
  }
  const rects = [];
  layoutTreemap(items, 0, 0, 100, 100, rects);
  els.treemap.innerHTML = rects.map((rect, index) => tileHtml(rect, index)).join("");
  els.treemap.querySelectorAll(".tile").forEach((tile) => {
    tile.addEventListener("dblclick", () => {
      const id = Number(tile.dataset.id);
      state.expanded.add(id);
      selectNode(id);
    });
  });
}

function layoutTreemap(items, x, y, w, h, out) {
  if (!items.length || w <= 0 || h <= 0) return;
  if (items.length === 1) {
    out.push({ node: items[0], x, y, w, h });
    return;
  }
  const total = items.reduce((sum, node) => sum + metricValue(node), 0);
  let splitAt = 0;
  let running = 0;
  while (splitAt < items.length - 1 && running < total / 2) {
    running += metricValue(items[splitAt]);
    splitAt += 1;
  }
  const first = items.slice(0, splitAt);
  const second = items.slice(splitAt);
  const firstTotal = first.reduce((sum, node) => sum + metricValue(node), 0);
  const ratio = total > 0 ? firstTotal / total : 0.5;
  if (w >= h) {
    const w1 = w * ratio;
    layoutTreemap(first, x, y, w1, h, out);
    layoutTreemap(second, x + w1, y, w - w1, h, out);
  } else {
    const h1 = h * ratio;
    layoutTreemap(first, x, y, w, h1, out);
    layoutTreemap(second, x, y + h1, w, h - h1, out);
  }
}

function tileHtml(rect, index) {
  const node = rect.node;
  const color = palette[index % palette.length];
  const label = rect.w * rect.h > 80
    ? `<strong>${escapeHtml(node.name)}</strong><span>${formatMetric(metricValue(node), state.metric)}</span>`
    : "";
  return `
    <div class="tile" data-id="${node.id}" title="${escapeHtml(node.path)}" style="left:${rect.x}%;top:${rect.y}%;width:${rect.w}%;height:${rect.h}%;background:${color}">
      ${label}
    </div>
  `;
}

function renderExtensions() {
  if (!state.data) {
    els.extensions.innerHTML = "";
    els.ages.innerHTML = "";
    return;
  }
  renderBarList(
    els.extensions,
    state.data.extensionStats || [],
    (item) => item.ext,
    (item) => item.bytes,
    (item) => `${formatMetric(item.bytes, "size")} | ${formatCount(item.files)} files`
  );
  renderBarList(
    els.ages,
    state.data.ageStats || [],
    (item) => item.label,
    (item) => item.bytes,
    (item) => `${formatMetric(item.bytes, "size")} | ${formatCount(item.files)} files`
  );
}

function renderTopFiles() {
  if (!state.data) {
    els.top.innerHTML = "";
    return;
  }
  const ids = state.data.topFiles || [];
  els.top.innerHTML = ids.map((id) => {
    const node = state.nodeById.get(id);
    if (!node) return "";
    return `
      <div class="item-row" data-path-id="${node.id}">
        <header><strong title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</strong><span>${formatMetric(node.size, "size")}</span></header>
        <small>${escapeHtml(node.path)}</small>
      </div>
    `;
  }).join("") || `<div class="empty">No files</div>`;
}

function handlePathButtonClick(event) {
  const target = event.target.closest("[data-path-id]");
  if (!target) return;
  const id = Number(target.dataset.pathId);
  if (!state.nodeById.has(id)) return;
  revealAncestors(id);
  selectNode(id);
}

function revealAncestors(id) {
  let node = state.nodeById.get(id);
  while (node && node.parent != null) {
    state.expanded.add(node.parent);
    node = state.nodeById.get(node.parent);
  }
}

function renderDuplicates() {
  if (!state.data) {
    els.duplicates.innerHTML = "";
    return;
  }
  if (state.exactDuplicateGroups) {
    els.duplicates.innerHTML = duplicateGroupHtml(state.exactDuplicateGroups, true);
    return;
  }
  const groups = state.data.duplicateCandidates || [];
  els.duplicates.innerHTML = duplicateGroupHtml(groups, false);
}

function duplicateGroupHtml(groups, exact) {
  if (!groups.length) return `<div class="empty">No duplicate groups</div>`;
  return groups.map((group) => {
    const ids = group.ids || [];
    const paths = ids.slice(0, 8).map((id) => {
      const node = state.nodeById.get(id);
      if (!node) return "";
      return `<button data-path-id="${node.id}" title="${escapeHtml(node.path)}">${escapeHtml(node.path)}</button>`;
    }).join("");
    const title = exact ? `Hash ${escapeHtml(group.hash || "")}` : escapeHtml(group.name || "same size");
    return `
      <div class="item-row">
        <header><strong>${title}</strong><span>${formatMetric(group.waste || 0, "size")} reclaimable</span></header>
        <small>${formatCount(ids.length)} files | ${formatMetric(group.size || 0, "size")} each</small>
        <div class="paths">${paths}</div>
      </div>
    `;
  }).join("");
}

async function runExactDuplicateScan() {
  if (!state.data) return;
  els.exactDup.disabled = true;
  setStatus("Hashing duplicate candidates");
  try {
    const minSize = Math.max(0, Number(els.duplicateMin.value || 0));
    const data = await getJson(`/api/duplicates?minSize=${encodeURIComponent(minSize)}&limit=100`);
    state.exactDuplicateGroups = data.groups || [];
    renderDuplicates();
    setStatus(`Exact duplicate groups: ${formatCount(state.exactDuplicateGroups.length)}`);
  } catch (error) {
    alert(cleanError(error.message || String(error)));
  } finally {
    els.exactDup.disabled = false;
  }
}

function renderErrors() {
  if (!state.data) {
    els.errors.innerHTML = "";
    return;
  }
  const errors = state.data.scanErrors || [];
  els.errors.innerHTML = errors.map((error) => `
    <div class="item-row">
      <header><strong title="${escapeHtml(error.path)}">${escapeHtml(error.path)}</strong></header>
      <small>${escapeHtml(error.message)}</small>
    </div>
  `).join("") || `<div class="empty">No scan errors</div>`;
}

function renderBarList(container, items, labelFn, valueFn, metaFn) {
  const max = Math.max(1, ...items.map(valueFn));
  container.innerHTML = items.map((item) => {
    const value = valueFn(item);
    return `
      <div class="bar-row">
        <header><strong>${escapeHtml(labelFn(item))}</strong><span>${metaFn(item)}</span></header>
        <div class="bar-track"><div class="bar-fill" style="--bar:${(value / max) * 100}%"></div></div>
      </div>
    `;
  }).join("") || `<div class="empty">No data</div>`;
}

function activateTab(name) {
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  });
}

function currentNode() {
  return state.nodeById.get(state.selectedId) || state.nodes[0] || null;
}

function metricValue(node) {
  switch (state.metric) {
    case "allocated":
      return node.allocated;
    case "files":
      return node.files;
    case "folders":
      return node.folders;
    default:
      return node.size;
  }
}

function parentMetricValue(node) {
  if (node.parent == null) return metricValue(node);
  const parent = state.nodeById.get(node.parent);
  return parent ? metricValue(parent) : metricValue(node);
}

function percentOfParent(node) {
  if (node.parent == null) return 100;
  const parent = state.nodeById.get(node.parent);
  return parent && parent.size > 0 ? (node.size / parent.size) * 100 : 0;
}

function nodeMatchesFilter(node, filter) {
  return (
    node.name.toLowerCase().includes(filter) ||
    node.path.toLowerCase().includes(filter) ||
    (node.extension || "").toLowerCase().includes(filter)
  );
}

function statHtml(label, value) {
  return `<div class="stat"><span>${label}</span><strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong></div>`;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function setBusy(busy) {
  els.scan.disabled = busy;
  els.refresh.disabled = busy;
  els.cancel.disabled = !busy;
  els.path.disabled = busy;
}

function setStatus(text) {
  els.status.textContent = text;
}

function formatMetric(value, metric) {
  if (metric === "files" || metric === "folders") return formatCount(value);
  return formatBytes(value || 0);
}

function formatBytes(value) {
  const units = [
    ["tb", 1024 ** 4, "TB"],
    ["gb", 1024 ** 3, "GB"],
    ["mb", 1024 ** 2, "MB"],
    ["kb", 1024, "KB"],
    ["bytes", 1, "B"],
  ];
  const selected = state.unit;
  const unit = selected === "auto"
    ? units.find((candidate) => Math.abs(value) >= candidate[1]) || units[4]
    : units.find((candidate) => candidate[0] === selected) || units[4];
  if (unit[0] === "bytes") return `${formatCount(value)} B`;
  const amount = value / unit[1];
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit[2]}`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatDuration(ms) {
  ms = Number(ms || 0);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatDate(ms) {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cleanError(text) {
  return String(text).replace(/^\{"error":"?|"?\}$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function exportHtmlSnapshot() {
  if (!state.data || !state.nodes.length) return;
  const root = state.nodes[0];
  const top = (state.data.topFiles || []).slice(0, 30).map((id) => {
    const node = state.nodeById.get(id);
    return node ? `<tr><td>${escapeHtml(node.path)}</td><td>${formatBytes(node.size)}</td></tr>` : "";
  }).join("");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>FileTree Snapshot</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#101113;color:#f2f5f7;margin:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #333840;padding:8px;text-align:left}th{background:#202328}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.stat{background:#181a1e;border:1px solid #333840;padding:12px;border-radius:8px}.muted{color:#a9b0b8}</style>
</head><body>
<h1>FileTree Snapshot</h1>
<p class="muted">${escapeHtml(root.path)}</p>
<div class="stats">
<div class="stat"><div class="muted">Size</div><strong>${formatBytes(root.size)}</strong></div>
<div class="stat"><div class="muted">Allocated</div><strong>${formatBytes(root.allocated)}</strong></div>
<div class="stat"><div class="muted">Files</div><strong>${formatCount(root.files)}</strong></div>
<div class="stat"><div class="muted">Folders</div><strong>${formatCount(root.folders)}</strong></div>
</div>
<h2>Top files</h2><table><thead><tr><th>Path</th><th>Size</th></tr></thead><tbody>${top}</tbody></table>
</body></html>`;
  downloadText("filetree-snapshot.html", "text/html", html);
}

function downloadText(filename, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
