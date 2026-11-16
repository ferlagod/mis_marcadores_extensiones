// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ferlagod
// Mis Marcadores — extensión de navegador

/*
 * Formato de los ficheros de Nextcloud (docs/SYNC_FORMAT.md y RemoteCodec.kt de la app).
 *   { "format": "mismarcadores", "version": 2, "type": "bookmark", "id": "<uuid>", "data": { … } }
 *   { "format": "mismarcadores", "version": 2, "type": "bookmark", "id": "<uuid>", "deleted": true, "deletedAt": 0 }
 * La versión 1 iba cifrada en "payload" y ya no se lee: si este navegador conoce el elemento,
 * lo vuelve a subir en claro encima (igual que la app).
 */
class MMLegacyFileError extends Error {
  constructor() {
    super('Fichero cifrado de la versión 1');
  }
}

const MMCodec = (() => {
  const FORMAT = 'mismarcadores';
  const VERSION = 2;
  const LEGACY_ENCRYPTED_VERSION = 1;

  const fileName = (type, id) => `${type}_${id}.json`;

  /** Devuelve {type, id} si el nombre es un fichero de datos de la app. */
  function parseFileName(name) {
    const m = /^(bookmark|folder)_(.+)\.json$/.exec(name);
    return m ? { type: m[1], id: m[2] } : null;
  }

  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);

  /** Normaliza un marcador (mismos valores por defecto que RemoteCodec.decodeBookmark). */
  function normalizeBookmark(p) {
    const updatedAt = Number(p.updatedAt) || 0;
    return {
      ...p,
      folderId: strOrNull(p.folderId),
      url: String(p.url || ''),
      title: typeof p.title === 'string' ? p.title : '',
      description: typeof p.description === 'string' ? p.description : '',
      notes: typeof p.notes === 'string' ? p.notes : '',
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      imageUrl: strOrNull(p.imageUrl),
      faviconUrl: strOrNull(p.faviconUrl),
      color: typeof p.color === 'string' && p.color ? p.color : 'DEFAULT',
      isFavorite: !!p.isFavorite,
      isReadLater: !!p.isReadLater,
      createdAt: Number(p.createdAt) || updatedAt,
      updatedAt,
      isTrashed: !!p.isTrashed
    };
  }

  function normalizeFolder(p) {
    return {
      ...p,
      parentId: strOrNull(p.parentId),
      name: typeof p.name === 'string' ? p.name : '',
      color: typeof p.color === 'string' && p.color ? p.color : 'DEFAULT',
      updatedAt: Number(p.updatedAt) || 0
    };
  }

  const envelope = (type, id) => ({ format: FORMAT, version: VERSION, type, id });

  function encode(type, id, payload) {
    const data = type === 'bookmark' ? normalizeBookmark(payload) : normalizeFolder(payload);
    return JSON.stringify({ ...envelope(type, id), data });
  }

  function encodeTombstone(type, id, deletedAt) {
    return JSON.stringify({ ...envelope(type, id), deleted: true, deletedAt });
  }

  /**
   * Descodifica un fichero. Devuelve {kind:'live', payload} o {kind:'tomb', deletedAt}.
   * Lanza MMLegacyFileError si es un fichero cifrado de la versión 1, o Error si no es válido.
   */
  function decode(type, raw, expectedId) {
    const json = JSON.parse(raw);
    if (json.format !== FORMAT) throw new Error('Formato desconocido');
    const version = Number(json.version) || 0;
    if (version > VERSION) throw new Error('Fichero de una versión más nueva de Mis Marcadores');
    if (json.type !== type) throw new Error('Tipo inesperado');
    if (json.id !== expectedId) throw new Error('El id del fichero no coincide con su nombre');
    if (version <= LEGACY_ENCRYPTED_VERSION && 'payload' in json) throw new MMLegacyFileError();

    if (json.deleted === true) return { kind: 'tomb', deletedAt: Number(json.deletedAt) || 0 };

    const data = json.data;
    if (!data || typeof data !== 'object') throw new Error('Fichero sin datos');
    if (type === 'bookmark') {
      const p = normalizeBookmark(data);
      if (!p.url.trim()) throw new Error('Marcador sin dirección');
      return { kind: 'live', payload: p };
    }
    return { kind: 'live', payload: normalizeFolder(data) };
  }

  return { fileName, parseFileName, normalizeBookmark, normalizeFolder, encode, encodeTombstone, decode };
})();
