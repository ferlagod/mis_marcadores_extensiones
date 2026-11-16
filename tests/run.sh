#!/bin/sh
# Pruebas: ejecuta los escenarios de sincronización en Chrome headless (árbol de marcadores y
# Nextcloud simulados) y comprueba que los ficheros resultantes siguen el formato de la app.
set -eu
cd "$(dirname "$0")"
rm -rf final index.html tmp*
python3 run.py ../src
python3 check_format.py final
rm -rf tmp*
