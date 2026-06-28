// ═══════════════════════════════════════════════════════════════
// 프로틴 트래커 서버
// Express + sqlite3 + 쿠팡 가격 자동 파싱 + 2시간 크론 업데이트
// ═══════════════════════════════════════════════════════════════
const express    = require('express');
const sqlite3    = require('sqlite3').verbose();
const axios      = require('axios');
const cheerio    = require('cheerio');
const cron       = require('node-cron');
const cors       = require('cors');
const helmet     = require('helmet');
const compression= require('compression');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-secret-key';
const DB_PATH   = process.env.DB_PATH   || path.join(__dirname, 'data.db');

// ─── DB 초기화 ────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('DB 연결 실패:', err.message); process.exit(1); }
  console.log('DB 연결:', DB_PATH);
});

// Promise 래퍼
const run = (sql, params=[]) => new Promise((res,rej) =>
  db.run(sql, params, function(err){ err ? rej(err) : res(this); }));
const get = (sql, params=[]) => new Promise((res,rej) =>
  db.get(sql, params, (err,row) => err ? rej(err) : res(row)));
const all = (sql, params=[]) => new Promise((res,rej) =>
  db.all(sql, params, (err,rows) => err ? rej(err) : res(rows)));

async function initDB() {
  await run(`PRAGMA journal_mode=WAL`);
  await run(`PRAGMA foreign_keys=ON`);
  await run(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, category TEXT NOT NULL,
    name TEXT NOT NULL, brand TEXT DEFAULT '',
    weight TEXT DEFAULT '', base_weight INTEGER DEFAULT 100,
    orig_price INTEGER, coupang_url TEXT, image_url TEXT,
    emoji TEXT DEFAULT '🥩', is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL, price INTEGER NOT NULL,
    source TEXT DEFAULT 'auto',
    ts INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS update_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started INTEGER DEFAULT (strftime('%s','now')),
    finished INTEGER, success INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0, note TEXT
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ph ON price_history(product_id, ts DESC)`);

  // 기본 상품 데이터
  const DEFAULTS = [
    {id:'c1',cat:'chicken',emoji:'🍗',brand:'하림',   name:'무항생제 닭가슴살',   weight:'1kg',  bw:1000,op:12000},
    {id:'c2',cat:'chicken',emoji:'🍗',brand:'올품',   name:'냉동 닭안심',         weight:'500g', bw:500, op:7500 },
    {id:'c3',cat:'chicken',emoji:'🍗',brand:'참프레', name:'생 닭다리살',         weight:'1kg',  bw:1000,op:9000 },
    {id:'p1',cat:'pork',   emoji:'🥩',brand:'도드람', name:'국내산 삼겹살',       weight:'500g', bw:500, op:16000},
    {id:'p2',cat:'pork',   emoji:'🥩',brand:'한돈',   name:'앞다리살 불고기용',   weight:'1kg',  bw:1000,op:13500},
    {id:'p3',cat:'pork',   emoji:'🥩',brand:'도드람', name:'목살 제육용',         weight:'1kg',  bw:1000,op:15000},
    {id:'b1',cat:'beef',   emoji:'🐄',brand:'호주산', name:'그레인페드 부채살',   weight:'500g', bw:500, op:20000},
    {id:'b2',cat:'beef',   emoji:'🐄',brand:'미국산', name:'척아이롤 스테이크용', weight:'1kg',  bw:1000,op:24000},
    {id:'b3',cat:'beef',   emoji:'🐄',brand:'한우',   name:'국거리·불고기 혼합',  weight:'300g', bw:300, op:35000},
    {id:'f1',cat:'fish',   emoji:'🐟',brand:'노르웨이산',name:'생연어 횟감용',    weight:'500g', bw:500, op:19000},
    {id:'f2',cat:'fish',   emoji:'🐟',brand:'국내산', name:'손질 고등어 3마리',   weight:'700g', bw:700, op:11000},
    {id:'f3',cat:'fish',   emoji:'🐟',brand:'동원',   name:'참치캔 프리미엄',     weight:'150g×4',bw:600,op:7200 },
    {id:'e1',cat:'eggs',   emoji:'🥚',brand:'풀무원', name:'GAPS 특란',           weight:'30구', bw:1800,op:9500 },
    {id:'e2',cat:'eggs',   emoji:'🥚',brand:'그리너스',name:'무항생제 계란',      weight:'15구', bw:900, op:7000 },
    {id:'e3',cat:'eggs',   emoji:'🥚',brand:'자연애', name:'동물복지 방목란',     weight:'10구', bw:600, op:8500 },
  ];
  for (const d of DEFAULTS) {
    await run(`INSERT OR IGNORE INTO products(id,category,emoji,brand,name,weight,base_weight,orig_price)
               VALUES(?,?,?,?,?,?,?,?)`,
      [d.id,d.cat,d.emoji,d.brand,d.name,d.weight,d.bw,d.op]);
  }
  console.log('DB 초기화 완료');
}

// ─── 가격 파싱 ─────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function resolveUrl(url) {
  try {
    const r = await axios.get(url, {
      maxRedirects:8, timeout:12000,
      headers:{'User-Agent':UA}, validateStatus:s=>s<500
    });
    return r.request?.res?.responseUrl || r.config?.url || url;
  } catch { return url; }
}

async function fetchCoupangInfo(url) {
  const finalUrl = await resolveUrl(url);
  const resp = await axios.get(finalUrl, {
    timeout:15000,
    headers:{
      'User-Agent':UA,
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language':'ko-KR,ko;q=0.9,en-US;q=0.8',
      'Referer':'https://www.coupang.com/',
    }
  });
  const $ = cheerio.load(resp.data);
  let price=null, name=null, imageUrl=null;

  $('script[type="application/ld+json"]').each((_,el) => {
    if (price) return;
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data)?data:[data];
      items.forEach(item => {
        if (item['@type']==='Product') {
          if (item.offers?.price) price=parseInt(String(item.offers.price).replace(/[^0-9]/g,''));
          if (!name&&item.name) name=item.name;
          if (!imageUrl) imageUrl=Array.isArray(item.image)?item.image[0]:item.image;
        }
      });
    } catch {}
  });
  if (!price) {
    const og=$('meta[property="product:price:amount"]').attr('content');
    if (og) price=parseInt(og.replace(/[^0-9]/g,''));
  }
  if (!name) name=$('meta[property="og:title"]').attr('content')||$('title').text().replace(/[-–|].*$/,'').trim();
  if (!imageUrl) imageUrl=$('meta[property="og:image"]').attr('content');
  if (!price) {
    for (const sel of ['.prod-price .total-price strong','#productPrice','.price-wrap strong','[class*="total-price"]']) {
      const txt=$(sel).first().text().replace(/[^0-9]/g,'');
      if (txt&&parseInt(txt)>100){price=parseInt(txt);break;}
    }
  }
  if (!price) {
    const m=resp.data.match(/"price"\s*:\s*"?(\d{3,7})"?/);
    if (m) price=parseInt(m[1]);
  }
  return {price, name:name?.substring(0,100), imageUrl, finalUrl};
}

// ─── 전체 업데이트 ─────────────────────────────────────────────
async function updateAllPrices(triggeredBy='cron') {
  const products = await all(
    `SELECT id,name,coupang_url FROM products WHERE coupang_url IS NOT NULL AND coupang_url!='' AND is_active=1`
  );
  if (!products.length) return {success:0,failed:0};

  const logRow = await run(`INSERT INTO update_log(note) VALUES(?)`, [triggeredBy]);
  let success=0, failed=0;

  for (const p of products) {
    try {
      const info = await fetchCoupangInfo(p.coupang_url);
      if (info.price && info.price>100 && info.price<10000000) {
        await run(`INSERT INTO price_history(product_id,price,source) VALUES(?,?,?)`, [p.id,info.price,triggeredBy]);
        await run(`UPDATE products SET updated_at=strftime('%s','now') WHERE id=?`, [p.id]);
        success++;
        console.log(`[UPDATE] ${p.name}: ${info.price.toLocaleString()}원`);
      } else { failed++; console.warn(`[WARN] ${p.name}: 가격 파싱 실패`); }
    } catch(e) { failed++; console.error(`[ERROR] ${p.name}:`, e.message); }
    await new Promise(r=>setTimeout(r, 2000+Math.random()*2000));
  }

  await run(`UPDATE update_log SET finished=strftime('%s','now'),success=?,failed=? WHERE id=?`,
    [success, failed, logRow.lastID]);
  console.log(`[CRON] 완료: 성공 ${success}, 실패 ${failed}`);
  return {success,failed};
}

cron.schedule('0 */2 * * *', () => {
  console.log('[CRON] 2시간 자동 업데이트 시작...');
  updateAllPrices('auto-cron');
});

// ─── 미들웨어 ──────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public'), {maxAge:'5m'}));
app.use('/api/', rateLimit({windowMs:60000,max:60}));

function checkAdmin(req,res,next) {
  const key=req.headers['x-admin-key']||req.query.adminKey;
  if(key!==ADMIN_KEY) return res.status(401).json({error:'인증 필요'});
  next();
}

// ─── 헬퍼 ─────────────────────────────────────────────────────
async function buildProductResponse(p) {
  const latest  = await get(`SELECT price FROM price_history WHERE product_id=? ORDER BY ts DESC LIMIT 1`, [p.id]);
  const histRaw = await all(`SELECT price FROM price_history WHERE product_id=? ORDER BY ts ASC`, [p.id]);
  const history = histRaw.map(h=>h.price).slice(-90);
  const currentPrice = latest?.price || null;

  let stats = null;
  if (history.length >= 2) {
    const mn=Math.min(...history), mx=Math.max(...history);
    const avg=Math.round(history.reduce((a,b)=>a+b,0)/history.length);
    const pct=mx===mn?50:Math.round((currentPrice-mn)/(mx-mn)*100);
    const recent7=history.slice(-7);
    const weekDiff=recent7.length>=2?recent7.at(-1)-recent7[0]:0;
    stats={min90:mn,max90:mx,avg90:avg,percentile:Math.max(0,Math.min(100,pct)),weekDiff};
  }
  return {
    id:p.id, category:p.category, emoji:p.emoji,
    brand:p.brand, name:p.name, weight:p.weight,
    baseWeight:p.base_weight, origPrice:p.orig_price,
    coupangUrl:p.coupang_url||'', imageUrl:p.image_url||'',
    currentPrice, history, stats,
    unit100:currentPrice?Math.round(currentPrice/p.base_weight*100):null,
    dcRate:(currentPrice&&p.orig_price)?Math.max(0,Math.round((1-currentPrice/p.orig_price)*100)):0,
    hasLink:!!p.coupang_url, updatedAt:p.updated_at
  };
}

// ─── API ───────────────────────────────────────────────────────
app.get('/api/products', async (req,res) => {
  try {
    const products = await all(`SELECT * FROM products WHERE is_active=1 ORDER BY category,name`);
    const result = await Promise.all(products.map(buildProductResponse));
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/products/:id', async (req,res) => {
  try {
    const p = await get(`SELECT * FROM products WHERE id=? AND is_active=1`, [req.params.id]);
    if (!p) return res.status(404).json({error:'상품 없음'});
    res.json(await buildProductResponse(p));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/preview-link', checkAdmin, async (req,res) => {
  const {url}=req.body;
  if (!url) return res.status(400).json({error:'URL 필요'});
  try { res.json(await fetchCoupangInfo(url)); }
  catch(e) { res.status(500).json({error:'파싱 실패: '+e.message}); }
});

app.post('/api/products', checkAdmin, async (req,res) => {
  const {id,category,name,brand,weight,baseWeight,origPrice,coupangUrl,emoji}=req.body;
  if (!category||!name) return res.status(400).json({error:'카테고리·상품명 필수'});
  const pid=id||uuidv4().split('-')[0];
  try {
    await run(`INSERT INTO products(id,category,name,brand,weight,base_weight,orig_price,coupang_url,emoji)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
               category=excluded.category,name=excluded.name,brand=excluded.brand,
               weight=excluded.weight,base_weight=excluded.base_weight,
               orig_price=excluded.orig_price,coupang_url=excluded.coupang_url,
               emoji=excluded.emoji,updated_at=strftime('%s','now')`,
      [pid,category,name,brand||'',weight||'',baseWeight||100,origPrice||null,coupangUrl||null,emoji||'🥩']);
    if (coupangUrl) {
      try {
        const info=await fetchCoupangInfo(coupangUrl);
        if (info.price) {
          await run(`INSERT INTO price_history(product_id,price,source) VALUES(?,?,'manual')`, [pid,info.price]);
          if (info.imageUrl) await run(`UPDATE products SET image_url=? WHERE id=?`, [info.imageUrl,pid]);
        }
      } catch {}
    }
    res.json({success:true,id:pid});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/products/:id', checkAdmin, async (req,res) => {
  const {coupangUrl,manualPrice,origPrice,name,brand}=req.body;
  const pid=req.params.id;
  try {
    const fields=[], vals=[];
    if (coupangUrl!==undefined){fields.push('coupang_url=?');vals.push(coupangUrl);}
    if (origPrice!==undefined){fields.push('orig_price=?');vals.push(origPrice);}
    if (name!==undefined){fields.push('name=?');vals.push(name);}
    if (brand!==undefined){fields.push('brand=?');vals.push(brand);}
    if (fields.length){fields.push("updated_at=strftime('%s','now')");vals.push(pid);
      await run(`UPDATE products SET ${fields.join(',')} WHERE id=?`,vals);}
    if (manualPrice&&parseInt(manualPrice)>0)
      await run(`INSERT INTO price_history(product_id,price,source) VALUES(?,?,'manual')`, [pid,parseInt(manualPrice)]);
    let fetchedPrice=null;
    if (coupangUrl) {
      try {
        const info=await fetchCoupangInfo(coupangUrl);
        if (info.price){
          await run(`INSERT INTO price_history(product_id,price,source) VALUES(?,?,'auto')`, [pid,info.price]);
          fetchedPrice=info.price;
        }
      } catch {}
    }
    res.json({success:true,fetchedPrice});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/products/:id', checkAdmin, async (req,res) => {
  await run(`UPDATE products SET is_active=0 WHERE id=?`, [req.params.id]);
  res.json({success:true});
});

app.post('/api/update-prices', checkAdmin, async (req,res) => {
  res.json({success:true,message:'업데이트 시작. 수분 소요.'});
  updateAllPrices('manual-admin');
});

app.get('/api/status', async (req,res) => {
  const lastLog = await get(`SELECT * FROM update_log ORDER BY id DESC LIMIT 1`);
  const total   = await get(`SELECT COUNT(*) as n FROM products WHERE is_active=1`);
  const linked  = await get(`SELECT COUNT(*) as n FROM products WHERE is_active=1 AND coupang_url!='' AND coupang_url IS NOT NULL`);
  res.json({lastUpdate:lastLog, total:total.n, linked:linked.n});
});

// ─── SEO ───────────────────────────────────────────────────────
const SITE_URL = (process.env.SITE_URL||`http://localhost:${PORT}`).replace(/\/$/,'');

app.get('/robots.txt', (_,res) => res.type('text/plain').send(
`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml`));

app.get('/sitemap.xml', (_,res) => {
  const now=new Date().toISOString().split('T')[0];
  const cats=['chicken','pork','beef','fish','eggs'];
  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`+
`<url><loc>${SITE_URL}/</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>\n`+
cats.map(c=>`<url><loc>${SITE_URL}/?cat=${c}</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`).join('\n')+
`\n</urlset>`);
});

// ─── 서버 시작 ─────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🥩 프로틴 트래커 → http://localhost:${PORT}`);
    console.log(`   어드민 키: ${ADMIN_KEY}`);
    console.log(`   DB: ${DB_PATH}`);
  });
}).catch(err => {
  console.error('서버 시작 실패:', err);
  process.exit(1);
});
