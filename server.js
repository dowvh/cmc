"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.disable("x-powered-by");
const PORT = Number(process.env.PORT) || 3000;

// Tempo máximo esperando o Google Drive começar a responder (o streaming em si não tem limite).
const TEMPO_RESPOSTA_DRIVE_MS = 20000;

// ---------------------------------------------------------------
// Credenciais do Google
// - Hospedagem: variável de ambiente GOOGLE_CREDENTIALS (JSON inteiro da chave)
// - No seu PC: arquivo service-account.json ao lado deste arquivo
// A chave NUNCA deve ir para o GitHub (está no .gitignore).
// ---------------------------------------------------------------
const KEY_FILE = path.join(__dirname, "service-account.json");
let authOptions;

if (process.env.GOOGLE_CREDENTIALS) {
  try {
    authOptions = { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS) };
  } catch {
    console.error("A variável GOOGLE_CREDENTIALS não contém um JSON válido.");
    process.exit(1);
  }
} else if (fs.existsSync(KEY_FILE)) {
  authOptions = { keyFile: KEY_FILE };
} else {
  console.error(
    "Credencial do Google não encontrada. Defina GOOGLE_CREDENTIALS " +
      "ou coloque service-account.json nesta pasta (somente no seu PC)."
  );
  process.exit(1);
}

const auth = new GoogleAuth({
  ...authOptions,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"]
});

// O servidor só lê arquivos do Drive compartilhados com a conta de serviço
// (o e-mail "client_email" da chave). Compartilhe apenas a pasta dos filmes.
const ID_VALIDO = /^[A-Za-z0-9_-]{15,80}$/;

// ---------------------------------------------------------------
// ALLOWED_ORIGIN: "*" (padrão) ou uma lista de origens separadas por vírgula,
// ex.: https://dowvh.github.io,http://localhost:5500
// Valores inválidos derrubam o servidor na partida (melhor do que rodar aberto sem querer).
// ---------------------------------------------------------------
function lerOrigensPermitidas(valor) {
  const bruto = String(valor || "*").trim();
  if (bruto === "*") {
    if (process.env.NODE_ENV === "production") {
      console.warn("Aviso: ALLOWED_ORIGIN não definido; qualquer site pode usar a rota /media.");
    }
    return { qualquer: true, lista: new Set() };
  }

  const lista = new Set();
  for (const item of bruto.split(",").map(s => s.trim()).filter(Boolean)) {
    let url = null;
    try { url = new URL(item); } catch { /* inválido */ }

    const semBarra = item.replace(/\/+$/, "").toLowerCase();
    if (!url || !/^https?:$/.test(url.protocol) || url.origin.toLowerCase() !== semBarra) {
      console.error(
        `ALLOWED_ORIGIN inválido: "${item}". Use origens completas, sem caminho, ` +
          "ex.: https://usuario.github.io"
      );
      process.exit(1);
    }
    lista.add(url.origin);
  }

  if (!lista.size) {
    console.error("ALLOWED_ORIGIN está vazio. Use * ou uma lista de origens.");
    process.exit(1);
  }
  return { qualquer: false, lista };
}

const ORIGENS = lerOrigensPermitidas(process.env.ALLOWED_ORIGIN);

// ---------------------------------------------------------------
// Cabeçalhos básicos de segurança (todas as respostas)
// ---------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// ---------------------------------------------------------------
// Arquivos públicos: somente pastas e arquivos listados (nunca __dirname inteiro,
// que exporia service-account.json).
// ---------------------------------------------------------------
app.use(
  "/capas",
  express.static(path.join(__dirname, "capas"), { dotfiles: "deny", index: false, maxAge: "1d" })
);
app.use(
  "/legendas",
  express.static(path.join(__dirname, "legendas"), {
    dotfiles: "deny",
    index: false,
    maxAge: "5m",
    setHeaders(res, file) {
      if (file.endsWith(".vtt")) res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    }
  })
);

// Página e seus arquivos (útil para testar tudo junto no PC).
const INDEX =
  ["index.html", "cinenoite-player.html"].find(nome => fs.existsSync(path.join(__dirname, nome))) ||
  "index.html";

const ARQUIVOS_DO_SITE = {
  "/": INDEX,
  "/index.html": INDEX,
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/catalogo.js": "catalogo.js"
};

app.get(Object.keys(ARQUIVOS_DO_SITE), (req, res) => {
  const nome = ARQUIVOS_DO_SITE[req.path];
  const cache = nome === INDEX ? "no-cache" : "public, max-age=300";

  res.sendFile(path.join(__dirname, nome), { headers: { "Cache-Control": cache } }, erro => {
    if (erro && !res.headersSent) res.status(404).send("Arquivo não encontrado");
  });
});

// Rota simples para o serviço de hospedagem verificar se o servidor está vivo.
app.get("/saude", (req, res) => {
  res.send("ok");
});

// ---------------------------------------------------------------
// CORS da rota de vídeo.
// Observação: o <video src> comum não usa CORS, então isto só protege acessos via fetch/XHR.
// ---------------------------------------------------------------
app.use("/media", (req, res, next) => {
  const origem = req.headers.origin;
  const permitida = ORIGENS.qualquer || (origem && ORIGENS.lista.has(origem));

  if (ORIGENS.qualquer) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    res.setHeader("Vary", "Origin");
    if (permitida) res.setHeader("Access-Control-Allow-Origin", origem);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Range, Accept-Ranges, Content-Length"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(origem && !permitida ? 403 : 204);
  }
  next();
});

// ---------------------------------------------------------------
// Range
// ---------------------------------------------------------------

// Só repassa ao Drive pedidos de UM intervalo bem formado ("bytes=0-", "bytes=10-99", "bytes=-500").
// Qualquer outra coisa é ignorada (o RFC permite) em vez de ser encaminhada.
function normalizarRange(valor) {
  const texto = String(valor || "").trim();
  return /^bytes=\d*-\d*$/i.test(texto) ? texto : null;
}

// Interpreta requisições Range do navegador.
function parseRange(rangeHeader, total) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());

  if (!match || !Number.isSafeInteger(total) || total <= 0) {
    return null;
  }

  let start;
  let end;

  // Exemplo: bytes=-500 (últimos 500 bytes)
  if (match[1] === "") {
    const suffix = Number(match[2]);

    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { invalid: true };
    }

    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? total - 1 : Number(match[2]);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return { invalid: true };
  }

  end = Math.min(end, total - 1);

  return { start, end, length: end - start + 1 };
}

function getHeader(headers, name) {
  if (!headers) return undefined;

  if (typeof headers.get === "function") {
    return headers.get(name);
  }

  return headers[name.toLowerCase()] || headers[name];
}

// Fallback caso o Google Drive ignore o Range e devolva o arquivo inteiro.
function createRangeStream(source, start, length) {
  let skipped = 0;
  let sent = 0;
  let done = false;

  const cutter = new Transform({
    transform(chunk, encoding, callback) {
      if (done) return callback();

      let data = chunk;

      if (skipped < start) {
        const amount = Math.min(start - skipped, data.length);
        skipped += amount;
        data = data.subarray(amount);
      }

      if (data.length && sent < length) {
        const amount = Math.min(data.length, length - sent);
        sent += amount;
        this.push(data.subarray(0, amount));
      }

      if (sent >= length) {
        done = true;
        source.unpipe(cutter);
        source.destroy();
        this.push(null);
      }

      callback();
    }
  });

  source.on("error", error => {
    cutter.destroy(error);
  });

  source.pipe(cutter);

  return cutter;
}

// ---------------------------------------------------------------
// Streaming do Drive
// ---------------------------------------------------------------
app.get("/media/:id", async (req, res) => {
  const id = req.params.id;

  if (!ID_VALIDO.test(id)) {
    return res.status(404).send("Filme não encontrado");
  }

  const range = normalizarRange(req.headers.range);
  const abort = new AbortController();
  let source;
  let output;
  let clienteSaiu = false;

  // Cobre também a espera pela resposta do Drive: se o navegador desistir, cancela tudo.
  res.on("close", () => {
    if (res.writableEnded) return;
    clienteSaiu = true;
    abort.abort();
    if (output && !output.destroyed) output.destroy();
    if (source && !source.destroyed) source.destroy();
  });

  try {
    const client = await auth.getClient();

    const headers = { "Accept-Encoding": "identity" };
    if (range) headers.Range = range;

    const limite = setTimeout(() => abort.abort(), TEMPO_RESPOSTA_DRIVE_MS);
    let response;

    try {
      response = await client.request({
        url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
        method: "GET",
        headers,
        responseType: "stream",
        signal: abort.signal,
        validateStatus: status => (status >= 200 && status < 300) || status === 416
      });
    } finally {
      clearTimeout(limite);
    }

    source = response.data;

    if (clienteSaiu) {
      if (!source.destroyed) source.destroy();
      return;
    }

    const upstreamStatus = response.status;

    // O Drive às vezes devolve application/octet-stream; o navegador precisa de um tipo de vídeo.
    const upstreamType = getHeader(response.headers, "content-type");
    const contentType =
      upstreamType && /^video\//i.test(upstreamType) ? upstreamType : "video/mp4";

    const contentLength = Number(getHeader(response.headers, "content-length"));
    const contentRange = getHeader(response.headers, "content-range");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Accept-Ranges", "bytes");
    // Permite que o navegador móvel reutilize blocos já baixados,
    // sem tornar os vídeos públicos em caches compartilhados.
    res.setHeader("Cache-Control", "private, max-age=1800, must-revalidate");

    // O Google Drive informou que o intervalo não é válido.
    if (upstreamStatus === 416) {
      res.setHeader(
        "Content-Range",
        contentRange || (Number.isFinite(contentLength) ? `bytes */${contentLength}` : "bytes */*")
      );
      source.destroy();
      return res.status(416).end();
    }

    // O Drive já respondeu corretamente com conteúdo parcial.
    if (upstreamStatus === 206) {
      if (contentRange) res.setHeader("Content-Range", contentRange);
      if (Number.isFinite(contentLength) && contentLength > 0) {
        res.setHeader("Content-Length", String(contentLength));
      }

      res.status(206);
      output = source;
    }

    // Sem Range: transmissão normal do arquivo.
    else if (!range) {
      if (Number.isFinite(contentLength) && contentLength > 0) {
        res.setHeader("Content-Length", String(contentLength));
      }

      res.status(200);
      output = source;
    }

    // O Drive ignorou o Range. Tenta cortar o trecho solicitado.
    else if (Number.isFinite(contentLength) && contentLength > 0) {
      const intervalo = parseRange(range, contentLength);

      if (!intervalo || intervalo.invalid) {
        source.destroy();
        res.setHeader("Content-Range", `bytes */${contentLength}`);
        return res.status(416).end();
      }

      res.status(206);
      res.setHeader("Content-Range", `bytes ${intervalo.start}-${intervalo.end}/${contentLength}`);
      res.setHeader("Content-Length", String(intervalo.length));

      output = createRangeStream(source, intervalo.start, intervalo.length);
    }

    // Sem tamanho conhecido, não é seguro simular uma resposta parcial.
    else {
      source.destroy();
      return res.status(502).send("Não foi possível processar o intervalo do vídeo");
    }

    // HEAD: só os cabeçalhos, sem puxar o filme.
    if (req.method === "HEAD") {
      source.destroy();
      if (output !== source && !output.destroyed) output.destroy();
      return res.end();
    }

    output.on("error", error => {
      console.error("Erro no fluxo de vídeo:", error.message);

      if (!res.headersSent) {
        res.status(502).end("Erro ao transmitir vídeo");
      } else {
        res.destroy();
      }
    });

    output.pipe(res);
  } catch (error) {
    if (source && !source.destroyed) source.destroy();
    if (clienteSaiu) return;

    const upstream = Number(error && error.response && error.response.status);
    try { error.response.data.destroy(); } catch { /* sem corpo para descartar */ }
    console.error("Erro ao transmitir vídeo:", upstream || (error && error.message));

    if (res.headersSent) return res.destroy();
    if (abort.signal.aborted) return res.status(504).send("O Google Drive demorou demais para responder");
    if (upstream === 404) return res.status(404).send("Filme não encontrado");
    if (upstream === 403 || upstream === 429) {
      return res.status(503).send("O Drive limitou o acesso a este arquivo. Tente novamente mais tarde.");
    }
    return res.status(502).send("Não foi possível carregar o vídeo");
  }
});

// ---------------------------------------------------------------
// 404 e erros (sem vazar detalhes internos)
// ---------------------------------------------------------------
app.use((req, res) => {
  res.status(404).send("Não encontrado");
});

app.use((error, req, res, next) => {
  console.error("Erro:", error && error.message);
  if (res.headersSent) return next(error);
  res.status(500).send("Erro interno");
});

const servidor = app.listen(PORT, () => {
  console.log(`CineNoite rodando na porta ${PORT}`);
});

// Encerramento limpo (o Render envia SIGTERM ao reiniciar/implantar).
process.on("SIGTERM", () => {
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
