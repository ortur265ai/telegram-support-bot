const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { Pool } = require('pg');
const cron = require('node-cron');

// Конфігурація
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const DATABASE_URL = process.env.DATABASE_URL;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// База даних PostgreSQL
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Ініціалізація таблиць
async function initDatabase() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            telegram_id BIGINT UNIQUE,
            name TEXT,
            stage TEXT DEFAULT 'знайомство',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            mood_score INTEGER DEFAULT 5,
            settings JSONB DEFAULT '{}'
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            user_id BIGINT,
            message TEXT,
            mood_score INTEGER,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            message_type TEXT DEFAULT 'user',
            tags TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS achievements (
            id SERIAL PRIMARY KEY,
            user_id BIGINT,
            title TEXT,
            description TEXT,
            date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS mood_patterns (
            id SERIAL PRIMARY KEY,
            user_id BIGINT,
            date DATE,
            morning_mood INTEGER,
            evening_mood INTEGER,
            notes TEXT
        )`);

        console.log('🗄️ База даних ініціалізована');
    } catch (error) {
        console.error('Помилка ініціалізації БД:', error);
    }
}

class SupportBot {
    constructor() {
        this.moodKeywords = {
            positive: ['добре', 'чудово', 'супер', 'класно', 'щасливий', 'радісно', 'вдалося'],
            negative: ['погано', 'сумно', 'депресія', 'важко', 'болить', 'втомлений', 'стрес'],
            neutral: ['нормально', 'звичайно', 'так собі', 'середньо']
        };
        this.setupHandlers();
        this.startCronJobs();
    }

    setupHandlers() {
        bot.onText(/\/start/, (msg) => this.handleStart(msg));
        bot.onText(/\/mood/, (msg) => this.handleMoodCheck(msg));
        bot.onText(/\/sos/, (msg) => this.handleSOS(msg));

        bot.on('message', (msg) => {
            if (!msg.text.startsWith('/')) {
                this.handleMessage(msg);
            }
        });

        bot.on('callback_query', (query) => this.handleCallback(query));
    }

    async handleStart(msg) {
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'Друже';

        try {
            await pool.query(`INSERT INTO users (telegram_id, name) VALUES ($1, $2) 
                             ON CONFLICT (telegram_id) DO UPDATE SET name = $2`, 
                [userId, userName]);

            const welcomeMessage = `Привіт, ${userName}! 👋

Я твій персональний бот-помічник для емоційної підтримки. Я буду:

🔹 Щодня цікавитися як твої справи
🔹 Запам'ятовувати все наше спілкування  
🔹 Відстежувати твій настрій та прогрес
🔹 Надавати підтримку коли потрібно
🔹 Святкувати твої досягнення

Доступні команди:
/mood - перевірити настрій
/sos - екстрена підтримка

Розкажи мені про себе - що зараз відбувається в твоєму житті?`;

            bot.sendMessage(userId, welcomeMessage);
        } catch (error) {
            console.error('Помилка реєстрації користувача:', error);
            bot.sendMessage(userId, 'Вибач, сталася помилка. Спробуй ще раз.');
        }
    }

    async handleMessage(msg) {
        const userId = msg.from.id;
        const messageText = msg.text;
        
        try {
            const moodScore = this.analyzeMood(messageText);
            
            await pool.query(`INSERT INTO messages (user_id, message, mood_score) VALUES ($1, $2, $3)`,
                [userId, messageText, moodScore]);

            await pool.query(`UPDATE users SET last_interaction = CURRENT_TIMESTAMP, mood_score = $1 WHERE telegram_id = $2`,
                [moodScore, userId]);

            const response = await this.generateResponse(userId, messageText, moodScore);
            bot.sendMessage(userId, response);

        } catch (error) {
            console.error('Помилка обробки повідомлення:', error);
            bot.sendMessage(userId, 'Вибач, сталася помилка. Але я тут і готовий тебе вислухати! Спробуй ще раз.');
        }
    }

    analyzeMood(text) {
        const lowerText = text.toLowerCase();
        let score = 5;

        this.moodKeywords.positive.forEach(word => {
            if (lowerText.includes(word)) score += 1;
        });

        this.moodKeywords.negative.forEach(word => {
            if (lowerText.includes(word)) score -= 1;
        });

        return Math.max(1, Math.min(10, score));
    }

    async generateResponse(userId, message, moodScore) {
        try {
            const prompt = `Ти емоційний помічник українською мовою. 
Настрій користувача (1-10): ${moodScore}
Повідомлення: "${message}"

Відповідай тепло, підтримуюче. Якщо настрій низький (1-4) - надавай більше підтримки. 
Відповідь має бути 2-3 речення.`;

            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 200,
                temperature: 0.7
            });

            return completion.choices[0].message.content;
        } catch (error) {
            console.error('OpenAI Error:', error);
            return this.getFallbackResponse(moodScore);
        }
    }

    getFallbackResponse(moodScore) {
        if (moodScore <= 3) {
            return "Розумію, що зараз важко. Я тут і готовий підтримати тебе. Хочеш поговорити про це детальніше?";
        } else if (moodScore >= 8) {
            return "Чудово чути такі позитивні новини! Продовжуй в тому ж дусі!";
        } else {
            return "Дякую за те, що поділився. Я завжди готовий вислухати і підтримати";
        }
    }

    async handleSOS(msg) {
        const userId = msg.from.id;
        
        const sosMessage = `🆘 Розумію, що зараз дуже важко. Ти не один.

Техніки швидкої допомоги:

🫁 **Дихання 4-7-8**
Вдихни на 4, затримай на 7, видихни на 8

🧊 **5-4-3-2-1 техніка**
5 речей які бачиш
4 речі які чуєш  
3 речі які відчуваєш
2 речі які нюхаєш
1 річ яку куштуєш

💙 **Пам'ятай**: ці почуття тимчасові, ти справляєшся краще ніж думаєш.

Хочеш поговорити про те, що зараз відбувається?`;

        bot.sendMessage(userId, sosMessage);
    }

    async handleMoodCheck(msg) {
        const userId = msg.from.id;
        
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "😭 1", callback_data: "mood_1" },
                    { text: "😢 2", callback_data: "mood_2" },
                    { text: "😔 3", callback_data: "mood_3" }
                ],
                [
                    { text: "😐 4", callback_data: "mood_4" },
                    { text: "🙂 5", callback_data: "mood_5" },
                    { text: "😊 6", callback_data: "mood_6" }
                ],
                [
                    { text: "😄 7", callback_data: "mood_7" },
                    { text: "😁 8", callback_data: "mood_8" },
                    { text: "🤩 9", callback_data: "mood_9" },
                    { text: "🚀 10", callback_data: "mood_10" }
                ]
            ]
        };

        bot.sendMessage(userId, "Як твій настрій зараз? (1-10)", { reply_markup: keyboard });
    }

    async handleCallback(query) {
        const userId = query.from.id;
        const data = query.data;

        try {
            if (data.startsWith('mood_')) {
                const mood = parseInt(data.split('_')[1]);
                await pool.query(`UPDATE users SET mood_score = $1 WHERE telegram_id = $2`, [mood, userId]);
                
                let response = `Записав твій настрій: ${mood}/10`;
                if (mood <= 3) {
                    response += "\n\nХочеш поговорити про те, що турбує? Я тут для тебе";
                } else if (mood >= 8) {
                    response += "\n\nВідмінно! Радію разом з тобою!";
                }
                
                bot.editMessageText(response, {
                    chat_id: userId,
                    message_id: query.message.message_id
                });
            }

            bot.answerCallbackQuery(query.id);
        } catch (error) {
            console.error('Помилка callback:', error);
            bot.answerCallbackQuery(query.id, { text: 'Сталася помилка, спробуй ще раз' });
        }
    }

    startCronJobs() {
        cron.schedule('0 9 * * *', () => {
            this.sendMorningCheckin();
        });

        cron.schedule('0 21 * * *', () => {
            this.sendEveningReflection();
        });
    }

    async sendMorningCheckin() {
        try {
            const result = await pool.query(`SELECT telegram_id, name FROM users WHERE telegram_id = $1`, [ADMIN_USER_ID]);
            
            result.rows.forEach(user => {
                const messages = [
                    `Доброго ранку! ☀️ Як плани на сьогодні?`,
                    `Привіт! 🌅 Що хорошого сподіваєшся сьогодні?`,
                    `Ранок! ☕ Як настрій на початок дня?`
                ];
                
                const randomMessage = messages[Math.floor(Math.random() * messages.length)];
                bot.sendMessage(user.telegram_id, randomMessage);
            });
        } catch (error) {
            console.error('Помилка ранкового повідомлення:', error);
        }
    }

    async sendEveningReflection() {
        try {
            const result = await pool.query(`SELECT telegram_id, name FROM users WHERE telegram_id = $1`, [ADMIN_USER_ID]);
            
            result.rows.forEach(user => {
                bot.sendMessage(user.telegram_id, "Як пройшов день? 🌙 Готовий підвести підсумки?");
            });
        } catch (error) {
            console.error('Помилка вечірнього повідомлення:', error);
        }
    }
}

// Ініціалізація та запуск бота
async function startBot() {
    await initDatabase();
    const supportBot = new SupportBot();
    console.log('🤖 Support Bot запущено!');
}

startBot().catch(console.error);

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
