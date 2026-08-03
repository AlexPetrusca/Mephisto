#!/usr/bin/env python3
# Chrome Native Messaging host for Tetrarch -- the four-player engine.
#
# Chrome launches this on stdin/stdout when the extension calls
# chrome.runtime.connectNative('com.tetrarch.host'); there is NO listening port.
# Install with ./install-native.sh --tetrarch, like the other native hosts.
#
# WHY THIS DOES NOT USE python-chess, unlike every other host here:
# python-chess is a TWO-player library. Its parser is built on 64 squares and a
# `chess.Move`, so `n14` is not a square it can name, `position fen4 ...` is not
# a command it can send, and `go rtime/btime/ytime/gtime` is not a clock shape it
# models. SimpleEngine would reject Tetrarch's output before we ever saw it. So
# this host speaks the line protocol directly over a pipe -- which is also less
# machinery than the two-player hosts need, because Tetrarch is single-threaded:
# `go` runs to completion and `stop` is accepted-and-ignored (PROTOCOL.md §5), so
# there is no cancellation to model and no post-bestmove chain to harvest.
#
# Engine path resolution order:
#   1. $TETRARCH_DIR   2. a sibling file `tetrarch-path`   3. ../../../Tetrarch
import sys, os, struct, json, queue, threading, subprocess, traceback, datetime

_DIR = os.path.dirname(os.path.abspath(__file__))
_LOG = os.path.join(_DIR, 'host-debug.log')
def _dbg(m):
    try:
        with open(_LOG, 'a') as f:
            f.write(f"{datetime.datetime.now().isoformat()} pid={os.getpid()} tetrarch {m}\n")
    except Exception:
        pass

def _resolve_repo():
    if os.environ.get('TETRARCH_DIR'):
        return os.environ['TETRARCH_DIR']
    sibling = os.path.join(_DIR, 'tetrarch-path')
    if os.path.isfile(sibling):
        return open(sibling).read().strip()
    return os.path.abspath(os.path.join(_DIR, '..', '..', 'Tetrarch'))

def _resolve_python():
    for cand in ('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', sys.executable):
        if cand and os.path.isfile(cand):
            return cand
    return 'python3'

# --- native messaging framing (4-byte LE length prefix + UTF-8 JSON) --------- #
def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack('<I', raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode('utf-8'))

# Queued writes, never inline -- the same reason as the other hosts: a native-messaging
# write blocks once the pipe fills and Chrome is not draining, and a blocked writer
# inside the engine-reader thread would stop us consuming engine output entirely.
_send_q = queue.Queue()
def _sender_loop():
    while True:
        obj = _send_q.get()
        try:
            data = json.dumps(obj).encode('utf-8')
            sys.stdout.buffer.write(struct.pack('<I', len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except Exception:
            return  # port closed
def send_message(obj):
    _send_q.put(obj)

# --- the engine ------------------------------------------------------------- #
engine_lock = threading.Lock()   # one search at a time; Tetrarch is single-threaded
_proc = None
_repo = _resolve_repo()

def _start_engine():
    """Launch `python3 uci.py` with cwd = the repo root. The cwd matters: the Net
    option defaults to the RELATIVE path `nets/net-v4.nnue`, so starting anywhere
    else gives an engine that boots and then cannot load its evaluation."""
    global _proc
    if _proc and _proc.poll() is None:
        return _proc
    uci = os.path.join(_repo, 'uci.py')
    if not os.path.isfile(uci):
        raise RuntimeError(f"Tetrarch not found at {_repo} -- set TETRARCH_DIR or native-host/tetrarch-path")
    _proc = subprocess.Popen([_resolve_python(), uci], cwd=_repo,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, bufsize=1)
    _send('uci')
    _read_until(lambda l: l.strip() == 'uciok', timeout=30)
    _dbg(f"engine up from {_repo}")
    return _proc

def _send(line):
    _proc.stdin.write(line + '\n')
    _proc.stdin.flush()

def _read_until(pred, timeout=600, on_line=None):
    """Read engine lines until `pred(line)`. Returns the matching line, or None if
    the engine died. `on_line` sees every line first (that is how info streams)."""
    deadline = datetime.datetime.now().timestamp() + timeout
    while True:
        if _proc.poll() is not None:
            return None
        line = _proc.stdout.readline()
        if line == '':
            return None
        if on_line:
            on_line(line.rstrip('\n'))
        if pred(line):
            return line.rstrip('\n')
        if datetime.datetime.now().timestamp() > deadline:
            return None

# --- UCI info -> the frame shape the panel already consumes ----------------- #
def parse_info(line):
    """`info depth 9 score cp 363 nodes 305328 nps 1278456 time 238 pv h2h3 b8c8 ...`
    -> the same dict shape the two-player hosts emit, so the transport is identical.
    Scores are the SIDE-TO-MOVE'S TEAM (PROTOCOL.md), not White -- the panel is told
    which seat is to move separately and does not have to guess."""
    t = line.split()
    if not t or t[0] != 'info':
        return None
    out, i = {}, 1
    while i < len(t):
        k = t[i]
        if k == 'pv':
            out['pv'] = t[i + 1:]
            out['move'] = t[i + 1] if len(t) > i + 1 else None
            break
        if k == 'score' and i + 2 < len(t):
            kind, val = t[i + 1], t[i + 2]
            out['rawScore'] = f"{kind} {val}"
            try:
                out['mate' if kind == 'mate' else 'score'] = int(val)
            except ValueError:
                pass
            i += 3
            continue
        if k in ('depth', 'seldepth', 'nodes', 'nps', 'time', 'multipv', 'hashfull'):
            try:
                out[k] = int(t[i + 1])
            except (ValueError, IndexError):
                pass
            i += 2
            continue
        if k == 'string':
            return None  # `info string ...` is human-readable, not a line
        i += 1
    return out or None

# --- commands --------------------------------------------------------------- #
# Options Tetrarch declares that we let the extension set. Mode and Setup RESET THE
# BOARD when changed (PROTOCOL.md), so they are only sent when the value differs.
_OPTIONS = {}

def do_configure(data):
    with engine_lock:
        _start_engine()
        for key, value in (data.get('options') or {}).items():
            if _OPTIONS.get(key) == value:
                continue   # Setup/Mode reset the board -- never re-send an unchanged value
            _OPTIONS[key] = value
            if isinstance(value, bool):
                value = 'true' if value else 'false'
            _send(f"setoption name {key} value {value}")
        _send('isready')
        _read_until(lambda l: l.strip() == 'readyok', timeout=30)
        return {'ok': True}

_request_lock = threading.Lock()
_request_counter = 0

def do_analyse(data, mid):
    global _request_counter
    with _request_lock:
        _request_counter += 1
        request_id = _request_counter
    with engine_lock:
        if _request_counter != request_id:
            return {'superseded': True}     # a newer position arrived while we queued
        _start_engine()
        # FEN4 is a SINGLE TOKEN with the newlines stripped (RULES.md §11), and the
        # board is found by the LAST '-' in the string -- so it must never be split
        # or reflowed on the way here.
        fen4 = (data.get('fen4') or '').strip()
        setup = data.get('setup') or 'classic'
        moves = (data.get('moves') or '').strip()
        if fen4:
            pos = f"position fen4 {fen4}"
        else:
            pos = f"position startpos {setup}"
        if moves:
            pos += f" moves {moves}"
        _send(pos)

        lines, best = {}, None
        def on_line(l):
            if not l.startswith('info'):
                return
            info = parse_info(l)
            if not info:
                return
            lines[info.get('multipv', 1)] = info
            if _request_counter == request_id:
                send_message({'id': mid, 'info': info})

        ms = int(data.get('time') or 1000)
        _send(f"go movetime {ms}")
        # `stop` is accepted-and-ignored and the engine is single-threaded, so the
        # ONLY way a search ends is its own bestmove. Give it the move budget plus a
        # generous margin rather than a fixed timeout: a slow machine must not have
        # its answer declared missing while the engine is still working on it.
        bm = _read_until(lambda l: l.startswith('bestmove'), timeout=ms / 1000.0 + 60, on_line=on_line)
        if bm is None:
            raise RuntimeError('Tetrarch stopped responding')
        parts = bm.split()
        best = parts[1] if len(parts) > 1 else None
        ordered = [lines[k] for k in sorted(lines)]
        return {'bestmove': best,
                'threat': '(none)',
                'lines': ordered or [{'move': best, 'pv': [best] if best else []}]}

def handle(msg):
    mid = msg.get('id')
    cmd = msg.get('cmd')
    _dbg(f"REQ  id={mid} cmd={cmd!r}")
    try:
        if cmd == 'analyse':
            res = do_analyse(msg, mid)
            _dbg(f"DONE id={mid} bestmove={res.get('bestmove')}")
            send_message({'id': mid, **res, 'done': True})
        elif cmd == 'configure':
            send_message({'id': mid, **do_configure(msg)})
        elif cmd == 'ping':
            # the panel's engine-health probe: answer WITHOUT launching the engine
            send_message({'id': mid, 'ok': True})
        else:
            send_message({'id': mid, 'error': f"unknown cmd {cmd!r}"})
    except Exception as e:
        _dbg(f"FAIL id={mid} {e!r}\n{traceback.format_exc()}")
        send_message({'id': mid, 'error': str(e)})

def main():
    threading.Thread(target=_sender_loop, daemon=True).start()
    while True:
        msg = read_message()
        if msg is None:
            break
        threading.Thread(target=handle, args=(msg,), daemon=True).start()
    try:
        if _proc and _proc.poll() is None:
            _proc.kill()
    except Exception:
        pass
    os._exit(0)   # finalizing here can SIGABRT on a held stdout lock

if __name__ == '__main__':
    main()
