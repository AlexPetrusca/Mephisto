import { define } from "../../../framework/require.js";
import { SettingsPage } from "../../../util/SettingsPage.js";

class AppearanceSettings extends SettingsPage {
    init() {
        // The <option>s are built here rather than written into appearance.html, so MephistoI18n's
        // LANGUAGES stays the ONE place a language exists -- adding one there is the whole job.
        // Each is named in its own language: a list written in English does not help someone
        // looking for theirs.
        const langSelect = document.getElementById('language_select');
        if (langSelect && !langSelect.options.length) {
            for (const {code, name} of MephistoI18n.LANGUAGES) {
                langSelect.add(new Option(name, code));
            }
        }
        M.FormSelect.init(document.querySelectorAll('select'), {});
        this.registerFormElement('pieces', 'Pieces:', 'select', 'wikipedia.svg');
        this.registerFormElement('board', 'Board:', 'select', 'brown');
        this.registerFormElement('coordinates', 'Coordinates:', 'checkbox', false);
        const darkToggle = this.registerFormElement('dark_mode', 'Dark Mode:', 'checkbox', false);
        darkToggle.registerChangeListener(() => window.mephistoApplyTheme?.());
        // Re-translate immediately on change: waiting for a reload to see whether you picked the
        // right language is the one thing a language picker must not do.
        const lang = this.registerFormElement('language', 'Language:', 'select', MephistoI18n.DEFAULT_LANG);
        lang.registerChangeListener(() => window.mephistoApplyLanguage?.(lang.getValue()));
    }
}

define({
    title: 'Appearance',
    page: new AppearanceSettings()
});