(() => {
"use strict";

/* ============================================================
 * 1. ESTADO DA APLICAÇÃO
 * ============================================================ */

const KEYS = {
  data: "notas:v2:data",        // notas em texto (quando NÃO há PIN)
  vault: "notas:v2:vault",      // notas criptografadas (quando há PIN)
  prefs: "notas:v2:prefs",      // tema e ordenação (nunca criptografado)
  legacyNotes: "notas:v1",      // versão antiga: só é lida para migrar
  legacyTheme: "notas:theme"
};
const SCHEMA = 2;
const DEFAULT_CATEGORIES = [
  { id: "pessoal", name: "Pessoal" },
  { id: "trabalho", name: "Trabalho" },
  { id: "estudos", name: "Estudos" },
  { id: "projetos", name: "Projetos" },
  { id: "ideias", name: "Ideias" }
];
const COLORS = ["none", "butter", "mint", "sky", "rose", "lilac"];
/** Paleta de cores do realce (mesmos nomes e tons das cores de nota, para o app usar uma linguagem visual única). */
const HIGHLIGHT_COLORS = [
  { id: "butter", name: "Amarelo" },
  { id: "mint", name: "Verde" },
  { id: "sky", name: "Azul" },
  { id: "rose", name: "Rosa" },
  { id: "lilac", name: "Lilás" }
];
const HIGHLIGHT_IDS = new Set(HIGHLIGHT_COLORS.map((c) => c.id));
const SAVE_DELAY_MS = 700;

/*
 * ANEXOS: IMAGENS E PDFs
 * O texto das notas fica no localStorage (cerca de 5 milhões de caracteres por
 * site). Os arquivos ficam no IndexedDB, que aceita centenas de MB, e a nota
 * guarda só uma referência: <img data-file="ID"> dentro do texto e a lista
 * note.attachments para os PDFs. Com PIN ativo, os arquivos também são
 * criptografados (veja Files e Vault).
 */
const QUOTA_CHARS = 5_000_000;
const MAX_IMAGE_SIDE = 1600;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const GC_MIN_AGE_MS = 6 * 3600e3;      // arquivos sem uso só são apagados depois disso
const BACKUP_SCHEMA = 3;               // 3 = backup com arquivos
const ATTACH_TYPES = ["application/pdf"];
const BACKUP_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
const FILE_ID = /^[a-z0-9]{6,40}$/;
const FILE_ID_ATTR = /data-file="([a-z0-9]{6,40})"/g;

const PIN_RE = /^\d{4,8}$/;
const PBKDF2_ITERATIONS = 150_000;
const SAFE_HREF = /^(https?:|mailto:)/i;
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;

const els = {};
const state = {
  data: null, // { schema, categories, notes }
  prefs: { theme: null, sort: "recent" },
  security: { enabled: false, key: null, salt: null, fileKey: null },
  ui: { scope: "all", category: "all", tags: [], query: "", activeId: null, view: "dashboard", saveState: "saved" }
};

let dirty = false;
let saveChain = Promise.resolve(true);
let toastTimer = null;
let lastSaveWarning = 0;
let pinMode = null;
let confirmRequired = null;
let savedRange = null;
let failedUnlocks = 0;
let lockoutUntil = 0;
const textCache = new Map();
const searchCache = new Map();
const urlCache = new Map(); // id do arquivo -> Promise da URL (blob:) usada em <img> e no visualizador
let persistAsked = false;

/* ============================================================
 * 2. UTILIDADES
 * ============================================================ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const isMobile = () => matchMedia("(max-width: 820px)").matches;
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateStamp = () => new Date().toISOString().slice(0, 10);

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Cria elementos DOM sem usar innerHTML (todo texto entra como textContent). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") { for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = v; }
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const ICONS = {
  pin: "M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z M12 15v5",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z",
  x: "M6 6l12 12M18 6 6 18",
  clip: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8"
};
function icon(name, className = "") {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function formatRelative(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86400000);
  if (diffDays === 0) return `há ${Math.floor(min / 60)} h`;
  if (diffDays === 1) return "ontem";
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("pt-BR", opts).replace(".", "");
}

function downloadFile(name, data, mime) { // data: texto ou Blob
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(message, { action = null, tone = "info", duration = 5000 } = {}) {
  clearTimeout(toastTimer);
  els.toastMsg.textContent = message;
  els.toast.dataset.tone = tone;
  els.toastAction.hidden = !action;
  els.toastAction.textContent = action ? action.label : "";
  els.toastAction.onclick = action ? () => { hideToast(); action.onClick(); } : null;
  els.toast.classList.add("show");
  toastTimer = setTimeout(hideToast, duration);
}
function hideToast() { clearTimeout(toastTimer); els.toast.classList.remove("show"); }

/** Diálogo de confirmação. Com requireText, o usuário precisa digitar a palavra exata. */
function confirmAction({ title, message, confirmText = "Confirmar", danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const dialog = els.confirmDialog;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = confirmText;
    els.confirmOk.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    confirmRequired = requireText;
    els.confirmField.hidden = !requireText;
    els.confirmInput.value = "";
    els.confirmOk.disabled = !!requireText;
    if (requireText) els.confirmFieldLabel.textContent = `Digite ${requireText} para confirmar`;
    const onClose = () => { dialog.removeEventListener("close", onClose); resolve(dialog.returnValue === "ok"); };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
  });
}

/* ============================================================
 * 3. PERSISTÊNCIA (todo acesso ao localStorage passa por aqui)
 * ============================================================ */

const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignora */ } }
};

function storageUsedChars() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      total += key.length + (localStorage.getItem(key) || "").length;
    }
  } catch (e) { /* ignora */ }
  return total;
}

/*
 * PROTEÇÃO POR PIN — É UMA PROTEÇÃO LOCAL, NÃO SEGURANÇA DE NÍVEL BANCÁRIO.
 * Com o PIN ativo, as notas são criptografadas (AES-GCM 256) com uma chave
 * derivada do PIN (PBKDF2-SHA256, 150 mil iterações, salt aleatório). O PIN
 * nunca é salvo: a senha certa é a que consegue descriptografar os dados.
 * Um PIN de 4 a 8 números pode ser descoberto por força bruta por quem copiar
 * os dados do navegador; ele protege contra curiosos, não contra ataques sérios.
 */
const Vault = {
  supported: () => !!(window.crypto && window.crypto.subtle),
  b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  unb64(str) {
    const bin = atob(str), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  async deriveKey(pin, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  },
  async encrypt(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
    return { iv: Vault.b64(iv), ct: Vault.b64(ct) };
  },
  async decrypt(key, { iv, ct }) {
    const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Vault.unb64(iv) }, key, Vault.unb64(ct));
    return new TextDecoder().decode(buf);
  },
  /* Arquivos (binário) */
  async encryptBytes(key, buffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer);
    return { iv, ct };
  },
  decryptBytes(key, iv, ct) { return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct); },
  /*
   * Os arquivos usam uma chave própria, aleatória (fileKey), guardada dentro do
   * cofre e protegida pelo PIN. Assim, trocar o PIN não obriga a recriptografar
   * todos os anexos: só a chave é reprotegida.
   */
  newFileKey() { return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); },
  async exportFileKey(key) { return Vault.b64(new Uint8Array(await crypto.subtle.exportKey("raw", key))); },
  importFileKey(b64) { return crypto.subtle.importKey("raw", Vault.unb64(b64), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]); }
};

/** Chave dos arquivos no momento: null = sem PIN (arquivos em claro). */
function currentFileKey() {
  if (!state.security.enabled) return null;
  if (!state.security.fileKey) throw new Error("As notas estão bloqueadas.");
  return state.security.fileKey;
}

/*
 * ARMAZENAMENTO DE ARQUIVOS (IndexedDB)
 * Dois depósitos: "blobs" (os bytes, criptografados quando há PIN) e "meta"
 * (tipo, tamanho e data; sem o nome do arquivo, que fica dentro da nota).
 * Cada registro diz se está criptografado (enc), então um estado misto, por
 * exemplo depois de uma falha no meio da ativação do PIN, continua legível.
 */
const Files = {
  _db: null,
  open() {
    if (!this._db) {
      this._db = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error("IndexedDB indisponível")); return; }
        let req;
        try { req = indexedDB.open("notas-files", 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => {
          req.result.createObjectStore("blobs", { keyPath: "id" });
          req.result.createObjectStore("meta", { keyPath: "id" });
        };
        req.onsuccess = () => {
          req.result.onversionchange = () => { req.result.close(); Files._db = null; };
          resolve(req.result);
        };
        req.onerror = () => reject(req.error || new Error("Falha ao abrir o armazenamento de anexos."));
        req.onblocked = () => reject(new Error("O armazenamento de anexos está bloqueado por outra aba."));
      });
      this._db.catch(() => { this._db = null; });
    }
    return this._db;
  },
  async _tx(stores, mode) { return (await this.open()).transaction(stores, mode); },
  _done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Operação cancelada."));
    });
  },
  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async _seal(plain, key = currentFileKey()) {
    if (!key) return { enc: false, iv: null, data: plain };
    const { iv, ct } = await Vault.encryptBytes(key, plain);
    return { enc: true, iv, data: ct };
  },
  async _unseal(rec, key = currentFileKey()) {
    if (!rec.enc) return rec.data;
    if (!key) throw new Error("Arquivo protegido: desbloqueie as notas.");
    return Vault.decryptBytes(key, rec.iv, rec.data);
  },

  async put(id, source, mime) {
    const plain = await source.arrayBuffer();
    const rec = await this._seal(plain);
    const tx = await this._tx(["blobs", "meta"], "readwrite");
    const done = this._done(tx);
    tx.objectStore("blobs").put({ id, ...rec });
    tx.objectStore("meta").put({ id, t: Date.now(), mime, size: plain.byteLength });
    await done;
  },
  async get(id) {
    const tx = await this._tx(["blobs", "meta"], "readonly");
    const [rec, meta] = await Promise.all([this._req(tx.objectStore("blobs").get(id)), this._req(tx.objectStore("meta").get(id))]);
    if (!rec || !meta) return null;
    return new Blob([await this._unseal(rec)], { type: meta.mime });
  },
  async remove(ids) {
    if (!ids.length) return;
    const tx = await this._tx(["blobs", "meta"], "readwrite");
    const done = this._done(tx);
    ids.forEach((id) => { tx.objectStore("blobs").delete(id); tx.objectStore("meta").delete(id); });
    await done;
  },
  async clear() {
    try { await this.open(); } catch (e) { return; }
    const tx = await this._tx(["blobs", "meta"], "readwrite");
    const done = this._done(tx);
    tx.objectStore("blobs").clear();
    tx.objectStore("meta").clear();
    await done;
  },
  async list() { // [{ id, t, mime, size }]
    const tx = await this._tx(["meta"], "readonly");
    return this._req(tx.objectStore("meta").getAll());
  },
  /** Leva todos os arquivos para o estado desejado: toKey = criptografados, toKey null = em claro. Em lotes. */
  async reencrypt(fromKey, toKey) {
    try { await this.open(); } catch (e) { return; } // sem IndexedDB não há arquivos
    const ids = (await this.list()).map((m) => m.id);
    for (let i = 0; i < ids.length; i += 6) {
      const read = await this._tx(["blobs"], "readonly");
      const recs = (await Promise.all(ids.slice(i, i + 6).map((id) => this._req(read.objectStore("blobs").get(id))))).filter(Boolean);
      const next = [];
      for (const rec of recs) {
        if (toKey && !rec.enc) next.push({ id: rec.id, ...(await this._seal(rec.data, toKey)) });
        else if (!toKey && rec.enc) next.push({ id: rec.id, enc: false, iv: null, data: await this._unseal(rec, fromKey) });
      }
      if (!next.length) continue;
      const write = await this._tx(["blobs"], "readwrite");
      const done = this._done(write);
      next.forEach((r) => write.objectStore("blobs").put(r));
      await done;
    }
  }
};

/** URL (blob:) de um arquivo guardado, com cache. Resolve null se o arquivo não existir. */
function fileUrl(id) {
  if (!urlCache.has(id)) {
    const p = Files.get(id).then((blob) => (blob ? URL.createObjectURL(blob) : null));
    urlCache.set(id, p);
    p.then((u) => { if (!u) urlCache.delete(id); }, () => urlCache.delete(id));
  }
  return urlCache.get(id);
}
function revokeUrl(id) {
  const p = urlCache.get(id);
  if (!p) return;
  urlCache.delete(id);
  p.then((u) => { if (u) URL.revokeObjectURL(u); }, () => {});
}
function revokeAllUrls() { [...urlCache.keys()].forEach(revokeUrl); }

function loadPrefs() {
  try {
    const p = JSON.parse(store.get(KEYS.prefs) || "null");
    if (p && typeof p === "object") {
      if (p.theme === "light" || p.theme === "dark") state.prefs.theme = p.theme;
      if (SORTERS[p.sort]) state.prefs.sort = p.sort;
    }
  } catch (e) { /* prefs corrompidas: usa o padrão */ }
  if (!state.prefs.theme) {
    const legacy = store.get(KEYS.legacyTheme);
    if (legacy === "light" || legacy === "dark") state.prefs.theme = legacy;
  }
}
const savePrefs = () => store.set(KEYS.prefs, JSON.stringify(state.prefs));

const emptyData = () => ({ schema: SCHEMA, categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), notes: [] });
const hasVault = () => store.get(KEYS.vault) !== null;

function loadPlainData() {
  const raw = store.get(KEYS.data);
  if (raw !== null) {
    try { return normalizeData(JSON.parse(raw)); }
    catch (e) { store.set(KEYS.data + ":corrupt", raw); /* guarda cópia para recuperação manual */ }
  }
  const legacy = store.get(KEYS.legacyNotes);
  if (legacy !== null) {
    try {
      const list = JSON.parse(legacy);
      if (Array.isArray(list)) return normalizeData({ notes: list }); // migra a versão 1
    } catch (e) { /* ignora */ }
  }
  return seedData();
}

async function writeData() {
  try {
    const json = JSON.stringify(state.data);
    if (state.security.key) {
      const { iv, ct } = await Vault.encrypt(state.security.key, json);
      const vault = { v: 2, salt: Vault.b64(state.security.salt), iv, ct };
      if (state.security.fileKey) vault.fk = await Vault.encrypt(state.security.key, await Vault.exportFileKey(state.security.fileKey));
      return store.set(KEYS.vault, JSON.stringify(vault));
    }
    return store.set(KEYS.data, json);
  } catch (e) { console.error(e); return false; }
}
/** Grava em fila para que duas gravações nunca se sobreponham. Resolve true/false. */
function saveData() { saveChain = saveChain.then(writeData); return saveChain; }

function seedData() {
  const now = Date.now();
  return normalizeData({
    notes: [
      {
        title: "Bem-vindo às suas notas", category: "pessoal", tags: ["dica"], color: "lilac", pinned: true, favorite: true, created: now, updated: now,
        content: '<p>Este é o seu bloco de notas. Tudo o que você escreve é salvo automaticamente neste navegador.</p><h3>O que você pode fazer</h3><ul class="checklist"><li data-checked="true">Criar uma nota em <b>Nova nota</b> ou com Alt + N</li><li data-checked="false">Formatar o texto com a barra acima do editor</li><li data-checked="false">Organizar por <mark>categoria</mark> e #tags</li><li data-checked="false">Favoritar, fixar no topo e escolher uma cor</li><li data-checked="false">Fazer backup em Configurações → Dados</li></ul><p>Apague esta nota quando quiser começar do zero.</p>'
      },
      {
        title: "Ideias soltas", category: "ideias", tags: ["ideias"], color: "butter", created: now - 3600e3, updated: now - 3600e3,
        content: "<p>Ler um livro por mês.</p><p>Aprender a fazer pão de fermentação natural.</p><p>Organizar as fotos da viagem.</p>"
      }
    ]
  });
}

/* ---------- Normalização e validação de dados ---------- */

const slugify = (s) => norm(s).trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "categoria";

function normalizeTag(raw) {
  return norm(raw).replace(/^#+/, "").trim().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 30);
}
function normalizeTags(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((t) => {
    const tag = normalizeTag(String(t));
    if (tag && !out.includes(tag)) out.push(tag); // evita tags duplicadas
  });
  return out.slice(0, 20);
}

function cleanFileName(name, fallback = "documento.pdf") {
  const clean = String(name || "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || fallback;
}
function normalizeAttachments(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((a) => {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !FILE_ID.test(a.id) || !ATTACH_TYPES.includes(a.type)) return;
    if (out.some((x) => x.id === a.id)) return;
    out.push({
      id: a.id,
      name: cleanFileName(a.name),
      type: a.type,
      size: Number.isFinite(a.size) && a.size >= 0 ? a.size : 0,
      added: Number.isFinite(a.added) ? a.added : Date.now()
    });
  });
  return out.slice(0, MAX_ATTACHMENTS);
}

/** ids dos arquivos usados por uma nota (imagens no texto + PDFs anexados) */
function noteFileIds(note) {
  const ids = new Set();
  for (const m of String(note.content || "").matchAll(FILE_ID_ATTR)) ids.add(m[1]);
  (note.attachments || []).forEach((a) => ids.add(a.id));
  return ids;
}
function referencedFileIds(notes) {
  const ids = new Set();
  notes.forEach((n) => noteFileIds(n).forEach((id) => ids.add(id)));
  return ids;
}

function normalizeCategories(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((c) => {
    if (!c || typeof c.name !== "string") return;
    const name = c.name.trim().slice(0, 30);
    const id = typeof c.id === "string" && c.id ? slugify(c.id) : slugify(name);
    if (name && !out.some((x) => x.id === id)) out.push({ id, name });
  });
  return out.length ? out : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
}

function textToHtml(text) {
  return String(text || "").split("\n").map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>")).join("");
}

/** Converte qualquer objeto em uma nota válida (ou null se não for uma nota). */
function normalizeNote(raw, categories) {
  if (!raw || typeof raw !== "object") return null;
  if (!["title", "content", "body"].some((k) => typeof raw[k] === "string")) return null;
  const now = Date.now();
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const fallbackCat = (categories.find((c) => c.id === "pessoal") || categories[0]).id;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
    content: typeof raw.content === "string" ? sanitizeHtml(raw.content) : textToHtml(raw.body), // "body" = formato antigo
    category: categories.some((c) => c.id === raw.category) ? raw.category : fallbackCat,
    tags: normalizeTags(raw.tags),
    attachments: normalizeAttachments(raw.attachments),
    color: COLORS.includes(raw.color) ? raw.color : "none",
    favorite: raw.favorite === true,
    pinned: raw.pinned === true,
    created: num(raw.created, num(raw.updated, now)),
    updated: num(raw.updated, now),
    deletedAt: Number.isFinite(raw.deletedAt) ? raw.deletedAt : null
  };
}

function normalizeData(raw) {
  const categories = normalizeCategories(raw && raw.categories);
  const seen = new Set(), notes = [];
  (raw && Array.isArray(raw.notes) ? raw.notes : []).forEach((r) => {
    const note = normalizeNote(r, categories);
    if (!note) return;
    if (seen.has(note.id)) note.id = uid();
    seen.add(note.id);
    notes.push(note);
  });
  return { schema: SCHEMA, categories, notes };
}

/* ---------- Sanitização de HTML (evita scripts em notas importadas/coladas) ---------- */

const SAFE_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "MARK", "H2", "H3", "P", "DIV", "BR", "UL", "OL", "LI", "A", "PRE", "CODE", "BLOCKQUOTE", "SPAN"]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "LINK", "META", "SVG", "MATH", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"]);

function sanitizeHtml(dirty) {
  const doc = new DOMParser().parseFromString(String(dirty || ""), "text/html");
  const out = document.createElement("div");
  cleanChildren(doc.body, out);
  return out.innerHTML;
}
function cleanChildren(from, to) {
  from.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) { to.append(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (DROP_TAGS.has(tag)) return;
    if (tag === "IMG") {
      const fileId = node.getAttribute("data-file") || "";
      const src = node.getAttribute("src") || "";
      // Imagem guardada no IndexedDB: só o id vai para a nota (o src blob: é recriado ao abrir).
      if (FILE_ID.test(fileId)) to.append(h("img", { "data-file": fileId, alt: "imagem" }));
      else if (SAFE_IMG.test(src)) to.append(h("img", { src, alt: "imagem" })); // formato antigo (base64)
      return;
    }
    if (tag === "SPAN" && /background/i.test(node.getAttribute("style") || "")) {
      const mark = document.createElement("mark");
      cleanChildren(node, mark);
      to.append(mark);
      return;
    }
    if (!SAFE_TAGS.has(tag)) { cleanChildren(node, to); return; } // remove a tag, mantém o texto
    const copy = document.createElement(tag.toLowerCase());
    if (tag === "A") {
      const href = (node.getAttribute("href") || "").trim();
      if (!SAFE_HREF.test(href)) { cleanChildren(node, to); return; }
      copy.setAttribute("href", href);
    }
    if (tag === "MARK") {
      const c = node.getAttribute("data-color");
      if (HIGHLIGHT_IDS.has(c) && c !== "butter") copy.setAttribute("data-color", c);
    }
    if (tag === "UL" && node.classList.contains("checklist")) copy.className = "checklist";
    if (tag === "LI") {
      const checked = node.getAttribute("data-checked");
      if (checked === "true" || checked === "false") copy.setAttribute("data-checked", checked);
    }
    cleanChildren(node, copy);
    to.append(copy);
  });
}

function plainText(html) {
  const stripped = String(html || "")
    .replace(/<img[^>]*>/gi, " [imagem] ")
    .replace(/<\/(p|div|li|h2|h3|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const box = document.createElement("textarea"); // decodifica entidades (&amp; etc.)
  box.innerHTML = stripped;
  return box.value.replace(/\s+/g, " ").trim();
}

/* ---------- Segurança: PIN ---------- */

async function verifyPin(pin) {
  try {
    const vault = JSON.parse(store.get(KEYS.vault));
    const key = await Vault.deriveKey(pin, Vault.unb64(vault.salt));
    await Vault.decrypt(key, vault);
    return true;
  } catch (e) { return false; }
}

async function enablePin(pin) {
  captureIfDirty();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await Vault.deriveKey(pin, salt);
  const fileKey = await Vault.newFileKey();
  const previous = { ...state.security };
  state.security = { enabled: true, key, salt, fileKey };
  // 1º o cofre (com a chave dos arquivos), 2º os arquivos. Se algo falhar no meio, nada fica ilegível.
  if (!(await saveData())) { state.security = previous; throw new Error("Não foi possível salvar. Verifique o espaço do navegador."); }
  let allProtected = true;
  try { await Files.reencrypt(null, fileKey); }
  catch (e) { console.error(e); allProtected = false; }
  store.remove(KEYS.data); // remove a cópia sem criptografia
  return allProtected;
}

async function disablePin() {
  const previous = { ...state.security };
  // Primeiro os arquivos voltam ao estado aberto (a chave ainda existe); só depois o cofre é removido.
  await Files.reencrypt(previous.fileKey, null);
  state.security = { enabled: false, key: null, salt: null, fileKey: null };
  if (!(await saveData())) { state.security = previous; throw new Error("Não foi possível salvar. Verifique o espaço do navegador."); }
  store.remove(KEYS.vault);
}

async function unlockWith(pin) {
  const vault = JSON.parse(store.get(KEYS.vault));
  const salt = Vault.unb64(vault.salt);
  const key = await Vault.deriveKey(pin, salt);
  const text = await Vault.decrypt(key, vault); // lança erro se o PIN estiver errado
  let fileKey, isNewKey = false;
  if (vault.fk) fileKey = await Vault.importFileKey(await Vault.decrypt(key, vault.fk));
  else { fileKey = await Vault.newFileKey(); isNewKey = true; } // cofre criado antes dos anexos em arquivo
  state.data = normalizeData(JSON.parse(text));
  state.security = { enabled: true, key, salt, fileKey };
  if (isNewKey) saveData(); // grava a chave no cofre
}

async function lockNow() {
  if (!state.security.enabled || !state.data) return;
  captureIfDirty();
  await saveData();
  state.data = null;
  state.security.key = null;
  state.security.fileKey = null;
  revokeAllUrls();
  Object.assign(state.ui, { activeId: null, scope: "all", category: "all", tags: [], query: "" });
  textCache.clear(); searchCache.clear();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  [els.noteList, els.dashRecent, els.dashCategories, els.dashStats, els.trashMeta, els.attachList, els.trashAttachList].forEach((el) => el.replaceChildren());
  els.noteContent.innerHTML = ""; els.trashContent.innerHTML = ""; els.noteTitle.value = ""; els.searchInput.value = "";
  showLock();
}

function showLock() {
  els.app.inert = true;
  els.lockScreen.hidden = false;
  els.lockPin.value = "";
  els.lockError.textContent = "";
  if (!Vault.supported()) {
    els.lockError.textContent = "Este navegador não permite abrir dados protegidos aqui. Abra o app em https ou em localhost.";
    els.lockSubmit.disabled = true;
    return;
  }
  els.lockSubmit.disabled = false;
  els.lockPin.focus();
}

async function onUnlockSubmit(event) {
  event.preventDefault();
  const wait = lockoutUntil - Date.now();
  if (wait > 0) { els.lockError.textContent = `Muitas tentativas. Aguarde ${Math.ceil(wait / 1000)} s.`; return; }
  const pin = els.lockPin.value;
  if (!PIN_RE.test(pin)) { els.lockError.textContent = "Digite o PIN (4 a 8 números)."; return; }
  els.lockSubmit.disabled = true;
  try {
    await unlockWith(pin);
    failedUnlocks = 0;
    startApp();
  } catch (e) {
    failedUnlocks++;
    if (failedUnlocks >= 3) lockoutUntil = Date.now() + Math.min(30000, 2000 * 2 ** (failedUnlocks - 3));
    els.lockError.textContent = "PIN incorreto.";
    els.lockPin.value = "";
    els.lockPin.focus();
  } finally {
    els.lockSubmit.disabled = false;
  }
}

async function forgotPin() {
  const ok = await confirmAction({
    title: "Esqueceu o PIN?",
    message: "Não existe recuperação. Para voltar a usar o app, todas as notas guardadas neste navegador serão apagadas.",
    confirmText: "Apagar tudo", danger: true, requireText: "APAGAR"
  });
  if (!ok) return;
  wipeEverything();
  startApp();
  toast("Dados apagados. O app foi reiniciado.");
}

/** Remove tudo do armazenamento e deixa o app vazio (sem recriar as notas de exemplo). */
function wipeEverything() {
  [KEYS.vault, KEYS.legacyNotes, KEYS.data + ":corrupt"].forEach(store.remove);
  state.data = emptyData();
  state.security = { enabled: false, key: null, salt: null, fileKey: null };
  textCache.clear(); searchCache.clear();
  revokeAllUrls();
  Files.clear().catch((e) => console.error(e));
  store.set(KEYS.data, JSON.stringify(state.data));
}

/* ---------- Backup: exportar e importar ---------- */

async function exportJson() {
  captureIfDirty();
  const ids = [...referencedFileIds(state.data.notes)];
  const files = {};
  let missing = 0;
  if (ids.length) toast("Gerando o backup com os anexos…", { duration: 60000 });
  for (const id of ids) {
    let blob = null;
    try { blob = await Files.get(id); } catch (e) { /* tratado como ausente */ }
    if (!blob) { missing++; continue; }
    files[id] = { type: blob.type, data: Vault.b64(new Uint8Array(await blob.arrayBuffer())) };
  }
  const payload = { app: "notas", schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString(), categories: state.data.categories, notes: state.data.notes };
  if (ids.length) payload.files = files;
  downloadFile(`notas-backup-${dateStamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
  const extra = Object.keys(files).length ? `, ${Object.keys(files).length} ${Object.keys(files).length === 1 ? "anexo" : "anexos"}` : "";
  toast(`Backup exportado (${state.data.notes.length} notas, incluindo a lixeira${extra}).` + (missing ? ` ${missing} ${missing === 1 ? "arquivo não foi encontrado" : "arquivos não foram encontrados"} e ficou de fora.` : ""),
    missing ? { tone: "error", duration: 9000 } : {});
}

function exportMarkdown() {
  captureIfDirty();
  const notes = liveNotes().sort((a, b) => b.updated - a.updated);
  if (!notes.length) { toast("Não há notas para exportar."); return; }
  downloadFile(`notas-${dateStamp()}.md`, notes.map(noteToMarkdown).join("\n\n---\n\n") + "\n", "text/markdown");
  toast("Markdown exportado. Imagens e PDFs ficam apenas no backup JSON.");
}

function noteToMarkdown(note) {
  const meta = [`Categoria: ${categoryName(note.category)}`];
  if (note.tags.length) meta.push("Tags: " + note.tags.map((t) => "#" + t).join(" "));
  meta.push("Atualizada em: " + new Date(note.updated).toLocaleString("pt-BR"));
  const parts = [`# ${note.title.trim() || "Sem título"}`, "", `*${meta.join(" | ")}*`, "", htmlToMarkdown(note.content)];
  if (note.attachments.length) parts.push("", "**Anexos (disponíveis no backup JSON):** " + note.attachments.map((a) => a.name).join(", "));
  return parts.join("\n");
}

function htmlToMarkdown(html) {
  const body = new DOMParser().parseFromString(html || "", "text/html").body;
  return mdBlocks(body).replace(/\n{3,}/g, "\n\n").trim();
}
function mdInlineNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const inner = () => mdInline(node);
  switch (node.tagName) {
    case "B": case "STRONG": return `**${inner()}**`;
    case "I": case "EM": return `*${inner()}*`;
    case "U": return `<u>${inner()}</u>`;
    case "S": return `~~${inner()}~~`;
    case "MARK": return `==${inner()}==`;
    case "CODE": return "`" + node.textContent + "`";
    case "A": return `[${inner()}](${node.getAttribute("href") || ""})`;
    case "BR": return "  \n";
    case "IMG": return "*[imagem omitida: disponível no backup JSON]*";
    default: return inner();
  }
}
const mdInline = (parent) => [...parent.childNodes].map(mdInlineNode).join("");
function mdList(list, depth = 0) {
  const ordered = list.tagName === "OL", checklist = list.classList.contains("checklist");
  let n = 1;
  const lines = [];
  [...list.children].forEach((li) => {
    if (li.tagName !== "LI") return;
    const nested = [...li.children].filter((c) => c.tagName === "UL" || c.tagName === "OL");
    const text = [...li.childNodes].filter((c) => !nested.includes(c)).map(mdInlineNode).join("").trim();
    const mark = checklist ? `- [${li.getAttribute("data-checked") === "true" ? "x" : " "}] ` : ordered ? `${n++}. ` : "- ";
    lines.push("  ".repeat(depth) + mark + text);
    nested.forEach((c) => lines.push(mdList(c, depth + 1)));
  });
  return lines.join("\n");
}
function mdBlocks(parent) {
  const parts = [];
  let buffer = "";
  const flush = () => { if (buffer.trim()) parts.push(buffer.trim()); buffer = ""; };
  parent.childNodes.forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) { buffer += mdInlineNode(node); return; }
    switch (node.tagName) {
      case "H2": flush(); parts.push("## " + mdInline(node).trim()); break;
      case "H3": flush(); parts.push("### " + mdInline(node).trim()); break;
      case "UL": case "OL": flush(); parts.push(mdList(node)); break;
      case "PRE": flush(); parts.push("```\n" + node.textContent.replace(/\n$/, "") + "\n```"); break;
      case "BLOCKQUOTE": flush(); parts.push(mdBlocks(node).split("\n").map((l) => "> " + l).join("\n")); break;
      case "P": case "DIV": {
        flush();
        const hasBlock = node.querySelector("h2,h3,ul,ol,pre,blockquote,div,p");
        const text = hasBlock ? mdBlocks(node) : mdInline(node).trim();
        if (text) parts.push(text);
        break;
      }
      default: buffer += mdInlineNode(node);
    }
  });
  flush();
  return parts.join("\n\n");
}

function hasPdfHeader(bytes) {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
}

/** Converte um arquivo do backup (base64) em Blob, ou null se for inválido. */
function decodeBackupFile(entry) {
  try {
    if (!entry || typeof entry.data !== "string" || !BACKUP_TYPES.includes(entry.type)) return null;
    const bytes = Vault.unb64(entry.data);
    if (bytes.length > MAX_PDF_BYTES) return null;
    if (entry.type === "application/pdf" && !hasPdfHeader(bytes)) return null;
    return new Blob([bytes], { type: entry.type });
  } catch (e) { return null; }
}

/** Importa um backup JSON sem tocar nas notas existentes; conflitos de id geram novos ids. */
async function importBackup(file) {
  const created = []; // arquivos gravados por esta importação (desfeitos se algo falhar)
  let snapshot = null;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("O arquivo é grande demais (limite de 100 MB).");
    let json;
    try { json = JSON.parse(await file.text()); }
    catch (e) { throw new Error("O arquivo não é um JSON válido."); }

    const incoming = Array.isArray(json) ? json : json && Array.isArray(json.notes) ? json.notes : null;
    if (!incoming) throw new Error("Estrutura não reconhecida: não encontrei uma lista de notas.");
    const backupFiles = json && !Array.isArray(json) && json.files && typeof json.files === "object" ? json.files : {};

    snapshot = { notes: state.data.notes.slice(), categories: state.data.categories.slice() };
    if (json && !Array.isArray(json)) {
      normalizeCategories(json.categories).forEach((c) => {
        if (!state.data.categories.some((x) => x.id === c.id)) state.data.categories.push(c);
      });
    }

    const usedIds = new Set(state.data.notes.map((n) => n.id));
    const pending = []; // arquivos das notas novas: { id, blob }
    let imported = 0, skipped = 0, invalid = 0, lostFiles = 0;
    incoming.forEach((raw) => {
      const note = normalizeNote(raw, state.data.categories);
      if (!note) { invalid++; return; }
      const existing = getNote(note.id);
      if (existing && existing.updated === note.updated && existing.content === note.content && existing.title === note.title) { skipped++; return; }
      if (usedIds.has(note.id)) note.id = uid();
      usedIds.add(note.id);

      // Cada nota importada recebe cópias próprias dos arquivos, com ids novos (nada é compartilhado por acidente).
      const idMap = new Map();
      noteFileIds(note).forEach((oldId) => {
        const entry = Object.prototype.hasOwnProperty.call(backupFiles, oldId) ? backupFiles[oldId] : null;
        const blob = decodeBackupFile(entry);
        if (!blob) { lostFiles++; return; }
        const newId = uid();
        idMap.set(oldId, newId);
        pending.push({ id: newId, blob });
      });
      note.content = note.content.replace(FILE_ID_ATTR, (m, id) => (idMap.has(id) ? `data-file="${idMap.get(id)}"` : m));
      note.attachments = note.attachments.filter((a) => idMap.has(a.id)).map((a) => ({ ...a, id: idMap.get(a.id) }));

      state.data.notes.push(note);
      imported++;
    });

    if (!imported && !skipped) throw new Error("Nenhuma nota válida foi encontrada no arquivo.");

    if (imported) {
      if (pending.length) {
        try { await Files.open(); }
        catch (e) { throw new Error("Este navegador não permite guardar os anexos do backup. Nada foi alterado."); }
        try {
          for (const p of pending) { await Files.put(p.id, p.blob, p.blob.type); created.push(p.id); }
        } catch (e) { throw new Error("Sem espaço no navegador para os anexos do backup. Nada foi alterado."); }
      }
      if (!(await saveData())) throw new Error("Sem espaço no navegador para importar. Nada foi alterado.");
    }
    fillCategorySelects();
    renderAll();
    housekeeping();
    const parts = [`${imported} ${imported === 1 ? "nota importada" : "notas importadas"}`];
    if (skipped) parts.push(`${skipped} já existiam`);
    if (invalid) parts.push(`${invalid} inválidas ignoradas`);
    if (lostFiles) parts.push(`${lostFiles} ${lostFiles === 1 ? "anexo ausente no backup" : "anexos ausentes no backup"}`);
    toast(parts.join(", ") + ".", lostFiles ? { duration: 8000 } : {});
  } catch (e) {
    if (snapshot) { state.data.notes = snapshot.notes; state.data.categories = snapshot.categories; fillCategorySelects(); }
    if (created.length) Files.remove(created).catch(() => {});
    toast(e.message || "Não foi possível importar o arquivo.", { tone: "error", duration: 7000 });
  }
}

async function clearAllData() {
  const ok = await confirmAction({
    title: "Limpar todos os dados?",
    message: "Todas as notas (inclusive as da lixeira) e o PIN serão apagados deste navegador. Não dá para desfazer.",
    confirmText: "Apagar tudo", danger: true, requireText: "APAGAR"
  });
  if (!ok) return;
  debouncedSave.cancel(); dirty = false;
  els.settingsDialog.close();
  wipeEverything();
  startApp();
  toast("Todos os dados foram apagados.");
}

/* ============================================================
 * 4. MANIPULAÇÃO DAS NOTAS
 * ============================================================ */

const getNote = (id) => (state.data ? state.data.notes.find((n) => n.id === id) || null : null);
const activeNote = () => getNote(state.ui.activeId);
const liveNotes = () => state.data.notes.filter((n) => !n.deletedAt);
const trashedNotes = () => state.data.notes.filter((n) => n.deletedAt);
const categoryName = (id) => (state.data.categories.find((c) => c.id === id) || {}).name || "Sem categoria";
const defaultCategoryId = () => (state.data.categories.find((c) => c.id === "pessoal") || state.data.categories[0]).id;

/** Ponto de extensão: permite criar categorias novas no futuro (ainda sem tela própria). */
function addCategory(name) {
  const clean = String(name || "").trim().slice(0, 30);
  if (!clean) return null;
  const id = slugify(clean);
  if (!state.data.categories.some((c) => c.id === id)) state.data.categories.push({ id, name: clean });
  fillCategorySelects();
  commit();
  return id;
}

function isEmptyNote(n) {
  return !n.title.trim() && !plainText(n.content) && !/<img/i.test(n.content) && !n.tags.length && !n.attachments.length;
}

function createNote() {
  const now = Date.now();
  const note = {
    id: uid(), title: "", content: "",
    category: state.ui.category !== "all" ? state.ui.category : defaultCategoryId(),
    tags: [], attachments: [], color: "none", favorite: false, pinned: false, created: now, updated: now, deletedAt: null
  };
  state.data.notes.unshift(note);
  return note;
}

/** Notas novas que ficaram vazias são descartadas ao sair delas. */
function discardIfEmpty(id) {
  const note = getNote(id);
  if (!note || note.deletedAt || !isEmptyNote(note)) return false;
  state.data.notes = state.data.notes.filter((n) => n.id !== id);
  textCache.delete(id); searchCache.delete(id);
  saveData();
  return true;
}

function moveToTrash(id) {
  const note = getNote(id);
  if (!note) return;
  captureIfDirty();
  if (isEmptyNote(note)) { discardIfEmpty(id); leaveNote(); renderAll(); return; }
  note.deletedAt = Date.now();
  if (state.ui.activeId === id) leaveNote();
  commit();
  toast("Nota movida para a lixeira.", { action: { label: "Desfazer", onClick: () => restoreNote(id, { open: true }) } });
}

function restoreNote(id, { open = false } = {}) {
  const note = getNote(id);
  if (!note) return;
  note.deletedAt = null;
  if (open) { state.ui.scope = state.ui.scope === "trash" ? "all" : state.ui.scope; commit(); selectNote(id); return; }
  if (state.ui.activeId === id) leaveNote();
  commit();
  toast("Nota restaurada.", { action: { label: "Abrir", onClick: () => { state.ui.scope = "all"; selectNote(id); } } });
}

async function deleteForever(id) {
  const note = getNote(id);
  if (!note) return;
  const ok = await confirmAction({
    title: "Excluir permanentemente?",
    message: `“${note.title.trim() || "Sem título"}” será apagada de vez. Não dá para desfazer.`,
    confirmText: "Excluir", danger: true
  });
  if (!ok) return;
  state.data.notes = state.data.notes.filter((n) => n.id !== id);
  textCache.delete(id); searchCache.delete(id);
  if (state.ui.activeId === id) leaveNote();
  commit();
  releaseFiles(noteFileIds(note));
  toast("Nota excluída permanentemente.");
}

async function emptyTrash() {
  const count = trashedNotes().length;
  if (!count) return;
  const ok = await confirmAction({
    title: "Esvaziar a lixeira?",
    message: `${count} ${count === 1 ? "nota será apagada" : "notas serão apagadas"} de vez. Não dá para desfazer.`,
    confirmText: "Esvaziar", danger: true
  });
  if (!ok) return;
  const removed = trashedNotes();
  state.data.notes = state.data.notes.filter((n) => !n.deletedAt);
  if (activeNote() === null) leaveNote();
  commit();
  releaseFiles(removed.flatMap((n) => [...noteFileIds(n)]));
  toast("Lixeira esvaziada.");
}

function toggleFavorite() {
  const note = activeNote();
  if (!note) return;
  note.favorite = !note.favorite;
  renderEditorBar(note);
  commit();
}
function togglePin() {
  const note = activeNote();
  if (!note) return;
  note.pinned = !note.pinned;
  renderEditorBar(note);
  commit();
}
function setColor(color) {
  const note = activeNote();
  if (!note || !COLORS.includes(color)) return;
  note.color = color;
  renderEditorBar(note);
  commit();
}
function setCategory(id) {
  const note = activeNote();
  if (!note || !state.data.categories.some((c) => c.id === id)) return;
  note.category = id;
  note.updated = Date.now();
  commit();
}
function addTagsFromInput() {
  const note = activeNote();
  if (!note) return;
  const parts = els.tagInput.value.split(/[\s,;]+/);
  els.tagInput.value = "";
  let changed = false;
  parts.forEach((part) => {
    const tag = normalizeTag(part);
    if (tag && !note.tags.includes(tag) && note.tags.length < 20) { note.tags.push(tag); changed = true; }
  });
  if (!changed) return;
  note.updated = Date.now();
  renderTagEditor(note);
  commit();
}
function removeTag(tag) {
  const note = activeNote();
  if (!note) return;
  note.tags = note.tags.filter((t) => t !== tag);
  note.updated = Date.now();
  renderTagEditor(note);
  commit();
}

/* ---------- Salvamento (com debounce) ---------- */

const SAVE_LABELS = { saved: "Salvo", saving: "Salvando...", dirty: "Alterações não salvas", error: "Erro ao salvar" };
function setSaveState(s) {
  state.ui.saveState = s;
  els.saveStatus.dataset.state = s;
  els.saveStatus.textContent = SAVE_LABELS[s];
}

/** Copia título e conteúdo do editor para a nota ativa. */
function captureEditor() {
  const note = activeNote();
  if (!note || note.deletedAt || state.ui.view !== "editor") return;
  note.title = els.noteTitle.value.slice(0, 200);
  note.content = sanitizeHtml(els.noteContent.innerHTML);
  note.updated = Date.now();
}
function captureIfDirty() {
  if (!dirty) return;
  debouncedSave.cancel();
  captureEditor();
  dirty = false;
}

async function commit() {
  if (!state.data) return false;
  captureIfDirty();
  setSaveState("saving");
  const ok = await saveData();
  if (!state.data) return ok; // o app foi bloqueado durante a gravação
  if (ok) setSaveState(dirty ? "dirty" : "saved");
  else { setSaveState("error"); warnSaveFailure(); }
  renderAll();
  return ok;
}
const debouncedSave = debounce(commit, SAVE_DELAY_MS);

function markDirty() {
  dirty = true;
  setSaveState("dirty");
  debouncedSave();
}
function flushEdits() { if (dirty) commit(); }

function warnSaveFailure() {
  if (Date.now() - lastSaveWarning < 15000) return;
  lastSaveWarning = Date.now();
  toast("Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado. Exporte um backup e libere espaço.", { tone: "error", duration: 9000 });
}

/* ============================================================
 * 5. FILTROS, BUSCA E ORDENAÇÃO
 * ============================================================ */

const titleOf = (n) => n.title.trim() || "Sem título";
const byRecent = (a, b) => b.updated - a.updated;
const SORTERS = {
  recent: byRecent,
  oldest: (a, b) => a.updated - b.updated,
  "title-asc": (a, b) => titleOf(a).localeCompare(titleOf(b), "pt-BR", { sensitivity: "base" }),
  "title-desc": (a, b) => titleOf(b).localeCompare(titleOf(a), "pt-BR", { sensitivity: "base" }),
  favorites: (a, b) => (b.favorite - a.favorite) || (b.pinned - a.pinned) || byRecent(a, b),
  pinned: (a, b) => (b.favorite - a.favorite) || byRecent(a, b)
};

/** Fixadas sempre aparecem primeiro (exceto em "Favoritas primeiro"). */
function sortNotes(list) {
  if (state.ui.scope === "trash") return [...list].sort((a, b) => b.deletedAt - a.deletedAt);
  const by = SORTERS[state.prefs.sort] || SORTERS.recent;
  const pinnedFirst = state.prefs.sort !== "favorites";
  return [...list].sort((a, b) => (pinnedFirst ? b.pinned - a.pinned : 0) || by(a, b));
}

function noteText(n) {
  const stamp = n.updated + ":" + n.content.length;
  let entry = textCache.get(n.id);
  if (!entry || entry.stamp !== stamp) { entry = { stamp, text: plainText(n.content) }; textCache.set(n.id, entry); }
  return entry.text;
}
/** Texto pesquisável: título, conteúdo, categoria e tags (sem acentos e em minúsculas). */
function searchIndex(n) {
  const stamp = `${n.updated}|${n.title}|${n.category}|${n.tags.join(",")}|${categoryName(n.category)}|${n.content.length}|${n.attachments.length}`;
  let entry = searchCache.get(n.id);
  if (!entry || entry.stamp !== stamp) {
    const hay = norm([n.title, noteText(n), categoryName(n.category), n.tags.map((t) => "#" + t).join(" "), n.attachments.map((a) => a.name).join(" ")].join(" "));
    entry = { stamp, hay };
    searchCache.set(n.id, entry);
  }
  return entry.hay;
}

function getVisibleNotes() {
  const { scope, category, tags, query } = state.ui;
  const terms = norm(query).split(/\s+/).filter(Boolean);
  let list = state.data.notes.filter((n) => (scope === "trash" ? n.deletedAt : !n.deletedAt));
  if (scope === "favorites") list = list.filter((n) => n.favorite);
  if (category !== "all") list = list.filter((n) => n.category === category);
  if (tags.length) list = list.filter((n) => tags.every((t) => n.tags.includes(t)));
  if (terms.length) list = list.filter((n) => { const hay = searchIndex(n); return terms.every((t) => hay.includes(t)); });
  return sortNotes(list);
}

function pruneFilters() {
  const source = state.ui.scope === "trash" ? trashedNotes() : liveNotes();
  const known = new Set(source.flatMap((n) => n.tags));
  state.ui.tags = state.ui.tags.filter((t) => known.has(t));
  if (state.ui.category !== "all" && !state.data.categories.some((c) => c.id === state.ui.category)) state.ui.category = "all";
}

function clearAllFilters() {
  Object.assign(state.ui, { scope: "all", category: "all", tags: [], query: "" });
  els.searchInput.value = "";
  els.searchBox.dataset.filled = "false";
  renderSidebar();
}

/* ============================================================
 * 6. RENDERIZAÇÃO
 * ============================================================ */

function renderAll() {
  if (!state.data) return;
  renderSidebar();
  if (state.ui.view === "dashboard") renderDashboard();
}

function fillCategorySelects() {
  const cats = state.data.categories;
  els.categoryFilter.replaceChildren(h("option", { value: "all", text: "Categorias" }), ...cats.map((c) => h("option", { value: c.id, text: c.name })));
  els.noteCategory.replaceChildren(...cats.map((c) => h("option", { value: c.id, text: c.name })));
}

function renderSidebar() {
  pruneFilters();
  const visible = getVisibleNotes();
  renderFilters(visible.length);
  renderList(visible);
}

function renderFilters(shown) {
  const { scope, category, tags, query } = state.ui;
  els.scopeChips.querySelectorAll("[data-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scope === scope)));
  els.categoryFilter.value = category;
  els.sortSelect.value = state.prefs.sort;

  const trashTotal = trashedNotes().length;
  els.trashCount.textContent = trashTotal ? String(trashTotal) : "";

  const total = scope === "trash" ? trashTotal : liveNotes().length;
  const noun = (n) => (n === 1 ? "nota" : "notas");
  if (scope === "trash") els.count.textContent = `${trashTotal} ${noun(trashTotal)} na lixeira`;
  else els.count.textContent = shown === total ? `${total} ${noun(total)}` : `${shown} de ${total} ${noun(total)}`;

  const activeFilters = (category !== "all" ? 1 : 0) + tags.length;
  els.filterBadge.hidden = !activeFilters;
  els.filterBadge.textContent = String(activeFilters);
  els.clearFilters.hidden = !(activeFilters || query);

  const source = scope === "trash" ? trashedNotes() : liveNotes();
  const freq = new Map();
  source.forEach((n) => n.tags.forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
  const ordered = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  els.tagChips.hidden = !ordered.length;
  els.tagChips.replaceChildren(...ordered.map(([tag]) =>
    h("button", { class: "chip", type: "button", "aria-pressed": String(tags.includes(tag)), dataset: { tag }, text: "#" + tag })
  ));
  els.tagSuggestions.replaceChildren(...[...new Set(liveNotes().flatMap((n) => n.tags))].sort().map((t) => h("option", { value: t })));
}

function renderList(visible) {
  els.listTools.hidden = state.ui.scope !== "trash";
  els.emptyTrashBtn.disabled = !trashedNotes().length;
  els.noteList.replaceChildren(...visible.map(buildCard));
  renderEmptyState(visible.length);
}

function buildCard(n) {
  const untitled = !n.title.trim();
  const preview = noteText(n).slice(0, 110) || "Sem texto";
  const tags = n.tags.slice(0, 3).map((t) => h("span", { class: "tag", text: "#" + t }));
  if (n.tags.length > 3) tags.push(h("span", { class: "tag more", text: `+${n.tags.length - 3}` }));
  return h("li", {},
    h("button", {
      class: "note-card", type: "button", "aria-current": String(n.id === state.ui.activeId),
      dataset: { id: n.id, color: n.color !== "none" ? n.color : null },
      onClick: () => selectNote(n.id)
    },
      h("span", { class: "card-top" },
        h("span", { class: "card-title" + (untitled ? " untitled" : ""), text: titleOf(n) }),
        n.pinned ? icon("pin", "mark-pin") : null,
        n.favorite ? icon("star", "mark-star") : null),
      h("span", { class: "card-preview", text: preview }),
      h("span", { class: "card-meta" }, h("span", { class: "badge", text: categoryName(n.category) }), ...tags,
        n.attachments.length ? h("span", { class: "tag attach-tag", title: `${n.attachments.length} ${n.attachments.length === 1 ? "anexo" : "anexos"}` }, icon("clip"), String(n.attachments.length)) : null),
      h("span", { class: "card-date", text: n.deletedAt ? `Excluída ${formatRelative(n.deletedAt)}` : formatRelative(n.updated) })
    ));
}

function renderEmptyState(count) {
  els.listEmpty.hidden = count > 0;
  if (count > 0) return;
  const { scope, query, category, tags } = state.ui;
  let title, text, canClear = false;
  if (query || category !== "all" || tags.length) { title = "Nenhuma nota encontrada"; text = "Tente outra palavra, tag ou categoria."; canClear = true; }
  else if (scope === "trash") { title = "A lixeira está vazia"; text = "Notas excluídas aparecem aqui e podem ser restauradas."; }
  else if (scope === "favorites") { title = "Nenhuma favorita ainda"; text = "Use a estrela dentro de uma nota para favoritá-la."; }
  else { title = "Nenhuma nota ainda"; text = "Use Nova nota para começar."; }
  els.listEmpty.replaceChildren(
    h("strong", { text: title }), h("span", { text }),
    canClear ? h("button", { class: "btn btn-small", type: "button", text: "Limpar busca e filtros", onClick: clearAllFilters }) : null
  );
}

function renderDashboard() {
  const live = liveNotes();
  const stats = [
    { label: "notas", value: live.length, scope: "all" },
    { label: "favoritas", value: live.filter((n) => n.favorite).length, scope: "favorites" },
    { label: "fixadas", value: live.filter((n) => n.pinned).length, scope: "all", sort: "pinned" },
    { label: "na lixeira", value: trashedNotes().length, scope: "trash" }
  ];
  els.dashStats.replaceChildren(...stats.map((s) =>
    h("button", { class: "stat", type: "button", onClick: () => openScope(s.scope, s.sort) },
      h("span", { class: "stat-value", text: String(s.value) }),
      h("span", { class: "stat-label", text: s.label }))
  ));

  const used = state.data.categories.map((c) => ({ c, n: live.filter((x) => x.category === c.id).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const max = used.length ? used[0].n : 1;
  els.dashCategories.replaceChildren(...(used.length
    ? used.map(({ c, n }) => h("li", {},
        h("button", { class: "cat-row", type: "button", onClick: () => openCategory(c.id) },
          h("span", { class: "cat-row-top" }, h("span", { text: c.name }), h("span", { class: "cat-count", text: String(n) })),
          h("span", { class: "bar" }, h("span", { class: "bar-fill", style: `width:${Math.round((n / max) * 100)}%` })))))
    : [h("li", { class: "panel-empty", text: "Nenhuma categoria em uso ainda." })]));

  const recent = [...live].sort(byRecent).slice(0, 5);
  els.dashRecent.replaceChildren(...(recent.length
    ? recent.map((n) => h("li", {}, h("button", { class: "recent-row", type: "button", onClick: () => selectNote(n.id) },
        h("span", { class: "recent-title", text: titleOf(n) }), h("span", { class: "recent-date", text: formatRelative(n.updated) }))))
    : [h("li", { class: "panel-empty", text: "Suas notas mais recentes aparecerão aqui." })]));
}

function openScope(scope, sort) {
  state.ui.scope = scope;
  if (sort) { state.prefs.sort = sort; savePrefs(); }
  renderSidebar();
  setPane("list");
}
function openCategory(id) {
  Object.assign(state.ui, { scope: "all", category: id });
  renderSidebar();
  setPane("list");
}

function showView(name) {
  state.ui.view = name;
  els.viewDashboard.hidden = name !== "dashboard";
  els.viewEditor.hidden = name !== "editor";
  els.viewTrash.hidden = name !== "trash";
  if (name === "dashboard") renderDashboard();
}
const setPane = (pane) => { els.app.dataset.pane = pane; };

function setSort(value) {
  if (!SORTERS[value]) return;
  state.prefs.sort = value;
  savePrefs();
  renderSidebar();
}

function selectNote(id, { focus = null } = {}) {
  const note = getNote(id);
  if (!note) return;
  closeHighlightPicker();
  flushEdits();
  const previous = state.ui.activeId;
  if (previous && previous !== id) discardIfEmpty(previous);
  state.ui.activeId = id;
  if (note.deletedAt) { showView("trash"); renderTrashView(note); }
  else { showView("editor"); loadEditor(note); }
  setPane("main");
  renderSidebar();
  if (focus === "title") els.noteTitle.focus();
}

/** Fecha a nota aberta e volta ao resumo (e à lista, no celular). */
function leaveNote() {
  closeHighlightPicker();
  state.ui.activeId = null;
  showView("dashboard");
  setPane("list");
}
function closeMain() {
  flushEdits();
  if (state.ui.activeId) discardIfEmpty(state.ui.activeId);
  leaveNote();
  renderAll();
}
function openDashboard() {
  closeMain();
  setPane("main");
}

function newNote() {
  if (!state.data) return;
  flushEdits();
  if (state.ui.scope === "trash") state.ui.scope = "all";
  state.ui.query = "";
  state.ui.tags = [];
  els.searchInput.value = "";
  els.searchBox.dataset.filled = "false";
  const note = createNote();
  selectNote(note.id, { focus: "title" });
}

function renderTrashView(note) {
  els.trashTitle.textContent = titleOf(note);
  els.trashMeta.replaceChildren(
    h("span", { class: "badge", text: categoryName(note.category) }),
    ...note.tags.map((t) => h("span", { class: "tag", text: "#" + t })),
    h("span", { class: "muted", text: `Excluída ${formatRelative(note.deletedAt)}` })
  );
  els.trashContent.innerHTML = sanitizeHtml(note.content);
  els.trashContent.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  hydrateImages(els.trashContent);
  renderAttachmentList(note, els.trashAttachList, els.trashAttachments, { editable: false });
  setColorAttr(els.viewTrash, note.color);
}

/* ============================================================
 * 7. EDITOR
 * ============================================================ */

function setColorAttr(el, color) {
  if (color && color !== "none") el.dataset.color = color; else delete el.dataset.color;
}

function loadEditor(note) {
  els.noteTitle.value = note.title;
  els.noteContent.innerHTML = sanitizeHtml(note.content);
  hydrateImages(els.noteContent);
  renderAttachments(note);
  renderTagEditor(note);
  renderEditorBar(note);
  updateEmptyState();
  updateWordCount();
  dirty = false;
  debouncedSave.cancel();
  setSaveState("saved");
  els.sheet.animate?.([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
}

function renderEditorBar(note) {
  setColorAttr(els.viewEditor, note.color);
  els.swatches.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-checked", String(s.dataset.color === note.color)));
  els.favBtn.setAttribute("aria-pressed", String(note.favorite));
  els.pinBtn.setAttribute("aria-pressed", String(note.pinned));
  els.noteCategory.value = note.category;
}

function renderTagEditor(note) {
  els.noteTags.replaceChildren(...note.tags.map((t) =>
    h("li", { class: "tag-chip" }, h("span", { text: "#" + t }),
      h("button", { type: "button", "aria-label": `Remover tag ${t}`, onClick: () => removeTag(t) }, icon("x")))
  ));
}

function updateEmptyState() {
  const empty = !els.noteContent.textContent.trim() && !els.noteContent.querySelector("img,li,pre");
  els.noteContent.classList.toggle("is-empty", empty);
}
function updateWordCount() {
  // Usa o HTML (e não innerText) porque innerText fica vazio quando o painel ainda está oculto no celular.
  const text = plainText(els.noteContent.innerHTML).replace(/\[imagem\]/g, "").trim();
  const words = text ? text.split(/\s+/).length : 0;
  const lines = countLines(els.noteContent);
  els.wordCount.textContent = `${words} ${words === 1 ? "palavra" : "palavras"}`;
  els.lineCount.textContent = `${lines} ${lines === 1 ? "linha" : "linhas"}`;
}
/**
 * Conta linhas visuais no editor: cada bloco de nível superior (parágrafo, item de lista, linha de
 * título...) é uma linha; um bloco <pre> com várias quebras internas conta uma linha por quebra.
 * Texto ou imagem soltos antes do primeiro Enter (sem bloco ao redor) contam como 1 linha.
 */
function countLines(root) {
  const BLOCK = new Set(["P", "DIV", "H2", "H3", "BLOCKQUOTE"]);
  let lines = 0, loose = false;
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) loose = true; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === "BR") lines++;
    else if (tag === "PRE") lines += Math.max(1, node.textContent.split("\n").length);
    else if (tag === "UL" || tag === "OL") lines += Math.max(1, node.children.length);
    else if (BLOCK.has(tag)) lines++;
    else if (node.textContent.trim() || node.querySelector("img")) loose = true; // formatação solta (b, i, mark...) fora de um bloco
  });
  if (loose) lines++;
  if (!lines && (root.textContent.trim() || root.querySelector("img"))) lines = 1;
  return lines;
}

/* ---------- Seleção e comandos de formatação ---------- */

function closestInSelection(selector) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const found = node && node.closest ? node.closest(selector) : null;
  return found && els.noteContent.contains(found) ? found : null;
}
function saveSelection() {
  const sel = window.getSelection();
  savedRange = sel && sel.rangeCount && els.noteContent.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
}
function restoreSelection() {
  els.noteContent.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (savedRange) sel.addRange(savedRange);
  else { const r = document.createRange(); r.selectNodeContents(els.noteContent); r.collapse(false); sel.addRange(r); }
}

function onFormatted() {
  markDirty();
  updateToolbarState();
  updateEmptyState();
  updateWordCount();
}
function exec(command, value = null) {
  els.noteContent.focus();
  document.execCommand("styleWithCSS", false, false); // usa <b>, <i>... em vez de style=""
  document.execCommand(command, false, value);
  onFormatted();
}

function toggleBlock(tag) {
  exec("formatBlock", closestInSelection(tag) ? "p" : tag);
}
function toggleBulletList() {
  const checklist = closestInSelection("ul.checklist");
  if (checklist) { checklist.classList.remove("checklist"); onFormatted(); return; }
  exec("insertUnorderedList");
}
function toggleChecklist() {
  els.noteContent.focus();
  const list = closestInSelection("ul");
  if (list && list.classList.contains("checklist")) { exec("insertUnorderedList"); return; } // desfaz a lista
  if (list) { list.classList.add("checklist"); onFormatted(); return; }                    // converte lista comum
  document.execCommand("insertUnorderedList");
  const created = closestInSelection("ul");
  if (created) created.classList.add("checklist");
  onFormatted();
}
/** <mark> sob o cursor ou tocados pela seleção. */
function marksInSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return [];
  const near = closestInSelection("mark");
  if (near) return [near];
  const range = sel.getRangeAt(0);
  if (range.collapsed) return [];
  return [...els.noteContent.querySelectorAll("mark")].filter((m) => range.intersectsNode(m));
}
function selectAround(startNode, endNode, inside = false) {
  const sel = window.getSelection();
  const range = document.createRange();
  if (inside) { range.setStart(startNode, 0); range.setEnd(endNode, endNode.childNodes.length); }
  else { range.setStartBefore(startNode); range.setEndAfter(endNode); }
  sel.removeAllRanges();
  sel.addRange(range);
}
/** Monta os botões de cor do popover de realce a partir de HIGHLIGHT_COLORS. */
function buildHighlightPicker() {
  els.highlightPopover.replaceChildren(
    ...HIGHLIGHT_COLORS.map((c) => h("button", {
      type: "button", class: "hl-swatch", dataset: { hl: c.id }, role: "menuitemradio", "aria-checked": "false", "aria-label": c.name
    })),
    h("span", { class: "hl-sep", "aria-hidden": "true" }),
    h("button", { type: "button", class: "hl-remove", dataset: { hl: "none" }, role: "menuitem", text: "Remover" })
  );
}

function toggleHighlightPicker() {
  if (els.highlightPopover.hidden) openHighlightPicker(); else closeHighlightPicker();
}
function openHighlightPicker() {
  saveSelection();
  const mark = closestInSelection("mark");
  const current = mark ? mark.dataset.color || "butter" : null;
  els.highlightPopover.querySelectorAll("[data-hl]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.hl === current)));
  els.highlightPopover.hidden = false;
  positionHighlightPicker();
  window.addEventListener("resize", positionHighlightPicker);
  els.fmtMarkBtn.setAttribute("aria-expanded", "true");
  document.addEventListener("click", onOutsideHighlightClick, true);
  document.addEventListener("keydown", onHighlightPickerKeydown, true);
}
/** Mantém o popover dentro da tela, mesmo quando o botão "Realce" está perto da borda (mobile). */
function positionHighlightPicker() {
  const btn = els.fmtMarkBtn.getBoundingClientRect();
  const pop = els.highlightPopover;
  const maxLeft = Math.max(8, window.innerWidth - pop.offsetWidth - 8);
  pop.style.top = btn.bottom + 8 + "px";
  pop.style.left = Math.min(maxLeft, Math.max(8, btn.right - pop.offsetWidth)) + "px";
}
function closeHighlightPicker() {
  if (els.highlightPopover.hidden) return;
  els.highlightPopover.hidden = true;
  els.fmtMarkBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onOutsideHighlightClick, true);
  document.removeEventListener("keydown", onHighlightPickerKeydown, true);
  window.removeEventListener("resize", positionHighlightPicker);
}
function onOutsideHighlightClick(e) {
  if (!els.highlightPopover.contains(e.target) && e.target !== els.fmtMarkBtn) closeHighlightPicker();
}
function onHighlightPickerKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); closeHighlightPicker(); els.noteContent.focus(); }
}
/** Aplica (ou remove, com colorId null) a cor de destaque na seleção salva. "butter" é a cor padrão (sem atributo, compatível com notas antigas). */
function applyHighlight(colorId) {
  restoreSelection();
  const sel = window.getSelection();
  const marks = marksInSelection();
  if (colorId === null) {
    if (!marks.length) return;
    const first = marks[0].firstChild, last = marks[marks.length - 1].lastChild;
    marks.forEach((m) => m.replaceWith(...m.childNodes));
    if (first && last) selectAround(first, last);
  } else if (marks.length) { // já destacado: só troca a cor
    marks.forEach((m) => { if (colorId === "butter") m.removeAttribute("data-color"); else m.dataset.color = colorId; });
    selectAround(marks[0], marks[marks.length - 1], true);
  } else if (sel.rangeCount && !sel.isCollapsed) {
    // O Chrome gera <span style="background-color"> com hiliteColor; convertemos em <mark>,
    // que é a única forma de destaque que a sanitização mantém ao salvar.
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("hiliteColor", false, "#FFE58A");
    document.execCommand("styleWithCSS", false, false);
    const created = normalizeHighlights(colorId);
    if (created.length) selectAround(created[0], created[created.length - 1], true); // permite alternar de novo
  } else return;
  onFormatted();
}
function normalizeHighlights(colorId) {
  const marks = [];
  els.noteContent.querySelectorAll("span[style]").forEach((span) => {
    if (!/background/i.test(span.getAttribute("style"))) return;
    const mark = document.createElement("mark");
    if (colorId && colorId !== "butter") mark.dataset.color = colorId;
    mark.append(...span.childNodes);
    span.replaceWith(mark);
    marks.push(mark);
  });
  return marks;
}

const COMMANDS = {
  bold: () => exec("bold"),
  italic: () => exec("italic"),
  underline: () => exec("underline"),
  highlight: toggleHighlightPicker,
  h2: () => toggleBlock("h2"),
  h3: () => toggleBlock("h3"),
  ul: toggleBulletList,
  ol: () => exec("insertOrderedList"),
  checklist: toggleChecklist,
  link: openLinkDialog,
  code: () => toggleBlock("pre"),
  image: () => { saveSelection(); els.imageInput.click(); },
  pdf: () => els.pdfInput.click()
};

function updateToolbarState() {
  if (state.ui.view !== "editor") return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !els.noteContent.contains(sel.anchorNode)) return;
  const inChecklist = !!closestInSelection("ul.checklist");
  const states = {
    bold: document.queryCommandState("bold"),
    italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    highlight: !!closestInSelection("mark"),
    h2: !!closestInSelection("h2"),
    h3: !!closestInSelection("h3"),
    ul: !!closestInSelection("ul") && !inChecklist,
    ol: !!closestInSelection("ol"),
    checklist: inChecklist,
    link: !!closestInSelection("a"),
    code: !!closestInSelection("pre")
  };
  els.formatBar.querySelectorAll("[data-cmd]").forEach((b) => {
    if (b.dataset.cmd in states) b.setAttribute("aria-pressed", String(!!states[b.dataset.cmd]));
  });
}

/* ---------- Links ---------- */

function normalizeUrl(input) {
  const value = input.trim();
  if (!value) return null;
  if (SAFE_HREF.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // outros esquemas (javascript:, data:...) são bloqueados
  if (value.includes("@") && !/\s/.test(value)) return "mailto:" + value;
  return "https://" + value;
}
function openLinkDialog() {
  saveSelection();
  const existing = closestInSelection("a");
  els.linkUrl.value = existing ? existing.getAttribute("href") : "";
  els.linkRemove.hidden = !existing;
  els.linkError.textContent = "";
  els.linkDialog.showModal();
  els.linkUrl.focus();
}
function applyLink(event) {
  event.preventDefault();
  const url = normalizeUrl(els.linkUrl.value);
  if (!url) { els.linkError.textContent = "Digite um endereço válido (http, https ou e-mail)."; return; }
  els.linkDialog.close();
  restoreSelection();
  const sel = window.getSelection();
  if (sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(els.linkUrl.value.trim())}</a>&nbsp;`);
  else document.execCommand("createLink", false, url);
  onFormatted();
}
function removeLink() {
  els.linkDialog.close();
  restoreSelection();
  document.execCommand("unlink");
  onFormatted();
}

/* ---------- Imagens e PDFs ---------- */

const isImageFile = (f) => /^image\/(png|jpe?g|gif|webp)$/i.test(f.type);
const isPdfFile = (f) => f.type === "application/pdf" || (!f.type && /\.pdf$/i.test(f.name));
const formatSize = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB`);

async function ensureFilesReady() {
  try {
    await Files.open();
    if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); } // pede para o navegador não apagar os anexos sozinho
    return true;
  } catch (e) {
    toast("Este navegador não permite guardar anexos (o armazenamento local está bloqueado).", { tone: "error", duration: 7000 });
    return false;
  }
}
async function hasRoomFor(bytes) {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota && usage != null && quota - usage < bytes * 1.5 + 5e6) return false;
  } catch (e) { /* sem estimativa: deixa tentar */ }
  return true;
}
const NO_ROOM = "Sem espaço no navegador para guardar esse arquivo. Exporte um backup e remova anexos antigos.";
function toastFileError(e, fallback) {
  const quota = e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
  toast(quota ? NO_ROOM : (e && e.message) || fallback, { tone: "error", duration: 7000 });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Não foi possível ler essa imagem.")); };
    img.src = url;
  });
}
const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Prepara a imagem para guardar: GIFs ficam como estão (mantém a animação); as demais são
 * reduzidas (lado máximo 1600 px) e recomprimidas em JPEG, exceto quando já são pequenas.
 * Na conversão para JPEG, transparência vira fundo branco.
 */
async function prepareImage(file) {
  if (file.type === "image/gif") {
    if (file.size > MAX_IMAGE_BYTES) throw new Error("Esse GIF é grande demais (limite de 8 MB).");
    return { blob: file, mime: "image/gif" };
  }
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && file.size <= 1.5 * 1048576) return { blob: file, mime: file.type.toLowerCase() };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
  if (!blob) throw new Error("Não foi possível processar essa imagem.");
  if (scale === 1 && blob.size >= file.size && file.size <= MAX_IMAGE_BYTES) return { blob: file, mime: file.type.toLowerCase() };
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("A imagem é grande demais, mesmo comprimida. Tente uma menor.");
  return { blob, mime: "image/jpeg" };
}

async function insertImageFile(file) {
  if (!file || !isImageFile(file)) { toast("Use imagens PNG, JPG, GIF ou WebP.", { tone: "error" }); return; }
  if (!(await ensureFilesReady())) return;
  const note = activeNote();
  if (!note || note.deletedAt || state.ui.view !== "editor") return;
  let id = null;
  try {
    const { blob, mime } = await prepareImage(file);
    if (!(await hasRoomFor(blob.size))) throw new Error(NO_ROOM);
    id = uid();
    await Files.put(id, blob, mime);
    if (state.ui.activeId !== note.id || els.viewEditor.hidden) { await Files.remove([id]); return; } // o usuário trocou de nota no meio do caminho
    const url = URL.createObjectURL(blob);
    urlCache.set(id, Promise.resolve(url));
    restoreSelection();
    document.execCommand("insertImage", false, url);
    const img = [...els.noteContent.querySelectorAll("img")].find((el) => el.getAttribute("src") === url && !el.hasAttribute("data-file"));
    if (!img) throw new Error("Não foi possível inserir a imagem.");
    img.setAttribute("data-file", id);
    img.alt = "imagem";
    onFormatted();
    saveSelection(); // a próxima imagem entra depois desta
  } catch (e) {
    if (id) { revokeUrl(id); Files.remove([id]).catch(() => {}); }
    toastFileError(e, "Não foi possível inserir a imagem.");
  }
}
async function insertImages(files) { for (const f of files) await insertImageFile(f); }

/** Troca <img data-file> (sem src) pela imagem guardada. Mostra um aviso se o arquivo não existir mais. */
async function hydrateImages(root) {
  const imgs = [...root.querySelectorAll("img[data-file]")].filter((img) => !img.getAttribute("src"));
  await Promise.all(imgs.map(async (img) => {
    let url = null;
    try { url = await fileUrl(img.getAttribute("data-file")); } catch (e) { /* tratado como ausente */ }
    if (url) img.src = url;
    else { img.classList.add("img-missing"); img.alt = "Imagem indisponível neste navegador"; }
  }));
}

/* ---------- Anexos em PDF ---------- */

async function looksLikePdf(file) {
  return hasPdfHeader(new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
}

async function attachPdfs(files) {
  const note = activeNote();
  if (!note || note.deletedAt || state.ui.view !== "editor") return;
  if (!(await ensureFilesReady())) return;
  let added = 0;
  for (const file of files) {
    if (note.attachments.length >= MAX_ATTACHMENTS) { toast(`Cada nota aceita até ${MAX_ATTACHMENTS} anexos.`, { tone: "error" }); break; }
    let id = null;
    try {
      if (file.size > MAX_PDF_BYTES) throw new Error(`“${file.name}” passa do limite de ${MAX_PDF_BYTES / 1048576} MB.`);
      if (!(await looksLikePdf(file))) throw new Error(`“${file.name}” não parece ser um PDF válido.`);
      if (!(await hasRoomFor(file.size))) throw new Error(NO_ROOM);
      id = uid();
      await Files.put(id, file, "application/pdf");
      if (!getNote(note.id)) { await Files.remove([id]); return; } // a nota foi apagada durante o envio
      note.attachments.push({ id, name: cleanFileName(file.name), type: "application/pdf", size: file.size, added: Date.now() });
      added++;
    } catch (e) {
      if (id) Files.remove([id]).catch(() => {});
      toastFileError(e, "Não foi possível anexar o PDF.");
    }
  }
  if (!added) return;
  note.updated = Date.now();
  if (state.ui.activeId === note.id) renderAttachments(note);
  await commit();
  toast(added === 1 ? "PDF anexado." : `${added} PDFs anexados.`, { duration: 2500 });
}

function renderAttachments(note) {
  renderAttachmentList(note, els.attachList, els.attachments, { editable: true });
}
function renderAttachmentList(note, list, section, { editable }) {
  section.hidden = !note.attachments.length;
  list.replaceChildren(...note.attachments.map((a) =>
    h("li", { class: "attach-item" },
      icon("file", "attach-icon"),
      h("div", { class: "attach-info" },
        h("span", { class: "attach-name", text: a.name, title: a.name }),
        h("span", { class: "attach-meta", text: `PDF · ${formatSize(a.size)}` })),
      h("div", { class: "attach-actions" },
        h("button", { class: "btn btn-small", type: "button", text: "Abrir", "aria-label": `Abrir ${a.name}`, onClick: () => openPdf(a) }),
        h("button", { class: "btn btn-small", type: "button", text: "Baixar", "aria-label": `Baixar ${a.name}`, onClick: () => downloadAttachment(a) }),
        editable ? h("button", { class: "btn btn-small btn-danger-outline", type: "button", text: "Remover", "aria-label": `Remover ${a.name}`, onClick: () => removeAttachment(note, a) }) : null))
  ));
}

async function openPdf(a) {
  try {
    const url = await fileUrl(a.id);
    if (!url) throw new Error("O arquivo não foi encontrado neste navegador.");
    els.pdfTitle.textContent = a.name;
    els.pdfOpenTab.href = url;
    els.pdfFrame.src = url;
    els.pdfDialog.showModal();
  } catch (e) { toast(e.message || "Não foi possível abrir o PDF.", { tone: "error" }); }
}

async function downloadAttachment(a) {
  try {
    const blob = await Files.get(a.id);
    if (!blob) throw new Error("O arquivo não foi encontrado neste navegador.");
    downloadFile(/\.pdf$/i.test(a.name) ? a.name : a.name + ".pdf", blob, "application/pdf");
  } catch (e) { toast(e.message || "Não foi possível baixar o PDF.", { tone: "error" }); }
}

async function removeAttachment(note, a) {
  const ok = await confirmAction({
    title: "Remover anexo?",
    message: `“${a.name}” será removido desta nota. Não dá para desfazer.`,
    confirmText: "Remover", danger: true
  });
  if (!ok || !getNote(note.id)) return;
  note.attachments = note.attachments.filter((x) => x.id !== a.id);
  note.updated = Date.now();
  if (state.ui.activeId === note.id) renderAttachments(note);
  await commit();
  releaseFiles([a.id]);
  toast("Anexo removido.");
}

/** Apaga do IndexedDB os arquivos que nenhuma nota usa mais. */
async function releaseFiles(ids) {
  if (!state.data) return;
  captureIfDirty(); // conta também o que está sendo digitado agora (imagem colada de outra nota, por exemplo)
  const still = referencedFileIds(state.data.notes);
  const gone = [...ids].filter((id) => !still.has(id));
  if (!gone.length) return;
  gone.forEach(revokeUrl);
  try { await Files.remove(gone); } catch (e) { console.error(e); }
}

/* ---------- Manutenção: migrar imagens antigas e limpar arquivos órfãos ---------- */

/** Notas antigas guardavam imagens em base64 dentro do texto. Move-as para o IndexedDB e libera o localStorage. */
async function migrateInlineImages() {
  if (!state.data) return;
  let changed = false;
  for (const note of state.data.notes) {
    if (!/<img[^>]+src="data:image/i.test(note.content)) continue;
    const original = note.content;
    const doc = new DOMParser().parseFromString(original, "text/html");
    const made = [];
    try {
      for (const img of doc.body.querySelectorAll("img")) {
        const src = img.getAttribute("src") || "";
        const m = SAFE_IMG.exec(src);
        if (!m) continue;
        const type = m[1].toLowerCase();
        const mime = "image/" + (type === "jpg" ? "jpeg" : type);
        const id = uid();
        await Files.put(id, new Blob([Vault.unb64(src.slice(src.indexOf(",") + 1))], { type: mime }), mime);
        made.push(id);
        img.removeAttribute("src");
        img.setAttribute("data-file", id);
      }
      if (!made.length) continue;
      if (!state.data || note.content !== original || state.ui.activeId === note.id) { await Files.remove(made); continue; } // nota em uso: tenta na próxima vez
      note.content = sanitizeHtml(doc.body.innerHTML);
      changed = true;
    } catch (e) {
      console.error(e);
      if (made.length) await Files.remove(made).catch(() => {});
    }
  }
  if (changed && state.data) await saveData();
}

/** Remove arquivos que nenhuma nota referencia (e que já têm algumas horas, para não pegar um envio em andamento). */
async function gcFiles() {
  if (!state.data) return;
  const used = referencedFileIds(state.data.notes);
  const now = Date.now();
  const stale = (await Files.list()).filter((m) => !used.has(m.id) && now - m.t > GC_MIN_AGE_MS).map((m) => m.id);
  if (!stale.length || !state.data) return;
  stale.forEach(revokeUrl);
  await Files.remove(stale);
}

async function housekeeping() {
  if (!state.data || store.get(KEYS.data + ":corrupt") !== null) return; // com dados corrompidos, não mexe em nada
  try { await Files.open(); } catch (e) { return; }
  try {
    await migrateInlineImages();
    await gcFiles();
  } catch (e) { console.error(e); }
}

/* ============================================================
 * 8. CONFIGURAÇÕES E TEMA
 * ============================================================ */

function effectiveTheme() { return state.prefs.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
function applyTheme() {
  if (state.prefs.theme) document.documentElement.dataset.theme = state.prefs.theme;
  else delete document.documentElement.dataset.theme;
  els.themeBtn.dataset.mode = effectiveTheme();
}
function toggleTheme() {
  state.prefs.theme = effectiveTheme() === "dark" ? "light" : "dark";
  savePrefs();
  applyTheme();
}

async function updateStorageMeter() {
  const used = storageUsedChars();
  const pct = Math.min(100, Math.round((used / QUOTA_CHARS) * 100));
  els.meterFill.style.width = pct + "%";
  els.meterFill.dataset.level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low";
  els.meterText.textContent = `Texto das notas: cerca de ${(used / 1e6).toFixed(1).replace(".", ",")} MB de aproximadamente 5 MB (${pct}%).`;
  try {
    const list = await Files.list();
    const bytes = list.reduce((sum, m) => sum + (m.size || 0), 0);
    els.meterFiles.textContent = list.length
      ? `Anexos (imagens e PDFs): ${list.length} ${list.length === 1 ? "arquivo" : "arquivos"}, ${formatSize(bytes)}. Ficam num espaço separado, bem maior que o do texto.`
      : "Nenhum anexo guardado ainda.";
  } catch (e) {
    els.meterFiles.textContent = "Anexos indisponíveis neste navegador.";
  }
}

function refreshSecurityUI() {
  const on = state.security.enabled;
  const supported = Vault.supported();
  els.pinStatus.textContent = !supported ? "O bloqueio por PIN não está disponível neste navegador ou endereço (é preciso https ou localhost)."
    : on ? "Bloqueio por PIN ativado." : "Bloqueio por PIN desativado.";
  els.pinEnableBtn.hidden = on;
  els.pinEnableBtn.disabled = !supported;
  els.pinChangeBtn.hidden = !on;
  els.pinDisableBtn.hidden = !on;
  els.lockBtn.hidden = !on;
}

function openSettings() {
  updateStorageMeter();
  refreshSecurityUI();
  els.settingsDialog.showModal();
}

function openPinDialog(mode) {
  pinMode = mode;
  const titles = { enable: "Ativar PIN", change: "Alterar PIN", disable: "Desativar PIN" };
  const hints = {
    enable: "Escolha um PIN de 4 a 8 números. Sem ele não será possível abrir as notas, e não há recuperação.",
    change: "Informe o PIN atual e escolha um novo.",
    disable: "Informe o PIN atual para remover a proteção. As notas voltarão a ficar sem criptografia."
  };
  els.pinTitle.textContent = titles[mode];
  els.pinHint.textContent = hints[mode];
  els.pinCurrentField.hidden = mode === "enable";
  els.pinNewField.hidden = mode === "disable";
  els.pinConfirmField.hidden = mode === "disable";
  els.pinSubmit.textContent = mode === "disable" ? "Desativar" : "Salvar PIN";
  [els.pinCurrent, els.pinNew, els.pinConfirm].forEach((i) => { i.value = ""; });
  els.pinError.textContent = "";
  els.pinDialog.showModal();
  (mode === "enable" ? els.pinNew : els.pinCurrent).focus();
}

async function onPinSubmit(event) {
  event.preventDefault();
  const fail = (msg) => { els.pinError.textContent = msg; };
  els.pinSubmit.disabled = true;
  try {
    if (pinMode !== "enable" && !(await verifyPin(els.pinCurrent.value))) return fail("PIN atual incorreto.");
    if (pinMode === "disable") {
      await disablePin();
      toast("Bloqueio por PIN desativado.");
    } else {
      if (!PIN_RE.test(els.pinNew.value)) return fail("Use de 4 a 8 números.");
      if (els.pinNew.value !== els.pinConfirm.value) return fail("Os PINs não são iguais.");
      const result = await (pinMode === "enable" ? enablePin(els.pinNew.value) : changePin(els.pinNew.value));
      if (pinMode === "enable" && result === false) toast("PIN ativado, mas alguns anexos não puderam ser criptografados. Desative e ative o PIN de novo para tentar outra vez.", { tone: "error", duration: 9000 });
      else toast(pinMode === "enable" ? "PIN ativado. Suas notas e anexos agora estão criptografados." : "PIN alterado.");
    }
    els.pinDialog.close();
    refreshSecurityUI();
  } catch (e) {
    fail(e.message || "Não foi possível concluir.");
  } finally {
    els.pinSubmit.disabled = false;
  }
}
async function changePin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await Vault.deriveKey(pin, salt);
  const previous = { ...state.security };
  state.security = { enabled: true, key, salt, fileKey: previous.fileKey }; // a chave dos arquivos não muda
  if (!(await saveData())) { state.security = previous; throw new Error("Não foi possível salvar o novo PIN."); }
}

/* ============================================================
 * 9. EVENTOS
 * ============================================================ */

function bindEvents() {
  /* --- barra lateral --- */
  els.newBtn.addEventListener("click", newNote);
  els.dashNew.addEventListener("click", newNote);
  els.dashBtn.addEventListener("click", openDashboard);
  els.settingsBtn.addEventListener("click", openSettings);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.lockBtn.addEventListener("click", lockNow);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  els.searchInput.addEventListener("input", () => {
    state.ui.query = els.searchInput.value;
    els.searchBox.dataset.filled = String(!!els.searchInput.value);
    renderSidebar();
  });
  els.clearSearch.addEventListener("click", () => {
    els.searchInput.value = "";
    state.ui.query = "";
    els.searchBox.dataset.filled = "false";
    renderSidebar();
    els.searchInput.focus();
  });
  els.sortSelect.addEventListener("change", () => setSort(els.sortSelect.value));
  els.categoryFilter.addEventListener("change", () => { state.ui.category = els.categoryFilter.value; renderSidebar(); });
  els.scopeChips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-scope]");
    if (chip) { state.ui.scope = chip.dataset.scope; renderSidebar(); }
  });
  els.tagChips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag]");
    if (!chip) return;
    const tag = chip.dataset.tag;
    state.ui.tags = state.ui.tags.includes(tag) ? state.ui.tags.filter((t) => t !== tag) : [...state.ui.tags, tag];
    renderSidebar();
  });
  els.clearFilters.addEventListener("click", clearAllFilters);
  els.emptyTrashBtn.addEventListener("click", emptyTrash);
  document.querySelectorAll("[data-action='back']").forEach((b) => b.addEventListener("click", closeMain));

  /* --- barra do editor --- */
  els.noteCategory.addEventListener("change", () => setCategory(els.noteCategory.value));
  els.swatches.addEventListener("click", (e) => { const s = e.target.closest(".swatch"); if (s) setColor(s.dataset.color); });
  els.favBtn.addEventListener("click", toggleFavorite);
  els.pinBtn.addEventListener("click", togglePin);
  els.deleteBtn.addEventListener("click", () => { if (state.ui.activeId) moveToTrash(state.ui.activeId); });
  els.restoreBtn.addEventListener("click", () => { if (state.ui.activeId) restoreNote(state.ui.activeId); });
  els.deleteForeverBtn.addEventListener("click", () => { if (state.ui.activeId) deleteForever(state.ui.activeId); });

  /* --- título, tags e conteúdo --- */
  els.noteTitle.addEventListener("input", markDirty);
  els.noteTitle.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); els.noteContent.focus(); } });
  els.tagInput.addEventListener("keydown", (e) => {
    if (["Enter", ",", " ", ";"].includes(e.key)) { e.preventDefault(); addTagsFromInput(); }
    else if (e.key === "Backspace" && !els.tagInput.value) { const n = activeNote(); if (n && n.tags.length) removeTag(n.tags[n.tags.length - 1]); }
  });
  els.tagInput.addEventListener("blur", addTagsFromInput);

  els.noteContent.addEventListener("input", (e) => {
    if (e.inputType === "insertParagraph") { // o item novo de um checklist nasce desmarcado
      const li = closestInSelection("li");
      if (li && li.parentElement.classList.contains("checklist")) li.setAttribute("data-checked", "false");
    }
    updateEmptyState();
    updateWordCount();
    markDirty();
  });
  els.noteContent.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const cmd = { b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()];
    if (cmd) { e.preventDefault(); exec(cmd); }
  });
  els.noteContent.addEventListener("click", (e) => {
    const li = e.target.closest && e.target.closest("ul.checklist > li");
    if (li && els.noteContent.contains(li) && e.clientX - li.getBoundingClientRect().left < 28) {
      li.setAttribute("data-checked", li.getAttribute("data-checked") === "true" ? "false" : "true");
      markDirty();
      return;
    }
    const link = e.target.closest && e.target.closest("a");
    if (link && (e.ctrlKey || e.metaKey)) window.open(link.href, "_blank", "noopener,noreferrer");
  });
  els.noteContent.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const images = [...data.files].filter((f) => f.type.startsWith("image/"));
    const pdfs = [...data.files].filter(isPdfFile);
    e.preventDefault();
    if (images.length || pdfs.length) {
      saveSelection();
      insertImages(images).then(() => (pdfs.length ? attachPdfs(pdfs) : null));
      return;
    }
    const html = data.getData("text/html");
    if (html) { document.execCommand("insertHTML", false, sanitizeHtml(html)); hydrateImages(els.noteContent); } // imagem copiada de dentro do app
    else document.execCommand("insertText", false, data.getData("text/plain"));
  });
  els.noteContent.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
  els.noteContent.addEventListener("drop", async (e) => {
    const dropped = [...(e.dataTransfer?.files || [])];
    const images = dropped.filter((f) => f.type.startsWith("image/"));
    const pdfs = dropped.filter(isPdfFile);
    if (!images.length && !pdfs.length) return;
    e.preventDefault();
    saveSelection();
    await insertImages(images);
    if (pdfs.length) await attachPdfs(pdfs);
  });

  /* --- barra de formatação --- */
  els.formatBar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // mantém a seleção
  els.formatBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cmd]");
    if (btn && COMMANDS[btn.dataset.cmd]) COMMANDS[btn.dataset.cmd]();
  });
  document.addEventListener("selectionchange", updateToolbarState);
  els.imageInput.addEventListener("change", async () => {
    const files = [...els.imageInput.files];
    els.imageInput.value = "";
    await insertImages(files);
  });
  els.pdfInput.addEventListener("change", async () => {
    const files = [...els.pdfInput.files];
    els.pdfInput.value = "";
    await attachPdfs(files);
  });
  els.pdfDialog.addEventListener("close", () => { els.pdfFrame.src = "about:blank"; els.pdfOpenTab.removeAttribute("href"); });
  els.highlightPopover.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hl]");
    if (!btn) return;
    e.stopPropagation();
    applyHighlight(btn.dataset.hl === "none" ? null : btn.dataset.hl);
    closeHighlightPicker();
  });
  els.linkForm.addEventListener("submit", applyLink);
  els.linkRemove.addEventListener("click", removeLink);

  /* --- configurações e diálogos --- */
  els.exportJsonBtn.addEventListener("click", exportJson);
  els.exportMdBtn.addEventListener("click", exportMarkdown);
  els.importBtn.addEventListener("click", () => els.importInput.click());
  els.importInput.addEventListener("change", () => { const f = els.importInput.files[0]; els.importInput.value = ""; if (f) importBackup(f); });
  els.clearAllBtn.addEventListener("click", clearAllData);
  els.pinEnableBtn.addEventListener("click", () => openPinDialog("enable"));
  els.pinChangeBtn.addEventListener("click", () => openPinDialog("change"));
  els.pinDisableBtn.addEventListener("click", () => openPinDialog("disable"));
  els.pinForm.addEventListener("submit", onPinSubmit);

  els.confirmCancel.addEventListener("click", () => els.confirmDialog.close("cancel"));
  els.confirmInput.addEventListener("input", () => {
    els.confirmOk.disabled = els.confirmInput.value.trim().toUpperCase() !== confirmRequired;
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close("cancel"); }); // clique no fundo escuro
    dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close("cancel")));
  });

  /* --- bloqueio --- */
  els.lockForm.addEventListener("submit", onUnlockSubmit);
  els.forgotPin.addEventListener("click", forgotPin);

  /* --- atalhos globais --- */
  document.addEventListener("keydown", onGlobalKeydown);

  /* --- segurança dos dados ao sair da aba --- */
  document.addEventListener("visibilitychange", () => { if (document.hidden && state.data) flushEdits(); });
  window.addEventListener("pagehide", () => { if (state.data) flushEdits(); });
}

function isTyping(target) {
  return target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
}
function focusSearch() {
  if (isMobile()) setPane("list");
  els.searchInput.focus();
  els.searchInput.select();
}

function onGlobalKeydown(e) {
  if (!state.data || document.querySelector("dialog[open]")) return; // bloqueado ou com diálogo aberto
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && key === "s") { e.preventDefault(); manualSave(); return; }
  if (mod && key === "f") { e.preventDefault(); focusSearch(); return; }
  // Alguns navegadores reservam Ctrl+N (nova janela) e ignoram preventDefault; Alt+N sempre funciona.
  if ((mod && key === "n" && !e.shiftKey) || (e.altKey && e.code === "KeyN")) { e.preventDefault(); newNote(); return; }
  if (key === "/" && !mod && !isTyping(e.target)) { e.preventDefault(); focusSearch(); return; }

  if (e.key === "Escape") {
    if (e.target === els.searchInput) {
      if (els.searchInput.value) els.clearSearch.click(); else els.searchInput.blur();
      return;
    }
    if (state.ui.view !== "dashboard") closeMain();
  }
}

async function manualSave() {
  const ok = await commit();
  if (ok) toast("Notas salvas.", { duration: 1600 });
}

/* ============================================================
 * 10. INICIALIZAÇÃO
 * ============================================================ */

function startApp() {
  els.lockScreen.hidden = true;
  els.app.inert = false;
  fillCategorySelects();
  Object.assign(state.ui, { scope: "all", category: "all", tags: [], query: "", activeId: null });
  els.searchInput.value = "";
  els.searchBox.dataset.filled = "false";
  els.filters.open = !isMobile();
  dirty = false;
  setSaveState("saved");
  refreshSecurityUI();
  showView("dashboard");
  setPane("list");
  renderAll();
  housekeeping();
}

function boot() {
  document.querySelectorAll("[id]").forEach((el) => { els[el.id] = el; });
  document.execCommand("defaultParagraphSeparator", false, "div"); // "p" faz o Chrome aninhar <p> dentro de <p>
  buildHighlightPicker();
  loadPrefs();
  applyTheme();
  bindEvents();

  if (hasVault()) { showLock(); return; }
  state.data = loadPlainData();
  startApp();
}

boot();
})();
