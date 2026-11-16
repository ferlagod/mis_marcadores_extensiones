// Rendimiento: muchos marcadores en los dos lados y latencia de red simulada.
(async () => {
  const log = (...a) => console.log('TEST', ...a);
  let failures = 0;
  const check = (cond, msg) => { if (cond) log('OK  ', msg); else { failures++; log('FAIL', msg); } };
  const N = 600;
  DAV.latency = 30;
  DAV.rootExists = true;
  for (let i = 0; i < N; i++) {
    const id = `5e5e5e5e-0000-4000-8000-${String(i).padStart(12, '0')}`;
    DAV.put(`bookmark_${id}.json`, MMCodec.encode('bookmark', id, { folderId: null, url: `https://srv${i}.example/`, title: 'S' + i, updatedAt: 1 }));
  }
  for (let i = 0; i < N; i++) await BM.create({ parentId: '2', title: 'L' + i, url: `https://loc${i}.example/` });
  const cfg = await MMSync.connect({ serverUrl: 'https://nc.test', username: 'user', appPassword: 'app-pass' });
  await chrome.storage.local.set({ mm_config: cfg });
  await MMSync.resetState();
  let t = performance.now();
  const s = await MMSync.synchronize();
  log(`primera sincronización: ${Math.round(performance.now() - t)} ms`, JSON.stringify(s));
  check(s.imported === N && s.exported === N, 'todo importado y exportado');
  t = performance.now();
  await MMSync.synchronize();
  log(`sincronización sin cambios: ${Math.round(performance.now() - t)} ms`);
  console.log('DONE failures=' + failures);
})();
