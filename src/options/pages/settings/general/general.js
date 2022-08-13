import { define } from "../../../framework/require.js";
import { SettingsPage } from "../../../util/SettingsPage.js";

class GeneralSettings extends SettingsPage {
    init() {
        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 500);
        this.registerFormElement('fen_refresh', 'Fen Refresh Interval (ms):', 'input', 100);
        this.registerFormElement('simon_says_mode', '"Hand and Brain" Mode:', 'checkbox', false);
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
