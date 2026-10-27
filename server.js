const express = require('express'), session = require('express-session');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.STEAM_API_KEY || '';
const ADMINS = (process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const ADMIN_CODE = String(process.env.ADMIN_CODE || '11111');
const DB_FILE = path.join(__dirname, 'db.json');

let db = { users: {}, promos: [{ code: '322', value: 3 }], deps: [], wds: [], feed: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
db.nextPid = db.nextPid || 1001;
db.opens = db.opens || {};
// Міграція: старі безкоштовні відкриття стають «для всіх кейсів»
Object.values(db.users).forEach(u => { if (u.free) { u.freeBy = u.freeBy || {}; u.freeBy['*'] = (u.freeBy['*'] || 0) + u.free; delete u.free; } });
db.promos = db.promos.map(p => ({ type: 'dep', uses: 0, count: 0, used: [], caseId: '', ...p }));
Object.values(db.users).forEach(u => { if (!u.pid) u.pid = String(db.nextPid++); });

// Рідкість предмета (колір картки) залежить від його шансу
const rarity = c => (c >= 30 ? 1 : c >= 15 ? 2 : c >= 6 ? 3 : c >= 2 ? 4 : 5);
const mk = (id, name, price, chance, icon) => ({ id, name, price, chance, icon, r: rarity(chance) });

// ===== КЕЙСИ =====  (сума шансів у кожному кейсі має бути 100)
// section/chip: розділ на головній; art: файл картинки у папці public; theme: колір сяйва картки
const CASES = [
  { id: 'wood', name: "Дерев'яний", price: 45, section: 'Кейси для початківців', chip: 'START', art: 'bomzhenya.png', theme: '#3fb67a', items: [
    mk('w1', 'Залізна мотика', 20, 40, 'iron_hoe'),
    mk('w2', 'Залізне кайло', 35, 25, 'iron_pickaxe'),
    mk('w3', 'Залізний меч', 35, 15, 'iron_sword'),
    mk('w4', 'Залізна сокира', 40, 12, 'iron_axe'),
    mk('w5', 'Залізна сокира (Еф. I)', 55, 6, 'iron_axe'),
    mk('w6', 'Залізна сокира (Еф. II)', 70, 2, 'iron_axe'),
  ] },
  { id: 'silver', name: 'Серебряний', price: 100, section: 'Кейси для початківців', chip: 'START', art: 'case-silver.png', theme: '#8fb4ff', items: [
    mk('s1', 'Залізна сокира (Еф. I)', 55, 30, 'iron_axe'),
    mk('s2', 'Залізна сокира (Еф. II)', 70, 27, 'iron_axe'),
    mk('s3', 'Алмазна лопата (Еф. II)', 95, 18, 'diamond_shovel'),
    mk('s4', 'Залізне кайло (Еф. III)', 90, 15, 'iron_pickaxe'),
    mk('s5', 'Алмазне кайло (Еф. I)', 105, 10, 'diamond_pickaxe'),
  ] },
  { id: 'gold', name: 'Голдовий', price: 135, section: 'Кейси для початківців', chip: 'START', art: 'case-gold.png', theme: '#ffb648', items: [
    mk('g1', 'Золота лопата (Еф. IV)', 110, 45, 'golden_shovel'),
    mk('g2', 'Золоте кайло (Еф. IV)', 120, 32, 'golden_pickaxe'),
    mk('g3', 'Золоте кайло (Еф. V)', 135, 13, 'golden_pickaxe'),
    mk('g4', '5 золотих яблук', 180, 6, 'golden_apple'),
    mk('g5', 'Супер зачароване золоте яблуко', 195, 2.5, 'golden_apple#ench'),
    mk('g6', '8 золотих яблук', 240, 1.3, 'golden_apple'),
    mk('g7', 'Тотем безсмертя', 1000, 0.2, 'totem_of_undying'),
  ] },
];
CASES.forEach(c => {
  const sum = c.items.reduce((a, i) => a + i.chance, 0);
  if (Math.abs(sum - 100) > 0.001) console.warn('УВАГА: сума шансів у кейсі ' + c.name + ' = ' + sum + ' (має бути 100)');
});

// Цілі апгрейду = усі предмети з кейсів (без повторів за назвою). Предмети з id у NO_UPGRADE не можна отримати апгрейдом
const NO_UPGRADE = new Set(['g7']);
const seenNames = new Set();
const TARGETS = CASES.flatMap(c => c.items)
  .filter(i => !NO_UPGRADE.has(i.id))
  .sort((a, b) => a.price - b.price)
  .filter(i => !seenNames.has(i.name) && seenNames.add(i.name))
  .map(i => ({ id: 't_' + i.id, name: i.name, price: i.price, icon: i.icon, r: i.r }));
// Розділи на головній (порядок = порядок на сайті). Новий кейс додається в CASES з section = назва розділу
const SECTIONS = [{ name: 'Кейси для початківців', chip: 'START' }, { name: 'Медіа', chip: 'MEDIA' }];
const UPGRADE_COMP = 7; // % ставки, що повертається коїнами при невдалому апгрейді

// Чесний шанс апгрейду: те саме число показується гравцю і використовується тут
const upChance = (bet, price) => Math.round(Math.min(80, Math.max(1, bet / price * 95)) * 100) / 100;
const rnd = () => crypto.randomInt(10000) / 100; // 0..99.99

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-please',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 30 * 864e5, httpOnly: true, sameSite: 'lax', secure: BASE.startsWith('https') },
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Steam OpenID ---------- */
app.get('/auth/steam', (req, res) => {
  const p = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': BASE + '/auth/steam/return',
    'openid.realm': BASE,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect('https://steamcommunity.com/openid/login?' + p);
});

app.get('/auth/steam/return', async (req, res) => {
  try {
    const q = { ...req.query };
    if (!String(q['openid.return_to'] || '').startsWith(BASE + '/auth/steam/return')) throw new Error('bad return_to');
    q['openid.mode'] = 'check_authentication';
    const r = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(q),
    });
    const text = await r.text();
    const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(req.query['openid.claimed_id'] || '');
    if (!/is_valid\s*:\s*true/.test(text) || !m) throw new Error('steam rejected');
    const id = m[1];
    let u = db.users[id];
    if (!u) u = db.users[id] = { id, name: 'Steam_' + id.slice(-4), avatar: '', bal: 0, inv: [], custom: false };
    if (KEY) {
      try {
        const pr = await (await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${id}`)).json();
        const pl = pr.response.players[0];
        if (pl) { if (!u.custom) { u.name = pl.personaname.slice(0, 24); u.avatar = pl.avatarfull; } }
      } catch {}
    }
    ensurePid(u);
    save();
    req.session.sid = id;
    res.redirect('/');
  } catch (e) {
    res.status(401).send('Не вдалося підтвердити вхід через Steam. <a href="/">Назад</a>');
  }
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: 1 })));

/* ---------- helpers ---------- */
const isAdmin = u => !!u && (u.admin === true || ADMINS.includes(u.id));
function ensurePid(u) { if (!u.pid) u.pid = String(db.nextPid++); }
const pub = u => u && { id: u.id, pid: u.pid, name: u.name, avatar: u.avatar, bal: u.bal, inv: u.inv, freeBy: u.freeBy || {}, admin: isAdmin(u) };
const auth = (req, res, next) => {
  const u = db.users[req.session.sid];
  if (!u) return res.status(401).json({ error: 'Увійдіть через Steam' });
  req.u = u; next();
};
const admin = (req, res, next) => auth(req, res, () =>
  isAdmin(req.u) ? next() : res.status(403).json({ error: 'Немає доступу' }));
const num = v => { v = Math.floor(Number(v)); return Number.isFinite(v) ? v : 0; };

/* ---------- public API ---------- */
app.get('/api/init', (req, res) => { const u0 = db.users[req.session.sid]; if (u0) ensurePid(u0); res.json({
  me: pub(u0) || null,
  cases: CASES.map(c => ({ ...c, opens: db.opens[c.id] || 0 })), sections: SECTIONS, targets: TARGETS, feed: db.feed,
}); });
app.get('/api/feed', (req, res) => res.json(db.feed));
app.get('/api/promo/:code', (req, res) => {
  const p = db.promos.find(x => x.code.toLowerCase() === String(req.params.code).trim().toLowerCase());
  res.json({ value: p && p.type === 'dep' && (!p.uses || p.count < p.uses) ? p.value : 0 });
});

/* ---------- game ---------- */
app.post('/api/open', auth, (req, res) => {
  const u = req.u, c = CASES.find(x => x.id === req.body.case);
  if (!c) return res.status(400).json({ error: 'Кейс не знайдено' });
  const n = Math.min(5, Math.max(1, num(req.body.n) || 1));
  const fb = u.freeBy || (u.freeBy = {});
  const own = fb[c.id] || 0, any = fb['*'] || 0;
  const freeUse = Math.min(n, own + any);
  const pay = (n - freeUse) * c.price;
  if (u.bal < pay) return res.status(400).json({ error: 'Недостатньо коїнів' });
  const items = [];
  for (let k = 0; k < n; k++) {
    let r = rnd(), won = c.items[c.items.length - 1];
    for (const it of c.items) { r -= it.chance; if (r < 0) { won = it; break; } }
    const item = { ...won, uid: crypto.randomUUID() };
    items.push(item); u.inv.push(item);
    db.feed.unshift({ user: u.name, item: won.name, price: won.price });
  }
  const fromOwn = Math.min(freeUse, own);
  fb[c.id] = own - fromOwn; fb['*'] = any - (freeUse - fromOwn);
  u.bal = Math.round((u.bal - pay) * 100) / 100;
  db.feed = db.feed.slice(0, 15);
  db.opens[c.id] = (db.opens[c.id] || 0) + n;
  save();
  res.json({ items, me: pub(u) });
});

app.post('/api/upgrade', auth, (req, res) => {
  const u = req.u, t = TARGETS.find(x => x.id === req.body.target);
  if (!t) return res.status(400).json({ error: 'Невірна ціль' });
  const cc = Math.max(0, num(req.body.cc));
  const uids = Array.isArray(req.body.uids) ? [...new Set(req.body.uids.map(String))].slice(0, 40) : [];
  const picked = uids.map(id => u.inv.find(x => x.uid === id));
  if (picked.some(x => !x)) return res.status(400).json({ error: 'Предмет не знайдено' });
  if (cc > u.bal) return res.status(400).json({ error: 'Недостатньо коїнів' });
  const stake = cc + picked.reduce((a, x) => a + x.price, 0);
  if (stake < 1) return res.status(400).json({ error: 'Додайте предмети або коїни' });
  if (stake > t.price) return res.status(400).json({ error: 'Ставка більша за ціну цілі' });
  const chance = upChance(stake, t.price);
  u.bal -= cc;
  u.inv = u.inv.filter(x => !uids.includes(x.uid));
  const win = rnd() < chance;
  let comp = 0;
  if (win) u.inv.push({ ...t, uid: crypto.randomUUID() });
  else comp = Math.round(stake * UPGRADE_COMP) / 100; // компенсація при невдачі
  u.bal = Math.round((u.bal + comp) * 100) / 100;
  save();
  res.json({ win, chance, comp, me: pub(u) });
});

app.post('/api/withdraw', auth, (req, res) => {
  const u = req.u, mc = String(req.body.mc || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return res.status(400).json({ error: 'Невірний Minecraft нік' });
  const i = u.inv.findIndex(x => x.uid === req.body.uid);
  if (i < 0) return res.status(400).json({ error: 'Предмет не знайдено' });
  const [item] = u.inv.splice(i, 1);
  db.wds.push({ id: crypto.randomUUID(), steamid: u.id, user: u.name, mc, item: item.name, done: false });
  save();
  res.json({ me: pub(u) });
});

app.post('/api/profile', auth, (req, res) => {
  const u = req.u, name = String(req.body.name || '').trim().slice(0, 24), av = String(req.body.avatar || '').trim();
  if (name) { u.name = name; u.custom = true; }
  if (/^https:\/\/[^\s"'<>]{4,300}$/.test(av)) u.avatar = av;
  save(); res.json({ me: pub(u) });
});

const findPromo = c => db.promos.find(p => p.code.toLowerCase() === String(c || '').trim().toLowerCase());
const promoOk = p => p && (!p.uses || p.count < p.uses);

app.post('/api/deposit', auth, (req, res) => {
  const amount = num(req.body.amount);
  if (amount < 10 || amount > 100000) return res.status(400).json({ error: 'Сума від 10 до 100000' });
  const p = findPromo(req.body.promo);
  const bonus = p && p.type === 'dep' && promoOk(p) ? p.value : 0;
  db.deps.push({ id: crypto.randomUUID(), steamid: req.u.id, pid: req.u.pid, user: req.u.name,
    amount: Math.floor(amount * (1 + bonus / 100)), bonus, promo: bonus ? p.code : '' });
  save(); res.json({ ok: 1 });
});

// Промокоди типів «coins» (коїни CosmicCoins) і «case» (безкоштовні відкриття кейса)
app.post('/api/promo/redeem', auth, (req, res) => {
  const u = req.u, p = findPromo(req.body.code);
  if (!p) return res.status(404).json({ error: 'Промокод не знайдено' });
  if (p.type === 'dep') return res.status(400).json({ error: 'Цей промокод вводиться у вікні «Поповнити»' });
  if (!promoOk(p)) return res.status(400).json({ error: 'Промокод вичерпано' });
  if (p.used.includes(u.id)) return res.status(400).json({ error: 'Ви вже активували цей промокод' });
  p.used.push(u.id); p.count++;
  let text;
  if (p.type === 'coins') { u.bal += p.value; text = 'Нараховано ' + p.value + ' CC (CosmicCoins)'; }
  else {
    const fb = u.freeBy || (u.freeBy = {}), key = p.caseId || '*';
    fb[key] = (fb[key] || 0) + p.value;
    const cn = p.caseId ? ((CASES.find(c => c.id === p.caseId) || {}).name || p.caseId) : 'усі кейси';
    text = 'Безкоштовних відкриттів: +' + p.value + ' (' + cn + ')';
  }
  save(); res.json({ me: pub(u), text });
});

/* ---------- admin ---------- */
const fails = {};
app.post('/api/admin/login', auth, (req, res) => {
  const k = req.ip, f = fails[k] || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 5) return res.status(429).json({ error: 'Забагато спроб, зачекайте 15 хвилин' });
  if (String(req.body.code) !== ADMIN_CODE) { f.n++; fails[k] = f; return res.status(403).json({ error: 'Невірний код' }); }
  delete fails[k];
  const u = req.u; u.admin = true;
  if (u.pid !== '777') {
    const other = Object.values(db.users).find(x => x.pid === '777' && x.id !== u.id);
    if (other) other.pid = String(db.nextPid++);
    u.pid = '777';
  }
  save(); res.json({ me: pub(u) });
});

app.get('/api/admin', admin, (req, res) => res.json({
  deps: db.deps, wds: db.wds.filter(w => !w.done),
  promos: db.promos.map(({ used, ...p }) => p),
}));
app.post('/api/admin/dep', admin, (req, res) => {
  const i = db.deps.findIndex(d => d.id === req.body.id);
  if (i < 0) return res.status(404).json({ error: 'Не знайдено' });
  const [d] = db.deps.splice(i, 1);
  if (req.body.ok && db.users[d.steamid]) {
    db.users[d.steamid].bal += d.amount;
    const p = d.promo && findPromo(d.promo); if (p) p.count++;
  }
  save(); res.json({ ok: 1 });
});
app.post('/api/admin/wd', admin, (req, res) => {
  const w = db.wds.find(x => x.id === req.body.id);
  if (w) w.done = true;
  save(); res.json({ ok: 1 });
});
// Нарахування балансу по ID (короткий ID з профілю, SteamID64 або нік)
app.post('/api/admin/give', admin, (req, res) => {
  const key = String(req.body.user || '').trim().toLowerCase(), amt = num(req.body.amount);
  if (!amt) return res.status(400).json({ error: 'Вкажіть суму' });
  const all = Object.values(db.users);
  const t = all.find(x => String(x.pid) === key) || db.users[key] || all.find(x => x.name.toLowerCase() === key);
  if (!t) return res.status(404).json({ error: 'Гравця не знайдено (ID, SteamID64 або нік)' });
  t.bal = Math.max(0, t.bal + amt);
  save(); res.json({ name: t.name, pid: t.pid, bal: t.bal });
});
// Створення промокодів: dep = бонус % до поповнення, coins = коїни CosmicCoins, case = безкоштовні відкриття кейса
app.post('/api/admin/promo', admin, (req, res) => {
  const code = String(req.body.code || '').trim().slice(0, 20), value = num(req.body.value), uses = Math.max(0, num(req.body.uses));
  const type = ['dep', 'coins', 'case'].includes(req.body.type) ? req.body.type : 'dep';
  if (!code || value < 1 || (type === 'dep' && value > 100)) return res.status(400).json({ error: 'Невірні дані промокоду' });
  db.promos = db.promos.filter(p => p.code.toLowerCase() !== code.toLowerCase());
  const caseId = type === 'case' && CASES.some(c => c.id === req.body.caseId) ? req.body.caseId : '';
  db.promos.push({ code, type, value, uses, caseId, count: 0, used: [] });
  save(); res.json({ ok: 1 });
});
app.post('/api/admin/promo/del', admin, (req, res) => {
  db.promos = db.promos.filter(p => p.code.toLowerCase() !== String(req.body.code || '').toLowerCase());
  save(); res.json({ ok: 1 });
});

app.listen(PORT, () => console.log('CosmDrop: ' + BASE + ' (port ' + PORT + ')'));
