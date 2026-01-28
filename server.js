const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Проверки
if (!process.env.DATABASE_URL) console.error("❌ OШИБКА: Нет DATABASE_URL");
if (!process.env.ADMIN_CHAT_ID) console.error("⚠️ ПРЕДУПРЕЖДЕНИЕ: Нет ADMIN_CHAT_ID");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
    res.send('<h1>TripPuff Server v2 (Multi-Admin) 🚀</h1>');
});

// --- ИНИЦИАЛИЗАЦИЯ БД ---
const initDB = async () => {
    try {
        // Создаем таблицы, если их нет
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
                product_id INTEGER REFERENCES products(id),
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

        // 🔥 МИГРАЦИЯ: Добавляем колонку username старым пользователям, если её нет
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN 
                    ALTER TABLE users ADD COLUMN username VARCHAR(255); 
                END IF; 
            END $$;
        `);

        console.log('✅ База данных готова (Username support added).');

        // Тестовые товары (если база пустая)
        const productCheck = await pool.query('SELECT count(*) FROM products');
        if (parseInt(productCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO products (name, description, price, image_url) VALUES
                ('TripPuff Vape X', 'Мощный вейп с долгим зарядом', 1500.00, 'https://placehold.co/400x300/666/fff?text=Vape+X'),
                ('Жидкость Mint Breeze', 'Свежий мятный вкус, 30мл', 450.00, 'https://placehold.co/400x300/999/fff?text=Mint'),
                ('Сменный картридж', 'Подходит для серии X и Y', 300.00, 'https://placehold.co/400x300/333/fff?text=Cartridge');
            `);
        }
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
};

initDB();

// --- API: Пользователи ---

app.get('/api/user/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.id]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ message: 'User not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, phone, username } = req.body; // Получаем username
        const referralCode = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        
        // Вставляем с username
        const result = await pool.query(
            'INSERT INTO users (telegram_id, name, phone, username, referral_code) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [userId, name, phone, username, referralCode]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ success: false, message: 'Ошибка регистрации' }); 
    }
});

// --- API: Товары и FAQ ---
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

// --- API: Корзина ---
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

// --- API: ЗАКАЗЫ (Обновленная логика) ---

app.post('/api/order', async (req, res) => {
    try {
        const { userId, address, comment } = req.body;

        // 1. Получаем данные пользователя из БД (чтобы быть уверенным в имени и телефоне)
        const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        const user = userRes.rows[0];

        // 2. Получаем корзину
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

        // 3. Формируем ссылку на пользователя
        // Если есть username - используем @, иначе ссылка через ID
        const userLink = user.username ? `@${user.username}` : `[${user.name}](tg://user?id=${user.telegram_id})`;

        const orderText = `
📦 *НОВЫЙ ЗАКАЗ*

👤 *Клиент:* ${user.name}
🔗 *Ссылка:* ${userLink}
📞 *Телефон:* ${user.phone}

📍 *Адрес:* \`${address}\`
💬 *Комментарий:* ${comment ? comment : 'Нет'}

🛒 *Товары:*
${itemsListText}
💰 *ИТОГО: ${totalPrice}₽*
`;

        // 4. Сохраняем в историю заказов
        await pool.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, address, comment) VALUES ($1, $2, $3, $4, $5)',
            [userId, JSON.stringify(items), totalPrice, address, comment]
        );

        // 5. Очищаем корзину
        await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        // 6. Отправляем ВСЕМ админам
        if (process.env.BOT_TOKEN && process.env.ADMIN_CHAT_ID) {
            // Разбиваем строку ID по запятой на массив
            const adminIds = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
            const tgUrl = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;

            // Отправляем каждому админу
            for (const adminId of adminIds) {
                if (adminId) {
                    await fetch(tgUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: adminId,
                            text: orderText,
                            parse_mode: 'Markdown'
                        })
                    }).catch(err => console.error(`Failed to send to admin ${adminId}:`, err));
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Order Error:', err);
        res.status(500).json({ success: false, message: 'Ошибка оформления заказа' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
