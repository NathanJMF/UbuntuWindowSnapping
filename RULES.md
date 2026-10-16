# Keyboard window snapping rules

Behaviour specification.

## Scope

Only Super (Windows key) + the four arrow keys change. Mouse dragging, edge snapping, mouse resizing, and cursor snapping remain under Ubuntu Tiling Assistant. Its app-selection popup remains disabled. Super+Shift+Arrow keeps Ubuntu's existing monitor-movement behaviour.

“Full screen” in these rules means maximized within the monitor's usable work area, keeping the top bar and bottom dock visible. It does not mean immersive fullscreen (F11).

## First arrow press

A fresh sequence starts when the window has no tracked keyboard position, after manually moving/resizing a window, or after crossing a monitor boundary.

| Keys | Result |
| --- | --- |
| Super+Up | Top half |
| Super+Down | Bottom half |
| Super+Left | Left half |
| Super+Right | Right half |

Each window has its own sequence. Switching focus to another window does not erase the first window's position. No shortcut in this extension minimizes a window.

## Quarter snapping

Perpendicular directions combine, in either order:

| Two arrows, with Super held for each | Result |
| --- | --- |
| Up then Left, or Left then Up | Top-left quarter |
| Up then Right, or Right then Up | Top-right quarter |
| Down then Left, or Left then Down | Bottom-left quarter |
| Down then Right, or Right then Down | Bottom-right quarter |

An opposite direction replaces that axis and retains the other one. Examples: Left half then Right becomes Right half; Top-left quarter then Right becomes Top-right quarter; Top-left then Down becomes Bottom-left.

## Repeated direction and monitor movement

A window must occupy the full half along the requested edge before it can cross monitors. From a quarter, pressing toward an occupied edge first removes the perpendicular split: bottom-right + Right becomes right half; bottom-right + Down becomes bottom half. This expansion happens whether or not there is a neighboring monitor. Only the next press from that half looks for a physically adjacent monitor in that direction. GNOME's monitor layout determines adjacency; no numbered-monitor assumption is made.

If a monitor is present, move the window there and maximize it. Do not arrive as a half or quarter. Clear the keyboard position so the next arrow chooses a fresh half on the destination.

Examples:

- Left, Left: left half, then maximize on the monitor to the left.
- Right, Right: right half, then maximize on the monitor to the right.
- Down, Down: bottom half, then maximize on the monitor below.
- Up, Up: top half, then maximize on the monitor above.
- Up, Left, Left, Left: top half, top-left quarter, left half, then maximize on the monitor to the left.
- Left, Down, Down, Down: left half, bottom-left quarter, bottom half, then maximize on the monitor below.
- Left, Left, Down: left half, maximize on the left monitor, then bottom half there.

Quarters always expand to a half first; only halves cross. Crossing never wraps from an outermost monitor to the other end of the layout.

## No monitor in that direction

| Repeated direction | Result at outer boundary |
| --- | --- |
| Left | Keep current left half (a left quarter first expands to left half) |
| Right | Keep current right half (a right quarter first expands to right half) |
| Down | Keep current bottom half (a bottom quarter first expands to bottom half); never minimize |
| Up | From top half, maximize on the current monitor (a top quarter first expands to top half) |

Thus Up twice maximizes locally if there is no monitor above. If a monitor is above, it maximizes there instead.

## Practical behaviour

- Use the monitor work area so bars/docks are respected, including different monitor resolutions and negative desktop coordinates.
- Application minimum sizes can prevent an exact half or quarter.
- A held key does not rapidly cycle screens; release and press again for another step.
- An already mouse-snapped window starts a fresh keyboard sequence. Its first arrow selects a half rather than inferring a prior keyboard history.
- The original experimental `windows-monitor-snap@local` patch must remain disabled.

## Animation preference

Desktop window animations and Tiling Assistant tile/untile animations are disabled. Snapping changes position immediately. This does not change the mouse snapping target regions.
