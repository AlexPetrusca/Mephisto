# Mephisto remote engine - runs a local UCI chess engine (Stockfish, Fairy-Stockfish, ...) and lets
# the browser extension talk to it over localhost. Keep this window open while you play, then set the
# extension's Engine to "Remote Engine".
#
# Requires:  pip install python-chess flask
#
# Examples:
#   python remote-engine.py /usr/bin/stockfish -o Hash:128 -o "Skill Level":15 -p 9090
#   python remote-engine.py fairy-stockfish -o UCI_Variant:crazyhouse -p 9090

import argparse
import sys
import threading

# Friendly message instead of a raw ImportError traceback when the packages aren't installed.
try:
    import chess
    import chess.engine
    import chess.variant
    from chess.engine import MANAGED_OPTIONS
    from flask import Flask, request
    from werkzeug.exceptions import HTTPException
except ImportError as e:
    sys.exit(f"Missing required package: {getattr(e, 'name', e)}\n"
             f"Install everything this script needs with:\n"
             f"    pip install python-chess flask")

engine = None
engine_options = {}
request_counter = 0
engine_lock = threading.Lock()
request_lock = threading.Lock()

app = Flask(__name__)


# The sites the extension runs on (mirrors manifest.json content_scripts matches). The panel runs in
# the page's isolated world, so its fetches carry the SITE's Origin - not chrome-extension://.
ALLOWED_HOSTS = {'www.chess.com', 'lichess.org', 'blitztactics.com', 'taketaketake.com',
                 'www.taketaketake.com', 'tactics.chessbase.com'}


@app.before_request
def _reject_foreign_origins():
    # Only the extension may drive this server (issue #36 §2): allow extension-context fetches,
    # fetches from the sites the panel runs on, and no-Origin callers (curl / manual testing) - 
    # the guard targets requests from arbitrary web pages. An Origin header can't be spoofed by
    # page script.
    origin = request.headers.get('Origin', '')
    if not origin or origin.startswith('chrome-extension://'):
        return
    host = origin.split('://', 1)[-1].split('/', 1)[0].split(':', 1)[0]
    if host not in ALLOWED_HOSTS:
        return {'error': 'forbidden origin'}, 403


parser = argparse.ArgumentParser(description='A backend to remotely communicate with a chess engine over UCI.')
parser.add_argument('executable', action='store', help='The path to the UCI chess engine executable.')
parser.add_argument('--option', '-o', dest='options', action='append',
                    help='Options to configure the engine, as NAME:VALUE (e.g. -o Hash:128).')
parser.add_argument('--port', '-p', dest='port', action='store', type=int, default=9090,
                    help='The port to run the server on. (default: 9090)')
args = parser.parse_args()


def set_option(key, value):
    # Apply one already-parsed engine option. `value` keeps its native type (str from the CLI, but
    # int/bool from the extension's JSON - e.g. Hash:512, UCI_LimitStrength:true) so python-chess
    # gets the type it expects. Never crashes the server on a bad option.
    key = str(key).strip()
    if not key:
        return
    engine_options[key] = value
    if key.lower() in MANAGED_OPTIONS:
        return  # python-chess manages these itself; setting them directly would fight it
    if key not in engine.options:
        print(f"ignoring option '{key}' - this engine doesn't offer it")
        return
    try:
        engine.configure({key: value})
    except Exception as ex:
        print(f"couldn't set {key} = {value}: {ex}")


def apply_option(opt):
    # Parse one CLI "NAME:VALUE" string, then apply it. Splits on the FIRST colon only, so values
    # containing ':' survive (Windows paths like C:\syzygy). Tolerates typos.
    if opt is None:
        return
    if ':' not in opt:
        print(f"skipping malformed option '{opt}' - expected NAME:VALUE, e.g. -o Hash:128")
        return
    key, value = opt.split(':', 1)
    set_option(key.strip(), value.strip())


def build_board(fen, moves):
    # Build the position, raising ValueError with a clear message on bad input.
    variant = engine_options.get('UCI_Variant')
    if variant is None:
        board = chess.Board(fen)
    elif variant == 'fischerandom':
        board = chess.Board(fen, chess960=True)
    else:
        VariantBoard = chess.variant.find_variant(variant)
        board = VariantBoard(fen)
    for move in (moves or '').split():
        board.push(chess.Move.from_uci(move))
    return board


def format_line(line, terminal, bestmove):
    if line.get('pv'): # normal or book move that arrived with a full info line
        pv = list(map(lambda v: str(v), line.get('pv')))
        score = line.get('score')
        score_prefix = 'mate' if score.is_mate() else 'cp'
        relative = score.relative # extracted so the f-string has no nested quotes (older-Python safe)
        formatted_line = {
            'depth': line.get('depth'),
            'seldepth': line.get('seldepth'),
            'multipv': line.get('multipv'),
            'nodes': line.get('nodes'),
            'nps': line.get('nps'),
            'hashfull': line.get('hashfull'),
            'tbhits': line.get('tbhits'),
            'time': line.get('time'),
            'move': pv[0],
            'pv': pv,
            'rawScore': f'{score_prefix} {relative}',
        }
        white = score.white()
        if score.is_mate():
            formatted_line['mate'] = white.mate()
        else:
            formatted_line['score'] = white.score()
        return formatted_line
    # no principal variation. game over is a property of the POSITION, not of the
    # engine output (a book move also arrives with no pv, and a superseded request
    # has no pv either) -- so key off `terminal`, never off a missing/null bestmove.
    if terminal: # the side to move has no legal move: real checkmate / stalemate
        score = line.get('score')
        if score is not None and score.is_mate(): # checkmate
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': f'mate {score.relative}', 'mate': score.white().mate()}
        relative = score.relative if score is not None else 0 # stalemate
        return {'move': '(none)', 'depth': line.get('depth', 0),
                'rawScore': f'cp {relative}',
                'score': score.white().score() if score is not None else 0}
    if bestmove is not None and bestmove != chess.Move.null(): # book move played with no info line
        return {'move': bestmove.uci(), 'depth': line.get('depth', 0),
                'pv': [bestmove.uci()], 'rawScore': 'cp 0', 'score': 0}
    # not terminal and no move yet (request superseded before any info) -- non-fatal placeholder
    return {'move': '(none)', 'depth': line.get('depth', 0), 'rawScore': 'cp 0', 'score': 0}


def format_lines(lines, terminal, bestmove):
    lines = list(map(lambda line: format_line(line, terminal, bestmove), lines or [{}]))
    if 'pv' in lines[0]:
        pv0 = lines[0].get('pv')
        return {
            'bestmove': pv0[0],
            'threat': pv0[1] if len(pv0) > 1 else '(none)',
            'lines': lines,
        }
    else:
        return {
            'bestmove': '(none)',
            'threat': '(none)',
            'lines': lines,
        }


def format_score(score, depth):
    return {
        'is_mate': score.is_mate(),
        'value': score.mate() if score.is_mate() else score.score(),
        'depth': depth,
    }


@app.route('/analyse', methods=['POST'])
def analyse():
    global request_counter, request_lock

    with request_lock:
        request_counter += 1
        request_id = request_counter

    with engine_lock:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return {'error': 'expected a JSON object in the request body'}, 400
        if 'fen' not in data:
            return {'error': "Parameter 'fen' is required"}, 400
        if 'time' not in data:
            return {'error': "Parameter 'time' is required"}, 400
        try:
            time_ms = float(data.get('time'))
        except (TypeError, ValueError):
            return {'error': "Parameter 'time' must be a number (milliseconds)"}, 400
        if time_ms <= 0:
            return {'error': "Parameter 'time' must be greater than 0"}, 400

        try:
            board = build_board(data.get('fen'), data.get('moves'))
        except ValueError as ex:
            return {'error': f'invalid position: {ex}'}, 400

        time_limit = chess.engine.Limit(time=time_ms / 1000)
        try:
            multipv = int(engine_options.get('MultiPV', 1))
        except (TypeError, ValueError):
            multipv = 1
        if 'multipv' not in engine.options:
            multipv = 1 # engine doesn't support MultiPV - don't ask for it

        terminal = not any(board.legal_moves) # authoritative game-over signal
        try:
            with engine.analysis(board, time_limit, multipv=multipv) as analysis:
                bestmove = None
                if request_counter == request_id:
                    for _ in analysis:
                        if request_counter != request_id:
                            break # request was cancelled
                    if request_counter == request_id:
                        bestmove = analysis.wait().move # actual move (search or book)
            return format_lines(analysis.multipv, terminal, bestmove)
        except chess.engine.EngineTerminatedError:
            return {'error': 'the engine process stopped - restart this script'}, 503


@app.route('/configure', methods=['POST'])
def configure():
    with engine_lock:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return {'error': 'expected a JSON object in the request body'}, 400
        for (key, value) in data.items():
            set_option(key, value)
        return config()


@app.route('/config', methods=['GET'])
def config():
    cfg = dict(engine.protocol.config)
    cfg.update(engine_options)
    return cfg


@app.errorhandler(Exception)
def on_unexpected_error(e):
    # Let Flask handle its own HTTP errors (404, the 400s above, ...); turn anything else into a
    # clean JSON error the extension can show, instead of an HTML traceback page.
    if isinstance(e, HTTPException):
        return e
    print(f"unexpected error: {e}")
    return {'error': f'internal error: {e}'}, 500


def start_engine(path):
    try:
        return chess.engine.SimpleEngine.popen_uci(path)
    except FileNotFoundError:
        sys.exit(f"Couldn't find an engine at: {path}\n"
                 f"Check the path is right - tip: drag the engine file into the terminal to paste its full path.")
    except PermissionError:
        sys.exit(f"The engine at {path} isn't executable.\n"
                 f"On macOS/Linux, run:  chmod +x \"{path}\"")
    except Exception as ex:
        sys.exit(f"Couldn't start the engine at {path}:\n    {ex}")


if __name__ == '__main__':
    engine = start_engine(args.executable)
    for option in args.options or []:
        apply_option(option)
    print(f"Mephisto remote engine ready at http://localhost:{args.port}")
    print("In the extension, set Engine = \"Remote Engine\". Keep this window open while you play.")
    print("Press Ctrl+C here to stop.")
    try:
        app.run(host='127.0.0.1', port=args.port)  # loopback only - never expose on the LAN
    except OSError as ex:
        sys.exit(f"Couldn't start the server on port {args.port}:\n    {ex}\n"
                 f"That port may already be in use (is this script already running?). "
                 f"Try another port, e.g. -p 9091.")
    finally:
        if engine is not None:
            engine.quit()
