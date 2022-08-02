export default class FormElement {
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
    }

    registerChangeListener(fn) {
        if (this.type === 'input') {
            this.elem.addEventListener('input', fn);
        } else if (this.type === 'checkbox') {
            this.elem.addEventListener('change', fn);
        } else if (this.type === 'select') {
            this.elem.addEventListener('change', fn);
        }
    }

    getValue() {
        if (this.type === 'input') {
            return this.elem.value;
        } else if (this.type === 'checkbox') {
            return this.elem.checked;
        } else if (this.type === 'select') {
            return this.elem.value;
        }
    }

    setValue(val) {
        if (this.type === 'input') {
            this.elem.value = val;
        } else if (this.type === 'checkbox') {
            this.elem.checked = val;
        } else if (this.type === 'select') {
            this.elem.value = val;
            this.elem.parentElement.querySelector('input').value =
                this.elem.querySelector(`option[value="${val}"]`).innerText;
        }
    }
}