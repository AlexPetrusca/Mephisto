import {define} from "../../../framework/require.js";
import {SettingsPage} from "../../../util/SettingsPage.js";

class GeneralSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        M.Range.init(document.querySelectorAll('input[type=range]'), {});
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});
        const engine_select = this.registerFormElement('engine', 'Engine:', 'select', 'stockfish-16-nnue-7');
        const variant_select = this.registerFormElement('variant', 'Variant:', 'select', 'chess');
        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 3000);
        this.registerFormElement('fen_refresh', 'Fen Refresh Interval (ms):', 'input', 200);
        const multipv_range = this.registerFormElement('multiple_lines', 'Multiple Lines:', 'range', 1);
        const threads_range = this.registerFormElement('threads', 'Threads:', 'range', navigator.hardwareConcurrency - 1);
        const memory_range = this.registerFormElement('memory', 'Memory:', 'range', 32);
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
        const engineLabelTooltiped = document.querySelector('#engine-label-tooltiped');
        const engineLabelUntooltiped = document.querySelector('#engine-label-untooltiped');
        for (const range of [multipv_range, threads_range, memory_range]) {
            range.registerChangeListener(() => {
                let section = range.elem;
                while (!section.classList.contains('section')) {
                    section = section.parentElement
                }
                section.querySelector('.value').innerText = range.getValue();
            });
        }
        engine_select.registerChangeListener(() => {
            let section = variant_select.elem;
            while (!section.classList.contains('section')) {
                section = section.parentElement
            }
            if (engine_select.getValue() === 'fairy-stockfish-14-nnue') {
                section.classList.remove('hidden');
            } else {
                section.classList.add('hidden');
                variant_select.setValue('chess');
            }
            if (engine_select.getValue() === 'remote') {
                engineLabelTooltiped.classList.remove('hidden');
                engineLabelUntooltiped.classList.add('hidden');
            } else {
                engineLabelTooltiped.classList.add('hidden');
                engineLabelUntooltiped.classList.remove('hidden');
            }
        })
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
