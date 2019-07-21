registerPageScript(() => {
    console.log('called');

    const moveTimeInput = document.getElementById('move_time_input');
    const fenRefreshInput = document.getElementById('fen_refresh_input');
    const autoplayInput = document.getElementById('autoplay_input');
    const resetButton = document.getElementById('reset_btn');
    const applyButton = document.getElementById('apply_btn');

    function pullConfigValues() {
        moveTimeInput.value = localStorage.getItem('move_time') || 1000;
        fenRefreshInput.value = localStorage.getItem('fen_refresh') || 100;
        autoplayInput.checked = JSON.parse(localStorage.getItem('autoplay')) || false;
    }

    function pushConfigValues() {
        localStorage.setItem('move_time', moveTimeInput.value);
        localStorage.setItem('fen_refresh', fenRefreshInput.value);
        localStorage.setItem('autoplay', autoplayInput.checked);
    }

    applyButton.addEventListener('click', () => {
        pushConfigValues();
    });

    resetButton.addEventListener('click', () => {
        localStorage.clear();
        pullConfigValues();
    });

    pullConfigValues();
});