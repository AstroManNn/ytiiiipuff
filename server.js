> ^:
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
                phone VARCHAR(50),
                username VARCHAR(255),
                points INTEGER DEFAULT 500,
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
        `);
        console.log('✅ БД готова.');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

// --- УТИЛИТЫ ---
const getAdmins = () => process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
const isAdmin = (chatId) => getAdmins().includes(chatId.toString());

// Бот теперь нужен только для /start и уведомлений
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Привет! Всё управление теперь внутри Mini App (кнопка 🤖 у админов).');
});


// --- НОВЫЕ API ДЛЯ АДМИНКИ ---

// 1. Добавить товар (с фото)
app.post('/api/admin/product', upload.single('photo'), async (req, res) => {
    try {
        const { userId, name, category, description, price, purchase_price, stock } = req.body;
        
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

> ^:
// Отправляем фото боту (в чат админа), чтобы получить file_id
        // Мы используем первого админа из списка как "хранилище"
        const storageChatId = getAdmins()[0]; 
        
        const photoMsg = await bot.sendPhoto(storageChatId, req.file.buffer, { caption: `New product: ${name}` });
        const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
        const internalLink =legramBot = require('node-telegram-bo

        await pool.query(
            'INSERT INTO products (name, category, description, price, purchase_price, stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [name, category, description, price, purchase_price, stock, internalLink]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error adding product' });
    }
});

// 2. Удалить товар
app.delete('/api/admin/product/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id']; // Передаем ID админа в заголовке
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Delete error' }); }
});

// 3. Получить заказы (активные или архив)
app.get('/api/admin/orders', async (req, res) => {
    try {
        const { userId, status } = req.query;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        const result = await pool.query(
            "SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 50", 
            [status || 'active']
        );
        
        // Получаем имена пользователей для каждого заказа
        const orders = await Promise.all(result.rows.map(async (o) => {
            const u = await pool.query("SELECT name, phone, username FROM users WHERE telegram_id = $1", [o.user_telegram_id]);
            return { 
                ...o, 
                user_data: u.rows[0],
                items: JSON.parse(o.details)
            };
        }));

        res.json(orders);
    } catch (err) { res.status(500).json({ error: 'Orders error' }); }
});

// 4. Завершить заказ
app.post('/api/admin/order/:id/done', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const orderId = req.params.id;

        const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1 AND status = 'active'", [orderId]);
        if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

        const order = orderRes.rows[0];
        const items = JSON.parse(order.details);

        // Списываем сток
        for (const item of items) {
            await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
        }

        await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Done error' }); }
});

// 5. Редактировать заказ
app.put('/api/admin/order/:id', async (req, res) => {
    try {
        const { userId, address, comment } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        await pool.query(
            "UPDATE orders SET address = $1, comment = $2 WHERE id = $3",
            [address, comment, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Update error' }); }
});

// 6. Статистика (существующий код)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.

> ^:
getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

        const ordersRes = await pool.query(
            "SELECT details, total_price FROM orders WHERE status = 'completed' AND created_at >= $1 AND created_at <= $2",
            [startOfMonth, endOfMonth]
        );

        let totalRevenue = 0; 
        let totalCOGS = 0;

        for (const order of ordersRes.rows) {
            totalRevenue += parseFloat(order.total_price);
            const items = JSON.parse(order.details);
            for (const item of items) {
                const productRes = await pool.query("SELECT purchase_price FROM products WHERE id = $1", [item.product_id]);
                if (productRes.rows.length > 0) {
                    const purchasePrice = parseFloat(productRes.rows[0].purchase_price || 0);
                    totalCOGS += purchasePrice * item.quantity;
                }
            }
        }

        const expensesRes = await pool.query(
            "SELECT * FROM expenses WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC",
            [startOfMonth, endOfMonth]
        );

        let totalExpenses = 0;
        const expensesList = expensesRes.rows.map(e => {
            totalExpenses += parseFloat(e.amount);
            return e;
        });

        const netProfit = totalRevenue - totalCOGS - totalExpenses;

        res.json({
            revenue: totalRevenue,
            cogs: totalCOGS,
            expenses: totalExpenses,
            netProfit: netProfit,
            expensesList: expensesList
        });

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

// --- STANDARD API ---

app.get('/', (req, res) => res.send('TripPuff v6 Full Admin Panel Running'));

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
        const userId = req.params.id;
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            user.is_admin = isAdmin(userId);
            res.json(user);
        } else res.status(404).json({ message: 'User not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, phone, username } = req.body;
        const referralCode = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const result = await pool.query(
            'INSERT INTO users (telegram_id, name, phone, username, referral_code) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [userId, name, phone, username, referralCode]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/faq', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM faq ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.

> ^:
get('/api/cart/:userId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.product_id, c.quantity, p.name, p.price, p.image_url 
            FROM cart_items c JOIN products p ON c.product_id = p.id
            WHERE c.user_telegram_id = $1 ORDER BY p.name ASC
        `, [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Cart error' }); }
});

app.post('/api/cart/add', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        const check = await pool.query('SELECT * FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        if (check.rows.length > 0) {
            await pool.query('UPDATE cart_items SET quantity = quantity + 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        } else {
            await pool.query('INSERT INTO cart_items (user_telegram_id, product_id, quantity) VALUES ($1, $2, 1)', [userId, productId]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Add cart error' }); }
});

app.post('/api/cart/remove', async (req, res) => {
    try {
        const { userId, productId, removeAll } = req.body;
        if (removeAll) await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        else {
            const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            if (check.rows.length > 0 && check.rows[0].quantity > 1) {
                await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            } else await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Remove cart error' }); }
});

app.post('/api/order', async (req, res) => {
    try {
        const { userId, address, comment } = req.body;
        const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false });
        const user = userRes.rows[0];
        const cartRes = await pool.query(`SELECT c.quantity, c.product_id, p.name, p.price FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1`, [userId]);
        if (cartRes.rows.length === 0) return res.status(400).json({ success: false });
        const items = cartRes.rows;
        let totalPrice = 0;
        let itemsListText = '';
        items.forEach(item => {
            const sum = item.price * item.quantity;
            totalPrice += sum;
            itemsListText +=s);
    } catch (e) { res.status(404).send('Not 
        });
        const userLink = user.username ?ire('cors');
const { :onst express = require('express');
const cors = requ
        const orderText =xpress');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const multer = require('multer'); // Для загрузки фото
const FormData = requi
        const newOrder = await pool.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, address, comment, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [userId, JSON.stringify(items), totalPrice, address, comment, 'active']
        );
        const orderId = newOrder.rows[0].id;
        await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);
        getAdmins().forEach(adminId => {
            if (adminId) bot.sendMessage(adminId, orderText +а Multer (храним фото в памяти перед отправкой в ТГ)
const upload = mu { parse_mode: 'Markdown' }).catch(e => console.error(e));
        });
        res.json({ success: true });
    } catch (err) { res.status(500).
