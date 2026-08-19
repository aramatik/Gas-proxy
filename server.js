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
const minioStorage = require('./minioStorage');
const app = express();
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '150mb' }));
app.use(express.json({ limit: '150mb' }));
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
const ARTIFACT_MAX = 130 * 1024 * 1024; // 130 МБ на приём (согласовано с MAX_FILE_SIZE)
const GITHUB_CONTENTS_MAX = 1 * 1024 * 1024; // лимит GitHub Contents API ~1 МБ
if (!fs.existsSync(ARTIFACT_DIR)) {
    try { fs.mkdirSync(ARTIFACT_DIR, { recursive: true }); } catch (e) { console.warn("[ARTIFACT] Не удалось создать папку:", e.message); }
}
// Доставка активна, только если заданы и URL, и токен эндпоинта
const ARTIFACT_DELIVERY_ENABLED = !!(PUBLIC_URL && ARTIFACT_TOKEN);
const GITHUB_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);
// ==========================================
// MINIO (Northflank Storage Addon) — все NF_STORAGE_* переменные
// ==========================================
const MINIO_ENABLED = minioStorage.ENABLED;
(async () => {
    if (MINIO_ENABLED) {
        const ok = await minioStorage.ensureBucket();
        console.log(`[MINIO] Инициализация bucket: ${ok ? 'OK' : 'ОШИБКА'}`);
    } else {
        console.log('[MINIO] Отключён (нет NF_STORAGE_ACCESS_KEY / HOST / ENDPOINT)');
    }
})();
let genAI = null;
let geminiHistory = [];          // история обычного чата
let adminMode = false;
let adminHistory = [];           // отдельная история для режима администратора
let githubHistory = [];          // история сессии /github (для продолжения после лимита итераций)
let githubSessionActive = false; // true, если предыдущий /github не завершил задачу (лимит/ошибка)
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
// Инструкции GitHub (подключаются только по команде /github, чтобы не раздувать контекст)
let githubSystemPrompt = "";
try {
    githubSystemPrompt = fs.readFileSync(path.join(__dirname, 'github.md'), 'utf8').trim();
    console.log("[SYSTEM] Инструкции GitHub загружены из github.md");
} catch (e) {
    console.warn("[SYSTEM] github.md не найден — инструмент github_ops будет без подробных инструкций");
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
// GITHUB OPS — полноценная работа с репозиторием (Contents API)
// ==========================================
function githubApiHeaders() {
    return {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'northflank-github-ops',
        'Content-Type': 'application/json'
    };
}
function normalizeRepoPath(p) {
    if (!p) return '';
    return String(p).replace(/^\/+/, '').replace(/\/+/g, '/');
}
async function githubOps(args) {
    const action = String(args.action || '').toLowerCase();
    const branch = (args.branch && String(args.branch).trim()) || GITHUB_BRANCH || 'main';
    const pathInRepo = normalizeRepoPath(args.path || '');

    if (action === 'status') {
        return JSON.stringify({
            ok: true,
            enabled: GITHUB_ENABLED,
            repo: GITHUB_ENABLED ? GITHUB_REPO : null,
            branch: GITHUB_BRANCH,
            path_prefix: GITHUB_PATH_PREFIX,
            contents_max_bytes: GITHUB_CONTENTS_MAX,
            reason: GITHUB_ENABLED ? 'GitHub настроен' : 'GITHUB_TOKEN и/или GITHUB_REPO не заданы'
        }, null, 2);
    }

    if (!GITHUB_ENABLED) {
        return JSON.stringify({ ok: false, error: 'GitHub не настроен: нужны env GITHUB_TOKEN и GITHUB_REPO' });
    }

    const base = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

    try {
        if (action === 'list') {
            const url = pathInRepo ? `${base}/${pathInRepo}?ref=${encodeURIComponent(branch)}` : `${base}?ref=${encodeURIComponent(branch)}`;
            const resp = await axios.get(url, { headers: githubApiHeaders(), timeout: 30000 });
            const data = resp.data;
            if (Array.isArray(data)) {
                const items = data.map(f => ({
                    name: f.name,
                    path: f.path,
                    type: f.type,
                    size: f.size,
                    sha: f.sha,
                    html_url: f.html_url
                }));
                return JSON.stringify({ ok: true, branch, path: pathInRepo || '/', count: items.length, items }, null, 2);
            }
            // одиночный файл, если path указывает на файл
            return JSON.stringify({
                ok: true,
                branch,
                item: {
                    name: data.name,
                    path: data.path,
                    type: data.type,
                    size: data.size,
                    sha: data.sha,
                    html_url: data.html_url,
                    encoding: data.encoding
                }
            }, null, 2);
        }

        if (action === 'get') {
            if (!pathInRepo) return JSON.stringify({ ok: false, error: 'path обязателен для get' });
            const url = `${base}/${pathInRepo}?ref=${encodeURIComponent(branch)}`;
            const resp = await axios.get(url, { headers: githubApiHeaders(), timeout: 30000 });
            const data = resp.data;
            if (data.type === 'dir' || Array.isArray(data)) {
                return JSON.stringify({ ok: false, error: 'path указывает на директорию — используй action=list' });
            }
            let textContent = null;
            if (data.encoding === 'base64' && data.content) {
                const buf = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
                // текстовый, если выглядит как UTF-8 без нулей
                const sample = buf.subarray(0, Math.min(buf.length, 4096));
                const hasNull = sample.includes(0);
                if (!hasNull && data.size <= 512 * 1024) {
                    try { textContent = buf.toString('utf8'); } catch (_) { textContent = null; }
                }
            }
            return JSON.stringify({
                ok: true,
                path: data.path,
                sha: data.sha,
                size: data.size,
                html_url: data.html_url,
                download_url: data.download_url,
                encoding: data.encoding,
                content: textContent,
                note: textContent === null ? 'Бинарный или слишком большой файл — content не декодирован. Используй download_to_server.' : undefined
            }, null, 2);
        }

        if (action === 'put') {
            if (!pathInRepo) return JSON.stringify({ ok: false, error: 'path обязателен для put' });
            let contentB64;
            if (args.local_path) {
                const lp = String(args.local_path);
                if (!fs.existsSync(lp)) return JSON.stringify({ ok: false, error: `Локальный файл не найден: ${lp}` });
                const st = fs.statSync(lp);
                if (st.size > GITHUB_CONTENTS_MAX) {
                    return JSON.stringify({ ok: false, error: `Файл ${st.size} байт превышает лимит Contents API (~1 МБ)` });
                }
                contentB64 = fs.readFileSync(lp).toString('base64');
            } else if (args.content !== undefined && args.content !== null) {
                if (args.is_binary) {
                    contentB64 = String(args.content).replace(/\s/g, '');
                } else {
                    contentB64 = Buffer.from(String(args.content), 'utf8').toString('base64');
                }
                if (Buffer.from(contentB64, 'base64').length > GITHUB_CONTENTS_MAX) {
                    return JSON.stringify({ ok: false, error: 'Содержимое превышает лимит Contents API (~1 МБ)' });
                }
            } else {
                return JSON.stringify({ ok: false, error: 'Нужен content или local_path' });
            }
            const body = {
                message: (args.message && String(args.message).trim()) || `update: ${pathInRepo}`,
                content: contentB64,
                branch
            };
            if (args.sha) body.sha = String(args.sha);
            const url = `${base}/${pathInRepo}`;
            const resp = await axios.put(url, body, { headers: githubApiHeaders(), timeout: 60000 });
            const c = resp.data && resp.data.content;
            return JSON.stringify({
                ok: true,
                action: args.sha ? 'updated' : 'created',
                path: c && c.path,
                sha: c && c.sha,
                html_url: c && c.html_url,
                commit: resp.data && resp.data.commit && (resp.data.commit.html_url || resp.data.commit.sha)
            }, null, 2);
        }

        if (action === 'delete') {
            if (!pathInRepo) return JSON.stringify({ ok: false, error: 'path обязателен для delete' });
            if (!args.sha) return JSON.stringify({ ok: false, error: 'sha обязателен для delete (получи через get/list)' });
            const body = {
                message: (args.message && String(args.message).trim()) || `delete: ${pathInRepo}`,
                sha: String(args.sha),
                branch
            };
            const url = `${base}/${pathInRepo}`;
            const resp = await axios.delete(url, { headers: githubApiHeaders(), data: body, timeout: 30000 });
            return JSON.stringify({
                ok: true,
                deleted: pathInRepo,
                commit: resp.data && resp.data.commit && (resp.data.commit.html_url || resp.data.commit.sha)
            }, null, 2);
        }

        if (action === 'download_to_server') {
            if (!pathInRepo && !args.url) {
                return JSON.stringify({ ok: false, error: 'Нужен path (в репо) или url' });
            }
            let downloadUrl = args.url ? String(args.url) : null;
            let suggestedName = path.basename(pathInRepo) || `gh_${Date.now()}`;
            if (!downloadUrl) {
                const metaUrl = `${base}/${pathInRepo}?ref=${encodeURIComponent(branch)}`;
                const meta = await axios.get(metaUrl, { headers: githubApiHeaders(), timeout: 30000 });
                if (!meta.data || !meta.data.download_url) {
                    return JSON.stringify({ ok: false, error: 'Не удалось получить download_url (возможно, это директория)' });
                }
                downloadUrl = meta.data.download_url;
                suggestedName = meta.data.name || suggestedName;
            }
            const safeName = suggestedName.replace(/[^a-zA-Z0-9.\-_]/g, '_') || `gh_${Date.now()}`;
            const savePath = args.local_path
                ? String(args.local_path)
                : path.join(TMP_DIR, safeName);
            // гарантируем родительскую папку
            fs.mkdirSync(path.dirname(savePath), { recursive: true });
            const fileResp = await axios.get(downloadUrl, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'northflank-github-ops', 'Accept': 'application/octet-stream' },
                timeout: 120000,
                maxContentLength: 80 * 1024 * 1024
            });
            fs.writeFileSync(savePath, Buffer.from(fileResp.data));
            const st = fs.statSync(savePath);
            return JSON.stringify({
                ok: true,
                path: savePath,
                size: st.size,
                size_kb: +(st.size / 1024).toFixed(1),
                source: downloadUrl.replace(/https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\//, 'raw://')
            }, null, 2);
        }

        if (action === 'create_artifact') {
            const lp = args.local_path ? String(args.local_path) : '';
            if (!lp || !fs.existsSync(lp)) {
                return JSON.stringify({ ok: false, error: `local_path обязателен и должен существовать: ${lp || '(пусто)'}` });
            }
            const st = fs.statSync(lp);
            if (st.size > GITHUB_CONTENTS_MAX) {
                return JSON.stringify({ ok: false, error: `Файл ${st.size} байт превышает лимит Contents API (~1 МБ). Разбейте или используйте другой способ доставки.` });
            }
            const safeName = path.basename(lp).replace(/[^a-zA-Z0-9.\-_]/g, '_') || 'artifact.bin';
            let repoPath;
            if (pathInRepo) {
                repoPath = pathInRepo;
            } else {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
                const prefix = (GITHUB_PATH_PREFIX || 'artifacts/').replace(/\/+$/, '');
                repoPath = `${prefix}/${stamp}_${safeName}`;
            }
            const b64 = fs.readFileSync(lp).toString('base64');
            const body = {
                message: (args.message && String(args.message).trim()) || `artifact: ${safeName}`,
                content: b64,
                branch
            };
            // если файл уже есть — подтянуть sha для обновления
            try {
                const exist = await axios.get(`${base}/${repoPath}?ref=${encodeURIComponent(branch)}`, {
                    headers: githubApiHeaders(), timeout: 15000
                });
                if (exist.data && exist.data.sha) body.sha = exist.data.sha;
            } catch (_) { /* 404 — создаём новый */ }
            const resp = await axios.put(`${base}/${repoPath}`, body, {
                headers: githubApiHeaders(), timeout: 60000
            });
            const c = resp.data && resp.data.content;
            return JSON.stringify({
                ok: true,
                path: c && c.path,
                sha: c && c.sha,
                html_url: c && c.html_url,
                size: st.size,
                local_path: lp,
                commit: resp.data && resp.data.commit && (resp.data.commit.html_url || resp.data.commit.sha)
            }, null, 2);
        }

        // ---------- GitHub Actions ----------
        const actionsBase = `https://api.github.com/repos/${GITHUB_REPO}/actions`;

        if (action === 'list_workflows') {
            const resp = await axios.get(`${actionsBase}/workflows?per_page=50`, {
                headers: githubApiHeaders(), timeout: 30000
            });
            const workflows = (resp.data.workflows || []).map(w => ({
                id: w.id,
                name: w.name,
                path: w.path,
                state: w.state,
                html_url: w.html_url
            }));
            return JSON.stringify({ ok: true, count: workflows.length, workflows }, null, 2);
        }

        if (action === 'trigger_workflow') {
            // workflow_id — числовой id или имя файла (build-esp32s3.yml / build-esp32s3.yaml)
            let workflowId = args.workflow_id || args.workflow || args.path;
            if (!workflowId) {
                return JSON.stringify({ ok: false, error: 'Нужен workflow_id (id или имя файла .yml)' });
            }
            workflowId = String(workflowId);
            const ref = branch;
            const inputs = (args.inputs && typeof args.inputs === 'object') ? args.inputs : undefined;
            const body = { ref };
            if (inputs) body.inputs = inputs;
            const url = `${actionsBase}/workflows/${encodeURIComponent(workflowId)}/dispatches`;
            await axios.post(url, body, { headers: githubApiHeaders(), timeout: 30000 });
            return JSON.stringify({
                ok: true,
                triggered: true,
                workflow: workflowId,
                ref,
                note: 'Dispatch принят (HTTP 204). Через 5–15 сек появится run — используй list_runs.'
            }, null, 2);
        }

        if (action === 'list_runs') {
            const params = new URLSearchParams();
            params.set('per_page', String(Math.min(parseInt(args.per_page, 10) || 10, 30)));
            if (args.workflow_id || args.workflow) params.set('path', ''); // filtered below if needed
            if (branch) params.set('branch', branch);
            if (args.status) params.set('status', String(args.status)); // queued|in_progress|completed
            let url = `${actionsBase}/runs?${params.toString()}`;
            if (args.workflow_id || args.workflow) {
                const wf = encodeURIComponent(String(args.workflow_id || args.workflow));
                url = `${actionsBase}/workflows/${wf}/runs?per_page=${params.get('per_page')}`;
                if (branch) url += `&branch=${encodeURIComponent(branch)}`;
                if (args.status) url += `&status=${encodeURIComponent(String(args.status))}`;
            }
            const resp = await axios.get(url, { headers: githubApiHeaders(), timeout: 30000 });
            const runs = (resp.data.workflow_runs || []).map(r => ({
                id: r.id,
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                event: r.event,
                head_branch: r.head_branch,
                html_url: r.html_url,
                created_at: r.created_at,
                updated_at: r.updated_at,
                artifacts_url: r.artifacts_url
            }));
            return JSON.stringify({ ok: true, total_count: resp.data.total_count, runs }, null, 2);
        }

        if (action === 'list_artifacts') {
            let url;
            if (args.run_id) {
                url = `${actionsBase}/runs/${encodeURIComponent(String(args.run_id))}/artifacts?per_page=30`;
            } else {
                url = `${actionsBase}/artifacts?per_page=20`;
            }
            const resp = await axios.get(url, { headers: githubApiHeaders(), timeout: 30000 });
            const artifacts = (resp.data.artifacts || []).map(a => ({
                id: a.id,
                name: a.name,
                size_in_bytes: a.size_in_bytes,
                expired: a.expired,
                created_at: a.created_at,
                workflow_run: a.workflow_run ? { id: a.workflow_run.id, head_branch: a.workflow_run.head_branch } : null,
                archive_download_url: a.archive_download_url
            }));
            return JSON.stringify({ ok: true, total_count: resp.data.total_count, artifacts }, null, 2);
        }

        if (action === 'download_artifact') {
            const artifactId = args.artifact_id || args.id;
            if (!artifactId) {
                return JSON.stringify({ ok: false, error: 'Нужен artifact_id (из list_artifacts)' });
            }
            // GitHub отдаёт 302 на временный URL архива (zip)
            const metaUrl = `${actionsBase}/artifacts/${encodeURIComponent(String(artifactId))}/zip`;
            const resp = await axios.get(metaUrl, {
                headers: githubApiHeaders(),
                responseType: 'arraybuffer',
                timeout: 180000,
                maxContentLength: 100 * 1024 * 1024,
                maxRedirects: 5
            });
            const zipName = `artifact_${artifactId}.zip`;
            const savePath = args.local_path
                ? String(args.local_path)
                : path.join(TMP_DIR, zipName);
            fs.mkdirSync(path.dirname(savePath), { recursive: true });
            fs.writeFileSync(savePath, Buffer.from(resp.data));
            const st = fs.statSync(savePath);

            // Попытка распаковать, если есть unzip
            let extracted = [];
            let extractDir = null;
            try {
                extractDir = path.join(TMP_DIR, `artifact_${artifactId}_unpacked`);
                fs.mkdirSync(extractDir, { recursive: true });
                await execPromise(`unzip -o -q "${savePath}" -d "${extractDir}"`, { timeout: 60000 });
                const walk = (dir, base = '') => {
                    for (const name of fs.readdirSync(dir)) {
                        const full = path.join(dir, name);
                        const rel = base ? `${base}/${name}` : name;
                        if (fs.statSync(full).isDirectory()) walk(full, rel);
                        else extracted.push({ path: full, rel, size: fs.statSync(full).size });
                    }
                };
                walk(extractDir);
            } catch (unzipErr) {
                extracted = [];
                extractDir = null;
            }

            // Если просили конкретный файл (например firmware.bin) — найти и скопировать
            let binPath = null;
            if (args.file_name && extracted.length) {
                const want = String(args.file_name).toLowerCase();
                const hit = extracted.find(e => e.rel.toLowerCase().endsWith(want) || path.basename(e.rel).toLowerCase() === want);
                if (hit) {
                    binPath = path.join(TMP_DIR, path.basename(hit.rel).replace(/[^a-zA-Z0-9.\-_]/g, '_'));
                    fs.copyFileSync(hit.path, binPath);
                }
            } else if (extracted.length === 1) {
                binPath = path.join(TMP_DIR, path.basename(extracted[0].rel).replace(/[^a-zA-Z0-9.\-_]/g, '_'));
                fs.copyFileSync(extracted[0].path, binPath);
            } else if (extracted.length) {
                const binHit = extracted.find(e => /\.(bin|elf|hex|uf2)$/i.test(e.rel));
                if (binHit) {
                    binPath = path.join(TMP_DIR, path.basename(binHit.rel).replace(/[^a-zA-Z0-9.\-_]/g, '_'));
                    fs.copyFileSync(binHit.path, binPath);
                }
            }

            return JSON.stringify({
                ok: true,
                zip_path: savePath,
                zip_size: st.size,
                extract_dir: extractDir,
                files: extracted.map(e => ({ rel: e.rel, path: e.path, size: e.size })),
                bin_path: binPath,
                note: binPath
                    ? `Готовый файл: ${binPath} — можно отправить через send_file_to_telegram`
                    : 'Архив скачан. Укажите file_name для извлечения конкретного файла или используйте zip_path.'
            }, null, 2);
        }

        if (action === 'wait_run') {
            // Опрос статуса run до completed или таймаута (сек)
            const runId = args.run_id;
            if (!runId) return JSON.stringify({ ok: false, error: 'Нужен run_id' });
            const timeoutSec = Math.min(parseInt(args.timeout_sec, 10) || 180, 300);
            const intervalSec = Math.min(parseInt(args.interval_sec, 10) || 8, 30);
            const deadline = Date.now() + timeoutSec * 1000;
            let last = null;
            while (Date.now() < deadline) {
                const resp = await axios.get(`${actionsBase}/runs/${encodeURIComponent(String(runId))}`, {
                    headers: githubApiHeaders(), timeout: 20000
                });
                last = {
                    id: resp.data.id,
                    status: resp.data.status,
                    conclusion: resp.data.conclusion,
                    html_url: resp.data.html_url,
                    updated_at: resp.data.updated_at
                };
                if (resp.data.status === 'completed') {
                    return JSON.stringify({ ok: true, finished: true, run: last }, null, 2);
                }
                await new Promise(r => setTimeout(r, intervalSec * 1000));
            }
            return JSON.stringify({
                ok: true,
                finished: false,
                run: last,
                note: `Таймаут ${timeoutSec}с — run ещё не completed. Вызови wait_run или list_runs снова.`
            }, null, 2);
        }

        return JSON.stringify({
            ok: false,
            error: `Неизвестное action: ${action}. Допустимо: status, list, get, put, delete, download_to_server, create_artifact, list_workflows, trigger_workflow, list_runs, list_artifacts, download_artifact, wait_run`
        });
    } catch (err) {
        const status = err.response && err.response.status;
        const detail = (err.response && err.response.data && (err.response.data.message || JSON.stringify(err.response.data))) || err.message;
        console.error('[GITHUB_OPS ERROR]', action, detail);
        return JSON.stringify({ ok: false, status: status || null, error: detail });
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
async function getCronPattern(humanText, modelName) {
    // Используем выбранную в чате модель; fallback — актуальная flash-модель (gemini-2.5-flash уже недоступна новым пользователям)
    const modelId = (modelName && String(modelName).trim()) || "gemini-2.0-flash";
    const model = genAI.getGenerativeModel({ model: modelId });
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
            const modelName = job.model || "gemini-2.0-flash";
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
        // === MINIO: постоянное хранилище (6 ГБ на Northflank) ===
        let minio = { ok: false, skipped: true, reason: "MinIO не настроен" };
        if (MINIO_ENABLED) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
            const objectKey = `${stamp}_${safeName}`;
            minio = await minioStorage.uploadFile(savePath, objectKey, {
                contentType: 'application/octet-stream',
                'x-amz-meta-source': 'artifact-endpoint'
            });
        }
        res.json({ ok: true, path: savePath, size: bytes, github: github, minio: minio });
    });
    writer.on('error', (e) => {
        console.error("[ARTIFACT WRITE ERROR]", e.message);
        if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    });
});

// ==========================================
// FILE UPLOAD (raw binary, без base64) — FM / APK
// POST /file-upload?token=PROXY_SECRET
// Headers:
//   X-Filename: оригинальное имя
//   X-Dest: fs | minio
//   X-Path: полный путь FS (/tmp/a.bin) или ключ MinIO (folder/a.bin)
//   Content-Type: application/octet-stream
// Body: сырые байты файла
// ==========================================
const FILE_UPLOAD_MAX = parseInt(process.env.FILE_UPLOAD_MAX || String(512 * 1024 * 1024), 10); // 512 МБ по умолчанию

function sanitizeUploadName(raw) {
    let name = path.basename(String(raw || 'upload.bin'));
    name = name.replace(/[\x00-\x1f\\/<>:"|?*]/g, '_').replace(/_+/g, '_').trim();
    if (!name || name === '.' || name === '..') name = 'upload.bin';
    return name;
}

app.post('/file-upload', (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const dest = String(req.get('x-dest') || req.query.dest || 'fs').toLowerCase();
    let filename = sanitizeUploadName(req.get('x-filename') || req.query.name || 'upload.bin');
    let targetPath = String(req.get('x-path') || req.query.path || '').trim();

    // FS: если X-Path — директория или пусто → /tmp/filename; если путь с именем — используем его
    let savePath;
    let minioKey = '';
    if (dest === 'minio') {
        if (!MINIO_ENABLED) return res.status(503).json({ ok: false, error: 'MinIO disabled' });
        minioKey = targetPath.replace(/^\/+/, '');
        if (!minioKey || minioKey.endsWith('/')) minioKey = (minioKey || '') + filename;
        // временный файл на диск, потом в MinIO
        savePath = path.join(TMP_DIR, 'up_' + Date.now() + '_' + filename.replace(/[^\w.\-]+/g, '_'));
    } else {
        if (targetPath && !targetPath.endsWith('/')) {
            // полный путь к файлу
            savePath = path.resolve(targetPath);
            filename = path.basename(savePath);
        } else {
            const dir = targetPath && targetPath.endsWith('/') ? targetPath.slice(0, -1) : (targetPath || TMP_DIR);
            const resolvedDir = path.resolve(dir || TMP_DIR);
            savePath = path.join(resolvedDir, filename);
        }
        // не даём выйти совсем в произвольные места через .. — мягкая проверка
        if (savePath.indexOf('\0') >= 0) {
            return res.status(400).json({ ok: false, error: 'bad path' });
        }
        try { fs.mkdirSync(path.dirname(savePath), { recursive: true }); } catch (_) {}
    }

    let bytes = 0;
    let aborted = false;
    const writer = fs.createWriteStream(savePath);

    req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > FILE_UPLOAD_MAX && !aborted) {
            aborted = true;
            req.destroy();
            writer.close();
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    });
    req.pipe(writer);

    writer.on('finish', async () => {
        if (aborted) {
            return res.status(413).json({
                ok: false,
                error: `Файл слишком большой (лимит ${Math.floor(FILE_UPLOAD_MAX / 1024 / 1024)} МБ). Env FILE_UPLOAD_MAX`
            });
        }
        try {
            if (dest === 'minio') {
                const result = await minioStorage.uploadFile(savePath, minioKey, {
                    contentType: req.get('content-type') || 'application/octet-stream'
                });
                try { fs.unlinkSync(savePath); } catch (_) {}
                if (!result.ok) return res.status(500).json(result);
                console.log(`[FILE-UPLOAD] MinIO ${minioKey} (${bytes} bytes)`);
                return res.json({
                    ok: true,
                    dest: 'minio',
                    key: result.key || minioKey,
                    filename,
                    size: bytes
                });
            }
            console.log(`[FILE-UPLOAD] FS ${savePath} (${bytes} bytes)`);
            return res.json({
                ok: true,
                dest: 'fs',
                path: savePath,
                filename,
                size: bytes
            });
        } catch (e) {
            try { fs.unlinkSync(savePath); } catch (_) {}
            console.error('[FILE-UPLOAD]', e.message);
            return res.status(500).json({ ok: false, error: e.message });
        }
    });
    writer.on('error', (e) => {
        try { fs.unlinkSync(savePath); } catch (_) {}
        if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    });
});

// ==========================================
// MINIO API ENDPOINTS
// ==========================================
app.get('/minio/status', async (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const st = await minioStorage.status();
    res.json(st);
});

app.get('/minio/list', async (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const prefix = req.query.prefix || undefined;
    const result = await minioStorage.listObjects(prefix);
    res.json(result);
});

app.get('/minio/download', async (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const key = req.query.key;
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    try {
        const stream = await minioStorage.getObjectStream(key);
        const filename = path.basename(key);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        stream.pipe(res);
    } catch (err) {
        res.status(404).json({ ok: false, error: err.message });
    }
});

app.get('/minio/presign', async (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const key = req.query.key;
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    const expires = parseInt(req.query.expires || '3600', 10);
    const result = await minioStorage.presignedGet(key, expires);
    res.json(result);
});

app.post('/minio/upload', async (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (!MINIO_ENABLED) return res.status(503).json({ ok: false, error: 'MinIO disabled' });

    let rawName = String(req.get('x-filename') || req.query.name || 'upload.bin');
    let safeName = path.basename(rawName).replace(/[\x00-\x1f\\/<>:"|?*]/g, '_').replace(/_+/g, '_').trim() || 'upload.bin';
    if (safeName === '.' || safeName === '..') safeName = 'upload.bin';
    const tmpPath = path.join(TMP_DIR, `minio_up_${Date.now()}_${safeName}`);

    let bytes = 0; let aborted = false;
    const writer = fs.createWriteStream(tmpPath);
    req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > ARTIFACT_MAX && !aborted) {
            aborted = true; req.destroy(); writer.close();
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
    });
    req.pipe(writer);
    writer.on('finish', async () => {
        if (aborted) return res.status(413).json({ ok: false, error: 'File too large' });
        // имя: query.key / body не используется (raw stream); сохраняем оригинальное имя
        const objectKey = String(req.query.key || req.get('x-object-key') || safeName).replace(/^\/+/, '');
        const result = await minioStorage.uploadFile(tmpPath, objectKey, {
            contentType: req.get('content-type') || 'application/octet-stream'
        });
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        res.json(result);
    });
    writer.on('error', (e) => {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    });
});

// ==========================================
// MINIO JSON API (для FileManager: list/upload/delete/mkdir/move/copy/to_tmp/...)
// ==========================================
app.post('/minio', async (req, res) => {
    if (req.query.token !== PROXY_SECRET && req.query.token !== ARTIFACT_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (!MINIO_ENABLED) {
        return res.status(503).json({ ok: false, error: 'MinIO disabled (нет NF_STORAGE_*)' });
    }
    const op = String(req.body.op || req.body.action || '').toLowerCase();
    const PREFIX = minioStorage.PREFIX || '';
    const BUCKET = minioStorage.BUCKET;
    const client = minioStorage.client;

    function fullKey(k) {
        k = String(k || '').replace(/^\/+/, '');
        if (!k) return PREFIX;
        if (PREFIX && k.startsWith(PREFIX)) return k;
        return PREFIX + k;
    }
    function relKey(k) {
        k = String(k || '');
        if (PREFIX && k.startsWith(PREFIX)) return k.substring(PREFIX.length);
        return k;
    }

    try {
        if (op === 'status') {
            const st = await minioStorage.status();
            return res.json(st);
        }

        if (op === 'list') {
            let prefix = String(req.body.prefix || req.query.prefix || '');
            prefix = prefix.replace(/^\/+/, '');
            const listPrefix = prefix ? fullKey(prefix.endsWith('/') ? prefix : prefix + '/') : PREFIX;
            // non-recursive listing by delimiter is not exposed; use recursive and group on client
            const result = await minioStorage.listObjects(listPrefix, true);
            if (!result.ok) return res.json(result);
            const items = (result.items || []).map(it => ({
                name: relKey(it.name),
                key: relKey(it.name),
                size: it.size || 0,
                lastModified: it.lastModified,
                etag: it.etag
            }));
            const used = typeof result.used === 'number'
                ? result.used
                : items.reduce((s, it) => s + (it.size || 0), 0);
            const quota = (typeof result.quota === 'number' ? result.quota : minioStorage.QUOTA) || 0;
            return res.json({
                ok: true,
                count: items.length,
                items,
                prefix: relKey(listPrefix),
                bucket: BUCKET,
                used,
                quota,
                free: Math.max(0, quota - used),
                total: quota
            });
        }

        if (op === 'upload') {
            const keyIn = String(req.body.key || req.body.filename || '');
            if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
            const b64 = req.body.b64;
            if (b64 === undefined || b64 === null) return res.status(400).json({ ok: false, error: 'b64 required' });
            const buf = Buffer.from(String(b64), 'base64');
            const contentType = req.body.contentType || req.body.content_type || 'application/octet-stream';
            const result = await minioStorage.uploadBuffer(buf, fullKey(keyIn), { contentType });
            if (result.ok) result.key = relKey(result.key);
            return res.json(result);
        }

        if (op === 'upload_from_server') {
            const localPath = String(req.body.local_path || req.body.path || '');
            const keyIn = String(req.body.key || path.basename(localPath));
            if (!localPath || !fs.existsSync(localPath)) {
                return res.status(400).json({ ok: false, error: 'local_path not found: ' + localPath });
            }
            const result = await minioStorage.uploadFile(localPath, fullKey(keyIn), {
                contentType: req.body.contentType || 'application/octet-stream'
            });
            if (result.ok) result.key = relKey(result.key);
            return res.json(result);
        }

        if (op === 'to_tmp' || op === 'download') {
            const keyIn = String(req.body.key || '');
            if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
            let localPath = String(req.body.local_path || '');
            if (!localPath) {
                const base = path.basename(keyIn.replace(/\/+$/, '')) || ('minio_' + Date.now());
                localPath = path.join(TMP_DIR, base);
            }
            const result = await minioStorage.downloadToFile(fullKey(keyIn), localPath);
            if (result.ok) result.key = relKey(result.key);
            return res.json(result);
        }

        if (op === 'delete' || op === 'remove') {
            let keys = req.body.keys;
            if (!keys && req.body.key) keys = [req.body.key];
            if (!Array.isArray(keys) || keys.length === 0) {
                return res.status(400).json({ ok: false, error: 'key/keys required' });
            }
            const results = [];
            for (const k of keys) {
                const kk = String(k);
                // if "folder" (ends with /) — delete all under prefix
                if (kk.endsWith('/')) {
                    const list = await minioStorage.listObjects(fullKey(kk), true);
                    if (list.ok && list.items) {
                        for (const it of list.items) {
                            results.push(await minioStorage.removeObject(it.name));
                        }
                    }
                    // also try remove marker if any
                    results.push(await minioStorage.removeObject(fullKey(kk)));
                } else {
                    results.push(await minioStorage.removeObject(fullKey(kk)));
                }
            }
            const failed = results.filter(r => !r.ok);
            return res.json({
                ok: failed.length === 0,
                deleted: results.filter(r => r.ok).length,
                error: failed.length ? failed[0].error : undefined
            });
        }

        if (op === 'mkdir') {
            let keyIn = String(req.body.key || req.body.prefix || '');
            if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
            if (!keyIn.endsWith('/')) keyIn += '/';
            // S3 "folder" = zero-byte object with trailing slash
            const result = await minioStorage.uploadBuffer(Buffer.alloc(0), fullKey(keyIn), {
                contentType: 'application/x-directory'
            });
            if (result.ok) result.key = relKey(result.key);
            return res.json(result);
        }

        if (op === 'presign') {
            const keyIn = String(req.body.key || '');
            if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
            const expiry = parseInt(req.body.expiry || req.body.expires || '3600', 10);
            return res.json(await minioStorage.presignedGet(fullKey(keyIn), expiry));
        }

        if (op === 'copy' || op === 'move') {
            const from = String(req.body.from || req.body.key || '');
            const to = String(req.body.to || req.body.dest || '');
            if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to required' });
            const srcKey = fullKey(from);
            const dstKey = fullKey(to);
            try {
                // minio-js: copyObject(bucket, object, sourceObject)
                await client.copyObject(BUCKET, dstKey, '/' + BUCKET + '/' + srcKey);
                if (op === 'move') {
                    await minioStorage.removeObject(srcKey);
                }
                return res.json({ ok: true, from: relKey(srcKey), to: relKey(dstKey), op });
            } catch (err) {
                // fallback: download + upload for small files
                try {
                    const tmp = path.join(TMP_DIR, 'minio_mv_' + Date.now());
                    const dl = await minioStorage.downloadToFile(srcKey, tmp);
                    if (!dl.ok) return res.json(dl);
                    const up = await minioStorage.uploadFile(tmp, dstKey);
                    try { fs.unlinkSync(tmp); } catch (_) {}
                    if (!up.ok) return res.json(up);
                    if (op === 'move') await minioStorage.removeObject(srcKey);
                    return res.json({ ok: true, from: relKey(srcKey), to: relKey(dstKey), op, via: 'download-upload' });
                } catch (e2) {
                    return res.json({ ok: false, error: err.message || e2.message });
                }
            }
        }

        return res.status(400).json({ ok: false, error: 'Unknown minio op: ' + op });
    } catch (err) {
        console.error('[MINIO API]', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ==========================================
// МАРШРУТ УПРАВЛЕНИЯ И GEMINI
// ==========================================
app.post('/gemini', async (req, res) => {
    if (req.query.token !== PROXY_SECRET) return res.status(403).json({ok: false, error: "Auth failed"});
    // MinIO ops from FileManager (тот же payload, что и POST /minio)
    if (req.body.action === 'minio') {
        // переиспользуем тот же код через внутренний вызов: просто проксируем логику
        req.url = '/minio?token=' + encodeURIComponent(PROXY_SECRET);
        // inline dispatch
        const op = String(req.body.op || '').toLowerCase();
        if (!MINIO_ENABLED) return res.status(503).json({ ok: false, error: 'MinIO disabled (нет NF_STORAGE_*)' });
        const PREFIX = minioStorage.PREFIX || '';
        const BUCKET = minioStorage.BUCKET;
        const client = minioStorage.client;
        function fullKey(k) {
            k = String(k || '').replace(/^\/+/, '');
            if (!k) return PREFIX;
            if (PREFIX && k.startsWith(PREFIX)) return k;
            return PREFIX + k;
        }
        function relKey(k) {
            k = String(k || '');
            if (PREFIX && k.startsWith(PREFIX)) return k.substring(PREFIX.length);
            return k;
        }
        try {
            if (op === 'status') return res.json(await minioStorage.status());
            if (op === 'list') {
                let prefix = String(req.body.prefix || '');
                prefix = prefix.replace(/^\/+/, '');
                const listPrefix = prefix ? fullKey(prefix.endsWith('/') ? prefix : prefix + '/') : PREFIX;
                const result = await minioStorage.listObjects(listPrefix, true);
                if (!result.ok) return res.json(result);
                const items = (result.items || []).map(it => ({
                    name: relKey(it.name), key: relKey(it.name),
                    size: it.size || 0, lastModified: it.lastModified, etag: it.etag
                }));
                const used = typeof result.used === 'number'
                    ? result.used
                    : items.reduce((s, it) => s + (it.size || 0), 0);
                const quota = (typeof result.quota === 'number' ? result.quota : minioStorage.QUOTA) || 0;
                return res.json({
                    ok: true, count: items.length, items, prefix: relKey(listPrefix), bucket: BUCKET,
                    used, quota, free: Math.max(0, quota - used), total: quota
                });
            }
            if (op === 'upload') {
                const keyIn = String(req.body.key || req.body.filename || '');
                if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
                if (req.body.b64 === undefined || req.body.b64 === null) return res.status(400).json({ ok: false, error: 'b64 required' });
                const buf = Buffer.from(String(req.body.b64), 'base64');
                const result = await minioStorage.uploadBuffer(buf, fullKey(keyIn), {
                    contentType: req.body.contentType || 'application/octet-stream'
                });
                if (result.ok) result.key = relKey(result.key);
                return res.json(result);
            }
            if (op === 'upload_from_server') {
                const localPath = String(req.body.local_path || req.body.path || '');
                const keyIn = String(req.body.key || path.basename(localPath));
                if (!localPath || !fs.existsSync(localPath)) return res.status(400).json({ ok: false, error: 'local_path not found: ' + localPath });
                const result = await minioStorage.uploadFile(localPath, fullKey(keyIn), { contentType: req.body.contentType || 'application/octet-stream' });
                if (result.ok) result.key = relKey(result.key);
                return res.json(result);
            }
            if (op === 'to_tmp' || op === 'download') {
                const keyIn = String(req.body.key || '');
                if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
                let localPath = String(req.body.local_path || '');
                if (!localPath) {
                    const base = path.basename(keyIn.replace(/\/+$/, '')) || ('minio_' + Date.now());
                    localPath = path.join(TMP_DIR, base);
                }
                const result = await minioStorage.downloadToFile(fullKey(keyIn), localPath);
                if (result.ok) result.key = relKey(result.key);
                return res.json(result);
            }
            if (op === 'delete' || op === 'remove') {
                let keys = req.body.keys;
                if (!keys && req.body.key) keys = [req.body.key];
                if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ ok: false, error: 'key/keys required' });
                const results = [];
                for (const k of keys) {
                    const kk = String(k);
                    if (kk.endsWith('/')) {
                        const list = await minioStorage.listObjects(fullKey(kk), true);
                        if (list.ok && list.items) {
                            for (const it of list.items) results.push(await minioStorage.removeObject(it.name));
                        }
                        results.push(await minioStorage.removeObject(fullKey(kk)));
                    } else {
                        results.push(await minioStorage.removeObject(fullKey(kk)));
                    }
                }
                const failed = results.filter(r => !r.ok);
                return res.json({ ok: failed.length === 0, deleted: results.filter(r => r.ok).length, error: failed.length ? failed[0].error : undefined });
            }
            if (op === 'mkdir') {
                let keyIn = String(req.body.key || req.body.prefix || '');
                if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
                if (!keyIn.endsWith('/')) keyIn += '/';
                const result = await minioStorage.uploadBuffer(Buffer.alloc(0), fullKey(keyIn), { contentType: 'application/x-directory' });
                if (result.ok) result.key = relKey(result.key);
                return res.json(result);
            }
            if (op === 'presign') {
                const keyIn = String(req.body.key || '');
                if (!keyIn) return res.status(400).json({ ok: false, error: 'key required' });
                const expiry = parseInt(req.body.expiry || req.body.expires || '3600', 10);
                return res.json(await minioStorage.presignedGet(fullKey(keyIn), expiry));
            }
            if (op === 'copy' || op === 'move') {
                const from = String(req.body.from || req.body.key || '');
                const to = String(req.body.to || req.body.dest || '');
                if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to required' });
                const srcKey = fullKey(from);
                const dstKey = fullKey(to);
                try {
                    const tmp = path.join(TMP_DIR, 'minio_mv_' + Date.now());
                    const dl = await minioStorage.downloadToFile(srcKey, tmp);
                    if (!dl.ok) return res.json(dl);
                    const up = await minioStorage.uploadFile(tmp, dstKey);
                    try { fs.unlinkSync(tmp); } catch (_) {}
                    if (!up.ok) return res.json(up);
                    if (op === 'move') await minioStorage.removeObject(srcKey);
                    return res.json({ ok: true, from: relKey(srcKey), to: relKey(dstKey), op });
                } catch (e2) {
                    return res.json({ ok: false, error: e2.message });
                }
            }
            return res.status(400).json({ ok: false, error: 'Unknown minio op: ' + op });
        } catch (err) {
            console.error('[MINIO][gemini]', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }
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
            let filename = path.basename(String(req.body.filename || 'upload.bin'));
            // сохраняем оригинал: только убираем path-separators и управляющие
            filename = filename.replace(/[\x00-\x1f\\/<>:"|?*]/g, '_').replace(/_+/g, '_').trim() || 'upload.bin';
            if (filename === '.' || filename === '..') filename = 'upload.bin';
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
                pattern = await getCronPattern(payload, req.body.model);
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
            model: req.body.model || "gemini-2.0-flash",
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
<code>/admin off</code> — Выключить режим администратора<br>
<code>/github [задача]</code> — Работа с GitHub (только в режиме admin): создать/править/удалить файлы, артефакты, скачать на сервер<br>
<i>Пример: <code>/github создай файл docs/hello.md с текстом Hello</code></i><br>
<i>GitHub: ${GITHUB_ENABLED ? '<span style="color:green">настроен (' + GITHUB_REPO + ')</span>' : '<span style="color:red">НЕ настроен</span>'}</i><br><br>
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
        githubHistory = [];
        githubSessionActive = false;
        adminAntigravityPrevId = null; adminAntigravityEnvId = null;
        console.log("[ADMIN] Режим администратора ОТКЛЮЧЕН.");
        return res.json({ ok: true, text: "🛑 <b>Режим администратора отключен.</b> Сессия /github также сброшена." });
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
    // /github — задача с подключением инструкций github.md (только в admin-режиме)
    if (userText.startsWith('/github')) {
        if (!adminMode) {
            return res.json({ ok: true, text: "⚠️ Сначала включите режим администратора: <code>/admin on</code>, затем повторите <code>/github …</code>." });
        }
        const ghTask = userText.replace(/^\/github\s*/i, '').trim();
        // Сброс сессии GitHub
        if (/^(clear|reset|новый|сброс)$/i.test(ghTask)) {
            githubHistory = [];
            githubSessionActive = false;
            return res.json({ ok: true, text: "🧹 <b>Сессия /github очищена.</b> Следующий <code>/github …</code> начнётся с нуля." });
        }
        if (!ghTask) {
            const sess = githubHistory.length
                ? `💾 Активная сессия: <b>${githubHistory.length}</b> сообщ.${githubSessionActive ? ' (ожидает продолжения после лимита)' : ''}<br>` +
                  `Продолжить: <code>/github продолжай</code> · Сброс: <code>/github clear</code><br><br>`
                : `Сессия пуста — новый диалог начнётся с первого запроса.<br><br>`;
            return res.json({
                ok: true,
                text: `📦 <b>GitHub-инструмент</b> (${GITHUB_ENABLED ? 'настроен: <code>' + GITHUB_REPO + '</code>' : '<span style="color:red">НЕ настроен</span>'})<br>` +
                    sess +
                    `Использование: <code>/github [что сделать]</code><br>` +
                    `Примеры:<br>` +
                    `• <code>/github покажи корень репозитория</code><br>` +
                    `• <code>/github создай скетч ESP32-S3, workflow PlatformIO, собери, скачай .bin и пришли в Telegram</code><br>` +
                    `• <code>/github продолжай</code> — после лимита итераций<br>` +
                    `• <code>/github clear</code> — сбросить сессию<br><br>` +
                    `Лимит: 50 вызовов инструментов за ход; прогресс сохраняется.`
            });
        }
        // «продолжай» без доп. текста — модель сама подхватит историю
        const taskForModel = /^(продолжай|continue|далее|продолжить)$/i.test(ghTask)
            ? 'Продолжи выполнение предыдущей задачи с того места, где остановился. Не начинай заново — используй уже сделанный прогресс из истории. Если всё уже сделано — кратко сообщи итог.'
            : ghTask;
        return handleAdminMessage(taskForModel, req, res, cronNotificationsHtml, { withGithub: true });
    }
    // Передаем cronNotificationsHtml в функцию администратора
    if (adminMode && userText && !userText.startsWith('/') && !userText.startsWith('!')) {
        return handleAdminMessage(userText, req, res, cronNotificationsHtml);
    }
    const modelName = req.body.model || "gemini-2.0-flash";
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
async function handleAntigravityAdmin(userText, req, res, cronNotificationsHtml = "", withGithub = false) {
    // Antigravity не имеет инструмента github_ops (он доступен только обычным Gemini-моделям в admin).
    // При /github просто добавляем текстовые инструкции; для полноценного GitHub лучше выбрать Gemini Flash.
    let basePrompt = adminSystemPrompt || "Ты — автономный агент-администратор. Выполняй задачу и возвращай краткий результат.";
    if (withGithub && githubSystemPrompt) {
        basePrompt += "\n\n=== РЕЖИМ GITHUB ===\n" + githubSystemPrompt +
            "\n\nВАЖНО: инструмент github_ops доступен только в обычном admin-режиме (модели Gemini Flash / Lite, НЕ Antigravity). " +
            "В Antigravity токен GitHub тебе недоступен — не пытайся его искать. Если нужна запись в репозиторий, попроси пользователя выбрать модель без Antigravity.";
    }
    // НЕБЛОКИРУЮЩИЙ режим: мгновенная заглушка, задача в фоне
    if (antigravityNonBlocking) {
        runAntigravityInBackground({
            mode: 'admin',
            input: userText,
            systemInstruction: getAntigravitySystemInstruction(basePrompt)
        });
        let stub = "✅ <b>Задача Antigravity принята в фоновый режим.</b><br>Прогресс и итоговый результат появятся во входящих (📬 Планировщик). Следите за блоками прогресса — они приходят каждые ~10 секунд.";
        if (withGithub) {
            stub += "<br><br>ℹ️ <b>Подсказка:</b> полноценный <code>github_ops</code> работает на моделях <b>Gemini Flash / Lite</b> (не Antigravity).";
        }
        if (cronNotificationsHtml) stub = cronNotificationsHtml + '<br>' + stub;
        return res.json({ ok: true, text: stub });
    }
    // БЛОКИРУЮЩИЙ режим: ждём завершения и возвращаем в пузыре
    try {
        const ag = await callAntigravityAgent({
            input: userText,
            previousInteractionId: adminAntigravityPrevId,
            environmentId: adminAntigravityEnvId,
            systemInstruction: getAntigravitySystemInstruction(basePrompt),
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
async function handleAdminMessage(userText, req, res, cronNotificationsHtml = "", options = {}) {
    if (!GEMINI_API_KEY) return res.status(500).json({ok: false, error: "Отсутствует GEMINI_API_KEY"});
    const preferredModel = req.body.model || "gemini-2.0-flash";
    const withGithub = !!(options && options.withGithub);
    // --- Antigravity: агент работает через Interactions API со своими инструментами ---
    if (isAntigravityModel(preferredModel)) {
        return handleAntigravityAdmin(userText, req, res, cronNotificationsHtml, withGithub);
    }
    const isGemma = preferredModel.toLowerCase().includes('gemma');
    const modelConfig = { model: preferredModel };
    if (!isGemma) {
        let sys = adminSystemPrompt || "Ты полезный администратор сервера...";
        if (withGithub && githubSystemPrompt) {
            sys = sys + "\n\n=== РЕЖИМ GITHUB (активен для этой задачи) ===\n" + githubSystemPrompt;
        }
        modelConfig.systemInstruction = sys;
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
            },
            {
                name: "github_ops",
                description: "GitHub Contents + Actions: files (list/get/put/delete), artifacts, workflows (list/trigger), runs, download Actions artifacts to /tmp. Token never exposed. Prefer this over raw curl/git.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: {
                            type: "STRING",
                            enum: [
                                "status", "list", "get", "put", "delete",
                                "download_to_server", "create_artifact",
                                "list_workflows", "trigger_workflow",
                                "list_runs", "wait_run",
                                "list_artifacts", "download_artifact"
                            ],
                            description: "Operation to perform"
                        },
                        path: { type: "STRING", description: "Path inside the repository (no leading slash)" },
                        content: { type: "STRING", description: "Full text content for put (UTF-8). For binary prefer local_path" },
                        message: { type: "STRING", description: "Commit message" },
                        branch: { type: "STRING", description: "Branch name (default from env)" },
                        local_path: { type: "STRING", description: "Absolute path on this server (/tmp/...)" },
                        sha: { type: "STRING", description: "Blob SHA required for update/delete" },
                        is_binary: { type: "BOOLEAN", description: "If true, content is treated as base64" },
                        url: { type: "STRING", description: "Optional direct download URL for download_to_server" },
                        workflow_id: { type: "STRING", description: "Workflow id or filename (e.g. build-esp32s3.yml) for trigger/list_runs" },
                        workflow: { type: "STRING", description: "Alias for workflow_id" },
                        run_id: { type: "STRING", description: "Workflow run id for list_artifacts / wait_run" },
                        artifact_id: { type: "STRING", description: "Artifact id for download_artifact" },
                        file_name: { type: "STRING", description: "Inside artifact zip: extract this file (e.g. firmware.bin)" },
                        status: { type: "STRING", description: "Filter runs: queued|in_progress|completed" },
                        timeout_sec: { type: "STRING", description: "wait_run timeout seconds (max 300)" },
                        interval_sec: { type: "STRING", description: "wait_run poll interval seconds" },
                        per_page: { type: "STRING", description: "Pagination for list_runs" }
                    },
                    required: ["action"]
                }
            }
        ]
    }];
    // /github: продолжаем сохранённую сессию, если она есть; иначе стартуем с github.md
    let historyForChat;
    if (withGithub) {
        if (githubHistory && githubHistory.length > 0) {
            historyForChat = githubHistory;
            console.log(`[GITHUB] Продолжение сессии: ${githubHistory.length} сообщений в истории`);
        } else {
            historyForChat = [
                { role: "user", parts: [{ text: "Инструкции администратора + GitHub" }] },
                { role: "model", parts: [{ text: (adminSystemPrompt || "") + (githubSystemPrompt ? "\n\n" + githubSystemPrompt : "") }] }
            ];
        }
    } else {
        historyForChat = adminHistory;
    }
    const chat = model.startChat({ history: historyForChat, tools: tools });
    const executedCommands = [];
    let iterations = 0;
    const maxIterations = withGithub ? 50 : 50; // admin / github: до 50 вызовов инструментов за один ход
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
                } else if (call.name === "github_ops") {
                    console.log(`[ADMIN] github_ops: action=${call.args && call.args.action}`);
                    let ghResult;
                    try {
                        ghResult = await githubOps(call.args || {});
                    } catch (err) {
                        ghResult = JSON.stringify({ ok: false, error: err.message });
                    }
                    // не светим токен даже если модель вдруг попросила env
                    ghResult = maskSecrets(ghResult);
                    console.log(`[ADMIN] github_ops result: ${String(ghResult).substring(0, 300)}`);
                    const funcResponse = { name: call.name, response: { result: ghResult } };
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
                // Сохраняем историю: admin → adminHistory; github → githubHistory (для /github continue)
                try {
                    const hist = await chat.getHistory();
                    if (withGithub) {
                        githubHistory = hist;
                        githubSessionActive = false; // задача штатно завершена
                    } else {
                        adminHistory = hist;
                    }
                } catch (_) {}
                let finalResponseText = finalText;
                if (cronNotificationsHtml) {
                    finalResponseText = cronNotificationsHtml + '<br>' + finalResponseText;
                }
                return res.json({ ok: true, text: finalResponseText });
            }
            iterations++;
            if (iterations >= maxIterations) {
                // Сохраняем точку остановки — следующий /github продолжит с этой истории
                try {
                    const hist = await chat.getHistory();
                    if (withGithub) {
                        githubHistory = hist;
                        githubSessionActive = true;
                    } else {
                        adminHistory = hist;
                    }
                } catch (_) {}
                let limitText = `⚠️ <b>Достигнут лимит операций (${maxIterations}).</b> Прогресс сохранён.<br>` +
                    (withGithub
                        ? `Продолжите той же сессией: <code>/github продолжай</code> или <code>/github</code> + следующая инструкция.<br>` +
                          `Сброс сессии GitHub: <code>/github clear</code>`
                        : `Отправьте следующее сообщение в admin-режиме — контекст сохранён.`);
                if (executedCommands.length > 0) {
                    limitText += `\n\n<details><summary>📋 <b>Терминал</b> (нажмите, чтобы развернуть)</summary>\n`;
                    executedCommands.forEach((cmd, index) => {
                        limitText += `\n${index + 1}. <code>${cmd.command}</code>\n   ↳ ${cmd.result}`;
                    });
                    limitText += `\n</details>`;
                }
                return res.json({ ok: true, text: limitText });
            }
        }
        try {
            const hist = await chat.getHistory();
            if (withGithub) { githubHistory = hist; } else { adminHistory = hist; }
        } catch (_) {}
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
        try {
            const hist = await chat.getHistory();
            if (withGithub) {
                githubHistory = hist;
                githubSessionActive = true;
                errorText += `<br><br>💾 Сессия GitHub сохранена — продолжите: <code>/github продолжай</code>`;
            } else {
                adminHistory = hist;
            }
        } catch (e) {}
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
        console.log(`[SYSTEM] Доставка артефактов: ${ARTIFACT_DELIVERY_ENABLED ? 'ВКЛ' : 'ВЫКЛ'} | GitHub: ${GITHUB_ENABLED ? 'ВКЛ (' + GITHUB_REPO + ')' : 'ВЫКЛ'} | MinIO: ${MINIO_ENABLED ? 'ВКЛ' : 'ВЫКЛ'}`);
        initAllCronJobs();
    });
}
startServer();
