registerPageScript(() => {
    class FormElement {
        // static formContainer = document.getElementById('form_container');
        // static tocContainer = document.getElementById('toc');

        constructor(name, description, type, defaultValue) {
            this.name = name;
            this.desc = description;
            this.type = type;
            this.default = defaultValue;
            this.elem = document.getElementById(`${name}_input`);
        }

        // injectFormElement() {
        //     const formElement = document.createElement('div');
        //     formElement.id = this.name;
        //     formElement.className = 'section scrollspy';
        //     if (this.type === 'input') {
        //         const input = `<input id="${this.name}_input" type="number">`;
        //         formElement.innerHTML = `<label>${this.desc} ${input}</label>`;
        //     } else if (this.type === 'checkbox') {
        //         const input = `<input id="${this.name}_input" type="checkbox">`;
        //         formElement.innerHTML = `<label>Off${input}<span class="lever"></span>On</label>`;
        //     }
        //     FormElement.formContainer.append(formElement);
        //
        //     const tocElement = document.createElement('li');
        //     tocElement.innerHTML = `<a href="#${this.name}">${this.title}</a>`;
        //     FormElement.tocContainer.append(tocElement);
        // }

        registerChangeListener(fn) {
            if (this.type === 'input') {
                this.elem.addEventListener('keyup', fn);
            } else if (this.type === 'checkbox') {
                this.elem.addEventListener('change', fn);
            }
        }

        getValue() {
            if (this.type === 'input') {
                return this.elem.value;
            } else if (this.type === 'checkbox') {
                return this.elem.checked;
            }
        }

        setValue(val) {
            if (this.type === 'input') {
                this.elem.value = val;
            } else if (this.type === 'checkbox') {
                this.elem.checked = val;
            }
        }
    }

    const resetButton = document.getElementById('reset_btn');
    const applyButton = document.getElementById('apply_btn');
    const formElements = [];
    let configUniqueifier = "";

    // form uniqueifier
    function getCurrentUniquifier() {
        return formElements.reduce((acc, formElement) => {
            return acc + formElement.name + ':' + formElement.getValue() + ' ';
        }, '');
    }

    function updateUniquifier() {
        configUniqueifier = getCurrentUniquifier();
    }

    // localstorage values push/pull
    function pullConfigValues() {
        formElements.forEach((formElement) => {
            const localStorageVal = localStorage.getItem(formElement.name);
            if (localStorageVal) {
                formElement.setValue(JSON.parse(localStorageVal));
            } else{
                formElement.setValue(formElement.default);
            }
        });
        updateUniquifier();
    }

    function pushConfigValues() {
        formElements.forEach((formElement) => {
            localStorage.setItem(formElement.name, formElement.getValue())
        });
        updateUniquifier();
    }

    // register form element
    function registerFormElement(name, description, type, defaultValue) {
        const formElement = new FormElement(name, description, type, defaultValue);
        formElement.registerChangeListener(onConfigValuesChanged);
        formElements.push(formElement);
    }

    // on event callbacks
    function onApplyConfigValues() {
        pushConfigValues();
        onConfigValuesChanged();
    }

    function onResetConfigValues() {
        localStorage.clear();
        pullConfigValues();
        onConfigValuesChanged();
    }

    function onConfigValuesChanged() {
        applyButton.disabled = (configUniqueifier === getCurrentUniquifier());
    }

    applyButton.addEventListener('click', onApplyConfigValues);
    resetButton.addEventListener('click', onResetConfigValues);

    registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 500);
    registerFormElement('fen_refresh', 'Fen Refresh Interval (ms):', 'input', 100);
    registerFormElement('simon_says_mode', '"Simon Says" Mode:', 'checkbox', false);
    registerFormElement('autoplay', 'Autoplay:', 'checkbox', false);
    registerFormElement('puzzle_mode', 'Puzzle Mode:', 'checkbox', false);
    registerFormElement('python_autoplay_backend', 'Python Autoplay Backend:', 'checkbox', false);
    registerFormElement('think_time', 'Simulated Think Time (ms):', 'input', 1000);
    registerFormElement('think_variance', 'Simulated Think Variance (ms):', 'input', 500);
    registerFormElement('move_time', 'Simulated Move Time (ms):', 'input', 200);
    registerFormElement('move_variance', 'Simulated Move Variance (ms):', 'input', 100);

    pullConfigValues();
    onConfigValuesChanged();
});
