// ═══════════════════════════════════════════════════════════════
// 프로틴 트래커 서버
// Express + SQLite + 쿠팡 가격 자동 파싱 + 2시간 크론 업데이트
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-secret-key'; // 반드시 환경변수로 변경

// ─── DB 초기화 ────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    name        TEXT NOT NULL,
    brand       TEXT NOT NULL DEFAULT '',
    weight      TEXT NOT NULL DEFAULT '',
    base_weight INTEGER NOT NULL DEFAULT 100,
    orig_price  INTEGER,
    coupang_url TEXT,
    image_url   TEXT,
    emoji       TEXT DEFAULT '🥩',
    is_active   INTEGER DEFAULT 1,
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    price      INTEGER NOT NULL,
    source     TEXT DEFAULT 'auto',
    ts         INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS update_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    started   INTEGER DEFAULT (unixepoch()),
    finished  INTEGER,
    success   INTEGER DEFAULT 0,
    failed    INTEGER DEFAULT 0,
    note      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ph_product ON price_history(product_id, ts DESC);
`);

// ─── 기본 상품 데이터 삽입 (처음 실행 시) ──────────────────────
const DEFAULTS = [
  { id:'c1', category:'chicken', emoji:'🍗', brand:'하림', name:'무항생제 닭가슴살', weight:'1kg', base_weight:1000, orig_price:12000 },
  { id:'c2', category:'chicken', emoji:'🍗', brand:'올품', name:'냉동 닭안심',       weight:'500g', base_weight:500,  orig_price:7500  },
  { id:'c3', category:'chicken', emoji:'🍗', brand:'참프레', name:'생 닭다리살',     weight:'1kg', base_weight:1000, orig_price:9000  },
  { id:'p1', category:'pork',    emoji:'🥩', brand:'도드람', name:'국내산 삼겹살',   weight:'500g', base_weight:500,  orig_price:16000 },
  { id:'p2', category:'pork',    emoji:'🥩', brand:'한돈', name:'앞다리살 불고기용', weight:'1kg', base_weight:1000, orig_price:13500 },
  { id:'p3', category:'pork',    emoji:'🥩', brand:'도드람', name:'목살 제육용',     weight:'1kg', base_weight:1000, orig_price:15000 },
  { id:'b1', category:'beef',    emoji:'🐄', brand:'호주산', name:'그레인페드 부채살',weight:'500g',base_weight:500,  orig_price:20000 },
  { id:'b2', category:'beef',    emoji:'🐄', brand:'미국산', name:'척아이롤 스테이크용',weight:'1kg',base_weight:1000,orig_price:24000 },
  { id:'b3', category:'beef',    emoji:'🐄', brand:'한우',  name:'국거리·불고기 혼합',weight:'300g',base_weight:300, orig_price:35000 },
  { id:'f1', category:'fish',    emoji:'🐟', brand:'노르웨이산', name:'생연어 횟감용',weight:'500g',base_weight:500, orig_price:19000 },
  { id:'f2', category:'fish',    emoji:'🐟', brand:'국내산', name:'손질 고등어 3마리',weight:'700g',base_weight:700, orig_price:11000 },
  { id:'f3', category:'fish',    emoji:'🐟', brand:'동원',  name:'참치캔 프리미엄', weight:'150g×4',base_weight:600,orig_price:7200  },
  { id:'e1', category:'eggs',    emoji:'🥚', brand:'풀무원', name:'GAPS 특란',       weight:'30구', base_weight:1800,orig_price:9500  },
  { id:'e2', category:'eggs',    emoji:'🥚', brand:'그리너스', name:'무항생제 계란', weight:'15구', base_weight:900, orig_price:7000  },
  { id:'e3', category:'eggs',    emoji:'🥚', brand:'자연애', name:'동물복지 방목란', weight:'10구', base_weight:600, orig_price:8500  },
];

const insertDefault = db.prepare(`
  INSERT OR IGNORE INTO products (id,category,emoji,brand,name,weight,base_weight,orig_price)
  VALUES (@id,@category,@emoji,@brand,@name,@weight,@base_weight,@orig_price)
`);
db.transaction(() => { DEFAULTS.forEach(p => insertDefault.run(p)); })();

// ─── 가격 파싱 ─────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function resolveUrl(shortUrl) {
  try {
    const r = await axios.get(shortUrl, {
      maxRedirects: 8,
      timeout: 12000,
      headers: { 'User-Agent': UA },
      validateStatus: s => s < 500
    });
    return r.request?.res?.responseUrl || r.config?.url || shortUrl;
  } catch(e) {
    return shortUrl;
  }
}

async function fetchCoupangInfo(url) {
  const finalUrl = await resolveUrl(url);

  const resp = await axios.get(finalUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://www.coupang.com/',
      'Cache-Control': 'no-cache',
    }
  });

  const $ = cheerio.load(resp.data);
  let price = null, name = null, imageUrl = null;

  // 방법 1: JSON-LD 구조화 데이터
  $('script[type="application/ld+json"]').each((_, el) => {
    if (price) return;
    try {
      const raw = $(el).html();
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      items.forEach(item => {
        if (item['@type'] === 'Product') {
          if (item.offers?.price) price = parseInt(String(item.offers.price).replace(/[^0-9]/g,''));
          if (!name && item.name) name = item.name;
          if (!imageUrl) imageUrl = Array.isArray(item.image) ? item.image[0] : item.image;
        }
      });
    } catch(e) {}
  });

  // 방법 2: og: meta 태그
  if (!price) {
    const og = $('meta[property="product:price:amount"]').attr('content')
            || $('meta[name="twitter:data1"]').attr('content');
    if (og) price = parseInt(og.replace(/[^0-9]/g,''));
  }
  if (!name) name = $('meta[property="og:title"]').attr('content') || $('title').text().replace(/[-–|].*$/,'').trim();
  if (!imageUrl) imageUrl = $('meta[property="og:image"]').attr('content');

  // 방법 3: DOM 선택자 (Coupang HTML 구조, 변경될 수 있음)
  if (!price) {
    const selectors = [
      '.prod-price .total-price strong',
      '#productPrice',
      '.price-wrap strong',
      '[class*="total-price"]',
      '.coupon-price strong',
    ];
    for (const sel of selectors) {
      const txt = $(sel).first().text().replace(/[^0-9]/g,'');
      if (txt && parseInt(txt) > 100) { price = parseInt(txt); break; }
    }
  }

  // 방법 4: 페이지 내 price 패턴 검색 (최후 수단)
  if (!price) {
    const html = resp.data;
    const m = html.match(/"price"\s*:\s*"?(\d{3,7})"?/);
    if (m) price = parseInt(m[1]);
  }

  return { price, name: name?.substring(0,100), imageUrl, finalUrl };
}

// ─── 전체 가격 업데이트 ────────────────────────────────────────
async function updateAllPrices(triggeredBy = 'cron') {
  const products = db.prepare(`
    SELECT id, name, coupang_url FROM products 
    WHERE coupang_url IS NOT NULL AND coupang_url != '' AND is_active = 1
  `).all();

  if (products.length === 0) return { success: 0, failed: 0 };

  const logId = db.prepare(`INSERT INTO update_log (note) VALUES (?)`).run(triggeredBy).lastInsertRowid;
  let success = 0, failed = 0;

  const insertPrice = db.prepare(`INSERT INTO price_history (product_id, price, source) VALUES (?, ?, ?)`);
  const updateTs    = db.prepare(`UPDATE products SET updated_at = unixepoch() WHERE id = ?`);

  for (const p of products) {
    try {
      const info = await fetchCoupangInfo(p.coupang_url);
      if (info.price && info.price > 100 && info.price < 10000000) {
        insertPrice.run(p.id, info.price, triggeredBy);
        updateTs.run(p.id);
        success++;
        console.log(`[UPDATE] ${p.name}: ${info.price.toLocaleString()}원`);
      } else {
        failed++;
        console.warn(`[WARN] ${p.name}: 가격 파싱 실패 (url: ${p.coupang_url})`);
      }
    } catch(e) {
      failed++;
      console.error(`[ERROR] ${p.name}:`, e.message);
    }
    // 쿠팡 rate-limit 방지: 2~4초 랜덤 대기
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
  }

  db.prepare(`UPDATE update_log SET finished=unixepoch(), success=?, failed=? WHERE id=?`)
    .run(success, failed, logId);

  console.log(`[CRON] 업데이트 완료: 성공 ${success}, 실패 ${failed}`);
  return { success, failed };
}

// 2시간마다 자동 업데이트
cron.schedule('0 */2 * * *', () => {
  console.log('[CRON] 가격 자동 업데이트 시작...');
  updateAllPrices('auto-cron');
});

// ─── 미들웨어 ──────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const apiLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

function checkAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: '인증 필요' });
  next();
}

// ─── 헬퍼 ─────────────────────────────────────────────────────
const getLatestPriceStmt = db.prepare(`
  SELECT price FROM price_history WHERE product_id = ? ORDER BY ts DESC LIMIT 1
`);
const getHistory90Stmt = db.prepare(`
  SELECT price, ts FROM price_history WHERE product_id = ? ORDER BY ts DESC LIMIT 90
`);

function buildProductResponse(p) {
  const latest = getLatestPriceStmt.get(p.id);
  const histRaw = getHistory90Stmt.all(p.id).reverse(); // 오래된 순
  const history = histRaw.map(h => h.price);
  const currentPrice = latest?.price || null;

  let stats = null;
  if (history.length >= 2) {
    const mn = Math.min(...history);
    const mx = Math.max(...history);
    const avg = Math.round(history.reduce((a,b)=>a+b,0)/history.length);
    const pct = mx === mn ? 50 : Math.round((currentPrice - mn)/(mx - mn)*100);
    const recent7 = history.slice(-7);
    const weekDiff = recent7.length >= 2 ? (recent7.at(-1) - recent7[0]) : 0;
    stats = { min90: mn, max90: mx, avg90: avg, percentile: Math.max(0,Math.min(100,pct)), weekDiff };
  }

  return {
    id: p.id, category: p.category, emoji: p.emoji,
    brand: p.brand, name: p.name, weight: p.weight,
    baseWeight: p.base_weight, origPrice: p.orig_price,
    coupangUrl: p.coupang_url || '', imageUrl: p.image_url || '',
    currentPrice, history, stats,
    unit100: currentPrice ? Math.round(currentPrice / p.base_weight * 100) : null,
    dcRate: (currentPrice && p.orig_price) ? Math.max(0, Math.round((1 - currentPrice/p.orig_price)*100)) : 0,
    hasLink: !!(p.coupang_url),
    updatedAt: p.updated_at
  };
}

// ─── API 라우트 ────────────────────────────────────────────────

// 전체 상품 목록
app.get('/api/products', (req, res) => {
  try {
    const products = db.prepare(`SELECT * FROM products WHERE is_active=1 ORDER BY category, name`).all();
    res.json(products.map(buildProductResponse));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 단일 상품
app.get('/api/products/:id', (req, res) => {
  try {
    const p = db.prepare(`SELECT * FROM products WHERE id=? AND is_active=1`).get(req.params.id);
    if (!p) return res.status(404).json({ error: '상품 없음' });
    res.json(buildProductResponse(p));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 쿠팡 링크에서 가격/정보 미리보기 (어드민)
app.post('/api/preview-link', checkAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필요' });
  try {
    const info = await fetchCoupangInfo(url);
    res.json(info);
  } catch(e) {
    res.status(500).json({ error: '가격 파싱 실패: ' + e.message });
  }
});

// 상품 추가/수정 (어드민)
app.post('/api/products', checkAdmin, async (req, res) => {
  const { id, category, name, brand, weight, baseWeight, origPrice, coupangUrl, emoji } = req.body;
  if (!category || !name) return res.status(400).json({ error: '카테고리와 상품명 필수' });

  const pid = id || uuidv4().split('-')[0];

  try {
    db.prepare(`
      INSERT INTO products (id, category, name, brand, weight, base_weight, orig_price, coupang_url, emoji)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category=excluded.category, name=excluded.name, brand=excluded.brand,
        weight=excluded.weight, base_weight=excluded.base_weight, orig_price=excluded.orig_price,
        coupang_url=excluded.coupang_url, emoji=excluded.emoji, updated_at=unixepoch()
    `).run(pid, category, name, brand||'', weight||'', baseWeight||100, origPrice||null, coupangUrl||null, emoji||'🥩');

    // 링크 있으면 즉시 가격 가져오기
    if (coupangUrl) {
      try {
        const info = await fetchCoupangInfo(coupangUrl);
        if (info.price) {
          db.prepare(`INSERT INTO price_history (product_id, price, source) VALUES (?,?,'manual')`).run(pid, info.price);
          if (info.imageUrl) db.prepare(`UPDATE products SET image_url=? WHERE id=?`).run(info.imageUrl, pid);
          console.log(`[ADD] ${name}: ${info.price.toLocaleString()}원`);
        }
      } catch(e) {
        console.warn(`[WARN] 즉시 가격 조회 실패: ${e.message}`);
      }
    }
    res.json({ success: true, id: pid });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 링크/가격 업데이트 (어드민)
app.patch('/api/products/:id', checkAdmin, async (req, res) => {
  const { coupangUrl, manualPrice, origPrice, name, brand } = req.body;
  const pid = req.params.id;
  try {
    const fields = [];
    const vals = [];
    if (coupangUrl !== undefined) { fields.push('coupang_url=?'); vals.push(coupangUrl); }
    if (origPrice !== undefined) { fields.push('orig_price=?'); vals.push(origPrice); }
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (brand !== undefined) { fields.push('brand=?'); vals.push(brand); }
    if (fields.length > 0) {
      fields.push('updated_at=unixepoch()');
      vals.push(pid);
      db.prepare(`UPDATE products SET ${fields.join(',')} WHERE id=?`).run(...vals);
    }
    // 수동 가격 입력
    if (manualPrice && parseInt(manualPrice) > 0) {
      db.prepare(`INSERT INTO price_history (product_id,price,source) VALUES (?,'manual')`).run(pid, parseInt(manualPrice));
    }
    // 링크 있으면 즉시 가격 파싱
    let fetchedPrice = null;
    if (coupangUrl) {
      try {
        const info = await fetchCoupangInfo(coupangUrl);
        if (info.price) {
          db.prepare(`INSERT INTO price_history (product_id,price,source) VALUES (?,?,'auto')`).run(pid, info.price);
          fetchedPrice = info.price;
        }
      } catch(e) {}
    }
    res.json({ success: true, fetchedPrice });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 상품 삭제 (어드민)
app.delete('/api/products/:id', checkAdmin, (req, res) => {
  db.prepare(`UPDATE products SET is_active=0 WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// 수동 전체 가격 업데이트 트리거 (어드민)
app.post('/api/update-prices', checkAdmin, async (req, res) => {
  res.json({ success: true, message: '업데이트 시작. 완료까지 수분 소요.' });
  updateAllPrices('manual-admin');
});

// 마지막 업데이트 로그
app.get('/api/status', (req, res) => {
  const lastLog = db.prepare(`SELECT * FROM update_log ORDER BY id DESC LIMIT 1`).get();
  const total   = db.prepare(`SELECT COUNT(*) as n FROM products WHERE is_active=1`).get().n;
  const linked  = db.prepare(`SELECT COUNT(*) as n FROM products WHERE is_active=1 AND coupang_url!='' AND coupang_url IS NOT NULL`).get().n;
  res.json({ lastUpdate: lastLog, total, linked });
});

// ─── 서버 시작 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🥩 프로틴 트래커 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`   어드민 키: ${ADMIN_KEY}`);
  console.log(`   DB 경로: ${DB_PATH}`);
});

// ─── SEO: robots.txt ──────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml`
  );
});

// ─── SEO: sitemap.xml ─────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const siteUrl = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const now = new Date().toISOString().split('T')[0];
  const cats = ['chicken','pork','beef','fish','eggs'];
  const urls = [
    `<url><loc>${siteUrl}/</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    ...cats.map(c =>
      `<url><loc>${siteUrl}/?cat=${c}</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`
    )
  ];
  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`
  );
});

// ─── SEO: 서버사이드 렌더링 (Google 크롤러용) ─────────────────
app.get('/ssr', (req, res) => {
  const siteUrl = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const products = db.prepare(`SELECT * FROM products WHERE is_active=1`).all();
  const rows = products.map(p => {
    const latest = db.prepare(`SELECT price FROM price_history WHERE product_id=? ORDER BY ts DESC LIMIT 1`).get(p.id);
    const price = latest?.price;
    return `<li>
      <strong>${p.name}</strong> (${p.brand}, ${p.weight}) —
      ${price ? `현재가 ${price.toLocaleString()}원` : '가격 수집 중'}
      ${p.coupang_url ? ` | <a href="${p.coupang_url}" rel="sponsored">쿠팡에서 보기</a>` : ''}
    </li>`;
  }).join('');
  const catNames = {chicken:'닭고기',pork:'돼지고기',beef:'소고기',fish:'생선류',eggs:'계란'};
  res.send(`<!DOCTYPE html><html lang="ko"><head>
    <meta charset="UTF-8"><title>프로틴 트래커 — 단백질 식품 가격 실시간 추적</title>
    <meta name="description" content="닭가슴살, 삼겹살, 소고기, 생선, 계란 쿠팡 최저가를 실시간으로 추적합니다. 90일 가격 기반 저점·고점 분석.">
    <link rel="canonical" href="${siteUrl}/">
    <meta http-equiv="refresh" content="0;url=${siteUrl}/">
  </head><body>
    <h1>프로틴 트래커 — 단백질 식품 가격 실시간 추적</h1>
    <p>쿠팡 단백질 식품 가격을 매 2시간마다 자동으로 추적합니다.</p>
    <ul>${rows}</ul>
    <p><a href="${siteUrl}/">메인으로 이동</a></p>
  </body></html>`);
});
