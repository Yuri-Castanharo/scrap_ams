const express = require("express");
const puppeteer = require("puppeteer");
const obterMovimentos = require("./ams_export");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");

const app = express();
const PORT = 3000;

// Função utilitária para ler CSV
function lerCSV(caminho) {
  return new Promise((resolve, reject) => {
    const resultados = [];
    fs.createReadStream(caminho)
      .pipe(csv())
      .on("data", (data) => resultados.push(data))
      .on("end", () => resolve(resultados))
      .on("error", reject);
  });
}

// Serve arquivos estáticos (index.html, JS, CSS, etc.)
app.use(express.static("public"));

// Endpoint para obter os dados e atualizar CSVs
app.get("/atualizar", async (req, res) => {
  const urlLogin = "https://amsweb.gru.com.br/legacy/#/";
  const usuario = "ORBITAL";
  const senha = "Gru@123";
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    console.log("Acessando a página de login...");
    await page.goto(urlLogin, {
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 60000,
    });

    await page.type("#username", usuario, { delay: 100 });
    await page.type("#password", senha, { delay: 100 });
    await page.click("#login-btn");

    // Captura do token
    let authToken = null;
    page.on("response", async (response) => {
      const headers = response.headers();
      if (headers["x-amsauthorization"]) {
        authToken = headers["x-amsauthorization"];
      }
    });

    await page.waitForNavigation({ waitUntil: "networkidle0" });

    if (!authToken) {
      return res.status(404).json({ success: false, message: "Token não encontrado" });
    }

    console.log("Token capturado:", authToken);
    await obterMovimentos(authToken);

    return res.json({ success: true, message: "Dados atualizados com sucesso", token: authToken });

  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// API para ler chegadas
app.get("/api/chegadas", async (req, res) => {
  try {
    const dados = await lerCSV("chegadas.csv");
    res.json(dados);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao ler chegadas.csv" });
  }
});

// API para ler saídas
app.get("/api/saidas", async (req, res) => {
  try {
    const dados = await lerCSV("saidas.csv");
    res.json(dados);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao ler saidas.csv" });
  }
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
