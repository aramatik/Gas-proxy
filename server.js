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
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ""; 
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || ""; 

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

function getKyivTime() {
    return new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Kyiv', hour12: false });
}

function captureLog(msg) {
    serverLogs.push(`[${getKyivTime()}] ${msg}`);
    if (serverLogs.length > MAX_LOG_LINES) serverLogs.shift();
}
const origLog = console.log; 
console.log = function(...args) { 
    origLog.apply(console, args); 
    captureLog(util.format(...args)); 
};
const origErr = console.error; 
console.error = function(...args) { 
    origErr.apply(console, args); 
    captureLog("ERROR: " + util.format(...args)); 
};

console.log("[SYSTEM] Сервер запущен. Часовой пояс: Europe/Kyiv");

let useProxy = false;

function getBrowserHeaders(isMobile = false) {
    const ua = isMobile 
        ? 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    return {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'upgrade-insecure-requests': '1'
    };
}

function decodeBuffer(buffer, contentType) {
    let charset = 'utf-8';
    if (contentType.toLowerCase().includes('windows-1251')) {
        charset = 'windows-1251';
    } else {
        const head = buffer.subarray(0, 2048).toString('ascii').toLowerCase();
        if (head.includes('windows-1251')) charset = 'windows-1251';
    }
    try {
        return new TextDecoder(charset).decode(buffer);
    } catch(e) {
        return buffer.toString('utf-8');
    }
}

// ==========================================
// ТЕЛЕМЕТРИЯ ЛИМИТОВ
// ==========================================
const LIMITS_FILE = path.join(TMP_DIR, 'gemini_limits.json');
let geminiLimits = {};

if (fs.existsSync(LIMITS_FILE)) {
    try { geminiLimits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); } catch(e){}
}

const originalFetch = global.fetch;
global.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    let url = typeof input === 'string' ? input : (input && input.url ? input.url : ''); 
    if (url && url.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        const match = url.match(/models\/([^:]+)(?::generateContent|:streamGenerateContent)/);
        if (match && match[1]) {
            const modelId = match[1];
            if (response.status === 429) {
                try {
                    const data = await response.clone().json();
                    let limit = '?'; let reset = '?';
                    if (data.error && data.error.details) {
                        const quotaFailure = data.error.details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
                        const retryInfo = data.error.details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
                        if (quotaFailure && quotaFailure.violations && quotaFailure.violations.length > 0) limit = quotaFailure.violations[0].quotaValue || '?';
                        if (retryInfo) reset = retryInfo.retryDelay || '?';
                    }
                    geminiLimits[modelId] = { status: 'БЛОКИРОВКА (429)', limit: limit, reset: reset, lastUpdated: getKyivTime() };
                    fs.writeFileSync(LIMITS_FILE, JSON.stringify(geminiLimits, null, 2));
                } catch(e) {}
            } else if (response.status === 200) {
                if (!geminiLimits[modelId] || geminiLimits[modelId].status !== 'OK') {
                    geminiLimits[modelId] = { status: 'OK', limit: geminiLimits[modelId] ? geminiLimits[modelId].limit : 'Скрыто', reset: '-', lastUpdated: getKyivTime() };
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
            const savePath = path.join(TMP_DIR, filename);
            fs.writeFileSync(savePath, Buffer.from(req.body.b64, 'base64'));
            console.log(`[UPLOAD] Файл сохранен: ${savePath}`);
            return res.json({ok: true, text: `✅ Файл <b>${filename}</b> загружен!<br>Путь: <code>${savePath}</code>`});
        } catch (err) { 
            console.error("[UPLOAD ERROR]", err.message);
            return res.status(500).json({ok: false, error: err.message}); 
        }
    }

    let userText = req.body.text ? req.body.text.trim() : "";
    
    if (userText === '/help') {
        const respHtml = `🤖 <b>СИСТЕМА CHATOPS:</b><br><br>
<code>/status</code> — Состояние сервера<br>
<code>/proxy on</code> | <code>/proxy off</code> — Ghost Proxy (curl-impersonate локальный)<br>
<code>/limit</code> — Состояние моделей<br>
<code>/download [путь]</code> — Скачать файл<br>
<code>/search [запрос]</code> — Поиск в сети<br><br>
💻 <b>Терминал:</b><br><code>! [команда]</code> — Консоль Linux`;
        return res.json({ ok: true, text: respHtml });
    }

    if (userText === '/proxy on') {
        if (!SOCKS5_PROXY) return res.json({ok: true, text: "❌ Переменная SOCKS5_PROXY не настроена."});
        useProxy = true;
        
        const curlDir = path.join(__dirname, 'curl-impersonate');
        const curlBin = path.join(curlDir, 'curl_chrome116'); 
        
        if (!fs.existsSync(curlBin)) {
            console.error("[PROXY ERROR] Папка curl-impersonate не найдена в корне проекта!");
            return res.json({ok: true, text: `❌ Ошибка: Не найдена локальная папка curl-impersonate. Проверьте GitHub репозиторий.`});
        }

        try {
            fs.chmodSync(curlBin, 0o755);
            fs.chmodSync(path.join(curlDir, 'curl-impersonate-chrome'), 0o755);
            console.log("[PROXY] Права на выполнение бинарников успешно обновлены.");
        } catch (e) {
            console.warn("[PROXY WARNING] Не удалось обновить права файлов:", e.message);
        }

        try {
            if (fs.existsSync('/etc/os-release')) {
                const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
                if (osRelease.includes('Alpine')) {
                    console.log("[PROXY] Обнаружен Alpine Linux. Проверка зависимостей...");
                    await execPromise(`apk add --no-cache bash gcompat libc6-compat`);
                    console.log("[PROXY] Успешно проверены bash и gcompat.");
                }
            }
        } catch (e) {
            console.log("[PROXY WARNING] Ошибка установки зависимостей:", e.message);
        }

        console.log("[PROXY] Ghost Proxy успешно активирован (Локальная версия).");
        return res.json({ok: true, text: "🚀 <b>Ghost Proxy включен!</b><br>Трафик идет через SOCKS5 с локальным curl-impersonate."});
    }

    if (userText === '/proxy off') {
        useProxy = false;
        console.log("[PROXY] Ghost Proxy отключен.");
        return res.json({ok: true, text: "🛑 <b>Proxy выключен.</b>"});
    }

    if (userText === '/limit') {
        if (Object.keys(geminiLimits).length === 0) return res.json({ ok: true, text: `📊 <b>Состояние моделей:</b> Отправьте запрос ИИ.` });
        let tableHtml = `<table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:5px; background:#fff; color:#333;"><tr style="background:#1a73e8; color:white;"><th style="padding:4px; border:1px solid #ccc;">Модель</th><th style="padding:4px; border:1px solid #ccc;">Статус</th><th style="padding:4px; border:1px solid #ccc;">Сброс</th></tr>`;
        for (const [model, data] of Object.entries(geminiLimits)) {
            const statusColor = data.status === 'OK' ? '#28a745' : '#dc3545'; 
            tableHtml += `<tr><td style="padding:4px; border:1px solid #ccc; font-weight:bold;">${model}</td><td style="padding:4px; border:1px solid #ccc; text-align:center; font-weight:bold; color:${statusColor};">${data.status}</td><td style="padding:4px; border:1px solid #ccc; text-align:center;">${data.reset}</td></tr>`;
        }
        tableHtml += `</table>`;
        return res.json({ ok: true, text: `📊 <b>Мониторинг блокировок:</b><br>${tableHtml}` });
    }

    if (userText.startsWith('/download ')) {
        const targetPath = userText.substring(10).trim();
        if (!fs.existsSync(targetPath)) return res.json({ok: true, text: `❌ Файл не найден.`});
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) return res.json({ok: true, text: `❌ Это папка. Сначала запакуйте её: <code>!zip -r /tmp/dir.zip ${targetPath}</code>`});
        const mb = (stat.size / 1024 / 1024).toFixed(2);
        if (stat.size > 15 * 1024 * 1024) return res.json({ok: true, text: `⚠️ Файл слишком большой (${mb} МБ). Максимум 15 МБ.`});
        
        console.log(`[DOWNLOAD] Подготовлен файл: ${targetPath} (${mb} MB)`);
        const fakeUrl = `http://system.local/dl?path=${encodeURIComponent(targetPath)}`;
        return res.json({ok: true, text: `📦 <b>Файл готов (${mb} MB)</b><br><a href="${fakeUrl}" style="display:inline-block; margin-top:8px; padding:8px 12px; background:#28a745; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">📥 Загрузить на телефон</a>`});
    }

    if (userText === '/logs') {
        const logsHtml = serverLogs.length ? serverLogs.join('\n') : "Логи пусты.";
        return res.json({ ok: true, text: `🖥 <b>Логи Northflank:</b><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#e0e0e0; color:#333; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${logsHtml}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#999; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>` });
    }
    
    if (userText === '/status') {
        const mem = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        return res.json({ ok: true, text: `🖥 <b>Статус:</b><br>⏱ Uptime: <b>${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м</b><br>💾 Память: <b>${(mem.rss / 1024 / 1024).toFixed(1)} MB</b><br>🔒 Ghost Proxy: <b>${useProxy ? '<span style="color:green">ВКЛЮЧЕН</span>' : '<span style="color:red">ВЫКЛЮЧЕН</span>'}</b><br>🧠 Контекст: <b>${geminiHistory.length} сообщений</b>` });
    }

    if (userText.startsWith('!')) {
        const cmd = userText.substring(1).trim();
        if (!cmd) return res.json({ ok: true, text: "⚠️ Введите команду." });
        try {
            console.log(`[CHATOPS] Выполнение: ${cmd}`);
            const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 }); 
            let output = stdout; if (stderr) output += `\n[STDERR]:\n${stderr}`;
            if (!output) output = "[Выполнено успешно]";
            if (output.length > 300000) output = output.substring(0, 300000) + "\n...[ОБРЕЗАН]...";
            return res.json({ ok: true, text: `<b>$</b> <code>${cmd}</code><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#1e1e1e; color:#0f0; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${output}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#555; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>` });
        } catch (err) {
            return res.json({ ok: true, text: `<b>$</b> <code>${cmd}</code><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#3b1313; color:#f66; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${err.message}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#773333; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>` });
        }
    }

    if (userText.startsWith('/search ')) {
        const query = userText.substring(8).trim();
        if (!query) return res.json({ ok: true, text: "⚠️ Укажите запрос." });

        console.log(`[WEB SEARCH] Выполнение: ${query}`);
        try {
            let searchResultsText = "";
            if (query.toLowerCase().startsWith('download:')) {
                const dlUrl = query.substring(9).trim();
                const parsed = new URL.URL(dlUrl);
                let filename = (path.basename(parsed.pathname) || `dl_${Date.now()}`).replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const savePath = path.join(TMP_DIR, filename);

                if (useProxy && SOCKS5_PROXY) {
                    console.log(`[WEB SEARCH] Скачивание через локальный Ghost Proxy: ${dlUrl}`);
                    const curlBin = path.join(__dirname, 'curl-impersonate', 'curl_chrome116'); 
                    const proxyStr = SOCKS5_PROXY.replace('socks5://', 'socks5h://');
                    await execPromise(`bash "${curlBin}" --compressed -m 60 -s -L -x "${proxyStr}" -o "${savePath}" "${dlUrl}"`);
                } else {
                    console.log(`[WEB SEARCH] Скачивание напрямую: ${dlUrl}`);
                    const response = await axios.get(dlUrl, { responseType: 'stream', headers: getBrowserHeaders(false), timeout: 60000 });
                    const writer = fs.createWriteStream(savePath);
                    response.data.pipe(writer);
                    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                }
                const stat = fs.statSync(savePath);
                console.log(`[WEB SEARCH] Файл успешно скачан. Размер: ${(stat.size/1024).toFixed(1)} KB`);
                searchResultsText = `✅ Файл успешно скачан!\n📁 Путь: ${savePath}\n📦 Размер: ${(stat.size/1024).toFixed(1)} KB`;
            } else {
                if (!TAVILY_API_KEY) throw new Error("Не настроен TAVILY_API_KEY.");
                let apiQuery = query; let includeDomains = [];
                const siteMatch = apiQuery.match(/(?:^|\s)site:([^\s]+)/i);
                if (siteMatch) { includeDomains.push(siteMatch[1]); apiQuery = apiQuery.replace(/(?:^|\s)site:([^\s]+)/i, '').trim(); }
                const ftMatch = apiQuery.match(/(?:^|\s)filetype:([a-z0-9]+)/i);
                if (ftMatch) { apiQuery = apiQuery.replace(/(?:^|\s)filetype:([a-z0-9]+)/i, '').trim(); apiQuery += ` (file document ${ftMatch[1]})`; }
                
                const requestBody = { api_key: TAVILY_API_KEY, query: apiQuery || "index", max_results: 6, search_depth: "basic" };
                if (includeDomains.length > 0) requestBody.include_domains = includeDomains;
                const response = await axios.post('https://api.tavily.com/search', requestBody);
                
                if (response.data && response.data.results && response.data.results.length > 0) {
                    let results = response.data.results.map((r, i) => `[${i+1}] ${r.title}\n${r.content}\nСсылка: ${r.url}`);
                    searchResultsText = `Результаты:\n\n${results.join('\n\n')}`;
                } else { searchResultsText = `По запросу «${query}» ничего не найдено.`; }
            }
            userText = `Команда /search "${query}". Данные:\n\n${searchResultsText}\n\nПроанализируй и дай ответ.`;
        } catch (err) { 
            console.error(`[WEB SEARCH ERROR]`, err.message);
            userText = `Ошибка поиска "${query}": ${err.message}.`; 
        }
    }

    if (!GEMINI_API_KEY) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY"});
    if (req.body.clear === 'true') { 
        geminiHistory = []; 
        console.log("[GEMINI] Память контекста нейросети очищена.");
        if (userText === 'clear') return res.json({ok: true, text: "История очищена"}); 
    }

    const modelName = req.body.model || "gemini-2.5-flash"; 
    const msgParts = [];
    if (userText) msgParts.push(userText);
    if (req.body.b64 && req.body.mimeType) {
        msgParts.push({ inlineData: { data: req.body.b64, mimeType: req.body.mimeType } });
        console.log(`[GEMINI] К запросу прикреплен файл: ${req.body.mimeType}`);
    }

    if (msgParts.length === 0) return res.status(400).json({ok: false, error: "Пустой запрос"});

    console.log(`[GEMINI] Запрос к ИИ. Модель: [${modelName}]. Контекст в памяти: [${geminiHistory.length} сообщений]`);

    try {
        const isGemma = modelName.toLowerCase().includes('gemma');
        const modelConfig = { model: modelName };
        if (!isGemma) modelConfig.systemInstruction = "Ты — полезный ИИ-ассистент.";
        const model = genAI.getGenerativeModel(modelConfig);
        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(msgParts);
        geminiHistory = await chat.getHistory();
        return res.json({ ok: true, text: result.response.text() });
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
    if (reqToken !== PROXY_SECRET) return res.status(403).send('Forbidden.');

    const nfDlPath = req.query.nf_dl_path;
    if (nfDlPath) {
        if (!fs.existsSync(nfDlPath)) return res.status(404).send("Not found.");
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${path.basename(nfDlPath)}"`);
        res.set('Content-Length', fs.statSync(nfDlPath).size);
        console.log(`[DOWNLOAD] Отдача локального файла: ${nfDlPath}`);
        return fs.createReadStream(nfDlPath).pipe(res);
    }

    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Укажите URL.');
    let imgLim = req.query.img_limit !== undefined ? parseInt(req.query.img_limit) : 10;
    let isMobile = req.query.mobile_ua === 'true';

    console.log(`\n[PROXY] Запрос ресурса: ${targetUrl} (Картинки: ${imgLim === -1 ? 'ВСЕ' : imgLim}, Режим: ${isMobile ? 'Mobile' : 'Desktop'})`);

    const parsedTarget = new URL.URL(targetUrl);
    const nfFileId = parsedTarget.searchParams.get('nf_fileId');
    const nfPartName = parsedTarget.searchParams.get('nf_partName');

    if (nfFileId && nfPartName) {
        const partPath = path.join(TMP_DIR, nfFileId, nfPartName);
        if (!fs.existsSync(partPath)) return res.status(404).send("Кэш истек.");
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${nfPartName}"`);
        res.set('Content-Length', fs.statSync(partPath).size);
        console.log(`[PROXY] Отдача части архива: ${nfPartName}`);
        return fs.createReadStream(partPath).pipe(res);
    }

    let contentType = '';
    let contentDisp = '';
    let responseStatus = 200;
    let isHtml = false;
    let htmlContent = '';
    let downloadStream = null;
    let downloadFilePath = '';

    try {
        if (useProxy && SOCKS5_PROXY) {
            console.log(`[PROXY] Использование Ghost Proxy (локальный curl-impersonate)...`);
            const reqId = crypto.randomUUID();
            const headFile = path.join(TMP_DIR, `${reqId}_head.txt`);
            const bodyFile = path.join(TMP_DIR, `${reqId}_body.bin`);
            const curlBin = path.join(__dirname, 'curl-impersonate', 'curl_chrome116'); 
            const proxyStr = SOCKS5_PROXY.replace('socks5://', 'socks5h://');
            
            await execPromise(`bash "${curlBin}" --compressed -m 15 -s -L -x "${proxyStr}" -D "${headFile}" -o "${bodyFile}" "${targetUrl}"`);
            
            const headContent = fs.readFileSync(headFile, 'utf8');
            const headerLines = headContent.split('\r\n');
            for (const line of headerLines) {
                if (line.toLowerCase().startsWith('content-type:')) contentType = line.split(':', 2)[1].trim();
                if (line.toLowerCase().startsWith('content-disposition:')) contentDisp = line.split(':', 2)[1].trim();
                if (line.startsWith('HTTP/')) {
                    const parts = line.split(' ');
                    if (parts.length > 1) responseStatus = parseInt(parts[1]);
                }
            }
            
            if (contentType.includes('text/html')) {
                isHtml = true;
                const bodyBuffer = fs.readFileSync(bodyFile);
                htmlContent = decodeBuffer(bodyBuffer, contentType);
                fs.unlinkSync(bodyFile); fs.unlinkSync(headFile);
            } else {
                downloadFilePath = bodyFile; 
                fs.unlinkSync(headFile);
            }
        } else {
            console.log(`[PROXY] Запрос напрямую (axios)...`);
            const response = await axios.get(targetUrl, { 
                responseType: 'stream', headers: getBrowserHeaders(isMobile), timeout: 15000, validateStatus: () => true 
            });
            responseStatus = response.status;
            contentType = response.headers['content-type'] || '';
            contentDisp = response.headers['content-disposition'] || '';
            
            if (contentType.includes('text/html')) {
                isHtml = true;
                let chunks = []; let htmlBytes = 0;
                for await (const chunk of response.data) {
                    chunks.push(chunk); htmlBytes += chunk.length;
                    if (htmlBytes > 20 * 1024 * 1024) { response.data.destroy(); return res.status(400).send("Слишком тяжелая страница."); }
                }
                const bodyBuffer = Buffer.concat(chunks);
                htmlContent = decodeBuffer(bodyBuffer, contentType);
            } else {
                downloadStream = response.data;
            }
        }

        // --- УМНАЯ ЗАГЛУШКА АНТИ-БОТОВ ---
        if ([401, 403, 406, 429, 503].includes(responseStatus)) {
            console.warn(`[PROXY WARNING] Сайт заблокировал запрос. HTTP Код: ${responseStatus}`);
            return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:40px; background:#f8d7da; color:#721c24; border-radius:10px; margin:20px;"><h2 style="margin-top:0;">🚫 Доступ заблокирован (${responseStatus})</h2><p>Целевой сервер отклонил запрос. Попробуйте использовать команду <b>/proxy on</b> в чате.</p></body></html>`);
        }

        if (isHtml && (htmlContent.includes('<title>Just a moment...</title>') || htmlContent.includes('Enable JavaScript and cookies to continue'))) {
             console.warn(`[PROXY WARNING] Обнаружена JS-капча Cloudflare (Код ${responseStatus})`);
             return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:40px; background:#fff3cd; color:#856404; border-radius:10px; margin:20px;"><h2 style="margin-top:0;">🤖 JS-Капча (Cloudflare)</h2><p>Сайт требует вычисления сложной JavaScript-капчи, которую невозможно выполнить через серверный прокси. Откройте эту ссылку в обычном браузере.</p></body></html>`);
        }

        // --- Обработка HTML ---
        if (isHtml) {
            console.log(`[PROXY] HTML загружен успешно. Парсинг ресурсов...`);
            const $ = cheerio.load(htmlContent);
            const baseUrl = parsedTarget.origin;
            
            const stylesheets = $('link[rel="stylesheet"]').toArray();
            for (let i = 0; i < Math.min(stylesheets.length, 5); i++) {
                let href = $(stylesheets[i]).attr('href');
                if (href && href.startsWith('/')) href = baseUrl + href;
                if (href) { 
                    try { 
                        const cssRes = await axios.get(href, { headers: getBrowserHeaders(isMobile), timeout: 3000 }); 
                        $(stylesheets[i]).replaceWith(`<style>${cssRes.data}</style>`); 
                    } catch (e) {} 
                }
            }

            const images = $('img').toArray();
            for (let i = 0; i < images.length; i++) {
                let img = $(images[i]);
                if (imgLim === 0) { img.attr('src', 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=').removeAttr('srcset').removeAttr('data-src').removeAttr('loading'); continue; }
                if (imgLim > 0 && i >= imgLim) break;

                let src = img.attr('src') || img.attr('data-src') || img.attr('data-original');
                if (src && !src.startsWith('data:') && src.startsWith('/')) src = baseUrl + src;
                if (src && !src.startsWith('data:')) {
                    try { 
                        const imgRes = await axios.get(src, { responseType: 'arraybuffer', headers: getBrowserHeaders(isMobile), timeout: 3500 });
                        img.attr('src', `data:${imgRes.headers['content-type']};base64,${Buffer.from(imgRes.data, 'binary').toString('base64')}`);
                        img.removeAttr('srcset').removeAttr('data-src').removeAttr('loading'); 
                    } catch (e) {}
                }
            }
            
            if (req.query.nf_dl_html === 'true') {
                console.log(`[PROXY] Формирование HTML для скачивания: ${parsedTarget.hostname}`);
                $('head').prepend(`<base href="${parsedTarget.origin}">`);
                res.set('Content-Type', 'application/octet-stream'); 
                res.set('Content-Disposition', `attachment; filename="page_${parsedTarget.hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}.html"`);
                return res.send($.html());
            }

            console.log(`[PROXY] Страница успешно обработана и отправлена.`);
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.send($.html());
        } 
        
        // --- Обработка Загрузки файлов ---
        else {
            console.log(`[PROXY] Обнаружен файл (${contentType}). Подготовка к загрузке...`);
            const fileId = crypto.randomUUID();
            const fileDir = path.join(TMP_DIR, fileId);
            fs.mkdirSync(fileDir, { recursive: true });

            let fileName = 'download.bin';
            if (contentDisp && contentDisp.includes('filename=')) fileName = contentDisp.split('filename=')[1].replace(/["']/g, '');
            else fileName = path.basename(parsedTarget.pathname) || 'download.bin';
            
            let safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_') || "app.bin";
            const filePath = path.join(fileDir, safeName);
            let downloadedBytes = 0; let isTooLarge = false;

            if (downloadFilePath) {
                downloadedBytes = fs.statSync(downloadFilePath).size;
                if (downloadedBytes > MAX_FILE_SIZE) {
                    console.warn(`[PROXY] Ошибка: Файл превысил лимит ${MAX_FILE_SIZE/1024/1024} МБ`);
                    fs.unlinkSync(downloadFilePath); return res.status(200).send(`<h2>🐘 Файл больше ${MAX_FILE_SIZE/1024/1024} МБ.</h2>`);
                }
                fs.renameSync(downloadFilePath, filePath);
            } else if (downloadStream) {
                const writer = fs.createWriteStream(filePath);
                await new Promise((resolve, reject) => {
                    downloadStream.pipe(writer);
                    downloadStream.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        if (downloadedBytes > MAX_FILE_SIZE && !isTooLarge) { isTooLarge = true; downloadStream.destroy(); writer.close(); reject(new Error("FILE_TOO_LARGE")); }
                    });
                    writer.on('close', resolve);
                    writer.on('error', reject);
                }).catch(err => { if (err.message !== "FILE_TOO_LARGE") throw err; });

                if (isTooLarge) { fs.rmSync(fileDir, { recursive: true, force: true }); return res.status(200).send(`<h2>🐘 Файл больше ${MAX_FILE_SIZE/1024/1024} МБ.</h2>`); }
            }

            console.log(`[PROXY] Файл скачан на сервер. Размер: ${(downloadedBytes/1024/1024).toFixed(2)} MB`);
            setTimeout(() => { try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch(e) {} }, 2 * 60 * 60 * 1000);

            if (downloadedBytes <= CHUNK_SIZE_MB * 1024 * 1024) {
                console.log(`[PROXY] Отдача файла напрямую клиенту.`);
                res.set('Content-Type', contentType);
                res.set('Content-Disposition', `attachment; filename="${fileName}"`);
                return fs.createReadStream(filePath).pipe(res);
            } else {
                console.log(`[PROXY] Файл больше ${CHUNK_SIZE_MB} МБ. Запущена упаковка в ZIP архив...`);
                const zipBaseName = safeName + '.zip';
                try { await execPromise(`cd "${fileDir}" && zip -s ${CHUNK_SIZE_MB}m "${zipBaseName}" "${safeName}"`); } 
                catch (zipErr) { 
                    console.error(`[PROXY ERROR] Ошибка создания ZIP:`, zipErr.message);
                    return res.status(500).send("Ошибка архивации"); 
                }
                
                fs.unlinkSync(filePath);
                const archiveParts = fs.readdirSync(fileDir).filter(f => f.startsWith(safeName + '.')).sort(); 
                
                console.log(`[PROXY] Архив создан успешно (${archiveParts.length} частей).`);

                let buttonsHtml = ''; let totalCompressedBytes = 0; 
                archiveParts.forEach((partName) => {
                    parsedTarget.searchParams.set('nf_fileId', fileId); parsedTarget.searchParams.set('nf_partName', partName);
                    const stat = fs.statSync(path.join(fileDir, partName)); totalCompressedBytes += stat.size; 
                    buttonsHtml += `<a href="${parsedTarget.toString()}" target="_blank" style="display:block; margin-bottom:10px; padding:12px; background:#1a73e8; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">📥 Скачать ${partName} <span style="font-weight:normal; font-size:12px;">(${(stat.size/1024/1024).toFixed(1)} МБ)</span></a>`;
                });

                const origMB = (downloadedBytes/1024/1024).toFixed(1); const compMB = (totalCompressedBytes/1024/1024).toFixed(1);
                let savingsHtml = downloadedBytes > totalCompressedBytes ? `<span style="color:#28a745; font-weight:bold;">Сжато до ${compMB} МБ (вы экономите ${((downloadedBytes - totalCompressedBytes)/1024/1024).toFixed(1)} МБ)</span>` : `Размер: ${compMB} МБ`;

                res.set('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(`<!DOCTYPE html><html><body style="background:#f0f2f5; display:flex; justify-content:center; padding:20px; font-family:sans-serif;"><div style="background:white; padding:25px; border-top:5px solid #1a73e8; border-radius:10px; text-align:center; width:100%; max-width:400px; box-shadow:0 4px 10px rgba(0,0,0,0.1);"><h2 style="margin-top:0;">📦 Объемный архив</h2><p style="font-size:14px; margin-bottom:5px;">Оригинал: ${origMB} МБ</p><p style="font-size:14px; margin-top:0; margin-bottom:15px;">${savingsHtml}</p>${buttonsHtml}</div></body></html>`);
            }
        }
    } catch (error) { 
        console.error(`[PROXY ERROR] Ошибка шлюза:`, error.message);
        res.status(500).send(`Ошибка шлюза: ${error.message}`); 
    }
});

app.listen(process.env.PORT || 8080);
        
