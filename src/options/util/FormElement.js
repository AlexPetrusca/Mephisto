export class FormElement {
    name;
    desc;
    type;
    default;
    valueType;
    elem;

    constructor(name, description, type, defaultValue) {
        this.name = name;
        this.desc = description;
        this.type = type;
        this.default = defaultValue;
        this.valueType = typeof defaultValue;
        this.elem = document.getElementById(`${name}_${type}`);
        // A SETTING WITH NO CONTROL MUST COST ONLY ITSELF. When the markup for one row is missing --
        // a hand-applied port that dropped it, a stale cached page, a typo in an id -- every method
        // below used to dereference null, and the throw took out the whole page: registration
        // stopped, so NO field was ever populated and nothing could be saved. It presented as "a
        // fresh install shows no defaults and won't let me turn anything on", which points nowhere
        // near the one row actually at fault. Now it is loud in the console and inert everywhere else.
        if (!this.elem) console.warn(`Mephisto: settings control ${name}_${type} is missing from this page`);
    }

    get missing() { return !this.elem; }

    registerChangeListener(fn) {
        if (this.missing) return;
        if (this.type === 'input' || this.type === 'range') {
            this.elem.addEventListener('input', fn);
        } else if (this.type === 'checkbox') {
            this.elem.addEventListener('change', fn);
        } else if (this.type === 'select') {
            this.elem.addEventListener('change', fn);
        }
    }

    getValue() {
        if (this.missing) return this.default;
        if (this.type === 'input' || this.type === 'range') {
            return this.elem.value;
        } else if (this.type === 'checkbox') {
            return this.elem.checked;
        } else if (this.type === 'select') {
            return this.elem.value;
        }
    }

    setValue(val) {
        if (this.missing) return;
        if (this.type === 'input' || this.type === 'range') {
            this.elem.value = val;
            this.elem.dispatchEvent(new Event('input'));
        } else if (this.type === 'checkbox') {
            this.elem.checked = val;
            this.elem.dispatchEvent(new Event('change'));
        } else if (this.type === 'select') {
            // A stored value whose <option> no longer exists -- e.g. an engine dropped since it was
            // saved, exactly the migration case popup.js handles and this page did not -- used to
            // throw here. setValue runs inside SettingsPage.pullConfigValues' forEach, so that throw
            // aborted the loop: every field AFTER this one silently kept its markup default and the
            // page rendered half-initialized. Fall back to this element's own default instead.
            // Scanning options also beats the old querySelector, which interpolated `val` straight
            // into the selector -- a stored value containing a quote threw SyntaxError just as fatally.
            const pick = (v) => [...this.elem.options].find(o => o.value === String(v));
            const opt = pick(val) || pick(this.default);
            if (!opt) return; // no default option either -- keep the markup's own rather than throw
            this.elem.value = opt.value;
            // Materialize replaces a select with a wrapper holding a text input, and that is what
            // the user actually sees. A select it skipped (or has not initialised yet) has no such
            // input -- writing to it blind is the other way this file could take out a whole page.
            const shown = this.elem.parentElement?.querySelector('input');
            if (shown) shown.value = opt.innerText;
            this.elem.dispatchEvent(new Event('change'));
        }
    }
}
