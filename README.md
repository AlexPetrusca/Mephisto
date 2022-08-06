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

For more information, check out [Wiki: Getting Started](https://github.com/AlexPetrusca/Mephisto/wiki/Getting-Started).


## How to Contribute
Thank you for your interest in contributing to Mephisto! There are many ways to contribute, and we appreciate all of them.

### Ways to Contribute
- Help contribute ideas to Mephisto
- Help identify and document bugs with Mephisto
- Implement requested features through PRs
- Fix identified bugs through PRs


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

For technical details, check out [Wiki: Technical Overview](https://github.com/AlexPetrusca/Mephisto/wiki/Technical-Overview).


## How to Run Python Autoplay Backend
Install dependencies:
```bash
pip3 install flask pyautogui
```

Run script:
```bash
python3 mephisto-clicker.py
```
