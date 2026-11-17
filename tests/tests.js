(async () => {
  const log = (...a) => console.log('TEST', ...a);
  let failures = 0;
  const check = (cond, msg) => { if (cond) log('OK  ', msg); else { failures++; log('FAIL', msg); } };

  const SERVER = 'https://nc.test';
  const TOOLBAR = '6d6d6172-6b00-4000-8000-000000000001';
  const F1 = 'f1f1f1f1-0000-4000-8000-000000000001';
  const B1 = 'b1b1b1b1-0000-4000-8000-000000000001';
  const B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
  const B3 = 'b3b3b3b3-0000-4000-8000-000000000003';
  const OLD = 1700000000000; // nov. 2023

  // Ficheros "de la app" (formato v2 en claro), más restos de la versión cifrada.
  const app = (type, id, data) => JSON.stringify({ format: 'mismarcadores', version: 2, type, id, data });
  const v1Encrypted = (type, id) => JSON.stringify({ format: 'mismarcadores', version: 1, type, id, payload: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  DAV.put(`folder_${F1}.json`, app('folder', F1, { parentId: null, name: 'Recetas', color: 'GREEN', updatedAt: OLD }));
  DAV.put(`bookmark_${B1}.json`, app('bookmark', B1, {
    folderId: F1, url: 'https://paella.example/', title: 'Paella', notes: 'nota secreta', tags: ['arroz', 'valencia'],
    isFavorite: true, color: 'RED', createdAt: OLD, updatedAt: OLD
  }));
  DAV.put(`bookmark_${B2}.json`, app('bookmark', B2, { folderId: null, url: 'https://raiz.example/', title: 'En la raiz', isReadLater: true, updatedAt: OLD }));
  DAV.put(`bookmark_${B3}.json`, app('bookmark', B3, { folderId: F1, url: 'https://nueva.example/', title: 'Título de la app', notes: 'nota B3', updatedAt: OLD }));
  const LEGACY_UNKNOWN = 'dddddddd-0000-4000-8000-000000000001';
  DAV.put(`bookmark_${LEGACY_UNKNOWN}.json`, v1Encrypted('bookmark', LEGACY_UNKNOWN));
  DAV.put('keyinfo.json', '{"format":"mismarcadores-keyinfo","version":1}');
  DAV.rootExists = false; // la extensión crea la carpeta si hace falta

  const children = async (id) => BM.getChildren(id);
  const findAll = () => [...BMNodes.values()].filter((n) => n.url);
  const byUrl = (u) => findAll().filter((n) => n.url === u);
  const remoteGet = (type, id) => MMCodec.decode(type, DAV.files.get(`${type}_${id}.json`).content, id);
  const appEdit = (type, id, fn) => DAV.put(`${type}_${id}.json`, MMCodec.encode(type, id, fn(remoteGet(type, id).payload)));
  const appTomb = (type, id) => DAV.put(`${type}_${id}.json`, MMCodec.encodeTombstone(type, id, Date.now()));
  const remoteBookmarks = () => [...DAV.files.keys()].filter((n) => n.startsWith('bookmark_')).map((n) => {
    const id = n.slice(9, -5);
    try { return { id, ...remoteGet('bookmark', id) }; } catch (_) { return { id, kind: 'unreadable' }; }
  });
  const sync = () => MMSync.synchronize();

  try {
    // --- Conexión
    let err = null;
    try { await MMSync.connect({ serverUrl: SERVER, username: 'user', appPassword: 'mal' }); } catch (e) { err = e; }
    check(err && err.code === 'auth', 'contraseña de aplicación incorrecta rechazada');

    const cfg = await MMSync.connect({ serverUrl: SERVER + '/', username: 'user', appPassword: 'app-pass' });
    check(cfg.rootUrl === SERVER + '/remote.php/dav/files/user/MisMarcadores/', 'URL WebDAV igual que la app');
    check(DAV.rootExists, 'carpeta MisMarcadores creada');
    check(!('key' in cfg), 'sin claves ni contraseña maestra');
    await chrome.storage.local.set({ mm_config: cfg });
    await MMSync.resetState();

    // --- Estado inicial del navegador
    await BM.create({ parentId: '1', title: 'Google', url: 'https://google.com' });
    // Coincide con B2 (misma carpeta y dirección) pero es MÁS ANTIGUO: gana el título de la app.
    await BM.create({ parentId: '2', title: 'Duplicado', url: 'https://raiz.example/', dateAdded: OLD - 1000 });
    // Coincide con B3 por dirección, en otra carpeta y MÁS RECIENTE: gana el navegador.
    await BM.create({ parentId: '1', title: 'Título del navegador', url: 'https://nueva.example/' });
    const loc = await BM.create({ parentId: '2', title: 'Carpeta local' });
    await BM.create({ parentId: loc.id, title: 'MDN', url: 'https://developer.mozilla.org/' });

    // --- 1ª sincronización: importar + exportar + emparejar por fecha
    let s = await sync();
    log('stats 1', JSON.stringify(s));
    check(s.imported === 1 && s.exported === 2 && s.matched === 2, 'al conectar: 1 importado, 2 exportados, 2 emparejados');
    check(s.warnings === 1, 'el fichero cifrado desconocido cuenta como aviso');
    const other = await children('2');
    const recetas = other.find((c) => c.title === 'Recetas' && !c.url);
    check(!!recetas, 'carpeta de la app creada en «Otros marcadores»');
    const recetasKids = recetas ? await children(recetas.id) : [];
    check(recetasKids.length === 1 && recetasKids[0].title === 'Paella', 'marcador de la app importado dentro de su carpeta');
    check(byUrl('https://raiz.example/').length === 1, 'marcador coincidente no se duplica');
    check(byUrl('https://raiz.example/')[0].title === 'En la raiz', 'servidor más reciente: el navegador toma el título de la app');
    const raizP = remoteGet('bookmark', B2).payload;
    check(raizP.isReadLater === true && raizP.title === 'En la raiz' && raizP.updatedAt === OLD, 'y el servidor no se reescribe');

    check(byUrl('https://nueva.example/').length === 1, 'coincidente por dirección en otra carpeta no se duplica');
    const b3n = byUrl('https://nueva.example/')[0];
    check(b3n.title === 'Título del navegador' && b3n.parentId === '1', 'navegador más reciente: se queda como está');
    const b3 = remoteGet('bookmark', B3).payload;
    check(b3.title === 'Título del navegador' && b3.folderId === TOOLBAR && b3.notes === 'nota B3' && b3.updatedAt > OLD,
      'y el servidor recibe título y carpeta del navegador conservando las notas');
    check(!remoteBookmarks().some((b) => b.kind === 'live' && b.id !== B3 && b.payload.url === 'https://nueva.example/'), 'sin copia duplicada en el servidor');

    check(DAV.files.has(`folder_${TOOLBAR}.json`), 'carpeta especial «Barra de marcadores» subida');
    const all = remoteBookmarks().filter((b) => b.kind === 'live').map((b) => ({ id: b.id, ...b.payload }));
    const gp = all.find((p) => p.url === 'https://google.com/' || p.url === 'https://google.com');
    check(gp && gp.folderId === TOOLBAR && gp.title === 'Google', 'marcador de la barra exportado con folderId de la barra');
    const mdn = all.find((p) => p.url === 'https://developer.mozilla.org/');
    check(mdn && mdn.folderId && mdn.folderId !== TOOLBAR, 'marcador en carpeta local exportado con su carpeta');
    const sample = JSON.parse(DAV.files.get(`bookmark_${gp.id}.json`).content);
    check(sample.version === 2 && sample.data && !('payload' in sample), 'los ficheros se escriben en claro (versión 2)');
    check(DAV.files.get(`bookmark_${LEGACY_UNKNOWN}.json`).content.includes('payload'), 'el fichero cifrado desconocido no se toca');

    // --- Segunda ronda: nada que hacer (ni siquiera volver a descargar el fichero cifrado)
    const putsBefore = DAV.puts, getsBefore = DAV.gets;
    s = await sync();
    check(DAV.puts === putsBefore && DAV.gets === getsBefore && s.warnings === 0, 'segunda sincronización sin cambios');

    // --- Renombrar en el navegador conserva notas/etiquetas/favorito
    const paella = recetasKids[0];
    await BM.update(paella.id, { title: 'Paella valenciana' });
    await sync();
    let p1 = remoteGet('bookmark', B1).payload;
    check(p1.title === 'Paella valenciana', 'renombrado en el navegador llega al servidor');
    check(p1.notes === 'nota secreta' && p1.tags.join() === 'arroz,valencia' && p1.isFavorite && p1.color === 'RED', 'notas, etiquetas, favorito y color conservados');
    check(p1.updatedAt > OLD, 'updatedAt actualizado');

    // --- Fichero cifrado v1 de un elemento conocido: se reescribe en claro
    DAV.put(`bookmark_${B1}.json`, v1Encrypted('bookmark', B1));
    s = await sync();
    p1 = remoteGet('bookmark', B1).payload;
    check(s.legacyRewritten === 1 && p1.title === 'Paella valenciana' && p1.notes === 'nota secreta', 'fichero cifrado conocido reescrito en claro');
    check(BMNodes.has(paella.id), 'y el marcador sigue en el navegador');

    // --- Si la reescritura en claro falla (red), se reintenta en la siguiente sincronización
    DAV.put(`bookmark_${B1}.json`, v1Encrypted('bookmark', B1));
    const fetchOk = window.fetch;
    window.fetch = async (url, opts = {}) => {
      if (opts.method === 'PUT' && String(url).includes(B1)) throw new TypeError('Failed to fetch');
      return fetchOk(url, opts);
    };
    let netErr = null;
    try { await sync(); } catch (e) { netErr = e; }
    window.fetch = fetchOk;
    check(netErr && netErr.code === 'network', 'fallo de red al reescribir el fichero cifrado');
    s = await sync();
    p1 = remoteGet('bookmark', B1).payload;
    check(s.legacyRewritten === 1 && p1.title === 'Paella valenciana', 'el fichero cifrado se reescribe al reintentar');

    // --- Cambio en la app llega al navegador
    appEdit('bookmark', B2, (p) => ({ ...p, title: 'Raíz editada en el móvil', updatedAt: Date.now() }));
    await sync();
    check(byUrl('https://raiz.example/')[0].title === 'Raíz editada en el móvil', 'cambio de la app aplicado al navegador');

    // --- Cambio simultáneo: título en la app + mover en el navegador
    await BM.move(paella.id, { parentId: '1' });
    appEdit('bookmark', B1, (p) => ({ ...p, title: 'Paella (app)', updatedAt: Date.now() }));
    await sync();
    p1 = remoteGet('bookmark', B1).payload;
    const paellaNode = BMNodes.get(paella.id);
    check(p1.folderId === TOOLBAR && p1.title === 'Paella (app)', 'fusión: carpeta del navegador + título de la app en el servidor');
    check(paellaNode.title === 'Paella (app)' && paellaNode.parentId === '1', 'fusión aplicada en el navegador');

    // --- Mover en la app a otra carpeta
    appEdit('bookmark', B1, (p) => ({ ...p, folderId: F1, updatedAt: Date.now() }));
    await sync();
    check(BMNodes.get(paella.id).parentId === recetas.id, 'mover en la app mueve en el navegador');

    // --- Borrar en el navegador = papelera
    const gNode = byUrl('https://google.com/')[0] || byUrl('https://google.com')[0];
    await BM.remove(gNode.id);
    await sync();
    check(remoteGet('bookmark', gp.id).payload.isTrashed === true, 'borrado en el navegador -> papelera en la app');

    // --- Restaurar desde la papelera de la app
    appEdit('bookmark', gp.id, (p) => ({ ...p, isTrashed: false, updatedAt: Date.now() }));
    await sync();
    check(byUrl(gp.url).length === 1 && BMNodes.get(byUrl(gp.url)[0].id).parentId === '1', 'restaurado en la app reaparece en la barra');

    // --- Papelera desde la app
    appEdit('bookmark', gp.id, (p) => ({ ...p, isTrashed: true, updatedAt: Date.now() }));
    await sync();
    check(byUrl(gp.url).length === 0, 'enviado a la papelera en la app desaparece del navegador');

    // --- Lápida (borrado definitivo en la app)
    appTomb('bookmark', B2);
    await sync();
    check(byUrl('https://raiz.example/').length === 0, 'borrado definitivo en la app se aplica');

    // --- Lápida antigua de la versión 1 (sin payload) también se aplica, como en la app
    await BM.create({ parentId: '2', title: 'Viejo', url: 'https://viejo.example/' });
    await sync();
    const viejoRid = remoteBookmarks().find((b) => b.kind === 'live' && b.payload.url === 'https://viejo.example/').id;
    DAV.put(`bookmark_${viejoRid}.json`, JSON.stringify({ format: 'mismarcadores', version: 1, type: 'bookmark', id: viejoRid, deleted: true, deletedAt: 0, auth: 'x' }));
    await sync();
    check(byUrl('https://viejo.example/').length === 0, 'lápida de la versión 1 se aplica');

    // --- Lápida con cambios sin subir en el navegador: se conserva y se resucita
    const seguro = await BM.create({ parentId: '2', title: 'Seguro', url: 'https://seguro.example/' });
    await sync();
    const extraRid = remoteBookmarks().find((b) => b.kind === 'live' && b.payload.url === 'https://seguro.example/').id;
    await BM.update(seguro.id, { title: 'Seguro editado' });
    appTomb('bookmark', extraRid);
    await sync();
    check(byUrl('https://seguro.example/').length === 1, 'lápida no borra un marcador con cambios sin subir');
    check(remoteGet('bookmark', extraRid).kind === 'live', 'y se vuelve a subir');

    // --- Carpeta borrada en la app: su contenido sube un nivel
    appTomb('folder', F1);
    await sync();
    check(!BMNodes.has(recetas.id), 'carpeta borrada en la app desaparece');
    check(BMNodes.get(paella.id) && BMNodes.get(paella.id).parentId === '2', 'su contenido pasa a la carpeta superior');
    await sync();
    p1 = remoteGet('bookmark', B1).payload;
    check(p1.folderId === null, 'el marcador queda en la raíz también en el servidor');

    // --- Carpeta nueva en la app con subcarpeta
    const FA = 'aaaaaaaa-0000-4000-8000-000000000001', FB = 'bbbbbbbb-0000-4000-8000-000000000001', BX = 'cccccccc-0000-4000-8000-000000000001';
    DAV.put(`folder_${FB}.json`, MMCodec.encode('folder', FB, { parentId: FA, name: 'Hija', updatedAt: 1 }));
    DAV.put(`folder_${FA}.json`, MMCodec.encode('folder', FA, { parentId: TOOLBAR, name: 'Madre', updatedAt: 1 }));
    DAV.put(`bookmark_${BX}.json`, MMCodec.encode('bookmark', BX, { folderId: FB, url: 'https://nieto.example/', title: 'Nieto', updatedAt: 1 }));
    await sync();
    const nieto = byUrl('https://nieto.example/')[0];
    const hija = nieto && BMNodes.get(nieto.parentId);
    const madre = hija && BMNodes.get(hija.parentId);
    check(hija && hija.title === 'Hija' && madre && madre.title === 'Madre' && madre.parentId === '1', 'jerarquía nueva de la app creada en la barra');

    // --- Borrar carpeta en el navegador: lápida + marcadores a la papelera
    await BM.removeTree(madre.id);
    await sync();
    const fa = remoteGet('folder', FA);
    const bx = remoteGet('bookmark', BX);
    check(fa.kind === 'tomb', 'carpeta borrada en el navegador -> lápida');
    check(bx.kind === 'live' && bx.payload.isTrashed, 'sus marcadores -> papelera');

    // --- Freno de borrados masivos del servidor
    const many = [];
    for (let i = 0; i < 25; i++) many.push(await BM.create({ parentId: '2', title: 'M' + i, url: `https://m${i}.example/` }));
    await sync();
    const manyRids = remoteBookmarks().filter((b) => b.kind === 'live' && /m\d+\.example/.test(b.payload.url)).map((b) => b.id);
    const tombAt = Date.now();
    for (const id of manyRids.slice(0, 10)) appTomb('bookmark', id);
    s = await sync();
    check(s.protectedRemote === 10 && findAll().filter((n) => /m\d+\.example/.test(n.url)).length === 25, 'freno: 10 borrados remotos en bloque no se aplican');
    check(remoteGet('bookmark', manyRids[0]).kind === 'live', 'y se vuelven a subir');
    check(remoteGet('bookmark', manyRids[0]).payload.updatedAt >= tombAt, 'con updatedAt posterior a la lápida');

    // --- Freno de borrados masivos en el navegador
    for (const n of many) await BM.remove(n.id);
    for (const n of findAll().filter((n) => n.parentId === '2')) await BM.remove(n.id);
    s = await sync();
    log('stats freno local', JSON.stringify(s));
    check(s.restoredLocal > 0 && findAll().filter((n) => /m\d+\.example/.test(n.url)).length === 25, 'freno: borrado masivo en el navegador se restaura');

    // --- 412: el servidor cambia entre la descarga y la subida
    const target = byUrl('https://seguro.example/')[0];
    await BM.update(target.id, { title: 'Seguro editado 2' });
    const origFetch = window.fetch;
    let injected = false;
    window.fetch = async (url, opts = {}) => {
      if (!injected && opts.method === 'PUT' && String(url).includes(extraRid)) {
        injected = true;
        appEdit('bookmark', extraRid, (p) => ({ ...p, notes: 'nota del móvil', updatedAt: Date.now() }));
      }
      return origFetch(url, opts);
    };
    await sync();
    window.fetch = origFetch;
    const se = remoteGet('bookmark', extraRid).payload;
    check(se.title === 'Seguro editado 2' && se.notes === 'nota del móvil', 'conflicto 412: se refusiona sin perder ningún cambio');

    // --- El usuario edita un marcador mientras la sincronización aplica cambios del servidor
    appEdit('bookmark', B1, (p) => ({ ...p, title: 'Paella (otra vez la app)', updatedAt: Date.now() }));
    const origUpdate = chrome.bookmarks.update;
    chrome.bookmarks.update = async (id, change) => {
      chrome.bookmarks.update = origUpdate;
      const r = await origUpdate(id, change);
      await origUpdate(target.id, { title: 'Editado durante la sincronización' });
      return r;
    };
    await sync();
    chrome.bookmarks.update = origUpdate;
    check(remoteGet('bookmark', extraRid).payload.title === 'Editado durante la sincronización', 'cambio hecho durante la sincronización llega al servidor');
    check(BMNodes.get(target.id).title === 'Editado durante la sincronización', 'y no se revierte en el navegador');
    check(byUrl('https://paella.example/')[0].title === 'Paella (otra vez la app)', 'el cambio de la app también se aplica');

    // --- Reconectar (estado vacío) con todo ya en los dos sitios: no duplica
    const countBefore = findAll().length, filesBefore = DAV.files.size;
    await MMSync.resetState();
    s = await sync();
    check(findAll().length === countBefore && DAV.files.size === filesBefore && s.imported === 0 && s.exported === 0,
      'reconectar no duplica nada en ningún lado');

    // --- Estable al final
    const p0 = DAV.puts, ev0 = window.__events;
    await sync();
    check(DAV.puts === p0 && window.__events === ev0, 'estado final estable (sin subidas ni cambios en el navegador)');
  } catch (e) {
    failures++;
    log('FAIL excepción', String((e && e.stack) || e).replace(/\n/g, ' | '));
  }

  // Ficheros finales para comprobar que la app puede leerlos.
  const dump = {};
  for (const [n, f] of DAV.files) dump[n] = f.content;
  console.log('DUMP ' + btoa(unescape(encodeURIComponent(JSON.stringify(dump)))));
  console.log('DONE failures=' + failures);
})();
