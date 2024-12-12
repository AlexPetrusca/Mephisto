import argparse
import chess.engine
from flask import Flask, request, jsonify

app = Flask(__name__)
parser = argparse.ArgumentParser(description='A simple backend to remotely communicate with a chess engine over UCI.')
parser.add_argument('--port', '-p', dest='port', action='store', default=9090,
               help='The port to run the server on. (default: 9090)')
args = parser.parse_args()


@app.route('/analyse', methods=['POST'])
def analyse():
    data = request.get_json()
    board = chess.Board(data.get('fen'))
    time_limit = chess.engine.Limit(time=data.get('time') / 1000)
    res = engine.play(board, time_limit, info=chess.engine.INFO_ALL)

    score = res.info["score"].relative
    return jsonify({
        "move": res.move.uci() if res.move else "(none)",
        "ponder": res.ponder.uci() if res.ponder else "(none)",
        "score": {
            "is_mate": score.is_mate(),
            "value": score.mate() if score.is_mate() else score.score(),
            "depth": res.info["depth"],
        },
    })


if __name__ == '__main__':
    engine_binary = "stockfish"
    engine = chess.engine.SimpleEngine.popen_uci(engine_binary)
    app.run(port=args.port)
