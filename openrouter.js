// openrouter.js — модуль для работы с OpenRouter API (stealth/ox-alpha)
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const URL = require('url');

const execPromise = util.promisify(exec);

// История сессии для OpenRouter
let openRouterHistory = [];

/**
 * Проверяет, является ли модель OpenRouter моделью
 */
function isOpenRouterModel(modelName) {
    return !!(modelName && String(modelName).toLowerCase().includes('stealth/'));
}

/**
 * Очищает историю OpenRouter
 */
function clearHistory() {
    openRouterHistory = [];
}

/**
 * Возвращает текущую историю
 */
function getHistory() {
    return openRouterHistory;
}

/**
 * Устанавливает историю (для восстановления состояния)
 */
function setHistory(history) {
    openRouterHistory = history || [];
}

/**
 * Основной обработчик запросов к OpenRouter
 * Поддерживает: чат, режим администратора, изображения, вызов инструментов
 */
async function handleOpenRouterMessage(req, res, options = {}) {
    const {
        OPENROUTER_API_KEY,
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

    if (!OPENROUTER_API_KEY) {
        return res.status(500).json({ ok: false, error: "OPENROUTER_API_KEY не задан на сервере" });
    }

    const model = req.body.model || 'stealth/ox-alpha';
    const userText = req.body.text ? req.body.text.trim() : "";

    // Получаем и очищаем уведомления cron
    let cronNotificationsHtml = "";
    if (messageInbox && messageInbox.length > 0) {
        cronNotificationsHtml = '<div style="background:#fff3cd; border-left:5px solid #ffc107; padding:12px; margin-bottom:15px; border-radius:6px; font-size:12px; color:#856404; max-height: 400px; overflow-y: auto;"><b>🔔 Результаты фоновых задач:</b><br>' +
            messageInbox.map(m => `⏰ [${m.time} Kyiv]: ${m.text}`).join('<hr style="border:0; border-top:1px solid #ffeeba; margin:10px 0;">') + '</div>';
        messageInbox.length = 0;
        fs.writeFileSync(path.join(TMP_DIR, 'inbox.json'), '[]');
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
        userContent = [
            { type: "text", text: userText || "Проанализируй это изображение" },
            { type: "image_url", image_url: { url: `data:${req.body.mimeType};base64,${req.body.b64}` } }
        ];
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
                            path: { type: "string", description: "Path inside the repository" },
                            content: { type: "string", description: "Full text content for put" },
                            message: { type: "string", description: "Commit message" },
                            branch: { type: "string", description: "Branch name" },
                            local_path: { type: "string", description: "Absolute path on this server" },
                            sha: { type: "string", description: "Blob SHA required for update/delete" },
                            is_binary: { type: "boolean", description: "If true, content is treated as base64" },
                            workflow_id: { type: "string", description: "Workflow id or filename" },
                            run_id: { type: "string", description: "Workflow run id" },
                            artifact_id: { type: "string", description: "Artifact id" }
                        },
                        required: ["action"]
                    }
                }
            }
        ];
    }

    try {
        let iterations = 0;
        const maxIterations = 15;
        let finalText = "";
        const executedCommands = [];

        while (iterations < maxIterations) {
            const payload = {
                model: model,
                messages: messages,
                tools: tools,
                temperature: 0.7
            };

            const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', payload, {
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': PUBLIC_URL || 'http://localhost',
                    'X-Title': 'MiniVPS'
                },
                timeout: 120000
            });

            const choice = response.data.choices[0];
            const message = choice.message;

            // Если есть вызовы инструментов
            if (message.tool_calls) {
                messages.push(message);

                for (const toolCall of message.tool_calls) {
                    let toolResult = "";
                    try {
                        const args = JSON.parse(toolCall.function.arguments);

                        if (toolCall.function.name === 'exec_command') {
                            const cmd = args.command;
                            console.log(`[OPENROUTER ADMIN] Executing: ${cmd}`);
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

                                if (useProxy && SOCKS5_PROXY) {
                                    // Используем curl-impersonate если доступен
                                    const curlBin = path.join(__dirname, 'curl-impersonate', 'curl_chrome116');
                                    if (fs.existsSync(curlBin)) {
                                        const proxyStr = SOCKS5_PROXY.replace('socks5://', 'socks5h://');
                                        const shell = fs.existsSync('/bin/bash') ? 'bash' : 'sh';
                                        await execPromise(`${shell} "${curlBin}" --compressed -m 60 -s -L -x "${proxyStr}" -o "${savePath}" "${url}"`);
                                    } else {
                                        const dlRes = await axios.get(url, { responseType: 'stream', headers: getBrowserHeaders(false), timeout: 60000 });
                                        const writer = fs.createWriteStream(savePath);
                                        dlRes.data.pipe(writer);
                                        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                                    }
                                } else {
                                    const dlRes = await axios.get(url, { responseType: 'stream', headers: getBrowserHeaders(false), timeout: 60000 });
                                    const writer = fs.createWriteStream(savePath);
                                    dlRes.data.pipe(writer);
                                    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                                }

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

            // Ограничиваем историю последними 10 сообщениями
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
        console.error("[OPENROUTER ERROR]", err.response ? err.response.data : err.message);
        const errMsg = err.response?.data?.error?.message || err.message;
        return res.status(500).json({ ok: false, error: `OpenRouter: ${errMsg}` });
    }
}

module.exports = {
    isOpenRouterModel,
    handleOpenRouterMessage,
    clearHistory,
    getHistory,
    setHistory
};
