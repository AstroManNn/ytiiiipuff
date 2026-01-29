const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 👇 ЗАМЕНИ НА СВОЙ RAILWAY URL
const SERVER_URL = 'https://ytiiiipuff-production.up.railway.app'; 

app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

if (!process.env.DATABASE_URL) console.error("❌ Нет DATABASE_URL");
if (!process.env.BOT_TOKEN) console.error("❌ Нет BOT_TOKEN");
if (!process.env.ADMIN_CHAT_ID) console.error("❌ Нет ADMIN_CHAT_ID");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- БД ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                name VARCHAR(255),
                phone VARCHAR(50),
                username VARCHAR(255),
                points INTEGER DEFAULT 0,
                referral_code VARCHAR(50) UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                purchase_price DECIMAL(10, 2) DEFAULT 0,
                image_url TEXT,
                stock INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                amount DECIMAL(10, 2) NOT NULL,
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS faq (
                id SERIAL PRIMARY KEY,
                question TEXT NOT NULL,
                answer TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cart_items (
                id SERIAL PRIMARY KEY,
                user_telegram_id BIGINT NOT NULL,
                product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
                quantity INTEGER DEFAULT 1,
                UNIQUE(user_telegram_id, product_id)
            );
            CREATE TABLE IF NOT EXISTS promocodes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                discount_percent INTEGER NOT NULL,
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_telegram_id BIGINT NOT NULL,
                details TEXT NOT NULL,
                total_price DECIMAL(10, 2),
                final_price DECIMAL(10, 2), -- Цена после скидок
                promo_code VARCHAR(50),
                discount_amount DECIMAL(10, 2) DEFAULT 0,
                points_spent INTEGER DEFAULT 0,
                address TEXT,
                comment TEXT,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ БД обновлена (промокоды и история заказов).');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

const getAdmins = () => process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
const isAdmin = (chatId) => getAdmins().includes(chatId.toString());

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Магазин работает внутри Web App.');
});

// --- API USERS ---
app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, phone, username } = req.body;
        const ref = 'R-' + Math.random().toString(36).substr(2, 6).toUpperCase();
        // Даем 500 баллов при регистрации
        const result = await pool.query(
            'INSERT INTO users (telegram_id, name, phone, username, referral_code, points) VALUES ($1, $2, $3, $4, $5, 500) ON CONFLICT (telegram_id) DO NOTHING RETURNING *', 
            [userId, name, phone, username, ref]
        );
        // Если юзер уже был, вернем его
        if (result.rows.length === 0) {
            const existing = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
            return res.json({ success: true, user: existing.rows[0] });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/user/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            user.is_admin = isAdmin(req.params.id);
            res.json(user);
        } else res.status(404).json({ message: 'Not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/:id/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API PRODUCTS & CART ---
app.get('/api/products', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM products ORDER BY id DESC'); res.json(result.rows); } catch (e) { res.status(500).json({}); }
});

app.get('/api/cart/:userId', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.product_id, c.quantity, p.name, p.price, p.image_url FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1 ORDER BY p.name ASC`, [req.params.userId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({}); }
});

app.post('/api/cart/add', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        const check = await pool.query('SELECT * FROM cart_items WHERE user_telegram_id=$1 AND product_id=$2', [userId, productId]);
        if (check.rows.length > 0) await pool.query('UPDATE cart_items SET quantity=quantity+1 WHERE user_telegram_id=$1 AND product_id=$2', [userId, productId]);
        else await pool.query('INSERT INTO cart_items (user_telegram_id, product_id, quantity) VALUES ($1, $2, 1)', [userId, productId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({}); }
});

app.post('/api/cart/remove', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id=$1 AND product_id=$2', [userId, productId]);
        if (check.rows.length > 0 && check.rows[0].quantity > 1) await pool.query('UPDATE cart_items SET quantity=quantity-1 WHERE user_telegram_id=$1 AND product_id=$2', [userId, productId]);
        else await pool.query('DELETE FROM cart_items WHERE user_telegram_id=$1 AND product_id=$2', [userId, productId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({}); }
});

// --- PROMO & ORDER ---
app.post('/api/cart/check-promo', async (req, res) => {
    try {
        const { code } = req.body;
        const result = await pool.query('SELECT * FROM promocodes WHERE code = $1 AND active = TRUE', [code]);
        if (result.rows.length > 0) res.json({ valid: true, discount: result.rows[0].discount_percent });
        else res.json({ valid: false });
    } catch (e) { res.status(500).json({ error: 'Promo check error' }); }
});

app.post('/api/order', async (req, res) => {
    try {
        const { userId, address, comment, promoCode, usePoints } = req.body;
        
        // 1. Get User & Cart
        const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        const cartRes = await pool.query(`SELECT c.quantity, p.id as pid, p.name, p.price FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1`, [userId]);
        
        if (cartRes.rows.length === 0) return res.status(400).json({ error: 'Корзина пуста' });
        const user = userRes.rows[0];
        
        // 2. Calculate Totals
        let subtotal = 0;
        cartRes.rows.forEach(i => subtotal += (parseFloat(i.price) * i.quantity));
        
        let discountAmount = 0;
        let finalPrice = subtotal;

        // 3. Apply Promo
        if (promoCode) {
            const promoRes = await pool.query('SELECT * FROM promocodes WHERE code = $1 AND active = TRUE', [promoCode]);
            if (promoRes.rows.length > 0) {
                const percent = promoRes.rows[0].discount_percent;
                discountAmount = Math.floor(subtotal * (percent / 100));
                finalPrice -= discountAmount;
            }
        }

        // 4. Apply Points (Max 15%)
        let pointsSpent = 0;
        if (usePoints) {
            const maxPoints = Math.floor(finalPrice * 0.15); // 15% of remaining sum
            pointsSpent = Math.min(user.points, maxPoints);
            finalPrice -= pointsSpent;
        }

        finalPrice = Math.max(0, finalPrice);

        // 5. Save Order
        const itemsJson = JSON.stringify(cartRes.rows.map(i => ({ product_id: i.pid, name: i.name, price: i.price, quantity: i.quantity })));
        
        const order = await pool.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, final_price, promo_code, discount_amount, points_spent, address, comment) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [userId, itemsJson, subtotal, finalPrice, promoCode || null, discountAmount, pointsSpent, address, comment]
        );

        // 6. Deduct Points & Clear Cart
        if (pointsSpent > 0) {
            await pool.query('UPDATE users SET points = points - $1 WHERE id = $2', [pointsSpent, user.id]);
        }
        await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        // 7. Notify Admins
        const adminMsg = `📦 *Заказ #${order.rows[0].id}*\n👤 ${user.name} (${user.phone})\n📍 ${address}\n💰 Сумма: ${subtotal}₽\n🎟 Скидка: ${discountAmount}₽\n💎 Баллы: ${pointsSpent}\n💵 *К оплате: ${finalPrice}₽*\n\nКомментарий: ${comment || '-'}`;
        
        getAdmins().forEach(id => {
            if (id) bot.sendMessage(id, adminMsg, { parse_mode: 'Markdown' });
        });

        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Order failed' }); }
});


// --- ADMIN API ---

// PROMO CODES
app.get('/api/admin/promocodes', async (req, res) => {
    if(!isAdmin(req.query.userId)) return res.status(403).json({});
    const resDb = await pool.query('SELECT * FROM promocodes ORDER BY id DESC');
    res.json(resDb.rows);
});
app.post('/api/admin/promocode', async (req, res) => {
    if(!isAdmin(req.body.userId)) return res.status(403).json({});
    const { code, percent } = req.body;
    await pool.query('INSERT INTO promocodes (code, discount_percent) VALUES ($1, $2)', [code, percent]);
    res.json({ success: true });
});
app.delete('/api/admin/promocode/:id', async (req, res) => {
    if(!isAdmin(req.headers['user-id'])) return res.status(403).json({});
    await pool.query('DELETE FROM promocodes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// STATS (Updated)
app.get('/api/admin/stats', async (req, res) => {
    if(!isAdmin(req.query.userId)) return res.status(403).json({});
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Revenue based on FINAL PRICE
    const orders = await pool.query("SELECT details, final_price, discount_amount, points_spent FROM orders WHERE status='completed' AND created_at >= $1", [start]);
    
    let revenue = 0, cogs = 0, discountsTotal = 0;
    
    for (const o of orders.rows) {
        revenue += parseFloat(o.final_price);
        discountsTotal += (parseFloat(o.discount_amount) + o.points_spent);
        
        const items = JSON.parse(o.details);
        for (const i of items) {
            const p = await pool.query('SELECT purchase_price FROM products WHERE id=$1', [i.product_id]);
            if(p.rows.length) cogs += parseFloat(p.rows[0].purchase_price) * i.quantity;
        }
    }
    
    const exp = await pool.query('SELECT * FROM expenses WHERE created_at >= $1', [start]);
    let expensesTotal = 0;
    exp.rows.forEach(e => expensesTotal += parseFloat(e.amount));

    res.json({
        revenue: revenue,
        cogs: cogs,
        expenses: expensesTotal,
        discounts_total: discountsTotal,
        netProfit: revenue - cogs - expensesTotal,
        expensesList: exp.rows
    });
});

// ORDERS (Updated with new fields)
app.get('/api/admin/orders', async (req, res) => {
    if(!isAdmin(req.query.userId)) return res.status(403).json({});
    const status = req.query.status || 'active';
    const resDb = await pool.query('SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 50', [status]);
    
    const detailed = await Promise.all(resDb.rows.map(async o => {
        const u = await pool.query('SELECT name, phone FROM users WHERE telegram_id = $1', [o.user_telegram_id]);
        return { 
            ...o, 
            user_data: u.rows[0], 
            items: JSON.parse(o.details) 
        };
    }));
    res.json(detailed);
});

// OTHER ADMIN (Existing reused)
app.post('/api/admin/product', upload.single('photo'), async (req, res) => {
    const { userId, name, category, price, stock } = req.body;
    if(!isAdmin(userId)) return res.status(403).json({});
    let img = 'https://via.placeholder.com/150';
    if(req.file) {
        const m = await bot.sendPhoto(getAdmins()[0], req.file.buffer);
        img = `${SERVER_URL}/api/image/${m.photo[m.photo.length-1].file_id}`;
    }
    await pool.query('INSERT INTO products (name, category, price, stock, image_url) VALUES ($1,$2,$3,$4,$5)', [name, category, price, stock, img]);
    res.json({success:true});
});
app.delete('/api/admin/product/:id', async (req, res) => {
    if(!isAdmin(req.headers['user-id'])) return res.status(403).json({});
    await pool.query('DELETE FROM cart_items WHERE product_id=$1', [req.params.id]);
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({success:true});
});
app.post('/api/admin/product/:id/image', upload.single('photo'), async (req, res) => {
    if(!req.file) return res.status(400).json({});
    const m = await bot.sendPhoto(getAdmins()[0], req.file.buffer);
    const link = `${SERVER_URL}/api/image/${m.photo[m.photo.length-1].file_id}`;
    await pool.query('UPDATE products SET image_url=$1 WHERE id=$2', [link, req.params.id]);
    res.json({success:true, imageUrl: link});
});
app.put('/api/admin/order/:id', async (req, res) => {
    // Edit order (simplified)
    const { total_price, address, comment } = req.body;
    await pool.query('UPDATE orders SET final_price=$1, address=$2, comment=$3 WHERE id=$4', [total_price, address, comment, req.params.id]);
    res.json({success:true});
});
app.post('/api/admin/order/:id/done', async (req, res) => {
    await pool.query("UPDATE orders SET status='completed' WHERE id=$1", [req.params.id]);
    res.json({success:true});
});
app.post('/api/admin/expense', async (req, res) => {
    await pool.query('INSERT INTO expenses (amount, comment) VALUES ($1,$2)', [req.body.amount, req.body.comment]);
    res.json({success:true});
});

// GENERIC DB
app.get('/api/admin/db/:table', async (req, res) => {
    if(!isAdmin(req.query.userId)) return res.status(403).send([]);
    try { const r = await pool.query(`SELECT * FROM ${req.params.table} ORDER BY id DESC LIMIT 50`); res.json(r.rows); } catch(e){res.json([])}
});
app.delete('/api/admin/db/:table/:id', async (req, res) => {
    if(!isAdmin(req.headers['user-id'])) return res.status(403).send({});
    try { await pool.query(`DELETE FROM ${req.params.table} WHERE id=$1`, [req.params.id]); res.json({success:true}); } catch(e){res.json({})}
});

app.get('/api/faq', async (req, res) => { try { const r = await pool.query('SELECT * FROM faq'); res.json(r.rows); } catch(e){res.json([])} });
app.get('/api/image/:fileId', async (req, res) => {
    try { const l = await bot.getFileLink(req.params.fileId); const r = await axios({url:l, responseType:'stream'}); r.data.pipe(res); } catch(e){res.sendStatus(404)}
});

app.listen(PORT, () => console.log('Server running ' + PORT));
