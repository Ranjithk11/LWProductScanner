const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTjjCLIzwdPBmQTGQTnQVGibBsW4tT_QiiJMaILAiWbWEBYP0o-occX3ZXhwfStws40Y8NSWHbur02h/pub?gid=0&single=true&output=csv';

module.exports = async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(204).end();
  }

  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sheetResponse = await fetch(SHEET_CSV_URL);
    if (!sheetResponse.ok) {
      return response.status(502).json({ error: 'Could not load product catalog' });
    }

    const csv = await sheetResponse.text();
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return response.status(200).send(csv);
  } catch (error) {
    return response.status(502).json({ error: 'Could not load product catalog' });
  }
};
