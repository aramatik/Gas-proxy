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

    console.log(`\n[${new Date().toISOString()}] [START] Получен запрос на URL: ${targetUrl}`);

    try {
        console.log(`[INFO] Стучимся на целевой сайт...`);
        
        const response = await axios.get(targetUrl, { 
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000,
            validateStatus: () => true 
        });
        
        console.log(`[INFO] Сайт ответил. Статус код: ${response.status}`);

        // --- НОВЫЙ БЛОК: ПЕРЕХВАТ ОШИБОК ЗАЩИТЫ ---
        if ([401, 403, 406, 429, 503].includes(response.status)) {
            console.log(`[WARN] Сработала защита (код ${response.status}). Отправляем визуальную заглушку.`);
            
            const host = new URL.URL(targetUrl).hostname;
            const errorHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="background-color: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 80vh; margin: 0; padding: 20px; box-sizing: border-box;">
                <div style="font-family: sans-serif; text-align: center; padding: 30px; background: white; border-top: 5px solid #dc3545; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); max-width: 400px; width: 100%;">
                    <h2 style="color: #dc3545; margin-top: 0;">🚫 Доступ заблокирован</h2>
                    <p style="font-size: 15px;">Сайт <b>${host}</b> отклонил автоматический запрос от прокси-сервера.</p>
                    <div style="background: #f8f9fa; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 16px; margin: 15px 0;">
                        HTTP Код: <b>${response.status}</b>
                    </div>
                    <p style="font-size: 13px; color: #666; line-height: 1.5;">Сработала защита от ботов (Cloudflare, Qrator и т.д.), которая требует прохождения JS-проверки в реальном браузере. Проксировать такие сайты напрямую невозможно.</p>
                </div>
            </body>
            </html>
            `;
            
            // Возвращаем HTML с кодом 200, чтобы наш Google Apps Script спокойно его принял и обернул в тулбар
            return res.status(200).send(errorHtml);
        }
        // ------------------------------------------

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
            console.log(`[SUCCESS] Упаковка завершена. Отправляем в GAS ${finalHtml.length} байт.`);
            res.send(finalHtml);
        } 
        else {
            console.log(`[SUCCESS] Бинарный файл (${contentType}) отправлен в GAS как есть.`);
            res.send(response.data);
        }

    } catch (error) {
        console.error(`[ERROR] Фатальная ошибка при обработке ${targetUrl}:`, error.message);
        res.status(500).send(`Ошибка шлюза (Northflank): ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
    
