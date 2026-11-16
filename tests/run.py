import json, os, pathlib, re, subprocess, sys, tempfile, threading, time

here = pathlib.Path(__file__).resolve().parent
src = pathlib.Path(sys.argv[1]).resolve()
script = sys.argv[2] if len(sys.argv) > 2 else 'tests.js'
libs = ''.join(f'<script src="{(src / "lib" / n).as_uri()}"></script>' for n in ['webdav.js', 'codec.js', 'sync.js'])
(here / 'index.html').write_text(
    '<!doctype html><meta charset="utf-8"><body>'
    f'<script src="mocks.js"></script>{libs}<script src="{script}"></script>')

chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
profile = tempfile.mkdtemp(dir=here)
proc = subprocess.Popen([chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
                         f'--user-data-dir={profile}', '--enable-logging=stderr', '--v=0',
                         (here / 'index.html').as_uri()], stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
lines = []
def reader():
    for line in proc.stderr:
        lines.append(line)
threading.Thread(target=reader, daemon=True).start()
deadline = time.time() + 240
while time.time() < deadline and not any('DONE failures=' in l for l in lines):
    time.sleep(0.5)
proc.kill()

for l in lines:
    m = re.search(r'"(TEST .*|DONE .*)", source', l)
    if not m and "FAIL" in l: print("RAW", l[:1500])
    if m:
        print(m.group(1).encode().decode('unicode_escape').encode('latin-1').decode('utf-8', 'replace'))
    m = re.search(r'"DUMP (.*)", source', l)
    if m:
        import base64
        dump = json.loads(base64.b64decode(m.group(1)).decode('utf-8'))
        out = here / 'final'
        out.mkdir(exist_ok=True)
        for f in out.iterdir(): f.unlink()
        for n, c in dump.items(): (out / n).write_text(c)
if not any('DONE' in l for l in lines):
    print('TIMEOUT'); print(''.join(lines[-30:]))
