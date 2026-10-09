// Fork layer check. Part of the fork layer, not an upstream file. See FORK.md, "Layering rules".
//
// Lists every file that differs between two commits and fails if any of them is an upstream file
// that is not a registered hook point in fork/layer.json.
//
//   node fork/check-layer.mjs                      # audit: our net changes vs upstream (merge-base of HEAD and upstream)
//   node fork/check-layer.mjs --base A --head B    # scope: only the files changed between A and B (e.g. a repair diff)
//   node fork/check-layer.mjs --upstream origin/main
//
// Exit code 0 = clean, 1 = violations, 2 = usage or git error.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const layer = JSON.parse(readFileSync(join(here, 'layer.json'), 'utf8'));

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function refExists(ref) {
    try {
        git('rev-parse', '--verify', '--quiet', ref + '^{commit}');
        return true;
    } catch {
        return false;
    }
}

function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') {
                // "**/" matches zero or more whole directories
                re += '(?:.*/)?';
                i++;
            } else {
                re += '.*';
            }
        } else if (c === '*') {
            re += '[^/]*';
        } else {
            re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$');
}

const args = process.argv.slice(2);
function arg(name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}

const head = arg('--head') ?? 'HEAD';
let base = arg('--base');
if (!base) {
    const upstream = arg('--upstream') ?? ['upstream/main', 'origin/main'].find(refExists);
    if (!upstream || !refExists(upstream)) {
        console.error('check-layer: no upstream ref found; pass --upstream <ref> or --base <ref>');
        process.exit(2);
    }
    base = git('merge-base', head, upstream);
    console.log(`check-layer: auditing ${head} against upstream ${upstream} (merge-base ${base.slice(0, 9)})`);
} else {
    console.log(`check-layer: checking files changed between ${base} and ${head}`);
}

const ours = layer.ourPaths.map(globToRegExp);
const hookFiles = new Map();
for (const hook of layer.hookPoints) {
    if (!hookFiles.has(hook.file)) {
        hookFiles.set(hook.file, []);
    }
    hookFiles.get(hook.file).push(hook.name);
}

const changed = git('diff', '--name-only', '--no-renames', base, head).split('\n').filter(Boolean);
const violations = [];
const touchedHooks = [];
for (const file of changed) {
    if (ours.some((re) => re.test(file))) {
        continue;
    }
    if (hookFiles.has(file)) {
        touchedHooks.push(file);
        continue;
    }
    violations.push(file);
}

const missingMarkers = [];
for (const file of touchedHooks) {
    let text = '';
    try {
        text = git('show', `${head}:${file}`);
    } catch {
        text = '';
    }
    for (const name of hookFiles.get(file)) {
        if (!text.includes(`FORK-HOOK(${name})`)) {
            missingMarkers.push(`${file}: no FORK-HOOK(${name}) marker`);
        }
    }
}

console.log(`check-layer: ${changed.length} changed file(s), ${touchedHooks.length} registered hook file(s) touched`);
if (!arg('--base')) {
    for (const file of hookFiles.keys()) {
        if (!touchedHooks.includes(file)) {
            console.log(`warning: ${file} is registered as a hook point but no longer differs from upstream; remove the registration`);
        }
    }
}
if (violations.length > 0) {
    console.log('\nUpstream files changed outside the registry (add a hook point to fork/layer.json and FORK.md, or move the code into our layer):');
    for (const file of violations) {
        console.log('  ' + file);
    }
}
if (missingMarkers.length > 0) {
    console.log('\nRegistered hook files without their marker comment:');
    for (const line of missingMarkers) {
        console.log('  ' + line);
    }
}
process.exit(violations.length + missingMarkers.length > 0 ? 1 : 0);
