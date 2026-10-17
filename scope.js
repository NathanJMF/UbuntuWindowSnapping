// Lifetime helpers. A Scope owns signal connections, timelines and timers
// and releases all of them exactly once, newest first. A Snap is one
// keyboard placement: everything it starts registers a cancel hook, and
// cancelling runs them newest first.

export class Scope {
    constructor() {
        this._release = [];
        this.disposed = false;
    }

    // Register a release function; it runs at once if already disposed.
    add(release) {
        if (this.disposed)
            release();
        else
            this._release.push(release);
        return release;
    }

    // object.connectObject(signal, handler, ...) tracked by this scope.
    connect(object, ...signalsAndHandlers) {
        object.connectObject(...signalsAndHandlers, this);
        this.add(() => object.disconnectObject(this));
    }

    // A timeline stopped (and its handlers dropped) on dispose. Clutter's
    // stop() emits 'stopped', not 'completed'.
    timeline(timeline, ...signalsAndHandlers) {
        this.add(() => timeline.stop());
        if (signalsAndHandlers.length)
            this.connect(timeline, ...signalsAndHandlers);
        return timeline;
    }

    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const release = this._release.reverse();
        this._release = [];
        for (const fn of release)
            fn();
    }
}

export class Snap {
    // owner: the dependency's keybinding handler when the snap began.
    constructor(owner) {
        this.owner = owner;
        this.cancelled = false;
        this.superseded = false;
        this._hooks = new Set();
    }

    // Run `hook` if the snap is cancelled while registered (at once if it
    // already is). Returns a function that unregisters it.
    onCancel(hook) {
        if (this.cancelled) {
            hook();
            return () => {};
        }
        this._hooks.add(hook);
        return () => this._hooks.delete(hook);
    }

    cancel() {
        if (this.cancelled)
            return;
        this.cancelled = true;
        const hooks = [...this._hooks].reverse();
        this._hooks.clear();
        for (const hook of hooks)
            hook();
    }

    // A newer key press takes over.
    supersede() {
        if (this.cancelled)
            return;
        this.superseded = true;
        this.cancel();
    }
}
