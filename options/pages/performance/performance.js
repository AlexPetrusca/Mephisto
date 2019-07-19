let name = 'performance';
let contentElem = document.getElementById('content');

contentElem.addEventListener('focus', onFocus);
function onFocus(e) {
    if (e.value === name) {
        let moveTimeElem = document.getElementById('move_time_input');
        let fenRefreshElem = document.getElementById('fen_refresh_input');
        let resetElem = document.getElementById('reset_btn');

        function refreshValues() {
            moveTimeElem.value = localStorage.getItem('move_time') || 1000;
            fenRefreshElem.value = localStorage.getItem('fen_refresh') || 100;
        }

        refreshValues();

        moveTimeElem.addEventListener('change', e => {
            localStorage.setItem('move_time', moveTimeElem.value);
        });

        fenRefreshElem.addEventListener('change', e => {
            localStorage.setItem('fen_refresh', fenRefreshElem.value);
        });

        resetElem.addEventListener('click', e => {
            localStorage.removeItem('fen_refresh');
            localStorage.removeItem('move_time');
            refreshValues();
        });
    }
}
onFocus({value: name});