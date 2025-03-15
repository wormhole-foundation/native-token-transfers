import chalk from "chalk";

export type Diff<T> = {
    push?: T;
    pull?: T;
};


// type that maps over the keys of an object (recursively), mapping each leaf type to Diff<T>
type DiffMap<T> = {
    [K in keyof T]: T[K] extends object ? Partial<DiffMap<T[K]>> : Diff<T[K]>
}

function isObject(obj: any): obj is Record<string, any> {
    return obj && typeof obj === 'object' && !Array.isArray(obj);
}

export function diffObjects<T extends Record<string, any>>(obj1: T, obj2: T): Partial<DiffMap<T>> {
    const result: Partial<DiffMap<T>> = {};

    for (const key in obj1) {
        if (obj1.hasOwnProperty(key)) {
            if (obj2.hasOwnProperty(key)) {
                if (isObject(obj1[key]) && isObject(obj2[key])) {
                    result[key] = diffObjects(obj1[key], obj2[key]);
                } else if (obj1[key] === obj2[key]) {
                    // result[key] = obj1[key] as any;
                } else {
                    result[key] = { pull: obj2[key] , push: obj1[key]} as any;
                }
            } else {
                result[key] = { push: obj1[key] } as any;
            }
        }
    }

    for (const key in obj2) {
        if (obj2.hasOwnProperty(key) && !obj1.hasOwnProperty(key)) {
            result[key] = { pull: obj2[key] } as any;
        }
    }

    // prune empty objects
    for (const key in result) {
        if (isObject(result[key])) {
            if (Object.keys(result[key]).length === 0) {
                delete result[key];
            }
        }
    }

    return result;
}

export function colorizeDiff(diff: any, indent = 2): string {
    if (!isObject(diff)) return JSON.stringify(diff, null, indent);

    const jsonString = JSON.stringify(diff, null, indent);
    let result = '';
    const lines = jsonString.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('"') && trimmedLine.endsWith(': {')) {
            const key = trimmedLine.slice(1, trimmedLine.indexOf('": {'));
            if (isObject(diff[key]) && ('push' in diff[key] || 'pull' in diff[key])) {
                const push = diff[key].push;
                const pull = diff[key].pull;
                if (push !== undefined && pull !== undefined) {
                    result += `${line}\n`;
                } else if (push !== undefined) {
                    result += line.replace(trimmedLine, chalk.red(trimmedLine)) + '\n';
                } else if (pull !== undefined) {
                    result += line.replace(trimmedLine, chalk.green(trimmedLine)) + '\n';
                }
            } else {
                result += line + '\n';
            }
        } else if (trimmedLine.startsWith('"push"') || trimmedLine.startsWith('"pull"')) {
            const color = trimmedLine.startsWith('"push"') ? chalk.green : chalk.red;
            result += line.replace(trimmedLine, color(trimmedLine)) + '\n';
        } else {
            result += line + '\n';
        }
    }

    return result;
}
