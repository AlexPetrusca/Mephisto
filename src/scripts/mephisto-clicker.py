from random import random

import pyautogui
import argparse
from flask import Flask, request

app = Flask(__name__)
parser = argparse.ArgumentParser(description='A simple backend to perform simulated clicks for the Mephisto chrome extension.')
parser.add_argument('--port', '-p', dest='port', action='store', default=8080,
                    help='The port to run the server on. (default: 8080)')
parser.add_argument('--drag-time', '-d', dest='drag_time', action='store', default=100,
                    help='Time to drag a piece in ms. (default: 75) [with defaults: 75ms - 125ms]')
parser.add_argument('--drag-var', '-v', dest='drag_variance', action='store', default=20,
                    help='Variance for time to drag a piece in ms. (default: 50)')
args = parser.parse_args()


def perform_click(x, y):
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
    app.run(port=args.port)
