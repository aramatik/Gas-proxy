// Устанавливаем часовой пояс сервера (Киевское время)
process.env.TZ = 'Europe/Kyiv';

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
// СИСТЕМА ЛОГИРОВАНИЯ (Киевское время)
// ==========================================
const MAX_LOG_LINES = 100;
let serverLogs = [];

function getKyivTime() {
    return new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Kyiv', hour12: false });
}

function captureLog(msg) {
    serverLogs.push(`[${getKyivTime()}] ${msg}`);
    if (serverLogs.length > MAX_LOG_LINES) serverLogs.shift();
}
const origLog = console.log; console.log = function(...args) { origLog.apply(console, args); captureLog(util.format(...args)); };
const origErr = console.error; console.error = function(...args) { origErr.apply(console, args); captureLog("ERROR: " + util.format(...args)); };

console.log("[SYSTEM] Сервер запущен. Часовой пояс: Europe/Kyiv");

// ==========================================
// ТЕЛЕМЕТРИЯ: ПЕРЕХВАТЧИК ЛИМИТОВ (JSON ERROR PARSER)
// ==========================================
const LIMITS_FILE = path.join(TMP_DIR, 'gemini_limits.json');
let geminiLimits = {};

if (fs.existsSync(LIMITS_FILE)) {
    try { geminiLimits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); } catch(e){}
}

const originalFetch = global.fetch;
global.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url; 
    else if (input && input.href) url = input.href; 

    // Ловим запросы генерации к Google API
    if (url && url.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        const match = url.match(/models\/([^:]+)(?::generateContent|:streamGenerateContent)/);
        if (match && match[1]) {
            const modelId = match[1];
            
            // Если словили 429 - лимиты исчерпаны, парсим JSON
            if (response.status === 429) {
                try {
                    const clonedRes = response.clone();
                    const data = await clonedRes.json();
                    
                    let limit = '?';
                    let reset = '?';
                    
                    if (data.error && data.error.details) {
                        const quotaFailure = data.error.details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
                        const retryInfo = data.error.details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
                        
                        if (quotaFailure && quotaFailure.violations && quotaFailure.violations.length > 0) {
                            limit = quotaFailure.violations[0].quotaValue || '?';
                        }
                        if (retryInfo) {
                            reset = retryInfo.retryDelay || '?';
                        }
                    }
                    
                    geminiLimits[modelId] = {
                        status: 'БЛОКИРОВКА (429)',
                        limit: limit,
                        reset: reset,
                        lastUpdated: getKyivTime()
                    };
                    fs.writeFileSync(LIMITS_FILE, JSON.stringify(geminiLimits, null, 2));
                } catch(e) {
                    console.error("[FETCH INTERCEPTOR] Ошибка парсинга 429:", e.message);
                }
            } else if (response.status === 200) {
                // Если запрос прошел успешно, снимаем статус блокировки
                if (!geminiLimits[modelId] || geminiLimits[modelId].status !== 'OK') {
                    geminiLimits[modelId] = {
                        status: 'OK',
                        limit: geminiLimits[modelId] ? geminiLimits[modelId].limit : 'Скрыто',
                        reset: '-',
                        lastUpdated: getKyivTime()
                    };
                    fs.writeFileSync(LIMITS_FILE, JSON.stringify(geminiLimits, null, 2));
                }
            }
        }
    }
    return response;
};

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
        <code>/limit</code> — Состояние моделей (Блокировки)<br>
        <code>/logs</code> — Логи Northflank<br>
        <code>/download [путь]</code> — Скачать файл (до 15 МБ)<br>
        <code>/upload</code> — Загрузить файл на сервер<br><br>
        💻 <b>Терминал:</b><br>
        <code>! [команда]</code> — Консоль Linux<br>
        <i>Пример: <code>!ls -la /tmp</code></i>`;
        return res.json({ ok: true, text: respHtml });
    }

    if (userText === '/limit') {
        if (Object.keys(geminiLimits).length === 0) {
            return res.json({ ok: true, text: `📊 <b>Состояние API-моделей:</b><br><br>Google больше не передает остаток лимитов заранее. Сервер узнает точный лимит только при достижении потолка (ошибке 429). Сделайте запрос к ИИ, чтобы начать отслеживание статуса.` });
        }
        let tableHtml = `<table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:5px; background:#fff; color:#333;">
            <tr style="background:#1a73e8; color:white;">
                <th style="padding:4px; border:1px solid #ccc;">Модель</th>
                <th style="padding:4px; border:1px solid #ccc;">Статус</th>
                <th style="padding:4px; border:1px solid #ccc;">Макс.</th>
                <th style="padding:4px; border:1px solid #ccc;">Сброс</th>
                <th style="padding:4px; border:1px solid #ccc;">Обновлено</th>
            </tr>`;
        for (const [model, data] of Object.entries(geminiLimits)) {
            const statusColor = data.status === 'OK' ? '#28a745' : '#dc3545'; 
            tableHtml += `<tr>
                <td style="padding:4px; border:1px solid #ccc; font-weight:bold;">${model}</td>
                <td style="padding:4px; border:1px solid #ccc; text-align:center; font-weight:bold; color:${statusColor};">${data.status}</td>
                <td style="padding:4px; border:1px solid #ccc; text-align:center;">${data.limit}</td>
                <td style="padding:4px; border:1px solid #ccc; text-align:center;">${data.reset}</td>
                <td style="padding:4px; border:1px solid #ccc; text-align:center; color:#666;">${data.lastUpdated}</td>
            </tr>`;
        }
        tableHtml += `</table>`;
        return res.json({ ok: true, text: `📊 <b>Мониторинг блокировок:</b><br>${tableHtml}` });
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
            
            // Жесткий список "мертвых" моделей и устаревших
            const zeroLimitModels = [
                'gemini-2.5-pro',
                'gemini-2-flash', 
                'gemini-3.1-pro',
                'bison',
                'gecko'
            ];

            const models = response.data.models
                .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                .filter(m => {
                    const id = m.name.replace('models/', '');
                    // Если ID модели содержит строку из черного списка - выбрасываем
                    return !zeroLimitModels.some(zeroId => id.includes(zeroId));
                })
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
        const isGemma = modelName.toLowerCase().includes('gemma');
        const modelConfig = { model: modelName };
        
        // Модели Gemma не поддерживают systemInstruction
        if (!isGemma) {
            modelConfig.systemInstruction = "Ты — полезный ИИ-ассистент. Если пользователь присылает тебе аудиофайл или голосовое сообщение, просто выслушай вопрос/информацию, которая там содержится, и дай прямой ответ. НИКОГДА не делай технический или структурный анализ аудиофайла (не пиши про длительность, шумы, пол спикера, перевод и транскрипцию), если только тебя не попросили об этом напрямую. Также используй удобное форматирование Markdown.";
        }

        const model = genAI.getGenerativeModel(modelConfig);
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
     
