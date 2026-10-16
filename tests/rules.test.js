import {FULL, step, rectangle} from '../engine.js';
let count = 0;
function equal(actual, expected, name) {
    count++;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function sequence(keys, neighbor = () => false) {
    let state = {...FULL};
    const results = [];
    for (const key of keys) {
        const result = step(state, key, neighbor(key));
        state = result.layout;
        results.push(result);
    }
    return results;
}
for (const d of ['left', 'right', 'up', 'down']) {
    const expected = {x: null, y: null};
    expected[['left','right'].includes(d) ? 'x' : 'y'] = d;
    equal(sequence([d])[0], {layout: expected, cross: null}, `${d} starts at half`);
    equal(sequence([d,d], () => true)[1], {layout: {...FULL}, cross: d}, `${d} crossing arrives full`);
    equal(sequence([d,d])[1].layout, d === 'up' ? {...FULL} : expected, `${d} outer boundary`);
}
for (const x of ['left','right']) {
    for (const y of ['up','down']) {
        const quarter = {x,y};
        equal(sequence([x,y])[1].layout, quarter, `${x},${y} quarter`);
        equal(sequence([y,x])[1].layout, quarter, `${y},${x} quarter`);
        for (const d of [x,y]) {
            const half = {x: null, y: null};
            half[['left','right'].includes(d) ? 'x' : 'y'] = d;
            equal(step(quarter,d,true), {layout: half, cross:null}, `quarter ${x}/${y} expands before ${d} crossing`);
            equal(step(quarter,d,false), {layout: half, cross:null}, `quarter ${x}/${y} expands at ${d} boundary`);
            equal(step(half,d,true), {layout: {...FULL}, cross:d}, `expanded half then crosses ${d}`);
            equal(step(half,d,false).layout, d === 'up' ? {...FULL} : half, `expanded half ${d} boundary`);
        }
    }
}
const crossing = sequence(['left','left','down'], d => d === 'left');
equal(crossing[2].layout, {x:null,y:'down'}, 'new monitor starts a fresh half sequence');
equal(sequence(['left','right'])[1].layout, {...FULL}, 'left half then Right restores full');
equal(sequence(['up','down'])[1].layout, {...FULL}, 'top half then Down restores full');
for (const [first,opposite] of [['left','right'],['right','left'],['up','down'],['down','up']]) {
    for (const neighbors of [false,true]) {
        const results=sequence([first,opposite,opposite],()=>neighbors);
        const half={x:null,y:null};half[['left','right'].includes(opposite)?'x':'y']=opposite;
        equal(results[1],{layout:{...FULL},cross:null},`${first} -> ${opposite} first goes full, neighbor=${neighbors}`);
        equal(results[2],{layout:half,cross:null},`${first} -> ${opposite} -> ${opposite} then half, neighbor=${neighbors}`);
    }
}
equal(sequence(['up','left','right'])[2].layout,{x:null,y:'up'},'opposite horizontal arrow from quarter first takes top half');
for (const x of ['left','right']) {
    for (const y of ['up','down']) {
        for (const occupied of [x,y]) {
            const opposite={left:'right',right:'left',up:'down',down:'up'}[occupied];
            const axis=['left','right'].includes(occupied)?'x':'y';
            for (const neighbors of [false,true]) {
                const quarter={x,y};
                const half={...quarter};half[axis]=null;
                const destination={...quarter};destination[axis]=opposite;
                const first=step(quarter,opposite,neighbors);
                equal(first,{layout:half,cross:null},`${x}/${y} -> ${opposite} removes only reversed split, neighbor=${neighbors}`);
                equal(step(first.layout,opposite,neighbors),{layout:destination,cross:null},`${x}/${y} -> ${opposite} twice reaches opposite quarter, neighbor=${neighbors}`);
            }
        }
    }
}

for (const d of ['left','right','up','down']) {
    equal(step(FULL,d,false),step(FULL,d,true),`${d} cannot cross on first press`);
}
const a = {x:-1920,y:24,width:1919,height:1055};
const l=rectangle({x:'left',y:null},a), r=rectangle({x:'right',y:null},a);
equal(l.width+r.width,a.width,'odd screen halves cover every pixel');
equal(l.x+l.width,r.x,'halves meet without gaps');
equal(r.x+r.width,a.x+a.width,'negative-coordinate right edge');
equal(rectangle(FULL,a),a,'full layout respects panel work area');
let bottom={x:null,y:'down'};
for(let i=0;i<20;i++) bottom=step(bottom,'down',false).layout;
equal(bottom,{x:null,y:'down'},'repeated down never minimizes');
print(`PASS: ${count} keyboard rule assertions`);
