export interface LibModule {
    malloc(size: number): number;
    free(ptr: number): void;
    qnt_extract(ptr: number): number;
    decompress(ptr: number, size: number, raw_size: number): number;
    memset: (dst: number, src: Uint8Array) => void;
    memget: (ptr: number, len: number) => Uint8Array;
}

export default async function createModule(): Promise<LibModule> {
    const fetched = fetch(new URL('./lib.wasm', import.meta.url));
    const imports = { env: { emscripten_notify_memory_growth: () => {} } };
    const { instance } = await WebAssembly.instantiateStreaming(fetched, imports);
    return {
        malloc: instance.exports.malloc as any,
        free: instance.exports.free as any,
        qnt_extract: instance.exports.qnt_extract as any,
        decompress: instance.exports.decompress as any,
        memset: (dst: number, src: Uint8Array) => {
            new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).set(src, dst);
        },
        memget: (ptr: number, len: number) => {
            return new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).slice(ptr, ptr + len);
        },
    }
}
