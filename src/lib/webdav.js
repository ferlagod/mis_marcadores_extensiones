// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ferlagod
// Mis Marcadores — extensión de navegador

/*
 * Cliente WebDAV mínimo para Nextcloud, equivalente a WebDavClient.kt.
 * Usa ETags e If-Match / If-None-Match para no pisar nunca un cambio remoto no visto.
 * El XML se analiza con expresiones regulares porque los service workers no tienen DOMParser.
 */
class MMError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code; // 'auth' | 'precondition' | 'http' | 'network' | 'path' | 'browser'
    this.status = status;
  }
}

const MMWebDav = (() => {
  const PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop>' +
    '<d:getlastmodified/><d:getetag/><d:resourcetype/><d:getcontentlength/>' +
    '</d:prop></d:propfind>';

  function normalizeEtag(raw) {
    if (!raw) return null;
    const v = String(raw).trim().replace(/^W\//, '').replace(/^"+|"+$/g, '');
    return v || null;
  }

  function decodeXml(s) {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, '&');
  }

  function tagText(block, tag) {
    const m = block.match(new RegExp('<(?:[\\w-]+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?' + tag + '>', 'i'));
    return m ? decodeXml(m[1].trim()) : null;
  }

  function parsePropfind(xml) {
    const out = [];
    const re = /<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const block = m[1];
      if (/<(?:[\w-]+:)?collection\s*\/?>/i.test(block)) continue;
      const href = tagText(block, 'href');
      if (!href) continue;
      let path;
      try {
        path = decodeURIComponent(href.replace(/\+/g, '%2B'));
      } catch (_) {
        path = href;
      }
      path = path.replace(/\/+$/, '');
      const name = path.substring(path.lastIndexOf('/') + 1);
      if (!name) continue;
      out.push({
        name,
        etag: normalizeEtag(tagText(block, 'getetag')),
        size: Number(tagText(block, 'getcontentlength')) || 0
      });
    }
    return out;
  }

  function utf8Base64(str) {
    const bytes = new TextEncoder().encode(str);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** Igual que AuthPreferences.buildWebDavRootUrl. */
  function buildRootUrl(serverUrl, username) {
    const raw = serverUrl.trim().replace(/\/+$/, '');
    if (raw.includes('/remote.php/dav/files/')) return raw + '/';
    return raw + '/remote.php/dav/files/' + encodeURIComponent(username) + '/MisMarcadores/';
  }

  class Client {
    constructor(rootUrl, username, appPassword) {
      this.root = rootUrl.endsWith('/') ? rootUrl : rootUrl + '/';
      this.auth = 'Basic ' + utf8Base64(username + ':' + appPassword);
    }

    url(name) {
      return name ? this.root + encodeURIComponent(name) : this.root;
    }

    async request(method, name, { body, headers = {}, timeoutMs = 60000 } = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(this.url(name), {
          method,
          body,
          headers: { Authorization: this.auth, ...headers },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
          signal: ctrl.signal
        });
        if (res.status === 401 || res.status === 403) {
          throw new MMError('auth', 'Usuario o contraseña de aplicación incorrectos', res.status);
        }
        return res;
      } catch (e) {
        if (e instanceof MMError) throw e;
        const msg = e && e.name === 'AbortError' ? 'El servidor tardó demasiado en responder' : 'No se pudo conectar con el servidor';
        throw new MMError('network', msg);
      } finally {
        clearTimeout(timer);
      }
    }

    propfind(name, depth) {
      return this.request('PROPFIND', name, {
        body: PROPFIND_BODY,
        headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }
      });
    }

    /** Comprueba credenciales y crea la carpeta MisMarcadores si no existe. */
    async ensureRoot() {
      const res = await this.propfind('', 0);
      if (res.ok) return;
      if (res.status !== 404) throw new MMError('http', `No se pudo acceder a la carpeta en Nextcloud (${res.status})`, res.status);
      const mk = await this.request('MKCOL', '');
      if (mk.ok || mk.status === 405) return;
      if (mk.status === 409) throw new MMError('path', 'La ruta WebDAV no existe; revisa la dirección del servidor y el usuario', 409);
      throw new MMError('http', `No se pudo crear la carpeta en Nextcloud (${mk.status})`, mk.status);
    }

    async list() {
      const res = await this.propfind('', 1);
      if (!res.ok) throw new MMError('http', `Error al listar ficheros en Nextcloud (${res.status})`, res.status);
      const text = await res.text();
      return text.trim() ? parsePropfind(text) : [];
    }

    /** Devuelve el texto del fichero o null si no existe. */
    async get(name) {
      const res = await this.request('GET', name);
      if (res.status === 404) return null;
      if (!res.ok) throw new MMError('http', `Error al descargar ${name} (${res.status})`, res.status);
      return res.text();
    }

    async etag(name) {
      const res = await this.propfind(name, 0);
      if (!res.ok) return null;
      const items = parsePropfind(await res.text());
      return items.length ? items[0].etag : null;
    }

    /** PUT con control de concurrencia. Lanza MMError('precondition') si el fichero cambió. */
    async put(name, text, { ifMatch = null, ifNoneMatch = false } = {}) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (ifMatch) headers['If-Match'] = '"' + ifMatch + '"';
      else if (ifNoneMatch) headers['If-None-Match'] = '*';
      const res = await this.request('PUT', name, { body: text, headers });
      if (res.status === 412) throw new MMError('precondition', `${name} cambió en el servidor`, 412);
      if (!res.ok) throw new MMError('http', `Error al subir ${name} (${res.status})`, res.status);
      return normalizeEtag(res.headers.get('OC-ETag') || res.headers.get('ETag')) || (await this.etag(name));
    }
  }

  return { Client, buildRootUrl, normalizeEtag, parsePropfind };
})();
