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
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const MAX_FILE_SIZE = 130 * 1024 * 1024;
const CHUNK_SIZE_MB = 15; 
const TMP_DIR = '/tmp';

// Секреты из Environment Variables
const PROXY_SECRET = process.env.PROXY_SECRET || "MySuperSecretPassword2026";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Глобальная инициализация ИИ и хранилище памяти
let genAI = null;
let geminiHistory = []; // Память диалога

if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// ==========================================
// МАРШРУТ: ПРЯМОЙ МОСТ К GEMINI AI
// ==========================================
app.post('/gemini', async (req, res) => {
    if (req.query.token !== PROXY_SECRET) return res.status(403).json({ok: false, error: "Auth failed"});
    if (!genAI) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY на сервере"});

    // Обработка сигнала об очистке памяти
    if (req.body.clear === 'true') {
        geminiHistory = [];
        console.log("[GEMINI] Память нейросети успешно очищена.");
        if (req.body.text === 'clear') return res.json({ok: true, text: "История очищена"});
    }

    const userText = req.body.text;
    const modelName = req.body.model || "gemini-1.5-flash"; // Модель по умолчанию
    if (!userText) return res.status(400).json({ok: false, error: "Нет текста запроса"});

    try {
        // Подключаем выбранную модель, передаем ей всю историю прошлых бесед
        const model = genAI.getGenerativeModel({ model: modelName });
        const chat = model.startChat({ history: geminiHistory });
        
        const result = await chat.sendMessage(userText);
        const responseText = result.response.text();
        
        // Сохраняем обновленную историю обратно в память
        geminiHistory = await chat.getHistory();
        
        return res.json({ ok: true, text: responseText });
    } catch (err) {
        console.error("[GEMINI ERROR]", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ==========================================
// ОСНОВНОЙ ПРОКСИ-СЕРВЕР
// ==========================================
app.get('/', async (req, res) => {
    const reqToken = req.query.token;
    if (reqToken !== PROXY_SECRET) {
        return res.status(403).send('Forbidden: Access Denied.');
    }

    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Укажите URL: ?url=https://example.com');

    console.log(`\n[${new Date().toISOString()}] [START] Запрос URL: ${targetUrl}`);
    const parsedTarget = new URL.URL(targetUrl);

    const nfFileId = parsedTarget.searchParams.get('nf_fileId');
    const nfPartName = parsedTarget.searchParams.get('nf_partName');

    if (nfFileId && nfPartName) {
        if (nfPartName.includes('/') || nfPartName.includes('\\') || nfFileId.includes('/')) return res.status(400).send("Bad path.");
        const partPath = path.join(TMP_DIR, nfFileId, nfPartName);
        if (!fs.existsSync(partPath)) return res.status(404).send("<meta charset='utf-8'><h3>⏳ Кэш истек. Начните заново.</h3>");
        
        const stats = fs.statSync(partPath);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${nfPartName}"`);
        res.set('Content-Length', stats.size);
        return fs.createReadStream(partPath).pipe(res);
    }

    try {
        const response = await axios.get(targetUrl, { 
            responseType: 'stream',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000,
            validateStatus: () => true 
        });
        
        if ([401, 403, 406, 429, 503].includes(response.status)) {
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:40px;"><h2 style="color:#dc3545;">🚫 Защита от ботов (Код: ${response.status})</h2></body></html>`);
        }

        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('text/html')) {
            let chunks = []; let htmlBytes = 0;
            for await (const chunk of response.data) {
                chunks.push(chunk); htmlBytes += chunk.length;
                if (htmlBytes > 20 * 1024 * 1024) { response.data.destroy(); return res.status(400).send("Слишком тяжелая страница."); }
            }
            const html = Buffer.concat(chunks).toString('utf-8');
            const $ = cheerio.load(html);
            const baseUrl = parsedTarget.origin;

            const stylesheets = $('link[rel="stylesheet"]').toArray();
            for (let i = 0; i < Math.min(stylesheets.length, 5); i++) {
                let href = $(stylesheets[i]).attr('href');
                if (href && href.startsWith('/')) href = baseUrl + href;
                if (href) { try { const cssRes = await axios.get(href, { timeout: 3000 }); $(stylesheets[i]).replaceWith(`<style>${cssRes.data}</style>`); } catch (e) {} }
            }

            const images = $('img').toArray();
            for (let i = 0; i < Math.min(images.length, 10); i++) {
                let src = $(images[i]).attr('src');
                if (src && !src.startsWith('data:') && src.startsWith('/')) src = baseUrl + src;
                if (src && !src.startsWith('data:')) {
                    try { const imgRes = await axios.get(src, { responseType: 'arraybuffer', timeout: 3000 });
                        const b64 = Buffer.from(imgRes.data, 'binary').toString('base64');
                        $(images[i]).attr('src', `data:${imgRes.headers['content-type']};base64,${b64}`).removeAttr('srcset'); 
                    } catch (e) {}
                }
            }
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.send($.html());
        } 
        
        else {
            const fileId = crypto.randomUUID();
            const fileDir = path.join(TMP_DIR, fileId);
            fs.mkdirSync(fileDir, { recursive: true });

            let fileName = 'download.bin';
            const cd = response.headers['content-disposition'];
            if (cd && cd.includes('filename=')) fileName = cd.split('filename=')[1].replace(/["']/g, '');
            else fileName = path.basename(parsedTarget.pathname) || 'download.bin';
            
            let safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_') || "app.bin";
            const filePath = path.join(fileDir, safeName);
            const writer = fs.createWriteStream(filePath);
            
            let downloadedBytes = 0; let isTooLarge = false;

            await new Promise((resolve, reject) => {
                response.data.pipe(writer);
                response.data.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes > MAX_FILE_SIZE && !isTooLarge) { isTooLarge = true; response.data.destroy(); writer.close(); reject(new Error("FILE_TOO_LARGE")); }
                });
                writer.on('close', resolve);
                writer.on('error', reject);
            }).catch(err => { if (err.message !== "FILE_TOO_LARGE") throw err; });

            if (isTooLarge) {
                fs.rmSync(fileDir, { recursive: true, force: true });
                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`<h2>🐘 Файл больше ${MAX_FILE_SIZE/1024/1024} МБ.</h2>`);
            }

            setTimeout(() => { try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch(e) {} }, 2 * 60 * 60 * 1000);

            if (downloadedBytes <= CHUNK_SIZE_MB * 1024 * 1024) {
                res.set('Content-Type', contentType);
                res.set('Content-Disposition', `attachment; filename="${fileName}"`);
                return fs.createReadStream(filePath).pipe(res);
            } else {
                const zipBaseName = safeName + '.zip';
                try { await execPromise(`cd "${fileDir}" && zip -s ${CHUNK_SIZE_MB}m "${zipBaseName}" "${safeName}"`); } 
                catch (zipErr) { return res.status(500).send("Ошибка архивации"); }
                fs.unlinkSync(filePath);

                const filesInDir = fs.readdirSync(fileDir);
                const archiveParts = filesInDir.filter(f => f.startsWith(safeName + '.')).sort(); 

                let buttonsHtml = ''; let totalCompressedBytes = 0; 
                archiveParts.forEach((partName) => {
                    parsedTarget.searchParams.set('nf_fileId', fileId); parsedTarget.searchParams.set('nf_partName', partName);
                    const stat = fs.statSync(path.join(fileDir, partName)); totalCompressedBytes += stat.size; 
                    buttonsHtml += `<a href="${parsedTarget.toString()}" target="_blank" style="display:block; margin-bottom:10px; padding:12px; background:#1a73e8; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">📥 Скачать ${partName} <span style="font-weight:normal; font-size:12px;">(${(stat.size/1024/1024).toFixed(1)} МБ)</span></a>`;
                });

                const origMB = (downloadedBytes/1024/1024).toFixed(1); const compMB = (totalCompressedBytes/1024/1024).toFixed(1);
                let savingsHtml = downloadedBytes > totalCompressedBytes ? `<span style="color:#28a745; font-weight:bold;">Сжато до ${compMB} МБ (вы экономите ${((downloadedBytes - totalCompressedBytes)/1024/1024).toFixed(1)} МБ)</span>` : `Размер: ${compMB} МБ`;

                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="background:#f0f2f5; display:flex; justify-content:center; padding:20px; font-family:sans-serif;"><div style="background:white; padding:25px; border-top:5px solid #1a73e8; border-radius:10px; text-align:center; width:100%; max-width:400px; box-shadow:0 4px 10px rgba(0,0,0,0.1);"><h2 style="margin-top:0;">📦 Объемный архив</h2><p style="font-size:14px; margin-bottom:5px;">Оригинал: ${origMB} МБ</p><p style="font-size:14px; margin-top:0; margin-bottom:15px;">${savingsHtml}</p><div style="background:#fff3cd; color:#856404; padding:10px; border-radius:5px; font-size:12px; text-align:left; margin-bottom:15px;">Распакуйте файл <b>.zip</b> в ZArchiver.</div>${buttonsHtml}</div></body></html>`);
            }
        }
    } catch (error) { res.status(500).send(`Ошибка шлюза: ${error.message}`); }
});

app.listen(process.env.PORT || 8080);
