const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                image_url TEXT,
                stock INTEGER DEFAULT 0,  -- Добавлено поле количества
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
                status VARCHAR(20) DEFAULT 'active', -- 'active' или 'completed'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Миграции для старых баз данных (добавляем колонки, если их нет)
        await pool.query(`
            DO $$ BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='stock') THEN 
                    ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 0; 
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='status') THEN 
                    ALTER TABLE orders ADD COLUMN status VARCHAR(20) DEFAULT 'active'; 
                END IF;
            END $$;
        `);
        console.log('✅ БД готова (v3 Stock & Orders).');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

// --- ЛОГИКА БОТА ---

const isAdmin = (chatId) => {
    const admins = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
    return admins.includes(chatId.toString());
};

const adminKeyboard = {
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
        bot.sendMessage(msg.chat.id, 'Админ-панель V3.0', adminKeyboard);
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
    
    // 1. Добавить товар
    if (text === '➕ Добавить т/в') {
        adminStates[chatId] = { step: 'WAITING_NAME', data: {} };
        return bot.sendMessage(chatId, 'Введите название товара:');
    }

    // 2. Удалить товар
    if (text === '❌ Удалить т/в') {
        try {
            const res = await pool.query('SELECT id, name, stock FROM products ORDER BY id ASC');
            if (res.rows.length === 0) return bot.sendMessage(chatId, 'Список пуст.');
            
            let list = '🗑 *Удаление товаров:*\n\n';
            res.rows.forEach(p => list += `${p.id}. ${p.name} (В наличии: ${p.stock})\n`);
            list += '\nНапишите `/del ID` для удаления.';
            return bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
        } catch (e) { return bot.sendMessage(chatId, 'Ошибка БД'); }
    }

    // 3. Список заказов (Активные)
    if (text === '📦 Заказы') {
        return showOrders(chatId, 'active');
    }

    // --- КОМАНДЫ ---

    // Удаление товара
    if (text && text.startsWith('/del ')) {
        const id = text.split(' ')[1];
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        return bot.sendMessage(chatId, `✅ Товар ${id} удален.`);
    }

    // Завершение заказа (/done)
    if (text && text.startsWith('/done ')) {
        const id = text.split(' ')[1];
        if (!id) return;

        try {
            // 1. Получаем заказ
            const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1 AND status = 'active'", [id]);
            if (orderRes.rows.length === 0) return bot.sendMessage(chatId, '❌ Заказ не найден или уже завершен.');
            
            const order = orderRes.rows[0];
            const items = JSON.parse(order.details); // [{ product_id, quantity, ... }]

            // 2. Списываем товары со склада
            for (const item of items) {
                // Если product_id не найден (товар удалили), игнорируем
                // SQL: Уменьшаем stock на quantity
                await pool.query(
                    'UPDATE products SET stock = stock - $1 WHERE id = $2',
                    [item.quantity, item.product_id]
                );
            }

            // 3. Меняем статус заказа
            await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [id]);

            bot.sendMessage(chatId, `✅ Заказ #${id} перенесен в архив. Остатки товаров списаны.`);
            // Показываем обновленный список
            return showOrders(chatId, 'active');

        } catch (e) {
            console.error(e);
            return bot.sendMessage(chatId, 'Ошибка при завершении заказа.');
        }
    }

    // Архив (/archive)
    if (text === '/archive') {
        return showOrders(chatId, 'completed');
    }

    // --- МАШИНА СОСТОЯНИЙ (Добавление) ---
    if (state) {
        if (state.step === 'WAITING_NAME') {
            state.data.name = text;
            state.step = 'WAITING_PRICE';
            return bot.sendMessage(chatId, 'Введите цену (число):');
        }
        if (state.step === 'WAITING_PRICE') {
            state.data.price = parseFloat(text);
            state.step = 'WAITING_STOCK'; // НОВЫЙ ШАГ
            return bot.sendMessage(chatId, 'Введите количество товара в наличии (число):');
        }
        if (state.step === 'WAITING_STOCK') { // НОВЫЙ ШАГ
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

// Функция показа заказов
async function showOrders(chatId, status) {
    try {
        const res = await pool.query(
            "SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 10", 
            [status]
        );
        
        const title = status === 'active' ? '🔥 ДЕЙСТВУЮЩИЕ ЗАКАЗЫ' : '🗄 АРХИВ ЗАКАЗОВ';
        let msg = `*${title}*\n\n`;

        if (res.rows.length === 0) {
            msg += "Список пуст.";
        } else {
            res.rows.forEach(o => {
                const date = new Date(o.created_at).toLocaleDateString('ru-RU');
                msg += `🆔 *Заказ #${o.id}* (${date})\n`;
                msg += `💰 Сумма: ${o.total_price}₽\n`;
                msg += `📍 Адрес: ${o.address}\n`;
                msg += `------------------\n`;
            });
        }

        if (status === 'active') {
            msg += "\n✅ Завершить заказ: `/done ID`\n🗄 Архив: `/archive`";
        }

        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) { console.error(e); }
}

// --- ОБРАБОТКА ФОТО (НАДЕЖНАЯ ЗАГРУЗКА) ---
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const state = adminStates[chatId];

    if (state && state.step === 'WAITING_PHOTO') {
        bot.sendMessage(chatId, '⏳ Обработка и загрузка фото... (это может занять пару секунд)');
        
        try {
            // 1. Получаем ссылку и скачиваем фото в буфер (память)
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await bot.getFileLink(fileId);
            
            // Скачиваем как ArrayBuffer
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            let permLink = null;

            // 2. Попытка №1: Загрузка на Telegraph
            try {
                const form = new FormData();
                form.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

                const uploadRes = await axios.post('https://telegra.ph/upload', form, {
                    headers: {
                        ...form.getHeaders(),
                        // Притворяемся браузером, чтобы не заблокировали
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });

                if (uploadRes.data && uploadRes.data[0] && uploadRes.data[0].src) {
                    permLink = 'https://telegra.ph' + uploadRes.data[0].src;
                    console.log('✅ Загружено на Telegraph:', permLink);
                }
            } catch (telegraphError) {
                console.error('⚠️ Telegraph error (пробую резерв):', telegraphError.message);
            }

            // 3. Попытка №2: Загрузка на Catbox (если Telegraph не сработал)
            if (!permLink) {
                try {
                    const formCat = new FormData();
                    formCat.append('reqtype', 'fileupload');
                    formCat.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

                    const catRes = await axios.post('https://catbox.moe/user/api.php', formCat, {
                        headers: { ...formCat.getHeaders() }
                    });
                    
                    if (catRes.data && catRes.data.startsWith('http')) {
                        permLink = catRes.data;
                        console.log('✅ Загружено на Catbox:', permLink);
                    }
                } catch (catError) {
                    console.error('❌ Catbox error:', catError.message);
                }
            }

            // 4. Если ничего не вышло
            if (!permLink) {
                return bot.sendMessage(chatId, '❌ Не удалось загрузить изображение ни на один сервер. Попробуйте другое фото.');
            }

            // 5. Сохраняем в БД
            await pool.query(
                'INSERT INTO products (name, description, price, stock, image_url) VALUES ($1, $2, $3, $4, $5)',
                [state.data.name, state.data.description, state.data.price, state.data.stock, permLink]
            );

            delete adminStates[chatId]; // Сброс состояния
            
            bot.sendMessage(chatId, 
                `✅ Товар успешно добавлен!\n\n📌 Название: ${state.data.name}\n💰 Цена: ${state.data.price}₽\n📦 Сток: ${state.data.stock}\n🖼 Ссылка: ${permLink}`, 
                adminKeyboard
            );

        } catch (e) {
            console.error('General Photo Error:', e);
            bot.sendMessage(chatId, '❌ Критическая ошибка при обработке. Проверьте логи Railway.');
        }
    }
});

// --- API ---

app.get('/', (req, res) => res.send('Server Running'));

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
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/faq', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM faq ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Корзина
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

// Заказ (при создании статус active)
app.post('/api/order', async (req, res) => {
    try {
        const { userId, address, comment } = req.body;
        const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
        const user = userRes.rows[0];

        const cartRes = await pool.query(`
            SELECT c.quantity, c.product_id, p.name, p.price 
            FROM cart_items c JOIN products p ON c.product_id = p.id
            WHERE c.user_telegram_id = $1
        `, [userId]);

        if (cartRes.rows.length === 0) return res.status(400).json({ success: false, message: 'Empty cart' });

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

        // Создаем заказ со статусом 'active'
        const newOrder = await pool.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, address, comment, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [userId, JSON.stringify(items), totalPrice, address, comment, 'active']
        );
        const orderId = newOrder.rows[0].id;

        await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        // Уведомление с ID заказа
        const adminIds = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
        const adminMsg = orderText + `\n🆔 *ID Заказа:* ${orderId}\n\n👉 Чтобы подтвердить и списать остатки, напишите:\n/done ${orderId}`;
        
        for (const adminId of adminIds) {
            if (adminId) bot.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }).catch(e => console.error(e));
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server v3 running on port ${PORT}`);
});

