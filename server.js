const express = require('express');
const compression = require('compression');
const axios = require('axios');
const cheerio = require('cheerio');
const URL = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { exec } = require('child_process');
const execPromise = util.promisify(exec);

const app = express();
app.use(compression());

// Лимиты: максимум 130 МБ на скачивание, части по 15 МБ для стабильности GAS
const MAX_FILE_SIZE = 130 * 1024 * 1024;
const CHUNK_SIZE_MB = 15; 
const TMP_DIR = '/tmp';

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Укажите URL: ?url=https://example.com');

    console.log(`\n[${new Date().toISOString()}] [START] Запрос URL: ${targetUrl}`);
    const parsedTarget = new URL.URL(targetUrl);

    // --- БЛОК 1: ОТДАЧА ГОТОВЫХ ЧАСТЕЙ АРХИВА ---
    const nfFileId = parsedTarget.searchParams.get('nf_fileId');
    const nfPartName = parsedTarget.searchParams.get('nf_partName');

    if (nfFileId && nfPartName) {
        if (nfPartName.includes('/') || nfPartName.includes('\\') || nfFileId.includes('/')) {
            return res.status(400).send("Недопустимый путь к файлу.");
        }

        const partPath = path.join(TMP_DIR, nfFileId, nfPartName);
        if (!fs.existsSync(partPath)) {
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.status(404).send("<meta charset='utf-8'><h3>⏳ Ошибка: Кэш истек.</h3><p>Файл был удален с серверов Northflank для экономии места. Начните скачивание заново.</p>");
        }
        
        const stats = fs.statSync(partPath);
        console.log(`[CHUNK] Отдаем часть архива ${nfPartName} (${stats.size} байт)`);
        
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${nfPartName}"`);
        res.set('Content-Length', stats.size);
        
        return fs.createReadStream(partPath).pipe(res);
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
        
        // --- ВЕТВЬ А: ВЕБ-СТРАНИЦА (HTML) ---
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
                if (href && href.startsWith('/')) href = baseUrl + href;
                if (href) {
                    try {
                        const cssRes = await axios.get(href, { timeout: 3000, headers: {'User-Agent': 'Mozilla/5.0'} });
                        $(stylesheets[i]).replaceWith(`<style>${cssRes.data}</style>`);
                    } catch (e) {}
                }
            }

            const images = $('img').toArray();
            for (let i = 0; i < Math.min(images.length, 10); i++) {
                let src = $(images[i]).attr('src');
                if (src && !src.startsWith('data:') && src.startsWith('/')) src = baseUrl + src;
                if (src && !src.startsWith('data:')) {
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
        
        // --- ВЕТВЬ Б: БИНАРНЫЙ ФАЙЛ (СКАЧИВАНИЕ И АРХИВАЦИЯ) ---
        else {
            console.log(`[INFO] Обнаружен файл (${contentType}). Стримим на диск NF...`);
            
            const fileId = crypto.randomUUID();
            const fileDir = path.join(TMP_DIR, fileId);
            fs.mkdirSync(fileDir, { recursive: true });

            let fileName = 'download.bin';
            const cd = response.headers['content-disposition'];
            if (cd && cd.includes('filename=')) {
                fileName = cd.split('filename=')[1].replace(/["']/g, '');
            } else {
                fileName = path.basename(parsedTarget.pathname) || 'download.bin';
            }
            
            let safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            if (!safeName) safeName = "app.bin";

            const filePath = path.join(fileDir, safeName);
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
                        reject(new Error("FILE_TOO_LARGE"));
                    }
                });
                writer.on('finish', resolve);
                writer.on('error', reject);
            }).catch(err => { if (err.message !== "FILE_TOO_LARGE") throw err; });

            if (isTooLarge) {
                fs.rmSync(fileDir, { recursive: true, force: true });
                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`
                <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
                <body style="background:#f0f2f5; display:flex; justify-content:center; align-items:center; min-height:80vh; margin:0; font-family:sans-serif;">
                    <div style="background:white; padding:30px; border-top:5px solid #ff9800; border-radius:10px; text-align:center;">
                        <h2>🐘 Файл слишком большой</h2><p>Установлен жесткий лимит на скачивание: <b>130 МБ</b>.</p>
                    </div>
                </body></html>`);
            }

            console.log(`[SUCCESS] Файл ${safeName} скачан. Размер: ${(downloadedBytes/1024/1024).toFixed(2)} МБ`);

            setTimeout(() => {
                try {
                    fs.rmSync(fileDir, { recursive: true, force: true });
                    console.log(`[CLEANUP] Очищен кэш для: ${fileId}`);
                } catch(e) {}
            }, 2 * 60 * 60 * 1000);

            if (downloadedBytes <= CHUNK_SIZE_MB * 1024 * 1024) {
                res.set('Content-Type', contentType);
                res.set('Content-Disposition', `attachment; filename="${fileName}"`);
                return fs.createReadStream(filePath).pipe(res);
            } 
            
            else {
                console.log(`[INFO] Запускаем системный zip для создания многотомного архива...`);
                const zipBaseName = safeName + '.zip';
                
                try {
                    await execPromise(`cd "${fileDir}" && zip -s ${CHUNK_SIZE_MB}m "${zipBaseName}" "${safeName}"`);
                    console.log(`[SUCCESS] Архив успешно создан!`);
                } catch (zipErr) {
                    console.error(`[ERROR] Ошибка при архивации:`, zipErr);
                    return res.status(500).send("Внутренняя ошибка сервера при создании архива.");
                }

                fs.unlinkSync(filePath);

                const filesInDir = fs.readdirSync(fileDir);
                const archiveParts = filesInDir
                    .filter(f => f.startsWith(safeName + '.'))
                    .sort(); 

                let buttonsHtml = '';
                archiveParts.forEach((partName) => {
                    parsedTarget.searchParams.set('nf_fileId', fileId);
                    parsedTarget.searchParams.set('nf_partName', partName);
                    
                    const stat = fs.statSync(path.join(fileDir, partName));
                    const mbSize = (stat.size / 1024 / 1024).toFixed(1);
                    
                    buttonsHtml += `
                        <a href="${parsedTarget.toString()}" target="_blank" style="display:block; margin-bottom:10px; padding:12px; background:#1a73e8; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">
                            📥 Скачать ${partName} <span style="font-weight:normal; font-size:12px; opacity:0.8;">(${mbSize} МБ)</span>
                        </a>`;
                });

                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`
                <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
                <body style="background:#f0f2f5; display:flex; justify-content:center; align-items:flex-start; min-height:100vh; margin:0; padding:20px; font-family:sans-serif; box-sizing:border-box;">
                    <div style="background:white; padding:25px; border-top:5px solid #1a73e8; border-radius:10px; text-align:center; width:100%; max-width:400px; box-shadow:0 4px 10px rgba(0,0,0,0.1); margin-top:20px;">
                        <h2 style="margin-top:0;">📦 Объемный архив</h2>
                        <p style="font-size:14px; color:#333;">Оригинальный файл <b>${fileName}</b> весит ${(downloadedBytes/1024/1024).toFixed(1)} МБ.</p>
                        <div style="background:#fff3cd; color:#856404; padding:10px; border-radius:5px; font-size:12px; text-align:left; margin-bottom:15px; border:1px solid #ffeeba;">
                            <b>Как распаковать:</b><br>1. Скачайте все части в одну папку на вашем устройстве.<br>2. Откройте файл с расширением <b>.zip</b> в архиваторе (например, ZArchiver). Он сам найдет остальные части и извлечет ваш файл.
                        </div>
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
                            
