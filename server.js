const express = require('express');
const compression = require('compression');
const axios = require('axios');
const cheerio = require('cheerio');
const URL = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(compression());

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 МБ
const CHUNK_SIZE = 34 * 1024 * 1024;    // 34 МБ
const TMP_DIR = '/tmp';

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Укажите URL: ?url=https://example.com');

    console.log(`\n[${new Date().toISOString()}] [START] Запрос URL: ${targetUrl}`);
    const parsedTarget = new URL.URL(targetUrl);

    // --- БЛОК 1: ОТДАЧА ГОТОВЫХ ЧАСТЕЙ (CHUNKS) ---
    const partId = parsedTarget.searchParams.get('nf_partId');
    const partIndex = parseInt(parsedTarget.searchParams.get('nf_partIndex'));
    const nfFileName = parsedTarget.searchParams.get('nf_filename') || 'download.bin';

    if (partId) {
        const filePath = path.join(TMP_DIR, `${partId}.bin`);
        if (!fs.existsSync(filePath)) {
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.status(404).send("<meta charset='utf-8'><h3>⏳ Ошибка: Кэш файла истек.</h3><p>Начните скачивание заново.</p>");
        }
        
        const stats = fs.statSync(filePath);
        const startBytes = partIndex * CHUNK_SIZE;
        const endBytes = Math.min(startBytes + CHUNK_SIZE - 1, stats.size - 1);
        
        console.log(`[CHUNK] Отдаем часть ${partIndex + 1} для ${partId}. Байты: ${startBytes}-${endBytes}`);
        
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${nfFileName}.part${partIndex + 1}"`);
        res.set('Content-Length', endBytes - startBytes + 1);
        
        return fs.createReadStream(filePath, { start: startBytes, end: endBytes }).pipe(res);
    }

    // --- БЛОК 2: ОБРАБОТКА НОВОГО ЗАПРОСА ---
    try {
        console.log(`[INFO] Стучимся на целевой сайт...`);
        const response = await axios.get(targetUrl, { 
            responseType: 'stream',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000,
            validateStatus: () => true 
        });
        
        // Перехват защиты
        if ([401, 403, 406, 429, 503].includes(response.status)) {
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.status(200).send(`
            <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="background:#f0f2f5; display:flex; justify-content:center; align-items:center; min-height:80vh; margin:0; padding:20px; font-family:sans-serif;">
                <div style="background:white; padding:30px; border-top:5px solid #dc3545; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1); text-align:center;">
                    <h2 style="color:#dc3545; margin-top:0;">🚫 Доступ заблокирован</h2>
                    <p>Сайт <b>${parsedTarget.hostname}</b> отклонил автоматический запрос (Код: ${response.status}).</p>
                    <p style="font-size:13px; color:#666;">Сработала защита от ботов, требующая реального браузера.</p>
                </div>
            </body></html>`);
        }

        const contentType = response.headers['content-type'] || '';
        
        // --- ВЕТВЬ А: ЭТО ВЕБ-СТРАНИЦА (HTML) ---
        if (contentType.includes('text/html')) {
            console.log(`[INFO] Читаем HTML в память...`);
            let chunks = [];
            let htmlBytes = 0;
            
            for await (const chunk of response.data) {
                chunks.push(chunk);
                htmlBytes += chunk.length;
                if (htmlBytes > 20 * 1024 * 1024) {
                    response.data.destroy();
                    return res.status(400).send("Страница слишком тяжелая для обработки.");
                }
            }
            
            const html = Buffer.concat(chunks).toString('utf-8');
            const $ = cheerio.load(html);
            const baseUrl = parsedTarget.origin;

            const stylesheets = $('link[rel="stylesheet"]').toArray();
            for (let i = 0; i < Math.min(stylesheets.length, 5); i++) {
                let href = $(stylesheets[i]).attr('href');
                if (href) {
                    if (href.startsWith('/')) href = baseUrl + href;
                    try {
                        const cssRes = await axios.get(href, { timeout: 3000, headers: {'User-Agent': 'Mozilla/5.0'} });
                        $(stylesheets[i]).replaceWith(`<style>${cssRes.data}</style>`);
                    } catch (e) {}
                }
            }

            const images = $('img').toArray();
            for (let i = 0; i < Math.min(images.length, 10); i++) {
                let src = $(images[i]).attr('src');
                if (src && !src.startsWith('data:')) {
                    if (src.startsWith('/')) src = baseUrl + src;
                    try {
                        const imgRes = await axios.get(src, { responseType: 'arraybuffer', timeout: 3000, headers: {'User-Agent': 'Mozilla/5.0'} });
                        const mimeType = imgRes.headers['content-type'];
                        const base64 = Buffer.from(imgRes.data, 'binary').toString('base64');
                        $(images[i]).attr('src', `data:${mimeType};base64,${base64}`);
                        $(images[i]).removeAttr('srcset'); 
                    } catch (e) {}
                }
            }

            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.send($.html());
        } 
        
        // --- ВЕТВЬ Б: ЭТО БИНАРНЫЙ ФАЙЛ (СКАЧИВАНИЕ НА ДИСК) ---
        else {
            console.log(`[INFO] Обнаружен файл (${contentType}). Стримим на жесткий диск...`);
            const fileId = crypto.randomUUID();
            const filePath = path.join(TMP_DIR, `${fileId}.bin`);
            const writer = fs.createWriteStream(filePath);
            
            let downloadedBytes = 0;
            let isTooLarge = false;

            await new Promise((resolve, reject) => {
                response.data.pipe(writer);
                response.data.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes > MAX_FILE_SIZE && !isTooLarge) {
                        isTooLarge = true;
                        response.data.destroy(); 
                        writer.close();
                        fs.unlink(filePath, () => {}); 
                        reject(new Error("FILE_TOO_LARGE"));
                    }
                });
                writer.on('finish', resolve);
                writer.on('error', reject);
            }).catch(err => { if (err.message !== "FILE_TOO_LARGE") throw err; });

            if (isTooLarge) {
                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`
                <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
                <body style="background:#f0f2f5; display:flex; justify-content:center; align-items:center; min-height:80vh; margin:0; font-family:sans-serif;">
                    <div style="background:white; padding:30px; border-top:5px solid #ff9800; border-radius:10px; text-align:center;">
                        <h2>🐘 Файл слишком большой</h2>
                        <p>Установлен жесткий лимит на скачивание: <b>100 МБ</b>.</p>
                    </div>
                </body></html>`);
            }

            let fileName = 'download.bin';
            const cd = response.headers['content-disposition'];
            if (cd && cd.includes('filename=')) {
                fileName = cd.split('filename=')[1].replace(/["']/g, '');
            } else {
                fileName = path.basename(parsedTarget.pathname) || 'download.bin';
            }

            if (downloadedBytes <= CHUNK_SIZE) {
                res.set('Content-Type', contentType);
                res.set('Content-Disposition', `attachment; filename="${fileName}"`);
                return fs.createReadStream(filePath).pipe(res);
            } 
            else {
                const partsCount = Math.ceil(downloadedBytes / CHUNK_SIZE);
                let buttonsHtml = '';
                
                for(let i = 0; i < partsCount; i++) {
                    parsedTarget.searchParams.set('nf_partId', fileId);
                    parsedTarget.searchParams.set('nf_partIndex', i);
                    parsedTarget.searchParams.set('nf_filename', fileName);
                    
                    const partSize = (i === partsCount - 1) ? (downloadedBytes - (i * CHUNK_SIZE)) : CHUNK_SIZE;
                    buttonsHtml += `
                        <a href="${parsedTarget.toString()}" style="display:block; margin-bottom:10px; padding:12px; background:#1a73e8; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">
                            📥 Скачать часть ${i + 1} <span style="font-weight:normal; font-size:12px; opacity:0.8;">(${(partSize/1024/1024).toFixed(1)} МБ)</span>
                        </a>`;
                }

                // Указываем кодировку UTF-8 чтобы русский текст отображался правильно
                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`
                <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
                <body style="background:#f0f2f5; display:flex; justify-content:center; align-items:flex-start; min-height:100vh; margin:0; padding:20px; font-family:sans-serif; box-sizing:border-box;">
                    <div style="background:white; padding:25px; border-top:5px solid #1a73e8; border-radius:10px; text-align:center; width:100%; max-width:400px; box-shadow:0 4px 10px rgba(0,0,0,0.1); margin-top:20px;">
                        <h2 style="margin-top:0;">📦 Объемный архив</h2>
                        <p style="font-size:14px; color:#333;">Файл <b>${fileName}</b> весит ${(downloadedBytes/1024/1024).toFixed(1)} МБ. Лимиты Google не позволяют передать его целиком.</p>
                        <p style="font-size:12px; color:#666; margin-bottom:20px;">Мы разделили его на ${partsCount} части. Скачайте их по очереди, а затем распакуйте архиватором (7-Zip, WinRAR).</p>
                        ${buttonsHtml}
                    </div>
                </body></html>`);
            }
        }

    } catch (error) {
        console.error(`[ERROR] Фатальная ошибка:`, error.message);
        res.status(500).send(`Ошибка шлюза (Northflank): ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
                 
