const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTjjCLIzwdPBmQTGQTnQVGibBsW4tT_QiiJMaILAiWbWEBYP0o-occX3ZXhwfStws40Y8NSWHbur02h/pub?gid=0&single=true&output=csv';

const state = {
  products: [],
  stream: null,
  detector: null,
  scanTimer: null,
  scanContext: null,
  imageScanner: null,
  cameraScanner: null,
  handlingScan: false
};

const $ = (selector) => document.querySelector(selector);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.toLowerCase().trim());
  return rows.map((values) => {
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    return normalizeProduct(raw);
  }).filter((product) => product.barcode || product.name);
}

function pickField(row, keys) {
  for (const key of keys) {
    if (row[key]) return row[key];
  }
  return '';
}

function parsePrice(value) {
  const number = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function normalizeProduct(row) {
  return {
    barcode: String(pickField(row, ['barcode', 'ean', 'upc', 'qr', 'sku', 'code'])).replace(/\s/g, ''),
    name: pickField(row, ['name', 'product', 'product name', 'item']),
    brand: pickField(row, ['brand', 'company']),
    category: pickField(row, ['category', 'type']),
    mrp: parsePrice(pickField(row, ['mrp', 'max retail price', 'list price'])),
    discount_price: parsePrice(pickField(row, ['discount_price', 'discount price', 'selling price', 'offer price', 'sale price']))
  };
}

async function loadCatalog() {
  const sources = [SHEET_CSV_URL, '/api/catalog'];
  let lastError = null;

  for (const source of sources) {
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error('catalog unavailable');
      const products = parseCsv(await response.text());
      if (!products.length) throw new Error('empty catalog');
      state.products = products;
      $('#productCount').textContent = `${state.products.length} products connected`;
      renderTiles(state.products.slice(0, 6));
      return;
    } catch (error) {
      lastError = error;
    }
  }

  console.error(lastError);
  $('#productCount').textContent = 'Catalog connection failed';
  showFeedback('Could not load the Google Sheet. Check your connection and try again.');
}

function money(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

function discountPercent(product) {
  const mrp = Number(product.mrp);
  const price = Number(product.discount_price);
  return mrp > 0 ? Math.round(((mrp - price) / mrp) * 100) : 0;
}

function normalizeBarcode(value) {
  return String(value || '').replace(/\D/g, '');
}

function barcodesMatch(left, right) {
  const a = normalizeBarcode(left);
  const b = normalizeBarcode(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.replace(/^0+/, '') === b.replace(/^0+/, '');
}

function candidateCodes(value) {
  const text = String(value || '').trim();
  const matches = text.match(/\d{8,14}/g) || [];
  return [...new Set([text.replace(/\s/g, ''), ...matches])].filter(Boolean);
}

function findProductByBarcode(value) {
  return state.products.find((product) => candidateCodes(value).some((code) => barcodesMatch(product.barcode, code))) || null;
}

function normalizeText(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function searchProducts(query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];
  return state.products.filter((product) => normalizeText(`${product.name} ${product.brand} ${product.category} ${product.barcode}`).includes(normalizedQuery));
}

function findProductFromText(text) {
  const words = new Set(normalizeText(text).split(' ').filter((word) => word.length > 2));
  let bestProduct = null;
  let bestScore = 0;

  state.products.forEach((product) => {
    const productWords = new Set(normalizeText(`${product.brand} ${product.name}`).split(' ').filter((word) => word.length > 2));
    const matchedWords = [...words].filter((word) => productWords.has(word));
    const score = matchedWords.length / Math.max(3, Math.min(productWords.size, 10));
    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  });

  return bestScore >= 0.3 ? bestProduct : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;'
  }[character]));
}

function showFeedback(message, isOk = false) {
  $('#feedback').textContent = message;
  $('#feedback').classList.toggle('is-ok', Boolean(isOk));
}

async function notifyProductNotFound(query, source) {
  try {
    const response = await fetch('/api/not-found', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, source })
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function showProduct(product, query = '', source = 'lookup') {
  if (!product) {
    $('#resultSection').hidden = true;
    showFeedback('No product found. Notifying the team...');
    const notified = await notifyProductNotFound(query, source);
    showFeedback(
      notified
        ? 'No product found. We have notified the team.'
        : 'No product found. Add a webhook URL in webhook.json to notify the team.',
      notified
    );
    return;
  }

  const saving = Math.max(0, Number(product.mrp) - Number(product.discount_price));
  $('#resultCard').innerHTML = `
    <div>
      <p class="section-kicker">MATCH FOUND</p>
      <h3>${escapeHtml(product.name)}</h3>
      <p class="result-meta">${escapeHtml(product.brand)} · ${escapeHtml(product.category)} · ${escapeHtml(product.barcode)}</p>
    </div>
    <div class="price-box">
      <small>DISCOUNT PRICE</small>
      <strong class="sale-price">${money(product.discount_price)}</strong>
      <span class="discount-badge">${discountPercent(product)}% OFF</span>
      <span class="mrp">MRP ${money(product.mrp)}</span>
      <span class="saving">Save ${money(saving)}</span>
    </div>
  `;
  $('#resultSection').hidden = false;
  $('#resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showFeedback('');
}

function renderTiles(products) {
  $('#productGrid').innerHTML = products.map((product) => `
    <article class="product-tile" data-barcode="${escapeHtml(product.barcode)}">
      <span class="tile-brand">${escapeHtml(product.brand)}</span>
      <h3>${escapeHtml(product.name)}</h3>
      <strong class="tile-price">${money(product.discount_price)}</strong>
      <span class="tile-mrp">${money(product.mrp)}</span>
      <span class="tile-discount">${discountPercent(product)}% OFF</span>
    </article>
  `).join('');

  document.querySelectorAll('.product-tile').forEach((tile) => {
    tile.addEventListener('click', () => showProduct(findProductByBarcode(tile.dataset.barcode)));
  });
}

function resolveScan(rawValue) {
  const query = String(rawValue || '').trim();
  const byBarcode = findProductByBarcode(query);
  if (byBarcode) return { product: byBarcode, matches: [byBarcode], query };

  const matches = searchProducts(query);
  if (matches.length === 1) return { product: matches[0], matches, query };

  const fromText = findProductFromText(query);
  if (fromText && !matches.length) return { product: fromText, matches: [fromText], query };

  return { product: null, matches, query };
}

function handleLookup(rawValue, source) {
  const { product, matches, query } = resolveScan(rawValue);
  if (product) {
    showProduct(product, query, source);
    return;
  }
  if (matches.length > 1) {
    renderTiles(matches);
    showFeedback(`${matches.length} products found. Select one below.`);
    $('#productGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  showProduct(null, query, source);
}

function onDecoded(text, source) {
  const value = String(text || '').trim();
  if (!value || state.handlingScan) return;
  state.handlingScan = true;
  $('#barcodeInput').value = value;
  showFeedback('Code scanned. Looking up price...', true);
  handleLookup(value, source);
  stopCamera();
}

function getScanContext() {
  const canvas = $('#scanCanvas');
  if (!canvas) return null;
  if (!state.scanContext) {
    state.scanContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  return { canvas, context: state.scanContext };
}

function decodeQrFromImageData(imageData) {
  if (!window.jsQR || !imageData) return null;
  const result = window.jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth'
  });
  return result?.data || null;
}

function decodeQrFromVideo(video) {
  if (!video?.videoWidth || !window.jsQR) return null;
  const scan = getScanContext();
  if (!scan) return null;

  const maxSize = 720;
  const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
  scan.canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
  scan.canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
  scan.context.drawImage(video, 0, 0, scan.canvas.width, scan.canvas.height);

  const full = scan.context.getImageData(0, 0, scan.canvas.width, scan.canvas.height);
  const fullResult = decodeQrFromImageData(full);
  if (fullResult) return fullResult;

  const cropSize = Math.floor(Math.min(scan.canvas.width, scan.canvas.height) * 0.72);
  const cropX = Math.floor((scan.canvas.width - cropSize) / 2);
  const cropY = Math.floor((scan.canvas.height - cropSize) / 2);
  const crop = scan.context.getImageData(cropX, cropY, cropSize, cropSize);
  return decodeQrFromImageData(crop);
}

function decodeQrFromFile(file) {
  return new Promise((resolve) => {
    if (!window.jsQR) {
      resolve(null);
      return;
    }

    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const maxSize = 1200;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.floor(image.width * scale));
        canvas.height = Math.max(1, Math.floor(image.height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(decodeQrFromImageData(context.getImageData(0, 0, canvas.width, canvas.height)));
      } catch (error) {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

async function scanLoop() {
  if (!state.stream || state.handlingScan) return;
  const video = $('#camera');

  try {
    if (video.readyState >= 2) {
      if (state.detector) {
        const codes = await state.detector.detect(video);
        if (codes[0]?.rawValue) {
          onDecoded(codes[0].rawValue, 'camera qr or barcode');
          return;
        }
      }

      const qrValue = decodeQrFromVideo(video);
      if (qrValue) {
        onDecoded(qrValue, 'camera qr');
        return;
      }
    }
  } catch (error) {
    // Keep scanning if a single frame fails.
  }

  state.scanTimer = requestAnimationFrame(scanLoop);
}

async function createBarcodeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  const preferred = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'data_matrix'];
  try {
    const supported = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : preferred;
    const formats = preferred.filter((format) => supported.includes(format));
    if (!formats.includes('qr_code') && supported.includes('qr_code')) formats.unshift('qr_code');
    return new BarcodeDetector({ formats: formats.length ? formats : ['qr_code'] });
  } catch (error) {
    try {
      return new BarcodeDetector({ formats: ['qr_code'] });
    } catch (fallbackError) {
      return null;
    }
  }
}

async function openCameraStream() {
  const attempts = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { video: { facingMode: 'environment' } },
    { video: true }
  ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showFeedback('Camera access needs HTTPS or localhost. Open the app from http://localhost:5173, then allow camera permission.');
    return;
  }

  if (!window.jsQR && !('BarcodeDetector' in window)) {
    showFeedback('QR scanning could not load. Check your internet connection and refresh the page.');
    return;
  }

  try {
    state.handlingScan = false;
    $('#cameraWrap').hidden = false;
    document.querySelector('.scanner-card')?.classList.add('is-scanning');
    showFeedback('Point a QR code at the camera. Hold it still for a moment.');

    state.detector = await createBarcodeDetector();
    state.stream = await openCameraStream();
    const video = $('#camera');
    video.srcObject = state.stream;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    await video.play();
    scanLoop();
  } catch (error) {
    console.error(error);
    stopCamera();
    showFeedback('Camera permission was denied or unavailable. Allow camera access and try again.');
  }
}

function stopCamera() {
  if (state.scanTimer) cancelAnimationFrame(state.scanTimer);
  state.scanTimer = null;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.detector = null;
  const video = $('#camera');
  if (video) {
    video.srcObject = null;
  }

  if (state.cameraScanner) {
    const scanner = state.cameraScanner;
    state.cameraScanner = null;
    scanner.stop().catch(() => {}).finally(() => {
      scanner.clear().catch(() => {});
    });
  }

  $('#cameraWrap').hidden = true;
  document.querySelector('.scanner-card')?.classList.remove('is-scanning');
}

async function scanImage(file) {
  if (!file) return;
  showFeedback('Reading QR code or barcode...');

  try {
    const qrValue = await decodeQrFromFile(file);
    if (qrValue) {
      $('#barcodeInput').value = qrValue;
      handleLookup(qrValue, 'product image qr');
      return;
    }

    if (window.Html5Qrcode) {
      if (!state.imageScanner) state.imageScanner = new Html5Qrcode('imageReader');
      const decodedText = await state.imageScanner.scanFile(file, true);
      $('#barcodeInput').value = decodedText;
      handleLookup(decodedText, 'product image qr or barcode');
      return;
    }
  } catch (barcodeError) {
    if (!window.Tesseract) {
      showFeedback('No QR or barcode found. Use a clear product photo or enter the barcode manually.');
      return;
    }

    try {
      showFeedback('Reading product name from image...');
      const result = await Tesseract.recognize(file, 'eng');
      const query = result.data.text;
      const product = findProductByBarcode(query) || findProductFromText(query);
      if (product) {
        showProduct(product, query, 'product image text');
      } else {
        showProduct(null, query, 'product image text');
      }
    } catch (ocrError) {
      showFeedback('Could not read the product image. Try a clearer, well-lit photo.');
    }
    return;
  } finally {
    if (state.imageScanner) {
      try {
        await state.imageScanner.clear();
      } catch (error) {
        // Ignore scanner cleanup errors.
      }
      state.imageScanner = null;
    }
    $('#imageInput').value = '';
  }

  showFeedback('No QR or barcode found. Use a clearer photo or enter the code manually.');
}

$('#lookupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('#barcodeInput').value.trim();
  if (!query) {
    showFeedback('Enter a barcode, QR value, or product name.');
    return;
  }
  handleLookup(query, 'name or barcode search');
});

$('#startCamera').addEventListener('click', startCamera);
$('#stopCamera').addEventListener('click', stopCamera);
$('#imageInput').addEventListener('change', (event) => scanImage(event.target.files[0]));
$('#clearSearch').addEventListener('click', () => {
  renderTiles(state.products.slice(0, 6));
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});

loadCatalog();
