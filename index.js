const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const cron = require('node-cron');

// Конфігурація
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // Твій Telegram ID

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// База даних
const db = new sqlite3.Database('support_bot.db');

// Ініціалізація таблиць
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        telegram_id INTEGER UNIQUE,
        name TEXT,
        stage TEXT DEFAULT 'знайомство',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP,
        mood_score INTEGER DEFAULT 5,
        settings TEXT DEFAULT '{}'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        message TEXT,
        mood_score INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_type TEXT DEFAULT 'user',
        tags TEXT,
        FOREIGN KEY(user_id) REFERENCES users(telegram_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        description TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(telegram_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS mood_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date DATE,
        morning_mood INTEGER,
        evening_mood INTEGER,
        notes TEXT,
        FOREIGN KEY(user_id) REFERENCES users(telegram_id)
    )`);
});

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
        // Команди
        bot.onText(/\/start/, (msg) => this.handleStart(msg));
        bot.onText(/\/mood/, (msg) => this.handleMoodCheck(msg));
        bot.onText(/\/sos/, (msg) => this.handleSOS(msg));
        bot.onText(/\/achievements/, (msg) => this.showAchievements(msg));
        bot.onText(/\/stats/, (msg) => this.showStats(msg));
        bot.onText(/\/settings/, (msg) => this.showSettings(msg));

        // Обробка всіх повідомлень
        bot.on('message', (msg) => {
            if (!msg.text.startsWith('/')) {
                this.handleMessage(msg);
            }
        });

        // Callback кнопки
        bot.on('callback_query', (query) => this.handleCallback(query));
    }

    async handleStart(msg) {
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'Друже';

        // Реєстрація користувача
        db.run(`INSERT OR REPLACE INTO users (telegram_id, name) VALUES (?, ?)`, 
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
/achievements - твої досягнення
/stats - статистика настрою
/settings - налаштування

Розкажи мені про себе - що зараз відбувається в твоєму житті?`;

        bot.sendMessage(userId, welcomeMessage);
    }

    async handleMessage(msg) {
        const userId = msg.from.id;
        const messageText = msg.text;
        
        // Аналіз настрою
        const moodScore = this.analyzeMood(messageText);
        
        // Збереження повідомлення
        db.run(`INSERT INTO messages (user_id, message, mood_score) VALUES (?, ?, ?)`,
            [userId, messageText, moodScore]);

        // Оновлення користувача
        db.run(`UPDATE users SET last_interaction = CURRENT_TIMESTAMP, mood_score = ? WHERE telegram_id = ?`,
            [moodScore, userId]);

        // Генерація відповіді
        const response = await this.generateResponse(userId, messageText, moodScore);
        bot.sendMessage(userId, response);

        // Перевірка на досягнення
        this.checkForAchievements(userId, messageText);
    }

    analyzeMood(text) {
        const lowerText = text.toLowerCase();
        let score = 5; // нейтральний

        // Позитивні маркери
        this.moodKeywords.positive.forEach(word => {
            if (lowerText.includes(word)) score += 1;
        });

        // Негативні маркери  
        this.moodKeywords.negative.forEach(word => {
            if (lowerText.includes(word)) score -= 1;
        });

        return Math.max(1, Math.min(10, score));
    }

    async generateResponse(userId, message, moodScore) {
        // Отримання контексту користувача
        const context = await this.getUserContext(userId);
        
        const prompt = `Ти емоційний помічник українською мовою. 

Контекст користувача: ${JSON.stringify(context)}
Поточний настрій (1-10): ${moodScore}
Останнє повідомлення: "${message}"

Відповідай тепло, підтримуюче, пам'ятай попередні розмови. Якщо настрій низький (1-4) - надавай більше підтримки. Якщо високий (8-10) - святкуй разом.

Відповідь має бути 2-3 речення, щира та персоналізована.`;

        try {
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
            return "Розумію, що зараз важко. Я тут і готовий підтримати тебе. Хочеш поговорити про це детальніше? 💙";
        } else if (moodScore >= 8) {
            return "Чудово чути такі позитивні новини! Продовжуй в тому ж дусі! 🌟";
        } else {
            return "Дякую за те, що поділився. Я завжди готовий вислухати і підтримати 🤗";
        }
    }

    async getUserContext(userId) {
        return new Promise((resolve) => {
            db.get(`SELECT * FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
                if (err) {
                    resolve({});
                    return;
                }

                db.all(`SELECT message, mood_score, timestamp FROM messages 
                        WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10`, 
                    [userId], (err, messages) => {
                    
                    resolve({
                        stage: user?.stage || 'знайомство',
                        lastMood: user?.mood_score || 5,
                        recentMessages: messages || []
                    });
                });
            });
        });
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

        const keyboard = {
            inline_keyboard: [
                [{ text: "Так, давай поговоримо", callback_data: "talk_sos" }],
                [{ text: "Покажи мої досягнення", callback_data: "show_achievements" }],
                [{ text: "Включи режим підтримки", callback_data: "support_mode" }]
            ]
        };

        bot.sendMessage(userId, sosMessage, { reply_markup: keyboard });
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

        if (data.startsWith('mood_')) {
            const mood = parseInt(data.split('_')[1]);
            db.run(`UPDATE users SET mood_score = ? WHERE telegram_id = ?`, [mood, userId]);
            
            let response = `Записав твій настрій: ${mood}/10`;
            if (mood <= 3) {
                response += "\n\nХочеш поговорити про те, що турбує? Я тут для тебе 💙";
            } else if (mood >= 8) {
                response += "\n\nВідмінно! Радію разом з тобою! 🎉";
            }
            
            bot.editMessageText(response, {
                chat_id: userId,
                message_id: query.message.message_id
            });
        }

        // Інші callback handlers...
        bot.answerCallbackQuery(query.id);
    }

    checkForAchievements(userId, message) {
        // Детекція досягнень
        const achievements = [];
        const lowerMessage = message.toLowerCase();

        if (lowerMessage.includes('закінчив') || lowerMessage.includes('завершив')) {
            achievements.push({ title: "Завершувач", description: "Довів справу до кінця!" });
        }
        
        if (lowerMessage.includes('навчився') || lowerMessage.includes('вивчив')) {
            achievements.push({ title: "Студент життя", description: "Освоїв щось нове!" });
        }

        achievements.forEach(achievement => {
            db.run(`INSERT INTO achievements (user_id, title, description) VALUES (?, ?, ?)`,
                [userId, achievement.title, achievement.description]);
            
            bot.sendMessage(userId, `🏆 Нове досягнення: "${achievement.title}"!\n${achievement.description}`);
        });
    }

    startCronJobs() {
        // Ранковий check-in (9:00)
        cron.schedule('0 9 * * *', () => {
            this.sendMorningCheckin();
        });

        // Вечірня рефлексія (21:00)
        cron.schedule('0 21 * * *', () => {
            this.sendEveningReflection();
        });

        // Тижневий аналіз (неділя 19:00)
        cron.schedule('0 19 * * 0', () => {
            this.sendWeeklyAnalysis();
        });
    }

    async sendMorningCheckin() {
        db.all(`SELECT telegram_id, name FROM users WHERE telegram_id = ?`, [ADMIN_USER_ID], (err, users) => {
            users.forEach(user => {
                const messages = [
                    `Доброго ранку! ☀️ Як плани на сьогодні?`,
                    `Привіт! 🌅 Що хорошого сподіваєшся сьогодні?`,
                    `Ранок! ☕ Як настрій на початок дня?`
                ];
                
                const randomMessage = messages[Math.floor(Math.random() * messages.length)];
                bot.sendMessage(user.telegram_id, randomMessage);
            });
        });
    }

    async sendEveningReflection() {
        db.all(`SELECT telegram_id, name FROM users WHERE telegram_id = ?`, [ADMIN_USER_ID], (err, users) => {
            users.forEach(user => {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "Поділитись днем", callback_data: "share_day" }],
                        [{ text: "Оцінити настрій", callback_data: "rate_mood" }]
                    ]
                };

                bot.sendMessage(user.telegram_id, 
                    "Як пройшов день? 🌙 Готовий підвести підсумки?", 
                    { reply_markup: keyboard });
            });
        });
    }
}

// Ініціалізація та запуск бота
async function startBot() {
    await initDatabase();
    const supportBot = new SupportBot();
    console.log('🤖 Support Bot запущено!');
}

startBot().catch(console.error);

// Обробка помилок
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

module.exports = { SupportBot, bot, pool };
