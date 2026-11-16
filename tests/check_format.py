"""Comprueba que los ficheros que escribe la extensión los puede leer la app (mismas reglas que RemoteCodec.kt)."""
import json, pathlib, re, sys

errors = 0
files = sorted(pathlib.Path(sys.argv[1]).iterdir())
for f in files:
    m = re.match(r'^(bookmark|folder)_(.+)\.json$', f.name)
    if not m:
        continue
    j = json.loads(f.read_text())
    t, i = m.groups()
    def bad(msg):
        global errors
        errors += 1
        print('FAIL', f.name, msg)
    if 'payload' in j:
        # Solo se admite el fichero cifrado desconocido que la prueba deja intacto a propósito.
        if i != 'dddddddd-0000-4000-8000-000000000001': bad('sigue cifrado')
        continue
    if j.get('version') == 1 and j.get('deleted') is True:
        continue  # lápida antigua escrita por la "app" en la prueba; la app la sigue leyendo
    if j.get('format') != 'mismarcadores' or j.get('version') != 2: bad('envoltorio incorrecto')
    if j.get('type') != t or j.get('id') != i: bad('tipo o id no coinciden con el nombre')
    if j.get('deleted') is True:
        if not isinstance(j.get('deletedAt'), int): bad('lápida sin deletedAt')
        continue
    d = j.get('data')
    if not isinstance(d, dict): bad('sin data'); continue
    if t == 'bookmark':
        if not str(d.get('url', '')).strip(): bad('marcador sin dirección')
        for k in ['folderId', 'url', 'title', 'description', 'notes', 'tags', 'imageUrl', 'faviconUrl', 'color',
                  'isFavorite', 'isReadLater', 'createdAt', 'updatedAt', 'isTrashed']:
            if k not in d: bad('falta ' + k)
        if not isinstance(d.get('tags'), list): bad('tags no es una lista')
    else:
        for k in ['parentId', 'name', 'color', 'updatedAt']:
            if k not in d: bad('falta ' + k)
print(f'FORMATO: {len(files)} ficheros revisados, {errors} errores')
sys.exit(1 if errors else 0)
