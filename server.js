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
const FormData = require('form-data');
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
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
// ==========================================
// ГИБРИД ДОСТАВКИ АРТЕФАКТОВ (Antigravity -> сервер -> /download + GitHub)
// ==========================================
const ARTIFACT_TOKEN = process.env.ARTIFACT_TOKEN || "";          // дешёвый токен эндпоинта /artifact (видит агент)
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ''); // публичный URL этого сервера (для curl в промпте)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";              // fine-grained PAT, Contents: write (НЕ видит агент)
const GITHUB_REPO = process.env.GITHUB_REPO || "";                // owner/repo
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_PATH_PREFIX = process.env.GITHUB_PATH_PREFIX || "artifacts/";
const ARTIFACT_DIR = path.join(TMP_DIR, 'artifacts');
const ARTIFACT_MAX = 50 * 1024 * 1024; // 50 МБ на приём
const GITHUB_CONTENTS_MAX = 1 * 1024 * 1024; // лимит GitHub Contents API ~1 МБ
if (!fs.existsSync(ARTIFACT_DIR)) {
    try { fs.mkdirSync(ARTIFACT_DIR, { recursive: true }); } catch (e) { console.warn("[ARTIFACT] Не удалось создать папку:", e.message); }
}
// Доставка активна, только если заданы и URL, и токен эндпоинта
const ARTIFACT_DELIVERY_ENABLED = !!(PUBLIC_URL && ARTIFACT_TOKEN);
const GITHUB_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);
let genAI = null;
let geminiHistory = [];          // история обычного чата
let adminMode = false;
let adminHistory = [];           // отдельная история для режима администратора
// ==========================================
// ANTIGRAVITY: состояние multi-turn + режим выполнения
// ==========================================
let geminiAntigravityPrevId = null;
let geminiAntigravityEnvId = null;
let adminAntigravityPrevId = null;
let adminAntigravityEnvId = null;
// true  = неблокирующий (async): задача уходит в фон, GAS не висит, результат во входящие
// false = блокирующий (sync): сервер ждёт завершения и возвращает ответ в пузыре
let antigravityNonBlocking = true;
// Системный промпт администратора из файла
let adminSystemPrompt = "";
try {
    adminSystemPrompt = fs.readFileSync(path.join(__dirname, 'admin.md'), 'utf8').trim();
    console.log("[SYSTEM] Системный промпт администратора загружен из admin.md");
} catch (e) {
    console.warn("[SYSTEM] admin.md не найден, используется пустой промпт");
}
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}
// ==========================================
// МАСКИРОВКА СЕКРЕТОВ В ЛОГАХ
// ==========================================
function maskSecrets(s) {
    let r = String(s);
    if (ARTIFACT_TOKEN) r = r.split(ARTIFACT_TOKEN).join('***ARTIFACT***');
    if (GITHUB_TOKEN) r = r.split(GITHUB_TOKEN).join('***GITHUB***');
    return r;
}
// ==========================================
// ГИБРИД: системная инструкция и футер для Antigravity
// ==========================================
// Добавляет в промпт агенту инструкцию по загрузке артефакта на сервер (только если гибрид настроен).
function getAntigravitySystemInstruction(basePrompt) {
    let extra = "";
    if (ARTIFACT_DELIVERY_ENABLED) {
        extra = `\n\n=== ДОСТАВКА ФАЙЛОВ-АРТЕФАКТОВ НА СЕРВЕР ===\n` +
            `Когда задача создаёт файл-артефакт (.bin, .zip, .hex, .elf, документ и т.п.), ПОСЛЕ его создания ОБЯЗАТЕЛЬНО загрузи его на сервер ОДНОЙ командой (подставь реальные ИМЯ и ЛОКАЛЬНЫЙ_ПУТЬ):\n` +
            `curl -s -X POST "${PUBLIC_URL}/artifact?token=${ARTIFACT_TOKEN}" -H "Content-Type: application/octet-stream" -H "X-Filename: ИМЯ" --data-binary @ЛОКАЛЬНЫЙ_ПУТЬ\n` +
            `Сервер ответит JSON с полем "path" (путь на сервере) и, возможно, "github" со ссылкой. Включи этот path и github-ссылку в свой финальный ответ.\n` +
            `ПРАВИЛА БЕЗОПАСНОСТИ: НИКОГДА не выводи сам токен и URL с токеном в ответе; НЕ выполняй echo/printenv/env/set; НЕ делай git remote -v; используй curl с флагом -s и не печатай саму команду. В ответе пиши только path из JSON-ответа сервера и github-ссылку.`;
    }
    return (basePrompt || "") + extra;
}
// Честная приписка про то, где физически лежит файл.
function buildAntigravityFooter() {
    if (ARTIFACT_DELIVERY_ENABLED) {
        return `\n\n<i>ℹ️ Antigravity выполняет код в собственном sandbox Google.</i><br>` +
            `📤 <b>Доставка артефактов настроена:</b> если агент создал файл и загрузил его командой <code>curl</code> на сервер — файл лежит в <code>/tmp/artifacts/</code> (путь указан в ответе) и доступен через <code>/download</code>; также он мог быть запушен в GitHub (ссылка в ответе).<br>` +
            `⚠️ Если в ответе нет пути сервера — значит агент не выполнил загрузку, и файл остался только в sandbox Google (недоступен на сервере). Для гарантированного получения файлов компилируйте в обычном админ-режиме: выберите <b>Gemini 3.5 Flash Lite / 3.6 Flash</b> вместо Antigravity.`;
    }
    return `\n\n<i>ℹ️ Antigravity выполняет код в собственном sandbox Google, а НЕ на этом сервере.</i><br>` +
        `⚠️ <b>Все созданные файлы (.bin, .zip и т.д.) остаются в sandbox Google и НЕДОСТУПНЫ на этом сервере</b> — скачать их через <code>/download</code> нельзя. Если нужен файл-артефакт, используйте обычный админ-режим: выберите модель <b>Gemini 3.5 Flash Lite / 3.6 Flash</b> вместо Antigravity — там команды выполняются на этом сервере и файл появится в <code>/tmp</code>.`;
}
// ==========================================
// ГИБРИД: push артефакта в GitHub (Contents API, без git)
// ==========================================
async function pushArtifactToGitHub(filePath, safeName) {
    if (!GITHUB_ENABLED) return { ok: false, skipped: true, reason: "GITHUB_TOKEN/GITHUB_REPO не настроены" };
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > GITHUB_CONTENTS_MAX) {
            return { ok: false, reason: `Файл ${stat.size} байт превышает лимит GitHub Contents API (~1 МБ)` };
        }
        const b64 = fs.readFileSync(filePath).toString('base64');
        // Уникальный путь с таймштампом Kyiv — избегаем конфликтов sha и перезаписи
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const prefix = GITHUB_PATH_PREFIX.replace(/\/+$/, '');
        const repoPath = `${prefix}/${stamp}_${safeName}`;
        const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`;
        const resp = await axios.put(url, {
            message: `artifact: ${safeName} (${stamp})`,
            content: b64,
            branch: GITHUB_BRANCH
        }, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'northflank-artifact',
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });
        const htmlUrl = (resp.data && resp.data.content && resp.data.content.html_url) || null;
        console.log(`[ARTIFACT][GITHUB] Запушен: ${repoPath}`);
        return { ok: true, path: repoPath, url: htmlUrl };
    } catch (err) {
        const detail = (err.response && err.response.data && (err.response.data.message || JSON.stringify(err.response.data))) || err.message;
        console.error("[ARTIFACT][GITHUB ERROR]", detail);
        return { ok: false, reason: detail };
    }
}
// ==========================================
// ПОДДЕРЖКА ANTIGRAVITY (Interactions API)
// ==========================================
function isAntigravityModel(modelName) {
    return !!(modelName && String(modelName).toLowerCase().includes('antigravity'));
}
function extractAntigravityText(interaction) {
    const parts = [];
    if (interaction && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
            if (step && step.type === 'model_output' && Array.isArray(step.content)) {
                for (const c of step.content) {
                    if (c && c.type === 'text' && c.text) parts.push(c.text);
                }
            }
        }
    }
    if (parts.length === 0 && interaction && interaction.output_text) return interaction.output_text;
    if (parts.length === 0 && interaction && Array.isArray(interaction.outputs)) {
        for (const o of interaction.outputs) {
            if (o && o.text) parts.push(o.text);
            if (o && Array.isArray(o.content)) for (const c of o.content) if (c && c.text) parts.push(c.text);
        }
    }
    return parts.join('\n') || '[Antigravity не вернул текстового ответа]';
}
// --- Хелперы прогресса Antigravity ---
function escHtmlAg(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Устойчивый парсер шагов: распознаёт реальные типы Antigravity (code_execution_*, thought).
function describeAntigravityStep(step, idx) {
    if (!step || typeof step !== 'object') return `⚙️ Шаг ${idx + 1}`;
    const type = String(step.type || step.role || '').toLowerCase();
    if (type === 'code_execution_call' || type === 'code_execution') {
        return `🔧 <b>Antigravity → выполняет код</b> (sandbox)`;
    }
    if (type === 'code_execution_result') {
        return `📥 <b>Antigravity:</b> код выполнен`;
    }
    if (type === 'thought' || type === 'reasoning') {
        return `💭 <b>Antigravity:</b> размышляет…`;
    }
    const toolName =
        (step.tool_call && step.tool_call.name) ||
        (step.tool_use && step.tool_use.name) ||
        (step.function_call && step.function_call.name) ||
        step.name || null;
    if (type === 'tool_call' || type === 'tool_use' || type === 'function_call' || toolName) {
        return `🔧 <b>Antigravity → инструмент:</b> <code>${escHtmlAg(toolName || 'tool')}</code>`;
    }
    if (type === 'tool_result' || type === 'tool_output' || type === 'function_response') {
        return `📥 <b>Antigravity:</b> получен результат инструмента`;
    }
    let preview = '';
    if (Array.isArray(step.content)) {
        for (const c of step.content) {
            if (c && typeof c.text === 'string') { preview = c.text; break; }
        }
    } else if (typeof step.text === 'string') preview = step.text;
    else if (typeof step.content === 'string') preview = step.content;
    if (preview) {
        preview = preview.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (preview.length > 160) preview = preview.slice(0, 160) + '…';
        return `💬 <b>Antigravity:</b> ${escHtmlAg(preview)}`;
    }
    return `⚙️ <b>Antigravity:</b> шаг ${idx + 1}${type ? ' (' + escHtmlAg(type) + ')' : ''}`;
}
// Лёгкий push прогресса в inbox БЕЗ записи на диск.
function pushProgressToInbox(html) {
    messageInbox.push({ time: getKyivTime(), text: html });
}
// --- Вызов агента: устойчивые таймауты + прогресс + heartbeat ---
async function callAntigravityAgent(opts) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY };
    const background = opts.background !== false;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const body = {
        agent: 'antigravity-preview-05-2026',
        input: opts.input,
        environment: opts.environmentId || 'remote'
    };
    if (opts.previousInteractionId) body.previous_interaction_id = opts.previousInteractionId;
    if (opts.systemInstruction) body.system_instruction = opts.systemInstruction;
    if (background) body.background = true;

    console.log(`[ANTIGRAVITY] Отправка задачи агенту (background=${background})...`);
    let resp = await axios.post(url, body, { headers, timeout: 120000 });
    let interaction = resp.data;

    if (onProgress) {
        try { onProgress('🚀 <b>Antigravity:</b> задача принята, агент запущен…'); } catch (_) {}
    }

    if (background) {
        const maxWaitMs = 10 * 60 * 1000;
        const intervalMs = 3000;
        const heartbeatIntervalMs = 30000;   // API не отдаёт шаги во время in_progress — шлём индикацию
        const start = Date.now();
        let lastActivityTime = Date.now();
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 5;
        let processedSteps = 0;
        while (interaction && (interaction.status === 'in_progress' || interaction.status === 'queued')) {
            if (Date.now() - start > maxWaitMs) throw new Error('Antigravity: превышено время ожидания (10 минут)');
            await new Promise(r => setTimeout(r, intervalMs));
            try {
                const poll = await axios.get(`${url}/${interaction.id}`, { headers, timeout: 60000 });
                interaction = poll.data;
                consecutiveErrors = 0;
                const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
                if (steps.length > processedSteps) {
                    for (let i = processedSteps; i < steps.length; i++) {
                        let desc;
                        try { desc = describeAntigravityStep(steps[i], i); } catch (_) { desc = `⚙️ Шаг ${i + 1}`; }
                        console.log(`[ANTIGRAVITY PROGRESS] ${desc.replace(/<[^>]*>/g, '')}`);
                        if (onProgress) { try { onProgress(desc); } catch (_) {} }
                    }
                    processedSteps = steps.length;
                    lastActivityTime = Date.now();
                } else if (onProgress && (Date.now() - lastActivityTime) >= heartbeatIntervalMs) {
                    const elapsedSec = Math.round((Date.now() - start) / 1000);
                    try { onProgress(`⏳ <b>Antigravity:</b> задача выполняется… (прошло ${elapsedSec} сек)`); } catch (_) {}
                    lastActivityTime = Date.now();
                }
            } catch (pollErr) {
                consecutiveErrors++;
                console.warn(`[ANTIGRAVITY] Polling ошибка (${consecutiveErrors}/${maxConsecutiveErrors}): ${pollErr.message}`);
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    throw new Error(`Antigravity: polling не удался ${maxConsecutiveErrors} раз подряд: ${pollErr.message}`);
                }
            }
        }
        // добиваем шаги из финального interaction (API отдаёт их только при завершении)
        if (interaction) {
            const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
            if (steps.length > processedSteps) {
                for (let i = processedSteps; i < steps.length; i++) {
                    let desc;
                    try { desc = describeAntigravityStep(steps[i], i); } catch (_) { desc = `⚙️ Шаг ${i + 1}`; }
                    console.log(`[ANTIGRAVITY PROGRESS] ${desc.replace(/<[^>]*>/g, '')}`);
                    if (onProgress) { try { onProgress(desc); } catch (_) {} }
                }
                processedSteps = steps.length;
            }
        }
    }

    if (interaction && interaction.status === 'failed') {
        const msg = (interaction.error && interaction.error.message) || 'Antigravity: задача завершилась с ошибкой';
        throw new Error(msg);
    }

    return {
        id: interaction ? interaction.id : null,
        environmentId: (interaction && (interaction.environment_id || (interaction.environment && interaction.environment.id))) || opts.environmentId || null,
        status: interaction ? interaction.status : 'unknown',
        text: extractAntigravityText(interaction)
    };
}
// ==========================================
// ANTIGRAVITY: НЕБЛОКИРУЮЩИЙ ФОНОВЫЙ ЗАПУСК
// ==========================================
function runAntigravityInBackground(opts) {
    const mode = opts.mode;
    (async () => {
        try {
            const prevId = (mode === 'admin') ? adminAntigravityPrevId : geminiAntigravityPrevId;
            const envId  = (mode === 'admin') ? adminAntigravityEnvId  : geminiAntigravityEnvId;
            const ag = await callAntigravityAgent({
                input: opts.input,
                previousInteractionId: prevId,
                environmentId: envId,
                systemInstruction: opts.systemInstruction,
                background: true,
                onProgress: (h) => pushProgressToInbox(h)
            });
            if (mode === 'admin') { adminAntigravityPrevId = ag.id; adminAntigravityEnvId = ag.environmentId; }
            else { geminiAntigravityPrevId = ag.id; geminiAntigravityEnvId = ag.environmentId; }

            let finalText = ag.text + buildAntigravityFooter();
            const head = (mode === 'admin')
                ? '🛰 <b>Antigravity (admin) — готово:</b><br>'
                : '🛰 <b>Antigravity — готово:</b><br>';
            addMessageToInbox(head + finalText);
            console.log(`[ANTIGRAVITY BG] Задача завершена (mode=${mode}).`);
        } catch (err) {
            console.error("[ANTIGRAVITY BG ERROR]", err.message);
            addMessageToInbox(`❌ <b>Ошибка Antigravity:</b> ${escHtmlAg(err.message)}`);
        }
    })().catch(e => console.error("[ANTIGRAVITY BG UNHANDLED]", e && e.message));
}
async function getCronPattern(humanText) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent("Переведи фразу строго в стандартный cron-pattern из 5 параметров (минуты, часы, день, месяц, день недели). Верни ТОЛЬКО строку, например '*/2 * * * *'. Никаких других символов. Фраза: " + humanText);
    let pattern = result.response.text().trim();
    if (!cron.validate(pattern)) return "*/5 * * * *"; // fallback
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
// Карта для хранения активных объектов cron-задач
const activeCronTasks = {};
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
            // --- Antigravity: фоновая задача через Interactions API ---
            if (isAntigravityModel(modelName)) {
                try {
                    const ag = await callAntigravityAgent({
                        input: job.taskText,
                        systemInstruction: getAntigravitySystemInstruction("Ты — автономный агент, выполняющий задачу по расписанию. Верни только краткий конечный результат."),
                        background: true
                    });
                    addMessageToInbox(`<b>Задача ${job.id} выполнена (Antigravity)!</b><br>Запрос: <i>${job.taskText}</i><br><br>${ag.text}`);
                } catch (e) {
                    addMessageToInbox(`❌ <b>Ошибка Antigravity в задаче ${job.id}:</b> ${e.message}`);
                }
                return;
            }
            const modelConfig = { model: modelName };
            modelConfig.systemInstruction = "Ты — автономный агент, выполняющий задачу по расписанию (cron). Твоя цель — выполнить запрошенное действие ЕДИНОРАЗОВО прямо сейчас и вернуть ТОЛЬКО краткий конечный результат. КАТЕГОРИЧЕСКИ ЗАПРЕЩАЕТСЯ создавать bash-скрипты с бесконечными циклами (while true, sleep) или свои планировщики. НЕ ОПИСЫВАЙ шаги, которые ты делал, и не перечисляй выполненные команды — система сама добавит их в лог для пользователя. Дай только ответ на суть задачи (например, только текущий курс или статус). Перед любым поиском или анализом ОБЯЗАТЕЛЬНО выполни команду date, чтобы знать актуальную дату и не использовать устаревшие данные из памяти.";
            const model = genAI.getGenerativeModel(modelConfig);
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
                        // *** ИСПРАВЛЕНО: search и download объединены в одну рабочую ветку ***
                        const action = call.args.action;
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
                                } else { searchResult = "Ничего не найдено."; }
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
                            } else {
                                searchResult = `Неизвестное действие search_web: ${action}`;
                            }
                        } catch (err) {
                            searchResult = `Ошибка поиска/загрузки: ${err.message}`;
                        }
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
function initAllCronJobs() {
    console.log(`[CRON] Инициализация сохраненных задач: ${scheduledJobs.length}`);
    scheduledJobs.forEach(job => {
        startCronTask(job);
    });
}
// ==========================================
// СИСТЕМА ЛОГИРОВАНИЯ (с маскировкой секретов)
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
    const formatted = maskSecrets(util.format(...args));
    origLog(formatted);
    captureLog(formatted);
};
const origErr = console.error;
console.error = function(...args) {
    const formatted = maskSecrets(util.format(...args));
    origErr(formatted);
    captureLog("ERROR: " + formatted);
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
// ТЕЛЕМЕТРИЯ ЛИМИТОВ + ПАТЧ СОВМЕСТИМОСТИ МОДЕЛЕЙ
// ==========================================
const LIMITS_FILE = path.join(TMP_DIR, 'gemini_limits.json');
let geminiLimits = {};
if (fs.existsSync(LIMITS_FILE)) {
    try { geminiLimits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); } catch(e){}
}
const originalFetch = global.fetch;
global.fetch = async (input, init) => {
    // ============================================================
    // ПАТЧ СОВМЕСТИМОСТИ: Gemini 3.5 Flash Lite / 3.6 Flash и новее
    // Эти модели не принимают роль 'function'. SDK всё ещё пакует
    // functionResponse в role:'function' — на лету переписываем в 'user'.
    // ============================================================
    let patchedInit = init;
    try {
        const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        if (urlStr && urlStr.includes('generativelanguage.googleapis.com') &&
            init && init.body && typeof init.body === 'string') {
            const parsed = JSON.parse(init.body);
            let changed = false;
            if (Array.isArray(parsed.contents)) {
                for (const c of parsed.contents) {
                    if (c && c.role === 'function') { c.role = 'user'; changed = true; }
                }
            }
            if (changed) {
                const newBody = JSON.stringify(parsed);
                let newHeaders = init.headers;
                try {
                    const h = new Headers(init.headers || {});
                    h.delete('content-length');
                    newHeaders = h;
                } catch (_) {
                    if (init.headers && typeof init.headers === 'object') {
                        newHeaders = { ...init.headers };
                        delete newHeaders['content-length'];
                        delete newHeaders['Content-Length'];
                    }
                }
                patchedInit = { ...init, body: newBody, headers: newHeaders };
            }
        }
    } catch (e) { /* если тело не JSON — шлём как есть */ }

    const response = await originalFetch(input, patchedInit);

    // --- телеметрия лимитов ---
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
// ЭНДПОИНТ ПРИЁМА АРТЕФАКТОВ ОТ ANTIGRAVITY
// Узкоскоупный: умеет ТОЛЬКО класть файл в /tmp/artifacts/ (+ опц. push в GitHub).
// Не даёт exec/прокси/чат. Токен ARTIFACT_TOKEN != PROXY_SECRET.
// ==========================================
app.post('/artifact', (req, res) => {
    if (!ARTIFACT_TOKEN) return res.status(500).json({ ok: false, error: "ARTIFACT_TOKEN not set on server" });
    if (req.query.token !== ARTIFACT_TOKEN) return res.status(403).json({ ok: false, error: "Auth failed" });

    // Имя только из basename, без путей и точек-точек
    let rawName = String(req.get('x-filename') || req.query.name || 'artifact.bin');
    let safeName = path.basename(rawName).replace(/[^a-zA-Z0-9.\-_]/g, '_') || 'artifact.bin';
    const savePath = path.join(ARTIFACT_DIR, safeName); // всегда внутри ARTIFACT_DIR

    let bytes = 0; let aborted = false;
    const writer = fs.createWriteStream(savePath);
    req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > ARTIFACT_MAX && !aborted) {
            aborted = true; req.destroy(); writer.close();
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    });
    req.pipe(writer);
    writer.on('finish', async () => {
        if (aborted) return res.status(413).json({ ok: false, error: "File too large" });
        console.log(`[ARTIFACT] Принят файл: ${savePath} (${(bytes/1024).toFixed(1)} KB)`);
        // Опциональный push в GitHub (агент GITHUB_TOKEN не видит)
        let github = { ok: false, skipped: true, reason: "GitHub не настроен" };
        if (GITHUB_ENABLED) {
            github = await pushArtifactToGitHub(savePath, safeName);
        }
        res.json({ ok: true, path: savePath, size: bytes, github: github });
    });
    writer.on('error', (e) => {
        console.error("[ARTIFACT WRITE ERROR]", e.message);
        if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    });
});
// ==========================================
// МАРШРУТ УПРАВЛЕНИЯ И GEMINI
// ==========================================
app.post('/gemini', async (req, res) => {
    if (req.query.token !== PROXY_SECRET) return res.status(403).json({ok: false, error: "Auth failed"});
    // Обработчик опроса уведомлений планировщика
    if (req.body.action === 'poll_inbox') {
        const notifications = messageInbox.map(msg => ({
            time: msg.time,
            text: msg.text
        }));
        messageInbox = [];
        saveInbox();
        return res.json({
            ok: true,
            inbox: notifications,
            admin_mode: adminMode
        });
    }
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
        const payload = userText.substring(6).trim();
        if (!payload) {
            return res.json({ ok: true, text: "❌ Некорректный синтаксис. Шаблон: <code>/task * * * * * Текст задачи</code> или <code>/task каждые 5 минут проверяй...</code>" });
        }
        const parts = payload.split(' ');
        let pattern = "";
        let taskText = "";
        const potentialCron = parts.slice(0, 5).join(' ');
        if (parts.length >= 6 && cron.validate(potentialCron)) {
            pattern = potentialCron;
            taskText = parts.slice(5).join(' ').trim();
        } else {
            try {
                pattern = await getCronPattern(payload);
                taskText = payload;
            } catch (err) {
                return res.json({ ok: true, text: "❌ Ошибка генерации cron-паттерна: " + err.message });
            }
        }
        if (!cron.validate(pattern)) {
            return res.json({ ok: true, text: `❌ Не удалось определить валидный cron-pattern для: <code>${payload}</code>` });
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
    if (userText === '/tasks') {
        if (scheduledJobs.length === 0) {
            return res.json({ ok: true, text: "📝 Активных фоновых задач планировщика нет." });
        }
        let jobsListHtml = "📝 <b>Активные фоновые задачи:</b><br><br>";
        scheduledJobs.forEach(j => {
            jobsListHtml += `🆔 ID: <code>${j.id}</code> (Создана: ${j.createdAt})<br>⏰ Расписание: <code>${j.pattern}</code><br>🎯 Задача: <i>${j.taskText}</i><hr style="border:0; border-top:1px solid #ccc; margin:8px 0;">`;
        });
        return res.json({ ok: true, text: jobsListHtml });
    }
    if (userText.startsWith('/deltask')) {
        const parts = userText.split(' ');
        if (parts.length > 1) {
            const jobId = parts[1].trim();
            const jobIndex = scheduledJobs.findIndex(j => j.id === jobId);
            if (jobIndex !== -1) {
                if (activeCronTasks[jobId]) {
                    activeCronTasks[jobId].stop();
                    delete activeCronTasks[jobId];
                }
                scheduledJobs.splice(jobIndex, 1);
                saveJobs();
                return res.json({ ok: true, text: `🗑️ <b>Задача <code>${jobId}</code> успешно удалена!</b>` });
            } else {
                return res.json({ ok: true, text: `❌ Задача с ID <code>${jobId}</code> не найдена.` });
            }
        } else {
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
    }
    if (userText === '/help') {
        const deliveryHint = ARTIFACT_DELIVERY_ENABLED
            ? `<code>/artifact</code> — приём артефактов от Antigravity <b>настроен</b> (файлы → /tmp/artifacts/ + GitHub${GITHUB_ENABLED ? '' : ' [не настроен]'})<br>`
            : `<code>/artifact</code> — приём артефактов <b>НЕ настроен</b> (нужны env PUBLIC_URL + ARTIFACT_TOKEN)<br>`;
        const respHtml = `🤖 <b>СИСТЕМА CHATOPS (с поддержкой фонового планировщика):</b><br><br>
<code>/task [cron-pattern или текст] [запрос]</code> — Запланировать автономную задачу для ИИ<br>
<i>Пример 1: <code>/task */5 * * * * Какая цена BTC сейчас?</code></i><br>
<i>Пример 2: <code>/task каждые 3 минуты проверяй курс eth на bybit</code></i><br>
<code>/tasks</code> — Список активных задач планировщика<br>
<code>/deltask</code> — Удалить все активные фоновые задачи<br>
<code>/deltask [ID]</code> — Удалить конкретную задачу по ID<br><br>
<code>/status</code> — Состояние сервера<br>
<code>/limit</code> — Состояние моделей<br>
<code>/logs</code> — Логи Northflank<br>
<code>/proxy on</code> | <code>/proxy off</code> — Ghost Proxy (curl-impersonate локальный)<br>
<code>/ag_async on</code> | <code>/ag_async off</code> — Antigravity: фон (async) / ожидание (sync)<br>
${deliveryHint}
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
        adminHistory = [
            { role: "user", parts: [{ text: "Инструкции администратора" }] },
            { role: "model", parts: [{ text: adminSystemPrompt || "Инструкции не загружены." }] }
        ];
        adminAntigravityPrevId = null; adminAntigravityEnvId = null;
        console.log("[ADMIN] Режим администратора ВКЛЮЧЕН. История инициализирована системным промптом.");
        return res.json({ ok: true, text: "🔧 <b>Режим администратора активирован.</b> Все последующие сообщения будут выполняться как автономные задачи с доступом к терминалу и поиску в интернете." });
    }
    if (userText === '/admin off') {
        adminMode = false;
        adminHistory = [];
        adminAntigravityPrevId = null; adminAntigravityEnvId = null;
        console.log("[ADMIN] Режим администратора ОТКЛЮЧЕН.");
        return res.json({ ok: true, text: "🛑 <b>Режим администратора отключен.</b>" });
    }
    // Режим выполнения Antigravity: async (фон) / sync (ожидание)
    if (userText === '/ag_async on' || userText === '/ag_async off') {
        antigravityNonBlocking = (userText === '/ag_async on');
        console.log("[ANTIGRAVITY] Неблокирующий режим: " + (antigravityNonBlocking ? "ON" : "OFF"));
        return res.json({ ok: true, text: antigravityNonBlocking
            ? "⚡ <b>Antigravity: неблокирующий режим ВКЛ (async).</b><br>Задачи уходят в фон мгновенно — GAS не висит и не упрётся в лимит 6 минут. Прогресс и итоговый результат придут во входящие (📬 Планировщик)."
            : "🔒 <b>Antigravity: блокирующий режим ВКЛ (sync).</b><br>Сервер ждёт завершения задачи и возвращает ответ прямо в пузыре. <b>Внимание:</b> на задачах дольше ~6 минут GAS‑прослойка может оборвать соединение — для долгих задач (компиляция, исследования) используйте <code>/ag_async on</code>." });
    }
    if (userText === '/ag_async') {
        return res.json({ ok: true, text: `⚡ Режим Antigravity сейчас: <b>${antigravityNonBlocking ? 'НЕБЛОКИРУЮЩИЙ (async, фон)' : 'БЛОКИРУЮЩИЙ (sync, ожидание)'}</b><br>Переключение: <code>/ag_async on</code> | <code>/ag_async off</code>` });
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
    if (userText === '/status') {
        const mem = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        const adminStatus = adminMode
            ? '<span style="color:green; font-weight:bold;">✅ ВКЛЮЧЕН</span>'
            : '<span style="color:red;">❌ ВЫКЛЮЧЕН</span>';
        const adminCtx = adminMode ? `<br>🧠 Контекст админа: <b>${adminHistory.length} сообщений</b>` : '';
        const agMode = antigravityNonBlocking
            ? '<span style="color:#1a73e8; font-weight:bold;">async (фон)</span>'
            : '<span style="color:#6f42c1; font-weight:bold;">sync (ожидание)</span>';
        const deliveryStatus = ARTIFACT_DELIVERY_ENABLED
            ? `<span style="color:green; font-weight:bold;">✅ настроена</span> → /tmp/artifacts/` + (GITHUB_ENABLED ? ` + GitHub (<code>${escHtmlAg(GITHUB_REPO)}</code>)` : ` <span style="color:#856404;">(GitHub не настроен)</span>`)
            : `<span style="color:red;">❌ НЕ настроена</span> (нужны env PUBLIC_URL + ARTIFACT_TOKEN)`;
        const tasksCount = scheduledJobs.length;
        let statusText = `🖥 <b>Статус:</b><br>⏱ Uptime: <b>${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м</b><br>💾 Память: <b>${(mem.rss / 1024 / 1024).toFixed(1)} MB</b><br>🔒 Ghost Proxy: <b>${useProxy ? '<span style="color:green">ВКЛЮЧЕН</span>' : '<span style="color:red">ВЫКЛЮЧЕН</span>'}</b><br>🔧 Режим администратора: ${adminStatus}${adminCtx}<br>⚡ Antigravity: <b>${agMode}</b><br>📤 Доставка артефактов: ${deliveryStatus}<br>🧠 Контекст обычного чата: <b>${geminiHistory.length} сообщений</b><br>⚙️ Фоновых задач: <b>${tasksCount}</b>`;
        if (cronNotificationsHtml) {
            statusText = cronNotificationsHtml + '<br>' + statusText;
        }
        return res.json({ ok: true, text: statusText });
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
        geminiAntigravityPrevId = null; geminiAntigravityEnvId = null;
        adminAntigravityPrevId = null; adminAntigravityEnvId = null;
        if (adminMode) {
            adminHistory = [
                { role: "user", parts: [{ text: "Инструкции администратора" }] },
                { role: "model", parts: [{ text: adminSystemPrompt || "Инструкции не загружены." }] }
            ];
        } else {
            adminHistory = [];
        }
        console.log("[GEMINI] Память контекста нейросети очищена.");
        if (userText === 'clear') return res.json({ok: true, text: "История очищена"});
    }
    // Передаем cronNotificationsHtml в функцию администратора
    if (adminMode && userText && !userText.startsWith('/') && !userText.startsWith('!')) {
        return handleAdminMessage(userText, req, res, cronNotificationsHtml);
    }
    const modelName = req.body.model || "gemini-2.5-flash";
    // --- Antigravity: отдельный путь через Interactions API ---
    if (isAntigravityModel(modelName)) {
        if (req.body.b64 && req.body.mimeType && !String(req.body.mimeType).startsWith('image/')) {
            return res.json({ ok: true, text: "⚠️ Antigravity через этот интерфейс поддерживает только текст и изображения — файл не прикреплён." });
        }
        let agInput = userText || " ";
        if (req.body.b64 && req.body.mimeType && String(req.body.mimeType).startsWith('image/')) {
            agInput = [
                { type: "text", text: userText || "Проанализируй это изображение" },
                { type: "image", data: req.body.b64, mime_type: req.body.mimeType }
            ];
        }
        // НЕБЛОКИРУЮЩИЙ режим: мгновенная заглушка, задача в фоне
        if (antigravityNonBlocking) {
            runAntigravityInBackground({ mode: 'chat', input: agInput, systemInstruction: getAntigravitySystemInstruction("Ты — полезный ИИ-ассистент.") });
            let stub = "✅ <b>Задача Antigravity принята в фоновый режим.</b><br>Прогресс и ответ появятся во входящих (📬 Планировщик). Следите за блоками прогресса — они приходят каждые ~10 секунд.";
            if (cronNotificationsHtml) stub = cronNotificationsHtml + '<br>' + stub;
            return res.json({ ok: true, text: stub });
        }
        // БЛОКИРУЮЩИЙ режим: ждём завершения и возвращаем в пузыре
        try {
            const ag = await callAntigravityAgent({
                input: agInput,
                previousInteractionId: geminiAntigravityPrevId,
                environmentId: geminiAntigravityEnvId,
                systemInstruction: getAntigravitySystemInstruction("Ты — полезный ИИ-ассистент."),
                background: true,
                onProgress: (h) => pushProgressToInbox(h)
            });
            geminiAntigravityPrevId = ag.id;
            geminiAntigravityEnvId = ag.environmentId;
            const aiText = ag.text + buildAntigravityFooter();
            return res.json({ ok: true, text: cronNotificationsHtml ? cronNotificationsHtml + '<br>' + aiText : aiText });
        } catch (err) {
            console.error("[ANTIGRAVITY ERROR]", err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }
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
// ANTIGRAVITY В РЕЖИМЕ АДМИНИСТРАТОРА
// ==========================================
async function handleAntigravityAdmin(userText, req, res, cronNotificationsHtml = "") {
    // НЕБЛОКИРУЮЩИЙ режим: мгновенная заглушка, задача в фоне
    if (antigravityNonBlocking) {
        runAntigravityInBackground({
            mode: 'admin',
            input: userText,
            systemInstruction: getAntigravitySystemInstruction(adminSystemPrompt || "Ты — автономный агент-администратор. Выполняй задачу и возвращай краткий результат.")
        });
        let stub = "✅ <b>Задача Antigravity принята в фоновый режим.</b><br>Прогресс и итоговый результат появятся во входящих (📬 Планировщик). Следите за блоками прогресса — они приходят каждые ~10 секунд.";
        if (cronNotificationsHtml) stub = cronNotificationsHtml + '<br>' + stub;
        return res.json({ ok: true, text: stub });
    }
    // БЛОКИРУЮЩИЙ режим: ждём завершения и возвращаем в пузыре
    try {
        const ag = await callAntigravityAgent({
            input: userText,
            previousInteractionId: adminAntigravityPrevId,
            environmentId: adminAntigravityEnvId,
            systemInstruction: getAntigravitySystemInstruction(adminSystemPrompt || "Ты — автономный агент-администратор. Выполняй задачу и возвращай краткий результат."),
            background: true,
            onProgress: (h) => pushProgressToInbox(h)
        });
        adminAntigravityPrevId = ag.id;
        adminAntigravityEnvId = ag.environmentId;
        let finalText = ag.text + buildAntigravityFooter();
        if (cronNotificationsHtml) finalText = cronNotificationsHtml + '<br>' + finalText;
        return res.json({ ok: true, text: finalText });
    } catch (err) {
        console.error("[ANTIGRAVITY ADMIN ERROR]", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
// ==========================================
// АВТОНОМНЫЙ АДМИНИСТРАТОР С ИНСТРУМЕНТАМИ
// ==========================================
async function handleAdminMessage(userText, req, res, cronNotificationsHtml = "") {
    if (!GEMINI_API_KEY) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY"});
    const preferredModel = req.body.model || "gemini-2.5-flash";
    // --- Antigravity: агент работает через Interactions API со своими инструментами ---
    if (isAntigravityModel(preferredModel)) {
        return handleAntigravityAdmin(userText, req, res, cronNotificationsHtml);
    }
    const isGemma = preferredModel.toLowerCase().includes('gemma');
    const modelConfig = { model: preferredModel };
    if (!isGemma) {
        modelConfig.systemInstruction = adminSystemPrompt || "Ты полезный администратор сервера...";
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
                        command: { type: "STRING", description: "The shell command to execute." }
                    },
                    required: ["command"]
                }
            },
            {
                name: "search_web",
                description: "Search the web using Tavily API or download a file directly.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: { type: "STRING", enum: ["search", "download"] },
                        query: { type: "STRING", description: "Search query" },
                        url: { type: "STRING", description: "URL to download" }
                    },
                    required: ["action"]
                }
            },
            {
                name: "send_message_to_telegram",
                description: "Send a text message to a Telegram chat. chat_id is optional; defaults to TG_CHAT_ID.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        chat_id: { type: "STRING", description: "Target chat ID (optional)" },
                        text: { type: "STRING", description: "Message text (HTML allowed)" }
                    },
                    required: ["text"]
                }
            },
            {
                name: "send_file_to_telegram",
                description: "Send a file from server to a Telegram chat. chat_id is optional; defaults to TG_CHAT_ID.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        chat_id: { type: "STRING", description: "Target chat ID (optional)" },
                        file_path: { type: "STRING", description: "Absolute path to the file" }
                    },
                    required: ["file_path"]
                }
            },
            {
                name: "toggle_proxy",
                description: "Enable or disable the Ghost Proxy (SOCKS5) for web scraping.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        state: { type: "STRING", enum: ["on", "off"], description: "Desired proxy state" }
                    },
                    required: ["state"]
                }
            },
            {
                name: "manage_cron_tasks",
                description: "Manage background cron tasks. Use 'create' to add a task, 'list' to view all, 'delete' to remove a task by job_id.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: { type: "STRING", enum: ["create", "list", "delete"], description: "Action to perform" },
                        pattern: { type: "STRING", description: "Cron pattern (for create)" },
                        task_text: { type: "STRING", description: "Task description for the AI (for create)" },
                        job_id: { type: "STRING", description: "Job ID to delete (for delete)" }
                    },
                    required: ["action"]
                }
            }
        ]
    }];
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
                    const funcResponse = { name: call.name, response: { result: execResult } };
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
                    const funcResponse = { name: call.name, response: { result: searchResult } };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else if (call.name === "send_message_to_telegram") {
                    let execResult;
                    if (!TG_TOKEN) {
                        execResult = "Ошибка: TG_TOKEN не настроен";
                    } else {
                        const chatId = call.args.chat_id || TG_CHAT_ID;
                        if (!chatId) {
                            execResult = "Ошибка: не указан chat_id и не задан TG_CHAT_ID";
                        } else {
                            const msgText = call.args.text;
                            try {
                                await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                                    chat_id: chatId,
                                    text: msgText,
                                    parse_mode: 'HTML'
                                });
                                execResult = `Сообщение успешно отправлено в чат ${chatId}`;
                            } catch (err) {
                                execResult = `Ошибка отправки сообщения: ${err.message}`;
                            }
                        }
                    }
                    console.log(`[ADMIN] send_message_to_telegram: ${execResult}`);
                    const funcResponse = { name: call.name, response: { result: execResult } };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else if (call.name === "send_file_to_telegram") {
                    let execResult;
                    if (!TG_TOKEN) {
                        execResult = "Ошибка: TG_TOKEN не настроен";
                    } else {
                        const chatId = call.args.chat_id || TG_CHAT_ID;
                        if (!chatId) {
                            execResult = "Ошибка: не указан chat_id и не задан TG_CHAT_ID";
                        } else {
                            const filePath = call.args.file_path;
                            if (!fs.existsSync(filePath)) {
                                execResult = `Файл не найден: ${filePath}`;
                            } else {
                                try {
                                    const fileName = path.basename(filePath);
                                    const fileStream = fs.createReadStream(filePath);
                                    const form = new FormData();
                                    form.append('chat_id', chatId);
                                    form.append('document', fileStream, fileName);
                                    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, form, {
                                        headers: form.getHeaders()
                                    });
                                    execResult = `Файл ${fileName} успешно отправлен в чат ${chatId}`;
                                } catch (err) {
                                    execResult = `Ошибка отправки файла: ${err.message}`;
                                }
                            }
                        }
                    }
                    console.log(`[ADMIN] send_file_to_telegram: ${execResult}`);
                    const funcResponse = { name: call.name, response: { result: execResult } };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else if (call.name === "toggle_proxy") {
                    const state = call.args.state;
                    let execResult;
                    if (state === "on") {
                        if (!SOCKS5_PROXY) {
                            execResult = "Ошибка: SOCKS5_PROXY не настроен";
                        } else {
                            useProxy = true;
                            execResult = "Прокси включён";
                        }
                    } else {
                        useProxy = false;
                        execResult = "Прокси выключен";
                    }
                    console.log(`[ADMIN] toggle_proxy: ${execResult}`);
                    const funcResponse = { name: call.name, response: { result: execResult } };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else if (call.name === "manage_cron_tasks") {
                    let execResult;
                    const action = call.args.action;
                    try {
                        if (action === "create") {
                            const pattern = call.args.pattern;
                            const taskText = call.args.task_text;
                            if (!pattern || !taskText) throw new Error("pattern and task_text are required");
                            if (!cron.validate(pattern)) throw new Error("Invalid cron pattern");
                            const jobId = 'job_' + Date.now();
                            const newJob = {
                                id: jobId,
                                pattern: pattern,
                                taskText: taskText,
                                model: preferredModel,
                                createdAt: getKyivTime()
                            };
                            scheduledJobs.push(newJob);
                            saveJobs();
                            startCronTask(newJob);
                            execResult = `Задача создана с ID: ${jobId}`;
                        } else if (action === "list") {
                            if (scheduledJobs.length === 0) {
                                execResult = "Нет активных задач.";
                            } else {
                                execResult = scheduledJobs.map(j => `ID: ${j.id} | ${j.pattern} | ${j.taskText}`).join('\n');
                            }
                        } else if (action === "delete") {
                            const jobId = call.args.job_id;
                            if (!jobId) throw new Error("job_id is required for delete");
                            const idx = scheduledJobs.findIndex(j => j.id === jobId);
                            if (idx === -1) {
                                execResult = `Задача с ID ${jobId} не найдена`;
                            } else {
                                if (activeCronTasks[jobId]) {
                                    activeCronTasks[jobId].stop();
                                    delete activeCronTasks[jobId];
                                }
                                scheduledJobs.splice(idx, 1);
                                saveJobs();
                                execResult = `Задача ${jobId} удалена`;
                            }
                        } else {
                            execResult = "Неизвестное действие";
                        }
                    } catch (err) {
                        execResult = `Ошибка: ${err.message}`;
                    }
                    console.log(`[ADMIN] manage_cron_tasks: ${execResult}`);
                    const funcResponse = { name: call.name, response: { result: execResult } };
                    result = await chat.sendMessage([{ functionResponse: funcResponse }]);
                } else {
                    console.log("[ADMIN] Неизвестная функция:", call.name);
                    break;
                }
            } else {
                let finalText = parts.map(p => p.text).join('');
                if (executedCommands.length > 0) {
                    finalText += `\n\n<details><summary>📋 <b>Терминал</b> (нажмите, чтобы развернуть)</summary>\n`;
                    executedCommands.forEach((cmd, index) => {
                        finalText += `\n${index + 1}. <code>${cmd.command}</code>\n   ↳ ${cmd.result}`;
                    });
                    finalText += `\n</details>`;
                }
                adminHistory = await chat.getHistory();
                let finalResponseText = finalText;
                if (cronNotificationsHtml) {
                    finalResponseText = cronNotificationsHtml + '<br>' + finalResponseText;
                }
                return res.json({ ok: true, text: finalResponseText });
            }
            iterations++;
            if (iterations >= maxIterations) {
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
        try { adminHistory = await chat.getHistory(); } catch (e) {}
        return res.status(500).json({ ok: false, error: errorText });
    }
}
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
        if ([401, 403, 406, 429, 503].includes(responseStatus)) {
            console.warn(`[PROXY WARNING] Сайт заблокировал запрос. HTTP Код: ${responseStatus}`);
            return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:40px; background:#f8d7da; color:#721c24; border-radius:10px; margin:20px;"><h2 style="margin-top:0;">🚫 Доступ заблокирован (${responseStatus})</h2><p>Целевой сервер отклонил запрос. Попробуйте использовать команду <b>/proxy on</b> в чате.</p></body></html>`);
        }
        if (isHtml && (htmlContent.includes('<title>Just a moment...</title>') || htmlContent.includes('Enable JavaScript and cookies to continue'))) {
            console.warn(`[PROXY WARNING] Обнаружена JS-капча Cloudflare (Код ${responseStatus})`);
            return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:40px; background:#fff3cd; color:#856404; border-radius:10px; margin:20px;"><h2 style="margin-top:0;">🤖 JS-Капча (Cloudflare)</h2><p>Сайт требует вычисления сложной JavaScript-капчи, которую невозможно выполнить через серверный прокси. Откройте эту ссылку в обычном браузере.</p></body></html>`);
        }
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
        console.log(`[SYSTEM] Доставка артефактов: ${ARTIFACT_DELIVERY_ENABLED ? 'ВКЛ' : 'ВЫКЛ'} | GitHub: ${GITHUB_ENABLED ? 'ВКЛ (' + GITHUB_REPO + ')' : 'ВЫКЛ'}`);
        initAllCronJobs();
    });
}
startServer();
