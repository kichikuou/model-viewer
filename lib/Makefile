EMFLAGS = -s STANDALONE_WASM --no-entry -s USE_ZLIB=1 -s ALLOW_MEMORY_GROWTH=1
EXPORTS = -s EXPORTED_FUNCTIONS="['_malloc', '_free']"

../docs/lib.wasm: qnt.c Makefile
	emcc -O3 -DNDEBUG $(EMFLAGS) -o $@ qnt.c $(EXPORTS)
