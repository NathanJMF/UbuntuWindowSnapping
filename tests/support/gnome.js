// Mock GNOME Shell world shared by the test suites. Extension modules are
// loaded through tests/support/load.js, which points their GNOME imports
// (gi://, resource:///, Tiling Assistant) at the exports below.
//
// Behaviour worth knowing when writing tests:
// - Timelines advance only when a test ticks them (see tickTimelines);
//   stop() emits 'stopped', not 'completed', as Clutter does.
// - Signal connections are tracked per object (`_h`), so leaks show.
// - GNOME Shell's own size-change handler is installed first and consumes
//   effect skips, counting native versus skipped effects.
// - St widgets record their moves, clips (as on-screen outlines), opacity
//   and destruction.

export const mock = {
    // Simulated monotonic clock (microseconds). autoClock advances it on
    // every read, for suites that do not step time themselves.
    clock: 0, autoClock: 0,
    animations: true, slowDown: 1,
    booleans: {},
    values: new Map(), defaults: new Map(), resets: [], missingKeys: new Set(), missingSchemas: new Set(),
    timers: new Map(), timelines: [], widgets: [], redraws: 0,
    nativeEffects: 0, skippedEffects: 0,
    focus: null, neighbor: -1, monitors: 2, grab: null, bindings: new Map(),
    dependencyEnabled: true, handler: {},
    lateSizeChange: false, later: [], pending: [],
};

export function signals(object) {
    object._h = [];
    object.connectObject = function (...args) {
        const tracker = args.pop();
        for (let i = 0; i+1 < args.length; i += 2)
            this._h.push({sig: args[i], fn: args[i+1], tracker});
    };
    object.disconnectObject = function (tracker) {
        this._h = this._h.filter(h => h.tracker !== tracker);
    };
    object.connect = function (sig, fn) {
        const id = Symbol(sig);
        this._h.push({sig, fn, tracker: id});
        return id;
    };
    object.disconnect = function (id) {
        this._h = this._h.filter(h => h.tracker !== id);
    };
    object.emit = function (sig, ...args) {
        for (const h of [...this._h]) {
            if (h.sig === sig)
                h.fn(this, ...args);
        }
    };
    return object;
}

class Settings {
    constructor({schema_id: schemaId} = {}) {
        if (mock.missingSchemas.has(schemaId))
            throw new Error(`GSettings schema ${schemaId} not found`);
        this.schema = schemaId ?? 'custom';
    }
    get_strv(key) {
        if (mock.missingKeys.has(`${this.schema}:${key}`))
            throw new Error(`GSettings key ${key} not found`);
        return mock.values.get(`${this.schema}:${key}`) ?? mock.defaults.get(`${this.schema}:${key}`) ?? [];
    }
    set_strv(key, value) {
        mock.values.set(`${this.schema}:${key}`, value);
    }
    get_default_value(key) {
        const value = mock.defaults.get(`${this.schema}:${key}`);
        return value ? {deepUnpack: () => [...value]} : null;
    }
    reset(key) {
        mock.values.delete(`${this.schema}:${key}`);
        mock.resets.push(`${this.schema}:${key}`);
    }
    get_boolean(key) {
        return mock.booleans[key] ?? false;
    }
    get_string(key) {
        return mock.values.get(`${this.schema}:${key}`) ?? '';
    }
    set_string(key, value) {
        mock.values.set(`${this.schema}:${key}`, value);
    }
    connectObject() {}
    disconnectObject() {}
}

export const Gio = {Settings};

export const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
    get_monotonic_time() {
        mock.clock += mock.autoClock;
        return mock.clock;
    },
    timeout_add(_priority, _ms, callback) {
        const id = mock.timers.size+100;
        mock.timers.set(id, callback);
        return id;
    },
    Source: {remove: id => mock.timers.delete(id)},
};

export class Extension {
    constructor() {
        this.uuid = 'keyboard-monitor-snap@local';
    }
    getSettings() {
        return new Settings();
    }
}

export const Meta = {
    WindowClientType: {WAYLAND: 0, X11: 1},
    WindowType: {NORMAL: 0, DESKTOP: 1, DOCK: 2},
    DisplayDirection: {LEFT: 0, RIGHT: 1, UP: 2, DOWN: 3},
    KeyBindingFlags: {IGNORE_AUTOREPEAT: 1},
    MaximizeFlags: {BOTH: 3},
    WindowConstraint: {NONE: 0, MONITOR: 1, WINDOW: 2},
};

export const Shell = {ActionMode: {NORMAL: 1}};

export const St = {
    Settings: {get: () => ({enable_animations: mock.animations, slow_down_factor: mock.slowDown})},
    // Snapshot widgets record where they were drawn and whether they are gone.
    Widget: class {
        constructor({content} = {}) {
            this.content = content;
            this.opacity = 255;
            this.destroyed = false;
            this.moves = [];
            mock.widgets.push(this);
        }
        set_position(x, y) {
            this.x = x;
            this.y = y;
        }
        set_size(width, height) {
            this.width = width;
            this.height = height;
            this.moves.push({x: this.x, y: this.y, width, height});
        }
        set_clip(x, y, width, height) {
            this.clip = {x, y, width, height};
            // The outline on screen: the clip in stage coordinates.
            (this.outline ??= []).push({x: this.x+x, y: this.y+y, width, height});
        }
        ease(params) {
            if ('opacity' in params)
                this.opacity = params.opacity;
            params.onStopped?.();
        }
        destroy() {
            this.destroyed = true;
            this.opacityAtDestroy = this.opacity;
        }
    },
};

class Timeline {
    constructor({duration}) {
        signals(this);
        this.duration = duration;
        this.elapsed = 0;
        mock.timelines.push(this);
    }
    get_elapsed_time() {
        return this.elapsed;
    }
    start() {
        this.running = true;
    }
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.emit('stopped');
    }
    tick(ms) {
        if (!this.running || this.stopped)
            return;
        this.elapsed = Math.min(this.duration, this.elapsed+ms);
        this.emit('new-frame');
        if (this.elapsed >= this.duration && !this.stopped) {
            this.stopped = true;
            this.emit('completed');
        }
    }
}

// Advance every running timeline by `ms` and forget the stopped ones.
export function tickTimelines(ms) {
    for (const timeline of [...mock.timelines])
        timeline.tick(ms);
    mock.timelines = mock.timelines.filter(t => !t.stopped);
}

export const Clutter = {Timeline, AnimationMode: {EASE_OUT_QUAD: 2}};

export class Rect {
    constructor(r) {
        Object.assign(this, r);
    }
    equal(r) {
        return ['x', 'y', 'width', 'height'].every(k => this[k] === r[k]);
    }
}

export const TilingWindowManager = {
    clearTilingProps() {},
    updateTileGroup() {},
    saveTileState() {},
    isMaximized: w => w.maximizedHorizontally && w.maximizedVertically,
};

export const Main = {
    layoutManager: signals({}),
    extensionManager: {
        lookup: () => ({
            get stateObj() {
                return mock.dependencyEnabled
                    ? {_twm: TilingWindowManager, _keybindingHandler: mock.handler, settings: {getGioObject: () => ({})}}
                    : {};
            },
        }),
    },
    wm: {
        _skippedActors: new Set(),
        skipNextEffect(actor) {
            this._skippedActors.add(actor);
        },
        addKeybinding: (key, _settings, _flags, _modes, callback) => mock.bindings.set(key, callback),
        removeKeybinding: key => mock.bindings.delete(key),
    },
};
mock.skipped = Main.wm._skippedActors;

globalThis.global = {
    window_manager: signals({}),
    window_group: {
        queue_redraw() {
            mock.redraws++;
        },
        add_child() {},
        set_child_above_sibling(actor) {
            actor.below = false;
        },
        set_child_below_sibling(actor) {
            actor.below = true;
        },
    },
    display: {
        get focus_window() {
            return mock.focus;
        },
        get_monitor_neighbor_index: () => mock.neighbor,
        get_n_monitors: () => mock.monitors,
        connect: (_name, callback) => {
            mock.grab = callback;
            return 1;
        },
        disconnect: () => {
            mock.grab = null;
        },
    },
};

// GNOME Shell's own handler is connected first and consumes skips.
global.window_manager.connect('size-change', (_wm, actor) => {
    if (Main.wm._skippedActors.delete(actor))
        mock.skippedEffects++;
    else
        mock.nativeEffects++;
});
