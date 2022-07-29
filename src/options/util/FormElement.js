export default class FormElement {
    name;
    desc;
    type;
    default;
    elem;

    constructor(name, description, type, defaultValue) {
        this.name = name;
        this.desc = description;
        this.type = type;
        this.default = defaultValue;
        this.elem = document.getElementById(`${name}_input`);
    }

    registerChangeListener(fn) {
        if (this.type === 'input') {
            this.elem.addEventListener('input', fn);
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