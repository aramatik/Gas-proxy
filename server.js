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
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

const MAX_FILE_SIZE = 130 * 1024 * 1024;
const CHUNK_SIZE_MB = 15; 
const TMP_DIR = '/tmp';

const PROXY_SECRET = process.env.PROXY_SECRET || "MySuperSecretPassword2026";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

let genAI = null;
let geminiHistory = []; 

if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// ==========================================
// СИСТЕМА ЛОГИРОВАНИЯ
// ==========================================
const MAX_LOG_LINES = 100;
let serverLogs = [];
function captureLog(msg) {
    const time = new Date().toISOString().substring(11, 19); 
    serverLogs.push(`[${time}] ${msg}`);
    if (serverLogs.length > MAX_LOG_LINES) serverLogs.shift();
}
const origLog = console.log; console.log = function(...args) { origLog.apply(console, args); captureLog(util.format(...args)); };
const origErr = console.error; console.error = function(...args) { origErr.apply(console, args); captureLog("ERROR: " + util.format(...args)); };

console.log("[SYSTEM] Сервер запущен. Система логирования активна.");

// ==========================================
// МАРШРУТ УПРАВЛЕНИЯ И GEMINI
// ==========================================
app.post('/gemini', async (req, res) => {
    if (req.query.token !== PROXY_SECRET) return res.status(403).json({ok: false, error: "Auth failed"});

    if (req.body.action === 'upload') {
        try {
            const filename = req.body.filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const buffer = Buffer.from(req.body.b64, 'base64');
            const savePath = path.join(TMP_DIR, filename);
            fs.writeFileSync(savePath, buffer);
            console.log(`[UPLOAD] Файл сохранен на диск сервера: ${savePath} (${(buffer.length/1024/1024).toFixed(2)} MB)`);
            return res.json({ok: true, text: `✅ Файл <b>${filename}</b> загружен!<br>Путь: <code>${savePath}</code>`});
        } catch (err) {
            console.error("[UPLOAD ERROR]", err.message);
            return res.status(500).json({ok: false, error: err.message});
        }
    }

    const userText = req.body.text ? req.body.text.trim() : "";
    
    if (userText === '/help') {
        const respHtml = `🤖 <b>СИСТЕМА CHATOPS:</b><br><br>
        <code>/status</code> — Состояние сервера<br>
        <code>/logs</code> — Логи Northflank<br>
        <code>/download [путь]</code> — Скачать файл (до 15 МБ)<br>
        <code>/upload</code> — Загрузить файл на сервер<br><br>
        💻 <b>Терминал:</b><br>
        <code>! [команда]</code> — Консоль Linux<br>
        <i>Пример: <code>!ls -la /tmp</code></i>`;
        return res.json({ ok: true, text: respHtml });
    }

    if (userText.startsWith('/download ')) {
        const targetPath = userText.substring(10).trim();
        if (!fs.existsSync(targetPath)) return res.json({ok: true, text: `❌ Файл не найден: <code>${targetPath}</code>`});
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) return res.json({ok: true, text: `❌ Это папка. Сначала запакуйте её:<br><code>!zip -r /tmp/dir.zip ${targetPath}</code>`});

        const mb = (stat.size / 1024 / 1024).toFixed(2);
        if (stat.size > 15 * 1024 * 1024) {
            return res.json({ok: true, text: `⚠️ Файл слишком большой для прокси Google (${mb} МБ). Максимум 15 МБ.<br>Разрежьте его на части:<br><code>!zip -s 14m /tmp/archive.zip ${targetPath}</code>`});
        }
        
        console.log(`[DOWNLOAD] Подготовлен файл для скачивания: ${targetPath} (${mb} MB)`);
        const fakeUrl = `http://system.local/dl?path=${encodeURIComponent(targetPath)}`;
        const respHtml = `📦 <b>Файл готов (${mb} MB)</b><br><a href="${fakeUrl}" style="display:inline-block; margin-top:8px; padding:8px 12px; background:#28a745; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">📥 Загрузить на телефон</a>`;
        return res.json({ok: true, text: respHtml});
    }

    if (userText === '/logs') {
        const logsHtml = serverLogs.length ? serverLogs.join('\n') : "Логи пусты.";
        return res.json({ ok: true, text: `🖥 <b>Логи Northflank:</b><br><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#e0e0e0; color:#333; padding:8px; border-radius:5px; margin-top:5px; white-space:pre-wrap;">${logsHtml}</div>` });
    }
    
    if (userText === '/status') {
        const mem = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        return res.json({ ok: true, text: `🖥 <b>Статус контейнера:</b><br>⏱ Uptime: <b>${hours}ч ${mins}м</b><br>💾 Память (RSS): <b>${(mem.rss / 1024 / 1024).toFixed(1)} MB</b><br>🧠 Контекст ИИ: <b>${geminiHistory.length} сообщений</b>` });
    }

    if (userText.startsWith('!')) {
        const cmd = userText.substring(1).trim();
        if (!cmd) return res.json({ ok: true, text: "⚠️ Введите команду после знака '!'." });
        try {
            console.log(`[CHATOPS] Выполнение в консоли: ${cmd}`);
            const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 }); 
            let output = stdout;
            if (stderr) output += `\n[STDERR]:\n${stderr}`;
            if (!output) output = "[Выполнено успешно, вывода нет]";
            if (output.length > 3000) output = output.substring(0, 3000) + "\n...[ВЫВОД ОБРЕЗАН]...";
            return res.json({ ok: true, text: `<b>$</b> <code>${cmd}</code><br><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#1e1e1e; color:#00ff00; padding:8px; border-radius:5px; margin-top:5px; white-space:pre-wrap;">${output}</div>` });
        } catch (err) {
            console.error(`[CHATOPS] Ошибка выполнения: ${cmd}`, err.message);
            return res.json({ ok: true, text: `<b>$</b> <code>${cmd}</code><br><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#3b1313; color:#ff6b6b; padding:8px; border-radius:5px; margin-top:5px; white-space:pre-wrap;">${err.message}</div>` });
        }
    }

    if (!GEMINI_API_KEY) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY на сервере"});

    if (req.body.action === 'get_models') {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
            const response = await axios.get(url);
            const models = response.data.models
                .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }));
            return res.json({ ok: true, models: models });
        } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
    }

    if (req.body.clear === 'true') {
        geminiHistory = [];
        console.log("[GEMINI] Память контекста нейросети очищена.");
        if (userText === 'clear') return res.json({ok: true, text: "История очищена"});
    }

    const modelName = req.body.model || "gemini-2.5-flash"; 
    
    const msgParts = [];
    if (userText) msgParts.push(userText);
    
    if (req.body.b64 && req.body.mimeType) {
        msgParts.push({
            inlineData: {
                data: req.body.b64,
                mimeType: req.body.mimeType
            }
        });
        console.log(`[GEMINI] К запросу прикреплен медиафайл: ${req.body.mimeType}`);
    }

    if (msgParts.length === 0) return res.status(400).json({ok: false, error: "Пустой запрос"});

    console.log(`[GEMINI] Запрос к ИИ. Модель: [${modelName}]. Контекст в памяти: [${geminiHistory.length} сообщений]`);

    try {
        const model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: "Ты — полезный ИИ-ассистент. Если пользователь присылает тебе аудиофайл или голосовое сообщение, просто выслушай вопрос/информацию, которая там содержится, и дай прямой ответ. НИКОГДА не делай технический или структурный анализ аудиофайла (не пиши про длительность, шумы, пол спикера, перевод и транскрипцию), если только тебя не попросили об этом напрямую. Также используй удобное форматирование Markdown."
        });
        
        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(msgParts);
        const responseText = result.response.text();
        geminiHistory = await chat.getHistory();
        return res.json({ ok: true, text: responseText });
    } catch (err) {
        console.error("[GEMINI ERROR]", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ==========================================
// ОСНОВНОЙ ПРОКСИ
// ==========================================
app.get('/', async (req, res) => {
    const reqToken = req.query.token;
    if (reqToken !== PROXY_SECRET) return res.status(403).send('Forbidden: Access Denied.');

    const nfDlPath = req.query.nf_dl_path;
    if (nfDlPath) {
        if (!fs.existsSync(nfDlPath)) return res.status(404).send("File not found on server.");
        const stats = fs.statSync(nfDlPath);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${path.basename(nfDlPath)}"`);
        res.set('Content-Length', stats.size);
        console.log(`[DOWNLOAD] Отдача запрошенного файла: ${nfDlPath}`);
        return fs.createReadStream(nfDlPath).pipe(res);
    }

    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Укажите URL: ?url=https://example.com');

    // ВОТ ОНИ: ВОССТАНОВЛЕННЫЕ ЛОГИ ПРОКСИ-СЕРВЕРА
    console.log(`\n[PROXY] Запрос веб-ресурса: ${targetUrl}`);
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
        console.log(`[PROXY] Отдача части архива: ${nfPartName}`);
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
            console.warn(`[PROXY WARNING] Целевой сайт заблокировал запрос (Код ${response.status})`);
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:40px;"><h2 style="color:#dc3545;">🚫 Защита от ботов (Код: ${response.status})</h2></body></html>`);
        }

        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('text/html')) {
            let chunks = []; let htmlBytes = 0;
            for await (const chunk of response.data) {
                chunks.push(chunk); htmlBytes += chunk.length;
                if (htmlBytes > 20 * 1024 * 1024) { 
                    response.data.destroy(); 
                    console.error(`[PROXY ERROR] Страница превысила лимит HTML в 20MB!`);
                    return res.status(400).send("Слишком тяжелая страница."); 
                }
            }
            const html = Buffer.concat(chunks).toString('utf-8');
            console.log(`[PROXY] HTML загружен (${(htmlBytes/1024).toFixed(1)} KB). Парсинг стилей и изображений...`);
            
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
            
            console.log(`[PROXY] Страница ${parsedTarget.hostname} успешно обработана и отправлена клиенту.`);
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.send($.html());
        } 
        
        else {
            console.log(`[PROXY] Обнаружен файл (${contentType}). Начинается загрузка на жесткий диск...`);
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
                    if (downloadedBytes > MAX_FILE_SIZE && !isTooLarge) { 
                        isTooLarge = true; 
                        response.data.destroy(); 
                        writer.close(); 
                        reject(new Error("FILE_TOO_LARGE")); 
                    }
                });
                writer.on('close', resolve);
                writer.on('error', reject);
            }).catch(err => { if (err.message !== "FILE_TOO_LARGE") throw err; });

            if (isTooLarge) {
                console.warn(`[PROXY] Файл превысил жесткий лимит скачивания (${MAX_FILE_SIZE/1024/1024} МБ). Операция прервана.`);
                fs.rmSync(fileDir, { recursive: true, force: true });
                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`<h2>🐘 Файл больше ${MAX_FILE_SIZE/1024/1024} МБ.</h2>`);
            }

            console.log(`[PROXY] Файл успешно скачан. Размер: ${(downloadedBytes/1024/1024).toFixed(2)} MB`);
            setTimeout(() => { try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch(e) {} }, 2 * 60 * 60 * 1000);

            if (downloadedBytes <= CHUNK_SIZE_MB * 1024 * 1024) {
                console.log(`[PROXY] Файл маленький, стримим напрямую клиенту.`);
                res.set('Content-Type', contentType);
                res.set('Content-Disposition', `attachment; filename="${fileName}"`);
                return fs.createReadStream(filePath).pipe(res);
            } else {
                console.log(`[PROXY] Файл больше ${CHUNK_SIZE_MB} МБ. Запущена упаковка в ZIP архив...`);
                const zipBaseName = safeName + '.zip';
                try { await execPromise(`cd "${fileDir}" && zip -s ${CHUNK_SIZE_MB}m "${zipBaseName}" "${safeName}"`); } 
                catch (zipErr) { 
                    console.error(`[PROXY ERROR] Ошибка создания ZIP архива: ${zipErr.message}`);
                    return res.status(500).send("Ошибка архивации"); 
                }
                
                fs.unlinkSync(filePath);
                const filesInDir = fs.readdirSync(fileDir);
                const archiveParts = filesInDir.filter(f => f.startsWith(safeName + '.')).sort(); 
                
                console.log(`[PROXY] Архив успешно создан. Состоит из ${archiveParts.length} частей.`);

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
    } catch (error) { 
        console.error(`[PROXY ERROR] Ошибка шлюза при обработке ${targetUrl}:`, error.message);
        res.status(500).send(`Ошибка шлюза: ${error.message}`); 
    }
});

app.listen(process.env.PORT || 8080);
