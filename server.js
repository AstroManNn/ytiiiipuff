const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const multer = require('multer'); // Для загрузки фото
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 👇 ВСТАВЬ СВОЮ ССЫЛКУ!
const SERVER_URL = 'https://ytiiiipuff-production.up.railway.app'; 

app.use(cors());
app.use(express.json());

// Настройка Multer (храним фото в памяти перед отправкой в ТГ)
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
                username VARCHAR(255),
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
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_telegram_id BIGINT NOT NULL,
                details TEXT NOT NULL,
                total_price DECIMAL(10, 2),
                subtotal_price DECIMAL(10, 2),
                promo_code VARCHAR(50),
                promo_discount_percent INTEGER DEFAULT 0,
                address TEXT,
                comment TEXT,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            `);

        // Promo codes table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS promo_codes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                discount_percent INTEGER NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        
        // --- settings schema (robust / backward-compatible) ---
        // В старых деплоях таблица `settings` могла существовать в другом формате (например, с колонкой "key" NOT NULL).
        // Поэтому: (1) создаем таблицу, если ее нет, (2) определяем реальные имена колонок, (3) используем их везде далее.
        const { rows: settingsTableRows } = await pool.query(`SELECT to_regclass('public.settings') AS reg;`);
        if (!settingsTableRows[0]?.reg) {
            await pool.query(`
                CREATE TABLE settings (
                    "key" TEXT PRIMARY KEY,
                    value TEXT
                );
            `);
        }

        const { rows: settingsColsRows } = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'settings'
        `);
        const settingsCols = new Set(settingsColsRows.map(r => r.column_name));

        // choose key/value columns that actually exist
        const SETTINGS_KEY_COL = settingsCols.has('key')
            ? 'key'
            : (settingsCols.has('setting_key') ? 'setting_key' : (settingsCols.has('name') ? 'name' : (settingsCols.has('setting') ? 'setting' : null)));

        const SETTINGS_VALUE_COL = settingsCols.has('value')
            ? 'value'
            : (settingsCols.has('setting_value') ? 'setting_value' : null);

        // If no key/value column detected, create minimal compatible columns
        if (!SETTINGS_KEY_COL) {
            await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS "key" TEXT;`);
        }
        if (!SETTINGS_VALUE_COL) {
            await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS value TEXT;`);
        }

        // expose for later handlers
        global.__SETTINGS_KEY_COL = SETTINGS_KEY_COL || 'key';
        global.__SETTINGS_VALUE_COL = SETTINGS_VALUE_COL || 'value';

        // Ensure default setting exists without relying on UNIQUE/PK constraints on a specific column name
        await pool.query(
            `INSERT INTO settings ("${global.__SETTINGS_KEY_COL}", "${global.__SETTINGS_VALUE_COL}")
             SELECT $1, $2
             WHERE NOT EXISTS (
                 SELECT 1 FROM settings WHERE "${global.__SETTINGS_KEY_COL}" = $1
             );`,
            ['reviews_channel_url', '']
        );

// Safe schema upgrades for existing deployments
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_price DECIMAL(10, 2);`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50);`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount_percent INTEGER DEFAULT 0;`);        console.log('✅ БД готова.');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

// --- УТИЛИТЫ ---
const getAdmins = () => process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
const isAdmin = (chatId) => getAdmins().includes(chatId.toString());

const normalizePromoCode = (code) => (code || '').toString().trim().toUpperCase();

const clampInt = (v, min, max) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
};

// Бот теперь нужен только для /start и уведомлений
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Привет! Всё управление теперь внутри Mini App (кнопка 🤖 у админов).');
});

// --- АДМИНКА ---

// 1. Добавить товар (Одиночный)
app.post('/api/admin/product', upload.single('photo'), async (req, res) => {
    try {
        const { userId, name, category, description, price, purchase_price, stock } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        let internalLink = null;
        if (req.file) {
            const storageChatId = getAdmins()[0]; 
            const photoMsg = await bot.sendPhoto(storageChatId, req.file.buffer, { caption: `New product: ${name}` });
            const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
            internalLink = `${SERVER_URL}/api/image/${fileId}`;
        } else {
            internalLink = 'https://via.placeholder.com/300x300.png?text=No+Photo'; 
        }

        await pool.query(
            'INSERT INTO products (name, category, description, price, purchase_price, stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [name, category, description, price, purchase_price || 0, stock || 0, internalLink]
        );
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error adding product' }); }
});

// 1.1 Массовый импорт (Batch)
app.post('/api/admin/products/batch', async (req, res) => {
    try {
        const { userId, products } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN'); 
            const defaultImage = 'https://via.placeholder.com/300x300.png?text=No+Photo'; 
            for (const p of products) {
                await client.query(
                    'INSERT INTO products (name, category, description, price, purchase_price, stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [p.name, p.category, p.description || '', p.price, p.purchase_price || 0, p.stock || 0, defaultImage]
                );
            }
            await client.query('COMMIT'); 
            res.json({ success: true, count: products.length });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Batch import error' }); }
});

// 1.2 БЫСТРОЕ ОБНОВЛЕНИЕ ФОТО (НОВОЕ)
app.post('/api/admin/product/:id/image', upload.single('photo'), async (req, res) => {
    try {
        const userId = req.body.userId; // Multer parses body too
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        if (!req.file) return res.status(400).json({ error: 'No photo' });

        const storageChatId = getAdmins()[0]; 
        const photoMsg = await bot.sendPhoto(storageChatId, req.file.buffer, { caption: `Updated photo for ID: ${req.params.id}` });
        const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
        const internalLink = `${SERVER_URL}/api/image/${fileId}`;

        await pool.query('UPDATE products SET image_url = $1 WHERE id = $2', [internalLink, req.params.id]);
        
        res.json({ success: true, imageUrl: internalLink });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Image upload error' }); }
});

// 2. Удалить товар (ИСПРАВЛЕНО: удаляет и из корзин тоже)
app.delete('/api/admin/product/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id']; 
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        const productId = req.params.id;

        // 1. Сначала удаляем этот товар из всех корзин пользователей
        await pool.query('DELETE FROM cart_items WHERE product_id = $1', [productId]);

        // 2. Теперь удаляем сам товар
        await pool.query('DELETE FROM products WHERE id = $1', [productId]);

        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Delete error: ' + err.message }); 
    }
});

// 2.1 Изменить сток
app.post('/api/admin/product/stock', async (req, res) => {
    try {
        const { userId, productId, change } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [parseInt(change), productId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Stock update error' }); }
});

// 3. Получить заказы
app.get('/api/admin/orders', async (req, res) => {
    try {
        const { userId, status } = req.query;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const result = await pool.query("SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 50", [status || 'active']);
        const orders = await Promise.all(result.rows.map(async (o) => {
            const u = await pool.query("SELECT name, username FROM users WHERE telegram_id = $1", [o.user_telegram_id]);
            return { ...o, user_data: u.rows[0], items: JSON.parse(o.details) };
        }));
        res.json(orders);
    } catch (err) { res.status(500).json({ error: 'Orders error' }); }
});

// 4. Завершить заказ
app.post('/api/admin/order/:id/done', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        const orderRes = await pool.query("SELECT id FROM orders WHERE id = $1 AND status = 'active'", [req.params.id]);
        if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

        await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Done error' }); }
});

// 5. Редактировать заказ
app.put('/api/admin/order/:id', async (req, res) => {
    try {
        const { userId, address, comment, details, total_price } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query(
            "UPDATE orders SET address = $1, comment = $2, details = $3, total_price = $4 WHERE id = $5",
            [address, comment, JSON.stringify(details), total_price, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Update error' }); }
});

// 6. Статистика
app.get('/api/admin/stats', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const ordersRes = await pool.query("SELECT details, total_price FROM orders WHERE status = 'completed' AND created_at >= $1 AND created_at <= $2", [startOfMonth, endOfMonth]);
        let totalRevenue = 0, totalCOGS = 0;
        for (const order of ordersRes.rows) {
            totalRevenue += parseFloat(order.total_price);
            const items = JSON.parse(order.details);
            for (const item of items) {
                const productRes = await pool.query("SELECT purchase_price FROM products WHERE id = $1", [item.product_id]);
                if (productRes.rows.length > 0) totalCOGS += parseFloat(productRes.rows[0].purchase_price || 0) * item.quantity;
            }
        }
        const expensesRes = await pool.query("SELECT * FROM expenses WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC", [startOfMonth, endOfMonth]);
        let totalExpenses = 0;
        const expensesList = expensesRes.rows.map(e => { totalExpenses += parseFloat(e.amount); return e; });
        res.json({ revenue: totalRevenue, cogs: totalCOGS, expenses: totalExpenses, netProfit: totalRevenue - totalCOGS - totalExpenses, expensesList });
    } catch (err) { res.status(500).json({ error: 'Stats error' }); }
});

app.post('/api/admin/expense', async (req, res) => {
    try {
        const { userId, amount, comment } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('INSERT INTO expenses (amount, comment) VALUES ($1, $2)', [amount, comment]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 7. VISUAL DB MANAGER
const isValidTable = (t) => ['users', 'products', 'expenses', 'faq', 'orders', 'cart_items', 'promo_codes'].includes(t);

app.get('/api/admin/db/:table', async (req, res) => {
    try {
        if (!isAdmin(req.query.userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const result = await pool.query(`SELECT * FROM ${req.params.table} ORDER BY id DESC LIMIT 100`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/db/:table', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const data = req.body;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        await pool.query(`INSERT INTO ${req.params.table} (${keys.join(', ')}) VALUES (${placeholders})`, values);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/db/:table/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const data = req.body;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        await pool.query(`UPDATE ${req.params.table} SET ${setClause} WHERE id = $${values.length + 1}`, [...values, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/db/:table/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        await pool.query(`DELETE FROM ${req.params.table} WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PROMO CODES (ADMIN) ---
app.get('/api/admin/promos', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const result = await pool.query('SELECT * FROM promo_codes ORDER BY id DESC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Promos error' }); }
});

app.post('/api/admin/promos', async (req, res) => {
    try {
        const { userId, code, discount_percent } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const promoCode = normalizePromoCode(code);
        const pct = clampInt(discount_percent, 1, 100);
        if (!promoCode) return res.status(400).json({ error: 'Empty code' });
        await pool.query(
            'INSERT INTO promo_codes (code, discount_percent, is_active) VALUES ($1, $2, TRUE) ON CONFLICT (code) DO UPDATE SET discount_percent = EXCLUDED.discount_percent, is_active = TRUE',
            [promoCode, pct]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Create promo error' }); }
});

app.put('/api/admin/promos/:id', async (req, res) => {
    try {
        const { userId, discount_percent, is_active } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const pct = discount_percent !== undefined ? clampInt(discount_percent, 1, 100) : null;
        const active = (is_active === undefined) ? null : !!is_active;

        const sets = [];
        const vals = [];
        let idx = 1;
        if (pct !== null) { sets.push(`discount_percent = $${idx++}`); vals.push(pct); }
        if (active !== null) { sets.push(`is_active = $${idx++}`); vals.push(active); }
        if (sets.length === 0) return res.json({ success: true });
        vals.push(req.params.id);
        await pool.query(`UPDATE promo_codes SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Update promo error' }); }
});

app.delete('/api/admin/promos/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('DELETE FROM promo_codes WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Delete promo error' }); }
});

// --- STANDARD API ---
app.get('/', (req, res) => res.send('TripPuff v11 Photo Wizard Running'));
app.get('/api/image/:fileId', async (req, res) => {
    try {
        const fileLink = await bot.getFileLink(req.params.fileId);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        res.setHeader('Content-Type', 'image/jpeg');
        response.data.pipe(res);
    } catch (e) { res.status(404).send('Not found'); }
});
app.get('/api/user/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.id]);
        if (result.rows.length > 0) { const user = result.rows[0]; user.is_admin = isAdmin(req.params.id); res.json(user); } 
        else res.status(404).json({ message: 'User not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get user's own order history (for profile)
app.get('/api/user/:id/orders', async (req, res) => {
    try {
        const userId = req.params.id;
        const result = await pool.query(
            'SELECT id, details, total_price, subtotal_price, promo_code, promo_discount_percent, address, comment, status, created_at FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC LIMIT 100',
            [userId]
        );
        const rows = result.rows.map(r => ({
            ...r,
            items: (() => { try { return JSON.parse(r.details); } catch { return []; } })()
        }));
        res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Orders history error' }); }
});

// Validate promo code (public)
app.post('/api/promo/validate', async (req, res) => {
    try {
        const code = normalizePromoCode(req.body.code);
        if (!code) return res.status(400).json({ valid: false, message: 'Пустой промокод' });
        const result = await pool.query('SELECT code, discount_percent, is_active FROM promo_codes WHERE code = $1', [code]);
        if (result.rows.length === 0) return res.json({ valid: false, message: 'Промокод не найден' });
        const row = result.rows[0];
        if (!row.is_active) return res.json({ valid: false, message: 'Промокод неактивен' });
        res.json({ valid: true, code: row.code, discount_percent: row.discount_percent });
    } catch (e) { res.status(500).json({ valid: false, message: 'Ошибка сервера' }); }
});
app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, username } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'No userId' });

        const cleanName = (name || '').toString().trim();
        const rawU = (username || '').toString().trim();
        const cleanUsername = rawU ? (rawU.startsWith('@') ? rawU : ('@' + rawU)) : '';

        const q = `
            INSERT INTO users (telegram_id, name, username)
            VALUES ($1, $2, $3)
            ON CONFLICT (telegram_id) DO UPDATE
            SET
                name = EXCLUDED.name,
                username = CASE
                    WHEN EXCLUDED.username <> '' THEN EXCLUDED.username
                    ELSE users.username
                END
            RETURNING *;
        `;
        const result = await pool.query(q, [userId, cleanName, cleanUsername]);
        const user = result.rows[0];
        user.is_admin = isAdmin(userId);
        res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/products', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM products ORDER BY id DESC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reviews channel link (stored in settings.reviews_channel_url)
app.get('/api/reviews-channel', async (req, res) => {
    try {
        const r = await pool.query(`SELECT "${global.__SETTINGS_VALUE_COL || "value"}" AS value FROM settings WHERE "${global.__SETTINGS_KEY_COL || "key"}" = $1 LIMIT 1`, ['reviews_channel_url']);
        res.json({ url: r.rows[0]?.value || '' });
    } catch (e) {
        res.json({ url: '' });
    }
});

app.get('/api/faq', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM faq ORDER BY id ASC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/cart/:userId', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.product_id, c.quantity, p.name, p.price, p.image_url FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1 ORDER BY p.name ASC`, [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Cart error' }); }
});
app.post('/api/cart/add', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        const check = await pool.query('SELECT * FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        if (check.rows.length > 0) await pool.query('UPDATE cart_items SET quantity = quantity + 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        else await pool.query('INSERT INTO cart_items (user_telegram_id, product_id, quantity) VALUES ($1, $2, 1)', [userId, productId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Add cart error' }); }
});
app.post('/api/cart/remove', async (req, res) => {
    try {
        const { userId, productId, removeAll } = req.body;
        if (removeAll) await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        else {
            const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            if (check.rows.length > 0 && check.rows[0].quantity > 1) await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            else await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Remove cart error' }); }
});
app.post('/api/order', async (req, res) => {
    const pickupContactLink = 'https://t.me/trippuff?text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82,%20%D1%8F%20%D0%BF%D0%BE%20%D0%BF%D0%BE%D0%B2%D0%BE%D0%B4%D1%83%20%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%D0%B0';
    const client = await pool.connect();
    try {
        const { userId, promo_code, comment } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'No userId' });

        await client.query('BEGIN');

        const userRes = await client.query('SELECT telegram_id, name, username FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        const user = userRes.rows[0];

        const cartRes = await client.query(
            `SELECT c.quantity, c.product_id, p.name, p.price, p.stock
             FROM cart_items c
             JOIN products p ON c.product_id = p.id
             WHERE c.user_telegram_id = $1
             FOR UPDATE OF p`,
            [userId]
        );
        if (cartRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Cart empty' });
        }

        const items = cartRes.rows;

        // Check stock & subtotal
        let subtotal = 0;
        let itemsListText = '';
        for (const item of items) {
            const qty = parseInt(item.quantity, 10) || 0;
            const stock = parseInt(item.stock, 10) || 0;
            if (qty <= 0) continue;
            if (stock < qty) {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, message: `Недостаточно товара: ${item.name}` });
            }
            const price = Number(item.price);
            const sum = price * qty;
            subtotal += sum;
            itemsListText += `- ${item.name} x${qty} = ${Math.ceil(sum)}₽
`;
        }

        // Promo
        let appliedPromoCode = null;
        let promoPercent = 0;
        const codeNorm = normalizePromoCode(promo_code);
        if (codeNorm) {
            const promoRes = await client.query('SELECT code, discount_percent, is_active FROM promo_codes WHERE code = $1', [codeNorm]);
            if (promoRes.rows.length > 0 && promoRes.rows[0].is_active) {
                appliedPromoCode = promoRes.rows[0].code;
                promoPercent = clampInt(promoRes.rows[0].discount_percent, 0, 100);
            }
        }

        const afterPromo = promoPercent > 0 ? (subtotal - (subtotal * (promoPercent / 100))) : subtotal;
        const totalPrice = Math.max(0, Math.ceil(afterPromo));

        // Deduct stock immediately on order creation
        for (const item of items) {
            const qty = parseInt(item.quantity, 10) || 0;
            if (qty <= 0) continue;
            const upd = await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1',
                [qty, item.product_id]
            );
            if (upd.rowCount !== 1) {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, message: `Недостаточно товара: ${item.name}` });
            }
        }

        const newOrder = await client.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, subtotal_price, promo_code, promo_discount_percent, comment, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [userId, JSON.stringify(items), totalPrice, subtotal, appliedPromoCode, promoPercent, (comment || '').toString(), 'active']
        );

        await client.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        await client.query('COMMIT');

        const uname = (user.username || '').toString().trim();
        const displayUser = uname ? uname : `[${(user.name || 'Пользователь').toString()}](tg://user?id=${userId})`;
        const promoLine = appliedPromoCode ? `
🎟 *Промокод:* ${appliedPromoCode} (-${promoPercent}%)` : '';
        const commentLine = comment ? `
💬 *Комментарий:* ${String(comment)}` : '';

        const orderText =
            `📦 *НОВЫЙ ЗАКАЗ*

` +
            `👤 *Клиент:* ${(user.name || 'Пользователь').toString()}
` +
            `🔗 *Контакт:* ${displayUser}
` +
            `📍 *Выдача:* уточнить в чате
` +
            `💬 *Чат:* ${pickupContactLink}

` +
            `🛒 *Товары:*
${itemsListText}` +
            `💵 *Сумма:* ${Math.ceil(subtotal)}₽${promoLine}${commentLine}
` +
            `💰 *ИТОГО: ${totalPrice}₽*`;

        getAdmins().forEach(adminId => {
            if (!adminId) return;
            bot.sendMessage(
                adminId,
                orderText + `
🆔 *ID:* ${newOrder.rows[0].id}

🤖 Зайдите в админ-панель для управления.`,
                { parse_mode: 'Markdown' }
            ).catch(e => console.error(e));
        });

        res.json({
            success: true,
            orderId: newOrder.rows[0].id,
            total_price: totalPrice,
            promo_code: appliedPromoCode,
            promo_discount_percent: promoPercent,
            pickup_contact_link: pickupContactLink
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch(_){}
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
