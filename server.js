// ═══════════════════════════════════════════════════════════════
// 프로틴 트래커 서버 — 네이티브 모듈 없는 순수 JS 버전
// JSON 파일 스토리지 + node-fetch v2
// ═══════════════════════════════════════════════════════════════
const express      = require('express');
const fetch        = require('node-fetch');
const cheerio      = require('cheerio');
const cron         = require('node-cron');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT      = process.env.PORT      || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-secret-key';
const DATA_FILE = process.env.DB_PATH   || path.join(__dirname, 'data.json');
const SITE_URL  = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── 데이터 스토어 ─────────────────────────────────────────────
let store = { products: [], priceHistory: {}, updateLog: [] };

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    store = JSON.parse(raw);
    if (!store.products)     store.products = [];
    if (!store.priceHistory) store.priceHistory = {};
    if (!store.updateLog)    store.updateLog = [];
  } catch {
    store = { products: [], priceHistory: {}, updateLog: [] };
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function seedDefaults() {
  const DEFAULTS = [
    {id:'c1',category:'chicken',emoji:'🍗',brand:'하림',   name:'무항생제 닭가슴살',   weight:'1kg',  baseWeight:1000,origPrice:12000},
    {id:'c2',category:'chicken',emoji:'🍗',brand:'올품',   name:'냉동 닭안심',         weight:'500g', baseWeight:500, origPrice:7500 },
    {id:'c3',category:'chicken',emoji:'🍗',brand:'참프레', name:'생 닭다리살',         weight:'1kg',  baseWeight:1000,origPrice:9000 },
    {id:'p1',category:'pork',   emoji:'🥩',brand:'도드람', name:'국내산 삼겹살',       weight:'500g', baseWeight:500, origPrice:16000},
    {id:'p2',category:'pork',   emoji:'🥩',brand:'한돈',   name:'앞다리살 불고기용',   weight:'1kg',  baseWeight:1000,origPrice:13500},
    {id:'p3',category:'pork',   emoji:'🥩',brand:'도드람', name:'목살 제육용',         weight:'1kg',  baseWeight:1000,origPrice:15000},
    {id:'b1',category:'beef',   emoji:'🐄',brand:'호주산', name:'그레인페드 부채살',   weight:'500g', baseWeight:500, origPrice:20000},
    {id:'b2',category:'beef',   emoji:'🐄',brand:'미국산', name:'척아이롤 스테이크용', weight:'1kg',  baseWeight:1000,origPrice:24000},
    {id:'b3',category:'beef',   emoji:'🐄',brand:'한우',   name:'국거리·불고기 혼합',  weight:'300g', baseWeight:300, origPrice:35000},
    {id:'f1',category:'fish',   emoji:'🐟',brand:'노르웨이산',name:'생연어 횟감용',    weight:'500g', baseWeight:500, origPrice:19000},
    {id:'f2',category:'fish',   emoji:'🐟',brand:'국내산', name:'손질 고등어 3마리',   weight:'700g', baseWeight:700, origPrice:11000},
    {id:'f3',category:'fish',   emoji:'🐟',brand:'동원',   name:'참치캔 프리미엄',     weight:'150g×4',baseWeight:600,origPrice:7200 },
    {id:'e1',category:'eggs',   emoji:'🥚',brand:'풀무원', name:'GAPS 특란',           weight:'30구', baseWeight:1800,origPrice:9500 },
    {id:'e2',category:'eggs',   emoji:'🥚',brand:'그리너스',name:'무항생제 계란',      weight:'15구', baseWeight:900, origPrice:7000 },
    {id:'e3',category:'eggs',   emoji:'🥚',brand:'자연애', name:'동물복지 방목란',     weight:'10구', baseWeight:600, origPrice:8500 },
  ];
  for (const d of DEFAULTS) {
    if (!store.products.find(p => p.id === d.id)) {
      store.products.push({ ...d, coupangUrl:'', imageUrl:'', isActive:true,
        createdAt: Date.now(), updatedAt: Date.now() });
      store.priceHistory[d.id] = [];
    }
  }
  saveData();
}

// ─── 가격 파싱 ─────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function resolveUrl(url) {
  try {
    const r = await fetch(url, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': UA },
      timeout: 12000
    });
    return r.url || url;
  } catch { return url; }
}

async function fetchCoupangInfo(url) {
  const finalUrl = await resolveUrl(url);
  const r = await fetch(finalUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://www.coupang.com/',
    },
    timeout: 15000
  });
  const html = await r.text();
  const $ = cheerio.load(html);
  let price = null, name = null, imageUrl = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (price) return;
    try {
      const d = JSON.parse($(el).html());
      const items = Array.isArray(d) ? d : [d];
      items.forEach(item => {
        if (item['@type'] === 'Product') {
          if (item.offers?.price) price = parseInt(String(item.offers.price).replace(/[^0-9]/g, ''));
          if (!name && item.name) name = item.name;
          if (!imageUrl) imageUrl = Array.isArray(item.image) ? item.image[0] : item.image;
        }
      });
    } catch {}
  });
  if (!price) {
    const og = $('meta[property="product:price:amount"]').attr('content');
    if (og) price = parseInt(og.replace(/[^0-9]/g, ''));
  }
  if (!name) name = $('meta[property="og:title"]').attr('content') || $('title').text().split(/[-–|]/)[0].trim();
  if (!imageUrl) imageUrl = $('meta[property="og:image"]').attr('content');
  if (!price) {
    for (const sel of ['.prod-price .total-price strong', '#productPrice', '.price-wrap strong']) {
      const txt = $(sel).first().text().replace(/[^0-9]/g, '');
      if (txt && parseInt(txt) > 100) { price = parseInt(txt); break; }
    }
  }
  if (!price) {
    const m = html.match(/"price"\s*:\s*"?(\d{3,7})"?/);
    if (m) price = parseInt(m[1]);
  }
  return { price, name: name?.substring(0, 100), imageUrl, finalUrl };
}

// ─── 전체 가격 업데이트 ────────────────────────────────────────
async function updateAllPrices(triggeredBy = 'cron') {
  const linked = store.products.filter(p => p.isActive && p.coupangUrl);
  if (!linked.length) return { success: 0, failed: 0 };
  const logEntry = { id: uuidv4(), started: Date.now(), finished: null, success: 0, failed: 0, note: triggeredBy };
  store.updateLog.push(logEntry);
  if (store.updateLog.length > 100) store.updateLog = store.updateLog.slice(-100);

  for (const p of linked) {
    try {
      const info = await fetchCoupangInfo(p.coupangUrl);
      if (info.price && info.price > 100 && info.price < 10000000) {
        if (!store.priceHistory[p.id]) store.priceHistory[p.id] = [];
        store.priceHistory[p.id].push({ price: info.price, ts: Date.now(), source: triggeredBy });
        if (store.priceHistory[p.id].length > 180) store.priceHistory[p.id] = store.priceHistory[p.id].slice(-180);
        p.updatedAt = Date.now();
        logEntry.success++;
        console.log(`[UPDATE] ${p.name}: ${info.price.toLocaleString()}원`);
      } else { logEntry.failed++; }
    } catch (e) { logEntry.failed++; console.error(`[ERROR] ${p.name}:`, e.message); }
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
  }
  logEntry.finished = Date.now();
  saveData();
  console.log(`[CRON] 완료: 성공 ${logEntry.success}, 실패 ${logEntry.failed}`);
  return { success: logEntry.success, failed: logEntry.failed };
}

cron.schedule('0 */2 * * *', () => {
  console.log('[CRON] 2시간 자동 업데이트 시작...');
  updateAllPrices('auto-cron');
});

// ─── 미들웨어 ──────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use('/api/', rateLimit({ windowMs: 60000, max: 60 }));

function checkAdmin(req, res, next) {
  if ((req.headers['x-admin-key'] || req.query.adminKey) !== ADMIN_KEY)
    return res.status(401).json({ error: '인증 필요' });
  next();
}

// ─── 응답 빌더 ─────────────────────────────────────────────────
function buildProductResponse(p) {
  const hist = (store.priceHistory[p.id] || []).slice(-90);
  const prices = hist.map(h => h.price);
  const currentPrice = prices.length ? prices[prices.length - 1] : null;
  let stats = null;
  if (prices.length >= 2) {
    const mn = Math.min(...prices), mx = Math.max(...prices);
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const pct = mx === mn ? 50 : Math.round((currentPrice - mn) / (mx - mn) * 100);
    const r7 = prices.slice(-7);
    stats = { min90: mn, max90: mx, avg90: avg,
      percentile: Math.max(0, Math.min(100, pct)),
      weekDiff: r7.length >= 2 ? r7[r7.length-1] - r7[0] : 0 };
  }
  return {
    id: p.id, category: p.category, emoji: p.emoji,
    brand: p.brand, name: p.name, weight: p.weight,
    baseWeight: p.baseWeight, origPrice: p.origPrice,
    coupangUrl: p.coupangUrl || '', imageUrl: p.imageUrl || '',
    currentPrice, history: prices, stats,
    unit100: currentPrice ? Math.round(currentPrice / p.baseWeight * 100) : null,
    dcRate: (currentPrice && p.origPrice) ? Math.max(0, Math.round((1 - currentPrice / p.origPrice) * 100)) : 0,
    hasLink: !!p.coupangUrl, updatedAt: p.updatedAt
  };
}

// ─── API 라우트 ────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const products = store.products.filter(p => p.isActive)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  res.json(products.map(buildProductResponse));
});

app.get('/api/products/:id', (req, res) => {
  const p = store.products.find(p => p.id === req.params.id && p.isActive);
  if (!p) return res.status(404).json({ error: '상품 없음' });
  res.json(buildProductResponse(p));
});

app.post('/api/preview-link', checkAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필요' });
  try { res.json(await fetchCoupangInfo(url)); }
  catch (e) { res.status(500).json({ error: '파싱 실패: ' + e.message }); }
});

app.post('/api/products', checkAdmin, async (req, res) => {
  const { id, category, name, brand, weight, baseWeight, origPrice, coupangUrl, emoji } = req.body;
  if (!category || !name) return res.status(400).json({ error: '카테고리·상품명 필수' });
  const pid = id || uuidv4().split('-')[0];
  const existing = store.products.findIndex(p => p.id === pid);
  const product = {
    id: pid, category, name, brand: brand || '', weight: weight || '',
    baseWeight: baseWeight || 100, origPrice: origPrice || null,
    coupangUrl: coupangUrl || '', imageUrl: '', emoji: emoji || '🥩',
    isActive: true, createdAt: existing >= 0 ? store.products[existing].createdAt : Date.now(),
    updatedAt: Date.now()
  };
  if (existing >= 0) store.products[existing] = product;
  else { store.products.push(product); store.priceHistory[pid] = []; }
  if (coupangUrl) {
    try {
      const info = await fetchCoupangInfo(coupangUrl);
      if (info.price) {
        store.priceHistory[pid].push({ price: info.price, ts: Date.now(), source: 'manual' });
        if (info.imageUrl) product.imageUrl = info.imageUrl;
      }
    } catch {}
  }
  saveData();
  res.json({ success: true, id: pid });
});

app.patch('/api/products/:id', checkAdmin, async (req, res) => {
  const pid = req.params.id;
  const p = store.products.find(p => p.id === pid);
  if (!p) return res.status(404).json({ error: '상품 없음' });
  const { coupangUrl, manualPrice, origPrice, name, brand } = req.body;
  if (coupangUrl !== undefined) p.coupangUrl = coupangUrl;
  if (origPrice !== undefined)  p.origPrice  = origPrice;
  if (name !== undefined)       p.name       = name;
  if (brand !== undefined)      p.brand      = brand;
  if (manualPrice && parseInt(manualPrice) > 0) {
    if (!store.priceHistory[pid]) store.priceHistory[pid] = [];
    store.priceHistory[pid].push({ price: parseInt(manualPrice), ts: Date.now(), source: 'manual' });
  }
  let fetchedPrice = null;
  if (coupangUrl) {
    try {
      const info = await fetchCoupangInfo(coupangUrl);
      if (info.price) {
        store.priceHistory[pid].push({ price: info.price, ts: Date.now(), source: 'auto' });
        fetchedPrice = info.price;
        if (info.imageUrl) p.imageUrl = info.imageUrl;
      }
    } catch {}
  }
  p.updatedAt = Date.now();
  saveData();
  res.json({ success: true, fetchedPrice });
});

app.delete('/api/products/:id', checkAdmin, (req, res) => {
  const p = store.products.find(p => p.id === req.params.id);
  if (p) { p.isActive = false; saveData(); }
  res.json({ success: true });
});

app.post('/api/update-prices', checkAdmin, (req, res) => {
  res.json({ success: true, message: '업데이트 시작. 수분 소요.' });
  updateAllPrices('manual-admin');
});

app.get('/api/status', (req, res) => {
  const logs = store.updateLog;
  res.json({
    lastUpdate: logs.length ? logs[logs.length - 1] : null,
    total: store.products.filter(p => p.isActive).length,
    linked: store.products.filter(p => p.isActive && p.coupangUrl).length
  });
});

// ─── SEO ───────────────────────────────────────────────────────
app.get('/robots.txt', (_, res) => res.type('text/plain').send(
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml`));

app.get('/sitemap.xml', (_, res) => {
  const now = new Date().toISOString().split('T')[0];
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    `<url><loc>${SITE_URL}/</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>` +
    ['chicken','pork','beef','fish','eggs'].map(c =>
      `<url><loc>${SITE_URL}/?cat=${c}</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`
    ).join('') + `</urlset>`);
});

// ─── 서버 시작 ─────────────────────────────────────────────────
loadData();
seedDefaults();
app.listen(PORT, () => {
  console.log(`🥩 프로틴 트래커 → http://localhost:${PORT}`);
  console.log(`   어드민 키: ${ADMIN_KEY}`);
  console.log(`   데이터: ${DATA_FILE}`);
});
