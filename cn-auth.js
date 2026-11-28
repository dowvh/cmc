"use strict";
/* =========================================================
   CineNoite — autorização dos vídeos do PC (sem dependências)

   Roda no seu PC, junto do Caddy, e faz duas coisas:
     POST /sign    o site pede um link assinado e temporário para um vídeo
     GET  /verify  o Caddy (forward_auth) pergunta se o pedido tem assinatura válida

   Variáveis de ambiente (defina antes de iniciar):
     SIGN_SECRET     segredo longo e aleatório (32+ caracteres). Só existe aqui e no Render.
     PUBLIC_HOST     endereço público do PC, ex.: desktop-g2jklud.taile9cab4.ts.net
     ALLOWED_ORIGIN  endereço(s) do site, ex.: https://dowvh.github.io (separe por vírgula)
     TTL_MIN         (opcional) validade do link em minutos. Padrão: 180
     PORT            (opcional) porta local. Padrão: 9100
   ========================================================= */
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 9100;
const SEGREDO = String(process.env.SIGN_SECRET || "");
const HOST = String(process.env.PUBLIC_HOST || "").trim();
const TTL_S = (Number(process.env.TTL_MIN) || 180) * 60;

function sair(msg) { console.error(msg); process.exit(1); }

if (SEGREDO.length < 32) sair("Defina SIGN_SECRET com pelo menos 32 caracteres (ex.: gere em https://generate-secret.vercel.app/48).");
if (!HOST || /[\/:\s]/.test(HOST)) sair("Defina PUBLIC_HOST só com o nome do PC, sem https:// e sem barra. Ex.: desktop-g2jklud.taile9cab4.ts.net");

const ORIGENS = new Set();
for (const item of String(process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean)) {
  let o = "";
  try { o = new URL(item).origin; } catch { /* inválido */ }
  if (!o || o.toLowerCase() !== item.replace(/\/+$/, "").toLowerCase()) sair('ALLOWED_ORIGIN inválido: "' + item + '". Use só a origem, ex.: https://dowvh.github.io');
  ORIGENS.add(o);
}
if (!ORIGENS.size) sair("Defina ALLOWED_ORIGIN com o endereço do site (ex.: https://dowvh.github.io).");

/* --- Assinatura: HMAC-SHA256 sobre "<caminho>\n<expiração>" --- */
const assinatura = (caminho, e) => crypto.createHmac("sha256", SEGREDO).update(caminho + "\n" + e).digest("base64url");

function confere(caminho, e, s) {
  e = Number(e);
  if (!Number.isSafeInteger(e) || e < Date.now() / 1000) return false;
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(s)) return false;
  const a = Buffer.from(assinatura(caminho, e)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* --- Limite de pedidos por IP (60 s) --- */
const janela = new Map();
function limitar(ip, max = 120) {
  const agora = Date.now();
  const lista = (janela.get(ip) || []).filter(t => agora - t < 60000);
  lista.push(agora);
  janela.set(ip, lista);
  return lista.length <= max;
}
setInterval(() => {
  const agora = Date.now();
  for (const [ip, l] of janela) if (!l.some(t => agora - t < 60000)) janela.delete(ip);
}, 60000).unref();

const ipDe = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function lerCorpo(req, max) {
  return new Promise((ok, erro) => {
    let tam = 0; const partes = [];
    req.on("data", c => { tam += c.length; if (tam > max) { erro(new Error("grande")); req.destroy(); } else partes.push(c); });
    req.on("end", () => ok(Buffer.concat(partes).toString("utf8")));
    req.on("error", erro);
  });
}

// Só aceita caminhos relativos simples de vídeo (sem "..", sem barra invertida, sem caracteres de controle).
function segmentos(f) {
  if (typeof f !== "string" || !f || f.length > 400 || /[\u0000-\u001f\\]/.test(f)) return null;
  const segs = f.split("/");
  if (segs.some(s => !s || s === "." || s === ".." || s.length > 200)) return null;
  if (!/\.(mp4|m4v|webm|mov|ogv)$/i.test(segs[segs.length - 1])) return null;
  return segs;
}

/* --- POST /sign --- */
async function aoAssinar(req, res) {
  const origem = req.headers.origin;
  const ok = !!origem && ORIGENS.has(origem);
  if (ok) {
    res.setHeader("Access-Control-Allow-Origin", origem);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") { res.writeHead(ok ? 204 : 403); return res.end(); }
  if (!ok) return json(res, 403, { erro: "origem não permitida" });
  if (req.method !== "POST") return json(res, 405, { erro: "método" });
  if (!limitar(ipDe(req))) return json(res, 429, { erro: "muitos pedidos" });

  let segs = null;
  try { segs = segmentos(JSON.parse(await lerCorpo(req, 2048)).file); } catch { /* inválido */ }
  if (!segs) return json(res, 400, { erro: "arquivo inválido" });

  const caminho = "/" + segs.join("/");
  const e = Math.floor(Date.now() / 1000) + TTL_S;
  json(res, 200, { url: "https://" + HOST + "/" + segs.map(encodeURIComponent).join("/") + "?e=" + e + "&s=" + assinatura(caminho, e) });
}

/* --- GET /verify (chamado só pelo Caddy; 204 = liberado, 403 = negado) --- */
function aoVerificar(req, res) {
  const uri = req.headers["x-forwarded-uri"];
  const metodo = String(req.headers["x-forwarded-method"] || "GET").toUpperCase();
  let liberado = false;
  if (typeof uri === "string" && (metodo === "GET" || metodo === "HEAD")) {
    try {
      const u = new URL(uri, "http://local");
      liberado = confere(decodeURIComponent(u.pathname), u.searchParams.get("e"), u.searchParams.get("s"));
    } catch { /* negado */ }
  }
  res.writeHead(liberado ? 204 : 403, { "Cache-Control": "no-store" });
  res.end();
}

const servidor = http.createServer((req, res) => {
  let caminho = "";
  try { caminho = new URL(req.url, "http://local").pathname; } catch { /* ignora */ }
  if (caminho === "/sign") return aoAssinar(req, res).catch(() => { if (!res.headersSent) json(res, 500, { erro: "interno" }); });
  if (caminho === "/verify") return aoVerificar(req, res);
  res.writeHead(404); res.end();
});
servidor.requestTimeout = 15000;
servidor.listen(PORT, "127.0.0.1", () => {
  console.log("cn-auth rodando em 127.0.0.1:" + PORT + " (links válidos por " + Math.round(TTL_S / 60) + " min)");
});
