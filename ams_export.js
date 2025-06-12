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
  if (data.length === 0) return console.log(`Nenhum dado para exportar em ${fileName}`);
  const parser = new Parser();
  const csv = parser.parse(data);
  fs.writeFileSync(fileName, csv, 'utf8');
  console.log(`✅ CSV salvo: ${fileName}`);
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

    exportToCSV(chegadas, 'chegadas.csv');
    exportToCSV(saidas, 'saidas.csv');

    const duracao = Math.round((Date.now() - inicio) / 1000);
    return `⏱ Execução concluída em ${duracao} segundos.`;
  } catch (err) {
    throw new Error(`Erro ao obter dados: ${err.message}`);
  }
}

module.exports = obterMovimentos;
