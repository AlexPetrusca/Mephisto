import {define} from "../../../framework/require.js";
import {SettingsPage} from "../../../util/SettingsPage.js";

class GeneralSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        M.Range.init(document.querySelectorAll('input[type=range]'), {});
        this.registerFormElement('engine', 'Engine:', 'select', 'stockfish-16-nnue-7');
        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 500);
        this.registerFormElement('fen_refresh', 'Fen Refresh Interval (ms):', 'input', 100);
        this.registerFormElement('computer_evaluation', 'Show Computer Evaluation:', 'checkbox', true);
        this.registerFormElement('threat_analysis', 'Show Threat Analysis', 'checkbox', true);
        this.registerFormElement('simon_says_mode', '"Hand and Brain" Mode:', 'checkbox', false);
        this.registerFormElement('autoplay', 'Autoplay:', 'checkbox', false);
        this.registerFormElement('puzzle_mode', 'Puzzle Mode:', 'checkbox', false);
        this.registerFormElement('python_autoplay_backend', 'Python Autoplay Backend:', 'checkbox', false);
        this.registerFormElement('think_time', 'Simulated Think Time (ms):', 'input', 1000);
        this.registerFormElement('think_variance', 'Simulated Think Variance (ms):', 'input', 500);
        this.registerFormElement('move_time', 'Simulated Move Time (ms):', 'input', 500);
        this.registerFormElement('move_variance', 'Simulated Move Variance (ms):', 'input', 250);
        const multipv_range = this.registerFormElement('multiple_lines', 'Multiple Lines:', 'range', 1);
        const threads_range = this.registerFormElement('threads', 'Threads:', 'range', 1);
        const memory_range = this.registerFormElement('memory', 'Memory:', 'range', 32);
        for (const range of [multipv_range, threads_range, memory_range]) {
            range.registerChangeListener(() => {
                const head = range.elem.parentElement.parentElement;
                head.querySelector('.value').innerText = range.getValue();
            });
        }
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
