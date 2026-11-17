"""Legge classifica e risultati CSI dal sito con l'automazione ChatGPT e li salva in csi.json.
Scrive il file solo se i dati sono validi e più recenti di quelli già pubblicati."""
import json, pathlib, sys, urllib.request

FONTE = 'https://quinto-csi-saro.rossgna.chatgpt.site/api/csi'
DEST = pathlib.Path(__file__).resolve().parent.parent / 'csi.json'

req = urllib.request.Request(FONTE, headers={'User-Agent': 'QUINTO-Polisportiva-Tigers/1.0', 'Accept': 'application/json'})
with urllib.request.urlopen(req, timeout=60) as r:
    dati = json.load(r)

snap = dati.get('snapshot') or {}
classifica = snap.get('standings') or []
risultati = snap.get('scores') or []
letto = snap.get('checkedAt') or ''
if len(classifica) < 2 or not risultati or not letto:
    sys.exit('Dati CSI incompleti: nessun aggiornamento.')

nuovo = {
    'checkedAt': letto,
    'source': 'Portale CSI tramite automazione ChatGPT',
    'standings': [{k: s.get(k) for k in ('name', 'position', 'points', 'played', 'wins', 'draws', 'losses', 'gf', 'ga', 'notes')} for s in classifica],
    'scores': {s['code']: [s.get('home'), s.get('away'), s.get('date'), s.get('time')] for s in risultati if s.get('home') is not None},
}
if DEST.exists():
    vecchio = json.loads(DEST.read_text())
    if vecchio.get('checkedAt', '') >= letto:
        print('Nessuna lettura CSI più recente di', vecchio.get('checkedAt'))
        sys.exit(0)
DEST.write_text(json.dumps(nuovo, ensure_ascii=False, indent=1))
print('Aggiornato:', letto, '·', len(nuovo['standings']), 'squadre ·', len(nuovo['scores']), 'risultati')
