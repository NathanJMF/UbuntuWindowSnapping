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

SUITES = ['tests/rules.test.js', 'tests/adapter.test.js', 'tests/placement.test.js', 'tests/lifecycle.test.js']
# Mutations known to survive, with the reason they are not a test gap.
EXPECTED_SURVIVORS = {
    'hold detach clears stopHold': 'defensive: the stale-hold path no longer arises with reveal timing',
}

# (behaviour, file, original snippet, mutated snippet)
MUTATIONS = [
    ('backdrop fills uncovered corners', 'extension.js',
     "            backdrop = effects.backdrop();\n", ""),
    ('content attached to top-left when both edges move', 'extension.js',
     "        const anchor = {x: fixed.x === 0.5 ? 0 : fixed.x, y: fixed.y === 0.5 ? 0 : fixed.y};",
     "        const anchor = fixed;"),
    ('each direction eases separately', 'extension.js',
     "        const easeY = growY ? easeInOutCubic : easeOutCubic;",
     "        const easeY = growing ? easeInOutCubic : easeOutCubic;"),
    ('shrinking snapshot is cropped, not squished', 'extension.js',
     "                    fit(cover, Math.max(natural.width, curve.width), Math.max(natural.height, curve.height));",
     "                    fit(cover, curve.width, curve.height);"),
    ('shrinking live window is unscaled', 'extension.js',
     "                    this._showRevealed(window, actor, curve, anchor);\n                } else {",
     "                    this._showAt(window, actor, curve, anchor);\n                } else {"),
    ('learned follow-up delays the handover', 'extension.js',
     "                const ready = sized && (follows",
     "                const ready = sized && (false"),
    ('handover waits for quiet content', 'extension.js',
     "                    : now-lastDamage >= QUIET_MS*1000);",
     "                    : true);"),
    ('re-aim at the drawn granted size', 'extension.js',
     "                        reaim(elapsed, g, 'drawn');",
     "                        ;"),
    ('fade ends before landing', 'extension.js',
     "                    fadeMs = Math.max(MIN_FADE_MS, Math.min(FADE_MS, FADE_END*duration-elapsed));",
     "                    fadeMs = FADE_MS;"),
    ('hold detach clears stopHold', 'extension.js',
     "            if (visual.stopHold === detach)",
     "            if (false)"),
    ('crossings repaint every frame', 'extension.js',
     "        operation.crossing = window.get_monitor() !== monitor;",
     "        operation.crossing = false;"),
    ('snapshot starts where it was seen', 'extension.js',
     "                visual.rect ??= {...at};",
     "                visual.rect ??= {...rect};"),
    ('maximize is covered', 'placement.js',
     "        effects?.coverState?.();\n", ""),
    ('every placement takes a snapshot', 'placement.js',
     "    effects?.cover(start);", ""),
    ('removed monitors are never addressed', 'placement.js',
     "        if (monitorExists && !monitorExists(monitor))",
     "        if (false)"),
    ('stopped hold timeline is stopped', 'extension.js',
     "            window.disconnectObject?.(hold);\n            hold.stop();",
     "            window.disconnectObject?.(hold);"),
    ('closing during the hold cleans up at once', 'extension.js',
     "        window.connectObject?.('unmanaging', gone, hold);", ""),
    ('cancelled cover restores opacity', 'extension.js',
     "                    if (hidden)\n                        actor.opacity = 255;", ""),
    ('cancelled snap releases its effects', 'extension.js',
     "        operation.cancelEffects = () => effects.release();", ""),
    ('skips disarmed on release', 'extension.js',
     "                Main.wm._skippedActors?.delete(actor);\n            pending = 0;",
     "            pending = 0;"),
    ('second native change re-arms the skip', 'extension.js',
     "                    if (pending > 0)\n                        Main.wm.skipNextEffect(actor);", ""),
    ('monitors-changed cancels placements', 'extension.js',
     "        Main.layoutManager.connectObject('monitors-changed', () => this._monitorsChanged(), this);", ""),
    ('bindings saved before any change', 'extension.js',
     "        this._settings.set_string('saved-bindings', JSON.stringify(saved));\n        changes.forEach(change => change());",
     "        changes.forEach(change => change());\n        throw new Error('partial');"),
    ('restore continues past a failing key', 'extension.js',
     "            } catch (error) {\n                console.warn(`${this.uuid}: cannot restore",
     "            } catch (error) {\n                throw error;\n                console.warn(`${this.uuid}: cannot restore"),
    ('maximize cover honours its time limit', 'extension.js',
     "                if (watch.expired)\n                    watch.finish(false);",
     "                if (false)\n                    watch.finish(false);"),
    ('follow-up estimate is a percentile', 'extension.js',
     "        this._followUp.set(window, sorted[Math.min(sorted.length-1,\n            Math.floor(FOLLOW_PERCENTILE*sorted.length))]);",
     "        this._followUp.set(window, sorted[sorted.length-1]);"),
    ('maximize redraw is not a follow-up', 'extension.js',
     "                this._learnerByWindow.get(window)?.();\n", ""),
    ('follow-up windows fall back at 75%', 'extension.js',
     "            const readyLimit = follows ? FOLLOW_READY_LIMIT : READY_LIMIT;",
     "            const readyLimit = READY_LIMIT;"),
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
