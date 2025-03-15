export type Diff<T> = {
    push?: T;
    pull?: T;
};
type DiffMap<T> = {
    [K in keyof T]: T[K] extends object ? Partial<DiffMap<T[K]>> : Diff<T[K]>;
};
export declare function diffObjects<T extends Record<string, any>>(obj1: T, obj2: T): Partial<DiffMap<T>>;
export declare function colorizeDiff(diff: any, indent?: number): string;
export {};
