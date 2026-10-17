// Taking Super+Arrow from GNOME and Tiling Assistant, and giving it back.
import Gio from 'gi://Gio';

// The bindings this extension takes, per schema and key.
const OWNED = {
    'org.gnome.shell.extensions.tiling-assistant': {
        'tile-left-half': '<Super>Left', 'tile-right-half': '<Super>Right',
        'tile-maximize': '<Super>Up', 'tile-top-half': '<Super>Up',
        'tile-bottom-half': '<Super>Down', 'restore-window': '<Super>Down',
    },
    'org.gnome.desktop.wm.keybindings': {
        maximize: '<Super>Up', unmaximize: '<Super>Down', minimize: '<Super>Down',
    },
    'org.gnome.mutter.keybindings': {
        'toggle-tiled-left': '<Super>Left', 'toggle-tiled-right': '<Super>Right',
    },
};

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class Bindings {
    // settings: this extension's settings ('saved-bindings' keeps each key's
    // value from before it was taken).
    constructor(settings, uuid) {
        this._settings = settings;
        this._uuid = uuid;
    }

    _schemaSettings(schema) {
        try {
            return new Gio.Settings({schema_id: schema});
        } catch (error) {
            console.warn(`${this._uuid}: ${error.message}`);
            return null;
        }
    }

    // All originals are stored before any key is changed, so a failure part
    // way through can always be undone. Missing schemas or keys (e.g. after a
    // Tiling Assistant update) are skipped.
    take() {
        let saved = this._settings.get_string('saved-bindings');
        saved = saved ? JSON.parse(saved) : {};
        const changes = [];
        for (const [schema, keys] of Object.entries(OWNED)) {
            const settings = this._schemaSettings(schema);
            if (!settings)
                continue;
            for (const [key, binding] of Object.entries(keys)) {
                let values;
                try {
                    values = settings.get_strv(key);
                } catch (error) {
                    console.warn(`${this._uuid}: ${schema} ${key} unavailable: ${error.message}`);
                    continue;
                }
                saved[schema] ??= {};
                saved[schema][key] ??= values;
                changes.push(() => settings.set_strv(key, values.filter(v => v !== binding)));
            }
        }
        this._settings.set_string('saved-bindings', JSON.stringify(saved));
        changes.forEach(change => change());
    }

    // Entries that cannot be restored now (schema or key missing) stay saved
    // for a later restore; everything else is restored.
    restore() {
        const raw = this._settings.get_string('saved-bindings');
        if (!raw)
            return;
        const remaining = {};
        for (const [schema, keys] of Object.entries(JSON.parse(raw))) {
            const failed = this._restoreSchema(schema, keys);
            if (Object.keys(failed).length)
                remaining[schema] = failed;
        }
        this._settings.set_string('saved-bindings',
            Object.keys(remaining).length ? JSON.stringify(remaining) : '');
    }

    // Put back only keys still holding the value we wrote; a key the user
    // changed meanwhile is theirs. A saved value equal to the default is
    // reset rather than written, so it keeps following the system default.
    // Returns the entries that could not be restored.
    _restoreSchema(schema, keys) {
        const settings = this._schemaSettings(schema);
        if (!settings)
            return keys;
        const failed = {};
        for (const [key, values] of Object.entries(keys)) {
            try {
                const binding = OWNED[schema]?.[key];
                const ours = binding ? values.filter(v => v !== binding) : values;
                if (!same(settings.get_strv(key), ours))
                    continue;
                const fallback = settings.get_default_value(key)?.deepUnpack();
                if (Array.isArray(fallback) && same(fallback, values))
                    settings.reset(key);
                else
                    settings.set_strv(key, values);
            } catch (error) {
                console.warn(`${this._uuid}: cannot restore ${schema} ${key}: ${error.message}`);
                failed[key] = values;
            }
        }
        return failed;
    }
}
