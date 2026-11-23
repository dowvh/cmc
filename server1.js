const express = require("express");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { GoogleAuth } = require("google-auth-library");

const app = express();
const PORT = process.env.PORT || 3000;

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
  } catch (error) {
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

// Somente estes arquivos do Drive podem ser transmitidos.
// Ao adicionar um filme novo, inclua o ID aqui e no driveId do HTML.
const FILMES = new Set([
  "1Jv6qcG-RcOF3BNNcHtYmo-Sva-cyGJ0w",
  "1KGCfu5dNcEFrwiFWBcyNRF4wmJf60T3j",
  "1aXm38oSTsh_vhTTY40nqTJbRqGN5I4yQ"
]);

// Endereço do site que pode incorporar os vídeos, ex.: https://dowvh.github.io
// Sem a variável, qualquer site pode usar a rota /media.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// ---------------------------------------------------------------
// Arquivos públicos
// Antes: express.static(__dirname) entregava a pasta inteira
// (inclusive a chave). Agora só saem estas pastas.
// ---------------------------------------------------------------
app.use("/capas", express.static(path.join(__dirname, "capas")));
app.use("/legendas", express.static(path.join(__dirname, "legendas")));

// Página inicial (útil para testar tudo junto no PC).
const PAGINA = ["index.html", "cinenoite-player.html"]
  .map(nome => path.join(__dirname, nome))
  .find(arquivo => fs.existsSync(arquivo));

app.get("/", (req, res) => {
  if (!PAGINA) return res.status(404).send("Página não encontrada");
  res.sendFile(PAGINA);
});

// Rota simples para o serviço de hospedagem verificar se o servidor está vivo.
app.get("/saude", (req, res) => {
  res.send("ok");
});

// CORS da rota de vídeo (necessário quando o site está em outro endereço).
app.use("/media", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Range, Accept-Ranges, Content-Length"
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Interpreta requisições Range do navegador.
function parseRange(rangeHeader, total) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(
    String(rangeHeader || "").trim()
  );

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

  return {
    start,
    end,
    length: end - start + 1
  };
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

  const cutter = new Transform({
    transform(chunk, encoding, callback) {
      let data = chunk;

      if (skipped < start) {
        const amount = Math.min(start - skipped, data.length);
        skipped += amount;
        data = data.subarray(amount);
      }

      if (data.length && sent < length) {
        const amount = Math.min(data.length, length - sent);
        const output = data.subarray(0, amount);

        sent += output.length;
        this.push(output);
      }

      if (sent >= length) {
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

app.get("/media/:id", async (req, res) => {
  const id = req.params.id;

  if (!FILMES.has(id)) {
    return res.status(404).send("Filme não encontrado");
  }

  let source;
  let output;

  try {
    const client = await auth.getClient();

    const headers = {
      "Accept-Encoding": "identity"
    };

    // Encaminha o Range recebido do elemento <video>.
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await client.request({
      url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
      method: "GET",
      headers,
      responseType: "stream",
      validateStatus: status =>
        (status >= 200 && status < 300) || status === 416
    });

    source = response.data;

    const upstreamStatus = response.status;

    // O Drive às vezes devolve application/octet-stream; o navegador
    // precisa de um tipo de vídeo para tocar.
    const upstreamType = getHeader(response.headers, "content-type");
    const contentType =
      upstreamType && /^video\//i.test(upstreamType)
        ? upstreamType
        : "video/mp4";

    const contentLength = Number(
      getHeader(response.headers, "content-length")
    );
    const contentRange = getHeader(response.headers, "content-range");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");

    // O Google Drive informou que o intervalo não é válido.
    if (upstreamStatus === 416) {
      const upstreamRange =
        contentRange ||
        (Number.isFinite(contentLength)
          ? `bytes */${contentLength}`
          : "bytes */*");

      res.setHeader("Content-Range", upstreamRange);
      source.destroy();
      return res.status(416).end();
    }

    // O Drive já respondeu corretamente com conteúdo parcial.
    if (upstreamStatus === 206) {
      if (contentRange) {
        res.setHeader("Content-Range", contentRange);
      }

      if (Number.isFinite(contentLength) && contentLength > 0) {
        res.setHeader("Content-Length", String(contentLength));
      }

      res.status(206);

      output = source;
    }

    // Sem Range: transmissão normal do arquivo.
    else if (!req.headers.range) {
      if (Number.isFinite(contentLength) && contentLength > 0) {
        res.setHeader("Content-Length", String(contentLength));
      }

      res.status(200);
      output = source;
    }

    // O Drive ignorou o Range. Tenta cortar o trecho solicitado.
    else if (Number.isFinite(contentLength) && contentLength > 0) {
      const range = parseRange(req.headers.range, contentLength);

      if (!range || range.invalid) {
        source.destroy();
        res.setHeader("Content-Range", `bytes */${contentLength}`);
        return res.status(416).end();
      }

      res.status(206);
      res.setHeader(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${contentLength}`
      );
      res.setHeader("Content-Length", String(range.length));

      output = createRangeStream(
        source,
        range.start,
        range.length
      );
    }

    // Sem tamanho conhecido, não é seguro simular uma resposta parcial.
    else {
      source.destroy();
      return res
        .status(502)
        .send("Não foi possível processar o intervalo do vídeo");
    }

    output.on("error", error => {
      console.error("Erro no fluxo de vídeo:", error.message);

      if (!res.headersSent) {
        res.status(502).end("Erro ao transmitir vídeo");
      } else {
        res.destroy(error);
      }
    });

    // Se o navegador cancelar ou trocar de posição, interrompe o fluxo antigo.
    res.on("close", () => {
      if (!res.writableEnded) {
        if (output && output !== source) {
          output.destroy();
        }

        if (source && !source.destroyed) {
          source.destroy();
        }
      }
    });

    output.pipe(res);

  } catch (error) {
    console.error("Erro ao transmitir vídeo:", error.message);

    if (source && !source.destroyed) {
      source.destroy();
    }

    if (!res.headersSent) {
      res.status(502).send("Não foi possível carregar o vídeo");
    } else {
      res.destroy(error);
    }
  }
});

app.listen(PORT, () => {
  console.log(`CineNoite rodando na porta ${PORT}`);
});
