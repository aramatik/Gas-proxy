const express = require('express');
const compression = require('compression');
const axios = require('axios');
const cheerio = require('cheerio');
const URL = require('url');

const app = express();
app.use(compression());

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('Укажите URL: ?url=https://example.com');
    }

    // --- 1. ЛОГ: НАЧАЛО ЗАПРОСА ---
    console.log(`\n[${new Date().toISOString()}] [START] Получен запрос на URL: ${targetUrl}`);

    try {
        console.log(`[INFO] Стучимся на целевой сайт...`);
        
        // Скачиваем данные. Добавили мощные заголовки, чтобы не казаться ботом!
        const response = await axios.get(targetUrl, { 
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000,
            validateStatus: () => true // Читаем ответ при любых статус-кодах
        });
        
        // --- 2. ЛОГ: СТАТУС ОТВЕТА ---
        console.log(`[INFO] Сайт ответил. Статус код: ${response.status}`);
        if (response.status === 403 || response.status === 503) {
            console.log(`[WARN] Внимание: Сайт вернул ${response.status}. Возможно, сработала защита от ботов (Cloudflare/Qrator)!`);
        }

        const contentType = response.headers['content-type'] || '';
        console.log(`[INFO] Тип контента: ${contentType}, Размер: ${response.data.length} байт`);
        
        res.set('Content-Type', contentType);
        if (response.headers['content-disposition']) {
            res.set('Content-Disposition', response.headers['content-disposition']);
        }

        if (contentType.includes('text/html')) {
            console.log(`[INFO] HTML распознан. Начинаем парсинг и внедрение ресурсов...`);
            
            const html = response.data.toString('utf-8');
            const $ = cheerio.load(html);
            const baseUrl = new URL.URL(targetUrl).origin;

            // Инлайним CSS
            let cssCount = 0;
            const stylesheets = $('link[rel="stylesheet"]').toArray();
            for (let i = 0; i < Math.min(stylesheets.length, 5); i++) {
                const el = stylesheets[i];
                let href = $(el).attr('href');
                if (href) {
                    if (href.startsWith('/')) href = baseUrl + href;
                    try {
                        const cssRes = await axios.get(href, { timeout: 3000, headers: {'User-Agent': 'Mozilla/5.0'} });
                        $(el).replaceWith(`<style>${cssRes.data}</style>`);
                        cssCount++;
                    } catch (err) {
                        console.log(`[WARN] Не удалось скачать CSS: ${href} | Ошибка: ${err.message}`);
                    }
                }
            }
            console.log(`[INFO] Успешно вшито CSS файлов: ${cssCount}`);

            // Инлайним картинки
            let imgCount = 0;
            const images = $('img').toArray();
            for (let i = 0; i < Math.min(images.length, 10); i++) {
                const el = images[i];
                let src = $(el).attr('src');
                if (src && !src.startsWith('data:')) {
                    if (src.startsWith('/')) src = baseUrl + src;
                    try {
                        const imgRes = await axios.get(src, { responseType: 'arraybuffer', timeout: 3000, headers: {'User-Agent': 'Mozilla/5.0'} });
                        const mimeType = imgRes.headers['content-type'];
                        const base64 = Buffer.from(imgRes.data, 'binary').toString('base64');
                        $(el).attr('src', `data:${mimeType};base64,${base64}`);
                        $(el).removeAttr('srcset'); 
                        imgCount++;
                    } catch (err) {
                        console.log(`[WARN] Не удалось скачать картинку: ${src} | Ошибка: ${err.message}`);
                    }
                }
            }
            console.log(`[INFO] Успешно вшито картинок: ${imgCount}`);

            const finalHtml = $.html();
            // --- 3. ЛОГ: ОТПРАВКА ---
            console.log(`[SUCCESS] Упаковка завершена. Отправляем в GAS ${finalHtml.length} байт.`);
            res.send(finalHtml);
        } 
        else {
            console.log(`[SUCCESS] Бинарный файл (${contentType}) отправлен в GAS как есть.`);
            res.send(response.data);
        }

    } catch (error) {
        // --- 4. ЛОГ: КРИТИЧЕСКАЯ ОШИБКА ---
        console.error(`[ERROR] Фатальная ошибка при обработке ${targetUrl}:`, error.message);
        res.status(500).send(`Ошибка шлюза (Northflank): ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
