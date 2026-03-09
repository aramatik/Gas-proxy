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

    try {
        // Скачиваем данные как arraybuffer, чтобы не повредить бинарные файлы (.zip, .apk)
        const response = await axios.get(targetUrl, { 
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 15000,
            validateStatus: () => true // Пропускаем любые статусы (404, 500)
        });
        
        const contentType = response.headers['content-type'] || '';
        
        // Передаем заголовки типа контента обратно в GAS
        res.set('Content-Type', contentType);
        if (response.headers['content-disposition']) {
            res.set('Content-Disposition', response.headers['content-disposition']);
        }

        // Если это веб-страница, парсим её и вшиваем ресурсы
        if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const $ = cheerio.load(html);
            const baseUrl = new URL.URL(targetUrl).origin;

            // Инлайним CSS
            const stylesheets = $('link[rel="stylesheet"]').toArray();
            for (let i = 0; i < Math.min(stylesheets.length, 5); i++) {
                const el = stylesheets[i];
                let href = $(el).attr('href');
                if (href) {
                    if (href.startsWith('/')) href = baseUrl + href;
                    try {
                        const cssRes = await axios.get(href, { timeout: 3000 });
                        $(el).replaceWith(`<style>${cssRes.data}</style>`);
                    } catch (err) {}
                }
            }

            // Инлайним картинки
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
                        $(el).removeAttr('srcset'); 
                    } catch (err) {}
                }
            }

            // Отдаем собранный HTML
            res.send($.html());
        } 
        // Если это файл (zip, apk, pdf и т.д.), просто отдаем бинарный поток!
        // GAS получит его, увидит заголовки и вызовет ваше окно загрузки Base64
        else {
            res.send(response.data);
        }

    } catch (error) {
        res.status(500).send(`Ошибка шлюза: ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
