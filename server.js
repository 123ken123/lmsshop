'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || '', ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ACCOUNT_NO = process.env.ACCOUNT_NO || '0971438618';
if (!WEBHOOK_KEY || !ADMIN_TOKEN) {
  console.error('Thiếu biến môi trường WEBHOOK_KEY hoặc ADMIN_TOKEN');
  process.exit(1);
}

const DIR = path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const DBF = path.join(DIR, 'db.json');
const PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));

let db = { users: {}, sessions: {}, topups: {}, txs: {}, orders: [], keys: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) {}

const save = () => {
  fs.writeFileSync(DBF + '.tmp', JSON.stringify(db));
  fs.renameSync(DBF + '.tmp', DBF);
};
const eq = (a, b) => {
  a = Buffer.from(String(a)); b = Buffer.from(String(b));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const who = req => {
  const t = bearer(req);
  const s = Object.prototype.hasOwnProperty.call(db.sessions, t) && db.sessions[t];
  return s && s.exp > Date.now() ? s.user : null;
};
const tries = {};
const recent = ip => { const n = Date.now(); return (tries[ip] = (tries[ip] || []).filter(t => n - t < 6e5)); };
const limited = ip => recent(ip).length >= 10;   // tối đa 10 lần sai/đăng ký trong 10 phút
const fail = ip => recent(ip).push(Date.now());
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // đặt =1 khi chạy sau Render/Railway/ngrok/nginx
const getIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
const getUser = n => Object.prototype.hasOwnProperty.call(db.users, n) ? db.users[n] : null;
const RESERVED = ['__proto__', 'constructor', 'prototype', 'admin', 'root', 'system'];
const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');

// dọn session hết hạn
const cleanSessions = () => {
  const n = Date.now(); let c = 0;
  for (const t in db.sessions) if (db.sessions[t].exp <= n) { delete db.sessions[t]; c++; }
  if (c) save();
};
cleanSessions(); setInterval(cleanSessions, 36e5).unref();

function buy(name, p) {
  const u = db.users[name], k = db.keys[p.id];
  if (u.balance < p.price) return { error: 'Số dư không đủ' };
  if (!k || !k.length) return { error: 'Sản phẩm tạm hết key, vui lòng liên hệ Admin' };
  u.balance -= p.price;
  const o = {
    id: '#' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    user: name, productId: p.id, name: p.name, price: p.price, key: k.shift(), t: Date.now()
  };
  db.orders.unshift(o);
  u.history.unshift({ t: Date.now(), d: 'Mua ' + p.name, a: -p.price });
  return { order: o };
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const body = req => new Promise((ok, no) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e5) { req.destroy(); no(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ok({}); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, ip = getIp(req);
  try {
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    const b = req.method === 'POST' ? await body(req) : {};

    if (p === '/api/products')
      return send(res, 200, PRODUCTS.map(x => ({
        ...x,
        stock: (db.keys[x.id] || []).length > 0,
        sold: db.orders.filter(o => o.productId === x.id).length
      })));

    if (p === '/api/register' || p === '/api/login') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (limited(ip)) return send(res, 429, { error: 'Thử quá nhiều lần, vui lòng thử lại sau ít phút' });
      const name = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
      if (p === '/api/register') {
        fail(ip); // chống tạo hàng loạt tài khoản
        if (!/^[a-z0-9_]{3,20}$/.test(name) || RESERVED.includes(name)) return send(res, 400, { error: 'Tên đăng nhập 3-20 ký tự: chữ thường, số, _ (không dùng tên hệ thống)' });
        if (pw.length < 6) return send(res, 400, { error: 'Mật khẩu tối thiểu 6 ký tự' });
        if (pw.length > 100) return send(res, 400, { error: 'Mật khẩu tối đa 100 ký tự' });
        if (getUser(name)) return send(res, 400, { error: 'Tên đăng nhập đã tồn tại' });
        const salt = crypto.randomBytes(16).toString('hex');
        db.users[name] = { salt, hash: hash(pw, salt), balance: 0, history: [], created: Date.now() };
      } else {
        const u = getUser(name);
        // luôn băm mật khẩu để thời gian phản hồi không lộ tài khoản có tồn tại hay không
        const h = hash(pw.slice(0, 100), u ? u.salt : '0'.repeat(32));
        if (!u || !eq(u.hash, h)) { fail(ip); return send(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' }); }
      }
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions[token] = { user: name, exp: Date.now() + 30 * 864e5 };
      save();
      return send(res, 200, { token });
    }

    if (p === '/api/logout') { // hủy session trên server
      const t = bearer(req);
      if (Object.prototype.hasOwnProperty.call(db.sessions, t)) { delete db.sessions[t]; save(); }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/webhook/sepay') { // SePay gọi vào đây khi có tiền vào tài khoản
      if (!eq(req.headers.authorization || '', 'Apikey ' + WEBHOOK_KEY)) return send(res, 401, { success: false });
      const id = String(b.id || b.referenceCode || '');
      if (!id || b.transferType !== 'in') return send(res, 200, { success: true });
      if (db.txs[id]) return send(res, 200, { success: true }); // chống cộng trùng
      if (b.accountNumber && String(b.accountNumber) !== ACCOUNT_NO) return send(res, 200, { success: true });
      const amount = Math.floor(Number(b.transferAmount));
      const text = ((b.content || '') + ' ' + (b.code || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const m = text.match(/LMS[0-9A-F]{8}/), t = m && db.topups[m[0]];
      db.txs[id] = { amount, memo: m ? m[0] : null, t: Date.now(), matched: !!(t && t.status === 'pending') };
      if (t && t.status === 'pending' && amount > 0) {
        const u = db.users[t.user];
        u.balance += amount;
        u.history.unshift({ t: Date.now(), d: 'Nạp tiền ' + t.memo, a: amount });
        t.status = 'paid';
        t.paidAmount = amount;
        const prod = PRODUCTS.find(x => x.id === t.productId);
        if (prod) { const r = buy(t.user, prod); if (r.order) t.orderId = r.order.id; }
      }
      save();
      return send(res, 200, { success: true });
    }

    if (p === '/api/admin/keys') {
      if (!eq(req.headers['x-admin-token'] || '', ADMIN_TOKEN)) return send(res, 401, { error: 'Unauthorized' });
      const id = +b.productId, list = (b.keys || []).map(String).filter(Boolean);
      if (!PRODUCTS.some(x => x.id === id)) return send(res, 400, { error: 'Sai productId' });
      db.keys[id] = (db.keys[id] || []).concat(list);
      save();
      return send(res, 200, { stock: db.keys[id].length });
    }

    const user = who(req);
    if (!user) return send(res, 401, { error: 'Chưa đăng nhập' });

    if (p === '/api/me') {
      const u = db.users[user];
      return send(res, 200, {
        username: user,
        balance: u.balance,
        history: u.history.slice(0, 100),
        orders: db.orders.filter(o => o.user === user).slice(0, 100)
      });
    }

    if (p === '/api/topup') {
      const prod = PRODUCTS.find(x => x.id === +b.productId) || null;
      let memo;
      do { memo = 'LMS' + crypto.randomBytes(4).toString('hex').toUpperCase(); } while (db.topups[memo]);
      db.topups[memo] = { memo, user, productId: prod ? prod.id : null, status: 'pending', t: Date.now() };
      save();
      return send(res, 200, { memo });
    }

    if (p === '/api/topup/status') {
      const t = db.topups[url.searchParams.get('memo')];
      if (!t || t.user !== user) return send(res, 404, { error: 'Không tìm thấy' });
      return send(res, 200, {
        status: t.status,
        amount: t.paidAmount || 0,
        productId: t.productId,
        order: t.orderId ? db.orders.find(o => o.id === t.orderId) : null
      });
    }

    if (p === '/api/buy') {
      const prod = PRODUCTS.find(x => x.id === +b.productId);
      if (!prod) return send(res, 400, { error: 'Sản phẩm không tồn tại' });
      const r = buy(user, prod);
      if (r.error) return send(res, 400, r);
      save();
      return send(res, 200, r);
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Lỗi hệ thống' });
  }
}).listen(PORT, () => console.log('Shop chạy tại http://localhost:' + PORT));
