// Self-update from this project's own GitHub releases.
//
// STRICT OPT-IN, and the gate is OURS. Nothing here runs until the Updates section is switched on,
// which is the same moment Chrome is asked for the two release hosts. install() refuses outright
// while that grant is missing, and the buttons stay disabled -- that check is the enforcement.
//
// MEASURED, because the obvious assumption is wrong: in Chrome 151 an extension PAGE can fetch and
// read any cross-origin URL with no host permission at all. A control fetch of example.com and a
// full 5,884,500-byte read of a real release asset both succeeded from the options page with
// nothing granted (headless Chrome 151.0.7922.72, macOS, 2026-08-06). So the permission is not what
// makes the download possible. It is kept anyway, for two reasons that are worth the four lines:
// it is a visible, revocable record of what was agreed to (chrome://extensions shows it, and
// switching the toggle off hands it back), and it keeps working on any build that DOES enforce CORS
// here. What it is not is a substitute for the hasPermission() check below.
//
// WHY THIS IS NEEDED AT ALL. Chrome never auto-updates an unpacked extension -- `update_url` is
// ignored for anything loaded through Developer mode. The only route left is to rewrite the
// extension's own folder on disk and call chrome.runtime.reload(). Nothing can hand an extension a
// writable filesystem path except the user, through showDirectoryPicker(), so the folder is picked
// once and the handle kept in IndexedDB.
//
// THE EXTENSION ID SURVIVES, which is the point. An unpacked extension's id comes from the absolute
// path of its folder (or from manifest "key" where one is set) -- never from its contents. Writing
// in place keeps the id, so every native-messaging manifest naming it keeps working. Re-installing
// from a fresh zip into a new folder is what breaks that, and is what this exists to avoid.
//
// ONLY THE UPDATE ARCHIVE IS EVER APPLIED. mephisto-<v>-update.zip is about six megabytes; the full
// one is 585 and would have to be held in memory to be read. The full archive is refused, twice --
// once on Content-Length and once on its contents.
const MephistoUpdater = (function () {
    const REPO = 'IchNukeDichWeg/Mephisto';
    // Deliberately narrow: the release-download path of ONE repository, not github.com. The second
    // host is where every asset download is redirected to, and its path is an opaque signed blob, so
    // that one cannot be narrowed at all. Must stay identical to manifest optional_host_permissions,
    // or the request is a silent no-op and the toggle can never go on.
    const ORIGINS = [
        `https://github.com/${REPO}/releases/download/*`,
        'https://release-assets.githubusercontent.com/*',
    ];
    const DB = 'mephisto-updater', STORE = 'h', KEY = 'root';
    const MAX_ZIP = 64 * 1024 * 1024; // the update archive is ~6 MB; the full one is 585

    // --- the picked folder, remembered ----------------------------------------------------------
    // A FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can hold it across restarts.
    // chrome.storage cannot: it JSON-serializes, which turns a handle into `{}`.
    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(DB, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(STORE);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function idbDo(mode, fn) {
        const db = await idb();
        try {
            return await new Promise((res, rej) => {
                const r = fn(db.transaction(STORE, mode).objectStore(STORE));
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        } finally {
            db.close();
        }
    }
    const handleGet = () => idbDo('readonly', s => s.get(KEY));
    const handlePut = (v) => idbDo('readwrite', s => s.put(v, KEY));
    const handleDel = () => idbDo('readwrite', s => s.delete(KEY));

    // --- permission -----------------------------------------------------------------------------
    // Both calls need a user gesture, which is why the caller wires them straight to the toggle
    // rather than doing anything clever first.
    const hasPermission = () => chrome.permissions.contains({origins: ORIGINS});
    const requestPermission = () => chrome.permissions.request({origins: ORIGINS});
    const dropPermission = () => chrome.permissions.remove({origins: ORIGINS});

    // --- the on/off setting -----------------------------------------------------------------------
    // The Chrome permission is a CAPABILITY, not the setting. Treating it as the setting meant the
    // switch could not be turned off: chrome.permissions.remove answers false whenever Chrome
    // decides not to revoke -- granting a path-scoped pattern can widen it to the whole origin, and
    // the narrower pattern then does not match anything removable -- so hasPermission() stayed true
    // and the checkbox sprang straight back on. The user's intent has to be recorded separately and
    // has to win. Off means off whatever Chrome kept.
    //
    // chrome.storage.local, not localStorage: the service worker reads it to answer isReady().
    const enabled = () => chrome.storage.local.get('auto_update').then(v => v.auto_update === true);
    const setEnabled = (on) => chrome.storage.local.set({auto_update: on === true});

    // Everything that has to be true before a one-click update can be offered.
    async function isReady() {
        if (!(await enabled())) return false;
        if (!(await hasPermission())) return false;
        return !!(await handleGet());
    }

    // --- the folder -----------------------------------------------------------------------------
    // Verified to be THIS extension before it is ever written to. A mis-picked directory would
    // otherwise get a few hundred files sprayed into it, and there is no undo for that. The name
    // comes from the RUNNING manifest, so the check cannot drift from whatever this build calls
    // itself -- the fork and the local tree share it by construction.
    async function verifyFolder(handle) {
        let manifest;
        try {
            manifest = JSON.parse(await (await handle.getFileHandle('manifest.json')).getFile()
                .then(f => f.text()));
        } catch (e) {
            throw new Error('No manifest.json in that folder — pick the folder you loaded as an unpacked extension.');
        }
        const want = chrome.runtime.getManifest().name;
        if (manifest.name !== want) {
            throw new Error(`That folder holds "${manifest.name || 'something else'}", not ${want}.`);
        }
        return manifest;
    }

    async function pickFolder() {
        const handle = await showDirectoryPicker({id: 'mephisto-root', mode: 'readwrite'});
        const manifest = await verifyFolder(handle); // throws BEFORE anything is remembered
        await handlePut(handle);
        return {name: handle.name, version: manifest.version};
    }

    // A handle survives a browser restart; its write grant does not always come back with it. So the
    // grant is re-checked on every use and re-requested when asked for -- and that request needs a
    // user gesture, which is why install() does it before the download rather than after.
    async function folder({prompt = false} = {}) {
        const handle = await handleGet();
        if (!handle) return null;
        const opts = {mode: 'readwrite'};
        let state = await handle.queryPermission(opts);
        if (state !== 'granted' && prompt) state = await handle.requestPermission(opts);
        return state === 'granted' ? handle : null;
    }

    // --- release lookup -------------------------------------------------------------------------
    // Goes through the service worker's updateCheck rather than fetching here: that one already
    // owns the version compare and a 12h cache, and the unauthenticated GitHub API allows 60
    // requests/hour/IP. One implementation, one cache.
    function check({force = false} = {}) {
        return new Promise((res, rej) => {
            chrome.runtime.sendMessage({updateCheck: {force}}, (r) => {
                if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
                if (!r || r.error) return rej(new Error(r?.error || 'no answer from the extension'));
                res(r);
            });
        });
    }

    // --- zip ------------------------------------------------------------------------------------
    // `git archive --format=zip -9` writes exactly two storage methods -- 0 (stored, for whatever
    // did not compress) and 8 (deflate) -- and no zip64 records, because the update archive is six
    // megabytes with a few hundred entries. Anything else is refused rather than guessed at.
    function readZip(buf) {
        const dv = new DataView(buf);
        // The end-of-central-directory record is found by scanning BACK for its signature: it ends
        // with a variable-length comment, so it sits at no fixed offset. The comment is capped at
        // 65535 bytes, which bounds the scan.
        let eocd = -1;
        for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 22 - 65536; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');
        const count = dv.getUint16(eocd + 10, true);
        const cdOff = dv.getUint32(eocd + 16, true);
        if (count === 0xffff || cdOff === 0xffffffff) throw new Error('Zip64 archives are not supported.');
        const dec = new TextDecoder();
        const entries = [];
        let p = cdOff;
        for (let i = 0; i < count; i++) {
            if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
            entries.push({
                method: dv.getUint16(p + 10, true),
                csize: dv.getUint32(p + 20, true),
                usize: dv.getUint32(p + 24, true),
                lho: dv.getUint32(p + 42, true),
                name: dec.decode(new Uint8Array(buf, p + 46, dv.getUint16(p + 28, true))),
            });
            p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
        }
        return entries;
    }

    async function extract(buf, e) {
        const dv = new DataView(buf);
        if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${e.name}.`);
        // The data offset has to come from the LOCAL header's own name/extra lengths. They are
        // routinely not the central directory's -- writers put different extra fields in each -- and
        // reusing the central values silently reads from the wrong offset.
        const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
        const raw = new Uint8Array(buf, start, e.csize);
        if (e.method === 0) return raw;
        if (e.method !== 8) throw new Error(`${e.name}: unsupported compression method ${e.method}.`);
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (out.byteLength !== e.usize) throw new Error(`${e.name}: inflated to the wrong size.`);
        return out;
    }

    // Everything is parsed, inflated and checked BEFORE a single byte is written. A half-applied
    // update is an extension that will not load, and the recovery for that is the 585 MB download --
    // so a bad archive has to fail while the folder is still untouched.
    async function readUpdateArchive(buf, version) {
        const prefix = `Mephisto-${version}/`;
        const out = [];
        for (const e of readZip(buf)) {
            if (e.name.endsWith('/')) continue; // directory record; directories are created on demand
            if (!e.name.startsWith(prefix)) throw new Error(`Unexpected path in the archive: ${e.name}`);
            const path = e.name.slice(prefix.length);
            // An archive is untrusted input even from our own release page. getDirectoryHandle('..')
            // does reject on its own, but a backslash or a leading slash is not covered by that, and
            // the right answer to any of them is to refuse the whole archive rather than skip a file.
            if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
                throw new Error(`Unsafe path in the archive: ${e.name}`);
            }
            out.push({path, bytes: await extract(buf, e)});
        }
        const have = new Set(out.map(f => f.path));
        for (const need of ['manifest.json', 'src/popup/popup.js', 'src/scripts/content-script.js', 'lib/chess.js']) {
            if (!have.has(need)) throw new Error(`The archive is missing ${need}.`);
        }
        // The full archive would apply perfectly well here and take 585 MB of memory to do it.
        // Refuse it by the one directory that tells the two apart.
        if ([...have].some(p => p.startsWith('lib/engine/'))) {
            throw new Error('That is the full archive, not the update one.');
        }
        const manifest = JSON.parse(new TextDecoder().decode(out.find(f => f.path === 'manifest.json').bytes));
        if (manifest.version !== version) {
            throw new Error(`The archive says v${manifest.version} but the release says v${version}.`);
        }
        return out;
    }

    // --- staged, recoverable install --------------------------------------------------------------
    // TRUE ATOMICITY IS NOT AVAILABLE, and it is worth being plain about why: the extension id comes
    // from its folder path, so the folder cannot be swapped out from under itself the way a normal
    // installer would. What IS available is making every step recoverable:
    //
    //   1. every file is written to .mephisto-staging first, so a complete copy of the new version
    //      exists on disk before anything is overwritten
    //   2. every file about to be replaced is copied to .mephisto-backup/<version>, with a manifest
    //   3. only then are the files put in place
    //
    // Die during 3 and the backup is complete, so Roll back restores the old version; the staged
    // copy is also intact, so finishing needs no second download. Dot-directories, which Chrome
    // ignores when it loads an unpacked extension.
    const STAGING = '.mephisto-staging';
    const BACKUP = '.mephisto-backup';

    async function dirAt(root, path, create) {
        let d = root;
        for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, {create});
        return d;
    }
    async function readFileAt(root, relPath) {
        try {
            const parts = relPath.split('/');
            const name = parts.pop();
            const d = await dirAt(root, parts.join('/'), false);
            const f = await (await d.getFileHandle(name)).getFile();
            return new Uint8Array(await f.arrayBuffer());
        } catch (e) {
            return null; // absent is a normal answer here, not a failure
        }
    }
    async function removeFileAt(root, relPath) {
        try {
            const parts = relPath.split('/');
            const name = parts.pop();
            const d = await dirAt(root, parts.join('/'), false);
            await d.removeEntry(name);
        } catch (e) { /* already gone */ }
    }
    async function removeEntry(root, name) {
        try { await root.removeEntry(name, {recursive: true}); } catch (e) { /* not there */ }
    }

    // One generation, deliberately. Two would double the disk for a case nobody has ever wanted:
    // what you want back is the version that was working ten minutes ago, not four versions ago.
    async function backupCurrent(dir, version, paths, onStatus) {
        await removeEntry(dir, BACKUP);
        const backup = await dir.getDirectoryHandle(BACKUP, {create: true});
        const gen = await backup.getDirectoryHandle(version, {create: true});
        const saved = [], added = [];
        let n = 0;
        for (const p of paths) {
            const bytes = await readFileAt(dir, p);
            if (bytes) { await writeFile(gen, p, bytes); saved.push(p); }
            else added.push(p); // a file this update introduces: rolling back has to DELETE it
            if (++n % 40 === 0) onStatus(`Backing up… ${n}/${paths.length}`);
        }
        await writeFile(backup, 'manifest.json', new TextEncoder().encode(
            JSON.stringify({version, saved, added, at: new Date().toISOString()}, null, 2)));
        return {saved: saved.length, added: added.length};
    }

    // What Settings needs to decide whether to offer the button at all.
    async function rollbackInfo() {
        const dir = await handleGet();
        if (!dir) return null;
        try {
            const backup = await dir.getDirectoryHandle(BACKUP);
            const raw = await readFileAt(backup, 'manifest.json');
            if (!raw) return null;
            const m = JSON.parse(new TextDecoder().decode(raw));
            return {version: m.version, files: (m.saved || []).length, at: m.at};
        } catch (e) {
            return null;
        }
    }

    // Every file is read back and checked BEFORE the first one is written, for the same reason the
    // archive is: a half-restore is worse than a failed one, and it is the state nobody can recover
    // from by hand.
    async function rollback(onStatus = () => {}) {
        const dir = await folder({prompt: true});
        if (!dir) throw new Error('Choose the extension folder first.');
        const backup = await dir.getDirectoryHandle(BACKUP).catch(() => null);
        if (!backup) throw new Error('There is nothing to roll back to.');
        const raw = await readFileAt(backup, 'manifest.json');
        if (!raw) throw new Error('The backup is missing its manifest.');
        const m = JSON.parse(new TextDecoder().decode(raw));
        const gen = await backup.getDirectoryHandle(m.version).catch(() => null);
        if (!gen) throw new Error(`The backup of v${m.version} is missing.`);

        onStatus(`Reading the backup of v${m.version}…`);
        const restore = [];
        for (const p of (m.saved || [])) {
            const bytes = await readFileAt(gen, p);
            if (!bytes) throw new Error(`The backup is missing ${p} — refusing to half-restore.`);
            restore.push({path: p, bytes});
        }
        let n = 0;
        for (const f of restore) {
            await writeFile(dir, f.path, f.bytes);
            if (++n % 40 === 0 || n === restore.length) onStatus(`Restoring… ${n}/${restore.length}`);
        }
        // Files the update ADDED have no earlier version. Leaving them behind would mix two builds,
        // which is the failure mode that made a deleted declaration invisible once before.
        for (const p of (m.added || [])) await removeFileAt(dir, p);
        await removeEntry(dir, BACKUP);
        return {version: m.version, files: restore.length, removed: (m.added || []).length};
    }

    // A staging directory left behind means the move step did not finish. Say so, and offer to
    // finish it from disk rather than making someone download the archive again.
    async function pendingInstall() {
        const dir = await handleGet();
        if (!dir) return null;
        try {
            const staging = await dir.getDirectoryHandle(STAGING);
            const raw = await readFileAt(staging, 'manifest.json');
            if (!raw) return null;
            return {version: JSON.parse(new TextDecoder().decode(raw)).version};
        } catch (e) {
            return null;
        }
    }

    // Every file under a directory handle, depth first, as paths relative to it.
    async function walkFiles(root, prefix = '') {
        const out = [];
        for await (const [name, h] of root.entries()) {
            const p = prefix ? `${prefix}/${name}` : name;
            if (h.kind === 'directory') out.push(...await walkFiles(h, p));
            else out.push(p);
        }
        return out;
    }

    // Finish an install whose move step was interrupted. The bytes are already on disk and already
    // verified -- they went through readUpdateArchive before they were staged -- so this is a copy,
    // not a second download. Read entirely into memory first, same as everywhere else: a partial
    // finish would be a third state nobody can reason about.
    async function finishStaged(onStatus = () => {}) {
        const dir = await folder({prompt: true});
        if (!dir) throw new Error('Choose the extension folder first.');
        const staging = await dir.getDirectoryHandle(STAGING).catch(() => null);
        if (!staging) throw new Error('There is no interrupted update to finish.');
        const raw = await readFileAt(staging, 'manifest.json');
        if (!raw) throw new Error('The staged update has no manifest — download it again.');
        const version = JSON.parse(new TextDecoder().decode(raw)).version;

        onStatus(`Reading the staged v${version}…`);
        const paths = await walkFiles(staging);
        const files = [];
        for (const p of paths) {
            const bytes = await readFileAt(staging, p);
            if (!bytes) throw new Error(`The staged update is missing ${p} — download it again.`);
            files.push({path: p, bytes});
        }
        // An interrupted install already took a backup. Only take one if it did not get that far,
        // and never overwrite a good backup with a half-updated folder -- that would destroy the
        // only copy of the version being restored to.
        if (!(await rollbackInfo())) {
            const installed = await verifyFolder(dir);
            await backupCurrent(dir, installed.version, paths, onStatus);
        }
        let n = 0;
        for (const f of files) {
            await writeFile(dir, f.path, f.bytes);
            if (++n % 40 === 0 || n === files.length) onStatus(`Installing… ${n}/${files.length}`);
        }
        await removeEntry(dir, STAGING);
        return {version, files: files.length};
    }

    // --- writing --------------------------------------------------------------------------------
    async function writeFile(root, relPath, bytes) {
        const parts = relPath.split('/');
        const name = parts.pop();
        let dir = root;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, {create: true});
        const w = await (await dir.getFileHandle(name, {create: true})).createWritable();
        await w.write(bytes);
        await w.close();
    }

    // A "key" in the INSTALLED manifest pins the extension id. The published archive carries none --
    // the fork ships without one -- so applying it verbatim would drop the key and change the id,
    // taking every native-messaging registration with it. Carry the installed one across.
    function carryKey(archiveManifestBytes, installed) {
        const m = JSON.parse(new TextDecoder().decode(archiveManifestBytes));
        if (!installed.key || m.key) return null;
        return new TextEncoder().encode(JSON.stringify({key: installed.key, ...m}, null, 2) + '\n');
    }

    // --- the whole thing ------------------------------------------------------------------------
    async function install(onStatus = () => {}) {
        if (!(await enabled())) throw new Error('Automatic updates are switched off.');
        if (!(await hasPermission())) throw new Error('Chrome is not holding the download permission.');
        const dir = await folder({prompt: true});
        if (!dir) throw new Error('Choose the extension folder first.');
        const installed = await verifyFolder(dir); // re-checked every run, not only when it was picked

        onStatus('Checking for a newer release…');
        const rel = await check({force: true});
        if (!rel.latest) throw new Error('Could not reach GitHub.');
        if (!rel.newer) return {already: true, version: rel.latest};
        if (!rel.asset) throw new Error(`Release v${rel.latest} has no update archive — use the full zip.`);

        onStatus(`Downloading v${rel.latest}…`);
        const res = await fetch(rel.asset, {credentials: 'omit'});
        if (!res.ok) throw new Error(`Download failed (${res.status}).`);
        // Checked before buffering, so a mis-named full archive costs one header rather than 585 MB.
        if (+res.headers.get('content-length') > MAX_ZIP) throw new Error('That download is far too big to be the update archive.');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_ZIP) throw new Error('That download is far too big to be the update archive.');

        onStatus('Reading the archive…');
        const files = await readUpdateArchive(buf, rel.latest);
        const keyed = carryKey(files.find(f => f.path === 'manifest.json').bytes, installed);
        if (keyed) files.find(f => f.path === 'manifest.json').bytes = keyed;

        // 1. STAGE. A complete copy of the new version lands on disk before anything is overwritten.
        onStatus(`Staging ${files.length} files…`);
        await removeEntry(dir, STAGING);
        const staging = await dir.getDirectoryHandle(STAGING, {create: true});
        let n = 0;
        for (const f of files) {
            await writeFile(staging, f.path, f.bytes);
            if (++n % 40 === 0 || n === files.length) onStatus(`Staging… ${n}/${files.length}`);
        }

        // 2. BACK UP what is about to be replaced, so this is undoable.
        onStatus(`Backing up v${installed.version}…`);
        const bk = await backupCurrent(dir, installed.version, files.map(f => f.path), onStatus);

        // 3. PUT IN PLACE. Written from memory rather than re-read from staging -- same bytes, half
        // the I/O. Staging still earns its keep: it is the on-disk proof that the whole version
        // arrived, and it is what finishes the job if this loop is interrupted.
        n = 0;
        for (const f of files) {
            await writeFile(dir, f.path, f.bytes);
            if (++n % 40 === 0 || n === files.length) onStatus(`Installing… ${n}/${files.length}`);
        }
        await removeEntry(dir, STAGING);
        return {installed: rel.latest, from: installed.version, files: files.length,
                backedUp: bk.saved, added: bk.added, headline: rel.headline || ''};
    }

    return {
        REPO, ORIGINS,
        hasPermission, requestPermission, dropPermission,
        enabled, setEnabled, isReady,
        // `folder` answers null when the write grant has lapsed (it does across restarts);
        // `savedFolder` answers whether one was ever chosen, which is a different question and the
        // one the settings page needs to decide what to tell you.
        pickFolder, folder, savedFolder: handleGet, forgetFolder: handleDel, verifyFolder,
        check, install,
        rollback, rollbackInfo, pendingInstall, finishStaged,
        // exported for the test suite, which drives them against a real archive and a stub directory
        _readZip: readZip, _extract: extract, _readUpdateArchive: readUpdateArchive,
        _writeFile: writeFile, _carryKey: carryKey,
        _readFileAt: readFileAt, _removeFileAt: removeFileAt, _backupCurrent: backupCurrent,
        _walkFiles: walkFiles,
        _STAGING: STAGING, _BACKUP: BACKUP,
    };
})();

// The options page loads this as a plain script; the test suite loads the same file into a vm.
if (typeof module !== 'undefined' && module.exports) module.exports = MephistoUpdater;
