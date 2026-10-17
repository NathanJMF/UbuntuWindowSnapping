// Debug logging, controlled by the debug-logging setting (off by default).
// Placement stages are logged as TRACE lines, animation frames as FRAME
// lines; tools/analyze-logs.py reads both.
import {rect} from './geometry.js';

export class Debug {
    // settings: this extension's settings. state(window): the window's
    // tracked keyboard state, for context in traces.
    constructor(settings, uuid, state) {
        this._uuid = uuid;
        this._state = state;
        // Read on every animation frame: cached, refreshed when it changes.
        // Connect before reading: GSettings only promises 'changed' for keys
        // read while a handler is connected.
        this._settings = settings;
        settings.connectObject('changed::debug-logging', () => {
            this.enabled = settings.get_boolean('debug-logging');
        }, this);
        this.enabled = settings.get_boolean('debug-logging');
    }

    dispose() {
        this._settings.disconnectObject(this);
    }

    trace(window, phase, extra = {}) {
        if (!this.enabled)
            return;
        try {
            const state = this._state(window);
            const maybeRect = r => r ? rect(r) : null;
            console.log(`${this._uuid}: TRACE ${JSON.stringify({
                phase, app: window.get_wm_class(), id: window.get_id(),
                monitor: window.get_monitor(), priorMonitor: state?.monitor,
                priorLayout: state?.layout, nativeMaxH: window.maximizedHorizontally,
                nativeMaxV: window.maximizedVertically, canMove: window.allows_move(),
                canResize: window.allows_resize(), isTiled: window.isTiled,
                tiledRect: maybeRect(window.tiledRect), frame: maybeRect(window.get_frame_rect()), ...extra,
            })}`);
        } catch (error) {
            // A window can close before a delayed diagnostic sample.
            console.log(`${this._uuid}: TRACE sample unavailable: ${error.message}`);
        }
    }

    frame(fields) {
        console.log(`${this._uuid}: FRAME ${JSON.stringify(fields)}`);
    }
}
