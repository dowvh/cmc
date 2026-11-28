"use strict";
(() => {

/* =========================================================
   1. CONFIGURAÇÃO — edite só este bloco
   ========================================================= */
const CONFIG = {
  capas: "capas/",
  legendas: "legendas/",
  // Servidor do Render (só para filmes que ainda usam "drive"). Deixe "" quando migrar o último.
  mediaBase: "https://cmc-3ke1.onrender.com",
  // Servidor de vídeos do seu PC (Caddy + Tailscale Funnel + cn-auth.js).
  // Nenhum segredo fica neste arquivo: o site pede ao servidor um link assinado e temporário (ver assinar()).
  tsHost: "desktop-g2jklud.taile9cab4.ts.net",
  // Link da planilha publicada (https://docs.google.com/...). "" = usa só catalogo.js.
  // Colunas: id, titulo, genero, ano, minutos, idade, cor, sinopse, capa, legenda, drive, video
  // Colunas opcionais para filme em duas partes: video2, drive2, legenda2
  // Colunas opcionais de diretor e 720p: diretor, video720, drive720 (e video2_720, drive2_720 para a Parte 2)
  planilha: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTZSLOiscliA71tkQolLK0tbhHi5HAM7sIikyf9-zmk2DS9xa7Q1IyNJ2W34xXDirwGylclVWgRAzuJ/pub?gid=1090910520&single=true&output=csv"
};

const CONTROLS_DELAY = 3000;   // ms até esconder os controles do player
const SEEK_TIMEOUT = 8000;     // ms até desistir de um "avançar" que não completou
const SPEEDS = [1, 1.25, 1.5, 2, .75];
const SUBSZ = [["Pequena", .75], ["Média", 1], ["Grande", 1.35], ["Extra grande", 1.8]];
const DRIVE_ID = /^[A-Za-z0-9_-]{15,80}$/;
const MEDIA = (() => {
  try { const u = new URL(CONFIG.mediaBase); return u.protocol === "https:" ? u.origin : ""; }
  catch { return ""; }
})();

/* =========================================================
   2. UTILITÁRIOS
   ========================================================= */
const $ = s => document.querySelector(s);
const E = Object.fromEntries([...document.querySelectorAll("[id]")].map(n => [n.id, n]));

const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = s => norm(s).replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
const dur = m => m < 60 ? m + "min" : Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "min";
const idade = a => a === "L" ? "Livre" : a + " anos";
const hueOf = t => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const decadeNum = d => +d.match(/\d+/)[0];
const fmt = s => {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = String(s % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + r : m + ":" + r;
};

/* --- Validação de endereços (só https ou caminhos relativos simples) --- */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function httpsUrl(u) {
  try {
    const x = new URL(String(u ?? "").trim());
    return x.protocol === "https:" && !x.username && !x.password ? x.href : "";
  } catch { return ""; }
}

// Devolve os segmentos já codificados ou null se o caminho for suspeito (esquema, "//", "..", controle).
function pathSegs(p) {
  p = String(p ?? "").trim().replace(/\\/g, "/");
  if (!p || p.startsWith("//") || SCHEME.test(p) || /[\u0000-\u001f]/.test(p)) return null;
  const segs = p.split("/").filter(Boolean);
  if (!segs.length || segs.some(s => s === "." || s === "..")) return null;
  return segs.map(s => { try { return encodeURIComponent(decodeURIComponent(s)); } catch { return encodeURIComponent(s); } });
}

function relUrl(dir, p) {
  p = String(p ?? "").trim();
  if (p.startsWith(dir)) p = p.slice(dir.length);
  const segs = pathSegs(p);
  return segs ? dir + segs.join("/") : "";
}

// Link https completo OU nome de arquivo no servidor do seu PC.
function videoUrl(v) {
  v = String(v ?? "").trim();
  if (!v) return "";
  if (SCHEME.test(v)) return httpsUrl(v);
  const segs = pathSegs(v);
  return segs ? "https://" + CONFIG.tsHost + "/" + segs.join("/") : "";
}

const extrairDriveId = u => {
  u = String(u ?? "").trim();
  const m = u.match(/\/d\/([-\w]+)|[?&]id=([-\w]+)/);
  return m ? (m[1] || m[2]) : u;
};

/* =========================================================
   3. ARMAZENAMENTO LOCAL (progresso, lista, preferências)
   ========================================================= */
const K = { prog: "cn-prog-v2", favs: "cn-favs-v2", likes: "cn-likes-v2", sub: "cn-sub", subsz: "cn-subsz", q: "cn-q", legProg: "cn-prog", legFavs: "cn-favs" };

const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado / cheio */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignora */ } }
};

const progValido = v => v && typeof v === "object" && Number.isFinite(v.t) && Number.isFinite(v.d) && v.d > 0 && v.t >= 0;

// p = parte salva (0 ou 1). Filmes sem partes ficam sempre com p = 0.
function limparProg(obj) {
  const out = Object.create(null);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (progValido(v)) out[k] = { t: v.t, d: v.d, u: Number.isFinite(v.u) ? v.u : 0, p: Number.isInteger(v.p) && v.p >= 0 && v.p < 2 ? v.p : 0 };
    }
  }
  return out;
}
const limparFavs = arr => new Set(Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x.length <= 100) : []);

// Chaves = id estável do filme (ver atribuirChaves), nunca o índice nem o título.
let favs = limparFavs(store.get(K.favs, []));
let likes = limparFavs(store.get(K.likes, []));
let prog = limparProg(store.get(K.prog, {}));
const saveFavs = () => store.set(K.favs, [...favs]);
const saveLikes = () => store.set(K.likes, [...likes]);
const saveProg = () => store.set(K.prog, prog);

// Parte salva (0 ou 1). Filmes sem partes sempre devolvem 0.
const partOf = o => { const p = prog[o.key]; return p && o.parts.length ? Math.min(p.p | 0, o.parts.length - 1) : 0; };
// Fonte de vídeo/legenda: a parte n (se o filme tem partes) ou o próprio filme.
const fonte = (o, n) => o.parts.length ? (o.parts[n] || o.parts[0]) : o;
// Progresso total: com partes, cada uma vale uma fração igual.
const pct = o => {
  const p = prog[o.key];
  if (!p || !p.d) return 0;
  const f = Math.min(1, p.t / p.d), n = o.parts.length;
  return n > 1 ? Math.min(1, (partOf(o) + f) / n) : f;
};
const inProgress = o => { const p = pct(o); return p > .02 && p < .95; };
const watched = o => pct(o) >= .95;

const subPref = () => store.get(K.sub, 1) !== 0;
// Qualidade preferida (1080 é o padrão). Só vale nos filmes/partes que tiverem 720p cadastrado.
let quality = store.get(K.q, 1080) === 720 ? 720 : 1080;
let szi = (() => { const r = store.get(K.subsz, 1); return Number.isInteger(r) && SUBSZ[r] ? r : 1; })();

/* =========================================================
   4. CATÁLOGO: normalização, chaves estáveis, migração
   ========================================================= */
let M = [];
let byKey = new Map();
const MAXPARTES = 2;
const MAXDIR = 4;

// Diretores: separados por vírgula, ponto e vírgula ou "|" (máx. 4, sem repetir).
const listaDiretores = v => [...new Set(String(v ?? "").split(/[;,|]/).map(s => s.trim().replace(/\s+/g, " ").slice(0, 80)).filter(Boolean))].slice(0, MAXDIR);

// Versão 720p de uma fonte (arquivo no PC / link https / ID do Drive). Vazia se não houver.
function alt720(video, drive) {
  const d = extrairDriveId(drive);
  return { src: videoUrl(video), driveId: DRIVE_ID.test(d) ? d : "" };
}
const has720 = s => !!(s && s.alt720 && (s.alt720.src || s.alt720.driveId));
const hasAny720 = o => o.parts.length ? o.parts.some(has720) : has720(o);
// Pede ao servidor um endereço ASSINADO e temporário para a fonte (PC ou Drive).
// O segredo da assinatura fica só nos servidores; links de outros sites (ex.: archive.org) passam direto.
async function assinar(s) {
  let endpoint, corpo;
  if (s.src) {
    const u = new URL(s.src);
    if (u.hostname !== CONFIG.tsHost) return s.src;
    endpoint = "https://" + CONFIG.tsHost + "/sign";
    corpo = { file: decodeURIComponent(u.pathname.slice(1)) };
  } else if (s.driveId && MEDIA) {
    endpoint = MEDIA + "/sign";
    corpo = { drive: s.driveId };
  } else {
    throw new Error("sem fonte");
  }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo), cache: "no-store", signal: ctl.signal
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const url = httpsUrl((await r.json()).url);
    // Só aceita link do mesmo servidor que assinou.
    if (!url || new URL(url).origin !== new URL(endpoint).origin) throw new Error("resposta inválida");
    return url;
  } finally {
    clearTimeout(timer);
  }
}

// Uma parte. Na planilha as chaves sempre existem (podem estar vazias).
// No catalogo.js, se "video"/"legenda" nem existir, usa o nome padrão <id>-p1.mp4 etc.
function normalizarParte(p, base, n) {
  p = p && typeof p === "object" ? p : {};
  const tem = k => Object.prototype.hasOwnProperty.call(p, k);
  const drive = extrairDriveId(p.drive);
  const video = tem("video") ? p.video : (drive ? "" : base + "-p" + (n + 1) + ".mp4");
  const legenda = tem("legenda") ? p.legenda : base + "-p" + (n + 1) + "-pt.vtt";
  const subtitles = [];
  const leg = relUrl(CONFIG.legendas, legenda);
  if (leg) subtitles.push({ src: leg, lang: "pt-BR", label: "Português" });
  return { src: videoUrl(video), driveId: DRIVE_ID.test(drive) ? drive : "", subtitles, alt720: alt720(p.video720, p.drive720) };
}

// Converte qualquer item (catalogo.js ou planilha) no formato interno, validando todos os links.
function normalizar(r) {
  const t = String(r.t ?? "").trim();
  if (!t) return null;
  const y = Math.round(Number(r.y)), m = Math.round(Number(r.m));
  const a = String(r.a ?? "").trim(), h = Number(r.h), x = String(r.x ?? "").trim();
  const capa = String(r.capa ?? "").trim();
  const drive = extrairDriveId(r.drive);
  const o = {
    id: String(r.id ?? "").trim(),
    t,
    g: String(r.g ?? "").trim(),
    y: y > 0 ? y : "",
    m: m > 0 ? m : 100,
    a: /^l(ivre)?$/i.test(a) ? "L" : /^\d{1,2}$/.test(a) ? a : "12",
    h: Number.isFinite(h) ? h : 0,
    x: /^\d{1,3}(\.\d+)?%$/.test(x) ? x : "70%",
    p: String(r.p ?? "").trim(),
    img: SCHEME.test(capa) ? httpsUrl(capa) : relUrl(CONFIG.capas, capa),
    src: videoUrl(r.video),
    driveId: DRIVE_ID.test(drive) ? drive : "",
    alt720: alt720(r.video720, r.drive720),
    dirs: listaDiretores(r.dir),
    subtitles: [],
    parts: []
  };
  // Legendas: só caminhos relativos (arquivos de outro site exigiriam CORS e quebrariam no <track>).
  const leg = relUrl(CONFIG.legendas, r.legenda);
  if (leg) o.subtitles.push({ src: leg, lang: "pt-BR", label: "Português" });

  // Partes (opcional): só existe se o filme pedir explicitamente (planilha: video2/drive2).
  const base = slug(o.id) || slug(t) || "filme";
  const pr = r.partes === 2 || r.partes === true ? [{}, {}] : r.partes;
  if (Array.isArray(pr) && pr.length >= 2) {
    o.parts = pr.slice(0, MAXPARTES).map((p, n) => normalizarParte(p, base, n));
    o.subtitles = o.parts.flatMap(p => p.subtitles);   // só para exibir em "Detalhes"
  }
  return o;
}

// Chave estável: id explícito, senão slug do título; se repetir, acrescenta o ano.
function atribuirChaves(lista) {
  const usadas = new Set();
  for (const o of lista) {
    const base = slug(o.id) || slug(o.t) || "filme";
    let k = base;
    if (usadas.has(k) && o.y) k = base + "-" + o.y;
    for (let n = 2; usadas.has(k); n++) k = base + "-" + n;
    usadas.add(k);
    o.key = k;
  }
}

function setCatalogo(lista) {
  atribuirChaves(lista);
  M = lista;
  byKey = new Map(lista.map(o => [o.key, o]));
}

// Traz para o formato novo o que foi salvo antes (progresso por título, lista por índice).
function migrarLegado() {
  const velho = store.get(K.legProg, null);
  if (velho && typeof velho === "object" && !Array.isArray(velho)) {
    let sobrou = false;
    for (const [titulo, v] of Object.entries(velho)) {
      const o = M.find(x => x.t === titulo);
      if (!o) { sobrou = true; continue; }
      if (!prog[o.key] && progValido(v)) prog[o.key] = { t: v.t, d: v.d, u: Number.isFinite(v.u) ? v.u : 0, p: 0 };
      delete velho[titulo];
    }
    saveProg();
    if (sobrou) store.set(K.legProg, velho); else store.del(K.legProg);
  }
  const velhosFavs = store.get(K.legFavs, null);
  if (Array.isArray(velhosFavs)) {
    velhosFavs.forEach(i => { const o = M[+i]; if (o) favs.add(o.key); });
    saveFavs();
    store.del(K.legFavs);
  }
}

const decadeOf = o => {
  const y = Number(o.y);
  return Number.isFinite(y) && y > 0 ? "Década de " + (Math.floor(y / 10) * 10) : "";
};

/* =========================================================
   5. ÍCONES
   ========================================================= */
const svgS = (p, n) => '<svg viewBox="0 0 24 24" width="' + n + '" height="' + n + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
const IC = {
  playFill: n => '<svg viewBox="0 0 24 24" width="' + n + '" height="' + n + '" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pauseFill: n => '<svg viewBox="0 0 24 24" width="' + n + '" height="' + n + '" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="38" height="38" aria-hidden="true"><path d="M7 4v16l13-8z" fill="currentColor"/></svg>',
  pause: svgS('<path d="M8 4v16M16 4v16" stroke-width="1.9"/>', 38),
  vol: svgS('<path d="M3 9.5v5h4l5 4v-13l-5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>', 28),
  mute: svgS('<path d="M3 9.5v5h4l5 4v-13l-5 4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>', 28),
  fs: svgS('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>', 28),
  heart: '<svg class="heart" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.4-9.4A5.2 5.2 0 0 1 12 6.4a5.2 5.2 0 0 1 9.4 4.7C19.5 15.9 12 20.5 12 20.5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  thumb: '<svg class="thumb" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>'
};
function setIcon(el, id, html) {
  if (el.dataset.i !== id) { el.dataset.i = id; el.innerHTML = html; }
}

/* =========================================================
   6. RENDERIZAÇÃO (destaque, faixas, grade, detalhes, menu lateral)
   ========================================================= */
let filter = "Todos", q = "", sortBy = "", hi = 0, heroTimer = null;
let detailKey = "", dtab = "like", homeScroll = 0;   // página de detalhes do filme
const SORTS = {
  az: (a, b) => a.t.localeCompare(b.t),
  new: (a, b) => (+b.y || 0) - (+a.y || 0),
  old: (a, b) => (+a.y || 0) - (+b.y || 0),
  short: (a, b) => a.m - b.m
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const sty = o => "--h:" + (+o.h || 0) + ";--x:" + String(o.x).replace(/[^0-9.%]/g, "") +
  (o.img ? ";--img:url('" + o.img.replace(/['()]/g, c => "%" + c.charCodeAt(0).toString(16)) + "')" : "");

const meta = o => (o.y ? "<span>" + esc(o.y) + "</span>" : "") + "<span>" + dur(o.m) + "</span>" +
  (o.g ? "<span>" + esc(o.g) + "</span>" : "") + "<span>" + esc(idade(o.a)) + "</span>";

function renderHero() {
  const L = M.slice(0, 6);
  E.hero.hidden = !!(filter !== "Todos" || q) || !L.length || !!detailKey;
  if (E.hero.hidden) return;
  const n = hi % L.length, o = L[n], f = favs.has(o.key), k = esc(o.key);
  E.hero.style.cssText = sty(o);
  E.hero.innerHTML = '<div class="hero-art"></div><div class="hero-body"><h1>' + esc(o.t) + '</h1><div class="meta">' + meta(o) + '</div><p>' + esc(o.p) +
    '</p><div class="actions"><button class="watch" data-open="' + k + '" aria-label="' + (inProgress(o) ? "Continuar" : "Assistir") + " " + esc(o.t) + '">' + IC.playFill(22) + (inProgress(o) ? "Continuar" : "Assistir") +
    '</button><button class="plus" data-fav="' + k + '" aria-pressed="' + f + '" aria-label="' + (f ? "Remover da minha lista" : "Adicionar à minha lista") + '">' + (f ? IC.check : IC.plus) +
    '</button></div></div><div class="dots">' + L.map((_, i) => '<button class="dot' + (i === n ? " on" : "") + '" data-dot="' + i + '" aria-label="Destaque ' + (i + 1) + '"' + (i === n ? ' aria-current="true"' : "") + '></button>').join("") + "</div>";
}

function startHero() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    if (document.hidden || E.hero.hidden || reduceMotion.matches || E.modal.classList.contains("open")) return;
    if (E.hero.matches(":hover,:focus-within")) return;   // não troca enquanto a pessoa interage
    hi = (hi + 1) % Math.min(6, M.length);
    renderHero();
  }, 8000);
}

function cardHTML(o) {
  const p = pct(o), ip = inProgress(o), w = p >= .95, inList = favs.has(o.key), k = esc(o.key);
  const tag = ip ? "Continuar" : w ? "Assistido" : "";
  return '<article class="card"><button class="open" data-open="' + k + '" aria-label="Abrir ' + esc(o.t) + '"><span class="poster' + (o.img ? " has-img" : "") + '" style="' + esc(sty(o)) + '">' +
    (o.img ? "" : "<b>" + esc(o.t) + "</b>") + (ip ? '<span class="prog"><i style="width:' + Math.round(p * 100) + '%"></i></span>' : "") + "</span></button>" +
    (tag ? '<span class="tag">' + tag + "</span>" : "") +
    '<button class="kebab" data-kb aria-label="Opções: ' + esc(o.t) + '" aria-expanded="false">' + IC.dots + "</button>" +
    '<div class="pop" hidden><button data-fav="' + k + '">' + (inList ? "Remover da minha lista" : "Adicionar à minha lista") + "</button>" +
    ((ip || w) ? '<button data-clear="' + k + '">' + (ip ? "Remover de Continuar assistindo" : "Marcar como não assistido") + "</button>" : "") + "</div></article>";
}

function railHTML(k, title, L) {
  return '<section class="row"><h2>' + esc(title) + '</h2><div class="rail-wrap"><button class="arr l" data-arr="-1" aria-label="Anteriores">‹</button><div class="rail" data-k="' + esc(k) + '">' +
    L.map(cardHTML).join("") + '</div><button class="arr r" data-arr="1" aria-label="Próximos">›</button></div></section>';
}

function visible() {
  const L = M.filter(o => (
    filter === "Todos" ||
    (filter === "Minha lista" ? favs.has(o.key) :
      filter.startsWith("Década de ") ? decadeOf(o) === filter : o.g === filter)
  ) && norm(o.t + " " + o.g + " " + o.y + " " + o.dirs.join(" ")).includes(norm(q)));
  if (SORTS[sortBy]) L.sort(SORTS[sortBy]);
  return L;
}

function renderRows() {
  E.rows.hidden = !!detailKey;
  if (detailKey) return;
  const R = E.rows, sc = {};
  R.querySelectorAll(".rail").forEach(r => { sc[r.dataset.k] = r.scrollLeft; });
  const grid = filter !== "Todos" || q;
  R.className = grid ? "pad" : "";
  let h = "";
  if (!M.length) {
    h = '<p class="empty">Nenhum filme cadastrado.</p>';
  } else if (grid) {
    const L = visible();
    const opts = [["", "Ordem padrão"], ["az", "A–Z"], ["new", "Mais recentes"], ["old", "Mais antigos"], ["short", "Mais curtos"]]
      .map(([v, l]) => '<option value="' + v + '"' + (v === sortBy ? " selected" : "") + ">" + l + "</option>").join("");
    const vazio = filter === "Minha lista" && !q
      ? "Sua lista está vazia. Use o menu ⋮ de um filme para adicioná-lo aqui."
      : "Nenhum filme encontrado. Tente outro nome ou escolha outra categoria.";
    h = '<section class="row"><div class="gh"><h2>' + esc(q ? "Resultados para “" + q + "”" : filter) + '<span class="count">' + L.length + (L.length === 1 ? " filme" : " filmes") +
      '</span></h2><select id="sortSel" aria-label="Ordenar filmes">' + opts + "</select></div>" +
      (L.length ? '<div class="gridv">' + L.map(cardHTML).join("") + "</div>" : '<p class="empty">' + vazio + "</p>") + "</section>";
  } else {
    const rows = [];
    const cont = M.filter(inProgress).sort((a, b) => prog[b.key].u - prog[a.key].u);
    if (cont.length) rows.push(["cont", "Continuar assistindo", cont]);
    const mine = M.filter(o => favs.has(o.key));
    if (mine.length) rows.push(["mine", "Minha lista", mine]);
    rows.push(["rec", "Recomendados para você", M]);
    const byG = {};
    M.forEach(o => { if (o.g) (byG[o.g] = byG[o.g] || []).push(o); });
    Object.entries(byG).filter(([, l]) => l.length > 1).sort((a, b) => b[1].length - a[1].length).forEach(([g, l]) => rows.push(["g:" + g, g, l]));
    const curtos = M.filter(o => o.m <= 90);
    if (curtos.length > 1) rows.push(["curtos", "Filmes curtos (até 1h30)", curtos]);
    const dec = {};
    M.forEach(o => { const d = decadeOf(o); if (d) (dec[d] = dec[d] || []).push(o); });
    Object.keys(dec).sort((a, b) => decadeNum(a) - decadeNum(b)).forEach(d => { if (dec[d].length > 1) rows.push(["d:" + d, d, dec[d]]); });
    h = rows.map(r => railHTML(r[0], r[1], r[2])).join("");
  }
  R.innerHTML = h;
  R.querySelectorAll(".rail").forEach(r => { if (sc[r.dataset.k]) r.scrollLeft = sc[r.dataset.k]; });
}

/* --- Página de detalhes (aparece ao clicar num filme, antes do player) --- */

// Filmes parecidos: mesmo diretor primeiro, depois mesmo gênero, depois mesma década, depois o ano mais próximo.
function related(o, n = 12) {
  const y = Number(o.y) || 0, dn = o.dirs.map(norm);
  return M.filter(x => x.key !== o.key)
    .map(x => {
      const xy = Number(x.y) || 0;
      const mesmoDir = dn.length && x.dirs.some(d => dn.includes(norm(d)));
      const score = (mesmoDir ? 3 : 0) + (x.g && x.g === o.g ? 2 : 0) + (y && xy && Math.floor(xy / 10) === Math.floor(y / 10) ? 1 : 0);
      return { x, score, d: y && xy ? Math.abs(xy - y) : 999 };
    })
    .sort((a, b) => b.score - a.score || a.d - b.d)
    .slice(0, n)
    .map(r => r.x);
}

function renderDetail() {
  const o = detailKey ? byKey.get(detailKey) : null;
  if (!o) { detailKey = ""; E.detail.hidden = true; E.detail.innerHTML = ""; return; }

  // O HTML é refeito a cada mudança; guarda o foco para o teclado não se perder.
  const keep = E.detail.contains(document.activeElement) ? document.activeElement.id : "";
  const k = esc(o.key), f = favs.has(o.key), liked = likes.has(o.key), ip = inProgress(o);
  const np = o.parts.length, pa = partOf(o);
  const acao = ip ? (np ? "Continuar Parte " + (pa + 1) : "Continuar") : "Assistir agora";
  const chips = [o.g, decadeOf(o)].filter(Boolean).map(c => "<span>" + esc(c) + "</span>").join("");
  const linha = (l, v) => v ? "<div><dt>" + l + "</dt><dd>" + esc(v) + "</dd></div>" : "";
  const rel = related(o);
  const legs = [...new Set(o.subtitles.map(s => s.label))];
  const dirTxt = o.dirs.join(", ");
  const n720 = np ? o.parts.filter(has720).length : (has720(o) ? 1 : 0);
  const qTxt = !n720 ? "" : (np && n720 < np ? "1080p; 720p só em algumas partes" : "1080p e 720p");

  // Botões "Parte 1 / Parte 2" (só para filmes configurados com partes na planilha).
  const partesHTML = np ? '<div class="dparts" role="group" aria-label="Escolher a parte do filme">' +
    o.parts.map((_, n) => {
      const cont = ip && pa === n;
      return '<button type="button" id="dpart-' + n + '" data-play="' + k + '" data-part="' + n + '" aria-label="' +
        (cont ? "Continuar" : "Assistir") + " Parte " + (n + 1) + ": " + esc(o.t) + '">' + IC.playFill(16) +
        "<span>Parte " + (n + 1) + "</span>" + (cont ? "<small>Continuar</small>" : "") + "</button>";
    }).join("") + "</div>" : "";

  const painel = dtab === "info"
    ? '<dl class="dinfo">' + linha("Título", o.t) + linha("Direção", dirTxt) + linha("Gênero", o.g) + linha("Ano", o.y) + linha("Duração", dur(o.m)) +
      linha("Partes", np ? np + " (Parte 1 e Parte 2)" : "") + linha("Qualidade", qTxt) +
      linha("Classificação", idade(o.a)) + linha("Legendas", legs.length ? legs.join(", ") : "Não disponíveis") +
      linha("Sinopse", o.p) + "</dl>"
    : rel.length ? '<div class="gridv">' + rel.map(cardHTML).join("") + "</div>"
      : '<p class="empty">Não há outros filmes para sugerir.</p>';

  const tab = (id, label) => '<button class="dtab" type="button" role="tab" id="dtab-' + id + '" data-dtab="' + id +
    '" aria-selected="' + (dtab === id) + '" aria-controls="dpanel">' + label + "</button>";

  E.detail.innerHTML =
    '<section class="hero dhero" style="' + esc(sty(o)) + '">' +
      '<button class="dback" id="dback" type="button" data-dback aria-label="Voltar ao catálogo">' + IC.back + "</button>" +
      '<div class="hero-art"></div>' +
      '<div class="hero-body"><h1>' + esc(o.t) + "</h1>" +
        (dirTxt ? '<div class="ddir">Direção: <b>' + esc(dirTxt) + "</b></div>" : "") +
        '<div class="dmeta"><span class="age" data-a="' + esc(o.a) + '" title="Classificação: ' + esc(idade(o.a)) + '">' + esc(o.a) + "</span>" +
          "<span>" + dur(o.m) + "</span>" + (o.y ? "<span>" + esc(o.y) + "</span>" : "") + "</div>" +
        '<button class="watch dwatch" id="dplay" type="button" data-play="' + k + '" aria-label="' + acao + ": " + esc(o.t) + '">' + IC.playFill(22) + acao + "</button>" +
        partesHTML +
        '<div class="dmini">' +
          '<button type="button" id="dfav" data-fav="' + k + '" aria-pressed="' + f + '">' + (f ? IC.check : IC.plus) + "<span>Minha lista</span></button>" +
          '<button type="button" id="drate" data-rate="' + k + '" aria-pressed="' + liked + '">' + IC.thumb + "<span>" + (liked ? "Gostei" : "Avaliar") + "</span></button>" +
        "</div>" +
        '<p class="syn">' + esc(o.p) + "</p>" +
        (chips ? '<div class="chips">' + chips + "</div>" : "") +
      "</div>" +
    "</section>" +
    '<div class="dtabs" role="tablist" aria-label="Mais sobre o filme">' + tab("like", "Você pode gostar também") + tab("info", "Detalhes") + "</div>" +
    '<div class="dpanel" id="dpanel" role="tabpanel" aria-labelledby="dtab-' + dtab + '">' + painel + "</div>";

  E.detail.hidden = false;
  if (keep) { const n = document.getElementById(keep); if (n) n.focus({ preventScroll: true }); }
}

function openDetail(o) {
  if (!o) return;
  if (!detailKey) homeScroll = scrollY;     // lembra onde estava no catálogo
  detailKey = o.key;
  dtab = "like";
  closePops();
  renderAll();
  scrollTo({ top: 0 });
  const b = document.getElementById("dplay");
  if (b) b.focus({ preventScroll: true });
}

function closeDetail() {
  if (!detailKey) return;
  const key = detailKey;
  detailKey = "";
  renderAll();
  scrollTo({ top: homeScroll });
  const card = document.querySelector('.open[data-open="' + CSS.escape(key) + '"]');
  if (card) card.focus({ preventScroll: true });
}

function toggleLike(key) {
  likes.has(key) ? likes.delete(key) : likes.add(key);
  saveLikes();
  renderDetail();
}

function renderDrawer() {
  const genres = [...new Set(M.map(o => o.g).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt"));
  const decades = [...new Set(M.map(decadeOf).filter(Boolean))].sort((a, b) => decadeNum(a) - decadeNum(b));
  const item = (c, l) => {
    const on = c === filter && !q;
    return '<button class="nav' + (on ? " on" : "") + '"' + (on ? ' aria-current="page"' : "") + ' data-c="' + esc(c) + '">' + esc(l || c) + "</button>";
  };
  E.drawer.innerHTML = '<button class="x2" data-dclose aria-label="Fechar menu">×</button><nav aria-label="Categorias">' +
    item("Todos", "Início") + item("Minha lista") + '<button class="nav" data-rand>Sortear um filme</button>' +
    "<h3>Gêneros</h3>" + genres.map(g => item(g)).join("") + "<h3>Décadas</h3>" + decades.map(d => item(d)).join("") + "</nav>";
}

function renderAll() { renderDrawer(); renderHero(); renderRows(); renderDetail(); }

/* =========================================================
   7. FOCO, MENU LATERAL, BUSCA, PERFIL E CARTÕES
   ========================================================= */
const BG = ["#top", "#hero", "#rows", "#detail", "footer"];    // áreas desativadas enquanto um painel está aberto
const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
const setInert = (sels, on) => sels.forEach(s => { const n = $(s); if (n) n.inert = on; });

// Mantém o Tab dentro de um painel (menu lateral / player).
function trapTab(e, box) {
  if (e.key !== "Tab") return;
  const items = [...box.querySelectorAll(FOCUSABLE)].filter(n => !n.disabled && n.getClientRects().length);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], act = document.activeElement;
  if (e.shiftKey && (act === first || !box.contains(act))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (act === last || !box.contains(act))) { e.preventDefault(); first.focus(); }
}

let toastTimer = 0;
function toast(msg) {
  E.toast.textContent = msg;
  E.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => E.toast.classList.remove("show"), 3500);
}

/* --- Menu lateral --- */
function openDrawer() {
  E.drawer.classList.add("open");
  E.scrim.hidden = false;
  E.menuBtn.setAttribute("aria-expanded", "true");
  setInert(BG, true);
  (E.drawer.querySelector(".nav.on") || E.drawer.querySelector(".x2")).focus();
}
function closeDrawer() {
  if (!E.drawer.classList.contains("open")) return;
  E.drawer.classList.remove("open");
  E.scrim.hidden = true;
  E.menuBtn.setAttribute("aria-expanded", "false");
  setInert(BG, false);
  E.menuBtn.focus();
}

/* --- Busca e filtros --- */
function closeSearch() {
  E.sbox.classList.remove("open");
  E.searchBtn.setAttribute("aria-expanded", "false");
}
function setFilter(c) {
  filter = c; q = ""; sortBy = "";
  detailKey = "";            // sair da página de detalhes
  E.q.value = "";
  closeSearch();
  renderAll();
  scrollTo({ top: 0 });
}

/* --- Opções de cada cartão (⋮) --- */
function closePops(restoreFocus) {
  document.querySelectorAll(".pop:not([hidden])").forEach(p => {
    p.hidden = true;
    const kb = p.previousElementSibling;
    if (kb) { kb.setAttribute("aria-expanded", "false"); if (restoreFocus) kb.focus(); }
  });
}

/* --- Perfil: exportar / importar / limpar dados locais --- */
function openProfile() {
  const naLista = M.filter(o => favs.has(o.key)).length, andamento = M.filter(inProgress).length;
  E.pinfo.textContent = naLista + " na lista · " + andamento + " em andamento · salvos só neste navegador";
  E.profileMenu.hidden = false;
  E.profileBtn.setAttribute("aria-expanded", "true");
  E.profileMenu.querySelector("[role=menuitem]").focus();
}
function closeProfile(restoreFocus) {
  if (E.profileMenu.hidden) return;
  E.profileMenu.hidden = true;
  E.profileBtn.setAttribute("aria-expanded", "false");
  if (restoreFocus) E.profileBtn.focus();
}

function exportarDados() {
  const dados = { app: "CineNoite", versao: 2, exportadoEm: new Date().toISOString(), lista: [...favs], curtidos: [...likes], progresso: prog };
  const url = URL.createObjectURL(new Blob([JSON.stringify(dados, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cinenoite-dados-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Dados exportados.");
}

async function importarDados(file) {
  try {
    if (file.size > 1e6) throw new Error("arquivo grande demais");
    const d = JSON.parse(await file.text());
    if (!d || d.app !== "CineNoite") throw new Error("formato desconhecido");
    limparFavs(d.lista).forEach(k => favs.add(k));
    limparFavs(d.curtidos).forEach(k => likes.add(k));
    for (const [k, v] of Object.entries(limparProg(d.progresso))) {
      if (!prog[k] || v.u > prog[k].u) prog[k] = v;
    }
    saveFavs(); saveLikes(); saveProg(); renderAll();
    toast("Dados importados.");
  } catch {
    toast("Arquivo inválido. Use um arquivo exportado pelo CineNoite.");
  }
}

const ACOES = {
  export: exportarDados,
  import: () => E.importFile.click(),
  clearProg() {
    if (!confirm("Apagar o progresso de todos os filmes?")) return;
    prog = Object.create(null); saveProg(); renderAll(); toast("Progresso apagado.");
  },
  clearList() {
    if (!confirm("Esvaziar a Minha lista?")) return;
    favs = new Set(); saveFavs(); renderAll(); toast("Lista esvaziada.");
  },
  clearAll() {
    if (!confirm("Apagar progresso, lista e preferências deste navegador?")) return;
    prog = Object.create(null); favs = new Set(); likes = new Set();
    [K.prog, K.favs, K.likes, K.sub, K.subsz, K.q, K.legProg, K.legFavs].forEach(store.del);
    szi = 1; quality = 1080; applySz(); renderAll(); toast("Dados locais apagados.");
  }
};

function toggleFav(key) {
  favs.has(key) ? favs.delete(key) : favs.add(key);
  saveFavs();
  renderAll();
  if (cur && cur.key === key) fillFav();
}

/* --- Eventos de clique (delegação) --- */
document.addEventListener("click", e => {
  const t = e.target;
  const c = t.closest("[data-c]"), o = t.closest("[data-open]"), f = t.closest("[data-fav]");
  const kb = t.closest("[data-kb]"), ar = t.closest("[data-arr]"), dt = t.closest("[data-dot]");
  const rd = t.closest("[data-rand]"), dc = t.closest("[data-dclose]"), cl = t.closest("[data-clear]");
  const pl = t.closest("[data-play]"), rt = t.closest("[data-rate]"), dtb = t.closest("[data-dtab]"), db = t.closest("[data-dback]");
  if (!kb && !t.closest(".pop")) closePops();
  if (!t.closest(".pwrap")) closeProfile();

  if (dc) closeDrawer();
  else if (c) { closeDrawer(); setFilter(c.dataset.c); }
  else if (rd) {
    closeDrawer();
    const pool = M.filter(x => !watched(x));
    const L = pool.length ? pool : M;
    openDetail(L[Math.floor(Math.random() * L.length)]);
  }
  else if (kb) {
    const p = kb.nextElementSibling, abrir = p.hidden;
    closePops();
    if (abrir) { p.hidden = false; kb.setAttribute("aria-expanded", "true"); p.querySelector("button").focus(); }
  }
  else if (cl) { delete prog[cl.dataset.clear]; saveProg(); renderAll(); }
  else if (f) toggleFav(f.dataset.fav);
  else if (ar) {
    const r = ar.parentElement.querySelector(".rail");
    r.scrollBy({ left: ar.dataset.arr * r.clientWidth * .85, behavior: "smooth" });
  }
  else if (dt) { hi = +dt.dataset.dot; renderHero(); startHero(); }
  // Botão "Assistir agora" (sem parte) ou "Parte N" da página de detalhes.
  else if (pl) openMovie(byKey.get(pl.dataset.play), pl.dataset.part === undefined ? undefined : +pl.dataset.part);
  else if (rt) toggleLike(rt.dataset.rate);
  else if (dtb) { dtab = dtb.dataset.dtab; renderDetail(); }
  else if (db) closeDetail();
  else if (o) { openDetail(byKey.get(o.dataset.open)); }   // clicar num filme abre os detalhes, não o player
});

document.addEventListener("change", e => {
  if (e.target.id === "sortSel") { sortBy = e.target.value; renderRows(); }
});

// Se o foco sair do menu do perfil por teclado, ele fecha.
document.addEventListener("focusin", e => {
  if (!E.profileMenu.hidden && !e.target.closest(".pwrap")) closeProfile();
});

E.menuBtn.onclick = openDrawer;
E.logo.onclick = () => setFilter("Todos");
E.listBtn.onclick = () => setFilter("Minha lista");
E.searchBtn.onclick = () => {
  const open = E.sbox.classList.toggle("open");
  E.searchBtn.setAttribute("aria-expanded", String(open));
  if (open) E.q.focus(); else { E.q.value = ""; q = ""; renderAll(); }
};
E.q.addEventListener("input", e => { q = e.target.value; detailKey = ""; renderAll(); });
E.q.addEventListener("keydown", e => {
  if (e.key === "Escape") { E.q.value = ""; q = ""; closeSearch(); renderAll(); E.searchBtn.focus(); }
});

E.profileBtn.onclick = () => E.profileMenu.hidden ? openProfile() : closeProfile(true);
E.profileMenu.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  closeProfile(true);
  ACOES[b.dataset.act]?.();
});
E.profileMenu.addEventListener("keydown", e => {
  const items = [...E.profileMenu.querySelectorAll("[role=menuitem]")], i = items.indexOf(document.activeElement);
  const go = n => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
});
E.importFile.addEventListener("change", () => {
  const file = E.importFile.files[0];
  E.importFile.value = "";
  if (file) importarDados(file);
});

addEventListener("scroll", () => E.top.classList.toggle("solid", scrollY > 40), { passive: true });

/* =========================================================
   8. PLAYER
   ========================================================= */
let cur = null, vid = null, playing = false, pos = 0, lastFocus = null, lastSave = 0, subTrack = null, curPart = 0, curQ = 1080, lastAuto = 0;
let controlsTimer = 0, seekWatch = 0, isSeeking = false, seekPointerId = null, pendingSeekTime = null;

/* --- Controles visíveis / escondidos --- */
function showControls() {
  clearTimeout(controlsTimer);
  E.screen.classList.remove("controls-hidden");
  // Não esconde enquanto o foco estiver nos controles via teclado.
  if (vid && !vid.paused && !vid.ended && !isSeeking && !E.screen.querySelector(":focus-visible")) {
    controlsTimer = setTimeout(() => E.screen.classList.add("controls-hidden"), CONTROLS_DELAY);
  }
}
function keepControlsVisible() {
  clearTimeout(controlsTimer);
  E.screen.classList.remove("controls-hidden");
}

// Zera tudo que poderia deixar a interface "presa" (arraste, seek pendente, timers).
function resetTransient() {
  clearTimeout(controlsTimer);
  clearTimeout(seekWatch);
  isSeeking = false;
  pendingSeekTime = null;
  seekPointerId = null;
}

/* --- Mensagem de status (texto puro, com link/botão opcionais) --- */
function setStatus(msg, opts = {}) {
  const s = E.status;
  s.textContent = "";
  if (!msg) return;
  s.append(msg);
  if (opts.link && /^https:/i.test(opts.link)) {
    const a = document.createElement("a");
    a.href = opts.link; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "Abrir o vídeo direto";
    s.append(" ", a);
  }
  if (opts.retry) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = "Tentar novamente";
    b.onclick = retryVideo;
    s.append(" ", b);
  }
}

function mostrarErro(v) {
  const code = v.error && v.error.code;
  const detalhe = code === 2 ? "A conexão foi interrompida." :
    code === 3 ? "O navegador não conseguiu decodificar este arquivo (formato ou codec)." :
    code === 4 ? "Não achei o vídeo neste endereço, ele está bloqueado, a autorização expirou ou o formato não é compatível." :
    "O servidor não conseguiu entregar o vídeo.";
  const dica = curQ === 720 ? " Se o 720p não existir, volte para 1080p no botão de qualidade." : "";
  const link = v.currentSrc || v.src || "";
  let host = "";
  try { host = new URL(link).hostname; } catch { /* sem host */ }
  // Não mostra o endereço assinado na tela (nem no console, sem a assinatura).
  setStatus(detalhe + dica + " (código " + (code || "?") + (host ? ", servidor " + host : "") + ")", { retry: true });
  console.warn("Erro no vídeo:", cur && cur.t, "código", code, link.split("?")[0]);
}

/* --- Progresso salvo (guarda também a parte atual) --- */
function saveNow() {
  if (!vid || !cur || !Number.isFinite(vid.duration) || vid.duration <= 0) return;
  const prev = prog[cur.key];
  // Nos primeiros 5 s não sobrescreve o progresso salvo de outra parte (nem cria progresso novo).
  if (vid.currentTime < 5 && (!prev || (prev.p | 0) !== curPart)) return;
  prog[cur.key] = { t: vid.currentTime, d: vid.duration, u: Date.now(), p: curPart };
  saveProg();
}
addEventListener("pagehide", saveNow);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });

/* --- Interface do player --- */
function ui() {
  if (!cur) return;
  const dok = vid && Number.isFinite(vid.duration) && vid.duration > 0;
  // Durante o arraste/seek, o timeupdate não pode devolver a barra para a posição antiga.
  if (dok && !isSeeking && pendingSeekTime === null) pos = vid.currentTime / vid.duration;
  const total = dok ? vid.duration : cur.m * 60;
  E.fill.style.width = (pos * 100) + "%";
  E.time.textContent = "-" + fmt(Math.max(0, total - pos * total));
  E.track.setAttribute("aria-valuenow", String(Math.round(pos * 100)));
  E.track.setAttribute("aria-valuetext", fmt(pos * total) + " de " + fmt(total));

  const muted = !!(vid && vid.muted);
  setIcon(E.mute, muted ? "m" : "v", muted ? IC.mute : IC.vol);
  E.mute.setAttribute("aria-pressed", String(muted));
  E.mute.setAttribute("aria-label", muted ? "Ativar som" : "Desativar som");

  setIcon(E.big, playing ? "p" : "r", playing ? IC.pauseFill(26) : IC.playFill(26));
  setIcon(E.pp, playing ? "p" : "r", playing ? IC.pause : IC.play);
  const lbl = playing ? "Pausar" : "Reproduzir";
  E.pp.setAttribute("aria-label", lbl);
  E.big.setAttribute("aria-label", lbl);
  E.screen.classList.toggle("playing", playing);
}

function setPlay(on) {
  if (!vid) return;
  if (!on) { delete vid.dataset.want; vid.pause(); return; }
  const player = vid;
  // Ainda aguardando o endereço assinado: toca assim que ele chegar.
  if (!player.getAttribute("src")) { player.dataset.want = "1"; return; }
  const p = player.play();
  if (p && p.catch) p.catch(err => {
    if (vid !== player) return;
    if (player.error) mostrarErro(player);
    else setStatus("Não foi possível iniciar a reprodução.", { retry: true });
    console.warn("Falha ao iniciar reprodução:", err);
  });
}

function skip(s) {
  if (!vid || !Number.isFinite(vid.duration)) return;
  vid.currentTime = Math.max(0, Math.min(vid.duration, vid.currentTime + s));
}

function fillFav() {
  const f = favs.has(cur.key);
  E.mf.setAttribute("aria-pressed", String(f));
  E.mf.innerHTML = IC.heart + (f ? "Na minha lista" : "Minha lista");
}

/* --- Legendas (desenhadas pelo site; o navegador só carrega o arquivo) --- */
function renderSubs() {
  E.subs.textContent = "";
  if (!subTrack) return;
  Array.from(subTrack.activeCues || []).forEach(c => {
    const d = document.createElement("div"), sp = document.createElement("span");
    sp.className = "sl";
    sp.appendChild(c.getCueAsHTML ? c.getCueAsHTML() : document.createTextNode(c.text));
    d.appendChild(sp);
    E.subs.appendChild(d);
  });
}
function useSub(i) {
  if (subTrack) subTrack.oncuechange = null;
  subTrack = null;
  if (vid) {
    const trs = Array.from(vid.querySelectorAll("track")).map(t => t.track);
    trs.forEach((t, k) => { t.mode = k === i ? "hidden" : "disabled"; });
    if (i >= 0 && trs[i]) { subTrack = trs[i]; subTrack.oncuechange = renderSubs; }
  }
  E.subtitle.value = String(i);
  renderSubs();
}

const applySz = () => document.documentElement.style.setProperty("--subsz", SUBSZ[szi][1]);

/* --- Tela cheia --- */
function toggleFs() {
  const el = E.screen;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen();
  else if (vid && vid.webkitEnterFullscreen) {
    // iPhone: só o player nativo entra em tela cheia.
    const tk = subTrack;
    if (tk) { tk.mode = "showing"; vid.addEventListener("webkitendfullscreen", () => { if (subTrack === tk) tk.mode = "hidden"; }, { once: true }); }
    vid.webkitEnterFullscreen();
  }
}

/* --- Carregar / descarregar o <video> --- */
function unloadVideo() {
  const old = vid;
  vid = null;
  useSub(-1);
  if (!old) return;
  old.pause();
  old.removeAttribute("src");
  old.querySelectorAll("source,track").forEach(n => n.remove());
  try { old.load(); } catch { /* ignora */ }
  old.remove();
}

// Título "Filme · Parte N" e botões Parte 1/2 do player (só aparecem em filmes com partes).
function syncParts() {
  const n = cur ? cur.parts.length : 0;
  E.mt.textContent = cur ? cur.t + (n ? " · Parte " + (curPart + 1) : "") : "";
  E.pseg.hidden = !n;
  E.pseg.querySelectorAll("[data-pt]").forEach(b => {
    const i = +b.dataset.pt;
    b.hidden = i >= n;
    b.setAttribute("aria-pressed", String(i === curPart));
  });
}

// Botão de qualidade (1080p/720p): só aparece se o filme tiver 720p em alguma parte.
function syncQuality() {
  const any = !!cur && hasAny720(cur);
  E.qual.hidden = !any;
  if (!any) return;
  const ok = has720(fonte(cur, curPart));
  E.qual.textContent = curQ + "p";
  E.qual.disabled = !ok;
  const label = ok ? "Qualidade: " + curQ + "p. Alternar para " + (curQ === 720 ? 1080 : 720) + "p"
    : "Qualidade: 1080p. O 720p não está disponível" + (cur.parts.length ? " nesta parte" : "");
  E.qual.setAttribute("aria-label", label);
  E.qual.title = label;
}

// msg (opcional): texto de status depois de carregar (ex.: "Qualidade: 720p").
function loadVideo(o, resumeAt, msg) {
  unloadVideo();
  resetTransient();
  playing = false;
  pos = 0;
  syncParts();
  E.mr.textContent = o.parts.length ? "Recomeçar a parte" : "Recomeçar do início";
  keepControlsVisible();
  setStatus("");
  E.spd.textContent = "1×";
  E.subtitle.hidden = E.subsz.hidden = true;
  E.subtitle.innerHTML = '<option value="-1">Legendas: desligadas</option>';

  // Arquivo direto (com token se for do seu PC) ou vídeo do Drive via Render. Com partes, usa a parte atual.
  const fo = fonte(o, curPart);
  const use720 = quality === 720 && has720(fo);      // 720p só se esta parte tiver
  const base = use720 ? fo.alt720 : fo;
  curQ = use720 ? 720 : 1080;
  syncQuality();
  if (!(base.src || (base.driveId && MEDIA))) {
    setStatus(base.driveId && !MEDIA ? "Este filme depende do servidor do Drive, que não está configurado."
      : o.parts.length ? "Esta parte ainda não está disponível." : "Este filme ainda não está disponível.");
    E.mr.hidden = true;
    ui();
    return;
  }

  // Retoma de onde parou (3 s antes), mas só se a parte salva for a que está abrindo.
  const sp = prog[o.key];
  const startAt = resumeAt != null ? resumeAt : (sp && inProgress(o) && partOf(o) === curPart ? Math.max(0, sp.t - 3) : 0);
  E.mr.hidden = !startAt;

  const v = document.createElement("video");
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.preload = "metadata";
  v.controls = false;

  const subs = fo.subtitles || [];
  subs.forEach((sub, i) => {
    const tr = document.createElement("track");
    tr.kind = "subtitles"; tr.src = sub.src; tr.srclang = sub.lang; tr.label = sub.label;
    const op = document.createElement("option");
    op.value = String(i); op.textContent = sub.label;
    tr.addEventListener("error", () => {
      if (vid !== v) return;
      op.disabled = true;
      op.textContent = sub.label + " (indisponível)";
      if (E.subtitle.value === String(i)) useSub(-1);
      setStatus("Não foi possível carregar a legenda “" + sub.label + "”. O filme continua sem legenda.");
    });
    v.appendChild(tr);
    E.subtitle.appendChild(op);
  });
  if (subs.length) E.subtitle.hidden = E.subsz.hidden = false;

  v.addEventListener("play", () => { if (vid !== v) return; playing = true; ui(); showControls(); });
  v.addEventListener("pause", () => { if (vid !== v) return; playing = false; saveNow(); ui(); keepControlsVisible(); });
  v.addEventListener("ended", () => {
    if (vid !== v) return;
    playing = false; resetTransient(); saveNow(); ui(); keepControlsVisible();
    // Fim da Parte 1: segue sozinho para a Parte 2.
    if (cur.parts.length && curPart < cur.parts.length - 1) avancarParte();
  });
  v.addEventListener("timeupdate", () => {
    if (vid !== v) return;
    ui();
    if (playing && Date.now() - lastSave > 5000) { lastSave = Date.now(); saveNow(); }
  });
  v.addEventListener("seeking", () => { if (vid === v && pendingSeekTime !== null) ui(); });
  v.addEventListener("seeked", () => { if (vid !== v) return; clearTimeout(seekWatch); pendingSeekTime = null; ui(); });
  v.addEventListener("durationchange", () => { if (vid === v) ui(); });
  v.addEventListener("loadedmetadata", () => {
    if (vid !== v) return;
    setStatus("");
    if (startAt > 0) {
      try { v.currentTime = Math.min(startAt, Math.max(0, v.duration - 1)); } catch { /* ignora */ }
      setStatus(msg || (o.parts.length ? "Retomando a Parte " + (curPart + 1) + " em " + fmt(startAt) + "…" : "Retomando de " + fmt(startAt) + "…"));
    } else if (msg) setStatus(msg);
    ui();
  });
  v.addEventListener("error", () => {
    if (vid !== v) return;
    const eraTocando = playing;
    playing = false;
    resetTransient();
    ui();
    keepControlsVisible();
    // Link assinado expirou no meio do filme: pede outro e continua de onde parou (no máx. 1x a cada 2 min).
    if (eraTocando && v.currentTime > 1 && Date.now() - lastAuto > 120000) { lastAuto = Date.now(); retryVideo(); return; }
    mostrarErro(v);
  });
  v.addEventListener("waiting", () => { if (vid === v) setStatus("Carregando vídeo…"); });
  v.addEventListener("playing", () => { if (vid === v) setStatus(""); });
  v.addEventListener("canplay", () => { if (vid === v && v.paused) setStatus("Pronto para reproduzir."); });
  v.addEventListener("stalled", () => {
    if (vid === v && pendingSeekTime !== null) setStatus("Aguardando o servidor entregar o trecho solicitado...");
  });
  v.addEventListener("volumechange", () => { if (vid === v) ui(); });
  v.addEventListener("ratechange", () => { if (vid === v) E.spd.textContent = (+v.playbackRate.toFixed(2)) + "×"; });

  v.addEventListener("contextmenu", e => e.preventDefault());   // sem "Salvar vídeo como" (só dificulta; não é proteção real)

  // Um toque pausa/continua; dois toques: laterais pulam 10 s, centro abre tela cheia.
  let clickTimer = 0;
  v.addEventListener("click", () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => setPlay(v.paused), 220);
  });
  v.addEventListener("dblclick", e => {
    clearTimeout(clickTimer);
    const r = v.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    showControls();
    if (x < .33) skip(-10); else if (x > .67) skip(10); else toggleFs();
  });

  E.screen.prepend(v);
  vid = v;
  lastSave = Date.now();
  useSub(subs.length && subPref() ? 0 : -1);
  ui();

  // O vídeo só começa a carregar quando o servidor devolve o endereço assinado.
  setStatus("Preparando o vídeo…");
  assinar(base).then(url => {
    if (vid !== v) return;
    v.src = url;
    if (v.dataset.want) { delete v.dataset.want; setPlay(true); }
  }).catch(err => {
    if (vid !== v) return;
    console.warn("Falha ao obter o link assinado:", err);
    setStatus("Não foi possível obter autorização para este vídeo. O servidor pode estar desligado.", { retry: true });
  });
}

/* --- Trocar de parte dentro do player --- */
function trocarParte(n, auto) {
  if (!cur || !cur.parts.length || n === curPart || n < 0 || n >= cur.parts.length) return;
  if (!auto) saveNow();          // guarda a parte atual antes de sair dela
  curPart = n;
  loadVideo(cur);                // retoma se for a parte salva; senão começa do zero
  setPlay(true);
}

// Fim da Parte 1: deixa o progresso apontando para o início da Parte 2 e segue sozinho.
function avancarParte() {
  const d = vid && Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 1;
  prog[cur.key] = { t: 0, d, u: Date.now(), p: curPart + 1 };
  saveProg();
  trocarParte(curPart + 1, true);
  toast("Continuando na Parte " + (curPart + 1) + ".");
}

// Troca 1080p <-> 720p mantendo o ponto atual e o estado (tocando/pausado).
function trocarQualidade(q) {
  if (!cur || q === curQ) return;
  if (q === 720 && !has720(fonte(cur, curPart))) return;
  const t = vid && Number.isFinite(vid.currentTime) ? vid.currentTime : undefined;
  const was = !!vid && !vid.paused && !vid.ended;
  saveNow();
  quality = q;
  store.set(K.q, q);
  loadVideo(cur, t, "Qualidade: " + q + "p");
  if (was) setPlay(true);
}

function retryVideo() {
  if (!cur) return;
  const t = vid && Number.isFinite(vid.currentTime) && vid.currentTime > 0 ? Math.max(0, vid.currentTime - 3) : undefined;
  loadVideo(cur, t);
  setPlay(true);
}

/* --- Abrir / fechar o player --- */
function openMovie(o, part) {
  if (!o) return;
  cur = o;
  // Parte pedida; senão, a parte salva (se em andamento); senão, a Parte 1.
  curPart = o.parts.length
    ? (Number.isInteger(part) && part >= 0 && part < o.parts.length ? part : (inProgress(o) ? partOf(o) : 0))
    : 0;
  lastFocus = document.activeElement;
  E.screen.setAttribute("style", sty(o));
  fillFav();
  loadVideo(o);               // também atualiza título e botões de parte
  E.modal.classList.add("open");
  setInert(BG, true);
  E.close.focus();
}

function restoreFocus() {
  const card = cur && document.querySelector('[data-open="' + CSS.escape(cur.key) + '"]');
  // A página de detalhes é refeita ao fechar o player, então o botão antigo já não existe: procura o novo.
  for (const n of [lastFocus, document.getElementById("dplay"), card, E.menuBtn]) {
    if (n && n.isConnected && n.getClientRects().length) { n.focus(); if (document.activeElement === n) return; }
  }
}

function closeMovie() {
  saveNow();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  unloadVideo();
  resetTransient();
  playing = false;
  setStatus("");
  keepControlsVisible();
  E.modal.classList.remove("open");
  setInert(BG, false);
  renderAll();            // atualiza barras de progresso, "Continuar" e a página de detalhes
  restoreFocus();
}

/* --- Barra de progresso (mouse, toque e caneta) --- */
function getSeekFraction(e) {
  const rect = E.track.getBoundingClientRect();
  if (!rect.width) return null;
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
const canSeek = () => vid && Number.isFinite(vid.duration) && vid.duration > 0;

function previewSeek(fraction) {
  if (!canSeek()) return;
  pos = fraction;
  E.fill.style.width = (fraction * 100) + "%";
  E.time.textContent = "-" + fmt(vid.duration * (1 - fraction));
}

function commitSeek(fraction) {
  if (!canSeek()) return;
  const d = vid.duration, target = Math.max(0, Math.min(d, fraction * d));
  pendingSeekTime = target;
  pos = target / d;
  E.fill.style.width = (pos * 100) + "%";
  E.time.textContent = "-" + fmt(d - target);
  setStatus("");
  clearTimeout(seekWatch);
  try {
    vid.currentTime = target;
    if (Math.abs(vid.currentTime - target) < .05 && !vid.seeking) { pendingSeekTime = null; ui(); }
    else {
      // Se o servidor não responder, não deixa a barra presa esperando.
      seekWatch = setTimeout(() => {
        if (pendingSeekTime === null) return;
        pendingSeekTime = null;
        ui();
        setStatus("O servidor demorou a responder ao avançar. Tente novamente.");
      }, SEEK_TIMEOUT);
    }
  } catch (err) {
    pendingSeekTime = null;
    setStatus("Não foi possível avançar para esse ponto.");
    console.error("Erro ao posicionar o vídeo:", err);
    ui();
  }
}

function endSeek(e, commit) {
  if (!isSeeking || e.pointerId !== seekPointerId) return;
  const fraction = commit ? getSeekFraction(e) : null;
  isSeeking = false;
  seekPointerId = null;
  if (fraction !== null) commitSeek(fraction); else if (pendingSeekTime === null) ui();
  showControls();
  try { if (E.track.hasPointerCapture(e.pointerId)) E.track.releasePointerCapture(e.pointerId); } catch { /* ignora */ }
}

E.track.addEventListener("pointerdown", e => {
  if (!canSeek() || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  isSeeking = true;
  seekPointerId = e.pointerId;
  showControls();
  const f = getSeekFraction(e);
  if (f !== null) previewSeek(f);
  try { E.track.setPointerCapture(e.pointerId); } catch { /* ignora */ }
});
E.track.addEventListener("pointermove", e => {
  if (!isSeeking || e.pointerId !== seekPointerId) return;
  const f = getSeekFraction(e);
  if (f !== null) previewSeek(f);
});
E.track.addEventListener("pointerup", e => endSeek(e, true));
E.track.addEventListener("pointercancel", e => endSeek(e, false));
E.track.addEventListener("lostpointercapture", e => endSeek(e, false));   // perdeu o ponteiro: nunca fica "arrastando"

/* --- Demais controles --- */
E.screen.addEventListener("pointermove", showControls);
E.screen.addEventListener("pointerdown", showControls);
E.screen.addEventListener("focusin", showControls);
E.screen.addEventListener("pointerleave", () => {
  if (vid && !vid.paused && !vid.ended && !isSeeking) {
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => E.screen.classList.add("controls-hidden"), CONTROLS_DELAY);
  }
});

E.big.onclick = E.pp.onclick = () => { showControls(); setPlay(!playing); };
E.subtitle.addEventListener("change", () => {
  if (!vid) return;
  const sel = Number(E.subtitle.value);
  store.set(K.sub, sel >= 0 ? 1 : 0);
  useSub(sel);
});
E.subsz.onclick = () => {
  showControls();
  szi = (szi + 1) % SUBSZ.length;
  applySz();
  store.set(K.subsz, szi);
  setStatus("Tamanho da legenda: " + SUBSZ[szi][0]);
  setTimeout(() => { if (E.status.textContent.startsWith("Tamanho")) setStatus(""); }, 1500);
};
E.spd.onclick = () => {
  showControls();
  if (!vid) return;
  const i = SPEEDS.indexOf(vid.playbackRate);
  vid.playbackRate = SPEEDS[(i + 1) % SPEEDS.length];
};
E.rew.onclick = () => { showControls(); skip(-10); };
E.fwd.onclick = () => { showControls(); skip(10); };
E.mf.onclick = () => cur && toggleFav(cur.key);
E.mr.onclick = () => {
  if (!vid || !cur) return;
  delete prog[cur.key];
  saveProg();
  vid.currentTime = 0;
  E.mr.hidden = true;
  setPlay(true);
};
E.qual.onclick = () => { showControls(); trocarQualidade(curQ === 720 ? 1080 : 720); };
E.pseg.addEventListener("click", e => {
  const b = e.target.closest("[data-pt]");
  if (!b) return;
  showControls();
  trocarParte(+b.dataset.pt);
});
E.mute.onclick = () => { showControls(); if (vid) vid.muted = !vid.muted; };
E.fs.onclick = () => { showControls(); toggleFs(); };
E.close.onclick = closeMovie;

/* =========================================================
   9. TECLADO (Esc, Tab preso nos painéis, atalhos do player)
   Espaço/K pausa · ←/→ ±10 s · ↑/↓ volume · M som · F tela cheia
   ========================================================= */
document.addEventListener("keydown", e => {
  const modalOpen = E.modal.classList.contains("open");
  const drawerOpen = E.drawer.classList.contains("open");

  if (e.key === "Escape") {
    if (!E.profileMenu.hidden) closeProfile(true);
    else if (modalOpen) closeMovie();
    else if (drawerOpen) closeDrawer();
    else if (document.querySelector(".pop:not([hidden])")) closePops(true);
    else if (detailKey) closeDetail();
    return;
  }
  if (drawerOpen) { trapTab(e, E.drawer); return; }
  if (!modalOpen) return;

  trapTab(e, E.modal);
  if (!vid || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === "SELECT" || tag === "INPUT") return;

  const k = e.key.toLowerCase();
  if (k === "k" || (k === " " && tag !== "BUTTON")) {
    e.preventDefault(); showControls(); setPlay(vid.paused);
  } else if (k === "arrowleft" || k === "arrowright") {
    e.preventDefault(); showControls(); skip(k === "arrowright" ? 10 : -10);
  } else if (k === "arrowup" || k === "arrowdown") {
    e.preventDefault(); showControls();
    vid.volume = Math.max(0, Math.min(1, vid.volume + (k === "arrowup" ? .1 : -.1)));
  } else if (k === "m") {
    showControls(); vid.muted = !vid.muted;
  } else if (k === "f") {
    showControls(); toggleFs();
  }
});

/* =========================================================
   10. PLANILHA DO GOOGLE (opcional)
   ========================================================= */
function parseCSV(t) {
  t = t.replace(/^\uFEFF/, "");
  const rows = []; let r = [], c = "", inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else inQ = false; }
      else c += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; r.push(c); rows.push(r); r = []; c = ""; }
    else c += ch;
  }
  if (c !== "" || r.length) { r.push(c); rows.push(r); }
  return rows;
}

function filmesDaPlanilha(csv) {
  const rows = parseCSV(csv).filter(r => r.some(c => c.trim()));
  if (rows.length < 2) return [];
  const head = rows[0].map(c => norm(c.trim()));
  const col = (r, n) => { const i = head.indexOf(n); return i < 0 ? "" : (r[i] || "").trim(); };
  return rows.slice(1).map(r => {
    const t = col(r, "titulo");
    if (!t) return null;
    const cor = col(r, "cor");
    // Filme em duas partes: só se video2 ou drive2 estiver preenchido.
    // A Parte 1 usa as colunas video/drive/legenda; a Parte 2 usa video2/drive2/legenda2.
    const v2 = col(r, "video2"), d2 = col(r, "drive2");
    const partes = (v2 || d2) ? [
      { video: col(r, "video"), drive: col(r, "drive"), legenda: col(r, "legenda"), video720: col(r, "video720"), drive720: col(r, "drive720") },
      { video: v2, drive: d2, legenda: col(r, "legenda2"), video720: col(r, "video2_720"), drive720: col(r, "drive2_720") }
    ] : undefined;
    return normalizar({
      id: col(r, "id"), t,
      g: col(r, "genero") || "Drama", y: col(r, "ano"), m: col(r, "minutos"), a: col(r, "idade"),
      h: cor !== "" && !isNaN(+cor) ? +cor : hueOf(t),
      x: (20 + hueOf(t + "x") % 60) + "%",
      p: col(r, "sinopse"),
      capa: col(r, "capa"), legenda: col(r, "legenda"), drive: col(r, "drive"), video: col(r, "video"),
      video720: col(r, "video720"), drive720: col(r, "drive720"),
      dir: col(r, "diretor") || col(r, "diretores") || col(r, "direcao"),
      partes
    });
  }).filter(Boolean);
}

async function carregarPlanilha() {
  let u;
  try { u = new URL(CONFIG.planilha); } catch { u = null; }
  if (!u || u.protocol !== "https:" || u.hostname !== "docs.google.com") {
    console.warn("PLANILHA ignorada: use um link https://docs.google.com/... publicado na web.");
    return;
  }
  // Aceita o link "pubhtml" e converte para CSV automaticamente.
  u.pathname = u.pathname.replace(/\/pubhtml$/, "/pub");
  if (u.searchParams.get("output") !== "csv") u.searchParams.set("output", "csv");

  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(u.href, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const lista = filmesDaPlanilha(await r.text());
    if (!lista.length) {
      console.warn("A planilha foi lida, mas não tem filmes válidos (confira a linha de títulos). Usando a lista padrão.");
      return;
    }
    setCatalogo(lista);
    console.info("Planilha carregada:", lista.length, "filmes.");
  } catch (err) {
    console.warn("Não foi possível ler a planilha; usando a lista padrão.", err);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   11. INICIALIZAÇÃO
   ========================================================= */
applySz();
setIcon(E.fs, "fs", IC.fs);
setCatalogo((Array.isArray(window.CATALOGO) ? window.CATALOGO : []).map(normalizar).filter(Boolean));
if (!CONFIG.planilha) migrarLegado();
renderAll();
startHero();
if (CONFIG.planilha) carregarPlanilha().finally(() => { migrarLegado(); renderAll(); });

})();
