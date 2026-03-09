const express = require('express');
const compression = require('compression');
const axios = require('axios');
const cheerio = require('cheerio');
const URL = require('url');

const app = express();

// Включаем GZIP-сжатие ответов (Google Apps Script это любит и понимает)
app.use(compression());

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send('Укажите URL: ?url=https://example.com');
    }

    try {
        // 1. Скачиваем исходный HTML
        const response = await axios.get(targetUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000 // Таймаут 10 секунд, чтобы не повесить Northflank
        });
        
        const html = response.data;
        const $ = cheerio.load(html);
        const baseUrl = new URL.URL(targetUrl).origin;

        // 2. Инлайним CSS (только базовые, чтобы не перегрузить память)
        const stylesheets = $('link[rel="stylesheet"]').toArray();
        for (let i = 0; i < Math.min(stylesheets.length, 5); i++) {
            const el = stylesheets[i];
            let href = $(el).attr('href');
            if (href) {
                if (href.startsWith('/')) href = baseUrl + href;
                try {
                    const cssRes = await axios.get(href, { timeout: 3000 });
                    $(el).replaceWith(`<style>${cssRes.data}</style>`);
                } catch (err) {
                    console.log(`Не удалось загрузить CSS: ${href}`);
                }
            }
        }

        // 3. Инлайним картинки в Base64 (ограничиваем количество, чтобы ответ не стал гигантским)
        const images = $('img').toArray();
        for (let i = 0; i < Math.min(images.length, 10); i++) {
            const el = images[i];
            let src = $(el).attr('src');
            if (src && !src.startsWith('data:')) {
                if (src.startsWith('/')) src = baseUrl + src;
                try {
                    const imgRes = await axios.get(src, { responseType: 'arraybuffer', timeout: 3000 });
                    const mimeType = imgRes.headers['content-type'];
                    const base64 = Buffer.from(imgRes.data, 'binary').toString('base64');
                    $(el).attr('src', `data:${mimeType};base64,${base64}`);
                    // Убираем srcset, так как он сломает отображение нашей base64 картинки
                    $(el).removeAttr('srcset'); 
                } catch (err) {
                    console.log(`Не удалось загрузить картинку: ${src}`);
                }
            }
        }

        // Отправляем собранный HTML (Express + compression сами сожмут его в GZIP)
        res.send($.html());

    } catch (error) {
        res.status(500).send(`Ошибка обработки: ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
              
