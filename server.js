const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Настройка CORS (разрешаем запросы с GitHub Pages и локалхоста)
app.use(cors());
app.use(express.json());

// Подключение к базе данных Railway
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Нужно для Railway
    }
});

// --- Инициализация Базы Данных (Создание таблиц) ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                name VARCHAR(255),
                phone VARCHAR(50),
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
        `);
        console.log('Таблицы проверены/созданы.');

        // Проверка и добавление тестовых товаров, если таблица пуста
        const productCheck = await pool.query('SELECT count(*) FROM products');
        if (parseInt(productCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO products (name, description, price, image_url) VALUES
                ('TripPuff Vape X', 'Мощный вейп с долгим зарядом', 1500.00, 'https://placehold.co/400x300/666/fff?text=Vape+X'),
                ('Жидкость Mint Breeze', 'Свежий мятный вкус, 30мл', 450.00, 'https://placehold.co/400x300/999/fff?text=Mint'),
                ('Сменный картридж', 'Подходит для серии X и Y', 300.00, 'https://placehold.co/400x300/333/fff?text=Cartridge');
            `);
            console.log('Тестовые товары добавлены.');
        }

        // Проверка и добавление FAQ
        const faqCheck = await pool.query('SELECT count(*) FROM faq');
        if (parseInt(faqCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO faq (question, answer) VALUES
                ('Как накопить баллы?', 'Показывайте QR-код из приложения при каждой покупке.'),
                ('Где находится магазин?', 'Мы находимся в центре города, ТЦ Плаза, 2 этаж.'),
                ('Как потратить баллы?', 'Баллами можно оплатить до 30% стоимости покупки.');
            `);
            console.log('FAQ добавлены.');
        }

    } catch (err) {
        console.error('Ошибка инициализации БД:', err);
    }
};

// Запускаем инициализацию при старте
initDB();

// --- API Endpoints ---

// 1. Получение пользователя по Telegram ID
app.get('/api/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [id]);
        
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. Регистрация пользователя
app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, phone } = req.body;

        // Генерация простого реферального кода
        const referralCode = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();

        const result = await pool.query(
            'INSERT INTO users (telegram_id, name, phone, referral_code) VALUES ($1, $2, $3, $4) RETURNING *',
            [userId, name, phone, referralCode]
        );

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') { // Ошибка уникальности (пользователь уже есть)
            res.json({ success: false, message: 'Пользователь уже существует' });
        } else {
            res.status(500).json({ success: false, message: 'Ошибка сервера' });
        }
    }
});

// 3. Получение списка товаров
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. Получение FAQ
app.get('/api/faq', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM faq ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});