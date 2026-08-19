/**
 * MinIO storage integration for Northflank addon
 * Uses all NF_STORAGE_* environment variables from the linked secret group
 */
const Minio = require('minio');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const BUCKET = process.env.NF_STORAGE_BUCKET || 'artifacts';
const PREFIX = (process.env.NF_STORAGE_PREFIX || 'artifacts/').replace(/\/+$/, '') + '/';

// Лимит addon (байты). Env: NF_STORAGE_QUOTA / NF_STORAGE_QUOTA_GB / NF_STORAGE_SIZE
// По умолчанию 6 ГиБ — типичный Northflank Storage addon
function parseQuotaBytes() {
  const raw = process.env.NF_STORAGE_QUOTA || process.env.NF_STORAGE_QUOTA_BYTES || process.env.NF_STORAGE_SIZE || '';
  if (raw) {
    const s = String(raw).trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/);
    if (m) {
      const n = parseFloat(m[1]);
      const u = m[2] || 'b';
      const mul = ({ b:1, kb:1000, kib:1024, mb:1e6, mib:1024**2, gb:1e9, gib:1024**3, tb:1e12, tib:1024**4 })[u] || 1;
      return Math.floor(n * mul);
    }
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  const gb = parseFloat(process.env.NF_STORAGE_QUOTA_GB || '');
  if (!isNaN(gb) && gb > 0) return Math.floor(gb * 1024 * 1024 * 1024);
  return 6 * 1024 * 1024 * 1024; // 6 GiB default
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

  // Приоритет: полный endpoint → HOST + PORT/API_PORT + TLS
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

  console.log(`[MINIO] Клиент: \( {useSSL ? 'https' : 'http'}:// \){endPoint}:\( {port} (bucket= \){BUCKET})`);

  return new Minio.Client({
    endPoint,
    port,
    useSSL,
    accessKey,
    secretKey,
    pathStyle: true          // обязательно для MinIO на Northflank
  });
}

const client = createClient();
const ENABLED = !!client;

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

/**
 * Загрузить локальный файл в MinIO
 * @returns {{ ok, key, etag, size } | { ok:false, error }}
 */
async function uploadFile(localPath, objectName, meta = {}) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = objectName.startsWith(PREFIX) ? objectName : PREFIX + objectName.replace(/^\/+/, '');
    const stat = fs.statSync(localPath);
    const etag = await client.fPutObject(BUCKET, key, localPath, {
      'Content-Type': meta.contentType || 'application/octet-stream',
      ...meta
    });
    console.log(`[MINIO] uploaded \( {key} ( \){stat.size} bytes)`);
    return { ok: true, key, etag, size: stat.size, bucket: BUCKET };
  } catch (err) {
    console.error('[MINIO] uploadFile error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Загрузить Buffer / Stream
 */
async function uploadBuffer(buffer, objectName, meta = {}) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = objectName.startsWith(PREFIX) ? objectName : PREFIX + objectName.replace(/^\/+/, '');
    const etag = await client.putObject(BUCKET, key, buffer, buffer.length, {
      'Content-Type': meta.contentType || 'application/octet-stream',
      ...meta
    });
    return { ok: true, key, etag, size: buffer.length, bucket: BUCKET };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Скачать объект в локальный файл
 */
async function downloadToFile(objectName, localPath) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = objectName.startsWith(PREFIX) ? objectName : PREFIX + objectName.replace(/^\/+/, '');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await client.fGetObject(BUCKET, key, localPath);
    const st = fs.statSync(localPath);
    return { ok: true, path: localPath, size: st.size, key };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Получить readable stream объекта
 */
async function getObjectStream(objectName) {
  if (!ENABLED) throw new Error('MinIO disabled');
  const key = objectName.startsWith(PREFIX) ? objectName : PREFIX + objectName.replace(/^\/+/, '');
  return client.getObject(BUCKET, key);
}

/**
 * Список объектов (с префиксом)
 */
async function listObjects(prefix = PREFIX, recursive = true) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled', items: [] };
  const items = [];
  return new Promise((resolve) => {
    const stream = client.listObjectsV2(BUCKET, prefix, recursive);
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
        total: QUOTA
      });
    });
  });
}

/**
 * Удалить объект
 */
async function removeObject(objectName) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = objectName.startsWith(PREFIX) ? objectName : PREFIX + objectName.replace(/^\/+/, '');
    await client.removeObject(BUCKET, key);
    return { ok: true, key };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Presigned URL (для временной публичной ссылки)
 */
async function presignedGet(objectName, expirySeconds = 3600) {
  if (!ENABLED) return { ok: false, error: 'MinIO disabled' };
  try {
    const key = objectName.startsWith(PREFIX) ? objectName : PREFIX + objectName.replace(/^\/+/, '');
    const url = await client.presignedGetObject(BUCKET, key, expirySeconds);
    return { ok: true, url, expiresIn: expirySeconds };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Статус подключения
 */
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
    // used = сумма размеров всех объектов в PREFIX
    let used = 0;
    try {
      const listed = await listObjects(PREFIX, true);
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

module.exports = {
  ENABLED,
  client,
  BUCKET,
  PREFIX,
  QUOTA,
  ensureBucket,
  uploadFile,
  uploadBuffer,
  downloadToFile,
  getObjectStream,
  listObjects,
  removeObject,
  presignedGet,
  status
};
