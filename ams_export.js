// ams_export.js
const axios = require('axios');
const fs = require('fs');
const { Parser } = require('json2csv');

function flattenObject(obj, parent = '', res = {}) {
  for (let [key, value] of Object.entries(obj)) {
    const propName = parent ? `${parent}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      flattenObject(value, propName, res);
    } else {
      res[propName] = Array.isArray(value) ? JSON.stringify(value) : value;
    }
  }
  return res;
}

function exportToCSV(data, fileName) {
  if (data.length === 0) {
    console.info(`Nenhum dado para exportar em ${fileName}`);
    return;
  }
  try {
    const parser = new Parser();
    const csv = parser.parse(data);
    fs.writeFileSync(fileName, csv, 'utf8');
    console.info(`✅ CSV salvo: ${fileName}`);
  } catch (err) {
    console.error(`Falha ao processar ou salvar CSV: ${fileName}`, err);
    // Decide if this should stop the whole obterMovimentos or just be a warning
    // For now, re-throwing to indicate the operation wasn't fully successful.
    throw new Error(`Falha ao exportar CSV ${fileName}: ${err.message}`);
  }
}

async function obterMovimentos(token) {
  const hoje = new Date();
  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);
  const formatarData = data => `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
  const dataAtual = formatarData(hoje);
  const dataAnterior = formatarData(ontem);

  const url = `https://amsweb.gru.com.br:44302/api/movements?airportCode=GRU&from=${dataAnterior}T00:00:00&to=${dataAtual}T23:59:59&tracker=true`;

  try {
    const inicio = Date.now();
    const response = await axios.get(url, {
      headers: {
        'x-amsauthorization': token,
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://amsweb.gru.com.br',
        'referer': 'https://amsweb.gru.com.br/',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    });

    const dados = response.data;
    const flattened = dados.map(item => flattenObject(item));
    const chegadas = flattened.filter(item => Object.keys(item).some(k => k.startsWith('arrival.')));
    const saidas = flattened.filter(item => Object.keys(item).some(k => k.startsWith('departure.')));

    try {
      exportToCSV(chegadas, 'chegadas.csv');
      exportToCSV(saidas, 'saidas.csv');
    } catch (csvError) {
      // Logged in exportToCSV, re-throw if critical, or handle if partial success is okay
      console.warn(`Aviso: Falha na exportação de um ou mais CSVs. Detalhes: ${csvError.message}`);
      // Depending on requirements, might not want to throw 'err' from axios if CSV simply fails
      // For now, we prioritize returning data if axios succeeded.
    }

    const duracao = Math.round((Date.now() - inicio) / 1000);
    console.info(`⏱  Movimentos obtidos e processados em ${duracao} segundos.`);
    return { arrivals: chegadas, departures: saidas };
  } catch (err) {
    // This primarily catches errors from axios.get or flattenObject
    console.error(`Falha crítica em obterMovimentos: ${err.message}`, err.isAxiosError ? err.toJSON() : err);
    throw err;
  }
}

module.exports = obterMovimentos;
