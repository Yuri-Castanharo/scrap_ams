const express = require("express");
const puppeteer = require("puppeteer");
const obterMovimentos = require("./ams_export");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");

const app = express();
const PORT = 3001;

// In-memory cache
let cachedArrivals = [];
let cachedDepartures = [];
let currentAuthToken = null;

// SSE Clients
let sseClients = [];

// Reusable login function
async function performLoginAndGetToken() {
  const urlLogin = "https://amsweb.gru.com.br/legacy/#/";
  const usuario = "ORBITAL";
  const senha = "Gru@123";
  console.info("Attempting to perform login and get token via Puppeteer...");
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    console.info("Puppeteer: Navigating to login page...");
    await page.goto(urlLogin, {
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 60000,
    });

    console.info("Puppeteer: Typing username and password...");
    await page.type("#username", usuario, { delay: 100 });
    await page.type("#password", senha, { delay: 100 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
          await page.click("#login-btn")

    ]);

    let authToken = null;
    await new Promise((resolve, reject) => {
      page.on("response", async (response) => {
        const headers = response.headers();
        if (headers["x-amsauthorization"]) {
          authToken = headers["x-amsauthorization"];
          console.info("Puppeteer: Token captured from response header.");
          if (!resolve.called) { resolve.called = true; resolve(); }
        }
      });

      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 })
        .then(() => {
          if (!authToken) {
            console.warn("Puppeteer: Navigation finished but token not captured directly. Checking after short delay...");
            setTimeout(() => {
              if (!authToken) {
                console.error("Puppeteer: Token not found after navigation and delay.");
                if (!reject.called) { reject.called = true; reject(new Error("Token not found after login navigation"));}
              } else {
                if (!resolve.called) { resolve.called = true; resolve(); }
              }
            }, 5000);
          } else {
             if (!resolve.called) { resolve.called = true; resolve(); }
          }
        })
        .catch(err => {
          console.error("Puppeteer: Error during waitForNavigation in login.", err);
          if (!reject.called) { reject.called = true; reject(err); }
        });
    });

    if (authToken) {
      console.info("Puppeteer: Login successful, token obtained.");
      return authToken;
    } else {
      // This case should ideally be caught by the promise rejection, but as a fallback:
      console.error("Puppeteer: Login appeared to succeed but token was not extracted.");
      return null;
    }
  } catch (err) {
    console.error("Puppeteer: Comprehensive error during login process.", { message: err.message, stack: err.stack, name: err.name });
    return null;
  } finally {
    if (browser) {
      console.info("Puppeteer: Closing browser.");
      await browser.close();
    }
  }
}

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
  let tokenUsedWasCached = !!currentAuthToken;

  if (!currentAuthToken) {
    console.warn('No cached token available for /atualizar. Attempting initial token acquisition.');
    const newToken = await performLoginAndGetToken();
    if (newToken) {
      currentAuthToken = newToken;
      console.info('Token acquisition successful for /atualizar.');
      tokenUsedWasCached = false; // Token was just acquired
    } else {
      console.error('Failed to acquire token for /atualizar. Cannot proceed.');
      return res.status(500).json({ success: false, message: "Falha crítica ao obter token necessário para atualização." });
    }
  } else {
    console.info('Attempting to use cached token for /atualizar.');
  }

  try {
    const movimentosData = await obterMovimentos(currentAuthToken);
    cachedArrivals = movimentosData.arrivals;
    cachedDepartures = movimentosData.departures;

    if(tokenUsedWasCached) {
      console.info('Data update successful using cached token for /atualizar.');
    } else {
      console.info('Data update successful using newly acquired token for /atualizar.');
    }
    sendDataToAllSseClients({ type: 'update', arrivals: cachedArrivals, departures: cachedDepartures });
    return res.json({ success: true, message: "Dados atualizados e cacheados com sucesso.", token: currentAuthToken });

  } catch (error) {
    console.warn(`Initial data fetch failed for /atualizar using token (was cached: ${tokenUsedWasCached}). Error: ${error.message}`, error.isAxiosError ? error.toJSON() : error);
    console.warn('Attempting token refresh due to error.');

    const newToken = await performLoginAndGetToken();
    if (newToken) {
      currentAuthToken = newToken;
      console.info('Token refresh successful for /atualizar. New token acquired.');
      try {
        const movimentosDataRetry = await obterMovimentos(currentAuthToken);
        cachedArrivals = movimentosDataRetry.arrivals;
        cachedDepartures = movimentosDataRetry.departures;
        console.info('Data update successful after token refresh for /atualizar.');
        sendDataToAllSseClients({ type: 'update', arrivals: cachedArrivals, departures: cachedDepartures });
        return res.json({ success: true, message: "Dados atualizados e cacheados com sucesso após atualização de token.", token: currentAuthToken });
      } catch (retryError) {
        console.error('Data update failed even after token refresh for /atualizar.', { message: retryError.message, errorDetails: retryError.isAxiosError ? retryError.toJSON() : retryError });
        return res.status(500).json({ success: false, message: "Falha ao obter dados de movimentos, mesmo após tentar atualizar o token.", error: retryError.message });
      }
    } else {
      console.error('Token refresh failed for /atualizar.');
      return res.status(500).json({ success: false, message: "Falha ao atualizar o token após erro na obtenção de dados.", errorDetails: error.message });
    }
  }
});

// API para ler chegadas do cache
app.get("/api/chegadas", async (req, res) => {
  if (cachedArrivals.length > 0) {
    res.json(cachedArrivals);
  } else {
    res.json([]); // Ou { message: "Nenhuma chegada em cache no momento." }
  }
});

// API para ler saídas do cache
app.get("/api/saidas", async (req, res) => {
  if (cachedDepartures.length > 0) {
    res.json(cachedDepartures);
  } else {
    res.json([]); // Ou { message: "Nenhuma saída em cache no momento." }
  }
});

// Function to initialize data and cache
async function initializeDataAndCache() {
  console.info('Initial data load attempt started...');
  const token = await performLoginAndGetToken();
  if (token) {
    currentAuthToken = token;
    console.info("Initial token obtained successfully for caching process.");
    try {
      console.info("Attempting to fetch initial movements for cache using newly acquired token.");
      const movimentos = await obterMovimentos(currentAuthToken);
      if (movimentos && movimentos.arrivals && movimentos.departures) {
        cachedArrivals = movimentos.arrivals;
        cachedDepartures = movimentos.departures;
        console.info('Initial data load successful. Cache populated.');
        sendDataToAllSseClients({ type: 'initialLoad', arrivals: cachedArrivals, departures: cachedDepartures });
      } else {
        console.warn("No movements data returned from obterMovimentos during initial cache population, cache may be empty or incomplete.");
      }
    } catch (error) {
      console.error("Error during initial data fetch for cache (after getting token):", { message: error.message, details: error.isAxiosError ? error.toJSON() : error });
      console.warn('Initial data load failed after token acquisition.');
    }
  } else {
    console.error("Failed to obtain initial token during startup. Server will start without cached data. Subsequent calls to /atualizar will attempt login.");
    console.warn('Initial data load failed due to inability to get token.');
  }
}

// SSE Endpoint
app.get('/api/data-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now() + "_" + Math.random().toString(36).substr(2, 9); // More unique ID
  const newClient = { id: clientId, res };
  sseClients.push(newClient);
  console.info(`SSE client connected: ${clientId}. Total clients: ${sseClients.length}`);

  try {
    // Send current cache state immediately
    if (cachedArrivals.length > 0 || cachedDepartures.length > 0) {
      newClient.res.write(`data: ${JSON.stringify({ type: 'initialLoad', arrivals: cachedArrivals, departures: cachedDepartures })}\n\n`);
    } else {
      newClient.res.write(`data: ${JSON.stringify({ type: 'initialLoad', arrivals: [], departures: [] })}\n\n`); // Send empty initial load if no cache
    }
  } catch (err) {
    console.error(`Error sending initial data to SSE client ${newClient.id}:`, err);
    // Remove client if initial send fails
    sseClients = sseClients.filter(client => client.id !== newClient.id);
    console.info(`SSE client ${newClient.id} removed due to error on initial data send. Total clients: ${sseClients.length}`);
    // No further action on res as it might be closed or in an error state.
    return; // Stop further processing for this client
  }


  req.on('close', () => {
    sseClients = sseClients.filter(client => client.id !== clientId);
    console.info(`SSE client disconnected: ${clientId}. Total clients: ${sseClients.length}`);
  });
});

// Broadcast function to send data to all SSE clients
function sendDataToAllSseClients(data) {
  if (sseClients.length === 0) return;
  console.info(`Broadcasting data to ${sseClients.length} SSE clients.`);

  const clientsToRemove = [];

  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error(`Error sending data to SSE client ${client.id}:`, err);
      clientsToRemove.push(client.id);
    }
  });

  if (clientsToRemove.length > 0) {
    sseClients = sseClients.filter(client => !clientsToRemove.includes(client.id));
    console.info(`Removed ${clientsToRemove.length} SSE clients due to write errors. Total clients: ${sseClients.length}`);
  }
}

// Inicia servidor e tenta inicializar o cache
app.listen(PORT, async () => {
  console.info(`Server started on port ${PORT}`);
  await initializeDataAndCache();
});
