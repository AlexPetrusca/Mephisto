import { FormElement } from "./FormElement.js";

export class SettingsPage {
    resetButton;
    formElements;

    constructor() {
        if (this.constructor === SettingsPage) {
            throw new Error("Can't instantiate abstract class!");
        }
        this.formElements = [];
    }

    init() {
        throw new Error("init() must be implemented!");
    }

    async onInit() {
        // Guarded, like every other lookup in this class: a page that has no reset button (the
        // Analysis page is one -- there is nothing on it to reset) would otherwise throw HERE and
        // take the whole page down before a single control was registered. Same failure shape as
        // the missing-control bug in FormElement, and the same answer.
        this.resetButton = document.getElementById('reset_btn');
        this.resetButton?.addEventListener('click', () => this.onResetConfigValues());

        // Export/import live on the General page only (they're global, not per-page), so guard: the
        // Appearance page shares this class and has no such buttons.
        const exportBtn = document.getElementById('export_btn');
        const importBtn = document.getElementById('import_btn');
        const importFile = document.getElementById('import_file');
        exportBtn?.addEventListener('click', () => this.onExportConfigValues());
        importBtn?.addEventListener('click', () => importFile?.click());
        importFile?.addEventListener('change', async () => {
            if (importFile.files[0]) await this.onImportConfigValues(importFile.files[0]);
            importFile.value = ''; // re-selecting the SAME file must fire 'change' again
        });

        // chrome.storage.local is the source of truth (the panel writes only there). Wait for the
        // cache before touching the forms -- reading early gave stale values, and any later change
        // then pushed those stale values back, silently reverting settings made in the panel.
        await MephistoConfig.ready;
        // Translate before init(): Materialize snapshots select options and tooltip text when it
        // initialises them, so a page translated afterwards would show half the old language.
        await window.mephistoApplyLanguage?.();
        this.init();
        MephistoI18n.apply(document); // the page's own markup, which only exists after init()
        this.decorateTooltips();
        this.wireFilter();
        this.pullConfigValues();
    }

    // A DESCRIPTION NOBODY CAN FIND IS NOT A DESCRIPTION. v3.1.249 gave every setting a tooltip and
    // they were invisible in practice (user report): most rows had no marker to hover, only a
    // handful of legacy rows carried the info icon, the Appearance page never called M.Tooltip.init
    // at all, and Materialize waited a full second before showing anything. So: one info icon on
    // every tooltipped label, initialised HERE for whatever page this is, at a delay that feels
    // like a hover rather than a wait. Runs after init() and after translation, so the icon is
    // never re-translated away and the tooltip text Materialize snapshots is the final one.
    decorateTooltips() {
        for (const el of document.querySelectorAll('.tooltipped[data-tooltip]')) {
            if (el.querySelector('.info-tooltip')) continue;      // legacy rows already have one
            const icon = document.createElement('i');
            icon.className = 'material-icons info-tooltip';
            icon.textContent = 'info';
            el.appendChild(icon);
        }
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 250});
    }

    // A SEARCH BOX OVER THE ROWS. Fifty-eight controls on General alone: typing "premove" should get
    // you there faster than scrolling does. Matching is over everything a person can see about a row
    // -- its label AND its tooltip -- so "engine strength" finds the Elo cap even though neither word
    // is in its label. Sections with no surviving row fold away, headings included; emptying the box
    // puts everything back. Lives here because every page built on this class gets it by carrying
    // one <input id="settings_filter"> and nothing else.
    wireFilter() {
        const box = document.getElementById('settings_filter');
        if (box || this._filterWired) { /* fall through */ } else { return; }
        if (!box) return;
        this._filterWired = true;
        box.addEventListener('input', () => {
            const q = box.value.trim().toLowerCase();
            // EVERY row on the page, not rows-inside-sections: the two builds' markup does not
            // agree on which rows sit inside a .set-sec, and a row the loop never visits is a row
            // the filter can never hide (measured on the fork: fourteen of them stayed visible).
            for (const row of document.querySelectorAll('.set-row')) {
                const hay = (row.textContent + ' ' +
                    [...row.querySelectorAll('[data-tooltip]')].map(el => el.getAttribute('data-tooltip')).join(' '))
                    .toLowerCase();
                row.classList.toggle('filter-hidden', !!q && !hay.includes(q));
            }
            // a section folds when none of ITS rows survived; one that never held rows (About and
            // its kin) is not the filter's business
            for (const sec of document.querySelectorAll('.set-sec')) {
                if (!sec.querySelector('.set-row')) continue;
                const any = [...sec.querySelectorAll('.set-row')].some(r => !r.classList.contains('filter-hidden'));
                sec.classList.toggle('filter-hidden', !!q && !any);
            }
        });
    }

    clearConfigValues() {
        this.formElements.forEach(formElement => {
            MephistoConfig.remove(formElement.name);
        });
    }

    // localstorage values push/pull
    pullConfigValues() {
        // Populating the form is a READ. setValue dispatches change/input so the page's own listeners
        // (section visibility and so on) stay in step, but those same events reach the persist
        // listener below -- so merely OPENING this page wrote every field back. That is harmless when
        // the value round-trips, and destructive when it does not: a stored value with no <option>
        // renders as the fallback, and the fallback was then saved over the real setting. Suppress
        // persistence for the duration; a genuine edit happens after this returns.
        this.populating = true;
        try {
            this.formElements.forEach(formElement => {
                const localStorageVal = MephistoConfig.get(formElement.name);
                if (localStorageVal) {
                    formElement.setValue(JSON.parse(localStorageVal));
                } else {
                    formElement.setValue(formElement.default);
                }
            });
        } finally {
            this.populating = false;
        }
    }

    // The ONE place a form value becomes the JSON string the rest of the extension stores. Both call
    // sites used to hand-build it -- `"${value}"` for strings, the raw value otherwise -- which is
    // not JSON in two ordinary cases: a number field left empty (or typed into badly) stores the
    // empty string, and a string containing a double quote stores broken JSON. Either one throws in
    // the panel's JSON.parse at boot, and the field it belongs to is not the only casualty.
    // getValue() returns a STRING for input/range/select regardless of what the default's type says,
    // so the coercion has to happen here rather than being assumed upstream.
    serializeValue(formElement) {
        const raw = formElement.getValue();
        if (formElement.valueType === 'number') {
            const n = Number(raw);
            return JSON.stringify((raw === '' || !Number.isFinite(n)) ? formElement.default : n);
        }
        if (formElement.valueType === 'string') return JSON.stringify(String(raw));
        return JSON.stringify(raw); // boolean (checkbox) -- already the right type
    }

    pushConfigValues() {
        this.formElements.forEach(formElement => {
            MephistoConfig.set(formElement.name, this.serializeValue(formElement));
        });
    }

    // register form element
    registerFormElement(name, description, type, defaultValue) {
        const formElement = new FormElement(name, description, type, defaultValue);
        formElement.registerChangeListener(() => {
            if (this.populating) return; // a form being filled from storage must not write back
            MephistoConfig.set(formElement.name, this.serializeValue(formElement));
        });
        this.formElements.push(formElement);
        return formElement;
    }

    // on event callbacks
    onResetConfigValues() {
        this.clearConfigValues();
        this.pullConfigValues();
    }

    // Export EVERY setting, not just this page's form elements: the point is that a reinstall or a
    // second machine restores the whole config, and plenty of it (panel geometry, per-site state)
    // was never on a form. Values are the JSON strings the store already holds, so it round-trips
    // byte-for-byte through import.
    async onExportConfigValues() {
        let all;
        try { all = await chrome.storage.local.get(null); } catch (e) { all = {}; }
        delete all.__cfg_migrated; // internal marker: exporting it would suppress the one-time
                                   // localStorage migration on a fresh install that imports this
        // EVERY SETTING IN THIS STORE IS A JSON STRING. The service worker also keeps bookkeeping
        // beside them that is not: startup timings as an array, the last update check as an object,
        // a couple of boolean flags. Exporting those produced a file that our own import then
        // refused as "not a Mephisto settings file" -- so the round trip was broken on every
        // install whose worker had ever run, which is all of them. They are not settings either:
        // none of them should follow anyone to another machine.
        for (const [k, v] of Object.entries(all)) if (typeof v !== 'string') delete all[k];
        // A CREDENTIAL never goes in the file. This export exists to be moved between machines and
        // pasted into issues, and a lichess token in one is a token in someone else's hands. The
        // field is one paste to refill on the other machine.
        delete all.lichess_token;
        const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], {type: 'application/json'}));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mephisto-settings.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    async onImportConfigValues(file) {
        let obj;
        try {
            obj = JSON.parse(await file.text());
        } catch (e) {
            alert('Import failed: that file is not valid JSON.');
            return;
        }
        // A hand-edited or wrong file shouldn't half-apply and leave the config in a mixed state.
        // The store holds JSON STRINGS for every key, so anything else means it isn't ours.
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)
            || Object.values(obj).some(v => typeof v !== 'string')) {
            alert('Import failed: that does not look like a Mephisto settings file.');
            return;
        }
        delete obj.__cfg_migrated;
        // Set through MephistoConfig, not chrome.storage directly: it updates the SYNC cache now,
        // rather than waiting on the async onChanged that pullConfigValues would otherwise race.
        for (const [k, v] of Object.entries(obj)) MephistoConfig.set(k, v);
        this.pullConfigValues();
        alert(`Imported ${Object.keys(obj).length} settings. Open panels pick them up on their next move; reload the game tab to apply an engine change now.`);
    }
}
