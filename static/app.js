import { DEFAULT } from "./config.js";

// ---------------------------------------------------------------- config
const qs = new URLSearchParams(location.search);
const CFG = {
  name: qs.get("name") || DEFAULT.name,
  bucket: qs.get("bucket") || DEFAULT.bucket,
  endpoint: qs.get("endpoint") || DEFAULT.endpoint,
  prefix: qs.get("prefix") ?? DEFAULT.prefix,
};
const BASE = (CFG.endpoint || `https://${CFG.bucket}.s3.amazonaws.com`).replace(/\/$/, "");
const urlFor = (key) => `${BASE}/${key.split("/").map(encodeURIComponent).join("/")}`;
const LS_INDEX = `bv:index:${BASE}:${CFG.prefix}`;
const LS_STATE = `bv:state:${BASE}:${CFG.prefix}`;
const FPS = 29.97;
let stateReady = false; // set after boot restores state
let booting = true;      // restored panes don't autoplay
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
};
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const fmtSize = (n) => n == null ? "" : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} K` : n < 1e9 ? `${(n / 1e6).toFixed(1)} M` : `${(n / 1e9).toFixed(2)} G`;
const fmtTime = (s) => { s = Math.max(0, s | 0); const m = (s / 60) | 0; return `${(m / 60) | 0}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

const syncEl = $("#sync");

document.title = `${CFG.name} viewer`;
$("#ds-name").textContent = CFG.name;

// ---------------------------------------------------------------- file kinds
function kindOf(name) {
  const n = name.toLowerCase();
  if (/\.(mp4|webm|m4v|mov|ogv)$/.test(n)) return "video";
  if (/\.(nii|nii\.gz|nrrd|nhdr|mha|mhd|mgz|mgh|hdr|img)$/.test(n)) return "vol";
  if (/\.(stl|vtk|obj|gii|ply|mz3|trk|tck|trx)$/.test(n)) return "mesh";
  if (/\.(png|jpe?g|gif|svg|webp|bmp)$/.test(n)) return "img";
  if (/\.(csv|tsv)$/.test(n)) return "table";
  if (/\.(md|txt|json|log|py|sh|yaml|yml|xml|cfg|ini|html)$/.test(n)) return "text";
  return "other";
}
const KIND_LABEL = { video: "vid", vol: "vol", mesh: "mesh", img: "img", table: "csv", text: "txt" };

// ---------------------------------------------------------------- index (S3 listing)
let ROOT = null;          // tree root node
let FILES = [];           // flat list of file nodes
const BYPATH = new Map(); // path -> node

async function listBucket(onPage) {
  const out = [];
  let token = null;
  do {
    const u = new URL(BASE + "/");
    u.searchParams.set("list-type", "2");
    u.searchParams.set("max-keys", "1000");
    if (CFG.prefix) u.searchParams.set("prefix", CFG.prefix);
    if (token) u.searchParams.set("continuation-token", token);
    const r = await fetch(u);
    if (!r.ok) throw new Error(`list ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
    for (const c of doc.getElementsByTagName("Contents")) {
      const key = c.getElementsByTagName("Key")[0].textContent;
      if (key.endsWith("/")) continue;
      out.push([key, +c.getElementsByTagName("Size")[0].textContent, c.getElementsByTagName("LastModified")[0].textContent.slice(0, 10)]);
    }
    token = doc.getElementsByTagName("IsTruncated")[0]?.textContent === "true"
      ? doc.getElementsByTagName("NextContinuationToken")[0].textContent : null;
    onPage?.(out.length);
  } while (token);
  return out;
}

function buildTree(entries) {
  BYPATH.clear();
  const root = { name: CFG.prefix || "/", path: "", dir: true, kids: new Map(), depth: -1 };
  const files = [];
  for (const [key, size, date] of entries) {
    const rel = CFG.prefix && key.startsWith(CFG.prefix) ? key.slice(CFG.prefix.length) : key;
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let nx = node.kids.get(parts[i]);
      if (!nx) {
        nx = { name: parts[i], path: (node.path ? node.path + "/" : "") + parts[i], dir: true, kids: new Map(), parent: node, depth: node.depth + 1 };
        node.kids.set(parts[i], nx);
        BYPATH.set(nx.path, nx);
      }
      node = nx;
    }
    const f = { name: parts.at(-1), path: rel, key, size, date, dir: false, parent: node, depth: node.depth + 1, kind: kindOf(rel) };
    node.kids.set(f.name, f);
    BYPATH.set(rel, f);
    files.push(f);
  }
  const finish = (n) => {
    n.list = [...n.kids.values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.size = 0; n.nfiles = 0;
    for (const k of n.list) {
      if (k.dir) finish(k);
      n.size += k.size; n.nfiles += k.dir ? k.nfiles : 1;
    }
  };
  finish(root);
  ROOT = root; FILES = files;
}

// ---------------------------------------------------------------- tree view
const treeEl = $("#tree");
const filterEl = $("#filter");
const expanded = new Set(lsGet(LS_STATE)?.expanded || []);
let visible = [];       // nodes currently shown
let cur = 0;            // cursor index in visible
let filterTerms = [];
let filterHits = null;  // Set of nodes kept by filter

function computeVisible() {
  visible = [];
  if (!ROOT) return;
  const walk = (n) => {
    for (const k of n.list) {
      if (filterHits && !filterHits.has(k)) continue;
      visible.push(k);
      if (k.dir && (filterHits ? true : expanded.has(k.path))) walk(k);
    }
  };
  walk(ROOT);
}

function applyFilter() {
  const q = filterEl.value.trim().toLowerCase();
  filterTerms = q ? q.split(/\s+/) : [];
  if (!filterTerms.length) { filterHits = null; return; }
  filterHits = new Set();
  let n = 0;
  for (const f of FILES) {
    const p = f.path.toLowerCase();
    if (filterTerms.every((t) => p.includes(t))) {
      n++;
      for (let x = f; x && x !== ROOT; x = x.parent) { if (filterHits.has(x)) break; filterHits.add(x); }
    }
  }
  setStatus(`${n} matching files`);
}

function hl(name) {
  if (!filterTerms.length) return name;
  const frag = document.createDocumentFragment();
  const low = name.toLowerCase();
  const marks = new Array(name.length).fill(false);
  for (const t of filterTerms) { let i = -1; while ((i = low.indexOf(t, i + 1)) >= 0) for (let j = 0; j < t.length; j++) marks[i + j] = true; }
  let i = 0;
  while (i < name.length) {
    let j = i; while (j < name.length && marks[j] === marks[i]) j++;
    frag.append(marks[i] ? h("mark", {}, name.slice(i, j)) : name.slice(i, j));
    i = j;
  }
  return frag;
}

// Virtualised rendering: only rows in view are in the DOM, so huge trees stay instant.
const ROW_H = 20;
const spacer = h("div", { style: "position:relative" });
treeEl.append(spacer);
function renderTree() {
  spacer.style.height = `${visible.length * ROW_H}px`;
  const top = treeEl.scrollTop, hgt = treeEl.clientHeight || 800;
  const a = Math.max(0, Math.floor(top / ROW_H) - 10), b = Math.min(visible.length, Math.ceil((top + hgt) / ROW_H) + 10);
  const openPaths = new Set(panes.map((p) => p.node?.path).filter(Boolean));
  spacer.textContent = "";
  for (let i = a; i < b; i++) {
    const n = visible[i];
    const isOpen = n.dir && (filterHits || expanded.has(n.path));
    const row = h("div", {
      class: `row ${n.dir ? "dir" : "file"} ${i === cur ? "cur" : ""} ${openPaths.has(n.path) ? "open-in" : ""}`,
      style: `position:absolute;top:${i * ROW_H}px;left:0;right:0;padding-left:${6 + n.depth * 14}px`,
      "data-i": i,
    },
      h("span", { class: "tw" }, n.dir ? (isOpen ? "▾" : "▸") : ""),
      h("span", { class: "nm", title: n.path }, hl(n.name)),
      !n.dir && KIND_LABEL[n.kind] ? h("span", { class: `k k-${n.kind}` }, KIND_LABEL[n.kind]) : null,
      h("span", { class: "sz" }, n.dir ? `${n.nfiles} · ${fmtSize(n.size)}` : fmtSize(n.size)),
    );
    spacer.append(row);
  }
}
treeEl.addEventListener("scroll", () => requestAnimationFrame(renderTree));
new ResizeObserver(() => renderTree()).observe(treeEl);

function refreshTree(keepNode) {
  const prev = keepNode ?? visible[cur];
  computeVisible();
  const j = prev ? visible.indexOf(prev) : -1;
  cur = j >= 0 ? j : Math.min(cur, Math.max(0, visible.length - 1));
  renderTree();
  saveState();
}

function scrollToCur() {
  const y = cur * ROW_H, top = treeEl.scrollTop, hgt = treeEl.clientHeight;
  if (y < top) treeEl.scrollTop = y;
  else if (y + ROW_H > top + hgt) treeEl.scrollTop = y + ROW_H - hgt;
}
function moveCur(d) {
  if (!visible.length) return;
  cur = Math.max(0, Math.min(visible.length - 1, cur + d));
  scrollToCur(); renderTree();
}
function toggleDir(n, open = !expanded.has(n.path)) {
  if (filterHits) return;
  open ? expanded.add(n.path) : expanded.delete(n.path);
  refreshTree(n);
}
function activate(n, next = false) {
  if (!n) return;
  if (n.dir) return toggleDir(n);
  openInPane(n, next ? nextPaneIndex() : active);
}

treeEl.addEventListener("click", (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  cur = +row.dataset.i;
  const n = visible[cur];
  treeEl.focus({ preventScroll: true });
  if (n.dir) toggleDir(n); else { renderTree(); activate(n, e.shiftKey); }
});

filterEl.addEventListener("input", () => { applyFilter(); cur = 0; treeEl.scrollTop = 0; refreshTree(null); });
filterEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { filterEl.value = ""; filterEl.dispatchEvent(new Event("input")); treeEl.focus(); }
  if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); treeEl.focus(); if (e.key === "Enter") activate(visible[cur], e.shiftKey); }
});

// ---------------------------------------------------------------- panes
const grid = $("#grid");
const panes = [];
let active = 0;
let layout = 4;

class Pane {
  constructor(i) {
    this.i = i;
    this.node = null;
    this.cleanup = null;
    this.el = h("div", { class: "pane" });
    this.idx = h("span", { class: "idx" }, String(i + 1));
    this.pathEl = h("span", { class: "path" });
    this.ctl = h("span", { class: "ctl" });
    this.body = h("div", { class: "body" });
    this.el.append(h("div", { class: "ph" }, this.idx, this.pathEl, this.ctl,
      h("button", { title: "close (x)", onclick: (e) => { e.stopPropagation(); this.clear(); } }, "×")), this.body);
    this.el.addEventListener("mousedown", () => setActive(this.i));
    this.clear();
  }
  clear() {
    this.cleanup?.(); this.cleanup = null; this.video = null; this.timeline = null; this.share = null;
    this.node = null;
    this.pathEl.textContent = ""; this.pathEl.title = "";
    this.ctl.textContent = "";
    this.body.textContent = "";
    this.body.append(h("div", { class: "empty" }, `pane ${this.i + 1}`, h("br"), h("span", { class: "dim" }, "select a file")));
    renderTree(); saveState();
  }
  async open(node, opts = {}) {
    this.clear();
    this.node = node;
    this.pathEl.textContent = `\u200e${node.path}\u200e`; this.pathEl.title = `${node.path}  (${fmtSize(node.size)})`;
    this.body.textContent = "";
    const token = (this.token = Symbol());
    const alive = () => this.token === token;
    try { await (VIEWERS[node.kind] || viewOther)(this, node, alive, opts); }
    catch (err) { if (alive()) { this.body.textContent = ""; this.body.append(h("div", { class: "info" }, `failed: ${err.message}`, h("br"), h("a", { href: urlFor(node.key), target: "_blank" }, "open raw"))); } }
    renderTree(); saveState();
  }
  button(label, title, fn) { const b = h("button", { title, onclick: (e) => { e.stopPropagation(); fn(b); } }, label); this.ctl.append(b); return b; }
}

for (let i = 0; i < 4; i++) { const p = new Pane(i); panes.push(p); grid.append(p.el); }

function setActive(i) {
  active = i;
  panes.forEach((p, j) => p.el.classList.toggle("active", j === i));
}
function nextPaneIndex() {
  const n = layout;
  for (let k = 1; k <= n; k++) { const j = (active + k) % n; if (!panes[j].node) return j; }
  return (active + 1) % n;
}
function openInPane(node, i, opts) {
  if (i >= layout) setLayout(i < 2 ? 2 : 4);
  setActive(i);
  panes[i].open(node, opts);
}
function setLayout(n) {
  layout = n;
  grid.dataset.layout = n;
  document.querySelectorAll("#layouts button").forEach((b) => b.classList.toggle("on", +b.dataset.layout === n));
  if (active >= n) setActive(0);
  window.dispatchEvent(new Event("resize"));
  saveState();
}
document.querySelectorAll("#layouts button").forEach((b) => b.addEventListener("click", () => setLayout(+b.dataset.layout)));

// ---------------------------------------------------------------- viewers
const VIEWERS = { video: viewVideo, vol: viewVolume, mesh: viewVolume, img: viewImage, table: viewTable, text: viewText };

function viewOther(p, node) {
  p.body.append(h("div", { class: "info" },
    h("div", {}, node.name), h("div", {}, `${fmtSize(node.size)} · ${node.date}`),
    h("div", {}, "no inline preview for this type"),
    h("a", { href: urlFor(node.key), target: "_blank", download: node.name }, "download")));
}

function viewImage(p, node) {
  p.body.append(h("img", { class: "im", src: urlFor(node.key) }));
}

async function rangeText(key, start, end) {
  const r = await fetch(urlFor(key), { headers: { Range: `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function viewText(p, node, alive) {
  const CH = 256 * 1024;
  const pre = h("pre"); const sc = h("div", { class: "scroll" }, pre); p.body.append(sc);
  let off = 0;
  const more = h("button", { class: "more", onclick: () => load() }, "load more");
  async function load() {
    const t = await rangeText(node.key, off, off + CH - 1); if (!alive()) return;
    off += CH;
    let s = t;
    if (off === CH && /\.json$/i.test(node.name) && node.size <= CH) { try { s = JSON.stringify(JSON.parse(t), null, 2); } catch {} }
    pre.append(s);
    more.remove(); if (off < node.size) sc.append(more);
  }
  await load();
}

function parseCSV(text, sep) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  return { rows, tail: row.length || f ? row.join(sep) + (row.length ? sep : "") + f : "" };
}

async function viewTable(p, node, alive) {
  const sep = /\.tsv$/i.test(node.name) ? "\t" : ",";
  const CH = 256 * 1024;
  const tbl = h("table", { class: "tb" }); const tb = h("tbody");
  const sc = h("div", { class: "scroll" }, tbl); p.body.append(sc);
  const more = h("button", { class: "more", onclick: () => load() }, "load more rows");
  let off = 0, carry = "", header = null, nrows = 0;
  async function load() {
    const t = await rangeText(node.key, off, off + CH - 1); if (!alive()) return;
    off += CH;
    const last = off >= node.size;
    const { rows, tail } = parseCSV(carry + t + (last ? "\n" : ""), sep);
    carry = last ? "" : tail;
    if (!header && rows.length) {
      header = rows.shift();
      tbl.append(h("thead", {}, h("tr", {}, h("th", {}, "#"), header.map((c) => h("th", {}, c)))), tb);
    }
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.append(h("tr", {}, h("td", { class: "dim" }, String(nrows++)), r.map((c) => h("td", {}, c))));
    tb.append(frag);
    more.remove(); if (!last) sc.append(more);
    p.pathEl.title = `${node.path} · ${nrows} rows shown`;
  }
  await load();
}

// ---------------------------------------------------------------- video sync
// Videos sync on the OCR'd procedure clock (the T+ timer in the overlay), not on video time:
// recordings are time-compressed and each plane skips idle stretches, so one T+ sits at different
// video times in A and B (which share a clock origin). Followers chase the frame showing the
// leader's T+. The leader is the pane last clicked, or the active pane when a video key is pressed.
let syncLeader = null;
let syncRate = 1;            // the speed you chose; followers' playbackRate is driven by the loop
function takeLead(p) {
  if (!p?.video || !syncEl.checked || syncLeader === p) return;
  syncLeader = p;
  p.video.playbackRate = syncRate;           // drop whatever catch-up speed it had as a follower
  for (const q of panes) q._sync = null;
}
syncEl.addEventListener("change", () => {  // leaving sync: give every video the chosen speed back
  if (!syncEl.checked) for (const q of panes) { q.syncRole = null; if (q.video) { q.video.playbackRate = syncRate; q.tick?.(); } }
  else syncLeader = panes[active].video ? panes[active] : syncLeader;
});
function syncTick() {
  requestAnimationFrame(syncTick);
  if (!syncEl.checked) return;
  const vids = panes.filter((q) => q.video && q.i < layout);
  for (const q of panes) q.syncRole = null;
  if (vids.length < 2) return;
  if (!vids.includes(syncLeader)) { syncLeader = null; takeLead(vids.find((q) => q.i === active) || vids[0]); }
  const L = syncLeader;
  const lv = L.video;
  if (lv.readyState < 1) return;
  const clock = !!L.timeline;
  const T = clock ? L.timeline.procAt(lv.currentTime * FPS) : lv.currentTime;
  L.syncRole = { lead: true, T, clock };
  for (const q of vids) if (q !== L) follow(q, L, T, clock && !!q.timeline);
  const now = performance.now();
  if (now - (syncTick.last || 0) > 200) { syncTick.last = now; for (const q of vids) q.tick?.(); }
}
requestAnimationFrame(syncTick);
function follow(q, L, T, clock) {
  const v = q.video, lv = L.video;
  if (v.readyState < 1) return;
  const target = clock ? (q.timeline.frameAt(T) + 0.5) / FPS : T;
  // how far behind the leader's clock this pane's best frame is (>0 = no frame here, holding the last one)
  q.syncRole = { lead: false, T, clock, gap: clock ? T - q.timeline.procAt(target * FPS) : 0 };
  const drift = target - v.currentTime;
  if (lv.paused || lv.seeking) {                       // paused / scrubbing: frame-exact, no playback
    if (!v.paused) v.pause();
    if (Math.abs(drift) > 0.6 / FPS && !v.seeking) v.currentTime = target;
    return;
  }
  if (Math.abs(drift) > 1.5) {                         // clock jumped (recording gap, new run): hard seek
    if (!v.seeking) v.currentTime = target;
    return;
  }
  // How fast this plane's video must run per second of leader video, measured over ±0.5 s of the
  // leader's footage: (follower frames covering that clock span) / (leader frames). 0 = this plane has no frames there.
  let ratio = 1;
  if (clock) {
    const lf = lv.currentTime * FPS, W = FPS / 2;
    const a = q.timeline.frameAt(L.timeline.procAt(lf - W)), b = q.timeline.frameAt(L.timeline.procAt(lf + W));
    ratio = Math.min(3, (b - a) / (2 * W));     // capped: a window straddling a clock jump would ask for a sprint
  }
  const want = lv.playbackRate * ratio + 1.0 * drift;  // feed-forward + gentle drift correction
  if (want < 0.07) { if (!v.paused) v.pause(); return; } // leader is where this plane recorded nothing: hold
  const r = Math.min(16, Math.max(0.0625, want));
  if (Math.abs(v.playbackRate - r) > Math.max(0.02, 0.05 * r)) v.playbackRate = r;
  if (v.paused) v.play().catch(() => {});
}

function viewVideo(p, node, alive, opts) {
  const v = h("video", { src: urlFor(node.key), controls: "", preload: "auto", playsinline: "", muted: "" });
  v.muted = true;
  p.video = v;
  const info = h("div", { class: "vinfo" });
  p.body.append(v, info);
  const rate = h("span");
  const tick = () => {
    const following = p.syncRole && !p.syncRole.lead;
    rate.textContent = following || v.playbackRate === 1 ? "" : `${+v.playbackRate.toFixed(3)}×`;
    const fr = Math.floor(v.currentTime * FPS);
    const buf = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
    info.textContent = "";
    info.append(h("span", {}, "frame ", h("b", {}, String(fr))), h("span", {}, `${fmtTime(v.currentTime)} / ${fmtTime(v.duration || 0)}`),
      h("span", {}, `buffered to ${fmtTime(buf)}`), rate);
    if (p.timeline) p.timeline.update(fr, info);
    const sr = p.syncRole;
    if (sr) info.prepend(sr.lead ? h("span", { class: "sync-lead", title: "sync leader: other videos follow this one's T+ clock" }, "◆ lead")
      : sr.gap > 2 ? h("span", { class: "sync-gap", title: "this plane recorded nothing at the leader's time; holding its last frame before it" }, `◇ no frame at T+${fmtTime(sr.T)} (−${fmtTime(sr.gap)})`)
      : h("span", { class: "sync-on", title: sr.clock ? "following the leader's T+ clock" : "no OCR clock: following raw video time" }, sr.clock ? "◇ synced" : "◇ synced (video time)"));
  };
  p.tick = tick;
  for (const ev of ["timeupdate", "seeked", "loadedmetadata", "progress", "ratechange"]) v.addEventListener(ev, tick);
  // clicking this pane (video, controls, timeline strip) makes it the sync leader
  p.body.addEventListener("pointerdown", () => takeLead(p), true);

  // OCR companion CSV (TAIR: <stem>_masked_ocr.csv aligns frame-for-frame with <stem>_masked.mp4)
  const ocr = node.path.replace(/_masked\.mp4$/, "_masked_ocr.csv");
  const ocrNode = ocr !== node.path ? BYPATH.get(ocr) : null;
  if (ocrNode) attachTimeline(p, ocrNode, alive).then(tick, console.error);
  const pair = biplanePartner(node);
  if (pair) p.button(`+${pair.path.match(/FLUORO\/(\w)/)[1]}`, "Open the other biplane view in the next pane (b)", () => openInPane(pair, nextPaneIndex()));
  if (opts.t) v.addEventListener("loadedmetadata", () => (v.currentTime = opts.t), { once: true });
  p.share = () => ({ t: v.currentTime.toFixed(2) });
  p.cleanup = () => { v.pause(); v.removeAttribute("src"); v.load(); };
  if (!booting) v.play().catch(() => {});
}

function biplanePartner(node) {
  // TAIR: <pid>/FLUORO/{A,B}/<run>_tNN_masked*.ext — note B's files are often also named "A1_…"
  const m = node.path.match(/^(.*\/FLUORO\/)([AB])\/[^/_]*(_t\d+_.*)$/);
  if (!m) return null;
  const dir = BYPATH.get(`${m[1]}${m[2] === "A" ? "B" : "A"}`);
  if (!dir) return null;
  const files = dir.list.filter((f) => !f.dir);
  return files.find((f) => f.name === node.name) || files.find((f) => f.name.endsWith(m[3])) || null;
}

async function attachTimeline(p, ocrNode, alive) {
  const r = await fetch(urlFor(ocrNode.key)); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text(); if (!alive()) return;
  const lines = text.split("\n"); const hdr = lines[0].split(",");
  const col = (n) => hdr.indexOf(n);
  const cT = col("frame_type"), cRT = col("relative_time"), cB1 = col("BottomLeft_1"), cB3 = col("BottomLeft_3");
  const N = lines.length - 1;
  const type = new Array(N), rt = new Array(N), ang = new Array(N), fld = new Array(N);
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split(",");
    type[n] = c[cT]; rt[n] = c[cRT]; ang[n] = c[cB3]; fld[n] = c[cB1]; n++;
  }
  // continuous procedure clock per frame: frames sharing one OCR'd second are spread evenly over it;
  // frames with no readable clock hold the previous value. Monotone, so it can be inverted by bisection.
  const procT = new Float64Array(n);
  const secOf = (t) => { const m = /^(\d+):(\d\d):(\d\d)$/.exec(t || ""); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
  { let prev = null, first = null;
    for (let i = 0; i < n; ) {
      const sec = secOf(rt[i]);
      if (sec == null || (prev != null && sec < prev)) { procT[i] = prev ?? NaN; i++; continue; }
      let j = i; while (j < n && (secOf(rt[j]) === sec || (secOf(rt[j]) == null && j + 1 < n && secOf(rt[j + 1]) === sec))) j++;
      for (let k = i; k < j; k++) procT[k] = sec + (k - i) / (j - i);
      prev = sec; first ??= sec; i = j;
    }
    for (let i = 0; i < n && Number.isNaN(procT[i]); i++) procT[i] = first ?? 0;
  }
  const procAt = (f) => procT[Math.min(n - 1, Math.max(0, Math.floor(f)))];
  const frameAt = (t) => { let lo = 0, hi = n - 1; if (t <= procT[0]) return 0; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (procT[m] <= t) lo = m; else hi = m - 1; } return lo; };
  const isDSA = (t) => t && /^WC\d+/.test(t);
  // segments of contiguous DSA frames (ignoring 1-5 frame Unlabeled gaps)
  const runs = []; let s = -1, lastDSA = -1;
  for (let i = 0; i < n; i++) {
    if (isDSA(type[i])) { if (s < 0 || i - lastDSA > 6) { if (s >= 0) runs.push([s, lastDSA]); s = i; } lastDSA = i; }
  }
  if (s >= 0) runs.push([s, lastDSA]);
  const strip = h("canvas", { class: "strip", title: "OCR timeline: amber = subtracted DSA, grey = roadmap/live fluoro. Click to seek." });
  const v = p.video;
  p.body.insertBefore(strip, v.nextSibling);
  const draw = (fr) => {
    const W = (strip.width = strip.clientWidth * devicePixelRatio), H = (strip.height = 14 * devicePixelRatio);
    const g = strip.getContext("2d");
    g.fillStyle = "#262a33"; g.fillRect(0, 0, W, H);
    const step = n / W;
    for (let x = 0; x < W; x++) {
      const t = type[Math.min(n - 1, Math.floor(x * step))];
      g.fillStyle = isDSA(t) ? "#e0a63a" : t === "Roadmap" ? "#4b5363" : "#262a33";
      g.fillRect(x, 0, 1, H);
    }
    if (fr != null) { g.fillStyle = "#fff"; g.fillRect(Math.floor((fr / n) * W) - 1, 0, 2 * devicePixelRatio, H); }
  };
  let lastFr = 0;
  new ResizeObserver(() => draw(lastFr)).observe(strip);
  strip.addEventListener("click", (e) => { const r = strip.getBoundingClientRect(); v.currentTime = ((e.clientX - r.left) / r.width) * n / FPS; });
  p.timeline = {
    runs, procAt, frameAt,
    update(fr, info) {
      lastFr = fr; draw(fr);
      const i = Math.min(n - 1, Math.max(0, fr));
      const ri = runs.findIndex(([a, b]) => fr >= a && fr <= b);
      info.append(
        h("span", { class: isDSA(type[i]) ? "ft-dsa" : "" }, h("b", {}, type[i] || "?")),
        h("span", { title: "OCR'd procedure clock (the T+ timer in the overlay); sync uses this" }, rt[i] ? `T+${rt[i]}` : `T+~${fmtTime(procT[i])}`),
        h("span", { title: "OCR'd C-arm angulation (noisy)" }, ang[i] || ""),
        h("span", { title: "OCR'd field size (noisy)" }, fld[i] || ""),
        h("span", {}, ri >= 0 ? `DSA run ${ri + 1}/${runs.length}` : `${runs.length} DSA runs`));
    },
  };
  draw(0);
}

function jumpRun(p, dir) {
  if (!p?.video || !p.timeline) return;
  const fr = Math.floor(p.video.currentTime * FPS);
  const rs = p.timeline.runs;
  const t = dir > 0 ? rs.find(([a]) => a > fr + 1) : [...rs].reverse().find(([a]) => a < fr - 15);
  if (t) p.video.currentTime = (t[0] + 0.5) / FPS;
}

// ---------------------------------------------------------------- volumes & meshes (niivue, LRU-cached in memory)
let NV = null;
const loadNV = () => (NV ??= import("./vendor/niivue.js"));
const VCACHE = new Map(); // key -> { buf, name }
const VCACHE_MAX = 3e9;
function cachePut(key, buf) {
  VCACHE.delete(key); VCACHE.set(key, buf);
  let tot = 0; for (const b of VCACHE.values()) tot += b.buf.byteLength;
  for (const k of VCACHE.keys()) { if (tot <= VCACHE_MAX) break; tot -= VCACHE.get(k).buf.byteLength; VCACHE.delete(k); }
}
const INFLIGHT = new Map();
function fetchBuf(node, onProg) {
  if (VCACHE.has(node.key)) { const b = VCACHE.get(node.key); cachePut(node.key, b); return Promise.resolve(b); }
  if (INFLIGHT.has(node.key)) { const f = INFLIGHT.get(node.key); f.listeners.add(onProg); return f.promise; }
  const listeners = new Set([onProg]);
  const promise = (async () => {
    const r = await fetch(urlFor(node.key)); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = +r.headers.get("content-length") || node.size;
    let got = 0; const t0 = performance.now();
    const counter = new TransformStream({ transform(chunk, ctl) {
      got += chunk.length;
      const mbps = got / 1e6 / ((performance.now() - t0) / 1e3);
      listeners.forEach((f) => f?.(got, total, mbps));
      ctl.enqueue(chunk);
    } });
    // .gz is inflated while it streams in, so it costs nothing extra after the download and
    // the in-memory cache holds raw bytes (re-opening skips decompression entirely).
    let stream = r.body.pipeThrough(counter);
    const gz = /\.gz$/i.test(node.name) && typeof DecompressionStream !== "undefined";
    if (gz) stream = stream.pipeThrough(new DecompressionStream("gzip"));
    const parts = []; let n = 0;
    const rd = stream.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; }
    const out = new Uint8Array(n); let o = 0;
    for (const c of parts) { out.set(c, o); o += c.length; }
    const res = { buf: out.buffer, name: gz ? node.name.replace(/\.gz$/i, "") : node.name };
    cachePut(node.key, res);
    return res;
  })().finally(() => INFLIGHT.delete(node.key));
  INFLIGHT.set(node.key, { promise, listeners });
  return promise;
}

async function viewVolume(p, node, alive, opts) {
  const bar = h("i"); const msg = h("div", {}, `downloading ${fmtSize(node.size)}…`);
  const ld = h("div", { class: "loading" }, msg, h("div", { class: "bar" }, bar));
  p.body.append(ld);
  const [vb0, mod] = await Promise.all([fetchBuf(node, (got, tot, mbps) => {
    if (!alive()) return;
    bar.style.width = `${(100 * got) / tot}%`;
    msg.textContent = `downloading ${fmtSize(got)} / ${fmtSize(tot)}  ·  ${mbps.toFixed(1)} MB/s`;
  }), loadNV()]);
  if (!alive()) return;
  msg.textContent = "decoding…";
  const canvas = h("canvas", { class: "nv" });
  p.body.append(canvas);
  const { Niivue, SLICE_TYPE } = mod;
  const nv = new Niivue({ backColor: [0, 0, 0, 1], show3Dcrosshair: true, isResizeCanvas: true, dragAndDropEnabled: false, multiplanarForceRender: false, loadingText: "" });
  await nv.attachToCanvas(canvas);
  // niivue picks its loader from the file extension
  await nv.loadFromArrayBuffer(vb0.buf.slice(0), vb0.name);
  if (!alive()) { nv.gl?.getExtension("WEBGL_lose_context")?.loseContext(); return; }
  ld.remove();
  const isMesh = node.kind === "mesh";
  nv.setSliceType(isMesh ? SLICE_TYPE.RENDER : SLICE_TYPE.MULTIPLANAR);
  const vol = nv.volumes[0];
  if (vol) {
    const d = vol.hdr.dims, px = vol.hdr.pixDims;
    p.pathEl.title = `${node.path}\n${d.slice(1, 1 + d[0]).join("×")} @ ${px.slice(1, 1 + d[0]).map((x) => x.toFixed(2)).join("×")} mm · ${fmtSize(node.size)}`;
  }
  // controls
  const views = [["A", SLICE_TYPE.AXIAL], ["C", SLICE_TYPE.CORONAL], ["S", SLICE_TYPE.SAGITTAL], ["MPR", SLICE_TYPE.MULTIPLANAR], ["3D", SLICE_TYPE.RENDER]];
  const vb = [];
  const setView = (k) => { nv.setSliceType(views[k][1]); vb.forEach((x, j) => x.classList.toggle("on", j === k)); };
  views.forEach(([lab], k) => vb.push(p.button(lab, `view: ${lab}`, () => setView(k))));
  vb[isMesh ? 4 : 3].classList.add("on");
  // shared-link state: view, window, crosshair (volume fractions), 3D azimuth/elevation
  const nums = (s) => (s || "").split(",").map(Number).filter((x) => !Number.isNaN(x));
  const viewIdx = views.findIndex(([lab]) => lab.toLowerCase() === opts.view);
  if (viewIdx >= 0) setView(viewIdx);
  if (nums(opts.xyz).length === 3) nv.scene.crosshairPos = nums(opts.xyz);
  if (nums(opts.rot).length === 2) nv.setRenderAzimuthElevation(...nums(opts.rot));
  if (vol && nums(opts.win).length === 2) { [vol.cal_min, vol.cal_max] = nums(opts.win); }
  nv.updateGLVolume();
  p.share = () => ({
    view: views.find(([, st]) => st === nv.opts.sliceType)?.[0].toLowerCase(),
    win: vol ? `${+vol.cal_min.toFixed(1)},${+vol.cal_max.toFixed(1)}` : undefined,
    xyz: [...nv.scene.crosshairPos].map((x) => +x.toFixed(4)).join(","),
    rot: nv.opts.sliceType === SLICE_TYPE.RENDER ? `${Math.round(nv.scene.renderAzimuth)},${Math.round(nv.scene.renderElevation)}` : undefined,
  });
  if (vol) {
    const win = (lo, hi) => { vol.cal_min = lo; vol.cal_max = hi; nv.updateGLVolume(); };
    const auto = [vol.cal_min, vol.cal_max];
    p.button("auto", "auto window", () => win(...auto));
    p.button("angio", "window 0–600 HU (contrast vessels)", () => win(0, 600));
    p.button("bone", "window -400–1600 HU", () => win(-400, 1600));
  }
  p.button("+overlay", "Pick another volume/mesh in the tree, then press this to add it on top", () => {
    const o = visible[cur];
    if (!o || o.dir || !(o.kind === "vol" || o.kind === "mesh") || o === node) return setStatus("select a volume/mesh in the tree first");
    fetchBuf(o, (g, t) => setStatus(`overlay ${fmtSize(g)}/${fmtSize(t)}`)).then(async (b) => {
      if (!alive()) return;
      await nv.loadFromArrayBuffer(b.buf.slice(0), b.name);
      const last = nv.volumes.at(-1);
      if (o.kind === "vol" && last !== vol) { last.colormap = "red"; last.opacity = 0.5; nv.updateGLVolume(); }
      setStatus(`overlaid ${o.path}`);
    });
  });
  p.cleanup = () => { try { nv.gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch {} };
}

// ---------------------------------------------------------------- keyboard
document.addEventListener("keydown", (e) => {
  if (e.target === filterEl || e.metaKey || e.ctrlKey || e.altKey) return;
  const inTree = document.activeElement === treeEl;
  const p = panes[active];
  const n = visible[cur];
  const k = e.key;
  const go = (f) => { e.preventDefault(); f(); };
  if (k === "/") return go(() => { filterEl.focus(); filterEl.select(); });
  if (k === "?") return go(() => ($("#help").hidden = !$("#help").hidden));
  if (k === "Escape") return go(() => ($("#help").hidden = true));
  if (e.shiftKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit4")) return go(() => setLayout(+e.code.slice(-1)));
  if (/^[1-4]$/.test(k)) return go(() => { const i = +k - 1; if (i >= layout) setLayout(i < 2 ? 2 : 4); setActive(i); });
  if (k === "[" || k === "]") return go(() => setActive((active + (k === "]" ? 1 : layout - 1)) % layout));
  if (k === "s") return go(() => { syncEl.checked = !syncEl.checked; syncEl.dispatchEvent(new Event("change")); });
  if (k === "x") return go(() => p.clear());
  if (k === "c") return go(() => shareBtn.click());
  if (k === "b" && p.node) { const o = biplanePartner(p.node); if (o) return go(() => openInPane(o, nextPaneIndex())); }
  if (p.video && [" ", ",", ".", "-", "=", "+", "n", "N"].includes(k)) {
    takeLead(p);
    const v = p.video;
    const speed = (f) => { const r = Math.min(16, Math.max(0.125, v.playbackRate * f)); v.playbackRate = r; syncRate = r; };
    if (k === " ") return go(() => (v.paused ? v.play() : v.pause()));
    if (k === ",") return go(() => { v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / FPS); });
    if (k === ".") return go(() => { v.pause(); v.currentTime += 1 / FPS; });
    if (k === "-") return go(() => speed(0.5));
    if (k === "=" || k === "+") return go(() => speed(2));
    if (k === "n") return go(() => jumpRun(p, 1));
    if (k === "N") return go(() => jumpRun(p, -1));
  }
  if (!inTree && !["ArrowUp", "ArrowDown", "j", "k"].includes(k)) return;
  if (k === "ArrowDown" || k === "j") return go(() => moveCur(1));
  if (k === "ArrowUp" || k === "k") return go(() => moveCur(-1));
  if (k === "PageDown") return go(() => moveCur(Math.floor(treeEl.clientHeight / ROW_H)));
  if (k === "PageUp") return go(() => moveCur(-Math.floor(treeEl.clientHeight / ROW_H)));
  if (k === "Home") return go(() => moveCur(-1e9));
  if (k === "End") return go(() => moveCur(1e9));
  if (!n) return;
  if (k === "ArrowRight" || k === "l") return go(() => { if (n.dir && !expanded.has(n.path) && !filterHits) toggleDir(n, true); else moveCur(1); });
  if (k === "ArrowLeft" || k === "h") return go(() => {
    if (n.dir && expanded.has(n.path) && !filterHits) toggleDir(n, false);
    else if (n.parent && n.parent !== ROOT) { cur = visible.indexOf(n.parent); scrollToCur(); renderTree(); }
  });
  if (k === "Enter") return go(() => activate(n, e.shiftKey));
});

// ---------------------------------------------------------------- misc UI
function setStatus(s) { $("#status").textContent = s; }
$("#help-btn").onclick = () => ($("#help").hidden = false);
$("#refresh").onclick = () => loadIndex(true);
{ // sidebar resize
  const side = $("#side"); let x0, w0;
  const w = lsGet("bv:sidew"); if (w) side.style.width = `${w}px`;
  $("#resizer").addEventListener("mousedown", (e) => {
    x0 = e.clientX; w0 = side.offsetWidth; e.preventDefault();
    const mv = (e) => { side.style.width = `${Math.max(200, w0 + e.clientX - x0)}px`; renderTree(); };
    const up = () => { removeEventListener("mousemove", mv); removeEventListener("mouseup", up); lsSet("bv:sidew", side.offsetWidth); window.dispatchEvent(new Event("resize")); };
    addEventListener("mousemove", mv); addEventListener("mouseup", up);
  });
}

function saveState() {
  if (!stateReady) return;
  lsSet(LS_STATE, { expanded: [...expanded], layout, active, panes: panes.map((p) => p.node?.path || null), sync: syncEl.checked });
}
syncEl.addEventListener("change", saveState);

// ---------------------------------------------------------------- share links
// The whole view lives in the URL hash (never sent to a server), e.g.
//   #layout=4&sync=1&active=1&p1=00098/FLUORO/A/A1_t00_masked.mp4&t1=707.4&p3=…&view3=mpr&win3=0,600
const enc = (v) => encodeURIComponent(v).replace(/%2F/g, "/").replace(/%2C/g, ",");
function shareURL() {
  const kv = [["layout", layout], ["active", active + 1]];
  if (syncEl.checked) kv.push(["sync", 1]);
  panes.forEach((q, i) => {
    if (!q.node) return;
    kv.push([`p${i + 1}`, q.node.path]);
    for (const [k, v] of Object.entries(q.share?.() || {})) if (v != null) kv.push([`${k}${i + 1}`, v]);
  });
  return `${location.origin}${location.pathname}${location.search}#${kv.map(([k, v]) => `${k}=${enc(v)}`).join("&")}`;
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (![1, 2, 3, 4].some((i) => q.has(`p${i}`))) return null;
  const panes = [1, 2, 3, 4].map((i) => {
    const path = q.get(`p${i}`); if (!path) return null;
    const opts = {};
    for (const k of ["t", "view", "win", "xyz", "rot"]) if (q.has(`${k}${i}`)) opts[k] = q.get(`${k}${i}`);
    if (opts.t) opts.t = +opts.t;
    return { path, opts };
  });
  return { layout: +q.get("layout") || 4, active: (+q.get("active") || 1) - 1, sync: q.get("sync") === "1", panes };
}
addEventListener("hashchange", () => readHash() && location.reload()); // link pasted into an open tab
const shareBtn = $("#share");
shareBtn.onclick = async () => {
  const url = shareURL();
  try { await navigator.clipboard.writeText(url); shareBtn.textContent = "copied ✓"; }
  catch { prompt("Copy this link:", url); }
  setTimeout(() => (shareBtn.textContent = "share"), 1500);
};

// ---------------------------------------------------------------- boot
async function loadIndex(force = false) {
  const cached = lsGet(LS_INDEX);
  if (cached && !ROOT) {
    buildTree(cached.entries); refreshTree();
    $("#ds-count").textContent = `${FILES.length} files · ${fmtSize(ROOT.size)}`;
    setStatus(`index from ${new Date(cached.t).toLocaleString()} · refreshing…`);
  } else setStatus("listing bucket…");
  try {
    const t0 = performance.now();
    const entries = await listBucket((k) => setStatus(`listing bucket… ${k} keys`));
    const changed = !cached || JSON.stringify(cached.entries) !== JSON.stringify(entries);
    lsSet(LS_INDEX, { t: Date.now(), entries });
    if (changed || force || !ROOT) {
      const keep = visible[cur]?.path;
      buildTree(entries);
      applyFilter(); computeVisible();
      const j = keep ? visible.findIndex((n) => n.path === keep) : -1;
      cur = Math.max(0, j); renderTree();
    }
    $("#ds-count").textContent = `${FILES.length} files · ${fmtSize(ROOT.size)}`;
    setStatus(`${FILES.length} files listed in ${((performance.now() - t0) / 1000).toFixed(1)}s${changed && cached ? " (index changed)" : ""}`);
  } catch (err) {
    setStatus(cached ? `offline? using cached index (${err.message})` : `listing failed: ${err.message}`);
  }
}

(async function boot() {
  const link = readHash();
  const st = link || lsGet(LS_STATE) || {};
  setLayout(st.layout || 4);
  setActive(st.active ?? 0);
  syncEl.checked = !!st.sync;
  await loadIndex();
  stateReady = true;
  (st.panes || []).forEach((x, i) => {
    const { path, opts } = typeof x === "string" ? { path: x, opts: {} } : x || {};
    const n = path && BYPATH.get(path);
    if (n) panes[i].open(n, opts);
  });
  if (link) history.replaceState(null, "", location.pathname + location.search); // later reloads use saved state
  if (link && syncEl.checked) takeLead(panes[active]);
  booting = false;
  treeEl.focus();
})();
