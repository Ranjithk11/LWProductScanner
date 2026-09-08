const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTjjCLIzwdPBmQTGQTnQVGibBsW4tT_QiiJMaILAiWbWEBYP0o-occX3ZXhwfStws40Y8NSWHbur02h/pub?gid=0&single=true&output=csv';

const state = {
  products: [],
  stream: null,
  detector: null,
  scanTimer: null,
  scanWaitTimer: null,
  scanContext: null,
  zxingReader: null,
  scanTick: 0,
  imageScanner: null,
  cameraScanner: null,
  handlingScan: false,
  waitingForUser: false
};

const SCAN_TIMEOUT_MS = 12000;

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
  clearScanWait();
  hideScanHelp();
  $('#barcodeInput').value = value;
  showFeedback('Code scanned. Looking up price...', true);
  handleLookup(value, source);
  stopCamera();
}

function hideScanHelp() {
  const help = $('#scanHelp');
  if (help) help.hidden = true;
  state.waitingForUser = false;
}

function showScanHelp() {
  if (state.handlingScan) return;
  if (!state.stream && !state.cameraScanner) return;
  state.waitingForUser = true;
  if (state.scanTimer) cancelAnimationFrame(state.scanTimer);
  state.scanTimer = null;
  const help = $('#scanHelp');
  if (help) help.hidden = false;
  showFeedback('We could not read the barcode. Type the numbers under it or upload a photo.');
}

function clearScanWait() {
  if (state.scanWaitTimer) {
    clearTimeout(state.scanWaitTimer);
    state.scanWaitTimer = null;
  }
}

function armScanWait() {
  clearScanWait();
  state.scanWaitTimer = setTimeout(showScanHelp, SCAN_TIMEOUT_MS);
}

function getScanContext() {
  const canvas = $('#scanCanvas');
  if (!canvas) return null;
  if (!state.scanContext) {
    state.scanContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  return { canvas, context: state.scanContext };
}

function drawVideoFrame(video) {
  if (!video?.videoWidth) return null;
  const scan = getScanContext();
  if (!scan) return null;
  const maxSize = 900;
  const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
  scan.canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
  scan.canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
  scan.context.drawImage(video, 0, 0, scan.canvas.width, scan.canvas.height);
  return scan;
}

function decodeQrFromImageData(imageData) {
  if (!window.jsQR || !imageData) return null;
  const result = window.jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth'
  });
  return result?.data || null;
}

function getZxingReader() {
  if (state.zxingReader) return state.zxingReader;
  if (!window.ZXing?.MultiFormatReader) return null;

  const hints = new Map();
  const formats = [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
    ZXing.BarcodeFormat.CODE_128,
    ZXing.BarcodeFormat.CODE_39,
    ZXing.BarcodeFormat.QR_CODE,
    ZXing.BarcodeFormat.DATA_MATRIX
  ].filter(Boolean);
  if (ZXing.DecodeHintType) {
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  }

  const reader = new ZXing.MultiFormatReader();
  if (reader.setHints) reader.setHints(hints);
  state.zxingReader = reader;
  return reader;
}

function toGrayscale(imageData) {
  const gray = new Uint8ClampedArray(imageData.width * imageData.height);
  const data = imageData.data;
  for (let index = 0, pixel = 0; index < gray.length; index += 1, pixel += 4) {
    gray[index] = (data[pixel] * 0.299 + data[pixel + 1] * 0.587 + data[pixel + 2] * 0.114) | 0;
  }
  return gray;
}

function decodeZxingFromCanvas(canvas) {
  const reader = getZxingReader();
  if (!reader || !canvas?.width) return null;

  try {
    let source = null;
    if (ZXing.HTMLCanvasElementLuminanceSource) {
      source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    } else if (ZXing.RGBLuminanceSource) {
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      source = new ZXing.RGBLuminanceSource(toGrayscale(image), canvas.width, canvas.height);
    }
    if (!source) return null;
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
    const result = reader.decode(bitmap);
    if (reader.reset) reader.reset();
    return result?.getText?.() || result?.text || null;
  } catch (error) {
    if (reader.reset) {
      try { reader.reset(); } catch (resetError) { /* ignore */ }
    }
    return null;
  }
}

function decodeFromVideo(video) {
  const scan = drawVideoFrame(video);
  if (!scan) return null;

  const zxingFull = decodeZxingFromCanvas(scan.canvas);
  if (zxingFull) return zxingFull;

  const strip = document.createElement('canvas');
  const stripWidth = scan.canvas.width;
  const stripHeight = Math.max(40, Math.floor(scan.canvas.height * 0.38));
  strip.width = stripWidth;
  strip.height = stripHeight;
  strip.getContext('2d').drawImage(
    scan.canvas,
    0,
    Math.floor((scan.canvas.height - stripHeight) / 2),
    stripWidth,
    stripHeight,
    0,
    0,
    stripWidth,
    stripHeight
  );
  const zxingStrip = decodeZxingFromCanvas(strip);
  if (zxingStrip) return zxingStrip;

  const full = scan.context.getImageData(0, 0, scan.canvas.width, scan.canvas.height);
  return decodeQrFromImageData(full);
}

function decodeQrFromFile(file) {
  return new Promise((resolve) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const maxSize = 1400;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.floor(image.width * scale));
        canvas.height = Math.max(1, Math.floor(image.height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(decodeZxingFromCanvas(canvas) || decodeQrFromImageData(context.getImageData(0, 0, canvas.width, canvas.height)));
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
  if (!state.stream || state.handlingScan || state.waitingForUser) return;
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

      state.scanTick += 1;
      if (state.scanTick % 2 === 0) {
        const decoded = decodeFromVideo(video);
        if (decoded) {
          onDecoded(decoded, 'camera qr or barcode');
          return;
        }
      }
    }
  } catch (error) {
    // Keep scanning if a single frame fails.
  }

  state.scanTimer = requestAnimationFrame(scanLoop);
}

async function createBarcodeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  const preferred = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'data_matrix'];
  try {
    const supported = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : preferred;
    const formats = preferred.filter((format) => supported.includes(format));
    return new BarcodeDetector({ formats: formats.length ? formats : supported });
  } catch (error) {
    try {
      return new BarcodeDetector();
    } catch (fallbackError) {
      return null;
    }
  }
}

async function openCameraStream() {
  const attempts = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
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

function html5BarcodeFormats() {
  const formats = window.Html5QrcodeSupportedFormats;
  if (!formats) return undefined;
  return [
    formats.EAN_13,
    formats.EAN_8,
    formats.UPC_A,
    formats.UPC_E,
    formats.CODE_128,
    formats.CODE_39,
    formats.QR_CODE,
    formats.DATA_MATRIX
  ].filter((format) => format !== undefined);
}

async function pickBackCameraId() {
  if (!window.Html5Qrcode?.getCameras) return null;
  try {
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras?.length) return null;
    const back = cameras.find((camera) => /back|rear|environment/i.test(camera.label || ''));
    return (back || cameras[0]).id;
  } catch (error) {
    return null;
  }
}

async function startHtml5BarcodeScanner() {
  if (!window.Html5Qrcode) return false;
  const reader = $('#cameraReader');
  if (!reader) return false;
  reader.innerHTML = '';
  $('#camera').hidden = true;

  state.cameraScanner = new Html5Qrcode('cameraReader', { verbose: false });
  const config = {
    fps: 12,
    disableFlip: false,
    qrbox: (viewfinderWidth, viewfinderHeight) => {
      const width = Math.max(220, Math.floor(viewfinderWidth * 0.92));
      const height = Math.max(80, Math.floor(Math.min(viewfinderHeight * 0.32, 160)));
      return { width, height };
    }
  };
  const formats = html5BarcodeFormats();
  if (formats) config.formatsToSupport = formats;

  const onScan = (decodedText) => {
    onDecoded(decodedText, 'camera barcode');
  };

  const cameraId = await pickBackCameraId();
  const cameraConfig = cameraId || { facingMode: 'environment' };

  try {
    await state.cameraScanner.start(cameraConfig, config, onScan, () => {});
    return true;
  } catch (error) {
    try {
      await state.cameraScanner.start({ facingMode: 'environment' }, config, onScan, () => {});
      return true;
    } catch (fallbackError) {
      try {
        await state.cameraScanner.clear();
      } catch (clearError) {
        // Ignore.
      }
      state.cameraScanner = null;
      return false;
    }
  }
}

async function startNativeScanner() {
  $('#camera').hidden = false;
  state.detector = await createBarcodeDetector();
  state.stream = await openCameraStream();
  const video = $('#camera');
  video.srcObject = state.stream;
  video.muted = true;
  video.setAttribute('playsinline', 'true');
  await video.play();
  scanLoop();
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showFeedback('Camera access needs HTTPS or localhost. Allow camera permission and try again.');
    return;
  }

  try {
    state.handlingScan = false;
    state.waitingForUser = false;
    state.scanTick = 0;
    hideScanHelp();
    $('#cameraWrap').hidden = false;
    document.querySelector('.scanner-card')?.classList.add('is-scanning');
    showFeedback('Hold the barcode inside the frame.');

    const startedHtml5 = await startHtml5BarcodeScanner();
    if (!startedHtml5) {
      await startNativeScanner();
    }
    armScanWait();
  } catch (error) {
    console.error(error);
    stopCamera();
    showFeedback('Camera permission was denied or unavailable. Allow camera access and try again.');
  }
}

function resumeScanning() {
  hideScanHelp();
  showFeedback('Hold the barcode inside the frame.');
  armScanWait();
  if (state.cameraScanner) return;
  if (state.stream) {
    scanLoop();
    return;
  }
  startCamera();
}

function typeBarcodeInstead() {
  stopCamera();
  showFeedback('Type the numbers printed under the barcode, then search.');
  $('#barcodeInput').focus();
}

function stopCamera() {
  clearScanWait();
  hideScanHelp();
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
$('#typeBarcode').addEventListener('click', typeBarcodeInstead);
$('#keepScanning').addEventListener('click', resumeScanning);
$('#helpUpload').addEventListener('click', () => {
  stopCamera();
  $('#imageInput').click();
});
$('#imageInput').addEventListener('change', (event) => scanImage(event.target.files[0]));
$('#clearSearch').addEventListener('click', () => {
  renderTiles(state.products.slice(0, 6));
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});

loadCatalog();
