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

// Инициализация бота (Polling)
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Хранилище состояний для админов (кто на каком этапе добавления товара)
const adminStates = {}; 
// Этапы: 'WAITING_NAME', 'WAITING_PRICE', 'WAITING_DESC', 'WAITING_PHOTO'

// --- ФУНКЦИИ БАЗЫ ДАННЫХ ---
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Миграция для старых таблиц (на всякий случай)
        await pool.query(`
            DO $$ BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN 
                    ALTER TABLE users ADD COLUMN username VARCHAR(255); 
                END IF; 
            END $$;
        `);
        console.log('✅ БД готова.');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

// --- ЛОГИКА БОТА ---

// Проверка на админа
const isAdmin = (chatId) => {
    const admins = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
    return admins.includes(chatId.toString());
};

// Клавиатура админа
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            ['➕ Добавить т/в', '❌ Удалить т/в']
        ],
        resize_keyboard: true
    }
};

bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.chat.id)) {
        bot.sendMessage(msg.chat.id, 'Добро пожаловать, Админ! Выберите действие:', adminKeyboard);
    } else {
        bot.sendMessage(msg.chat.id, 'Привет! Открой Mini App для покупок.');
    }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;

    const text = msg.text;
    const state = adminStates[chatId];

    // 1. Команда: Добавить т/в
    if (text === '➕ Добавить т/в') {
        adminStates[chatId] = { step: 'WAITING_NAME', data: {} };
        return bot.sendMessage(chatId, 'Введите название товара:');
    }

    // 2. Команда: Удалить т/в
    if (text === '❌ Удалить т/в') {
        try {
            const res = await pool.query('SELECT id, name FROM products ORDER BY id ASC');
            if (res.rows.length === 0) return bot.sendMessage(chatId, 'Список товаров пуст.');
            
            let list = '📦 *Список товаров:*\n\n';
            res.rows.forEach(p => {
                list += `${p.id}. ${p.name}\n`;
            });
            list += '\n📝 Чтобы удалить, напишите: `/del ID` (например: `/del 5`)';
            return bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
        } catch (e) { return bot.sendMessage(chatId, 'Ошибка получения списка.'); }
    }

    // 3. Команда удаления (/del N)
    if (text && text.startsWith('/del ')) {
        const idToDelete = text.split(' ')[1];
        if (!idToDelete) return bot.sendMessage(chatId, 'Укажите ID.');
        try {
            await pool.query('DELETE FROM products WHERE id = $1', [idToDelete]);
            return bot.sendMessage(chatId, `✅ Товар с ID ${idToDelete} удален.`);
        } catch (e) { return bot.sendMessage(chatId, 'Ошибка удаления (возможно, неверный ID).'); }
    }

    // --- МАШИНА СОСТОЯНИЙ (Добавление товара) ---
    if (state) {
        if (state.step === 'WAITING_NAME') {
            state.data.name = text;
            state.step = 'WAITING_PRICE';
            return bot.sendMessage(chatId, 'Введите цену (только цифры):');
        }

        if (state.step === 'WAITING_PRICE') {
            const price = parseFloat(text);
            if (isNaN(price)) return bot.sendMessage(chatId, 'Пожалуйста, введите число.');
            state.data.price = price;
            state.step = 'WAITING_DESC';
            return bot.sendMessage(chatId, 'Введите описание товара:');
        }

        if (state.step === 'WAITING_DESC') {
            state.data.description = text;
            state.step = 'WAITING_PHOTO';
            return bot.sendMessage(chatId, 'Отправьте картинку товара (сжатую, не файлом):');
        }
    }
});

// Обработка фото (для добавления товара)
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const state = adminStates[chatId];

    if (state && state.step === 'WAITING_PHOTO') {
        bot.sendMessage(chatId, '⏳ Загружаю фото...');
        
        try {
            // Берем самое качественное фото
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;
            
            // Получаем ссылку на скачивание от Телеграма
            const fileLink = await bot.getFileLink(fileId);
            
            // Скачиваем фото
            const imageResponse = await axios({ url: fileLink, responseType: 'stream' });
            
            // Загружаем на Telegraph (хитрость для вечной ссылки)
            const form = new FormData();
            form.append('file', imageResponse.data, { filename: 'image.jpg' });
            
            const uploadRes = await axios.post('https://telegra.ph/upload', form, {
                headers: { ...form.getHeaders() }
            });

            const permLink = 'https://telegra.ph' + uploadRes.data[0].src;

            // Сохраняем в БД
            await pool.query(
                'INSERT INTO products (name, description, price, image_url) VALUES ($1, $2, $3, $4)',
                [state.data.name, state.data.description, state.data.price, permLink]
            );

            delete adminStates[chatId]; // Сброс состояния
            bot.sendMessage(chatId, `✅ Товар "${state.data.name}" успешно добавлен!\nКартинка: ${permLink}`, adminKeyboard);

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Ошибка загрузки фото. Попробуйте снова.');
        }
    }
});


// --- API ---

app.get('/', (req, res) => res.send('TripPuff Server & Bot Active 🚀'));

// Получить юзера
app.get('/api/user/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.id]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ message: 'User not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, phone, username } = req.body;
        const referralCode = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const result = await pool.query(
            'INSERT INTO users (telegram_id, name, phone, username, referral_code) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [userId, name, phone, username, referralCode]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: 'Ошибка регистрации' }); }
});

// Товары
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC'); // Сортировка по ID, чтобы соответствовало списку удаления
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// FAQ
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
        const query = `
            SELECT c.product_id, c.quantity, p.name, p.price, p.image_url 
            FROM cart_items c
            JOIN products p ON c.product_id = p.id
            WHERE c.user_telegram_id = $1
            ORDER BY p.name ASC
        `;
        const result = await pool.query(query, [userId]);
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

// Заказ
app.post('/api/order', async (req, res) => {
    try {
        const { userId, address, comment } = req.body;
        const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        const user = userRes.rows[0];
        const cartRes = await pool.query(`
            SELECT c.quantity, p.name, p.price 
            FROM cart_items c
            JOIN products p ON c.product_id = p.id
            WHERE c.user_telegram_id = $1
        `, [userId]);

        if (cartRes.rows.length === 0) return res.status(400).json({ success: false, message: 'Корзина пуста' });

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

        await pool.query('INSERT INTO orders (user_telegram_id, details, total_price, address, comment) VALUES ($1, $2, $3, $4, $5)', [userId, JSON.stringify(items), totalPrice, address, comment]);
        await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        // Рассылка админам
        const adminIds = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
        for (const adminId of adminIds) {
            if (adminId) {
                bot.sendMessage(adminId, orderText, { parse_mode: 'Markdown' }).catch(e => console.error(e));
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Order Error:', err);
        res.status(500).json({ success: false, message: 'Ошибка оформления' });
    }
});

app.listen(PORT, () => {
    console.log(`Server & Bot running on port ${PORT}`);
});
