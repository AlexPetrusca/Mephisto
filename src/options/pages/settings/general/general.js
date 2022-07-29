import FormElement from "./../../../util/FormElement.js";

class GeneralSettings {
    resetButton;
    applyButton;
    formElements;
    configUniqueifier;

    constructor() {
        this.formElements = [];
        this.configUniqueifier = '';
    }

    onInit() {
        this.applyButton = document.getElementById('apply_btn');
        this.applyButton.addEventListener('click', () => this.onApplyConfigValues());
        this.resetButton = document.getElementById('reset_btn');
        this.resetButton.addEventListener('click', () => this.onResetConfigValues());

        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 500);
        this.registerFormElement('fen_refresh', 'Fen Refresh Interval (ms):', 'input', 100);
        this.registerFormElement('simon_says_mode', '"Hand and Brain" Mode:', 'checkbox', false);
        this.registerFormElement('autoplay', 'Autoplay:', 'checkbox', false);
        this.registerFormElement('puzzle_mode', 'Puzzle Mode:', 'checkbox', false);
        this.registerFormElement('python_autoplay_backend', 'Python Autoplay Backend:', 'checkbox', false);
        this.registerFormElement('think_time', 'Simulated Think Time (ms):', 'input', 1000);
        this.registerFormElement('think_variance', 'Simulated Think Variance (ms):', 'input', 500);
        this.registerFormElement('move_time', 'Simulated Move Time (ms):', 'input', 200);
        this.registerFormElement('move_variance', 'Simulated Move Variance (ms):', 'input', 100);

        this.pullConfigValues();
        this.onConfigValuesChanged();
    }

    // form uniqueifier
    getCurrentUniquifier() {
        return this.formElements.reduce((acc, formElement) => {
            return acc + formElement.name + ':' + formElement.getValue() + ' ';
        }, '');
    }

    updateUniquifier() {
        this.configUniqueifier = this.getCurrentUniquifier();
    }

    // localstorage values push/pull
    pullConfigValues() {
        this.formElements.forEach((formElement) => {
            const localStorageVal = localStorage.getItem(formElement.name);
            if (localStorageVal) {
                formElement.setValue(JSON.parse(localStorageVal));
            } else {
                formElement.setValue(formElement.default);
            }
        });
        this.updateUniquifier();
    }

    pushConfigValues() {
        this.formElements.forEach((formElement) => {
            localStorage.setItem(formElement.name, formElement.getValue())
        });
        this.updateUniquifier();
    }

    // register form element
    registerFormElement(name, description, type, defaultValue) {
        const formElement = new FormElement(name, description, type, defaultValue);
        formElement.registerChangeListener(() => this.onConfigValuesChanged());
        this.formElements.push(formElement);
    }

    // on event callbacks
    onApplyConfigValues() {
        this.pushConfigValues();
        this.onConfigValuesChanged();
    }

    onResetConfigValues() {
        localStorage.clear();
        this.pullConfigValues();
        this.onConfigValuesChanged();
    }

    onConfigValuesChanged() {
        this.applyButton.disabled = (this.configUniqueifier === this.getCurrentUniquifier());
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
