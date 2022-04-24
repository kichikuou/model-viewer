export interface LibModule extends EmscriptenModule {
    _qnt_extract(ptr: number): number;
    _decompress(ptr: number, size: number, raw_size: number): number;
}

declare const createModule: EmscriptenModuleFactory<LibModule>;
export default createModule;
