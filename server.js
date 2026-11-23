
const express = require("express");
const path = require("path");
const { Transform } = require("stream");
const { GoogleAuth } = require("google-auth-library");

const app = express();
const PORT = process.env.PORT || 3000;

const auth = new GoogleAuth({
  keyFile: "./service-account.json",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"]
});

const FILMES = new Set([
  "1Jv6qcG-RcOF3BNNcHtYmo-Sva-cyGJ0w",
  "1KGCfu5dNcEFrwiFWBcyNRF4wmJf60T3j",
  "1aXm38oSTsh_vhTTY40nqTJbRqGN5I4yQ"
]);

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "cinenoite-player.html"));
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
    const contentType =
      getHeader(response.headers, "content-type") || "video/mp4";
    const contentLength = Number(
      getHeader(response.headers, "content-length")
    );
    const contentRange = getHeader(response.headers, "content-range");
    const acceptRanges =
      getHeader(response.headers, "accept-ranges") || "bytes";

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
