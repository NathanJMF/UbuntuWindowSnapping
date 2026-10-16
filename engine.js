// Pure keyboard rules. No GNOME objects or mouse handlers belong here.
export const FULL = Object.freeze({x: null, y: null});
export function step(layout, direction, hasNeighbor) {
    if (!['left', 'right', 'up', 'down'].includes(direction))
        throw new Error(`Unknown direction: ${direction}`);
    const next = {...(layout ?? FULL)};
    const axis = ['left', 'right'].includes(direction) ? 'x' : 'y';
    if (next[axis] === direction) {
        // A quarter must expand to the requested full side before crossing.
        // This step applies even when no neighboring monitor exists.
        const perpendicular = axis === 'x' ? 'y' : 'x';
        if (next[perpendicular] !== null) {
            next[perpendicular] = null;
            return {layout: next, cross: null};
        }
        if (hasNeighbor)
            return {layout: {...FULL}, cross: direction};
        if (direction === 'up')
            return {layout: {...FULL}, cross: null};
        return {layout: next, cross: null};
    }
    next[axis] = direction;
    return {layout: next, cross: null};
}
export function rectangle(layout, area) {
    const xHalf = Math.floor(area.width / 2);
    const yHalf = Math.floor(area.height / 2);
    return {
        x: area.x + (layout.x === 'right' ? xHalf : 0),
        y: area.y + (layout.y === 'down' ? yHalf : 0),
        width: layout.x ? (layout.x === 'right' ? area.width - xHalf : xHalf) : area.width,
        height: layout.y ? (layout.y === 'down' ? area.height - yHalf : yHalf) : area.height,
    };
}
