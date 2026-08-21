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
        // Arrow colours: the hex field is the SETTING (registered like any input); the native
        // colour picker beside it is a second face of the same value, synced both ways. An empty
        // field means "the shipped default" -- the panel validates at use, so junk cannot break
        // drawing. FormElement saves on 'input' events, which is exactly what the picker fires.
        const ARROW_COLORS = [
            ['arrow_color_line1', '#0a5bd3'], ['arrow_color_line2', '#0f9d58'],
            ['arrow_color_line3', '#e0a400'], ['arrow_color_line4', '#e8710a'],
            ['arrow_color_line5', '#9333ea'], ['arrow_color_forced_ours', '#d81b8c'],
            ['arrow_color_forced_theirs', '#00a693'], ['arrow_color_pv_walk', '#8f8f8f'],
            ['arrow_color_threat', '#bf0000'], ['arrow_color_book', '#14b8a6'],
            ['arrow_color_human_reply', '#a8657f'], ['arrow_color_safety_net', '#4c9f70'],
        ];
        for (const [key, dflt] of ARROW_COLORS) {
            const el = this.registerFormElement(key, key + ':', 'input', '');
            const picker = document.getElementById(key + '_picker');
            const text = document.getElementById(key + '_input');
            if (!picker || !text || el.missing) continue;
            const sync = () => { picker.value = /^#[0-9a-fA-F]{6}$/.test(text.value) ? text.value : dflt; };
            sync();
            el.registerChangeListener(sync);
            picker.addEventListener('input', () => {
                text.value = picker.value;
                text.dispatchEvent(new Event('input', {bubbles: true})); // the event FormElement saves on
            });
        }
    }
}

define({
    title: 'Appearance',
    page: new AppearanceSettings()
});