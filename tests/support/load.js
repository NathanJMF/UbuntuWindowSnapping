// Load the real extension modules with their GNOME imports pointed at the
// mocks in tests/support/gnome.js. Every module in the extension directory is
// copied to a temporary folder with its imports rewritten; local imports
// ('./x.js') keep working between the copies. An import from GNOME that the
// mocks do not provide fails loudly instead of loading a real library.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const here = Gio.File.new_for_uri(import.meta.url);
const root = here.get_parent().get_parent().get_parent();
const support = here.get_parent().get_child('gnome.js').get_uri();

// Module specifier -> name of the mock export that stands in for it.
const MOCKED = {
    'gi://Clutter': 'Clutter', 'gi://Gio': 'Gio', 'gi://GLib': 'GLib', 'gi://Meta': 'Meta',
    'gi://Shell': 'Shell', 'gi://St': 'St',
    'resource:///org/gnome/shell/ui/main.js': 'Main',
    'resource:///org/gnome/shell/extensions/extension.js': null,
    'file:///usr/share/gnome-shell/extensions/tiling-assistant@ubuntu.com/src/extension/tilingWindowManager.js': null,
    'file:///usr/share/gnome-shell/extensions/tiling-assistant@ubuntu.com/src/extension/utility.js': null,
};

function rewrite(source, file) {
    return source.replace(/^import ([^;]*?) from '([^']+)';$/gms, (line, clause, specifier) => {
        if (specifier.startsWith('./') || specifier.startsWith('../'))
            return line;
        if (!(specifier in MOCKED))
            throw new Error(`${file}: no mock for import '${specifier}'`);
        const name = MOCKED[specifier];
        if (clause.startsWith('{'))
            return `import ${clause} from '${support}';`;
        const local = clause.replace(/^\* as /, '').trim();
        return `import {${name} as ${local}} from '${support}';`;
    });
}

// Returns the extension module's namespace (default export: the extension).
export async function loadExtension() {
    const folder = GLib.dir_make_tmp('keyboard-snap-tests-XXXXXX');
    const copied = [];
    const children = root.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = children.next_file(null))) {
        const name = info.get_name();
        if (!name.endsWith('.js'))
            continue;
        const source = new TextDecoder().decode(root.get_child(name).load_contents(null)[1]);
        GLib.file_set_contents(`${folder}/${name}`, rewrite(source, name));
        copied.push(`${folder}/${name}`);
    }
    try {
        return await import(Gio.File.new_for_path(`${folder}/extension.js`).get_uri());
    } finally {
        // Imported modules stay in memory; the copies are no longer needed.
        for (const path of copied)
            GLib.unlink(path);
        GLib.rmdir(folder);
    }
}
