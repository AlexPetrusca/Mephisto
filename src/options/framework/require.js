const moduleMap = {};

export async function require(path, type = 'js') {
    if (type === 'js') {
        return requirejs(path);
    } else if (type === 'css') {
        return requirecss(path)
    } else {
        return requirehtml(path)
    }
}

export function define(module) {
    moduleMap.latest = module;
}

async function requirejs(path) {
    if (moduleMap[path]) return moduleMap[path];
    return new Promise(resolve => {
        const script = document.createElement('script');
        script.id = `${path}-script`;
        script.src = `${path}.js`;
        script.type = 'module';
        script.className = 'page-script';
        script.setAttribute('async', '');
        script.setAttribute('defer', '');
        script.onload = () => {
            moduleMap[path] = moduleMap.latest;
            resolve(moduleMap[path]);
        }
        document.body.appendChild(script);
    });
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