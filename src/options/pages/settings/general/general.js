import { define } from "../../../framework/require.js";
import { SettingsPage } from "../../../util/SettingsPage.js";

class GeneralSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        this.registerFormElement('engine', 'Engine:', 'select', 'stockfish-16-nnue');
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
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
