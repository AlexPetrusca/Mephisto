registerPageScript(() => {
    const moveTimeInput = document.getElementById('move_time_input');
    const fenRefreshInput = document.getElementById('fen_refresh_input');
    const autoplayInput = document.getElementById('autoplay_input');
    const resetButton = document.getElementById('reset_btn');
    const applyButton = document.getElementById('apply_btn');
    let configUniqueifier;

    function getCurrentUniquifier() {
        return JSON.stringify({
            'move_time': moveTimeInput.value,
            'fen_refresh': fenRefreshInput.value,
            'autoplay': autoplayInput.checked
        });
    }

    function updateUniquifier() {
        configUniqueifier = getCurrentUniquifier();
    }

    function pullConfigValues() {
        moveTimeInput.value = localStorage.getItem('move_time') || 1000;
        fenRefreshInput.value = localStorage.getItem('fen_refresh') || 100;
        autoplayInput.checked = JSON.parse(localStorage.getItem('autoplay')) || false;
        updateUniquifier();
    }

    function pushConfigValues() {
        localStorage.setItem('move_time', moveTimeInput.value);
        localStorage.setItem('fen_refresh', fenRefreshInput.value);
        localStorage.setItem('autoplay', autoplayInput.checked);
        updateUniquifier();
    }

    function onApplyConfigValues() {
        pushConfigValues();
        onConfigValuesChanged();
    }

    function onResetConfigValues() {
        localStorage.clear();
        pullConfigValues();
        onConfigValuesChanged();
    }

    function onConfigValuesChanged() {
        applyButton.disabled = (configUniqueifier === getCurrentUniquifier());
    }

    applyButton.addEventListener('click', onApplyConfigValues);
    resetButton.addEventListener('click', onResetConfigValues);
    moveTimeInput.addEventListener('keyup', onConfigValuesChanged);
    fenRefreshInput.addEventListener('keyup', onConfigValuesChanged);
    autoplayInput.addEventListener('change', onConfigValuesChanged);

    pullConfigValues();
    onConfigValuesChanged();
});