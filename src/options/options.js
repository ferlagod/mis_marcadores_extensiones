// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ferlagod
// Mis Marcadores — página de ajustes

const $ = (id) => document.getElementById(id);

function send(msg) {
  return ext.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
}

function formatDate(ms) {
  return new Date(ms).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

async function render() {
  const data = await ext.storage.local.get(['mm_config', 'mm_status']);
  const cfg = data.mm_config;
  const st = data.mm_status || {};
  $('setup').hidden = !!cfg;
  $('connected').hidden = !cfg;
  if (!cfg) return;

  $('account').textContent = `${cfg.username} · ${new URL(cfg.serverUrl).host}`;
  const badge = $('badge');
  badge.classList.toggle('err', !!st.error && !st.running);
  badge.textContent = st.running ? 'Sincronizando…' : st.error ? 'Error' : st.lastSync ? 'Al día' : 'Pendiente';

  const parts = [];
  if (st.lastSync) parts.push(`Última sincronización: ${formatDate(st.lastSync)}.`);
  const f = st.firstSync;
  if (f && (f.imported || f.exported || f.matched)) {
    parts.push(`Al conectar: ${f.imported} importados, ${f.exported} exportados, ${f.matched} ya estaban en los dos sitios.`);
  }
  const s = st.stats;
  if (s) {
    if (s.downloaded || s.uploaded) parts.push(`Recibidos ${s.downloaded}, enviados ${s.uploaded}.`);
    if (s.legacyRewritten) parts.push(`${s.legacyRewritten} ficheros cifrados antiguos se han reescrito en claro.`);
    if (s.warnings) parts.push(`${s.warnings} elementos no se pudieron procesar (ver consola de la extensión).`);
    if (s.protectedRemote) parts.push(`Se han conservado ${s.protectedRemote} marcadores que el servidor quería borrar en bloque.`);
    if (s.restoredLocal) parts.push(`Se han restaurado ${s.restoredLocal} marcadores borrados en bloque en el navegador; si querías eliminarlos, hazlo desde la app.`);
  }
  $('statusText').textContent = parts.join(' ') || 'Aún no se ha sincronizado.';
  $('errorText').hidden = !st.error;
  $('errorText').textContent = st.error || '';
  $('syncBtn').disabled = !!st.running;
}

$('form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const serverUrl = $('server').value.trim();
  let origin;
  try {
    const u = new URL(serverUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    origin = u.origin;
  } catch (_) {
    showFormError('La dirección del servidor no es válida.');
    return;
  }
  if (origin.startsWith('http:') && !confirm('El servidor no usa HTTPS: la contraseña de aplicación viajaría sin cifrar. ¿Continuar?')) return;

  // El permiso de acceso al servidor debe pedirse directamente desde el clic.
  const granted = ext.permissions.request({ origins: [origin + '/*'] });
  const btn = $('connectBtn');
  btn.disabled = true;
  btn.textContent = 'Conectando e importando…';
  showFormError('');
  Promise.resolve(granted)
    .then((ok) => {
      if (!ok) throw new Error('Hace falta permiso para acceder a tu servidor.');
      return send({
        type: 'connect',
        serverUrl,
        username: $('user').value.trim(),
        appPassword: $('appPass').value
      });
    })
    .then((res) => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'No se pudo conectar');
      $('appPass').value = '';
      return render();
    })
    .catch((e) => showFormError(e.message))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Conectar y sincronizar';
    });
});

function showFormError(text) {
  $('formError').hidden = !text;
  $('formError').textContent = text;
}

$('syncBtn').addEventListener('click', async () => {
  $('syncBtn').disabled = true;
  await send({ type: 'sync' });
  render();
});

$('disconnectBtn').addEventListener('click', async () => {
  if (!confirm('¿Desconectar? Los marcadores del navegador no se borran; solo se deja de sincronizar.')) return;
  await send({ type: 'disconnect' });
  render();
});

// ------------------------------------------------------------------ copia en formato HTML estándar

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toNetscape(nodes, depth) {
  const pad = '    '.repeat(depth);
  let out = '';
  for (const n of nodes) {
    const added = Math.floor((n.dateAdded || Date.now()) / 1000);
    if (n.url) {
      out += `${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${added}">${esc(n.title)}</A>\n`;
    } else if (n.type !== 'separator') {
      out += `${pad}<DT><H3 ADD_DATE="${added}">${esc(n.title)}</H3>\n${pad}<DL><p>\n`;
      out += toNetscape(n.children || [], depth + 1);
      out += `${pad}</DL><p>\n`;
    }
  }
  return out;
}

async function exportBackup() {
  const tree = await ext.bookmarks.getTree();
  const html =
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
    '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
    toNetscape(tree[0].children || [], 1) +
    '</DL><p>\n';
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `marcadores-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('exportBtn').addEventListener('click', exportBackup);
$('exportBtn2').addEventListener('click', exportBackup);

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.mm_status || changes.mm_config)) render();
});

render();
