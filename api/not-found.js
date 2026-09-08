const { notifyMissingProduct } = require('../notify-missing');

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await notifyMissingProduct(request.body || {});
    if (!result.ok) {
      return response.status(result.status).json({ error: result.error });
    }
    return response.status(200).json({ notified: true });
  } catch (error) {
    return response.status(500).json({ error: 'Webhook request failed' });
  }
};
