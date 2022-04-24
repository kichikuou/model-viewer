EXPORTS = -s EXPORTED_FUNCTIONS="['_malloc', '_free']"

../docs/lib.js: qnt.c Makefile
	emcc -Oz -s MODULARIZE=1 -s EXPORT_ES6=1 -o $@ qnt.c -s USE_ZLIB=1 $(EXPORTS)
