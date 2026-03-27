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
const { SocksProxyAgent } = require('socks-proxy-agent');

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
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || ""; // socks5://user:pass@ip:port

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
const origLog = console.log; console.log = function(...args) { origLog.apply(console, args); captureLog(util.format(...args)); };
const origErr = console.error; console.error = function(...args) { origErr.apply(console, args); captureLog("ERROR: " + util.format(...args)); };

console.log("[SYSTEM] Сервер запущен. Часовой пояс: Europe/Kyiv");

// ==========================================
// СИСТЕМА ПРОКСИРОВАНИЯ (SOCKS5)
// ==========================================
let useProxy = false;

function getAxiosConfig(extraConfig = {}) {
    const config = { ...extraConfig };
    if (useProxy && SOCKS5_PROXY) {
        const agent = new SocksProxyAgent(SOCKS5_PROXY);
        config.httpAgent = agent;
        config.httpsAgent = agent;
    }
    return config;
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
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url; 
    else if (input && input.href) url = input.href; 

    if (url && url.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        const match = url.match(/models\/([^:]+)(?::generateContent|:streamGenerateContent)/);
        if (match && match[1]) {
            const modelId = match[1];
            if (response.status === 429) {
                try {
                    const clonedRes = response.clone();
                    const data = await clonedRes.json();
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
            const buffer = Buffer.from(req.body.b64, 'base64');
            const savePath = path.join(TMP_DIR, filename);
            fs.writeFileSync(savePath, buffer);
            console.log(`[UPLOAD] Файл сохранен на диск сервера: ${savePath}`);
            return res.json({ok: true, text: `✅ Файл <b>${filename}</b> загружен!<br>Путь: <code>${savePath}</code>`});
        } catch (err) { return res.status(500).json({ok: false, error: err.message}); }
    }

    let userText = req.body.text ? req.body.text.trim() : "";
    
    if (userText === '/help') {
        const respHtml = `🤖 <b>СИСТЕМА CHATOPS:</b><br><br>
<code>/status</code> — Состояние сервера<br>
<code>/limit</code> — Состояние моделей (Блокировки)<br>
<code>/logs</code> — Логи Northflank<br>
<code>/proxy on</code> | <code>/proxy off</code> — Управление SOCKS5 Proxy<br>
<code>/download [путь]</code> — Скачать файл (до 15 МБ)<br>
<code>/upload</code> — Загрузить файл<br>
<code>/search [запрос]</code> — Поиск в сети (поддерживает <i>site:</i> и <i>filetype:</i>)<br>
<code>/search download:[url]</code> — Прямая загрузка файла<br><br>
💻 <b>Терминал:</b><br>
<code>! [команда]</code> — Консоль Linux<br>
<i>Пример: <code>!ls -la /tmp</code></i>`;
        return res.json({ ok: true, text: respHtml });
    }

    // --- УПРАВЛЕНИЕ PROXY ---
    if (userText === '/proxy on') {
        if (!SOCKS5_PROXY) return res.json({ok: true, text: "❌ Переменная SOCKS5_PROXY не настроена в Northflank."});
        useProxy = true;
        console.log("[PROXY] Включен обход блокировок через внешний сервер.");
        return res.json({ok: true, text: "🚀 <b>Proxy включен!</b><br>Веб-парсинг и скачивание теперь идут через твой внешний сервер."});
    }

    if (userText === '/proxy off') {
        useProxy = false;
        console.log("[PROXY] Отключен. Трафик идет напрямую с Northflank.");
        return res.json({ok: true, text: "🛑 <b>Proxy выключен.</b><br>Запросы идут через родной IP дата-центра."});
    }

    if (userText === '/limit') {
        if (Object.keys(geminiLimits).length === 0) {
            return res.json({ ok: true, text: `📊 <b>Состояние API-моделей:</b><br><br>Google больше не передает остаток лимитов заранее. Сервер узнает точный лимит только при достижении потолка (ошибке 429). Сделайте запрос к ИИ, чтобы начать отслеживание статуса.` });
        }
        let tableHtml = `<table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:5px; background:#fff; color:#333;"><tr style="background:#1a73e8; color:white;"><th style="padding:4px; border:1px solid #ccc;">Модель</th><th style="padding:4px; border:1px solid #ccc;">Статус</th><th style="padding:4px; border:1px solid #ccc;">Макс.</th><th style="padding:4px; border:1px solid #ccc;">Сброс</th><th style="padding:4px; border:1px solid #ccc;">Обновлено</th></tr>`;
        for (const [model, data] of Object.entries(geminiLimits)) {
            const statusColor = data.status === 'OK' ? '#28a745' : '#dc3545'; 
            tableHtml += `<tr><td style="padding:4px; border:1px solid #ccc; font-weight:bold;">${model}</td><td style="padding:4px; border:1px solid #ccc; text-align:center; font-weight:bold; color:${statusColor};">${data.status}</td><td style="padding:4px; border:1px solid #ccc; text-align:center;">${data.limit}</td><td style="padding:4px; border:1px solid #ccc; text-align:center;">${data.reset}</td><td style="padding:4px; border:1px solid #ccc; text-align:center; color:#666;">${data.lastUpdated}</td></tr>`;
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
        return res.json({ ok: true, text: `🖥 <b>Логи Northflank:</b><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#e0e0e0; color:#333; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${logsHtml}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#999; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>` });
    }
    
    if (userText === '/status') {
        const mem = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        return res.json({ ok: true, text: `🖥 <b>Статус контейнера:</b><br>⏱ Uptime: <b>${hours}ч ${mins}м</b><br>💾 Память (RSS): <b>${(mem.rss / 1024 / 1024).toFixed(1)} MB</b><br>🔒 Proxy: <b>${useProxy ? '<span style="color:green">ВКЛЮЧЕН</span>' : '<span style="color:red">ВЫКЛЮЧЕН</span>'}</b><br>🧠 Контекст ИИ: <b>${geminiHistory.length} сообщений</b>` });
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
            return res.json({ ok: true, text: `<b>$</b> <code>${cmd}</code><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#1e1e1e; color:#00ff00; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${output}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#555; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>` });
        } catch (err) {
            console.error(`[CHATOPS] Ошибка выполнения: ${cmd}`, err.message);
            return res.json({ ok: true, text: `<b>$</b> <code>${cmd}</code><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#3b1313; color:#ff6b6b; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${err.message}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#773333; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>` });
        }
    }

    // ==========================================
    // ВЕБ-ПОИСК И ЗАГРУЗКА
    // ==========================================
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

                // ИСПОЛЬЗУЕМ SOCKS5 PROXY ЕСЛИ ОН ВКЛЮЧЕН
                const response = await axios.get(dlUrl, getAxiosConfig({ 
                    responseType: 'stream', 
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
                    timeout: 60000
                }));
                
                const writer = fs.createWriteStream(savePath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                
                const stat = fs.statSync(savePath);
                searchResultsText = `✅ Файл успешно скачан!\n📁 Путь: ${savePath}\n📦 Размер: ${(stat.size/1024).toFixed(1)} KB`;
            } else {
                if (!TAVILY_API_KEY) throw new Error("Не настроен TAVILY_API_KEY.");
                let apiQuery = query; let includeDomains = [];
                const siteMatch = apiQuery.match(/(?:^|\s)site:([^\s]+)/i);
                if (siteMatch) { includeDomains.push(siteMatch[1]); apiQuery = apiQuery.replace(/(?:^|\s)site:([^\s]+)/i, '').trim(); }
                const ftMatch = apiQuery.match(/(?:^|\s)filetype:([a-z0-9]+)/i);
                if (ftMatch) { apiQuery = apiQuery.replace(/(?:^|\s)filetype:([a-z0-9]+)/i, '').trim(); apiQuery += ` (file document ${ftMatch[1]})`; }
                if (!apiQuery) apiQuery = "index";

                const requestBody = { api_key: TAVILY_API_KEY, query: apiQuery, max_results: 6, search_depth: "basic" };
                if (includeDomains.length > 0) requestBody.include_domains = includeDomains;

                const response = await axios.post('https://api.tavily.com/search', requestBody);
                if (response.data && response.data.results && response.data.results.length > 0) {
                    let results = response.data.results.map((r, i) => `[${i+1}] ${r.title}\n${r.content}\nСсылка: ${r.url}`);
                    searchResultsText = `Результаты:\n\n${results.join('\n\n')}`;
                } else {
                    searchResultsText = `По запросу «${query}» ничего не найдено.`;
                }
            }
            userText = `Команда /search "${query}". Данные:\n\n${searchResultsText}\n\nПроанализируй и дай ответ.`;
        } catch (err) {
            userText = `Ошибка поиска "${query}": ${err.message}.`;
        }
    }

    if (!GEMINI_API_KEY) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY"});

    if (req.body.action === 'get_models') {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
            const response = await axios.get(url);
            const models = response.data.models.filter(m => m.supportedGenerationMethods.includes('generateContent')).map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }));
            return res.json({ ok: true, models: models });
        } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
    }

    if (req.body.clear === 'true') {
        geminiHistory = []; console.log("[GEMINI] Память очищена.");
        if (userText === 'clear') return res.json({ok: true, text: "История очищена"});
    }

    const modelName = req.body.model || "gemini-2.5-flash"; 
    const msgParts = [];
    if (userText) msgParts.push(userText);
    
    if (req.body.b64 && req.body.mimeType) {
        msgParts.push({ inlineData: { data: req.body.b64, mimeType: req.body.mimeType } });
    }

    if (msgParts.length === 0) return res.status(400).json({ok: false, error: "Пустой запрос"});

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
        return fs.createReadStream(nfDlPath).pipe(res);
    }

    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Укажите URL: ?url=https://example.com');

    let imgLim = req.query.img_limit !== undefined ? parseInt(req.query.img_limit) : 10;
    let userAgentStr = req.query.mobile_ua === 'true' 
        ? 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

    const parsedTarget = new URL.URL(targetUrl);
    const nfFileId = parsedTarget.searchParams.get('nf_fileId');
    const nfPartName = parsedTarget.searchParams.get('nf_partName');

    if (nfFileId && nfPartName) {
        const partPath = path.join(TMP_DIR, nfFileId, nfPartName);
        if (!fs.existsSync(partPath)) return res.status(404).send("Кэш истек.");
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${nfPartName}"`);
        res.set('Content-Length', fs.statSync(partPath).size);
        return fs.createReadStream(partPath).pipe(res);
    }

    try {
        // ИСПОЛЬЗУЕМ SOCKS5 PROXY ЕСЛИ ОН ВКЛЮЧЕН
        const response = await axios.get(targetUrl, getAxiosConfig({ 
            responseType: 'stream',
            headers: { 'User-Agent': userAgentStr, 'Accept': 'text/html,*/*;q=0.8', 'Cache-Control': 'no-cache' },
            timeout: 15000,
            validateStatus: () => true 
        }));
        
        if ([401, 403, 406, 429, 503].includes(response.status)) {
            console.warn(`[PROXY] Сайт заблокировал запрос (Код ${response.status})`);
            return res.status(200).send(`<!DOCTYPE html><html><body style="text-align:center; padding:40px;"><h2 style="color:#dc3545;">🚫 Защита от ботов (${response.status})</h2><p>Попробуйте включить Proxy командой <b>/proxy on</b> в чате с ИИ.</p></body></html>`);
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
                if (href) { try { const cssRes = await axios.get(href, getAxiosConfig({ timeout: 3000 })); $(stylesheets[i]).replaceWith(`<style>${cssRes.data}</style>`); } catch (e) {} }
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
                        const imgRes = await axios.get(src, getAxiosConfig({ responseType: 'arraybuffer', timeout: 3500 }));
                        img.attr('src', `data:${imgRes.headers['content-type']};base64,${Buffer.from(imgRes.data, 'binary').toString('base64')}`);
                        img.removeAttr('srcset').removeAttr('data-src').removeAttr('loading'); 
                    } catch (e) {}
                }
            }
            
            if (req.query.nf_dl_html === 'true') {
                $('head').prepend(`<base href="${parsedTarget.origin}">`);
                res.set('Content-Type', 'application/octet-stream'); 
                res.set('Content-Disposition', `attachment; filename="page_${parsedTarget.hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}.html"`);
                return res.send($.html());
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
                const archiveParts = fs.readdirSync(fileDir).filter(f => f.startsWith(safeName + '.')).sort(); 
                
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
        res.status(500).send(`Ошибка шлюза: ${error.message}`); 
    }
});

app.listen(process.env.PORT || 8080);
                                           
