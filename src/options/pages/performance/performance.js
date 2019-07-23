registerPageScript(() => {
    let configUniqueifier;

    function getUniquifier() {
        return JSON.stringify({
            'move_time': moveTimeInput.value,
            'fen_refresh': fenRefreshInput.value,
            'autoplay': autoplayInput.checked
        });
    }

    function updateUniquifier() {
        configUniqueifier = getUniquifier();
    }

    const moveTimeInput = document.getElementById('move_time_input');
    const fenRefreshInput = document.getElementById('fen_refresh_input');
    const autoplayInput = document.getElementById('autoplay_input');
    const resetButton = document.getElementById('reset_btn');
    const applyButton = document.getElementById('apply_btn');

    function pullConfigValues() {
        moveTimeInput.value = localStorage.getItem('move_time') || 1000;
        fenRefreshInput.value = localStorage.getItem('fen_refresh') || 100;
        autoplayInput.checked = JSON.parse(localStorage.getItem('autoplay')) || false;
        updateUniquifier();
    }

    function pushConfigValues() {
        updateUniquifier();
        localStorage.setItem('move_time', moveTimeInput.value);
        localStorage.setItem('fen_refresh', fenRefreshInput.value);
        localStorage.setItem('autoplay', autoplayInput.checked);
    }

    function resetConfigValues() {
        localStorage.clear();
        pullConfigValues();
    }

    function checkConfigValuesChanged() {
        console.log(configUniqueifier);
        console.log(getUniquifier());
        applyButton.disabled = (configUniqueifier === getUniquifier());
    }

    applyButton.addEventListener('click', pushConfigValues);
    resetButton.addEventListener('click', resetConfigValues);
    moveTimeInput.addEventListener('change', checkConfigValuesChanged);
    fenRefreshInput.addEventListener('change', checkConfigValuesChanged);
    autoplayInput.addEventListener('change', checkConfigValuesChanged);

    pullConfigValues();
    checkConfigValuesChanged();
});