// Installed font file discovery only. File access and Office policy belong to main.
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define COBJMACROS
#include <windows.h>
#include <initguid.h>
#include <dwrite.h>
#else
#include <CoreFoundation/CoreFoundation.h>
#include <CoreText/CoreText.h>
#endif

struct face {
  char *path;
  char *name;
  unsigned char *name_table;
  size_t name_table_size;
  uint32_t index;
  bool has_index;
};
struct catalog {
  napi_async_work work;
  napi_deferred deferred;
  struct face *faces;
  size_t count;
  const char *error;
};

static void release_face(struct face *face) {
  free(face->path); free(face->name); free(face->name_table);
}

static bool seen_name(const struct catalog *catalog, const char *name) {
  for (size_t i = 0; i < catalog->count; ++i) {
    if (!strcmp(catalog->faces[i].name, name)) return true;
  }
  return false;
}

static void append(struct catalog *catalog, struct face face) {
  if (!face.path || !face.name || !*face.path || !*face.name) {
    release_face(&face);
    catalog->error = "Installed font has no local file or PostScript name";
    return;
  }
  struct face *faces = realloc(catalog->faces, (catalog->count + 1) * sizeof(*faces));
  if (!faces) { release_face(&face); catalog->error = "Font catalog allocation failed"; return; }
  catalog->faces = faces;
  faces[catalog->count++] = face;
}

#ifdef _WIN32
static char *utf8(const WCHAR *value) {
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, NULL, 0, NULL, NULL);
  if (!size) return NULL;
  char *result = malloc((size_t)size);
  if (result && !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result, size, NULL, NULL)) {
    free(result); return NULL;
  }
  return result;
}

static char *localized_name(IDWriteLocalizedStrings *strings, struct catalog *catalog) {
  if (!strings || !IDWriteLocalizedStrings_GetCount(strings)) return NULL;
  BOOL exists = FALSE;
  UINT32 index = 0, length = 0;
  if (FAILED(IDWriteLocalizedStrings_FindLocaleName(strings, L"en-us", &index, &exists))) {
    catalog->error = "DirectWrite font locale unavailable"; return NULL;
  }
  if (!exists) index = 0;
  char *result = NULL;
  if (SUCCEEDED(IDWriteLocalizedStrings_GetStringLength(strings, index, &length))) {
    WCHAR *value = calloc((size_t)length + 1, sizeof(WCHAR));
    if (value && SUCCEEDED(IDWriteLocalizedStrings_GetString(strings, index, value, length + 1))) result = utf8(value);
    free(value);
  }
  if (!result) catalog->error = "DirectWrite font name unavailable";
  return result;
}

static char *information_name(IDWriteFont *font, DWRITE_INFORMATIONAL_STRING_ID id, struct catalog *catalog) {
  IDWriteLocalizedStrings *strings = NULL;
  BOOL exists = FALSE;
  HRESULT status = IDWriteFont_GetInformationalStrings(font, id, &strings, &exists);
  char *result = NULL;
  if (FAILED(status)) catalog->error = "DirectWrite font information unavailable";
  else if (exists) result = localized_name(strings, catalog);
  if (strings) IDWriteLocalizedStrings_Release(strings);
  return result;
}

static char *family_name(IDWriteFontFamily *family, struct catalog *catalog) {
  IDWriteLocalizedStrings *strings = NULL;
  if (FAILED(IDWriteFontFamily_GetFamilyNames(family, &strings))) {
    if (strings) IDWriteLocalizedStrings_Release(strings);
    catalog->error = "DirectWrite font family name unavailable"; return NULL;
  }
  char *result = localized_name(strings, catalog);
  if (strings) IDWriteLocalizedStrings_Release(strings);
  return result;
}

static char *copy_name(const char *name, struct catalog *catalog) {
  char *result = malloc(strlen(name) + 1);
  if (result) strcpy(result, name);
  else catalog->error = "Font catalog allocation failed";
  return result;
}

static char *font_path(IDWriteFontFile *file) {
  const void *key = NULL;
  UINT32 key_size = 0, length = 0;
  IDWriteFontFileLoader *loader = NULL;
  IDWriteLocalFontFileLoader *local = NULL;
  char *result = NULL;
  if (FAILED(IDWriteFontFile_GetReferenceKey(file, &key, &key_size)) ||
      FAILED(IDWriteFontFile_GetLoader(file, &loader))) goto done;
  if (FAILED(IDWriteFontFileLoader_QueryInterface(loader, &IID_IDWriteLocalFontFileLoader, (void **)&local))) goto done;
  if (FAILED(IDWriteLocalFontFileLoader_GetFilePathLengthFromKey(local, key, key_size, &length))) goto done;
  WCHAR *value = calloc((size_t)length + 1, sizeof(WCHAR));
  if (value && SUCCEEDED(IDWriteLocalFontFileLoader_GetFilePathFromKey(local, key, key_size, value, length + 1))) result = utf8(value);
  free(value);
done:
  if (local) IDWriteLocalFontFileLoader_Release(local);
  if (loader) IDWriteFontFileLoader_Release(loader);
  return result;
}

static void enumerate(struct catalog *catalog) {
  IDWriteFactory *factory = NULL;
  IDWriteFontCollection *collection = NULL;
  if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, &IID_IDWriteFactory, (IUnknown **)&factory)) ||
      FAILED(IDWriteFactory_GetSystemFontCollection(factory, &collection, TRUE))) {
    catalog->error = "DirectWrite system font collection unavailable"; goto done;
  }
  UINT32 families = IDWriteFontCollection_GetFontFamilyCount(collection);
  for (UINT32 i = 0; i < families && !catalog->error; ++i) {
    IDWriteFontFamily *family = NULL;
    if (FAILED(IDWriteFontCollection_GetFontFamily(collection, i, &family))) {
      catalog->error = "DirectWrite font family unavailable"; break;
    }
    char *family_text = family_name(family, catalog);
    if (!family_text) { IDWriteFontFamily_Release(family); continue; }
    free(family_text);
    UINT32 count = IDWriteFontFamily_GetFontCount(family);
    for (UINT32 j = 0; j < count && !catalog->error; ++j) {
      IDWriteFont *font = NULL;
      IDWriteFontFace *face = NULL;
      IDWriteFontFile **files = NULL;
      UINT32 file_count = 0;
      UINT32 capacity = 0;
      char *name = NULL;
      char *style = NULL;
      if (FAILED(IDWriteFontFamily_GetFont(family, j, &font))) {
        catalog->error = "DirectWrite font unavailable"; break;
      }
      if (IDWriteFont_GetSimulations(font) != DWRITE_FONT_SIMULATIONS_NONE) { IDWriteFont_Release(font); continue; }
      // Chromium omits faces without PostScript/style metadata. A missing optional
      // name is not an IO error and must not make all other installed fonts fail.
      name = information_name(font, DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME, catalog);
      if (!name || !*name || catalog->error || seen_name(catalog, name)) goto face_done;
      style = information_name(font, DWRITE_INFORMATIONAL_STRING_PREFERRED_SUBFAMILY_NAMES, catalog);
      if (!style && !catalog->error)
        style = information_name(font, DWRITE_INFORMATIONAL_STRING_WIN32_SUBFAMILY_NAMES, catalog);
      if (!style || catalog->error) goto face_done;
      if (FAILED(IDWriteFont_CreateFontFace(font, &face)) || FAILED(IDWriteFontFace_GetFiles(face, &file_count, NULL))) {
        catalog->error = "DirectWrite font files unavailable"; goto face_done;
      }
      capacity = file_count;
      files = calloc(capacity, sizeof(*files));
      if (!files || !file_count || FAILED(IDWriteFontFace_GetFiles(face, &file_count, files))) {
        catalog->error = "DirectWrite font files unavailable"; goto face_done;
      }
      for (UINT32 k = 0; k < file_count && !catalog->error; ++k) {
        struct face record = { .path = font_path(files[k]), .name = copy_name(name, catalog),
          .index = IDWriteFontFace_GetIndex(face), .has_index = true };
        append(catalog, record);
      }
face_done:
      if (files) { for (UINT32 k = 0; k < capacity; ++k) if (files[k]) IDWriteFontFile_Release(files[k]); free(files); }
      if (face) IDWriteFontFace_Release(face);
      free(name); free(style);
      IDWriteFont_Release(font);
    }
    IDWriteFontFamily_Release(family);
  }
done:
  if (collection) IDWriteFontCollection_Release(collection);
  if (factory) IDWriteFactory_Release(factory);
}
#else
static char *utf8(CFStringRef value) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return NULL;
  CFIndex size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
  char *result = malloc((size_t)size);
  if (result && !CFStringGetCString(value, result, size, kCFStringEncodingUTF8)) { free(result); return NULL; }
  return result;
}

static bool string_attribute(CTFontDescriptorRef descriptor, CFStringRef attribute, bool localized) {
  CFTypeRef value = localized ? CTFontDescriptorCopyLocalizedAttribute(descriptor, attribute, NULL)
    : CTFontDescriptorCopyAttribute(descriptor, attribute);
  bool valid = value && CFGetTypeID(value) == CFStringGetTypeID();
  if (value) CFRelease(value);
  return valid;
}

static bool valid_descriptor(CTFontDescriptorRef descriptor) {
  // Same required fields as Chromium's macOS Local Font Access enumeration.
  return string_attribute(descriptor, kCTFontNameAttribute, false)
    && string_attribute(descriptor, kCTFontDisplayNameAttribute, true)
    && string_attribute(descriptor, kCTFontFamilyNameAttribute, false)
    && string_attribute(descriptor, kCTFontStyleNameAttribute, false);
}

static void enumerate(struct catalog *catalog) {
  const void *keys[] = { kCTFontCollectionRemoveDuplicatesOption };
  const void *values[] = { kCFBooleanTrue };
  CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CTFontCollectionRef collection = CTFontCollectionCreateFromAvailableFonts(options);
  CFRelease(options);
  CFArrayRef descriptors = collection ? CTFontCollectionCreateMatchingFontDescriptors(collection) : NULL;
  if (!descriptors) { catalog->error = "CoreText system font collection unavailable"; if (collection) CFRelease(collection); return; }
  for (CFIndex i = 0; i < CFArrayGetCount(descriptors) && !catalog->error; ++i) {
    CTFontDescriptorRef descriptor = (CTFontDescriptorRef)CFArrayGetValueAtIndex(descriptors, i);
    if (!valid_descriptor(descriptor)) continue;
    CFStringRef name = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute);
    char *postscript_name = utf8(name);
    if (name) CFRelease(name);
    if (!postscript_name) { catalog->error = "CoreText font name unavailable"; break; }
    if (!*postscript_name || seen_name(catalog, postscript_name)) { free(postscript_name); continue; }
    CFURLRef url = CTFontDescriptorCopyAttribute(descriptor, kCTFontURLAttribute);
    CFStringRef path = url && CFGetTypeID(url) == CFURLGetTypeID() ? CFURLCopyFileSystemPath(url, kCFURLPOSIXPathStyle) : NULL;
    CTFontRef font = CTFontCreateWithFontDescriptor(descriptor, 0, NULL);
    CFDataRef table = font ? CTFontCopyTable(font, kCTFontTableName, kCTFontTableOptionNoOptions) : NULL;
    struct face record = { .path = utf8(path), .name = postscript_name };
    if (table && CFDataGetLength(table) > 0) {
      record.name_table_size = (size_t)CFDataGetLength(table);
      record.name_table = malloc(record.name_table_size);
      if (record.name_table) memcpy(record.name_table, CFDataGetBytePtr(table), record.name_table_size);
    }
    if (!record.name_table) {
      release_face(&record); catalog->error = "CoreText font name table unavailable";
    } else append(catalog, record);
    if (table) CFRelease(table);
    if (font) CFRelease(font);
    if (path) CFRelease(path);
    if (url) CFRelease(url);
  }
  CFRelease(descriptors);
  CFRelease(collection);
}
#endif

static void execute(napi_env env, void *data) { (void)env; enumerate(data); }

static void complete(napi_env env, napi_status status, void *data) {
  struct catalog *catalog = data;
  napi_value result;
  if (status != napi_ok && !catalog->error) catalog->error = "Font enumeration cancelled";
  if (catalog->error) {
    napi_value message;
    napi_create_string_utf8(env, catalog->error, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &result);
    napi_reject_deferred(env, catalog->deferred, result);
  } else {
    napi_create_array_with_length(env, catalog->count, &result);
    for (size_t i = 0; i < catalog->count; ++i) {
      napi_value face, path, name;
      napi_create_object(env, &face);
      napi_create_string_utf8(env, catalog->faces[i].path, NAPI_AUTO_LENGTH, &path);
      napi_create_string_utf8(env, catalog->faces[i].name, NAPI_AUTO_LENGTH, &name);
      napi_set_named_property(env, face, "path", path);
      napi_set_named_property(env, face, "postscriptName", name);
      if (catalog->faces[i].has_index) {
        napi_value index;
        napi_create_uint32(env, catalog->faces[i].index, &index);
        napi_set_named_property(env, face, "faceIndex", index);
      }
      if (catalog->faces[i].name_table) {
        napi_value table;
        napi_create_buffer_copy(env, catalog->faces[i].name_table_size, catalog->faces[i].name_table, NULL, &table);
        napi_set_named_property(env, face, "nameTable", table);
      }
      napi_set_element(env, result, (uint32_t)i, face);
    }
    napi_resolve_deferred(env, catalog->deferred, result);
  }
  for (size_t i = 0; i < catalog->count; ++i) release_face(&catalog->faces[i]);
  free(catalog->faces);
  napi_delete_async_work(env, catalog->work);
  free(catalog);
}

static napi_value query(napi_env env, napi_callback_info info) {
  (void)info;
  struct catalog *catalog = calloc(1, sizeof(*catalog));
  if (!catalog) { napi_throw_error(env, NULL, "Font catalog allocation failed"); return NULL; }
  napi_value promise, name;
  if (napi_create_promise(env, &catalog->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "system-font-files", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute, complete, catalog, &catalog->work) != napi_ok ||
      napi_queue_async_work(env, catalog->work) != napi_ok) {
    if (catalog->work) napi_delete_async_work(env, catalog->work);
    free(catalog); napi_throw_error(env, NULL, "Cannot schedule font enumeration"); return NULL;
  }
  return promise;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value query_function;
  napi_create_function(env, "enumerateFonts", NAPI_AUTO_LENGTH, query, NULL, &query_function);
  napi_set_named_property(env, exports, "enumerateFonts", query_function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
