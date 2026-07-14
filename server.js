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
const cron = require('node-cron');

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
let geminiHistory = [];          // история обычного чата
let adminMode = false;
let adminHistory = [];           // отдельная история для режима администратора

if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}


async function getCronPattern(humanText) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent("Переведи фразу на cron-pattern (5 звезд) и верни только строку, например '* * * * *'. Фраза: " + humanText);
    let pattern = result.response.text().trim();
    if (!cron.validate(pattern)) return "* * * * *"; // fallback
    return pattern;
}

// ==========================================
// СИСТЕМА ОЧЕРЕДИ ДЛЯ CRON-ЗАДАЧ (INBOX)
// ==========================================
const MESSAGES_FILE = path.join(TMP_DIR, 'inbox.json');
const JOBS_FILE = path.join(TMP_DIR, 'scheduled_jobs.json');
let messageInbox = [];
let scheduledJobs = []; // список активных задач { id, pattern, taskText, model }

if (fs.existsSync(MESSAGES_FILE)) {
    try { messageInbox = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); } catch(e){}
}
if (fs.existsSync(JOBS_FILE)) {
    try { scheduledJobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch(e){}
}

function saveInbox() {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messageInbox, null, 2));
}

function saveJobs() {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(scheduledJobs.map(j => ({
        id: j.id,
        pattern: j.pattern,
        taskText: j.taskText,
        model: j.model,
        createdAt: j.createdAt
    })), null, 2));
}

function addMessageToInbox(msgText) {
    messageInbox.push({
        time: getKyivTime(),
        text: msgText
    });
    saveInbox();
}

// Карта для хранения активных объектов cron-задач (чтобы иметь возможность их останавливать)
const activeCronTasks = {};

// Функция для инициализации/запуска cron-задачи в памяти
function startCronTask(job) {
    if (activeCronTasks[job.id]) {
        activeCronTasks[job.id].stop();
    }
    const task = cron.schedule(job.pattern, async () => {
        console.log(`[CRON JOB ${job.id}] Запуск фонового выполнения...`);
        try {
            if (!GEMINI_API_KEY) {
                addMessageToInbox(`[Ошибка задачи ${job.id}]: Отсутствует GEMINI_API_KEY`);
                return;
            }
            const modelName = job.model || "gemini-2.5-flash";
            const modelConfig = { model: modelName };
            modelConfig.systemInstruction = "Ты полезный администратор сервера. Ты можешь выполнять команды терминала Linux и искать информацию в интернете. Проанализируй запрос пользователя, при необходимости используй инструменты, чтобы выполнить задачу. После каждого вызова функции дождись результата и прими решение о следующем шаге. Когда задача будет выполнена, дай окончательный текстовый ответ. В ответе обязательно перечисли выполненные тобой команды терминала и их результаты.";
            
            const model = genAI.getGenerativeModel(modelConfig);
            // Создаем отдельный независимый чат для этой задачи с инструментами терминала и поиска
            const tools = [{
                functionDeclarations: [
                    {
                        name: "exec_command",
                        description: "Execute a shell command and return stdout and stderr.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                command: { type: "STRING", description: "The shell command to execute." }
                            },
                            required: ["command"]
                        }
                    },
                    {
                        name: "search_web",
                        description: "Search the web using Tavily API or download a file directly. Use 'query' for search, or 'download' with a URL to download a file.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                action: { type: "STRING", enum: ["search", "download"], description: "Search the web or download." },
                                query: { type: "STRING", description: "Search query" },
                                url: { type: "STRING", description: "URL to download" }
                            },
                            required: ["action"]
                        }
                    }
                ]
            }];

            const chat = model.startChat({ history: [], tools: tools });
            const executedCommands = [];
            let result = await chat.sendMessage(job.taskText);
            let iterations = 0;
            const maxIterations = 10;

            while (result.response && result.response.candidates && result.response.candidates[0]) {
                const candidate = result.response.candidates[0];
                const parts = candidate.content.parts;
                const functionCall = parts.find(part => part.functionCall);
                
                if (functionCall) {
                    const call = functionCall.functionCall;
                    if (call.name === "exec_command") {
                        const cmd = call.args.command;
                        let execResult;
                        try {
                            const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });
                            execResult = stdout;
                            if (stderr) execResult += '\n[STDERR]: ' + stderr;
                            if (!execResult.trim()) execResult = "[Команда выполнена успешно, вывод пуст]";
                        } catch (err) {
                            execResult = `Ошибка: ${err.message}`;
                        }
                        executedCommands.push({ command: cmd, result: execResult });
                        const funcResponse = { name: call.name, response: { result: execResult } };
                        result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                    } else if (call.name === "search_web") {
                        const action = call.args.action;
                        let searchResult = "";
                        try {
                            if (action === "search") {
                                const query = call.args.query;
                                const requestBody = { api_key: TAVILY_API_KEY, query: query, max_results: 5, search_depth: "basic" };
                                const tavRes = await axios.post('https://api.tavily.com/search', requestBody);
                                if (tavRes.data && tavRes.data.results) {
                                    searchResult = tavRes.data.results.map((r, i) => `[${i+1}] ${r.title}\n${r.content}\n${r.url}`).join('\n\n');
                                } else { searchResult = "Ничего не найдено."; }
                            }
                        } catch (err) {
                            searchResult = `Ошибка поиска: ${err.message}`;
                        }
                        const funcResponse = { name: call.name, response: { result: searchResult } };
                        result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                    } else if (call.name === "search_web" && action === "download") {
                        const url = call.args.url;
                        const filename = (path.basename(url) || `dl_${Date.now()}`).replace(/[^a-zA-Z0-9.-_]/g, '_');
                        const savePath = path.join(TMP_DIR, filename);
                        try {
                            const response = await axios.get(url, { responseType: 'stream', timeout: 30000 });
                            const writer = fs.createWriteStream(savePath);
                            response.data.pipe(writer);
                            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                            searchResult = `Файл успешно скачан: ${savePath}`;
                        } catch (e) { searchResult = `Ошибка скачивания: ${e.message}`; }
                        const funcResponse = { name: call.name, response: { result: searchResult } };
                        result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                    } else { break; }
                } else {
                    let finalText = parts.map(p => p.text).join('');
                    if (executedCommands.length > 0) {
                        finalText += `\n\n<details><summary>📋 <b>Фоновый терминал</b> (нажмите, чтобы развернуть)</summary>\n`;
                        executedCommands.forEach((cmd, index) => {
                            finalText += `\n${index + 1}. <code>${cmd.command}</code>\n   ↳ ${cmd.result}`;
                        });
                        finalText += `\n</details>`;
                    }
                    addMessageToInbox(`<b>Задача ${job.id} выполнена!</b><br>Запрос: <i>${job.taskText}</i><br><br>${finalText}`);
                    return;
                }
                iterations++;
                if (iterations >= maxIterations) {
                    addMessageToInbox(`⚠️ <b>Задача ${job.id} прервана:</b> Достигнут лимит итераций.\nЗапрос: <i>${job.taskText}</i>`);
                    return;
                }
            }
        } catch (jobErr) {
            console.error(`[CRON JOB ERROR ${job.id}]`, jobErr.message);
            addMessageToInbox(`❌ <b>Ошибка в задаче ${job.id}:</b> ${jobErr.message}`);
        }
    });
    activeCronTasks[job.id] = task;
}

// Функция для инициализации всех сохраненных задач при старте сервера
function initAllCronJobs() {
    console.log(`[CRON] Инициализация сохраненных задач: ${scheduledJobs.length}`);
    scheduledJobs.forEach(job => {
        startCronTask(job);
    });
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

    // Проверяем входящие накопленные ответы от отработавших cron-задач
    let cronNotificationsHtml = "";
    if (messageInbox.length > 0) {
        cronNotificationsHtml = '<div style="background:#fff3cd; border-left:5px solid #ffc107; padding:12px; margin-bottom:15px; border-radius:6px; font-size:12px; color:#856404; max-height: 400px; overflow-y: auto;"><b>🔔 Результаты фоновых задач планировщика:</b><br>' + messageInbox.map(m => `⏰ [${m.time} Kyiv]: ${m.text}`).join('<hr style="border:0; border-top:1px solid #ffeeba; margin:10px 0;">') + '</div>';
        messageInbox = [];
        fs.writeFileSync(MESSAGES_FILE, '[]');
    }

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

    if (req.body.action === 'get_models') {
        try {
            console.log("[GEMINI] Запрос списка доступных моделей...");
            const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
            const models = response.data.models
                .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
                .map(m => {
                    let cleanId = m.name.replace('models/', '');
                    let cleanName = m.displayName ? m.displayName.replace('models/', '') : cleanId;
                    return { id: cleanId, name: cleanName };
                });
            console.log(`[GEMINI] Успешно загружено ${models.length} моделей.`);
            return res.json({ ok: true, models: models });
        } catch (err) {
            console.error("[GEMINI ERROR] Сбой загрузки списка моделей:", err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    let userText = req.body.text ? req.body.text.trim() : "";

    if (userText.startsWith('/task ')) {
        const parts = userText.substring(10).trim().split(' ');
        if (parts.length < 6) {
            return res.json({ ok: true, text: "❌ Некорректный синтаксис. Шаблон: <code>/task * * * * * Текст задачи для ИИ</code>" });
        }
        const pattern = parts.slice(0, 5).join(' ');
        const taskText = parts.slice(5).join(' ').trim();
        
        if (!cron.validate(pattern)) {
            return res.json({ ok: true, text: "❌ Невалидный cron-pattern: <code>" + pattern + "</code>" });
        }
        
        const jobId = 'job_' + Date.now();
        const newJob = {
            id: jobId,
            pattern: pattern,
            taskText: taskText,
            model: req.body.model || "gemini-2.5-flash",
            createdAt: getKyivTime()
        };
        
        scheduledJobs.push(newJob);
        saveJobs();
        startCronTask(newJob);
        
        return res.json({ ok: true, text: `✅ <b>Задача планировщика создана!</b><br>ID: <code>${jobId}</code><br>Расписание: <code>${pattern}</code><br>Задача: <i>${taskText}</i><br><br>ИИ выполнит её в фоновом режиме и сохранит результат во входящие.` });
    }

    if (userText === '/jobs') {
        if (scheduledJobs.length === 0) {
            return res.json({ ok: true, text: "📝 Активных фоновых задач планировщика нет." });
        }
        let jobsListHtml = "📝 <b>Активные фоновые задачи:</b><br><br>";
        scheduledJobs.forEach(j => {
            jobsListHtml += `🆔 ID: <code>${j.id}</code> (Создана: ${j.createdAt})<br>⏰ Расписание: <code>${j.pattern}</code><br>🎯 Задача: <i>${j.taskText}</i><hr style="border:0; border-top:1px solid #ccc; margin:8px 0;">`;
        });
        return res.json({ ok: true, text: jobsListHtml });
    }

    if (userText === '/clear_jobs') {
        scheduledJobs.forEach(j => {
            if (activeCronTasks[j.id]) {
                activeCronTasks[j.id].stop();
                delete activeCronTasks[j.id];
            }
        });
        scheduledJobs = [];
        saveJobs();
        return res.json({ ok: true, text: "🧹 <b>Все фоновые cron-задачи удалены!</b>" });
    }

    if (userText === '/help') {
        const respHtml = `🤖 <b>СИСТЕМА CHATOPS (с поддержкой фонового планировщика):</b><br><br>
<code>/task [cron-pattern] [текст запроса]</code> — Запланировать автономную задачу для ИИ (пример: <code>/task */5 * * * * Какая цена BTC сейчас?</code>)<br>
<code>/jobs</code> — Список активных задач планировщика<br>
<code>/clear_jobs</code> — Удалить все активные фоновые задачи<br><br>
<code>/status</code> — Состояние сервера<br>
<code>/limit</code> — Состояние моделей<br>
<code>/logs</code> — Логи Northflank<br>
<code>/proxy on</code> | <code>/proxy off</code> — Ghost Proxy (curl-impersonate локальный)<br>
<code>/download [путь]</code> — Скачать файл (до 15 МБ)<br>
<code>/upload</code> — Загрузить файл на сервер<br>
<code>/search [запрос]</code> — Поиск в сети с помощью Tavily API<br>
<code>/search download:[url]</code> — Прямая загрузка файла<br>
<code>/admin on</code> — Включить режим администратора (автовыполнение команд)<br>
<code>/admin off</code> — Выключить режим администратора<br><br>
💻 <b>Терминал:</b><br>
<i>Путь контейнера: <code>/usr/src/app</code></i><br>
<code>! [команда]</code> — Консоль Linux<br>
<i>Пример: <code>!ls -la /tmp</code></i>`;
        return res.json({ ok: true, text: respHtml });
    }

    // Режим администратора
    if (userText === '/admin on') {
        adminMode = true;
        adminHistory = [];   // сбрасываем историю при включении
        console.log("[ADMIN] Режим администратора ВКЛЮЧЕН.");
        return res.json({ ok: true, text: "🔧 <b>Режим администратора активирован.</b> Все последующие сообщения будут выполняться как автономные задачи с доступом к терминалу и поиску в интернете." });
    }
    if (userText === '/admin off') {
        adminMode = false;
        adminHistory = [];   // очищаем контекст
        console.log("[ADMIN] Режим администратора ОТКЛЮЧЕН.");
        return res.json({ ok: true, text: "🛑 <b>Режим администратора отключен.</b>" });
    }

    if (userText === '/proxy on') {
        if (!SOCKS5_PROXY) return res.json({ok: true, text: "❌ Переменная SOCKS5_PROXY не настроена."});
        useProxy = true;
        
        const curlDir = path.join(__dirname, 'curl-impersonate');
        const curlBin = path.join(curlDir, 'curl_chrome116');
        
        if (!fs.existsSync(curlBin)) {
            console.error("[PROXY ERROR] Папка curl-impersonate не найдена!");
            return res.json({ok: true, text: `❌ Ошибка: Не найдена локальная папка curl-impersonate.`});
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

    // ---------- ОБНОВЛЁННЫЙ /status ----------
    if (userText === '/status') {
        const mem = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        const adminStatus = adminMode
            ? '<span style="color:green; font-weight:bold;">✅ ВКЛЮЧЕН</span>'
            : '<span style="color:red;">❌ ВЫКЛЮЧЕН</span>';
        const adminCtx = adminMode ? `<br>🧠 Контекст админа: <b>${adminHistory.length} сообщений</b>` : '';
        return res.json({ ok: true, text: `🖥 <b>Статус:</b><br>⏱ Uptime: <b>${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м</b><br>💾 Память: <b>${(mem.rss / 1024 / 1024).toFixed(1)} MB</b><br>🔒 Ghost Proxy: <b>${useProxy ? '<span style="color:green">ВКЛЮЧЕН</span>' : '<span style="color:red">ВЫКЛЮЧЕН</span>'}</b><br>🔧 Режим администратора: ${adminStatus}${adminCtx}<br>🧠 Контекст обычного чата: <b>${geminiHistory.length} сообщений</b>` });
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
                    const shellExec = fs.existsSync('/bin/bash') ? 'bash' : 'sh';
                    await execPromise(`${shellExec} "${curlBin}" --compressed -m 60 -s -L -x "${proxyStr}" -o "${savePath}" "${dlUrl}"`);
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
        adminHistory = [];   // заодно чистим админский контекст
        console.log("[GEMINI] Память контекста нейросети очищена.");
        if (userText === 'clear') return res.json({ok: true, text: "История очищена"});
    }

    // Если включён режим администратора и сообщение не начинается со служебного символа,
    // передаём управление автономному агенту
    if (adminMode && userText && !userText.startsWith('/') && !userText.startsWith('!')) {
        return handleAdminMessage(userText, req, res);
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
        const aiText = result.response.text();
        return res.json({ ok: true, text: cronNotificationsHtml ? cronNotificationsHtml + '<br>' + aiText : aiText });
    } catch (err) {
        console.error("[GEMINI ERROR]", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ==========================================
// АВТОНОМНЫЙ АДМИНИСТРАТОР С ИНСТРУМЕНТАМИ
// ==========================================
async function handleAdminMessage(userText, req, res) {
    if (!GEMINI_API_KEY) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY"});

    const preferredModel = req.body.model || "gemini-2.5-flash";
    const isGemma = preferredModel.toLowerCase().includes('gemma');

    const modelConfig = { model: preferredModel };
    if (!isGemma) {
        modelConfig.systemInstruction = "Ты полезный администратор сервера. Ты можешь выполнять команды терминала Linux и искать информацию в интернете. Проанализируй запрос пользователя, при необходимости используй инструменты, чтобы выполнить задачу. После каждого вызова функции дождись результата и прими решение о следующем шаге. Когда задача будет выполнена, дай окончательный текстовый ответ. В ответе обязательно перечисли выполненные тобой команды терминала и их результаты.";
    }

    const model = genAI.getGenerativeModel(modelConfig);
    const tools = [{
        functionDeclarations: [
            {
                name: "exec_command",
                description: "Execute a shell command and return stdout and stderr.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        command: {
                            type: "STRING",
                            description: "The shell command to execute."
                        }
                    },
                    required: ["command"]
                }
            },
            {
                name: "search_web",
                description: "Search the web using Tavily API or download a file directly. Use 'query' for search, or 'download' with a URL to download a file.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: {
                            type: "STRING",
                            enum: ["search", "download"],
                            description: "Search the web for information or download a file from URL."
                        },
                        query: {
                            type: "STRING",
                            description: "Search query (required for action=search)"
                        },
                        url: {
                            type: "STRING",
                            description: "URL to download (required for action=download)"
                        }
                    },
                    required: ["action"]
                }
            }
        ]
    }];

    // Используем сохранённую историю администратора
    const chat = model.startChat({ history: adminHistory, tools: tools });
    const executedCommands = [];

    let iterations = 0;
    const maxIterations = 10;

    try {
        let result = await chat.sendMessage(userText);
        while (result.response && result.response.candidates && result.response.candidates[0]) {
            const candidate = result.response.candidates[0];
            const parts = candidate.content.parts;
            
            const functionCall = parts.find(part => part.functionCall);
            if (functionCall) {
                const call = functionCall.functionCall;
                if (call.name === "exec_command") {
                    const cmd = call.args.command;
                    console.log(`[ADMIN] Выполнение команды: ${cmd}`);
                    let execResult;
                    try {
                        const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });
                        execResult = stdout;
                        if (stderr) execResult += '\n[STDERR]: ' + stderr;
                        if (!execResult.trim()) execResult = "[Команда выполнена успешно, вывод пуст]";
                    } catch (err) {
                        execResult = `Ошибка: ${err.message}`;
                    }
                    executedCommands.push({ command: cmd, result: execResult });
                    console.log(`[ADMIN] Результат: ${execResult.substring(0, 200)}`);
                    const funcResponse = {
                        name: call.name,
                        response: { result: execResult }
                    };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else if (call.name === "search_web") {
                    const action = call.args.action;
                    console.log(`[ADMIN] Поиск/загрузка: action=${action}`);
                    let searchResult = "";
                    try {
                        if (action === "search") {
                            const query = call.args.query;
                            if (!query) throw new Error("No query provided");
                            if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY not set");
                            const requestBody = { api_key: TAVILY_API_KEY, query: query, max_results: 5, search_depth: "basic" };
                            const tavRes = await axios.post('https://api.tavily.com/search', requestBody);
                            if (tavRes.data && tavRes.data.results) {
                                searchResult = tavRes.data.results.map((r, i) => `[${i+1}] ${r.title}\n${r.content}\n${r.url}`).join('\n\n');
                            } else {
                                searchResult = "Ничего не найдено.";
                            }
                        } else if (action === "download") {
                            const url = call.args.url;
                            if (!url) throw new Error("No URL provided");
                            const parsed = new URL.URL(url);
                            const filename = (path.basename(parsed.pathname) || `dl_${Date.now()}`).replace(/[^a-zA-Z0-9.\-_]/g, '_');
                            const savePath = path.join(TMP_DIR, filename);
                            
                            if (useProxy && SOCKS5_PROXY) {
                                const curlBin = path.join(__dirname, 'curl-impersonate', 'curl_chrome116');
                                const proxyStr = SOCKS5_PROXY.replace('socks5://', 'socks5h://');
                                const shell = fs.existsSync('/bin/bash') ? 'bash' : 'sh';
                                await execPromise(`${shell} "${curlBin}" --compressed -m 60 -s -L -x "${proxyStr}" -o "${savePath}" "${url}"`);
                            } else {
                                const response = await axios.get(url, { responseType: 'stream', headers: getBrowserHeaders(false), timeout: 60000 });
                                const writer = fs.createWriteStream(savePath);
                                response.data.pipe(writer);
                                await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                            }
                            const stat = fs.statSync(savePath);
                            searchResult = `Файл загружен: ${savePath} (${(stat.size/1024).toFixed(1)} KB)`;
                        }
                    } catch (err) {
                        searchResult = `Ошибка поиска/загрузки: ${err.message}`;
                    }
                    console.log(`[ADMIN] Результат операции: ${searchResult.substring(0, 200)}`);
                    const funcResponse = {
                        name: call.name,
                        response: { result: searchResult }
                    };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else {
                    console.log("[ADMIN] Неизвестная функция:", call.name);
                    break;
                }
            } else {
                // Финальный ответ
                let finalText = parts.map(p => p.text).join('');
                if (executedCommands.length > 0) {
                    finalText += `\n\n<details><summary>📋 <b>Терминал</b> (нажмите, чтобы развернуть)</summary>\n`;
                    executedCommands.forEach((cmd, index) => {
                        finalText += `\n${index + 1}. <code>${cmd.command}</code>\n   ↳ ${cmd.result}`;
                    });
                    finalText += `\n</details>`;
                }
                // Сохраняем обновлённую историю
                adminHistory = await chat.getHistory();
                console.log(`[ADMIN] Финальный ответ. Контекст админа теперь: ${adminHistory.length} сообщений`);
                // Подмешиваем уведомления в режиме админа
                let finalResponseText = finalText;
                if (cronNotificationsHtml) {
                    finalResponseText = cronNotificationsHtml + '<br>' + finalResponseText;
                }
                return res.json({ ok: true, text: finalResponseText });
            }
            iterations++;
            if (iterations >= maxIterations) {
                console.log("[ADMIN] Достигнут лимит итераций.");
                let limitText = "⚠️ Достигнут лимит операций. Завершаю работу.";
                if (executedCommands.length > 0) {
                    limitText += `\n\n<details><summary>📋 <b>Терминал</b> (нажмите, чтобы развернуть)</summary>\n`;
                    executedCommands.forEach((cmd, index) => {
                        limitText += `\n${index + 1}. <code>${cmd.command}</code>\n   ↳ ${cmd.result}`;
                    });
                    limitText += `\n</details>`;
                }
                adminHistory = await chat.getHistory();
                return res.json({ ok: true, text: limitText });
            }
        }
        adminHistory = await chat.getHistory();
        return res.json({ ok: true, text: "Не удалось получить ответ от ИИ." });
    } catch (err) {
        console.error("[ADMIN ERROR]", err.message);
        let errorText = `Ошибка: ${err.message}`;
        if (executedCommands.length > 0) {
            errorText += `\n\n<details><summary>📋 <b>Выполненные команды до ошибки</b> (нажмите, чтобы развернуть)</summary>\n`;
            executedCommands.forEach((cmd, index) => {
                errorText += `\n${index + 1}. <code>${cmd.command}</code>\n   ↳ ${cmd.result}`;
            });
            errorText += `\n</details>`;
        }
        // Попытаемся сохранить историю даже при ошибке
        try { adminHistory = await chat.getHistory(); } catch (e) {}
        return res.status(500).json({ ok: false, error: errorText });
    }
}

// ==========================================
// ОСНОВНОЙ ПРОКСИ (без изменений)
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
        const requestUseProxy = useProxy || req.query.socks === 'true';
        if (requestUseProxy && SOCKS5_PROXY) {
            console.log(`[PROXY] Использование Ghost Proxy (локальный curl-impersonate)...`);
            const reqId = crypto.randomUUID();
            const headFile = path.join(TMP_DIR, `${reqId}_head.txt`);
            const bodyFile = path.join(TMP_DIR, `${reqId}_body.bin`);
            const curlBin = path.join(__dirname, 'curl-impersonate', 'curl_chrome116');
            const proxyStr = SOCKS5_PROXY.replace('socks5://', 'socks5h://');
            
            const shellExec = fs.existsSync('/bin/bash') ? 'bash' : 'sh';
            await execPromise(`${shellExec} "${curlBin}" --compressed -m 15 -s -L -x "${proxyStr}" -D "${headFile}" -o "${bodyFile}" "${targetUrl}"`);
            
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

// ==========================================
// ИНИЦИАЛИЗАЦИЯ И ЗАПУСК СЕРВЕРА
// ==========================================
async function startServer() {
    console.log("[SYSTEM] Проверка окружения перед запуском...");
    try {
        const curlDir = path.join(__dirname, 'curl-impersonate');
        const curlBin = path.join(curlDir, 'curl_chrome116');
        if (fs.existsSync(curlBin)) {
            fs.chmodSync(curlBin, 0o755);
            if (fs.existsSync(path.join(curlDir, 'curl-impersonate-chrome'))) {
                fs.chmodSync(path.join(curlDir, 'curl-impersonate-chrome'), 0o755);
            }
            console.log("[SYSTEM] Права файлов curl-impersonate настроены.");
        }
        
        if (fs.existsSync('/etc/os-release')) {
            const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
            if (osRelease.includes('Alpine')) {
                console.log("[SYSTEM] Обнаружен Alpine Linux. Установка зависимостей (bash, zip, gcompat)...");
                await execPromise(`apk add --no-cache bash gcompat libc6-compat zip`);
                console.log("[SYSTEM] Зависимости Alpine успешно установлены.");
            }
        }
    } catch (e) {
        console.warn("[SYSTEM WARNING] Ошибка инициализации:", e.message);
    }

    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`[SYSTEM] Сервер успешно запущен на порту ${PORT}`);
        // Запускаем сохраненные cron-задачи
        initAllCronJobs();
    });
}

startServer();
