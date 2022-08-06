![alt text](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

Mephisto is a browser extension that enables next best move calculation and automated gameplay on Chess.com and Lichess.


## Getting Started
Click Mephisto's icon to open its popup window and automatically scrape the current page for a chess position to 
analyze.

### Pinning Mephisto
For ease of use, pin Mephisto in chrome's extensions menu. Click the puzzle icon to the right of Chrome's address bar. 
Find "Mephisto Chess Extension" and click the pin icon to the right of it.

### Keeping Mephisto Open
You may notice that when you click outside of Mephisto's popup window, the popup will lose focus and close. To prevent
this, right-click the pinned icon and click 'Inspect Popup'.

Check out [Wiki: Getting Started](Getting-Started) for more information.


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
