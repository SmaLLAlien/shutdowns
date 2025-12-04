// npm install node-fetch jsdom
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import axios from 'axios';

// Проверки окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL;

if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN is not set in .env');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

async function fetchShutdowns() {
    const resp = await fetch(API_URL, { redirect: 'follow' });
    if (!resp.ok) {
        throw new Error(`HTTP error: ${resp.status}`);
    }
    const html = await resp.text();

    const dom = new JSDOM(html);
    const scripts = [...dom.window.document.querySelectorAll('script')];

    for (const script of scripts) {
        const txt = script.textContent;

        if (txt && txt.includes('DisconSchedule.fact')) {
            // Ищем присвоение
            const regex = /DisconSchedule\.fact\s*=\s*(\{[\s\S]*?\})(?=\s*DisconSchedule\.|\s*$)/;
            const m = txt.match(regex);
            if (m) {
                let objStr = m[1];

                // Попробуем превратить в чистый JSON-like, если это возможно
                // 1) заменяем одинарные кавычки → двойные
                objStr = objStr.replace(/'/g, '"');
                // 2) (опционально) оборачиваем ключи в кавычки, если они не в кавычках
                objStr = objStr.replace(/(\b[a-zA-Z0-9_]+)\s*:/g, '"$1":');

                try {

                    const data = JSON.parse(objStr);
                    return data;
                } catch (e) {
                    // Если JSON.parse не сработал — fallback на eval
                    // (не идеально с точки зрения безопасности, но если доверяете сайту — допустимо)
                    // Используем Function для изоляции
                    const data = Function('"use strict"; return (' + m[1] + ');')();
                    return data;
                }
            }
        }
    }

    console.log('Не удалось найти DisconSchedule.fact на странице');
}

function filterGPVKeys(obj, keysToKeep) {
    const result = {};

    // Проходим по всем датам
    for (const dateKey in obj) {
        if (obj.hasOwnProperty(dateKey)) {
            result[dateKey] = {};

            // Проходим по всем GPV ключам в текущей дате
            for (const gpvKey in obj[dateKey]) {
                // Если ключ входит в список тех, что нужно оставить
                if (keysToKeep.includes(gpvKey)) {
                    result[dateKey][gpvKey] = obj[dateKey][gpvKey];
                }
            }
        }
    }

    return result;
}

function parseLightSchedule(data) {
    const results = [];

    // Проходим по всем датам
    for (const [timestamp, schedules] of Object.entries(data)) {
        const date = new Date(parseInt(timestamp) * 1000);
        const formattedDate = date.toLocaleDateString('ru-RU');

        // Проходим по всем графикам для этой даты
        for (const [scheduleName, timeSlots] of Object.entries(schedules)) {
            const noLightPeriods = [];
            let currentPeriod = null;

            // Проходим по всем часам (1-24)
            for (let hour = 1; hour <= 24; hour++) {
                const status = timeSlots[hour.toString()];

                if (status === 'no') {
                    // Если это начало нового периода отсутствия света
                    if (currentPeriod === null) {
                        currentPeriod = {
                            start: hour - 1, // На 1 час меньше, так как час 9 означает 8-9
                            end: hour
                        };
                    } else {
                        // Продолжаем существующий период
                        currentPeriod.end = hour;
                    }
                } else {
                    // Если был активный период, сохраняем его
                    if (currentPeriod !== null) {
                        noLightPeriods.push(currentPeriod);
                        currentPeriod = null;
                    }
                }
            }

            // Если период дошел до конца, сохраняем его
            if (currentPeriod !== null) {
                noLightPeriods.push(currentPeriod);
            }

            // Формируем текст только если есть периоды без света
            if (noLightPeriods.length > 0) {
                const periodTexts = noLightPeriods.map(period => {
                    // Для периода из одного часа
                    if (period.end - period.start === 1) {
                        return `${period.start} - ${period.end}`;
                    }
                    // Для периода из нескольких часов
                    return `${period.start} - ${period.end}`;
                });

                results.push(`Дата ${formattedDate}, график ${scheduleName.replace('GPV', '')}, света не будет в такие промежутки: ${periodTexts.join(', ')}`);
            }
        }
    }

    return results.join('\n');
}

// Обработчик /start
bot.start(async (ctx) => {
    const user = ctx.from;
    console.log(`/start from ${user.username || user.id}`);

    // Сообщаем пользователю, что работаем
    await ctx.reply(`Привет, ${user.first_name || 'пользователь'}! Запрашиваю данные...`);

    try {
        // Можно передать параметры запроса: пример — user id
        const params = { userId: user.id };

        const data = await fetchShutdowns(params);

        // --- Пример логики: ---
        // допустим API возвращает { status: 'ok', payload: {...} }
        if (!data?.data) {
            await ctx.reply('Пустой ответ от API.');
            return;
        }

        if (data.status && data.status !== 'ok') {
            await ctx.reply(`API вернул статус: ${data.status}`);
            return;
        }

        // Формируем ответ пользователю — адаптируйте под свой payload
        // Пример: если data.payload.items — массив
        console.log(data.data);
        const filteredData = filterGPVKeys(data.data, ['GPV5.1', 'GPV3.2']);
        let text = parseLightSchedule(filteredData);


        // Если текст слишком длинный — можно отправлять частями
        const MAX_MSG_LEN = 4000;
        if (text.length <= MAX_MSG_LEN) {
            await ctx.reply(text);
        } else {
            // разбить на части
            for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
                await ctx.reply(text.slice(i, i + MAX_MSG_LEN));
            }
        }

    } catch (err) {
        console.error('Error in /start handler:', err?.message || err);
        // подробности в логи, пользователю — дружелюбно
        await ctx.reply('Упс — не удалось получить данные. Попробуйте позже.');
    }
});

// Простые команды
bot.help((ctx) => ctx.reply('Отправь /start чтобы получить данные.'));

bot.on('message', (ctx) => {
    // По умолчанию — эхо или подсказка
    ctx.reply('Используйте /start или /help.');
});

// Запуск polling
(async () => {
    try {
        await bot.launch();
        console.log('Bot started (polling).');
    } catch (err) {
        console.error('Bot launch failed:', err);
        process.exit(1);
    }
})();

// graceful stop (Ctrl+C)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// (async () => {
//     try {
//
//
//         const shutdowns = await fetchShutdowns();
//         console.log('Parsed shutdown data:', shutdowns);
//     } catch (err) {
//         console.error('Error:', err);
//     }
// })();