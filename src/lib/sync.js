// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ferlagod
// Mis Marcadores — extensión de navegador

/*
 * Sincronización entre los marcadores NATIVOS del navegador y la bóveda de Mis Marcadores en
 * Nextcloud. La extensión no tiene gestor propio: crea, renombra, mueve y borra los marcadores
 * del navegador.
 *
 * Correspondencia de carpetas raíz:
 *   "Otros marcadores" (Chromium) / "Otros marcadores" (Firefox)  <->  raíz de la app (sin carpeta)
 *   Barra de marcadores                                            <->  carpeta "Barra de marcadores"
 *   Menú de marcadores (solo Firefox)                              <->  carpeta "Menú de marcadores"
 *   Marcadores del móvil                                           <->  carpeta "Marcadores del móvil"
 * Las carpetas especiales tienen ids fijos, así que todos los navegadores usan la misma.
 *
 * Fusión a tres bandas por elemento:
 *   base = último payload sincronizado (con los campos que el navegador no conoce: notas,
 *          etiquetas, favorito, color…, que se conservan siempre)
 *   seen = cómo estaba el marcador en el navegador tras la última sincronización
 *   Si un campo cambió solo en el navegador gana el navegador; en cualquier otro caso, el servidor.
 *
 * Primera sincronización (al conectar la cuenta): se importa lo que solo está en el servidor, se
 * exporta lo que solo está en el navegador y los marcadores que están en los dos sitios (misma
 * dirección; primero en la misma carpeta, luego en cualquiera) se emparejan sin duplicarse. Si
 * difieren en título o carpeta, gana el más reciente: fecha de creación en el navegador frente a
 * la última modificación (updatedAt) en el servidor.
 *
 * Seguridad (mismas reglas que la app):
 *   - Subidas con If-Match / If-None-Match.
 *   - Borrar en el navegador = mandar a la papelera de la app (recuperable).
 *   - Freno de borrados masivos en ambos sentidos.
 *   - Los ficheros cifrados de la versión 1 no se pueden leer: si este navegador conoce el
 *     elemento se vuelve a subir en claro encima; si no, se ignora.
 */
const MMSync = (() => {
  const ext = globalThis.browser ?? globalThis.chrome;

  const SPECIAL = {
    '6d6d6172-6b00-4000-8000-000000000001': { root: 'toolbar', name: 'Barra de marcadores' },
    '6d6d6172-6b00-4000-8000-000000000002': { root: 'menu', name: 'Menú de marcadores' },
    '6d6d6172-6b00-4000-8000-000000000003': { root: 'mobile', name: 'Marcadores del móvil' }
  };
  const RID_BY_ROOT = Object.fromEntries(Object.entries(SPECIAL).map(([rid, s]) => [s.root, rid]));

  const BM_FIELDS = ['title', 'url', 'folderId'];
  const F_FIELDS = ['name', 'parentId'];

  const STATE_KEY = 'mm_state';
  const CONFIG_KEY = 'mm_config';
  const MAX_ROUNDS = 3;
  const DOWNLOAD_CONCURRENCY = 6;
  const UPLOAD_CONCURRENCY = 6;
  const SAVE_EVERY = 25; // subidas entre guardados del estado (por si el navegador corta a medias)

  // Freno para retiradas remotas (igual que SyncMerger.isMassRemoval).
  const isMassRemoval = (removed, live) => removed >= 5 && (removed >= 50 || removed * 4 >= live);
  // Freno para borrados en el navegador (más permisivo: borrar una carpeta es habitual).
  const isMassLocalDeletion = (removed, live) => removed >= 50 || (removed >= 20 && removed * 2 >= live);

  // ------------------------------------------------------------------ almacenamiento

  async function loadConfig() {
    return (await ext.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || null;
  }

  const emptyState = () => ({ v: 2, items: {}, tombs: {} });

  async function loadState() {
    const s = (await ext.storage.local.get(STATE_KEY))[STATE_KEY];
    if (s && s.v === 2) return s;
    if (s && s.v === 1) {
      // Estado de la versión cifrada: se olvidan los ETags para volver a descargarlo todo una vez
      // y reescribir en claro los ficheros cifrados que sigan en el servidor.
      for (const it of Object.values(s.items)) it.etag = null;
      s.v = 2;
      return s;
    }
    return emptyState();
  }

  const saveState = (state) => ext.storage.local.set({ [STATE_KEY]: state });
  const resetState = () => ext.storage.local.set({ [STATE_KEY]: emptyState() });

  // ------------------------------------------------------------------ utilidades

  function urlKey(u) {
    try {
      return new URL(u).href;
    } catch (_) {
      return String(u || '');
    }
  }

  const sameField = (f, a, b) => (f === 'url' ? urlKey(a) === urlKey(b) : (a ?? null) === (b ?? null));

  /** Ejecuta fn sobre la lista con n tareas a la vez. Al primer error deja de empezar tareas y lo relanza. */
  async function pool(list, n, fn) {
    let i = 0;
    let error = null;
    const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
      while (!error && i < list.length) {
        try {
          await fn(list[i++]);
        } catch (e) {
          error = error || e;
        }
      }
    });
    await Promise.all(workers);
    if (error) throw error;
  }

  function isSyncableUrl(url) {
    return !!url && !/^place:/i.test(url);
  }

  // ------------------------------------------------------------------ árbol del navegador

  function detectRoots(tree) {
    const top = (tree[0] && tree[0].children) || [];
    const firefox = { toolbar_____: 'toolbar', menu________: 'menu', unfiled_____: 'other', mobile______: 'mobile' };
    const chromium = { 'bookmarks-bar': 'toolbar', other: 'other', mobile: 'mobile' };
    const roots = {};
    top.forEach((n, i) => {
      let kind = firefox[n.id] || (n.folderType ? chromium[n.folderType] : null);
      // Chromium antiguo (sin folderType): barra, otros y móvil, en ese orden.
      if (!kind && !n.folderType && /^\d+$/.test(n.id)) kind = ['toolbar', 'other', 'mobile'][i];
      if (kind && !roots[kind]) roots[kind] = n;
    });
    return roots;
  }

  async function snapshot() {
    const tree = await ext.bookmarks.getTree();
    const roots = detectRoots(tree);
    if (!roots.other) throw new MMError('browser', 'No se encontró la carpeta «Otros marcadores» del navegador');
    const nodes = new Map();
    const order = []; // recorrido en profundidad: los padres van antes que sus hijos
    const rootRid = new Map();

    const walk = (n, isRoot) => {
      if (n.type === 'separator') return;
      const folder = !n.url;
      if (!isRoot && !folder && !isSyncableUrl(n.url)) return;
      nodes.set(n.id, {
        id: n.id,
        parentId: n.parentId,
        title: n.title || '',
        url: n.url || null,
        folder,
        dateAdded: n.dateAdded || Date.now(),
        root: isRoot
      });
      if (!isRoot) order.push(n.id);
      for (const c of n.children || []) walk(c, false);
    };

    for (const [kind, node] of Object.entries(roots)) {
      rootRid.set(node.id, kind === 'other' ? null : RID_BY_ROOT[kind]);
      walk(node, true);
    }
    return { roots, nodes, order, rootRid };
  }

  // ------------------------------------------------------------------ cuenta

  /**
   * Comprueba la cuenta de Nextcloud y crea la carpeta MisMarcadores si no existe.
   * Devuelve la configuración a guardar.
   */
  async function connect({ serverUrl, username, appPassword }) {
    const rootUrl = MMWebDav.buildRootUrl(serverUrl, username);
    const client = new MMWebDav.Client(rootUrl, username, appPassword);
    await client.ensureRoot();
    return { serverUrl: serverUrl.trim(), username, appPassword, rootUrl };
  }

  // ------------------------------------------------------------------ sincronización

  async function synchronize() {
    const cfg = await loadConfig();
    if (!cfg) return null;
    const client = new MMWebDav.Client(cfg.rootUrl, cfg.username, cfg.appPassword);
    const stats = {
      warnings: 0, protectedRemote: 0, restoredLocal: 0, uploaded: 0, downloaded: 0,
      imported: 0, exported: 0, matched: 0, legacyRewritten: 0
    };
    let rounds = 0;
    let rerun;
    do {
      const ctx = { client, stats, rerun: false };
      await runRound(ctx);
      rerun = ctx.rerun;
      rounds++;
    } while (rerun && rounds < MAX_ROUNDS);
    return stats;
  }

  async function runRound(ctx) {
    const { client, stats } = ctx;
    await client.ensureRoot();

    const files = await client.list();
    const fileNames = new Set(files.map((f) => f.name));
    const remoteFiles = new Map(); // rid -> {type, name, etag}
    for (const f of files) {
      const p = MMCodec.parseFileName(f.name);
      if (p) remoteFiles.set(p.id, { type: p.type, name: f.name, etag: f.etag });
    }

    const state = await loadState();
    const items = state.items;
    for (const name of Object.keys(state.tombs)) if (!fileNames.has(name)) delete state.tombs[name];

    // 1. Descargar lo que cambió en el servidor ------------------------------------------
    const toFetch = [];
    for (const [rid, f] of remoteFiles) {
      const it = items[rid];
      if (it && it.t !== f.type) continue;
      if (it && it.etag && it.etag === f.etag) continue;
      if (!it && f.etag && state.tombs[f.name] === f.etag) continue;
      toFetch.push([rid, f]);
    }
    const remote = new Map();
    const legacy = new Set(); // rids con fichero cifrado v1 que este navegador puede reescribir
    await pool(toFetch, DOWNLOAD_CONCURRENCY, async ([rid, f]) => {
      const raw = await client.get(f.name);
      if (raw == null) return;
      try {
        const rec = MMCodec.decode(f.type, raw, rid);
        remote.set(rid, { ...rec, etag: f.etag, name: f.name, type: f.type });
        stats.downloaded++;
      } catch (e) {
        const it = items[rid];
        if (e instanceof MMLegacyFileError && it && it.t === f.type && it.base) {
          // Se conoce el contenido: se sube en claro encima del fichero cifrado.
          it.etag = f.etag;
          legacy.add(rid);
          return;
        }
        if (e instanceof MMLegacyFileError && !it && f.etag) state.tombs[f.name] = f.etag; // no volver a descargarlo
        console.warn('Mis Marcadores: no se pudo leer', f.name, e);
        stats.warnings++;
      }
    });

    // 2. Estado del navegador ------------------------------------------------------------
    let snap = await snapshot();
    const { roots, rootRid } = snap;

    // Carpetas raíz del navegador ligadas a carpetas especiales de la app.
    for (const [rid, sp] of Object.entries(SPECIAL)) {
      const root = roots[sp.root];
      const it = items[rid];
      if (root) {
        const hasChildren = snap.order.some((id) => snap.nodes.get(id).parentId === root.id);
        if (it || hasChildren || remote.has(rid)) {
          items[rid] = { ...(it || { t: 'folder', etag: null, base: null, seen: null }), bid: root.id, rootBound: true };
        }
      } else if (it && it.rootBound) {
        it.rootBound = false;
        it.bid = null;
        it.seen = null;
      }
    }

    const bid2rid = new Map();
    const rebuildIndex = () => {
      bid2rid.clear();
      for (const [rid, it] of Object.entries(items)) {
        if (it.bid && snap.nodes.has(it.bid) && !bid2rid.has(it.bid)) bid2rid.set(it.bid, rid);
      }
    };
    rebuildIndex();

    const parentRidOf = (node) => {
      const p = node.parentId;
      if (rootRid.has(p)) return rootRid.get(p);
      return bid2rid.get(p) ?? null;
    };
    const localFields = (it, node) =>
      it.t === 'bookmark'
        ? { title: node.title, url: node.url, folderId: parentRidOf(node) }
        : { name: node.title, parentId: parentRidOf(node) };

    // Nodos del navegador sin correspondencia: se emparejan con elementos nuevos del servidor
    // para no duplicar. Carpetas: misma carpeta superior + mismo nombre. Marcadores: misma
    // carpeta + misma dirección y, si no hay, misma dirección en cualquier carpeta (la fusión
    // decide luego por fecha dónde se queda). Lo que no se empareja es nuevo.
    const poolFolders = new Map();
    const poolBookmarks = new Map();
    const poolByUrl = new Map();
    const claimed = new Set();
    const push = (map, k, rid) => (map.get(k) || map.set(k, []).get(k)).push(rid);
    const take = (list) => {
      while (list && list.length) {
        const rid = list.shift();
        if (!claimed.has(rid)) {
          claimed.add(rid);
          return rid;
        }
      }
      return null;
    };
    for (const [rid, r] of remote) {
      if (items[rid] || r.kind !== 'live') continue;
      if (r.type === 'folder') {
        push(poolFolders, (r.payload.parentId ?? '') + '\u0000' + r.payload.name.trim(), rid);
      } else if (!r.payload.isTrashed) {
        push(poolBookmarks, (r.payload.folderId ?? '') + '\u0000' + urlKey(r.payload.url), rid);
        push(poolByUrl, urlKey(r.payload.url), rid);
      }
    }
    const bind = (id, rid, folder) => {
      items[rid] = { t: folder ? 'folder' : 'bookmark', bid: id, etag: null, base: null, seen: null };
      bid2rid.set(id, rid);
    };
    const unmatched = [];
    for (const id of snap.order) {
      if (bid2rid.has(id)) continue;
      const n = snap.nodes.get(id);
      const k = (parentRidOf(n) ?? '') + '\u0000' + (n.folder ? n.title.trim() : urlKey(n.url));
      const rid = take((n.folder ? poolFolders : poolBookmarks).get(k));
      if (rid) bind(id, rid, n.folder);
      else if (n.folder) bind(id, crypto.randomUUID(), true);
      else unmatched.push(id);
    }
    for (const id of unmatched) {
      const rid = take(poolByUrl.get(urlKey(snap.nodes.get(id).url)));
      bind(id, rid || crypto.randomUUID(), false);
    }

    // Freno: borrado masivo en el navegador (perfil vaciado, importación fallida…).
    const goneLocal = Object.entries(items).filter(([, it]) => it.bid && !it.rootBound && !snap.nodes.has(it.bid));
    const goneBookmarks = goneLocal.filter(([, it]) => it.t === 'bookmark' && it.base && !it.base.isTrashed).length;
    const liveBookmarks = Object.values(items).filter((it) => it.t === 'bookmark' && it.base && !it.base.isTrashed).length;
    if (goneBookmarks && isMassLocalDeletion(goneBookmarks, liveBookmarks)) {
      for (const [, it] of goneLocal) {
        it.bid = null;
        it.seen = null;
      }
      stats.restoredLocal += goneBookmarks;
    }

    // 3. Decidir ---------------------------------------------------------------------------
    const now = Date.now();
    const uploads = [];
    const creates = [];
    const updates = [];
    const bmRemovals = [];
    const folderDissolves = [];

    const etagFor = (rid, rec) => {
      if (rec) return rec.etag;
      const rf = remoteFiles.get(rid);
      if (!rf) return null;
      const it = items[rid];
      if (it && it.etag === rf.etag) return rf.etag;
      if (state.tombs[rf.name] === rf.etag) return rf.etag;
      return null;
    };
    const queueUpload = (rid, type, payload, rec, extra = {}) => {
      const ifMatch = remoteFiles.has(rid) ? etagFor(rid, rec) : null;
      uploads.push({ rid, type, payload, ifMatch, ifNoneMatch: !ifMatch, ...extra });
    };
    const accept = (it, rec) => {
      if (rec) {
        it.base = rec.payload;
        it.etag = rec.etag;
      }
    };
    const specialPayload = (rid, base) => ({
      parentId: null,
      name: SPECIAL[rid].name,
      color: 'DEFAULT',
      ...(base || {}),
      updatedAt: base ? base.updatedAt : now
    });
    const fromBrowser = (it, node, L) =>
      it.t === 'bookmark'
        ? {
            folderId: L.folderId, url: L.url, title: L.title, description: '', notes: '', tags: [],
            imageUrl: null, faviconUrl: null, color: 'DEFAULT', isFavorite: false, isReadLater: false,
            createdAt: node.dateAdded || now, updatedAt: now, isTrashed: false
          }
        : { parentId: L.parentId, name: L.name, color: 'DEFAULT', updatedAt: now };

    const rids = new Set([...Object.keys(items), ...remote.keys()]);
    for (const rid of rids) {
      let it = items[rid];
      const rec = remote.get(rid);
      if (!it) {
        if (!rec) continue;
        if (rec.kind === 'tomb') {
          state.tombs[rec.name] = rec.etag;
          continue;
        }
        it = items[rid] = { t: rec.type, bid: null, etag: null, base: null, seen: null };
      }
      if (rec && rec.type !== it.t) continue;

      const fields = it.t === 'bookmark' ? BM_FIELDS : F_FIELDS;
      const node = it.bid ? snap.nodes.get(it.bid) : null;
      const L = node && !it.rootBound ? localFields(it, node) : null;
      const localGone = !!it.bid && !node;

      // --- Lápida remota
      if (rec && rec.kind === 'tomb') {
        if (it.rootBound) {
          // Las carpetas raíz del navegador no se pueden borrar: se vuelve a crear la carpeta.
          queueUpload(rid, 'folder', specialPayload(rid, it.base), rec);
          continue;
        }
        if (!node) {
          delete items[rid];
          state.tombs[rec.name] = rec.etag;
          continue;
        }
        const changed = it.seen ? fields.some((f) => !sameField(f, L[f], it.seen[f])) : true;
        if (!changed && it.t === 'bookmark') {
          bmRemovals.push({ rid, bid: node.id, rec, permanent: true });
          continue;
        }
        if (!changed && it.t === 'folder') {
          folderDissolves.push({ rid, bid: node.id, rec });
          continue;
        }
        // Cambios en el navegador sin subir: se conserva y se resucita.
        const payload = it.base
          ? { ...it.base, ...L, ...(it.t === 'bookmark' ? { isTrashed: false } : {}), updatedAt: now }
          : fromBrowser(it, node, L);
        queueUpload(rid, it.t, payload, rec);
        continue;
      }

      const B = it.base;
      const R = rec ? rec.payload : B;
      const missing = !!B && !remoteFiles.has(rid); // desapareció del servidor sin lápida
      // Hay que volver a subirlo: desapareció del servidor o allí solo queda el fichero cifrado v1.
      const reupload = missing || legacy.has(rid);

      // --- Nunca subido
      if (!R) {
        if (!node && !it.rootBound) {
          delete items[rid];
          continue;
        }
        if (it.rootBound) queueUpload(rid, 'folder', specialPayload(rid, null), null);
        else if (node) queueUpload(rid, it.t, fromBrowser(it, node, L), null);
        continue;
      }

      // --- Carpeta especial ligada a una raíz del navegador
      if (it.rootBound) {
        accept(it, rec);
        if (reupload) queueUpload(rid, 'folder', specialPayload(rid, B), null);
        continue;
      }

      // --- Borrado en el navegador
      // (it.bid se conserva hasta que la subida funcione: si falla, el borrado se reintenta.)
      if (localGone) {
        if (it.t === 'folder') {
          if (!remoteFiles.has(rid)) {
            delete items[rid];
            continue;
          }
          const ifMatch = etagFor(rid, rec);
          uploads.push({ rid, type: 'folder', tomb: true, deletedAt: now, ifMatch, ifNoneMatch: !ifMatch });
          continue;
        }
        if (R.isTrashed && !reupload) {
          accept(it, rec);
          it.bid = null;
          it.seen = null;
          continue;
        }
        // Borrar en el navegador = mandar a la papelera de Mis Marcadores.
        queueUpload(rid, 'bookmark', { ...R, isTrashed: true, updatedAt: now }, rec, { gone: true });
        continue;
      }

      // --- No está en el navegador (nuevo del servidor, en la papelera o no admitido)
      if (!node) {
        if (rec) {
          accept(it, rec);
          it.skip = false;
        }
        if (reupload) queueUpload(rid, it.t, R, null);
        if (!(it.t === 'bookmark' && R.isTrashed) && !it.skip) creates.push(rid);
        continue;
      }

      // --- Marcador enviado a la papelera desde otro dispositivo
      if (it.t === 'bookmark' && R.isTrashed) {
        if (rec) {
          accept(it, rec);
          bmRemovals.push({ rid, bid: node.id, rec, permanent: false });
        } else {
          queueUpload(rid, 'bookmark', { ...R, ...L, isTrashed: false, updatedAt: now }, null);
        }
        continue;
      }

      // --- Primer emparejamiento (al conectar la cuenta): sin historia común, gana el más
      // reciente. El navegador solo guarda la fecha de creación; el servidor, la de modificación.
      const firstPair = !it.seen && !B && !!rec;
      if (firstPair && it.t === 'bookmark') stats.matched++;
      const browserNewer = firstPair && (Number(node.dateAdded) || 0) > (Number(R.updatedAt) || 0);

      // --- Fusión a tres bandas
      const merged = { ...R };
      const browserChanges = {};
      for (const f of fields) {
        const localChanged = it.seen ? !sameField(f, L[f], it.seen[f]) : false;
        const remoteChanged = rec ? (B ? !sameField(f, R[f], B[f]) : true) : false;
        // Gana el navegador solo si el campo cambió allí y no en el servidor (o, al emparejar por
        // primera vez, si es más reciente). En cualquier otro caso el navegador se ajusta al
        // servidor (también corrige desajustes antiguos).
        if (firstPair ? browserNewer : localChanged && !remoteChanged) merged[f] = L[f];
        else if (!sameField(f, R[f], L[f])) browserChanges[f] = R[f];
      }
      const localWon = fields.some((f) => !sameField(f, merged[f], R[f]));
      if (localWon || reupload) {
        if (localWon) merged.updatedAt = now;
        queueUpload(rid, it.t, merged, missing ? null : rec);
      } else {
        accept(it, rec);
      }
      if (Object.keys(browserChanges).length) updates.push({ rid, bid: node.id, t: it.t, changes: browserChanges });
    }

    // Freno: el servidor quiere borrar muchos marcadores visibles a la vez.
    const permanent = bmRemovals.filter((r) => r.permanent);
    const visible = Object.values(items).filter((it) => it.t === 'bookmark' && it.bid && snap.nodes.has(it.bid)).length;
    if (permanent.length && isMassRemoval(permanent.length, visible)) {
      for (const r of permanent) {
        const it = items[r.rid];
        const payload = { ...(it.base || {}), isTrashed: false };
        if (it.base) queueUpload(r.rid, 'bookmark', payload, r.rec);
      }
      stats.protectedRemote += permanent.length;
      bmRemovals.splice(0, bmRemovals.length, ...bmRemovals.filter((r) => !r.permanent));
    }

    // 4. Aplicar al navegador ------------------------------------------------------------
    const bidFor = (rid) => {
      if (rid == null) return roots.other.id;
      const it = items[rid];
      return it && it.bid ? it.bid : roots.other.id;
    };
    const depthOf = (rid) => {
      let d = 0;
      const seen = new Set();
      let cur = items[rid] && items[rid].base ? items[rid].base.parentId : null;
      while (cur && !seen.has(cur) && items[cur] && d < 64) {
        seen.add(cur);
        d++;
        cur = items[cur].base ? items[cur].base.parentId : null;
      }
      return d;
    };
    const currentParent = (bid) => {
      const n = snap.nodes.get(bid);
      return n ? n.parentId : null;
    };
    // Cómo debería quedar cada nodo del navegador según la sincronización. Si al final no
    // coincide, es que el usuario lo cambió mientras tanto: ese cambio se sube en la próxima.
    const expected = new Map();
    for (const [bid, n] of snap.nodes) if (!n.root) expected.set(bid, { title: n.title, url: n.url, parentId: n.parentId });
    const expect = (bid, patch) => {
      const e = expected.get(bid);
      if (e) Object.assign(e, patch);
    };
    const tryOp = async (label, fn) => {
      try {
        return await fn();
      } catch (e) {
        console.warn('Mis Marcadores:', label, e);
        stats.warnings++;
        return null;
      }
    };

    // Carpetas nuevas (de arriba abajo), luego cambios en carpetas.
    const folderCreates = creates.filter((rid) => items[rid].t === 'folder').sort((a, b) => depthOf(a) - depthOf(b));
    for (const rid of folderCreates) {
      const it = items[rid];
      const created = await tryOp('crear carpeta', () =>
        ext.bookmarks.create({ parentId: bidFor(it.base.parentId), title: it.base.name })
      );
      if (created) {
        it.bid = created.id;
        expected.set(created.id, { title: created.title, url: null, parentId: created.parentId });
      } else it.skip = true;
    }
    for (const u of updates.filter((u) => u.t === 'folder')) {
      if ('name' in u.changes) {
        const ok = await tryOp('renombrar carpeta', () => ext.bookmarks.update(u.bid, { title: u.changes.name }));
        if (ok) expect(u.bid, { title: u.changes.name });
        else expected.delete(u.bid);
      }
      if ('parentId' in u.changes) {
        const target = bidFor(u.changes.parentId);
        if (target !== u.bid && target !== currentParent(u.bid)) {
          const ok = await tryOp('mover carpeta', () => ext.bookmarks.move(u.bid, { parentId: target }));
          if (ok) expect(u.bid, { parentId: target });
          else expected.delete(u.bid);
        }
      }
    }

    // Marcadores nuevos y cambios.
    for (const rid of creates.filter((r) => items[r].t === 'bookmark')) {
      const it = items[rid];
      const created = await tryOp('crear marcador', () =>
        ext.bookmarks.create({ parentId: bidFor(it.base.folderId), title: it.base.title, url: it.base.url })
      );
      if (created) {
        it.bid = created.id;
        expected.set(created.id, { title: created.title, url: created.url, parentId: created.parentId });
        stats.imported++;
      } else it.skip = true;
    }
    for (const u of updates.filter((u) => u.t === 'bookmark')) {
      const change = {};
      if ('title' in u.changes) change.title = u.changes.title;
      if ('url' in u.changes) change.url = u.changes.url;
      if (Object.keys(change).length) {
        const ok = await tryOp('actualizar marcador', () => ext.bookmarks.update(u.bid, change));
        // El navegador puede normalizar la dirección: se toma lo que devuelve.
        if (ok) expect(u.bid, { title: ok.title, url: ok.url });
        else expected.delete(u.bid);
      }
      if ('folderId' in u.changes) {
        const target = bidFor(u.changes.folderId);
        if (target !== currentParent(u.bid)) {
          const ok = await tryOp('mover marcador', () => ext.bookmarks.move(u.bid, { parentId: target }));
          if (ok) expect(u.bid, { parentId: target });
          else expected.delete(u.bid);
        }
      }
    }

    // Retiradas: marcadores borrados o enviados a la papelera desde otro dispositivo.
    for (const r of bmRemovals) {
      const ok = await tryOp('quitar marcador', () => ext.bookmarks.remove(r.bid).then(() => true));
      if (!ok) continue;
      if (r.permanent) {
        delete items[r.rid];
        state.tombs[r.rec.name] = r.rec.etag;
      } else {
        items[r.rid].bid = null;
        items[r.rid].seen = null;
      }
    }

    // Carpetas borradas en otro dispositivo: su contenido pasa a la carpeta superior (como en la app).
    for (const d of folderDissolves) {
      const children = (await tryOp('leer carpeta', () => ext.bookmarks.getChildren(d.bid))) || [];
      const nodeInfo = snap.nodes.get(d.bid);
      const parentBid = nodeInfo ? nodeInfo.parentId : roots.other.id;
      for (const c of children) {
        const ok = await tryOp('mover hijo', () => ext.bookmarks.move(c.id, { parentId: parentBid }));
        if (ok) expect(c.id, { parentId: parentBid });
        else expected.delete(c.id);
      }
      const ok = await tryOp('quitar carpeta', () => ext.bookmarks.remove(d.bid).then(() => true));
      if (ok) {
        delete items[d.rid];
        state.tombs[d.rec.name] = d.rec.etag;
      }
    }

    // Nueva referencia "seen": lo que la sincronización ha dejado en el navegador. Si el usuario
    // ha tocado un nodo entretanto, se usa lo esperado para que su cambio cuente como local.
    snap = await snapshot();
    rebuildIndex();
    const sameNode = (a, b) => a.title === b.title && (a.url || null) === (b.url || null) && a.parentId === b.parentId;
    let editedDuringSync = false;
    const pendingUpload = new Set(uploads.map((u) => u.rid));
    const dissolved = new Set(folderDissolves.filter((d) => !items[d.rid]).map((d) => d.rid));
    const newSeen = new Map();
    for (const [rid, it] of Object.entries(items)) {
      if (!it.bid || it.rootBound) continue;
      const fresh = snap.nodes.get(it.bid);
      if (!fresh) continue;
      const exp = expected.get(it.bid);
      const node = exp && !sameNode(exp, fresh) ? exp : fresh;
      if (node !== fresh) editedDuringSync = true;
      const seen = localFields(it, node);
      // Lo que estaba en una carpeta borrada ha subido un nivel: se trata como cambio local
      // para que el servidor reciba también la nueva ubicación.
      const pf = it.t === 'bookmark' ? 'folderId' : 'parentId';
      if (it.base && dissolved.has(it.base[pf])) seen[pf] = it.base[pf];
      if (pendingUpload.has(rid)) newSeen.set(rid, seen);
      else it.seen = seen;
    }
    await saveState(state);

    if (editedDuringSync) ctx.rerun = true;

    // 5. Subir -----------------------------------------------------------------------------
    // Por fases (carpetas, marcadores, lápidas) y varias a la vez dentro de cada fase.
    const phase = (u) => (u.tomb ? 2 : u.type === 'folder' ? 0 : 1);
    let sinceSave = 0;
    const uploadOne = async (u) => {
      const name = MMCodec.fileName(u.type, u.rid);
      const body = u.tomb
        ? MMCodec.encodeTombstone(u.type, u.rid, u.deletedAt)
        : MMCodec.encode(u.type, u.rid, u.payload);
      let etag;
      try {
        etag = await client.put(name, body, { ifMatch: u.ifMatch, ifNoneMatch: u.ifNoneMatch });
      } catch (e) {
        if (e.code === 'precondition') {
          ctx.rerun = true; // cambió en el servidor: otra ronda para fusionar primero
          return;
        }
        throw e;
      }
      stats.uploaded++;
      const it = items[u.rid];
      if (legacy.has(u.rid)) stats.legacyRewritten++;
      if (!u.tomb && u.type === 'bookmark' && !remoteFiles.has(u.rid) && !(it && it.base)) stats.exported++;
      if (u.tomb) {
        delete items[u.rid];
        state.tombs[name] = etag;
      } else if (it) {
        it.base = MMCodec[u.type === 'bookmark' ? 'normalizeBookmark' : 'normalizeFolder'](u.payload);
        it.etag = etag;
        if (u.gone) {
          it.bid = null;
          it.seen = null;
        } else if (newSeen.has(u.rid)) {
          it.seen = newSeen.get(u.rid);
        }
      }
      if (++sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        await saveState(state);
      }
    };
    try {
      for (let p = 0; p <= 2; p++) await pool(uploads.filter((u) => phase(u) === p), UPLOAD_CONCURRENCY, uploadOne);
    } finally {
      await saveState(state);
    }
  }

  return { synchronize, connect, loadConfig, resetState, CONFIG_KEY, STATE_KEY };
})();
