const fs = require('fs');
const path = require('path');

function getWebhookUrl() {
  const fromEnv = process.env.WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (fromEnv) return fromEnv.trim();

  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'webhook.json'), 'utf8'));
    return String(config.url || '').trim();
  } catch (error) {
    return '';
  }
}

async function notifyMissingProduct({ query, source }) {
  const webhookUrl = getWebhookUrl();
  const cleanedQuery = String(query || '').trim().slice(0, 200);

  if (!cleanedQuery) {
    return { ok: false, status: 400, error: 'Missing product query' };
  }

  if (!webhookUrl) {
    return { ok: false, status: 503, error: 'Webhook is not configured' };
  }

  const message = `Product not found in catalog\nQuery: ${cleanedQuery}\nSource: ${source || 'lookup'}`;
  const payload = {
    text: message,
    content: message,
    event: 'product_not_found',
    query: cleanedQuery,
    source: source || 'lookup',
    timestamp: new Date().toISOString()
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return { ok: false, status: 502, error: 'Webhook notification failed' };
  }

  return { ok: true, status: 200, notified: true };
}

module.exports = { getWebhookUrl, notifyMissingProduct };
