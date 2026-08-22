/**
 * MinIO storage for Northflank addon (NF_STORAGE_* env).
 *
 * Контракт ключей:
 *  - Снаружи (FileManager / POST /minio) всегда ОТНОСИТЕЛЬНЫЕ ключи: "voice/a.wav", "artifacts/x.apk"
 *  - В бакете: PREFIX + relative. PREFIX по умолчанию "artifacts/"
 *  - Папка пользователя с именем "artifacts" → объект "artifacts/artifacts/..." — это нормально
 *
 * Раньше objectName.startsWith(PREFIX) ломало папку "artifacts":
 *   key "artifacts/file" считался уже с PREFIX → писал в корень PREFIX, а не в подпапку.
 */
const Minio = require('minio');
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.NF_STORAGE_BUCKET || 'artifacts';
const PREFIX = (process.env.NF_STORAGE_PREFIX || 'artifacts/').replace(/\/+$/, '') + '/';

function parseQuotaBytes() {
  const raw = process.env.NF_STORAGE_QUOTA || process.env.NF_STORAGE_QUOTA_BYTES || process.env.NF_STORAGE_SIZE || '';
  if (raw) {
    const s = String(raw).trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/);
    if (m) {
      const n = parseFloat(m[1]);
      const u = m[2] || 'b';
      const mul = ({ b: 1, kb: 1000, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 })[u] || 1;
      return Math.floor(n * mul);
    }
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  const gb = parseFloat(process.env.NF_STORAGE_QUOTA_GB || '');
  if (!isNaN(gb) && gb > 0) return Math.floor(gb * 1024 * 1024 * 1024);
  return 6 * 1024 * 1024 * 1024;
}
const QUOTA = parseQuotaBytes();

function parseEndpoint(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return {
      endPoint: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
      useSSL: u.protocol === 'https:'
    };
  } catch (_) {
    return null;
  }
}

function createClient() {
  const accessKey = process.env.NF_STORAGE_ACCESS_KEY || process.env.NF_STORAGE_ADMIN_USERNAME;
  const secretKey = process.env.NF_STORAGE_SECRET_KEY || process.env.NF_STORAGE_ADMIN_PASSWORD;
  if (!accessKey || !secretKey) {
    console.warn('[MINIO] NF_STORAGE_ACCESS_KEY / NF_STORAGE_SECRET_KEY не заданы — MinIO отключён');
    return null;
  }
  let endPoint, port, useSSL;
  const ep = parseEndpoint(process.env.NF_STORAGE_MINIO_ENDPOINT);
  if (ep) {
    endPoint = ep.endPoint;
    port = ep.port;
    useSSL = ep.useSSL;
  } else {
    endPoint = process.env.NF_STORAGE_HOST;
    if (!endPoint) {
      console.warn('[MINIO] NF_STORAGE_HOST / NF_STORAGE_MINIO_ENDPOINT не заданы — MinIO отключён');
      return null;
    }
    const tls = String(process.env.NF_STORAGE_TLS_ENABLED || '').toLowerCase();
    useSSL = tls === 'true' || tls === '1' || tls === 'yes';
    port = parseInt(process.env.NF_STORAGE_API_PORT || process.env.NF_STORAGE_PORT || (useSSL ? '443' : '9000'), 10);
  }
  console.log(`[MINIO] Клиент: ${useSSL ? 'https' : 'http'}://${endPoint}:${port} (bucket=${BUCKET}, prefix=${PREFIX})`);
  return new Minio.Client({
    endPoint,
    port,
    useSSL,
    accessKey,
    secretKey,
    pathStyle: true
  });
}

const client = createClient();
const ENABLED = !!client;

/**
 * Относительный ключ API → ключ в бакете.
 * ВСЕГДА PREFIX + relative (без startsWith).
 * Иначе папка пользователя "artifacts" при PREFIX=artifacts/ пишется в корень.
 * Вызывающий код должен передавать только относительные ключи.
 * Для уже полных ключей из listObjects (obj.name) — removeStorageKey / без toKey.
 */
function toKey(objectName) {
  let k = String(objectName || '').replace(/^\/+/, '');
  if (!PREFIX) return k;
  // убрать ошибочный двойной PREFIX от старых версий server.js
  while (k.indexOf(PREFIX + PREFIX) === 0) k = k.substring(PREFIX.length);
  // если передали уже storage-ключ (ровно один PREFIX) — не дублировать
  // НО: relative "artifacts/file" тоже начинается с PREFIX — для него НУЖЕН вложенный путь.
  // Различаем по флагу: toKey(name, { storage: true })
  return PREFIX + k;
}

function toKeySmart(objectName, asStorage) {
  let k = String(objectName || '').replace(/^\/+/, '');
  if (!PREFIX) return k;
  while (k.indexOf(PREFIX + PREFIX) === 0) k = k.substring(PREFIX.length);
  if (asStorage && k.indexOf(PREFIX) === 0) return k;
  return PREFIX + k;
}

/** Ключ в бакете → относительный для API/FileManager (снимаем ровно один PREFIX). */
function toRelative(storageKey) {
  let k = String(storageKey || '');
  if (!PREFIX) return k.replace(/^\/+/, '');
  if (k.indexOf(PREFIX) === 0) return k.substring(PREFIX.length);
  return k;
}

async function ensureBucket() {
  if (!ENABLED) return false;
  try {
    const exists = await client.bucketExists(BUCKET);
    if (!exists) {
      await client.makeBucket(BUCKET, '');
      console.log(`[MINIO] Bucket "${BUCKET}" создан`);
    }
    return true;
  } catch (err) {
    console.error('[MINIO] ensureBucket error:', err.message);
    return false;
  }
}

async function uploadFile(localPath, objectName, meta = {}) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = toKey(objectName);
    const stat = fs.statSync(localPath);
    const etag = await client.fPutObject(BUCKET, key, localPath, {
      'Content-Type': meta.contentType || 'application/octet-stream',
      ...meta
    });
    console.log(`[MINIO] uploaded ${key} (${stat.size} bytes)`);
    return { ok: true, key, relativeKey: toRelative(key), etag, size: stat.size, bucket: BUCKET };
  } catch (err) {
    console.error('[MINIO] uploadFile error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function uploadBuffer(buffer, objectName, meta = {}) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = toKey(objectName);
    const etag = await client.putObject(BUCKET, key, buffer, buffer.length, {
      'Content-Type': meta.contentType || 'application/octet-stream',
      ...meta
    });
    return { ok: true, key, relativeKey: toRelative(key), etag, size: buffer.length, bucket: BUCKET };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function downloadToFile(objectName, localPath) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = toKey(objectName);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await client.fGetObject(BUCKET, key, localPath);
    const st = fs.statSync(localPath);
    return { ok: true, path: localPath, size: st.size, key, relativeKey: toRelative(key) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getObjectStream(objectName) {
  if (!ENABLED) throw new Error('MinIO disabled');
  const key = toKey(objectName);
  return client.getObject(BUCKET, key);
}

async function listObjects(prefix = '', recursive = true) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled', items: [] };
  // prefix относительный; в бакете — под PREFIX
  let listPrefix = PREFIX;
  const rel = String(prefix || '').replace(/^\/+/, '');
  if (rel) {
    listPrefix = toKey(rel.endsWith('/') ? rel : rel + '/');
  }
  const items = [];
  return new Promise((resolve) => {
    const stream = client.listObjectsV2(BUCKET, listPrefix, recursive);
    stream.on('data', (obj) => {
      items.push({
        name: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag
      });
    });
    stream.on('error', (err) => resolve({ ok: false, error: err.message, items }));
    stream.on('end', () => {
      const used = items.reduce((s, it) => s + (parseInt(it.size, 10) || 0), 0);
      resolve({
        ok: true,
        count: items.length,
        items,
        used,
        quota: QUOTA,
        free: Math.max(0, QUOTA - used),
        total: QUOTA,
        prefix: toRelative(listPrefix),
        bucket: BUCKET
      });
    });
  });
}

async function removeObject(objectName) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = toKey(objectName);
    await client.removeObject(BUCKET, key);
    return { ok: true, key, relativeKey: toRelative(key) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function presignedGet(objectName, expirySeconds = 3600) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = toKey(objectName);
    const url = await client.presignedGetObject(BUCKET, key, expirySeconds);
    return { ok: true, url, expiresIn: expirySeconds, key, relativeKey: toRelative(key) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function status() {
  if (!ENABLED) {
    return {
      ok: false,
      enabled: false,
      reason: 'NF_STORAGE_ACCESS_KEY / HOST / ENDPOINT не заданы'
    };
  }
  try {
    await ensureBucket();
    const buckets = await client.listBuckets();
    let used = 0;
    try {
      const listed = await listObjects('', true);
      if (listed && listed.ok) used = listed.used || 0;
    } catch (_) {}
    return {
      ok: true,
      enabled: true,
      bucket: BUCKET,
      prefix: PREFIX,
      buckets: buckets.map(b => b.name),
      endpoint: process.env.NF_STORAGE_MINIO_ENDPOINT || process.env.NF_STORAGE_HOST,
      tls: process.env.NF_STORAGE_TLS_ENABLED,
      used,
      quota: QUOTA,
      free: Math.max(0, QUOTA - used),
      total: QUOTA
    };
  } catch (err) {
    return { ok: false, enabled: true, error: err.message };
  }
}

/**
 * Единый JSON-API для FileManager (POST /minio и action:minio на /gemini).
 * body: { op, key, keys, prefix, local_path, from, to, b64, contentType, expiry, ... }
 * tmpDir — для copy/move fallback и to_tmp по умолчанию
 */
async function handleApi(body, opts = {}) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled (нет NF_STORAGE_*)', _http: 503 };
  const op = String(body.op || body.action || '').toLowerCase();
  const tmpDir = opts.tmpDir || process.env.TMPDIR || '/tmp';

  try {
    if (op === 'status') return await status();

    if (op === 'list') {
      let prefix = String(body.prefix || '').replace(/^\/+/, '');
      const result = await listObjects(prefix, true);
      if (!result.ok) return result;
      const items = (result.items || []).map(it => {
        const rel = toRelative(it.name);
        return {
          name: rel,
          key: rel,
          size: it.size || 0,
          lastModified: it.lastModified,
          etag: it.etag
        };
      });
      const used = typeof result.used === 'number'
        ? result.used
        : items.reduce((s, it) => s + (it.size || 0), 0);
      const quota = result.quota || QUOTA;
      return {
        ok: true,
        count: items.length,
        items,
        prefix: toRelative(prefix ? toKey(prefix.endsWith('/') ? prefix : prefix + '/') : PREFIX),
        bucket: BUCKET,
        used,
        quota,
        free: Math.max(0, quota - used),
        total: quota
      };
    }

    if (op === 'upload') {
      const keyIn = String(body.key || body.filename || '');
      if (!keyIn) return { ok: false, error: 'key required', _http: 400 };
      if (body.b64 === undefined || body.b64 === null) return { ok: false, error: 'b64 required', _http: 400 };
      const buf = Buffer.from(String(body.b64), 'base64');
      const contentType = body.contentType || body.content_type || 'application/octet-stream';
      const result = await uploadBuffer(buf, keyIn, { contentType });
      if (result.ok) result.key = toRelative(result.key);
      return result;
    }

    if (op === 'upload_from_server') {
      const localPath = String(body.local_path || body.path || '');
      const keyIn = String(body.key || path.basename(localPath));
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, error: 'local_path not found: ' + localPath, _http: 400 };
      }
      const result = await uploadFile(localPath, keyIn, {
        contentType: body.contentType || 'application/octet-stream'
      });
      if (result.ok) result.key = toRelative(result.key);
      return result;
    }

    if (op === 'to_tmp' || op === 'download') {
      const keyIn = String(body.key || '');
      if (!keyIn) return { ok: false, error: 'key required', _http: 400 };
      let localPath = String(body.local_path || '');
      if (!localPath) {
        const base = path.basename(keyIn.replace(/\/+$/, '')) || ('minio_' + Date.now());
        localPath = path.join(tmpDir, base);
      }
      const result = await downloadToFile(keyIn, localPath);
      if (result.ok) result.key = toRelative(result.key);
      return result;
    }

    if (op === 'delete' || op === 'remove') {
      let keys = body.keys;
      if (!keys && body.key) keys = [body.key];
      if (!Array.isArray(keys) || keys.length === 0) {
        return { ok: false, error: 'key/keys required', _http: 400 };
      }
      const results = [];
      for (const k of keys) {
        const kk = String(k);
        if (kk.endsWith('/')) {
          const list = await listObjects(kk, true);
          if (list.ok && list.items) {
            for (const it of list.items) {
              // it.name — полный storage key из MinIO
              try {
                await client.removeObject(BUCKET, it.name);
                results.push({ ok: true, key: it.name });
              } catch (e) {
                results.push({ ok: false, error: e.message });
              }
            }
          }
          results.push(await removeObject(kk));
        } else {
          results.push(await removeObject(kk));
        }
      }
      const failed = results.filter(r => !r.ok);
      return {
        ok: failed.length === 0,
        deleted: results.filter(r => r.ok).length,
        error: failed.length ? failed[0].error : undefined
      };
    }

    if (op === 'mkdir') {
      let keyIn = String(body.key || body.prefix || '');
      if (!keyIn) return { ok: false, error: 'key required', _http: 400 };
      if (!keyIn.endsWith('/')) keyIn += '/';
      const result = await uploadBuffer(Buffer.alloc(0), keyIn, { contentType: 'application/x-directory' });
      if (result.ok) result.key = toRelative(result.key);
      return result;
    }

    if (op === 'presign') {
      const keyIn = String(body.key || '');
      if (!keyIn) return { ok: false, error: 'key required', _http: 400 };
      const expiry = parseInt(body.expiry || body.expires || '3600', 10);
      return await presignedGet(keyIn, expiry);
    }

    if (op === 'copy' || op === 'move') {
      const from = String(body.from || body.key || '');
      const to = String(body.to || body.dest || '');
      if (!from || !to) return { ok: false, error: 'from and to required', _http: 400 };
      const srcKey = toKey(from);
      const dstKey = toKey(to);
      try {
        if (client && typeof client.copyObject === 'function') {
          await client.copyObject(BUCKET, dstKey, '/' + BUCKET + '/' + srcKey);
          if (op === 'move') await removeObject(srcKey);
          return { ok: true, from: toRelative(srcKey), to: toRelative(dstKey), op };
        }
      } catch (_) {}
      const tmp = path.join(tmpDir, 'minio_mv_' + Date.now());
      const dl = await downloadToFile(from, tmp);
      if (!dl.ok) return dl;
      const up = await uploadFile(tmp, to);
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!up.ok) return up;
      if (op === 'move') await removeObject(from);
      return { ok: true, from: toRelative(srcKey), to: toRelative(dstKey), op, via: 'download-upload' };
    }

    return {
      ok: false,
      error: 'Unknown minio op: ' + op,
      _http: 400
    };
  } catch (err) {
    console.error('[MINIO] handleApi', err.message);
    return { ok: false, error: err.message, _http: 500 };
  }
}

module.exports = {
  ENABLED,
  client,
  BUCKET,
  PREFIX,
  QUOTA,
  toKey,
  toRelative,
  ensureBucket,
  uploadFile,
  uploadBuffer,
  downloadToFile,
  getObjectStream,
  listObjects,
  removeObject,
  presignedGet,
  status,
  handleApi
};
