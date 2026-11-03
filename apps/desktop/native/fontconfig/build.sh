#!/bin/bash
set -euo pipefail
source_root="$1"
cd "$2"
build_root="$PWD"
prefix="$build_root/prefix"
mkdir -p "$prefix"
export CFLAGS="-O2"
export CXXFLAGS="-O2"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
patch -d freetype-2.13.0 -p1 < "$source_root/patches/external_freetype_freetype-2.6.5.patch.1"
patch -d freetype-2.13.0 -p0 < "$source_root/patches/external_freetype_ubsan.patch"
patch -d freetype-2.13.0 -p0 < "$source_root/patches/external_freetype_freetype-fd-hack.patch.0"
patch -d fontconfig-2.14.2 -p1 < "$source_root/patches/external_fontconfig_fontconfig-2.12.1.patch.1"
patch -d fontconfig-2.14.2 -p0 < "$source_root/patches/external_fontconfig_ubsan.patch"
patch -d fontconfig-2.14.2 -p0 < "$source_root/patches/external_fontconfig_libfontconfig-bundled-soname.patch.0"
cd freetype-2.13.0
emconfigure ./configure --prefix="$prefix" --host=wasm32-unknown-emscripten --disable-shared --with-pic --with-zlib --without-brotli --without-bzip2 --without-harfbuzz --without-png ZLIB_CFLAGS=-sUSE_ZLIB=1 ZLIB_LIBS=-sUSE_ZLIB=1
# This helper executes on the build host, not in the WASM target.
cc src/tools/apinames.c -o objs/apinames
emmake make -j6
emmake make install
cd "$build_root/libxml2-2.12.10"
emconfigure ./configure --prefix="$prefix" --sysconfdir=/etc --host=wasm32-unknown-emscripten --disable-shared --disable-ipv6 --without-python --without-zlib --with-sax1 --without-lzma --without-iconv --without-icu
emmake make -j6 libxml2.la
emmake make install-libLTLIBRARIES install-pkgconfigDATA
emmake make -C include install
cd "$build_root"
cp libxml2-2.12.10/config.sub fontconfig-2.14.2/config.sub
cp libxml2-2.12.10/config.guess fontconfig-2.14.2/config.guess
# Darwin archive padding is not a WASM section. Use GNU archives of raw objects.
emar --format=gnu rcs prefix/lib/libfreetype-wasm.a freetype-2.13.0/objs/*.o
emar --format=gnu rcs prefix/lib/libxml2-wasm.a libxml2-2.12.10/libxml2_la-*.o
mkdir fontconfig-build
cd fontconfig-build
emconfigure ../fontconfig-2.14.2/configure --prefix="$prefix" --host=wasm32-unknown-emscripten --disable-shared --disable-docs --with-pic --enable-libxml2 --with-baseconfigdir=/instdir/share/fontconfig --with-templatedir=/instdir/share/fontconfig/conf.avail --with-cache-dir=/instdir/share/fontconfig/cache --with-add-fonts=/instdir/share/fonts ac_cv_func_fstatfs=no ac_cv_func_fstatvfs=no ac_cv_func_link=no FREETYPE_CFLAGS="-I$prefix/include/freetype2" FREETYPE_LIBS="$prefix/lib/libfreetype-wasm.a -sUSE_ZLIB=1" LIBXML2_CFLAGS="-I$prefix/include/libxml2" LIBXML2_LIBS="$prefix/lib/libxml2-wasm.a"
emmake make -j6 -C src
objects=()
for object in src/fc*.o src/ftglue.o; do
  if [ "$object" != src/fcarch.o ]; then objects+=("$object"); fi
done
emar --format=gnu rcs ../fontconfig.a "${objects[@]}"
emcc "$source_root/generator.c" -I../fontconfig-2.14.2 -I"$prefix/include/freetype2" ../fontconfig.a "$prefix/lib/libfreetype-wasm.a" "$prefix/lib/libxml2-wasm.a" -sUSE_ZLIB=1 -O2 --no-entry -sMODULARIZE=1 -sEXPORT_NAME=OfficeFontCache -sEXPORTED_FUNCTIONS='["_generate"]' -sEXPORTED_RUNTIME_METHODS='["FS"]' -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -o ../fontcache.js
# Browser assets are data, not host executables.
chmod 644 ../fontcache.js ../fontcache.wasm
