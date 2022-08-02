import FormElement from "./../../../util/FormElement.js";

// todo: remove duplicated code, here and in General Settings
class AppearanceSettings {
    resetButton;
    applyButton;
    formElements;
    configUniqueifier;

    constructor() {
        this.formElements = [];
        this.configUniqueifier = '';
    }

    onInit() {
        M.FormSelect.init(document.querySelectorAll('select'), {});

        this.applyButton = document.getElementById('apply_btn');
        this.applyButton.addEventListener('click', () => this.onApplyConfigValues());
        this.resetButton = document.getElementById('reset_btn');
        this.resetButton.addEventListener('click', () => this.onResetConfigValues());

        this.registerFormElement('pieces', 'Pieces:', 'select', 'standard');
        this.registerFormElement('board', 'Board:', 'select', 'brown');

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
            const formValue = (formElement.valueType === 'string')
                ? `"${formElement.getValue()}"`
                : formElement.getValue();
            localStorage.setItem(formElement.name, formValue);
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
        this.pullConfigValues();
        this.onConfigValuesChanged();
    }

    onConfigValuesChanged() {
        this.applyButton.disabled = (this.configUniqueifier === this.getCurrentUniquifier());
    }
}

define({
    title: 'Appearance',
    page: new AppearanceSettings()
});