// Simulación de chrome.storage, chrome.bookmarks (estilo Chromium) y un Nextcloud WebDAV.
(() => {
  // ---------------- storage
  const store = {};
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const storage = {
    local: {
      async get(keys) {
        const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
        const out = {};
        for (const k of ks) if (k in store) out[k] = clone(store[k]);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = clone(v); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; }
    }
  };

  // ---------------- bookmarks
  let nextId = 100;
  const nodes = new Map();
  const mk = (id, parentId, title, url, extra = {}) => {
    const n = { id, parentId, title, url, children: url ? undefined : [], dateAdded: Date.now(), ...extra };
    nodes.set(id, n);
    if (parentId) nodes.get(parentId).children.push(id);
    return n;
  };
  mk('0', undefined, '', undefined);
  mk('1', '0', 'Barra de marcadores', undefined, { folderType: 'bookmarks-bar' });
  mk('2', '0', 'Otros marcadores', undefined, { folderType: 'other' });
  mk('3', '0', 'Marcadores del móvil', undefined, { folderType: 'mobile' });
  const out = (n) => {
    const o = { id: n.id, parentId: n.parentId, title: n.title, dateAdded: n.dateAdded };
    if (n.url) o.url = n.url;
    if (n.folderType) o.folderType = n.folderType;
    if (n.children) o.children = n.children.map((c) => out(nodes.get(c)));
    return o;
  };
  const detach = (n) => {
    const p = nodes.get(n.parentId);
    p.children = p.children.filter((c) => c !== n.id);
  };
  const removeRec = (id) => {
    const n = nodes.get(id);
    for (const c of n.children || []) removeRec(c);
    nodes.delete(id);
  };
  const isDesc = (anc, id) => {
    for (let cur = nodes.get(id); cur; cur = nodes.get(cur.parentId)) if (cur.id === anc) return true;
    return false;
  };
  window.__events = 0;
  const bookmarks = {
    async getTree() { return [out(nodes.get('0'))]; },
    async getChildren(id) { return nodes.get(id).children.map((c) => { const o = out(nodes.get(c)); delete o.children; return o; }); },
    async create({ parentId, title, url, dateAdded }) {
      if (!nodes.has(parentId)) throw new Error('No parent');
      if (url !== undefined) new URL(url);
      window.__events++;
      return out(mk(String(nextId++), parentId, title || '', url, dateAdded ? { dateAdded } : {}));
    },
    async update(id, { title, url }) {
      const n = nodes.get(id); if (!n) throw new Error('No node');
      if (title !== undefined) n.title = title;
      if (url !== undefined) n.url = url;
      window.__events++;
      return out(n);
    },
    async move(id, { parentId }) {
      const n = nodes.get(id);
      if (isDesc(id, parentId)) throw new Error('Cannot move into descendant');
      detach(n); n.parentId = parentId; nodes.get(parentId).children.push(id);
      window.__events++;
      return out(n);
    },
    async remove(id) {
      const n = nodes.get(id);
      if (n.children && n.children.length) throw new Error('Folder not empty');
      detach(n); nodes.delete(id); window.__events++;
    },
    async removeTree(id) { const n = nodes.get(id); detach(n); removeRec(id); window.__events++; }
  };
  window.chrome = { storage, bookmarks };
  window.BM = bookmarks;
  window.BMNodes = nodes;

  // ---------------- WebDAV
  const ROOT_PATH = '/remote.php/dav/files/user/MisMarcadores/';
  const files = new Map(); // name -> {content, etag}
  let etagSeq = 1;
  const newEtag = () => 'e' + (etagSeq++).toString(16) + Math.random().toString(16).slice(2, 6);
  window.DAV = {
    files,
    rootExists: false,
    puts: 0,
    gets: 0,
    put(name, content) { files.set(name, { content, etag: newEtag() }); },
    reset() { files.clear(); this.puts = 0; this.gets = 0; }
  };
  const xmlResp = (href, etag, len, coll) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
    (coll ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>') +
    (etag ? `<d:getetag>&quot;${etag}&quot;</d:getetag>` : '') +
    (coll ? '' : `<d:getcontentlength>${len}</d:getcontentlength>`) +
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

  window.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const h = opts.headers || {};
    if (h.Authorization !== 'Basic ' + btoa('user:app-pass')) return new Response('', { status: 401 });
    if (!u.pathname.startsWith(ROOT_PATH.slice(0, -1))) return new Response('', { status: 404 });
    const name = decodeURIComponent(u.pathname.slice(ROOT_PATH.length));
    const m = opts.method || 'GET';
    if (m === 'MKCOL') { DAV.rootExists = true; return new Response(null, { status: 201 }); }
    if (m === 'PROPFIND') {
      if (!DAV.rootExists) return new Response('', { status: 404 });
      let body = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">';
      if (!name) {
        body += xmlResp(ROOT_PATH, 'root', 0, true);
        if (h.Depth === '1') for (const [n, f] of files) body += xmlResp(ROOT_PATH + encodeURIComponent(n), f.etag, f.content.length, false);
      } else {
        const f = files.get(name);
        if (!f) return new Response('', { status: 404 });
        body += xmlResp(ROOT_PATH + name, f.etag, f.content.length, false);
      }
      return new Response(body + '</d:multistatus>', { status: 207 });
    }
    if (m === 'GET') {
      DAV.gets++;
      const f = files.get(name);
      return f ? new Response(f.content, { status: 200 }) : new Response('', { status: 404 });
    }
    if (m === 'PUT') {
      const f = files.get(name);
      const im = h['If-Match'], inm = h['If-None-Match'];
      if (im && (!f || '"' + f.etag + '"' !== im)) return new Response('', { status: 412 });
      if (inm === '*' && f) return new Response('', { status: 412 });
      const etag = newEtag();
      files.set(name, { content: opts.body, etag });
      DAV.puts++;
      return new Response(null, { status: f ? 204 : 201, headers: { ETag: '"' + etag + '"' } });
    }
    return new Response('', { status: 405 });
  };
})();
