from random import random

import pyautogui
import argparse
from flask import Flask, request

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


parser = argparse.ArgumentParser(description='A backend to perform simulated clicks for the Mephisto chrome extension.')
parser.add_argument('--port', '-p', dest='port', action='store', default=8080,
                    help='The port to run the server on. (default: 8080)')
parser.add_argument('--drag-time', '-d', dest='drag_time', action='store', default=100,
                    help='Time to drag a piece in ms. (default: 75) [with defaults: 75ms - 125ms]')
parser.add_argument('--drag-var', '-v', dest='drag_variance', action='store', default=20,
                    help='Variance for time to drag a piece in ms. (default: 50)')
args = parser.parse_args()


SCREEN_W, SCREEN_H = pyautogui.size()


def perform_click(x, y):
    # Clamp to the screen so a bad caller can't drive clicks off into the void (issue #36 §2).
    x = max(0, min(int(x), SCREEN_W - 1))
    y = max(0, min(int(y), SCREEN_H - 1))
    duration = (args.drag_variance * random() + args.drag_time) / 1000
    pyautogui.moveTo(x, y, duration=duration)
    pyautogui.mouseDown()
    pyautogui.mouseUp()


def perform_move(x0, y0, x1, y1):
    perform_click(x0, y0)
    pyautogui.sleep(4)
    perform_click(x1, y1)


@app.route('/performClick', methods=['POST'])
def perform_click_api():
    data = request.get_json()
    perform_click(data.get('x'), data.get('y'))
    return 'OK'


@app.route('/performMove', methods=['POST'])
def perform_move_api():
    data = request.get_json()
    perform_move(data.get('x0'), data.get('y0'), data.get('x1'), data.get('y1'))
    return 'OK'


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=args.port)  # loopback only - never expose on the LAN
