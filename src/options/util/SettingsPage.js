import { FormElement } from "./FormElement.js";

export class SettingsPage {
    resetButton;
    applyButton;
    formElements;
    configUniqueifier;

    constructor() {
        if (this.constructor === SettingsPage) {
            throw new Error("Can't instantiate abstract class!");
        }
        this.formElements = [];
        this.configUniqueifier = '';
    }

    init() {
        throw new Error("init() must be implemented!");
    }

    onInit() {
        this.applyButton = document.getElementById('apply_btn');
        this.applyButton.addEventListener('click', () => this.onApplyConfigValues());
        this.resetButton = document.getElementById('reset_btn');
        this.resetButton.addEventListener('click', () => this.onResetConfigValues());

        this.init();

        this.pullConfigValues();
        this.onConfigValuesChanged();
    }

    // form uniqueifier
    createUniquifier() {
        return this.formElements.reduce((acc, formElement) => {
            return acc + formElement.name + ':' + formElement.getValue() + ' ';
        }, '');
    }

    updateUniquifier() {
        this.configUniqueifier = this.createUniquifier();
    }

    clearConfigValues() {
        this.formElements.forEach(formElement => {
            localStorage.removeItem(formElement.name);
        });
        this.updateUniquifier();
    }

    // localstorage values push/pull
    pullConfigValues() {
        this.formElements.forEach(formElement => {
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
        this.formElements.forEach(formElement => {
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
        return formElement;
    }

    // on event callbacks
    onApplyConfigValues() {
        this.pushConfigValues();
        this.onConfigValuesChanged();
    }

    onResetConfigValues() {
        this.clearConfigValues();
        this.pullConfigValues();
        this.onConfigValuesChanged();
    }

    onConfigValuesChanged() {
        this.applyButton.disabled = (this.configUniqueifier === this.createUniquifier());
    }
}
