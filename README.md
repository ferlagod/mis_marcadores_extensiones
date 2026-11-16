# Mis Marcadores — extensión para Chromium y Firefox

Sincroniza los **marcadores nativos del navegador** con la app [Mis Marcadores](../../Mis%20Apps/MisMarcadores) a través de tu Nextcloud, con el mismo formato de ficheros (`MisMarcadores/` en WebDAV, JSON en claro, versión 2).

No es un gestor de marcadores aparte (como Raindrop): no tiene lista propia ni ventana emergente. Crea, renombra, mueve y borra los marcadores del propio navegador. Su única pantalla es la de ajustes (se abre con el icono de la extensión).

## Instalar

```sh
./build.sh          # genera dist/chromium, dist/firefox y sus .zip
```

**Chrome, Edge, Brave, Vivaldi, Opera…** → `chrome://extensions` → activar *Modo de desarrollador* → *Cargar descomprimida* → `dist/chromium`.

**Firefox** (128 o posterior):
- Para probar: `about:debugging` → *Este Firefox* → *Cargar complemento temporal* → `dist/firefox/manifest.json` (se quita al cerrar Firefox).
- Para uso permanente hay que firmarla: sube `dist/mis-marcadores-firefox-*.zip` a [addons.mozilla.org](https://addons.mozilla.org/developers/) como **no listada** (se firma de forma automática y no aparece en la tienda). En Firefox Developer Edition/Nightly/ESR también puedes poner `xpinstall.signatures.required = false` en `about:config`.

## Configurar

En la página de ajustes, los mismos datos que en *Ajustes → Sincronización* de la app: servidor, usuario y contraseña de aplicación. El navegador pedirá permiso para acceder solo a tu servidor.

Al conectar se hace la primera sincronización automáticamente: se **importan** al navegador los marcadores de la app, se **exportan** a la app los del navegador y los que están en los dos sitios se emparejan (ver abajo). La página de ajustes muestra el resumen.

Sincroniza al arrancar el navegador, unos segundos después de cada cambio en los marcadores y cada 10 minutos.

## Correspondencia de carpetas

| Navegador | Mis Marcadores |
|---|---|
| Otros marcadores | Raíz (sin carpeta) |
| Barra de marcadores | Carpeta «Barra de marcadores» |
| Menú de marcadores (Firefox) | Carpeta «Menú de marcadores» (en Chromium aparece como carpeta normal) |
| Marcadores del móvil | Carpeta «Marcadores del móvil» |

Las carpetas especiales tienen identificadores fijos, así que todos los navegadores comparten la misma.

## Comportamiento

- **Fusión a tres bandas por campo** (título, dirección, carpeta). Si un campo cambió solo en el navegador gana el navegador; si cambió en el servidor (o en los dos sitios), gana el servidor.
- **Lo que el navegador no conoce se conserva**: notas, etiquetas, descripción, color, favorito, «Leer más tarde», imagen, fechas.
- **Borrar en el navegador = mandar a la papelera** de la app (recuperable). Restaurarlo en la app lo hace reaparecer.
- Lo que está en la papelera de la app no aparece en el navegador. Un borrado definitivo en la app (lápida verificada) lo quita del navegador.
- Al borrar una carpeta en la app, su contenido sube un nivel en el navegador (como en la app).
- **Primera sincronización** (al conectar o reconectar): los marcadores con la misma dirección no se duplican; se emparejan primero en la misma carpeta y, si no, en cualquiera. Si difieren en título o carpeta, **gana el más reciente**: la fecha en que se añadió al navegador (el navegador no guarda fecha de modificación) frente a `updatedAt` en la app. Lo que la app guarda y el navegador no (notas, etiquetas…) se conserva siempre.
- **Ficheros cifrados antiguos** (versión 1): como en la app, si la extensión conoce el elemento lo vuelve a subir en claro encima; si no, se ignora (cuenta como aviso). `keyinfo.json` se ignora.
- **Seguridad**: subidas con `If-Match` / `If-None-Match`, una lápida no borra un marcador con cambios sin subir, freno de borrados masivos en ambos sentidos (los del servidor como la app; en el navegador, 50 o más, o 20 o más si son la mitad: se restauran).

## Limitaciones

- No se sincroniza el **orden** dentro de las carpetas (la app no lo guarda); los nuevos se añaden al final.
- Separadores y consultas `place:` de Firefox no se sincronizan.
- Si usas también la sincronización propia del navegador (Chrome Sync, Firefox Sync), instala la extensión en **un solo** equipo de cada cuenta del navegador para evitar duplicados.
- La contraseña de aplicación se guarda en el almacenamiento local de la extensión. Los ficheros en Nextcloud van en claro: la protección es la de tu servidor (HTTPS y su cifrado del lado del servidor, si lo tienes activado).

## Pruebas

```sh
tests/run.sh
```

Ejecuta los escenarios de sincronización con el código real de la extensión en Chrome headless (árbol de marcadores y Nextcloud simulados) y comprueba que todo lo que la extensión escribe sigue el formato que lee la app (`RemoteCodec.kt`). Requiere Python 3 y Google Chrome.

## Estructura

```
src/lib/webdav.js   cliente WebDAV con ETags (WebDavClient.kt)
src/lib/codec.js    formato de ficheros (RemoteCodec.kt)
src/lib/sync.js     motor de sincronización con los marcadores del navegador
src/background.js   eventos, alarma periódica y mensajes
src/options/        página de ajustes
manifests/          manifiesto de Chromium (service worker) y de Firefox (scripts de fondo)
```

Licencia GPL-3.0-or-later, como la app.
