const http = require('http');
const fs = require('fs');
const path = require('path');
const { notifyMissingProduct } = require('./notify-missing');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTjjCLIzwdPBmQTGQTnQVGibBsW4tT_QiiJMaILAiWbWEBYP0o-occX3ZXhwfStws40Y8NSWHbur02h/pub?gid=0&single=true&output=csv';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const catalogCache = { text: '', at: 0 };

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function getCatalogCsv() {
  if (catalogCache.text && Date.now() - catalogCache.at < 60000) {
    return catalogCache.text;
  }

  const response = await fetch(SHEET_CSV_URL);
  if (!response.ok) throw new Error('catalog unavailable');
  const text = await response.text();
  catalogCache.text = text;
  catalogCache.at = Date.now();
  return text;
}

const server = http.createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent((request.url || '/').split('?')[0]);

    if (request.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/catalog') {
      try {
        const csv = await getCatalogCsv();
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        response.end(csv);
      } catch (error) {
        sendJson(response, 502, { error: 'Could not load product catalog' });
      }
      return;
    }

    if (urlPath === '/api/not-found') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }

      try {
        const body = JSON.parse((await readBody(request)) || '{}');
        const result = await notifyMissingProduct(body);
        sendJson(response, result.status, result.ok ? { notified: true } : { error: result.error });
      } catch (error) {
        sendJson(response, 500, { error: 'Webhook request failed' });
      }
      return;
    }

    const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^[/\\]+/, '');
    const filePath = path.resolve(ROOT, relativePath);

    if (!filePath.startsWith(ROOT)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500);
        response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
        return;
      }

      response.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      response.end(data);
    });
  } catch (error) {
    sendJson(response, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`PriceLens running at http://localhost:${PORT}`);
});
