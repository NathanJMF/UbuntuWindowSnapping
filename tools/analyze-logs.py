#!/usr/bin/env python3
"""Summarize the extension's debug logs for comparing versions.

Usage:
  journalctl -b _COMM=gnome-shell -o short-unix --since "..." \\
      --grep 'keyboard-monitor-snap@local: (FRAME|TRACE)' > snaps.log
  python3 -I tools/analyze-logs.py snaps.log

Reports per app: snaps, motion length, when the handover started (fraction
of the motion), fade length, how often the app redrew after the handover,
learned follow-up delays, maximize-cover times, gaps between animation
frames, and (when logged) the frame handler's cost.
"""
import collections
import json
import re
import statistics
import sys

LINE = re.compile(r'(TRACE|FRAME) (\{.*\})\s*$')


def percentile(values, p):
    values = sorted(values)
    return values[min(len(values)-1, int(p*len(values)))] if values else None


def fmt(values, unit=''):
    if not values:
        return '-'
    return f'median {statistics.median(values):.1f}{unit}, p90 {percentile(values, 0.9):.1f}{unit}, max {max(values):.1f}{unit}'


def load(path):
    snaps, covers, follow = [], [], collections.defaultdict(list)
    current = None
    for line in open(path):
        match = LINE.search(line)
        if not match:
            continue
        stamp = float(line.split()[0])
        data = json.loads(match.group(2))
        if match.group(1) == 'TRACE':
            phase = data.get('phase')
            if phase == 'animate':
                current = {'app': data['app'], 'duration': data.get('duration'), 'from': data['from'],
                           'to': data['to'], 'frames': []}
                snaps.append(current)
            elif phase == 'state-cover':
                covers.append(data)
            elif phase == 'follow-up':
                follow[(data['app'], data['id'])].append(data['learned'])
        elif current is not None and 'curve' in data:
            current['frames'].append((stamp, data))
    return snaps, covers, follow


def main(path):
    snaps, covers, follow = load(path)
    by_app = collections.defaultdict(list)
    for snap in snaps:
        if len(snap['frames']) > 3:
            by_app[snap['app']].append(snap)
    for app, group in sorted(by_app.items()):
        handover, fades, gaps, costs, after = [], [], [], [], 0
        for snap in group:
            frames = [d for _, d in snap['frames']]
            stamps = [t for t, _ in snap['frames']]
            gaps += [(stamps[i]-stamps[i-1])*1000 for i in range(1, len(stamps))]
            costs += [d['cost'] for d in frames if 'cost' in d]
            start = next((i for i, d in enumerate(frames) if d.get('fadeFrom') is not None), None)
            if start is None:
                continue
            handover.append(frames[start]['fadeFrom']/snap['duration'])
            fades.append(frames[start].get('fadeMs', 0))
            if any(frames[i]['sinceDamage'] < frames[i-1]['sinceDamage'] for i in range(start+1, len(frames))):
                after += 1
        print(f'{app}: {len(group)} snaps, motion {fmt([s["duration"] for s in group], " ms")}')
        print(f'  handover at {fmt([100*h for h in handover], "%")} of the motion; fade {fmt(fades, " ms")}')
        print(f'  app redrew after the handover in {after} of {len(handover)} snaps')
        print(f'  frame gaps {fmt(gaps, " ms")}')
        if costs:
            print(f'  frame handler cost {fmt(costs, " us")}')
    for (app, window), values in sorted(follow.items()):
        print(f'follow-up learned for {app} window {window}: last {values[-1]} ms over {len(values)} samples')
    if covers:
        times = [c['ms'] for c in covers]
        settled = sum(1 for c in covers if c.get('settled'))
        print(f'maximize covers: {len(covers)}, settled {settled}, held {fmt(times, " ms")}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1])
