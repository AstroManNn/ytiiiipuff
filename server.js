const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 👇 ВСТАВЬ СЮДА СВОЮ ССЫЛКУ С RAILWAY (без слэша в конце)
const SERVER_URL = 'https://ytiiiipuff-production.up.railway.app'; 

app.use(cors());
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
if (!process.env.DATABASE_URL) console.error("❌ Нет DATABASE_URL");
if (!process.env.BOT_TOKEN) console.error("❌ Нет BOT_TOKEN");
if (!process.env.ADMIN_CHAT_ID) console.error("❌ Нет ADMIN_CHAT_ID");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const adminStates = {}; 

// Список категорий
const CATEGORIES = ['Жидкости', 'Одноразки', 'Снюс', 'POD-системы', 'Картриджи'];

// --- ИНИЦИАЛИЗАЦИЯ БД ---
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
                category VARCHAR(100), -- Категория
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                image_url TEXT,
                stock INTEGER DEFAULT 0,
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

        // Миграция: Добавляем колонку category, если её нет
        await pool.query(`
            DO $$ BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='category') THEN 
                    ALTER TABLE products ADD COLUMN category VARCHAR(100); 
                END IF;
            END $$;
        `);
        console.log('✅ БД готова (Categories added).');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

// --- ЛОГИКА БОТА ---

const isAdmin = (chatId) => {
    const admins = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
    return admins.includes(chatId.toString());
};

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            ['➕ Добавить т/в', '❌ Удалить т/в'],
            ['📦 Заказы']
        ],
        resize_keyboard: true
    }
};

bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.chat.id)) {
        bot.sendMessage(msg.chat.id, 'Админ-панель V4.0 (Categories)', mainKeyboard);
    } else {
        bot.sendMessage(msg.chat.id, 'Привет! Открой Mini App.');
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const text = msg.text;
    const state = adminStates[chatId];

    // --- ГЛАВНОЕ МЕНЮ ---
    
    // 1. Добавить товар (Начинаем с категорий)
    if (text === '➕ Добавить т/в') {
        adminStates[chatId] = { step: 'WAITING_CATEGORY', data: {} };
        // Создаем клавиатуру с категориями
        const catButtons = CATEGORIES.map(c => [c]);
        return bot.sendMessage(chatId, 'Выберите категорию:', {
            reply_markup: {
                keyboard: catButtons,
                resize_keyboard: true,
                one_time_keyboard: true
            }
        });
    }

    // 2. Удалить товар
    if (text === '❌ Удалить т/в') {
        try {
            const res = await pool.query('SELECT id, name, category, stock FROM products ORDER BY id ASC');
            if (res.rows.length === 0) return bot.sendMessage(chatId, 'Список пуст.', mainKeyboard);
            
            let list = '🗑 *Удаление товаров:*\n\n';
            res.rows.forEach(p => list += `${p.id}. [${p.category || 'Без кат.'}] ${p.name} (Ост: ${p.stock})\n`);
            list += '\nНапишите `/del ID` для удаления.';
            return bot.sendMessage(chatId, list, { parse_mode: 'Markdown', ...mainKeyboard });
        } catch (e) { return bot.sendMessage(chatId, 'Ошибка БД'); }
    }

    // 3. Заказы
    if (text === '📦 Заказы') {
        return showOrders(chatId, 'active');
    }

    // --- КОМАНДЫ ---
    if (text && text.startsWith('/del ')) {
        const id = text.split(' ')[1];
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        return bot.sendMessage(chatId, `✅ Товар ${id} удален.`);
    }

    if (text && text.startsWith('/done ')) {
        const id = text.split(' ')[1];
        if (!id) return;
        try {
            const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1 AND status = 'active'", [id]);
            if (orderRes.rows.length === 0) return bot.sendMessage(chatId, '❌ Заказ не найден.');
            const order = orderRes.rows[0];
            const items = JSON.parse(order.details);
            for (const item of items) {
                await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
            }
            await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [id]);
            bot.sendMessage(chatId, `✅ Заказ #${id} завершен.`);
            return showOrders(chatId, 'active');
        } catch (e) { return bot.sendMessage(chatId, 'Ошибка завершения.'); }
    }

    if (text === '/archive') {
        return showOrders(chatId, 'completed');
    }

    // --- МАШИНА СОСТОЯНИЙ ---
    if (state) {
        // Шаг 1: Категория
        if (state.step === 'WAITING_CATEGORY') {
            if (!CATEGORIES.includes(text)) {
                return bot.sendMessage(chatId, 'Пожалуйста, выберите категорию кнопкой.');
            }
            state.data.category = text;
            state.step = 'WAITING_NAME';
            // Убираем клавиатуру категорий, возвращаем обычную (но она скроется, пока пишем текст)
            return bot.sendMessage(chatId, 'Введите название товара:', { reply_markup: { remove_keyboard: true } });
        }

        if (state.step === 'WAITING_NAME') {
            state.data.name = text;
            state.step = 'WAITING_PRICE';
            return bot.sendMessage(chatId, 'Введите цену (число):');
        }
        if (state.step === 'WAITING_PRICE') {
            state.data.price = parseFloat(text);
            state.step = 'WAITING_STOCK';
            return bot.sendMessage(chatId, 'Введите количество (сток):');
        }
        if (state.step === 'WAITING_STOCK') {
            state.data.stock = parseInt(text);
            state.step = 'WAITING_DESC';
            return bot.sendMessage(chatId, 'Введите описание:');
        }
        if (state.step === 'WAITING_DESC') {
            state.data.description = text;
            state.step = 'WAITING_PHOTO';
            return bot.sendMessage(chatId, 'Отправьте фото:');
        }
    }
});

// Функция показа заказов (с составом)
async function showOrders(chatId, status) {
    try {
        const res = await pool.query(
            "SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 10", 
            [status]
        );
        
        const title = status === 'active' ? '🔥 ДЕЙСТВУЮЩИЕ' : '🗄 АРХИВ';
        let msg = `*${title}*\n\n`;

        if (res.rows.length === 0) msg += "Пусто.";
        else {
            res.rows.forEach(o => {
                const date = new Date(o.created_at).toLocaleDateString('ru-RU');
                const items = JSON.parse(o.details);
                
                msg += `🆔 *#${o.id}* (${date}) | ${o.total_price}₽\n`;
                msg += `📍 ${o.address}\n`;
                // Состав заказа
                msg += `🛒 *Состав:*\n`;
                items.forEach(i => {
                    msg += `   • ${i.name} x${i.quantity}\n`;
                });
                msg += `------------------\n`;
            });
        }

        if (status === 'active') msg += "\n✅ В архив: `/done ID`\n🗄 Архив: `/archive`";
        
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (e) { console.error(e); }
}

// Обработка Фото (Прокси)
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const state = adminStates[chatId];

    if (state && state.step === 'WAITING_PHOTO') {
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const internalLink = `${SERVER_URL}/api/image/${fileId}`;

            await pool.query(
                'INSERT INTO products (name, category, description, price, stock, image_url) VALUES ($1, $2, $3, $4, $5, $6)',
                [state.data.name, state.data.category, state.data.description, state.data.price, state.data.stock, internalLink]
            );

            delete adminStates[chatId];
            bot.sendMessage(chatId, `✅ Товар добавлен в категорию "${state.data.category}"!`, mainKeyboard);

        } catch (e) {
            console.error('Save Error:', e);
            bot.sendMessage(chatId, '❌ Ошибка сохранения.', mainKeyboard);
        }
    }
});

// --- API ---

app.get('/', (req, res) => res.send('TripPuff v4 Running'));

// Прокси для картинок
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
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ message: 'User not found' });
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
        // Теперь возвращаем и category
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

app.get('/api/cart/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT c.product_id, c.quantity, p.name, p.price, p.image_url 
            FROM cart_items c JOIN products p ON c.product_id = p.id
            WHERE c.user_telegram_id = $1 ORDER BY p.name ASC
        `, [userId]);
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
        if (removeAll) {
             await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        } else {
            const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            if (check.rows.length > 0) {
                if (check.rows[0].quantity > 1) {
                    await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
                } else {
                    await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
                }
            }
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

        const cartRes = await pool.query(`
            SELECT c.quantity, c.product_id, p.name, p.price 
            FROM cart_items c JOIN products p ON c.product_id = p.id
            WHERE c.user_telegram_id = $1
        `, [userId]);

        if (cartRes.rows.length === 0) return res.status(400).json({ success: false });
        const items = cartRes.rows;
        let totalPrice = 0;
        let itemsListText = '';
        items.forEach(item => {
            const sum = item.price * item.quantity;
            totalPrice += sum;
            itemsListText += `- ${item.name} x${item.quantity} = ${sum}₽\n`;
        });

        const userLink = user.username ? `@${user.username}` : `[${user.name}](tg://user?id=${user.telegram_id})`;
        const orderText = `📦 *НОВЫЙ ЗАКАЗ*\n\n👤 *Клиент:* ${user.name}\n🔗 *Ссылка:* ${userLink}\n📞 *Телефон:* ${user.phone}\n\n📍 *Адрес:* \`${address}\`\n💬 *Комментарий:* ${comment || 'Нет'}\n\n🛒 *Товары:*\n${itemsListText}\n💰 *ИТОГО: ${totalPrice}₽*`;

        const newOrder = await pool.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, address, comment, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [userId, JSON.stringify(items), totalPrice, address, comment, 'active']
        );
        const orderId = newOrder.rows[0].id;
        await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        const adminIds = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
        const adminMsg = orderText + `\n🆔 *ID:* ${orderId}\n\n👉 Списать и в архив:\n/done ${orderId}`;
        
        for (const adminId of adminIds) {
            if (adminId) bot.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }).catch(e => console.error(e));
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
