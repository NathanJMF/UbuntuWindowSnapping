#!/usr/bin/env python3
"""Mutation sweep: each entry breaks one guarded behaviour; a test must fail.

Run from the repository root:  python3 -I tests/mutations.py
Source files are always restored, even if a run crashes or hangs.
Update the snippets when code moves; never delete an entry without
replacing the guard it represents.
"""
import os
import subprocess
import sys

SUITES = ['tests/rules.test.js', 'tests/units.test.js', 'tests/adapter.test.js', 'tests/placement.test.js',
          'tests/lifecycle.test.js']
# Mutations known to survive, with the reason they are not a test gap.
EXPECTED_SURVIVORS = {
    'hold detach clears stopHold': 'defensive: the stale-hold path no longer arises with reveal timing',
}

# (behaviour, file, original snippet, mutated snippet)
MUTATIONS = [
    # The animation (reveal.js) and its layout and timing modules
    ('backdrop fills uncovered corners', 'reveal.js',
     "        backdrop = effects.backdrop();\n", ""),
    ('content attached to top-left when both edges move', 'layers.js',
     "    return {x: fixed.x === 0.5 ? 0 : fixed.x, y: fixed.y === 0.5 ? 0 : fixed.y};",
     "    return fixed;"),
    ('each direction eases separately', 'geometry.js',
     "        this.easeY = this.growY ? easeInOutCubic : easeOutCubic;",
     "        this.easeY = this.growX || this.growY ? easeInOutCubic : easeOutCubic;"),
    ('shrinking snapshot is cropped, not squished', 'reveal.js',
     "            placeWidget(cover, snapshotLayout(outline, natural, anchor, true));",
     "            placeWidget(cover, snapshotLayout(outline, outline, anchor, true));"),
    ('shrinking live window is unscaled', 'reveal.js',
     "        : visuals.showRevealed(window, actor, outline, anchor, drawn);",
     "        : visuals.showAt(window, actor, outline, anchor);"),
    ('re-aim at the drawn granted size', 'reveal.js',
     "                if (g && sameSize(drawn, g) && !sameSize(g, path.end)) {",
     "                if (false) {"),
    ('learned follow-up delays the handover', 'handover.js',
     "        this.ready = sized && (this.follows",
     "        this.ready = sized && (false"),
    ('handover waits for quiet content', 'handover.js',
     "            : now-lastDamage >= QUIET_MS*1000);",
     "            : true);"),
    ('fade ends before landing', 'handover.js',
     "            this.fadeMs = Math.max(MIN_FADE_MS, Math.min(FADE_MS, FADE_END*this.duration-elapsed));",
     "            this.fadeMs = FADE_MS;"),
    ('follow-up windows fall back at 75%', 'handover.js',
     "        this.readyLimit = this.follows ? FOLLOW_READY_LIMIT : READY_LIMIT;",
     "        this.readyLimit = READY_LIMIT;"),
    ('follow-up estimate is a percentile', 'follow-up.js',
     "    return sorted[Math.min(sorted.length-1, Math.floor(FOLLOW_PERCENTILE*sorted.length))];",
     "    return sorted[sorted.length-1];"),
    # The hold (visuals.js)
    ('hold detach clears stopHold', 'visuals.js',
     "            if (visual.stopHold === detach)\n                visual.stopHold = null;\n        };\n        visual.stopHold = detach;\n        const end",
     "            if (false)\n                visual.stopHold = null;\n        };\n        visual.stopHold = detach;\n        const end"),
    ('closing during the hold cleans up at once', 'visuals.js',
     "        scope.connect(window, 'unmanaging', gone);\n", ""),
    # Snapshots and native effects (effects.js)
    ('snapshot starts where it was seen', 'effects.js',
     "            visual.rect ??= {...at};",
     "            visual.rect ??= {...frame};"),
    ('cancelled cover restores opacity', 'effects.js',
     "                if (hidden)\n                    actor.opacity = 255;", ""),
    ('skips disarmed on release', 'effects.js',
     "            Main.wm._skippedActors?.delete(actor);\n        pending = 0;",
     "        pending = 0;"),
    ('second native change re-arms the skip', 'effects.js',
     "                if (pending > 0)\n                    Main.wm.skipNextEffect(actor);", ""),
    ('maximize cover honours its time limit', 'effects.js',
     "            if (watch.expired)\n                watch.finish(false);",
     "            if (false)\n                watch.finish(false);"),
    ('maximize redraw is not a follow-up', 'effects.js',
     "            followUps.interrupt(window);\n", ""),
    # Placement stages (placement.js)
    ('maximize is covered', 'placement.js',
     "        effects?.coverState?.();\n", ""),
    ('every placement takes a snapshot', 'placement.js',
     "    effects?.cover(start);", ""),
    ('removed monitors are never addressed', 'placement.js',
     "        if (monitorExists && !monitorExists(monitor))",
     "        if (false)"),
    # Lifetimes (scope.js)
    ('stopped hold timeline is stopped', 'scope.js',
     "        this.add(() => timeline.stop());",
     "        this.add(() => {});"),
    ('scopes release newest first', 'scope.js',
     "        const release = this._release.reverse();",
     "        const release = this._release;"),
    ('cancel hooks run newest first', 'scope.js',
     "        const hooks = [...this._hooks].reverse();",
     "        const hooks = [...this._hooks];"),
    ('registering on a disposed scope releases at once', 'scope.js',
     "        if (this.disposed)\n            release();\n        else\n            this._release.push(release);",
     "        this._release.push(release);"),
    ('a new motion stops the running hold', 'reveal.js',
     "    visuals.get(window)?.stopHold?.();\n    actor.remove_all_transitions();",
     "    actor.remove_all_transitions();"),
    ('growing snapshot finishes its fade after the motion', 'reveal.js',
     "                effects.dropCover(growing ? handover.remaining(elapsed) : 0);",
     "                effects.dropCover(0);"),
    ('final crossing repaint', 'reveal.js',
     "            scope.dispose();\n            repaint(true);",
     "            scope.dispose();"),
    ('re-aim restarts the size wait', 'reveal.js',
     "                    handover.resetSized();\n", ""),
    ('granted frame must sit on the requested edges', 'reveal.js',
     "        aligned('x', 'width') && aligned('y', 'height') ? g : null;",
     "        true ? g : null;"),
    ('closing the window cancels the animation', 'reveal.js',
     "        scope.connect(window, 'unmanaging', () => snap.cancel());\n", ""),
    ('a finished animation leaves the snap\'s cancel hooks', 'reveal.js',
     "            finished = true;\n            unregister();\n            const elapsed",
     "            finished = true;\n            const elapsed"),
    ('an already-cancelled animation starts nothing', 'reveal.js',
     "        if (finished)\n            return;\n        scope.connect(timeline",
     "        scope.connect(timeline"),
    ('zoom is even, never squished', 'visuals.js',
     "{...outline, height: frame.height*scale}", "outline"),
    ('zoom asks for the height that fills the slot', 'visuals.js',
     "            window.move_resize_frame(true, slot.x, slot.y, zoom.width, zoom.height);\n", "            ;\n"),
    ('a lagging app keeps the size already asked of it', 'reveal.js',
     "visuals.zoom(window, actor, slot, to);", "visuals.zoom(window, actor, slot);"),
    ('zoom follows the app\'s drawn size', 'visuals.js',
     "        scope.connect(actor, 'notify::width', show, 'notify::height', show);\n", ""),
    ('the zoomed motion lands evenly scaled', 'reveal.js',
     "        ? visuals.showZoomed(window, actor, outline)\n", "        ? visuals.showRevealed(window, actor, outline, anchor, drawn)\n"),
    ('a zoomed motion is not re-aimed', 'reveal.js',
     "            if (!slot && !handover.started", "            if (!handover.started"),
    ('snapshots are taken without the transform', 'effects.js',
     "        Object.assign(actor, {scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});\n", ""),
    ('the transform comes back after a snapshot', 'effects.js',
     "        } finally {\n            Object.assign(actor, {scale_x, scale_y, translation_x, translation_y});\n        }\n", "        }\n"),
    ('zoom ends on close', 'visuals.js',
     "        scope.connect(window, 'unmanaging', () => this.reset(window, false, actor));\n", ""),
    ('zoom ends on an outside maximize', 'visuals.js',
     "if (window.maximizedHorizontally || window.maximizedVertically || window.fullscreen) {", "if (false) {"),
    ('zoomed windows stay tracked', 'extension.js',
     "(this._visuals.get(window)?.zoomed || sameFrame(window.get_frame_rect(), state.frame))",
     "sameFrame(window.get_frame_rect(), state.frame)"),
    ('X11 windows are never zoomed', 'extension.js',
     "        return window.get_client_type() !== Meta.WindowClientType.X11;", "        return true;"),
    ('a known minimum goes straight into the zoom', 'extension.js',
     "            operation.slot = zoomed ? target : null;\n            const applied = await this._place(window, zoomed ?? target, monitor, operation);",
     "            operation.slot = null;\n            const applied = await this._place(window, target, monitor, operation);"),
    ('a zoomed window is tiled at its slot', 'extension.js',
     "new Rect(operation.slot ?? target)", "new Rect(target)"),
    ('shadow is taken off a known minimum', 'extension.js',
     "zoomFor({width: width-buffer.width+frame.width,\n            height: height-buffer.height+frame.height}, slot)", "zoomFor({width, height}, slot)"),
    ('too small to use: not zoomed', 'geometry.js',
     "    if (scale < MIN_ZOOM)\n        return null;\n", ""),
    ('hold ends when the actor is destroyed', 'visuals.js',
     "        scope.connect(actor, 'destroy', gone);\n", ""),
    # The extension (extension.js) and shortcuts (bindings.js)
    ('a grab with no window is ignored', 'extension.js',
     "            if (!window)\n                return;\n            this._queued.delete(window);",
     "            this._queued.delete(window);"),
    ('disable removes pending timers', 'extension.js',
     "        for (const source of this._timers)\n            GLib.Source.remove(source);\n", ""),
    ('follow-up observers stop after placements are cancelled', 'extension.js',
     "        this._cancelOperations();\n        this._followUps.stopAll();",
     "        this._followUps.stopAll();\n        this._cancelOperations();"),
    ('a finished wait leaves the snap\'s cancel hooks', 'extension.js',
     "                    GLib.Source.remove(source);\n                unregister();",
     "                    GLib.Source.remove(source);"),
    ('a rejected window relaxes smoothly', 'extension.js',
     "            this._debug.trace(window, 'rejected-capability', {directions});\n            this._visuals.reset(window, true);",
     "            this._debug.trace(window, 'rejected-capability', {directions});\n            this._visuals.reset(window, false);"),
    ('crossings repaint every frame', 'extension.js',
     "        const crossing = window.get_monitor() !== monitor;",
     "        const crossing = false;"),
    ('cancelled snap releases its effects', 'extension.js',
     "        operation.onCancel(() => effects.release());", ""),
    ('monitors-changed cancels placements', 'extension.js',
     "        Main.layoutManager.connectObject('monitors-changed', () => this._monitorsChanged(), this);", ""),
    ('desktop and other non-application windows are ignored', 'extension.js',
     "        if (!this._dependencyReady() || !window || !this._snappable(window))",
     "        if (!this._dependencyReady() || !window)"),
    ('debug flag follows the setting', 'trace.js',
     "            this.enabled = settings.get_boolean('debug-logging');\n        }, this);",
     "        }, this);"),
    ('bindings saved before any change', 'bindings.js',
     "        this._settings.set_string('saved-bindings', JSON.stringify(saved));\n        changes.forEach(change => change());",
     "        changes.forEach(change => change());\n        throw new Error('partial');"),
    ('restore continues past a failing key', 'bindings.js',
     "            } catch (error) {\n                console.warn(`${this._uuid}: cannot restore",
     "            } catch (error) {\n                throw error;\n                console.warn(`${this._uuid}: cannot restore"),
]


def run_suites():
    """Return (all passed, first failure message)."""
    for suite in SUITES:
        try:
            result = subprocess.run(['gjs', '-m', suite], capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            return False, f'{suite}: HUNG'
        output = result.stdout + result.stderr
        if 'PASS:' not in output:
            message = next((line.split('Error: ', 1)[1] for line in output.splitlines()
                            if 'JS ERROR' in line and 'Error: ' in line), 'failed')
            return False, f'{os.path.basename(suite)}: {message[:110]}'
    return True, ''


def main():
    files = {name: open(name).read() for name in {m[1] for m in MUTATIONS}}
    ok, message = run_suites()
    if not ok:
        print(f'Unmutated code fails: {message}')
        return 2
    missed = []
    try:
        for behaviour, name, old, new in MUTATIONS:
            source = files[name]
            if source.count(old) != 1:
                print(f'STALE   {behaviour}: snippet not found once in {name}')
                missed.append(behaviour)
                continue
            with open(name, 'w') as f:
                f.write(source.replace(old, new, 1))
            caught, message = run_suites()
            caught = not caught
            with open(name, 'w') as f:
                f.write(source)
            if caught:
                print(f'CAUGHT  {behaviour} -> {message}')
            elif behaviour in EXPECTED_SURVIVORS:
                print(f'SURVIVE {behaviour} (expected: {EXPECTED_SURVIVORS[behaviour]})')
            else:
                print(f'MISSED  {behaviour}')
                missed.append(behaviour)
            sys.stdout.flush()
    finally:
        for name, source in files.items():
            with open(name, 'w') as f:
                f.write(source)
    print(f'{len(MUTATIONS)-len(missed)}/{len(MUTATIONS)} guarded'
          + (f'; MISSED: {", ".join(missed)}' if missed else ''))
    return 1 if missed else 0


if __name__ == '__main__':
    sys.exit(main())
