import {define} from "../../../framework/require.js";
import {SettingsPage} from "../../../util/SettingsPage.js";

class GeneralSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        M.Range.init(document.querySelectorAll('input[type=range]'), {});
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});
        const engine_select = this.registerFormElement('engine', 'Engine:', 'select', 'stockfish-dev-nnue');
        const variant_select = this.registerFormElement('variant', 'Variant:', 'select', 'chess');
        const elo_input = this.registerFormElement('elo', 'Elo:', 'input', 0);
        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 300);
        this.registerFormElement('fen_refresh', 'Fallback Poll Interval (ms):', 'input', 1000);
        const multipv_range = this.registerFormElement('multiple_lines', 'Multiple Lines:', 'range', 1);
        const threads_range = this.registerFormElement('threads', 'Threads:', 'range', MephistoConfig.defaultThreads());
        const memory_range = this.registerFormElement('memory', 'Memory:', 'range', 512);
        this.registerFormElement('computer_evaluation', 'Show Computer Evaluation:', 'checkbox', true);
        this.registerFormElement('threat_analysis', 'Show Threat Analysis', 'checkbox', false);
        this.registerFormElement('simon_says_mode', '"Hand and Brain" Mode:', 'checkbox', false);
        this.registerFormElement('autoplay', 'Autoplay:', 'checkbox', false);
        this.registerFormElement('premove', 'Premove:', 'checkbox', false);
        this.registerFormElement('ponder', 'Pondering:', 'checkbox', false);
        this.registerFormElement('tablebase', 'Endgame Tablebase:', 'checkbox', false);
        this.registerFormElement('move_reason', 'Explain Moves:', 'checkbox', false);
        this.registerFormElement('hide_opponent', 'Hide Opponent Name:', 'checkbox', false);
        this.registerFormElement('explorer', 'Opening Explorer:', 'checkbox', false);
        this.registerFormElement('book_play', 'Play Book Moves:', 'checkbox', false);
        this.registerFormElement('explorer_db', 'Opening Database:', 'select', 'masters');
        this.registerFormElement('background_play', 'Background Play:', 'checkbox', false);
        this.registerFormElement('help_mode', 'Help Mode:', 'checkbox', false);
        this.registerFormElement('humanize', 'Humanize:', 'checkbox', false);
        this.registerFormElement('clock_mode', 'Clock Mode:', 'checkbox', false);
        this.registerFormElement('mirror_mode', 'Mirror Time:', 'checkbox', false);
        this.registerFormElement('manual_mode', 'Manual Mode:', 'checkbox', false);
        this.registerFormElement('opp_alert', 'Opponent Mistake Alert:', 'checkbox', false);
        this.initHumanizeMix();
        this.initHumanizeThresholds();
        this.initUiMode();
        this.initHotkeys();
        this.registerFormElement('puzzle_mode', 'Puzzle Mode:', 'checkbox', false);
        this.registerFormElement('python_autoplay_backend', 'Python Autoplay Backend:', 'checkbox', false);
        this.registerFormElement('think_time', 'Simulated Think Time (ms):', 'input', 0);
        this.registerFormElement('think_variance', 'Simulated Think Variance (ms):', 'input', 0);
        this.registerFormElement('move_time', 'Simulated Move Time (ms):', 'input', 400);
        this.registerFormElement('move_variance', 'Simulated Move Variance (ms):', 'input', 400);
        const engineLabelTooltiped = document.querySelector('#engine-label-tooltiped');
        const engineLabelUntooltiped = document.querySelector('#engine-label-untooltiped');
        for (const range of [multipv_range, threads_range, memory_range]) {
            range.registerChangeListener(() => {
                let section = range.elem;
                while (!section.classList.contains('section')) {
                    section = section.parentElement
                }
                section.querySelector('.value').innerText = range.getValue();
            });
        }
        engine_select.registerChangeListener(() => {
            let section = variant_select.elem;
            while (!section.classList.contains('section')) {
                section = section.parentElement
            }
            if (['fairy-stockfish-14-nnue', 'fairy-native'].includes(engine_select.getValue())) {
                section.classList.remove('hidden');
            } else {
                section.classList.add('hidden');
                // Chess960 survives an engine switch: every mainline Stockfish plays it via
                // UCI_Chess960 (sent at engine init). Only fairy-only variants reset.
                if (!['chess', 'fischerandom'].includes(variant_select.getValue())) {
                    variant_select.setValue('chess');
                }
            }
            // Elo cap range follows the engine (Stockfish ignores out-of-range UCI_Elo). Keep the
            // input min at 0 so "0 = full strength" stays enterable; only cap the top per engine.
            const ELO_RANGE = { 'stockfish-11-hce': [1350, 2850], 'fairy-stockfish-14-nnue': [500, 2850], 'fairy-native': [500, 2850], 'sf-native': [1320, 3190] };
            elo_input.elem.max = (ELO_RANGE[engine_select.getValue()] || [1320, 3190])[1];
            if (engine_select.getValue() === 'remote') {
                engineLabelTooltiped.classList.remove('hidden');
                engineLabelUntooltiped.classList.add('hidden');
            } else {
                engineLabelTooltiped.classList.add('hidden');
                engineLabelUntooltiped.classList.remove('hidden');
            }
        })
    }

    // Humanize move mix: five independent slider+number pairs. No auto-rescaling -- the user
    // balances them by hand, and the Total row shows the sum plus what's off: "90 (-10)" means
    // add 10 somewhere, "110 (+10)" means remove 10. (The popup normalizes by the sum when
    // picking, so an off-100 mix still behaves proportionally in the meantime.) NOT FormElements:
    // one logical setting spans two inputs per row. Values persist per-key via MephistoConfig
    // (chrome.storage.local); the panel reads them fresh on every pick, so edits apply to the very
    // next move.
    // Panel Style: 'floating' (in-page overlay) or 'popup' (toolbar bubble = no page footprint).
    // Read straight off chrome.storage.local rather than through MephistoConfig: the background
    // service worker flips the toolbar popup on/off (chrome.action.setPopup) off the same key, and
    // writing it here fires chrome.storage.onChanged in the worker.
    // Hotkeys: one rebindable key per action, stored together in config.hotkeys (a single JSON key,
    // so settings export/import carries them). DEFAULTS + labels must match content-script.js's
    // HOTKEY_DEFAULTS. Clicking a key captures the next keydown (Esc cancels, Backspace/Delete clears).
    initHotkeys() {
        const container = document.getElementById('hotkey_rows');
        const resetBtn = document.getElementById('hotkey_reset_btn');
        if (!container || !resetBtn) return; // stale cached page html
        const DEFAULTS = MephistoConfig.HOTKEY_DEFAULTS; // shared source (config-store.js)
        const LABELS = {
            manual_play: 'Play move (Manual Mode)', autoplay: 'Toggle Autoplay', premove: 'Toggle Premove',
            help_mode: 'Toggle Help Mode', humanize: 'Toggle Humanize', clock_mode: 'Toggle Clock Mode',
            mirror_mode: 'Toggle Mirror Time', manual_mode: 'Toggle Manual Mode', eval_bar: 'Toggle Eval Bar',
            eval_history: 'Toggle Eval History', tablebase: 'Toggle Endgame Tablebase',
            puzzle_mode: 'Toggle Puzzle Mode', explorer: 'Toggle Opening Explorer',
            book_play: 'Toggle Book Moves', copy_fen: 'Copy FEN', copy_pgn: 'Copy PGN', redetect: 'Re-detect game',
        };
        const ORDER = ['manual_play', 'manual_mode', 'autoplay', 'premove', 'explorer', 'book_play',
            'help_mode', 'humanize', 'clock_mode', 'mirror_mode', 'eval_bar', 'eval_history', 'tablebase', 'puzzle_mode',
            'copy_fen', 'copy_pgn', 'redetect'];
        // same normalization as the content-script listener, so what we store matches what it compares
        const keyString = (e) => {
            const parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
            return parts.join('+');
        };
        const pretty = (k) => !k ? '—' : k.split('+').map(p => p === ' ' ? 'Space' : (p.length === 1 ? p.toUpperCase() : p)).join(' + ');
        const load = () => { try { return {...DEFAULTS, ...(JSON.parse(MephistoConfig.get('hotkeys')) || {})}; } catch (e) { return {...DEFAULTS}; } };
        const save = (obj) => MephistoConfig.set('hotkeys', JSON.stringify(obj));
        let bindings = load();
        let capturing = null; // the action currently being rebound

        const render = () => {
            container.innerHTML = '';
            for (const action of ORDER) {
                const row = document.createElement('div');
                row.className = 'section';
                row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin:4px 0;';
                const label = document.createElement('span');
                label.textContent = LABELS[action];
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'waves-effect waves-light btn-small';
                btn.textContent = (capturing === action) ? 'press a key…' : pretty(bindings[action]);
                btn.style.minWidth = '120px';
                btn.addEventListener('click', () => { capturing = (capturing === action) ? null : action; render(); });
                row.append(label, btn);
                container.appendChild(row);
            }
        };
        // one document-level capture listener; only acts while rebinding
        document.addEventListener('keydown', (e) => {
            if (!capturing) return;
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') { capturing = null; return render(); }
            if (e.key === 'Backspace' || e.key === 'Delete') { bindings[capturing] = ''; save(bindings); capturing = null; return render(); }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for the real key
            bindings[capturing] = keyString(e);
            save(bindings);
            capturing = null;
            render();
        }, true);
        resetBtn.addEventListener('click', () => { MephistoConfig.remove('hotkeys'); bindings = {...DEFAULTS}; capturing = null; render(); });
        render();
    }

    initUiMode() {
        const sel = document.getElementById('ui_mode_select');
        if (!sel) return; // stale cached page html
        chrome.storage.local.get('ui_mode', ({ui_mode}) => { sel.value = ui_mode || 'floating'; });
        sel.addEventListener('change', () => chrome.storage.local.set({ui_mode: sel.value}));
    }

    initHumanizeMix() {
        const MIX = [
            ['humanize_top', 50], ['humanize_second', 40], ['humanize_third', 4],
            ['humanize_fourth', 0], ['humanize_inaccuracy', 0],
            ['humanize_mistake', 5], ['humanize_blunder', 1],
        ];
        const rows = MIX.map(([key, dflt]) => ({
            key, dflt,
            range: document.getElementById(`${key}_mixrange`),
            num: document.getElementById(`${key}_mixnum`),
        }));
        const total = document.getElementById('humanize_mix_total');
        if (!rows.every(r => r.range && r.num) || !total) return; // stale cached page html
        const paint = (el) => // dark-mode slider fill (options.js paints only on user input)
            el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
        const load = (key, dflt) => {
            try {
                const v = JSON.parse(MephistoConfig.get(key));
                return (v != null && isFinite(+v)) ? +v : dflt;
            } catch (e) {
                return dflt;
            }
        };

        const updateTotal = () => {
            const sum = rows.reduce((a, r) => a + (+r.range.value), 0);
            const diff = sum - 100;
            total.textContent = (diff === 0) ? '100 ✓' : `${sum} (${diff > 0 ? '+' : ''}${diff})`;
            total.classList.toggle('ok', diff === 0);
            total.classList.toggle('off', diff !== 0);
        };

        const set = (row, val, persist = true) => {
            val = Math.min(100, Math.max(0, Math.round(+val) || 0));
            row.range.value = val;
            row.num.value = val;
            paint(row.range);
            if (persist) MephistoConfig.set(row.key, val);
            updateTotal();
        };

        rows.forEach(r => {
            set(r, load(r.key, r.dflt), false); // initial sync, don't churn storage on page open
            r.range.addEventListener('input', () => set(r, r.range.value));
            r.num.addEventListener('change', () => set(r, r.num.value));
        });
    }

    // Per-category centipawn thresholds, each with a live accuracy/win-drop readout. The two formulas
    // are Lichess's own, so "what does this cp cost" reads the same as a Lichess game review:
    //   winPercent(cp)  -- lila WinPercent.scala, the PR #11148 regression (NOT SF's own formula)
    //   accuracy        -- lila AccuracyPercent.scala, from the before/after win%
    // The readout takes an equal position as the reference (win% 50 before the move), the standard way
    // these are illustrated: a 110cp loss is a 10% win-drop = Inaccuracy, 230cp = 20% = Mistake,
    // 377cp = 30% = Blunder -- which is where the defaults sit.
    initHumanizeThresholds() {
        const CP = [
            ['humanize_cp_second', 40], ['humanize_cp_third', 75], ['humanize_cp_fourth', 110],
            ['humanize_cp_inaccuracy', 230], ['humanize_cp_mistake', 377], ['humanize_cp_blunder', 600],
        ];
        const rows = CP.map(([key, dflt]) => ({
            key, dflt,
            range: document.getElementById(`${key}_range`),
            num: document.getElementById(`${key}_num`),
            readout: document.getElementById(`${key}_readout`),
        }));
        if (!rows.every(r => r.range && r.num && r.readout)) return; // stale cached page html

        const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
        const readoutText = (loss) => {
            const after = winPct(-loss);           // our win% after a move that loses `loss` cp from equal
            const drop = 50 - after;
            const acc = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669 + 1));
            return `≈ ${Math.round(acc)}% accuracy · ${Math.round(drop)}% win drop`;
        };
        const paint = (el) =>
            el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
        const load = (key, dflt) => {
            try { const v = JSON.parse(MephistoConfig.get(key)); return (v != null && isFinite(+v)) ? +v : dflt; }
            catch (e) { return dflt; }
        };
        const set = (row, val, persist = true) => {
            val = Math.min(800, Math.max(0, Math.round(+val / 5) * 5 || 0)); // snap to the 5cp step
            row.range.value = val;
            row.num.value = val;
            row.readout.textContent = readoutText(val);
            paint(row.range);
            if (persist) MephistoConfig.set(row.key, val);
        };
        rows.forEach(r => {
            set(r, load(r.key, r.dflt), false);
            r.range.addEventListener('input', () => set(r, r.range.value));
            r.num.addEventListener('change', () => set(r, r.num.value));
        });
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
