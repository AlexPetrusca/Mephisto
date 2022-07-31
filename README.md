# Mephisto

Mephisto is a browser extension that enables next best move calculation and automated gameplay on Chess.com and Lichess.


## Usage
Clicking Mephisto's icon will open its popup window and automatically scrape the current page for a chess position to 
analyze.

### Pinning Mephisto
For ease of use, pin Mephisto in chrome's extensions menu. Click the puzzle icon to the right of Chrome's address bar. 
Find "Mephisto Chess Extension" and click the pin icon to the right of it.

### Keeping Mephisto Open
You may notice that when you click outside of Mephisto's popup window, the popup will lose focus and close. To prevent
this, right click the pinned icon and click 'Inspect Popup'.

NOTE: This will keep the popup open until either the inspect window is closed or the current tab is changed/closed.

###Further Analysis
In Mephisto's popup window, you can click the button in the bottom-left corner to open the current position in 
Lichess's analysis board for in-depth analysis. This page will be opened in a new tab.


## Configuration
Mephisto supports several modes of operation.

### Best Move
This is the default mode. Mephisto presents the best move, the opponent's best response to the best move, and the 
Stockfish evaluation for the position. The best move is displayed as a blue arrow whereas the opponent's best response 
is displayed as a red arrow.

### Hand & Brain
Mephisto presents the Stockfish evaluation for the position and acts as the "Brain", telling you the type of the piece 
to move. From there, it is your job as the "Hand" to find and play the best move given the hint.

### Autoplay
Mephisto calculates the next best move and simulates clicks to play it over the board. By default, the simulated clicks
are generated directly in browser.

#### Python Autoplay Backend
Click and drag events are performed outside the browser from a Python backend. Simulated mouse actions are generated
using PyAutoGUI. For this mode to work, users must run mephisto-clicker.py locally.

NOTE: This script will take control of the mouse when activated by Mephisto.

#### Puzzle Mode
Mephisto optimizes for efficiently solving and automating puzzles. This should be enabled when autoplaying puzzle 
minigames, like Chess.com's Puzzle Rush and Lichess's Puzzle Storm, where a player's score depends on solving as many
puzzles as possible in a fixed timeframe.


## How to Contribute
Thank you for your interest in contributing to Mephisto! There are many ways to contribute, and I appreciate all of them.

### Ways to Contribute
- Help contribute ideas to Mephisto
- Help identify and document bugs with Mephisto
- Implement requested features through PRs
- Fix identified bugs through PRs


## Technical Overview
Mephisto's central mechanism is the interplay between its content script and popup script.

### Content Script
The content script runs in the context of the page and has access to the page's DOM tree. It scrapes the page for 
information about the current chess position to send back to the popup script. It also handles sending calls to 
either the Python backend or popup script to simulate mouse actions.

### Popup Script
The popup script runs in the context of the popup window and therefore has no direct access to the page. The popup
script is responsible for syncing the UI with the current chess position, computing the next best move, and 
simulating click actions. It reads information passed from the content script, converts it into a FEN string, and
passes the string to a JavaScript port of Stockfish for analysis. Once the next best move is calculated, the move is
displayed on the UI. 

If autoplay is enabled, the move is sent back to the content script, where additional scraping will be performed 
to convert the move to its corresponding XY coordinates and click events will be orchestrated to simulate the move.
The content script receives these click events and invokes the chrome.debugger API to simulate clicks.


## How to Develop Locally
Set up a local install:
1. Clone the repo
2. Navigate to `chrome://extensions` through the Chrome address bar
3. Enable developer mode
4. Click on "Load unpacked" and select the cloned repo folder
5. Mephisto Chess Extension is now installed

Test a code change:
1. Navigate to `chrome://extensions`
2. Reload Mephisto Chess Extension
3. Reload the webpage you want to test on
4. Test the changes


## How to Run Python Autoplay Backend
Install dependencies:
```bash
pip3 install flask pyautogui
```

Run script:
```bash
python3 mephisto-clicker.py
```