const queue = [];
const moduleMap = {};

async function require(path, type = 'js') {
    if (type === 'js') {
        return requirejs(path);
    } else if (type === 'css') {
        return requirecss(path)
    } else {
        return requirehtml(path)
    }
}

async function requirejs(path) {
    if (moduleMap[path]) return moduleMap[path];
    queue.push(path);
    let script = document.createElement('script');
    script.id = `${path}-script`;
    script.type = 'module';
    script.src = `${path}.js`;
    script.className = 'page-script';
    document.body.appendChild(script);
    let retries = 0;
    async function pollModule() {
        if (moduleMap[path]) {
            return moduleMap[path];
        } else if (retries > 10) {
            define(null);
            return null;
        }
        retries++;
        return timeout(pollModule, 4);
    }
    return pollModule();
}

async function requirecss(path) {
    const stylesheet = document.createElement('link');
    stylesheet.id = `${path}-stylesheet`;
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${path}.css`;
    stylesheet.className = 'page-stylesheet';
    return stylesheet;
}

async function requirehtml(path) {
    const body = document.createElement('div');
    body.id = `${path}-body`;
    body.innerHTML = await fetch(`${path}.html`).then(response => response.text());
    body.className = 'page-body';
    return body;
}

function define(module) {
    const path = queue.shift();
    moduleMap[path] = module;
}

async function timeout(fn, t) {
    return new Promise(resolve => {
        setTimeout(() => resolve(fn()), t);
    });
}