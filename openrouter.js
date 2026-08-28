// openrouter.js — модуль для работы с OpenRouter и Groq API
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const URL = require('url');

const execPromise = util.promisify(exec);

let openRouterHistory = [];

/**
 * Groq-модели в UI имеют префикс "groq/" (например groq/llama-3.3-70b-versatile).
 * При вызове API префикс снимается.
 */
function isGroqModel(modelName) {
    if (!modelName) return false;
    return String(modelName).toLowerCase().startsWith('groq/');
}

/**
 * Проверяет, является ли модель OpenRouter моделью.
 * OpenRouter модели имеют формат "provider/model" (содержат "/"),
 * а Gemini модели — "gemini-X.X-..." или "gemma-..." (без "/").
 * Модели groq/* обрабатываются отдельно через Groq API.
 */
function isOpenRouterModel(modelName) {
    if (!modelName) return false;
    const name = String(modelName).toLowerCase();

    // Antigravity обрабатывается отдельным путём
    if (name.includes('antigravity')) return false;

    // Groq — отдельный провайдер
    if (name.startsWith('groq/')) return false;

    // Gemini/Gemma модели НЕ содержат '/' в названии
    if (name.startsWith('gemini-') || name.startsWith('gemma-') || name.startsWith('aqa')) {
        return false;
    }

    // Все остальные модели с '/' — это OpenRouter
    // Примеры: minimax/minimax-m2.7:free, meta-llama/llama-3.1, z-ai/glm-5.2:free
    if (name.includes('/')) return true;

    return false;
}

/** OpenRouter или Groq — оба идут через handleOpenRouterMessage */
function isOpenAICompatibleExternalModel(modelName) {
    return isOpenRouterModel(modelName) || isGroqModel(modelName);
}

function clearHistory() {
    openRouterHistory = [];
}

function getHistory() {
    return openRouterHistory;
}

function setHistory(history) {
    openRouterHistory = history || [];
}

/**
 * Основной обработчик запросов к OpenRouter / Groq
 */
async function handleOpenRouterMessage(req, res, options = {}) {
    const {
        OPENROUTER_API_KEY,
        GROQ_API_KEY,
        TAVILY_API_KEY,
        TMP_DIR,
        PUBLIC_URL,
        adminMode,
        adminSystemPrompt,
        githubSystemPrompt,
        githubOps,
        maskSecrets,
        messageInbox,
        getKyivTime,
        escapeHtml,
        useProxy,
        SOCKS5_PROXY,
        getBrowserHeaders
    } = options;

    const rawModel = req.body.model || '';
    const isGroq = isGroqModel(rawModel);
    // Для Groq: UI-id "groq/llama-3.3-70b-versatile" → API-id "llama-3.3-70b-versatile"
    const model = isGroq
        ? String(rawModel).replace(/^groq\//i, '')
        : (rawModel || 'meta-llama/llama-3.3-70b-instruct:free');

    if (isGroq) {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ ok: false, error: "GROQ_API_KEY не задан на сервере" });
        }
    } else {
        if (!OPENROUTER_API_KEY) {
            return res.status(500).json({ ok: false, error: "OPENROUTER_API_KEY не задан на сервере" });
        }
    }

    const apiUrl = isGroq
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    const apiKey = isGroq ? GROQ_API_KEY : OPENROUTER_API_KEY;
    const providerLabel = isGroq ? 'GROQ' : 'OPENROUTER';

    const userText = req.body.text ? req.body.text.trim() : "";

    // === ВАЖНО: Обработка команд терминала (!) ДО OpenRouter ===
    // Команды терминала должны выполняться локально, а не отправляться в OpenRouter
    if (userText.startsWith('!')) {
        const cmd = userText.substring(1).trim();
        if (!cmd) return res.json({ ok: true, text: "⚠️ Введите команду." });
        try {
            console.log(`[${providerLabel} CHATOPS] Выполнение: ${cmd}`);
            const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });
            let output = stdout;
            if (stderr) output += `\n[STDERR]:\n${stderr}`;
            if (!output) output = "[Выполнено успешно]";
            if (output.length > 300000) output = output.substring(0, 300000) + "\n\n...[ОБРЕЗАН]...";
            const safeOut = escapeHtml(output);
            const safeCmd = escapeHtml(cmd);
            return res.json({ ok: true, text:`<b>$</b> <code>${safeCmd}</code><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#1e1e1e; color:#0f0; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${safeOut}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#555; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>`});
        } catch (err) {
            const safeCmdE = escapeHtml(cmd);
            const safeErr = escapeHtml(err.message || String(err));
            return res.json({ ok: true, text:`<b>$</b> <code>${safeCmdE}</code><br><div style="position:relative; margin-top:5px;"><div style="font-family:monospace; font-size:10px; max-height:250px; overflow-y:auto; background:#3b1313; color:#f66; padding:8px 8px 30px 8px; border-radius:5px; white-space:pre-wrap;">${safeErr}</div><button onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',2000)" style="position:absolute; bottom:5px; right:5px; padding:4px 8px; font-size:10px; background:#773333; color:#fff; border:none; border-radius:3px; cursor:pointer;">Copy</button></div>`});
        }
    }

    // Получаем и очищаем уведомления cron
    let cronNotificationsHtml = "";
    if (messageInbox && messageInbox.length > 0) {
        cronNotificationsHtml = '<div style="background:#fff3cd; border-left:5px solid #ffc107; padding:12px; margin-bottom:15px; border-radius:6px; font-size:12px; color:#856404; max-height: 400px; overflow-y: auto;"><b>🔔 Результаты фоновых задач:</b><br>' +
            messageInbox.map(m => `⏰ [${m.time} Kyiv]: ${m.text}`).join('<hr style="border:0; border-top:1px solid #ffeeba; margin:10px 0;">') + '</div>';
        messageInbox.length = 0;
        const MESSAGES_FILE = path.join(TMP_DIR, 'inbox.json');
        fs.writeFileSync(MESSAGES_FILE, '[]');
    }

    // Формируем массив сообщений для OpenRouter
    const messages = [];

    if (adminMode) {
        let sysPrompt = adminSystemPrompt || "Ты полезный администратор сервера.";
        if (githubSystemPrompt) {
            sysPrompt += "\n\n=== РЕЖИМ GITHUB ===\n" + githubSystemPrompt;
        }
        messages.push({ role: "system", content: sysPrompt });
        messages.push(...openRouterHistory);
    }

    // Формируем контент пользователя (текст + изображение)
    let userContent = userText || "Проанализируй это изображение";
    if (req.body.b64 && req.body.mimeType) {
        // OpenAI-совместимый формат для изображений
        const isImage = String(req.body.mimeType).startsWith('image/');
        if (isImage) {
            userContent = [
                { type: "text", text: userText || "Проанализируй это изображение" },
                { type: "image_url", image_url: { url: `data:${req.body.mimeType};base64,${req.body.b64}` } }
            ];
        } else {
            // Не-изображения — просто упоминаем путь (файл уже загружен на сервер через action: upload)
            userContent = userText || "Обработай прикреплённый файл.";
        }
    }
    messages.push({ role: "user", content: userContent });

    // Определяем доступные инструменты для admin режима
    let tools = undefined;
    if (adminMode) {
        tools = [
            {
                type: "function",
                function: {
                    name: "exec_command",
                    description: "Execute a shell command and return stdout and stderr.",
                    parameters: {
                        type: "object",
                        properties: {
                            command: { type: "string", description: "The shell command to execute." }
                        },
                        required: ["command"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "search_web",
                    description: "Search the web using Tavily API or download a file directly.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: { type: "string", enum: ["search", "download"] },
                            query: { type: "string", description: "Search query" },
                            url: { type: "string", description: "URL to download" }
                        },
                        required: ["action"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "github_ops",
                    description: "GitHub Contents + Actions: files, artifacts, workflows.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: ["status", "list", "get", "put", "delete", "download_to_server", "create_artifact", "list_workflows", "trigger_workflow", "list_runs", "wait_run", "list_artifacts", "download_artifact"]
                            },
                            path: { type: "string" },
                            content: { type: "string" },
                            message: { type: "string" },
                            branch: { type: "string" },
                            local_path: { type: "string" },
                            sha: { type: "string" },
                            is_binary: { type: "boolean" },
                            workflow_id: { type: "string" },
                            run_id: { type: "string" },
                            artifact_id: { type: "string" }
                        },
                        required: ["action"]
                    }
                }
            }
        ];
    }

    try {
        let iterations = 0;
        const maxIterations = 30;
        let finalText = "";
        const executedCommands = [];

        while (iterations < maxIterations) {
            const payload = {
                model: model,
                messages: messages,
                temperature: 0.7
            };
            
            // Добавляем tools только если они определены
            if (tools) {
                payload.tools = tools;
            }

            console.log(`[${providerLabel}] Запрос к модели: ${model} (итерация ${iterations + 1})`);

            let response;
            try {
                const headers = {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                };
                if (!isGroq) {
                    headers['HTTP-Referer'] = PUBLIC_URL || 'http://localhost';
                    headers['X-Title'] = 'MiniVPS';
                }
                response = await axios.post(apiUrl, payload, {
                    headers,
                    timeout: 600000
                });
            } catch (apiErr) {
                const errData = apiErr.response?.data?.error;
                if (apiErr.response?.status === 429) {
                    const remedy = errData?.metadata?.remedy_hint || errData?.message || 'Попробуйте позже или выберите другую модель';
                    return res.status(429).json({
                        ok: false,
                        error: `⏱ <b>Rate limit (429)</b><br>Модель <code>${escapeHtml(model)}</code> (${providerLabel}) временно перегружена.<br><i>${escapeHtml(String(remedy))}</i>`
                    });
                }
                if (apiErr.response?.status === 400) {
                    return res.status(400).json({
                        ok: false,
                        error: `❌ <b>Ошибка 400</b><br>${escapeHtml(errData?.message || 'Модель не поддерживает запрошенные параметры')}`
                    });
                }
                if (apiErr.response?.status === 401) {
                    return res.status(401).json({
                        ok: false,
                        error: `🔑 <b>Ошибка авторизации</b><br>Проверьте ${isGroq ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'}.`
                    });
                }
                throw apiErr;
            }

            const choice = response.data.choices[0];
            if (!choice) {
                return res.status(500).json({ ok: false, error: "OpenRouter не вернул ответ" });
            }
            
            const message = choice.message;

            // Если есть вызовы инструментов
            if (message.tool_calls && message.tool_calls.length > 0) {
                messages.push(message);

                for (const toolCall of message.tool_calls) {
                    let toolResult = "";
                    try {
                        const args = JSON.parse(toolCall.function.arguments);

                        if (toolCall.function.name === 'exec_command') {
                            const cmd = args.command;
                            console.log(`[${providerLabel} ADMIN] Executing: ${cmd}`);
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
                            toolResult = JSON.stringify({ result: execResult });

                        } else if (toolCall.function.name === 'search_web') {
                            let searchResult = "";
                            if (args.action === 'search') {
                                if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY не задан");
                                const tavRes = await axios.post('https://api.tavily.com/search', {
                                    api_key: TAVILY_API_KEY,
                                    query: args.query,
                                    max_results: 5,
                                    search_depth: "basic"
                                });
                                searchResult = tavRes.data.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\n${r.url}`).join('\n\n');
                            } else if (args.action === 'download') {
                                const url = args.url;
                                const parsed = new URL.URL(url);
                                const filename = (path.basename(parsed.pathname) || `dl_${Date.now()}`).replace(/[^a-zA-Z0-9.\-_]/g, '_');
                                const savePath = path.join(TMP_DIR, filename);
                                const dlRes = await axios.get(url, { responseType: 'stream', headers: getBrowserHeaders(false), timeout: 60000 });
                                const writer = fs.createWriteStream(savePath);
                                dlRes.data.pipe(writer);
                                await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                                const stat = fs.statSync(savePath);
                                searchResult = `Файл загружен: ${savePath} (${(stat.size / 1024).toFixed(1)} KB)`;
                            }
                            toolResult = JSON.stringify({ result: searchResult });

                        } else if (toolCall.function.name === 'github_ops') {
                            let ghResult;
                            try {
                                ghResult = await githubOps(args);
                            } catch (err) {
                                ghResult = JSON.stringify({ ok: false, error: err.message });
                            }
                            toolResult = maskSecrets(ghResult);

                        } else {
                            toolResult = JSON.stringify({ error: "Unknown tool" });
                        }
                    } catch (err) {
                        toolResult = JSON.stringify({ error: `Tool execution failed: ${err.message}` });
                    }

                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                        content: toolResult
                    });
                }
                iterations++;
            } else {
                // Финальный текстовый ответ
                finalText = message.content || "";
                break;
            }
        }

        if (iterations >= maxIterations) {
            finalText += "\n\n⚠️ <b>Достигнут лимит итераций инструментов.</b>";
        }

        // Добавляем выполненные команды в ответ
        if (executedCommands.length > 0) {
            finalText += `\n\n<details><summary>📋 <b>Терминал</b> (нажмите, чтобы развернуть)</summary>\n`;
            executedCommands.forEach((cmd, index) => {
                finalText += `\n${index + 1}. <code>${escapeHtml(cmd.command)}</code>\n ↳ ${escapeHtml(cmd.result)}`;
            });
            finalText += `\n</details>`;
        }

        // Сохраняем историю для admin режима
        if (adminMode) {
            openRouterHistory.push({ role: "user", content: userContent });
            openRouterHistory.push({ role: "assistant", content: finalText });

            if (openRouterHistory.length > 10) {
                openRouterHistory = openRouterHistory.slice(-10);
            }
        }

        return res.json({
            ok: true,
            text: cronNotificationsHtml ? cronNotificationsHtml + '<br>' + finalText : finalText,
            admin_mode: adminMode
        });

    } catch (err) {
        console.error(`[${providerLabel} ERROR]`, err.response ? err.response.data : err.message);
        const errData = err.response?.data?.error;
        const errMsg = errData?.message || err.message;
        const errCode = err.response?.status || 500;

        let userFriendlyError = `${providerLabel}: ${errMsg}`;
        if (errCode === 429) {
            userFriendlyError = `⏱ <b>Rate limit</b><br>Модель <code>${escapeHtml(model)}</code> временно перегружена. Попробуйте другую модель.`;
        } else if (errCode === 400) {
            userFriendlyError = `❌ <b>Ошибка 400</b><br>Модель <code>${escapeHtml(model)}</code> не поддерживает запрошенные параметры.`;
        } else if (errCode === 401) {
            userFriendlyError = `🔑 <b>Ошибка авторизации</b><br>Проверьте ${isGroq ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'}.`;
        } else if (errCode === 402) {
            userFriendlyError = isGroq
                ? `💳 <b>Лимит / квота Groq</b><br>Проверьте лимиты на console.groq.com.`
                : `💳 <b>Недостаточно кредитов</b><br>Пополните баланс на OpenRouter.`;
        } else if (errCode === 502 || errCode === 503) {
            userFriendlyError = `🌐 <b>Ошибка ${errCode}</b><br>Провайдер модели <code>${escapeHtml(model)}</code> временно недоступен.`;
        }

        return res.status(errCode).json({ ok: false, error: userFriendlyError });
    }
}

module.exports = {
    isOpenRouterModel,
    isGroqModel,
    isOpenAICompatibleExternalModel,
    handleOpenRouterMessage,
    clearHistory,
    getHistory,
    setHistory
};
