// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ferlagod
// Mis Marcadores — extensión de navegador

// Chromium (service worker) carga las librerías aquí; Firefox las declara en el manifiesto.
if (typeof importScripts === 'function' && typeof MMSync === 'undefined') {
  importScripts('lib/webdav.js', 'lib/codec.js', 'lib/sync.js');
}

const ext = globalThis.browser ?? globalThis.chrome;

const STATUS_KEY = 'mm_status';
const ALARM = 'mm-periodic';
const PERIOD_MINUTES = 5;
const DEBOUNCE_MS = 3000;
const KEEPALIVE_MS = 20000;

let running = null;
let pending = false;
let debounceTimer = null;

/*
 * Chrome cierra el service worker si pasan ~30 s sin llamadas a la API de extensiones, aunque
 * haya peticiones de red en curso: una sincronización larga se cortaría a medias. Mientras
 * sincroniza, una llamada trivial cada 20 s lo mantiene vivo.
 */
function keepAlive() {
  const timer = setInterval(() => ext.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  return () => clearInterval(timer);
}

// Si el service worker se cerró en mitad de una sincronización, el estado quedó en «running».
ext.storage.local.get(STATUS_KEY).then((d) => {
  if (!running && d[STATUS_KEY] && d[STATUS_KEY].running) setStatus({ running: false });
});

async function setStatus(patch) {
  const cur = (await ext.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
  await ext.storage.local.set({ [STATUS_KEY]: { ...cur, ...patch } });
}

function friendly(e) {
  if (e && e.message) return e.message;
  return 'Error desconocido';
}

function syncNow() {
  if (running) {
    pending = true;
    return running;
  }
  running = (async () => {
    const cfg = await MMSync.loadConfig();
    if (!cfg) return { ok: false, error: 'Sin configurar' };
    await setStatus({ running: true });
    const release = keepAlive();
    try {
      const stats = await MMSync.synchronize();
      await setStatus({ running: false, lastSync: Date.now(), error: null, stats });
      return { ok: true, stats };
    } catch (e) {
      console.warn('Mis Marcadores: error de sincronización', e);
      await setStatus({ running: false, error: friendly(e), errorAt: Date.now() });
      return { ok: false, error: friendly(e) };
    } finally {
      release();
    }
  })().finally(() => {
    running = null;
    if (pending) {
      pending = false;
      scheduleSync();
    }
  });
  return running;
}

function scheduleSync() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncNow(), DEBOUNCE_MS);
}

/**
 * Cambios en los marcadores del navegador. Los que hace la propia sincronización también llegan
 * aquí: provocan como mucho una sincronización más, que no encuentra nada y no cambia nada.
 * Así no se pierde ningún cambio hecho por el usuario mientras se sincronizaba.
 */
function onBookmarkEvent() {
  if (running) pending = true;
  else scheduleSync();
}

ext.bookmarks.onCreated.addListener(onBookmarkEvent);
ext.bookmarks.onChanged.addListener(onBookmarkEvent);
ext.bookmarks.onMoved.addListener(onBookmarkEvent);
ext.bookmarks.onRemoved.addListener(onBookmarkEvent);
if (ext.bookmarks.onImportEnded) ext.bookmarks.onImportEnded.addListener(onBookmarkEvent);

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) syncNow();
});

async function ensureAlarm() {
  const existing = await ext.alarms.get(ALARM);
  if (!existing || existing.periodInMinutes !== PERIOD_MINUTES) {
    ext.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
  }
}

ext.runtime.onStartup.addListener(() => {
  ensureAlarm();
  syncNow();
});

ext.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  if (details.reason === 'install') ext.runtime.openOptionsPage();
});

ext.action.onClicked.addListener(() => ext.runtime.openOptionsPage());

// ------------------------------------------------------------------ mensajes de la página de ajustes

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'connect': {
      const cfg = await MMSync.connect(msg);
      await ext.storage.local.set({ [MMSync.CONFIG_KEY]: cfg });
      await MMSync.resetState();
      await setStatus({ error: null, lastSync: null, stats: null, firstSync: null, connectedAt: Date.now() });
      await ensureAlarm();
      // Primera sincronización: importa lo del servidor, exporta lo del navegador y empareja lo común.
      const res = await syncNow();
      if (res && res.ok) await setStatus({ firstSync: res.stats });
      return { ok: true, firstSync: res };
    }
    case 'sync':
      return syncNow();
    case 'disconnect':
      await ext.storage.local.remove([MMSync.CONFIG_KEY, MMSync.STATE_KEY, STATUS_KEY]);
      await ext.alarms.clear(ALARM);
      return { ok: true };
    default:
      return { ok: false, error: 'Mensaje desconocido' };
  }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return false;
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: friendly(e) }));
  return true;
});
