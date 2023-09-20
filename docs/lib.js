export default async function createModule() {
    const fetched = fetch(new URL('./lib.wasm', import.meta.url));
    const imports = { env: { emscripten_notify_memory_growth: () => { } } };
    const { instance } = await WebAssembly.instantiateStreaming(fetched, imports);
    return {
        malloc: instance.exports.malloc,
        free: instance.exports.free,
        qnt_extract: instance.exports.qnt_extract,
        decompress: instance.exports.decompress,
        memset: (dst, src) => {
            new Uint8Array(instance.exports.memory.buffer).set(src, dst);
        },
        memget: (ptr, len) => {
            return new Uint8Array(instance.exports.memory.buffer).slice(ptr, ptr + len);
        },
    };
}
