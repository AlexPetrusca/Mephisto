#!/usr/bin/env python3
# Chrome Native Messaging host for a NATIVE UCI engine -- the "Remote Engine" without a server.
#
# Chrome launches this on stdin/stdout when the extension calls
# chrome.runtime.connectNative('com.<slug>.host'); there is NO listening port and nothing to
# start by hand. One source file serves several engines: install.sh copies it to
# <slug>-host.py (e.g. sf18-native-host.py) and writes the engine's absolute path into a
# sibling <slug>.path file. Optional sibling <slug>.nnue-dir points at a directory of
# Fairy-Stockfish variant nets (EvalFile is switched per UCI_Variant).
#
# Threads/Hash: the host opens with a full-power DEFAULT (all CPU cores, 2048 MB) so it's strong
# even before the extension configures it -- but the extension's Threads/Hash sliders DO override
# these (a native engine isn't sandboxed, so the sliders control it just like the WASM engines).
import sys, os, glob, struct, json, threading, traceback, datetime

_DIR = os.path.dirname(os.path.abspath(__file__))
_SLUG = os.path.basename(os.path.abspath(sys.argv[0] if sys.argv else __file__))
_SLUG = _SLUG[:-len('-host.py')] if _SLUG.endswith('-host.py') else _SLUG

# host defaults -- the whole point of running native (change here, in the open, if ever needed)
FULL_THREADS = os.cpu_count() or 8
FULL_HASH_MB = 2048

_LOG = os.path.join(_DIR, 'host-debug.log')
def _dbg(m):
    try:
        with open(_LOG, 'a') as f:
            f.write(f"{datetime.datetime.now().isoformat()} pid={os.getpid()} [{_SLUG}] {m}\n")
    except Exception:
        pass
_dbg(f"START py={sys.executable} argv={sys.argv}")

try:
    import chess.engine, chess.variant
    from chess.engine import MANAGED_OPTIONS
except Exception:
    _dbg("IMPORT FAILED:\n" + traceback.format_exc())
    raise

def _read_sibling(name):
    p = os.path.join(_DIR, name)
    if os.path.isfile(p):
        return open(p).read().strip() or None
    return None

def _resolve_engine():
    path = _read_sibling(f'{_SLUG}.path')
    if path and os.path.isfile(path):
        return path
    _dbg(f"no usable {_SLUG}.path ({path!r}); giving up")
    raise SystemExit(f"{_SLUG}: engine path missing -- re-run install.sh")

_NNUE_DIR = _read_sibling(f'{_SLUG}.nnue-dir')

# --- native messaging framing (4-byte LE length prefix + UTF-8 JSON) --------- #
_stdout_lock = threading.Lock()
def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack('<I', raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode('utf-8'))

def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    with _stdout_lock:
        sys.stdout.buffer.write(struct.pack('<I', len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

# --- response formatting (kept identical to remote-engine.py) --------------- #
def format_line(line, terminal, bestmove, in_check=False):
    if line.get('pv'):
        pv = list(map(str, line.get('pv')))
        score_prefix = 'mate' if line.get('score').is_mate() else 'cp'
        formatted = {
            'depth': line.get('depth'), 'seldepth': line.get('seldepth'),
            'multipv': line.get('multipv'), 'nodes': line.get('nodes'),
            'nps': line.get('nps'), 'hashfull': line.get('hashfull'),
            'tbhits': line.get('tbhits'), 'time': line.get('time'),
            'move': pv[0], 'pv': pv,
            'rawScore': f"{score_prefix} {line.get('score').relative}",
        }
        score = line.get('score').white()
        if line.get('score').is_mate():
            formatted['mate'] = score.mate()
        else:
            formatted['score'] = score.score()
        wdl = line.get('wdl')  # present only when the engine declares UCI_ShowWDL
        if wdl is not None:
            try:
                w = wdl.white()  # -> Wdl(wins, draws, losses) from White's perspective, permille
                formatted['wdl'] = [w.wins, w.draws, w.losses]  # [white, draw, black]
            except Exception:
                pass  # unexpected wdl shape (old python-chess) -- just omit it, never crash analyse
        return formatted
    if terminal:
        score = line.get('score')
        if score is not None and score.is_mate():
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': f'mate {score.relative}', 'mate': score.white().mate()}
        if score is None and in_check:
            # a mated position gets NO info lines (score None); without this the popup falls
            # into the cp branch and shows "Stalemate!"/"Draw" for a checkmate
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': 'mate 0', 'mate': 0}
        return {'move': '(none)', 'depth': line.get('depth', 0),
                'rawScore': f'cp {score.relative if score is not None else 0}',
                'score': score.white().score() if score is not None else 0}
    if bestmove is not None and bestmove != chess.Move.null():
        return {'move': bestmove.uci(), 'depth': line.get('depth', 0),
                'pv': [bestmove.uci()], 'rawScore': 'cp 0', 'score': 0}
    return {'move': '(none)', 'depth': line.get('depth', 0), 'rawScore': 'cp 0', 'score': 0}

def format_lines(lines, terminal, bestmove, in_check=False):
    lines = [format_line(l, terminal, bestmove, in_check) for l in (lines or [{}])]
    if 'pv' in lines[0]:
        pv0 = lines[0].get('pv')
        best, threat = pv0[0], pv0[1] if len(pv0) > 1 else '(none)'
        # a partial deeper iteration can change the engine's FINAL bestmove after the last
        # completed info line -- the true bestmove wins
        if bestmove is not None and bestmove != chess.Move.null() and bestmove.uci() != best:
            best, threat = bestmove.uci(), '(none)'
        return {'bestmove': best, 'threat': threat, 'lines': lines}
    return {'bestmove': '(none)', 'threat': '(none)', 'lines': lines}

# --- engine state (opened LAZILY: a `ping` availability probe must NOT launch the engine, so the
# extension can cheaply check which native engines are installed without spawning Stockfish x N) --- #
_ENGINE_PATH = _resolve_engine()  # cheap: reads the sibling .path, validates it exists
engine = None
_engine_init_lock = threading.Lock()
engine_options = {}
engine_lock = threading.Lock()
request_lock = threading.Lock()
request_counter = 0

def _set_if_declared(key, value):
    try:
        if key in engine.options:
            engine.configure({key: value})
    except Exception as e:
        _dbg(f"couldn't set {key}={value}: {e}")

def get_engine():
    global engine
    if engine is not None:
        return engine
    with _engine_init_lock:
        if engine is None:
            _dbg(f"opening engine: {_ENGINE_PATH}")
            engine = chess.engine.SimpleEngine.popen_uci(_ENGINE_PATH)
            # full-power default; the extension's configure (Threads/Hash sliders) overrides this
            _set_if_declared('Threads', FULL_THREADS)
            _set_if_declared('Hash', FULL_HASH_MB)
            _set_if_declared('UCI_ShowWDL', True)  # so info lines carry `wdl W D L` for the panel
            _apply_variant_net(None)
            _dbg(f"engine ready: Threads={FULL_THREADS} Hash={FULL_HASH_MB}")
    return engine

def _apply_variant_net(variant):
    # Fairy-Stockfish: each variant has its own net; standard chess uses the nn-* net.
    if not _NNUE_DIR:
        return
    prefix = 'nn' if variant in (None, 'chess', 'fischerandom') else variant
    hits = sorted(glob.glob(os.path.join(_NNUE_DIR, f'{prefix}-*.nnue')))
    if hits:
        _set_if_declared('EvalFile', hits[0])
        _set_if_declared('Use NNUE', True)
        _dbg(f"EvalFile -> {hits[0]}")

def do_analyse(data, mid):
    global request_counter
    get_engine()  # open on first real use (not on a ping probe)
    with request_lock:
        request_counter += 1
        request_id = request_counter
    with engine_lock:
        variant = engine_options.get('UCI_Variant')
        if variant in (None, 'chess', 'fischerandom'):
            board = chess.Board(data['fen'],
                                chess960=(variant == 'fischerandom'
                                          or bool(engine_options.get('UCI_Chess960'))))
        else:
            board = chess.variant.find_variant(variant)(data['fen'])
        if data.get('moves'):
            for mv in data['moves'].split():
                board.push(chess.Move.from_uci(mv))
        limit = chess.engine.Limit(time=data['time'] / 1000)
        multipv = int(engine_options.get('MultiPV', 1))
        if 'multipv' not in engine.options:
            multipv = 1
        terminal = not any(board.legal_moves)  # game-over is a property of the POSITION
        in_check = board.is_check()            # terminal + in_check = checkmate, not stalemate
        with engine.analysis(board, limit, multipv=multipv) as analysis:
            bestmove = None
            if request_counter == request_id:
                for info in analysis:
                    if request_counter != request_id:
                        break  # superseded by a newer position
                    # STREAM per-depth updates (live depth UI + JS premove certification).
                    # Aspiration re-searches emit `score cp N lowerbound|upperbound` lines whose pv
                    # is a partial, unresolved guess. The WASM path drops them (popup.js checks the
                    # raw UCI text); over here format_line does NOT forward the flag, so the popup
                    # cannot tell them apart -- they have to be dropped HERE or they land in the
                    # premove depth-13/14 certification snapshots as if they were finished lines.
                    if (info.get('pv') and info.get('score') is not None
                            and not info.get('lowerbound') and not info.get('upperbound')):
                        try:
                            send_message({'id': mid, 'info': format_line(info, False, None)})
                        except Exception:
                            pass
                if request_counter == request_id:
                    bestmove = analysis.wait().move
        return format_lines(analysis.multipv, terminal, bestmove, in_check)

def do_configure(data):
    get_engine()  # a configure is a real use -> open the engine (a ping never gets here)
    with engine_lock:
        for key, value in (data.get('options') or {}).items():
            engine_options[key] = value
            if key == 'UCI_Variant':
                _apply_variant_net(value if value != 'chess' else None)
            if key.lower() in MANAGED_OPTIONS:
                continue
            if key not in engine.options:
                continue
            try:
                engine.configure({key: value})
            except Exception as e:
                _dbg(f"configure {key}={value} failed: {e}")
        return {'ok': True}

def handle(msg):
    mid = msg.get('id')
    try:
        if msg.get('cmd') == 'ping':
            send_message({'id': mid, 'ok': True})  # host is installed & alive; does NOT open the engine
        elif msg.get('cmd') == 'analyse':
            send_message({'id': mid, **do_analyse(msg, mid), 'done': True})
        elif msg.get('cmd') == 'configure':
            send_message({'id': mid, **do_configure(msg)})
        else:
            send_message({'id': mid, 'error': f"unknown cmd {msg.get('cmd')!r}"})
    except Exception as e:  # never let one bad request kill the host
        send_message({'id': mid, 'error': str(e)})

def main():
    # reader loop that never blocks on a search: each message runs on its own thread,
    # so a newer 'analyse' bumps request_counter and supersedes the old one
    while True:
        msg = read_message()
        if msg is None:
            break  # Chrome closed the port
        threading.Thread(target=handle, args=(msg,), daemon=True).start()
    try:
        engine.quit()
    except Exception:
        pass

if __name__ == '__main__':
    main()
