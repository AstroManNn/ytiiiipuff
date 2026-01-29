const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 👇 ВСТАВЬ СВОЮ ССЫЛКУ!
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
        const client = await pool.connect();
        try {
            await client.query(`
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
                CREATE TABLE IF NOT EXISTS orders (
                    id SERIAL PRIMARY KEY,
                    user_telegram_id BIGINT NOT NULL,
                    details TEXT NOT NULL,
                    total_price DECIMAL(10, 2),
                    address TEXT,
                    comment TEXT,
                    status VARCHAR(20) DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                -- НОВАЯ ТАБЛИЦА ПРОМОКОДОВ
                CREATE TABLE IF NOT EXISTS promocodes (
                    id SERIAL PRIMARY KEY,
                    code VARCHAR(50) UNIQUE NOT NULL,
                    discount_percent INTEGER NOT NULL,
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Миграции для старых БД (добавляем колонки, если их нет)
            await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_used INTEGER DEFAULT 0;`);
            await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS promocode VARCHAR(50);`);
            await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS initial_price DECIMAL(10, 2);`); // Цена до скидок

            console.log('✅ БД готова.');
        } finally {
            client.release();
        }
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

const getAdmins = () => process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
const isAdmin = (chatId) => getAdmins().includes(chatId.toString());

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Привет! Всё управление теперь внутри Mini App.');
});

// --- API ПРОМОКОДЫ ---
app.get('/api/promocode/check/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const result = await pool.query("SELECT discount_percent FROM promocodes WHERE code = $1 AND is_active = TRUE", [code.trim()]);
        if (result.rows.length > 0) {
            res.json({ success: true, discount: result.rows[0].discount_percent });
        } else {
            res.json({ success: false });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/promocodes', async (req, res) => {
    try {
        if (!isAdmin(req.query.userId)) return res.status(403).json({ error: 'Denied' });
        const result = await pool.query("SELECT * FROM promocodes ORDER BY id DESC");
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/promocode', async (req, res) => {
    try {
        const { userId, code, discount } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        await pool.query("INSERT INTO promocodes (code, discount_percent) VALUES ($1, $2)", [code, discount]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/promocode/:id', async (req, res) => {
    try {
        if (!isAdmin(req.headers['user-id'])) return res.status(403).json({ error: 'Denied' });
        await pool.query("DELETE FROM promocodes WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- АДМИНКА (ТОВАРЫ, ЗАКАЗЫ и т.д.) ---

// Добавление товара
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

// Массовый импорт
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

// Обновление фото
app.post('/api/admin/product/:id/image', upload.single('photo'), async (req, res) => {
    try {
        const userId = req.body.userId;
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

// Удаление товара
app.delete('/api/admin/product/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id']; 
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('DELETE FROM cart_items WHERE product_id = $1', [req.params.id]);
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Delete error: ' + err.message }); }
});

// Изменение стока
app.post('/api/admin/product/stock', async (req, res) => {
    try {
        const { userId, productId, change } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [parseInt(change), productId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Stock update error' }); }
});

// Получить заказы (Админ)
app.get('/api/admin/orders', async (req, res) => {
    try {
        const { userId, status } = req.query;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const result = await pool.query("SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 50", [status || 'active']);
        const orders = await Promise.all(result.rows.map(async (o) => {
            const u = await pool.query("SELECT name, phone, username FROM users WHERE telegram_id = $1", [o.user_telegram_id]);
            return { ...o, user_data: u.rows[0], items: JSON.parse(o.details) };
        }));
        res.json(orders);
    } catch (err) { res.status(500).json({ error: 'Orders error' }); }
});

// Завершить заказ
app.post('/api/admin/order/:id/done', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        
        // Получаем заказ, чтобы начислить баллы (5% от оплаченной суммы)
        const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1 AND status = 'active'", [req.params.id]);
        if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        
        const order = orderRes.rows[0];
        const items = JSON.parse(order.details);
        
        // Списываем сток
        for (const item of items) {
            await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
        }
        
        // Начисляем баллы пользователю (кешбэк 5% от реальной оплаты)
        const cashback = Math.floor(parseFloat(order.total_price) * 0.05);
        if (cashback > 0) {
            await pool.query('UPDATE users SET points = points + $1 WHERE telegram_id = $2', [cashback, order.user_telegram_id]);
        }

        await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Done error' }); }
});

// Редактировать заказ
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

// Статистика
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

// DB MANAGER
const isValidTable = (t) => ['users', 'products', 'expenses', 'faq', 'promocodes'].includes(t); // added promocodes
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


// --- STANDARD API ---
app.get('/', (req, res) => res.send('TripPuff v12 Promo & Points Running'));
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

// История заказов пользователя
app.get('/api/user/:id/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, total_price, status, created_at, points_used, promocode FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, phone, username } = req.body;
        const referralCode = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const result = await pool.query('INSERT INTO users (telegram_id, name, phone, username, referral_code) VALUES ($1, $2, $3, $4, $5) RETURNING *', [userId, name, phone, username, referralCode]);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/products', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM products ORDER BY id DESC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
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

// --- ОФОРМЛЕНИЕ ЗАКАЗА (ОБНОВЛЕНО) ---
app.post('/api/order', async (req, res) => {
    const client = await pool.connect();
    try {
        const { userId, address, comment, promoCode, usePoints } = req.body;
        
        await client.query('BEGIN'); // Транзакция

        const userRes = await client.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0) throw new Error('User not found');
        const user = userRes.rows[0];

        const cartRes = await client.query(`SELECT c.quantity, c.product_id, p.name, p.price FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1`, [userId]);
        if (cartRes.rows.length === 0) throw new Error('Cart empty');
        const items = cartRes.rows;

        // 1. Считаем базовую сумму
        let initialPrice = 0;
        let itemsListText = '';
        items.forEach(item => { 
            const sum = item.price * item.quantity; 
            initialPrice += sum; 
            itemsListText += `- ${item.name} x${item.quantity} = ${sum}₽\n`; 
        });

        // 2. Применяем промокод
        let priceAfterPromo = initialPrice;
        let promoDiscountPercent = 0;
        if (promoCode) {
            const promoRes = await client.query("SELECT discount_percent FROM promocodes WHERE code = $1 AND is_active = TRUE", [promoCode.trim()]);
            if (promoRes.rows.length > 0) {
                promoDiscountPercent = promoRes.rows[0].discount_percent;
                priceAfterPromo = initialPrice * (1 - promoDiscountPercent / 100);
            }
        }

        // 3. Списываем баллы (макс 15% от суммы ПОСЛЕ промокода)
        let pointsToSpend = 0;
        if (usePoints) {
            const maxPoints = Math.floor(priceAfterPromo * 0.15); // Лимит 15%
            pointsToSpend = Math.min(user.points, maxPoints);
            // Вычитаем баллы из цены
            priceAfterPromo -= pointsToSpend;
        }

        const finalPrice = Math.ceil(priceAfterPromo);

        // 4. Формируем текст
        const userLink = user.username ? `@${user.username}` : `[${user.name}](tg://user?id=${user.telegram_id})`;
        let orderText = `📦 *НОВЫЙ ЗАКАЗ*\n\n👤 *Клиент:* ${userLink}\n📞 *Тел:* ${user.phone}\n`;
        orderText += `\n🛒 *Товары:*\n${itemsListText}`;
        orderText += `\n💵 *Подытог:* ${initialPrice}₽`;
        if (promoDiscountPercent > 0) orderText += `\n🏷 *Промокод:* ${promoCode} (-${promoDiscountPercent}%)`;
        if (pointsToSpend > 0) orderText += `\n💎 *Списано баллов:* ${pointsToSpend}`;
        orderText += `\n\n💰 *ИТОГО К ОПЛАТЕ: ${finalPrice}₽*`;
        orderText += `\n\n📍 *Адрес:* \`${address}\`\n💬 *Коммент:* ${comment || '-'}`;

        // 5. Запись в БД
        const newOrder = await client.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, initial_price, address, comment, status, points_used, promocode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id', 
            [userId, JSON.stringify(items), finalPrice, initialPrice, address, comment, 'active', pointsToSpend, promoCode || null]
        );

        // 6. Очистка корзины и списание баллов у юзера
        await client.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);
        if (pointsToSpend > 0) {
            await client.query('UPDATE users SET points = points - $1 WHERE telegram_id = $2', [pointsToSpend, userId]);
        }

        await client.query('COMMIT');

        getAdmins().forEach(adminId => { 
            if (adminId) bot.sendMessage(adminId, orderText + `\n🆔 *ID:* ${newOrder.rows[0].id}`, { parse_mode: 'Markdown' }).catch(e => console.error(e)); 
        });

        res.json({ success: true });
    } catch (err) { 
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: err.message }); 
    } finally {
        client.release();
    }
});

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
