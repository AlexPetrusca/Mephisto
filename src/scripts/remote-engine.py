# Example Usage: python remote-engine.py /usr/bin/stockfish -o Hash:32 -o "Skill Level":15 -o SyzygyPath:"/path/to/syzygy" -p 9090

import argparse
import chess.engine
from chess.engine import MANAGED_OPTIONS
from flask import Flask, request

app = Flask(__name__)
parser = argparse.ArgumentParser(description='A backend to remotely communicate with a chess engine over UCI.')
parser.add_argument('executable', action='store', help='The path to the UCI chess engine executable.')
parser.add_argument('--option', '-o', dest='options', action='append',
                    help='Options to configure the engine.')
parser.add_argument('--port', '-p', dest='port', action='store', default=9090,
                    help='The port to run the server on. (default: 9090)')
args = parser.parse_args()

def format_line(line):
    if line.get('depth') == 0: # game over?
        if line.get('score').is_mate(): # checkmate?
            return {
                'move': '(none)',
                'depth': line.get('depth'),
                'rawScore': f'mate {line.get('score').relative}',
                'mate': line.get('score').white().mate(),
            }
        else: # stalemate
            return {
                'move': '(none)',
                'depth': line.get('depth'),
                'rawScore': f'cp {line.get('score').relative}',
                'score': line.get('score').white().score(),
            }
    else: # normal move
        pv = list(map(lambda v: str(v), line.get('pv')))
        score_prefix = 'mate' if line.get('score').is_mate() else 'cp'
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
            'rawScore': f'{score_prefix} {line.get('score').relative}',
        }
        score = line.get('score').white()
        if line.get('score').is_mate():
            formatted_line['mate'] = score.mate()
        else:
            formatted_line['score'] = score.score()
        return formatted_line

def format_lines(lines):
    lines = list(map(lambda line: format_line(line), lines))
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
    data = request.get_json()
    if 'fen' not in data:
        return {'error': "Parameter 'fen' is required"}, 400
    elif 'time' not in data:
        return {'error': "Parameter 'time' is required"}, 400

    board = chess.Board(data.get('fen'))
    if 'moves' in data:
        # todo: handle placements (e.g. '@Kf3')
        # todo: more generally, handle variants
        for move in data.get('moves').split():
            board.push(chess.Move.from_uci(move))
    time_limit = chess.engine.Limit(time=data.get('time') / 1000)
    multipv = engine_options.get('MultiPV') if 'MultiPV' in engine_options else 1
    lines = engine.analyse(board, time_limit, info=chess.engine.INFO_ALL, multipv=multipv)
    return format_lines(lines)


@app.route('/configure', methods=['POST'])
def configure():
    data = request.get_json()
    for (key, value) in data.items():
        engine_options[key] = value
        if not key.lower() in MANAGED_OPTIONS:
            engine.configure({key: value})
    return config()


@app.route('/config', methods=['GET'])
def config():
    cfg = dict(engine.protocol.config)
    cfg.update(engine_options)
    return cfg


if __name__ == '__main__':
    engine_options = {}
    engine = chess.engine.SimpleEngine.popen_uci(args.executable)
    for option in args.options or []:
        key, value = option.split(':')
        engine_options[key] = value
        if not key.lower() in MANAGED_OPTIONS:
            engine.configure({key: value})
    app.run(port=args.port)
