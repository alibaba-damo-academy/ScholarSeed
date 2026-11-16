declare function fingerprint(filename: string): string
declare const fingerprints: { fingerprint: typeof fingerprint }
export = fingerprints
