// Process-owned advisory locks. Data-domain policy and process-family drain
// belong to the caller; this primitive does not authorize update activation.
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "directory.h"
#include "security.h"
#include <stdio.h>

#ifdef _WIN32
#include <windows.h>
#define MAX_PATH_UNITS 32760
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#define MAX_PATH_UNITS 4096
#endif

enum lease_state { LEASE_HELD, LEASE_CLOSED, LEASE_UNCERTAIN };
struct context;
struct lease {
  file_handle file;
  enum lease_state state;
  struct context *owner;
  struct lease *next;
  struct directory *directory;
  struct lease *parent;
  size_t children;
};
struct context {
  struct lease *head;
  bool detached;
  bool startup_consumed;
};

static napi_value fail_detail(napi_env env, const char *code, uint32_t system_code, const struct directory_error *source) {
  napi_value name, message, error, detail;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, name, message, &error) != napi_ok ||
      napi_create_uint32(env, system_code, &detail) != napi_ok ||
      napi_set_named_property(env, error, "systemCode", detail) != napi_ok) {
    napi_throw_error(env, "ERR_LEASE_NATIVE", "native lease error construction failed");
    return NULL;
  }
#ifdef _WIN32
  const char *native_reason = sc_diagnostic_system_reason(system_code);
  if (!strcmp(code, "ERR_LEASE_PERMISSION") || native_reason) {
    static volatile LONG sequence;
    char incident[64];
    snprintf(incident, sizeof(incident), "%lu-%lu", (unsigned long)GetCurrentProcessId(), (unsigned long)InterlockedIncrement(&sequence));
    const char *reason = native_reason ? native_reason :
        (source && source->permission_reason ? source->permission_reason : "policy_denied");
    fprintf(stderr, "{\"schema\":%u,\"event\":\"%s\",\"policy_hash\":\"%s\",\"profile\":\"native_directory\",\"stage\":\"binding\",\"reason\":\"%s\",\"subject_kind\":\"%s\",\"code\":\"%s\",\"system_code\":%u,\"error_type\":\"native\",\"correlation_id\":\"%s\",\"ace_index\":%d,\"mask\":%u,\"scope\":%d}\n",
      (unsigned)SC_DIAGNOSTIC_SCHEMA, SC_DIAGNOSTIC_EVENT, SC_POLICY_HASH, reason, sc_diagnostic_subject(reason), code, system_code, incident,
      source ? source->permission_index : -1, source ? source->permission_mask : 0, source ? source->permission_scope : 0);
    fflush(stderr);
    napi_value identity;
    if (napi_create_string_utf8(env, incident, NAPI_AUTO_LENGTH, &identity) == napi_ok) {
      // An own data property cannot invoke a patched Error prototype setter.
      napi_property_descriptor property = { .utf8name = "permissionIncidentId", .value = identity,
        .attributes = napi_writable | napi_configurable };
      napi_define_properties(env, error, 1, &property);
    }
  }
#else
  (void)source;
#endif
  napi_throw(env, error);
  return NULL;
}

static napi_value fail(napi_env env, const char *code, uint32_t system_code) {
  return fail_detail(env, code, system_code, NULL);
}
static napi_value fail_directory(napi_env env, const struct directory_error *source) {
  return fail_detail(env, source->code, source->system, source);
}

static uint32_t close_file(file_handle file) {
#ifdef _WIN32
  return CloseHandle(file) ? 0 : GetLastError();
#else
  // Never retry close after EINTR: the descriptor's state may be indeterminate.
  return close(file) == 0 ? 0 : (uint32_t)errno;
#endif
}

static napi_value fail_after_close(napi_env env, file_handle file,
                                   const char *code, uint32_t system_code) {
  uint32_t closed = close_file(file);
  return closed ? fail(env, "ERR_LEASE_RELEASE", closed) : fail(env, code, system_code);
}

static uint32_t close_resource(struct lease *lease) {
  uint32_t error;
  if (lease->directory) {
    error = directory_close(lease->directory);
    lease->directory = NULL;
  } else error = close_file(lease->file);
  if (!error && lease->parent) {
    lease->parent->children--;
    lease->parent = NULL;
  }
  return error;
}

static void forget(struct lease *lease) {
  struct context *owner = lease->owner;
  struct lease **cursor = &owner->head;
  while (*cursor && *cursor != lease) cursor = &(*cursor)->next;
  if (*cursor) *cursor = lease->next;
  free(lease);
  if (owner->detached && !owner->head) free(owner);
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  struct lease *lease = data;
  // Losing a JS reference is not proof that application IO has ended. An
  // orphaned live/uncertain lease intentionally survives until process death.
  if (lease->state == LEASE_CLOSED) forget(lease);
}

static void detach_environment(void *data) {
  struct context *owner = data;
  owner->detached = true;
  // Node worker / N-API environment teardown can precede process and IO exit.
  // Do not close any file here, including a lease whose JS external is gone.
  if (!owner->head) free(owner);
}

#ifdef _WIN32
static bool absolute_path(const char16_t *name, size_t length) {
  if (length > 2 && name[0] == '\\' && name[1] == '\\') return true;
  return length > 3 &&
         ((name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= 'a' && name[0] <= 'z')) &&
         name[1] == ':' && (name[2] == '/' || name[2] == '\\');
}

static file_handle open_file(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > MAX_PATH_UNITS) {
    fail(env, "ERR_LEASE_ARGUMENT", 0);
    return INVALID_FILE;
  }
  char16_t *name = calloc(length + 1, sizeof(char16_t));
  if (!name) {
    fail(env, "ERR_LEASE_ALLOCATION", 0);
    return INVALID_FILE;
  }
  bool valid = napi_get_value_string_utf16(env, value, name, length + 1, &length) == napi_ok;
  for (size_t i = 0; i < length; i++) if (!name[i]) valid = false;
  valid = valid && absolute_path(name, length);
  if (!valid) {
    free(name);
    fail(env, "ERR_LEASE_ARGUMENT", 0);
    return INVALID_FILE;
  }
  HANDLE file = CreateFileW((LPCWSTR)name, GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS,
                           FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  uint32_t error = file == INVALID_FILE ? GetLastError() : 0;
  free(name);
  if (error) {
    fail(env, "ERR_LEASE_NATIVE", error);
    return INVALID_FILE;
  }
  BY_HANDLE_FILE_INFORMATION identity;
  if (!GetFileInformationByHandle(file, &identity)) {
    error = GetLastError();
    fail_after_close(env, file, "ERR_LEASE_NATIVE", error);
    return INVALID_FILE;
  }
  if (GetFileType(file) != FILE_TYPE_DISK || identity.nNumberOfLinks != 1 ||
      (identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    fail_after_close(env, file, "ERR_LEASE_FILE", 0);
    return INVALID_FILE;
  }
  return file;
}
#else
static file_handle open_file(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > MAX_PATH_UNITS) {
    fail(env, "ERR_LEASE_ARGUMENT", 0);
    return INVALID_FILE;
  }
  char *name = calloc(length + 1, 1);
  if (!name) {
    fail(env, "ERR_LEASE_ALLOCATION", 0);
    return INVALID_FILE;
  }
  if (napi_get_value_string_utf8(env, value, name, length + 1, &length) != napi_ok ||
      name[0] != '/' || memchr(name, 0, length) != NULL) {
    free(name);
    fail(env, "ERR_LEASE_ARGUMENT", 0);
    return INVALID_FILE;
  }
  int flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
  int file = open(name, flags | O_CREAT | O_EXCL, 0600);
  if (file < 0 && errno == EEXIST) file = open(name, flags);
  uint32_t error = file == INVALID_FILE ? (uint32_t)errno : 0;
  free(name);
  if (error) {
    fail(env, error == ELOOP ? "ERR_LEASE_FILE" : "ERR_LEASE_NATIVE", error);
    return INVALID_FILE;
  }
  struct stat identity;
  if (fstat(file, &identity) != 0) {
    error = (uint32_t)errno;
    fail_after_close(env, file, "ERR_LEASE_NATIVE", error);
    return INVALID_FILE;
  }
  if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 || identity.st_uid != geteuid()) {
    fail_after_close(env, file, "ERR_LEASE_FILE", 0);
    return INVALID_FILE;
  }
  return file;
}
#endif

static napi_value hold(napi_env env, struct context *owner, file_handle file,
                       bool exclusive, struct lease *parent) {
  napi_value result;
  uint32_t error = 0;
  bool busy = false;
#ifdef _WIN32
  OVERLAPPED overlap = {0};
  if (!LockFileEx(file, LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0),
                  0, 1, 0, &overlap)) {
    error = GetLastError();
    busy = error == ERROR_LOCK_VIOLATION;
  }
#else
  if (flock(file, LOCK_NB | (exclusive ? LOCK_EX : LOCK_SH)) != 0) {
    error = (uint32_t)errno;
    busy = error == EWOULDBLOCK || error == EAGAIN;
  }
#endif
  if (error) {
    return fail_after_close(env, file, busy ? "ERR_LEASE_BUSY" : "ERR_LEASE_NATIVE", error);
  }
  struct lease *lease = calloc(1, sizeof(*lease));
  if (!lease) {
    return fail_after_close(env, file, "ERR_LEASE_ALLOCATION", 0);
  }
  lease->file = file;
  lease->state = LEASE_HELD;
  lease->owner = owner;
  lease->next = owner->head;
  owner->head = lease;
  lease->parent = parent;
  if (parent) parent->children++;
  if (napi_create_external(env, lease, finalize, NULL, &result) != napi_ok) {
    uint32_t closed = close_resource(lease);
    if (closed == 0) forget(lease);
    else lease->state = LEASE_UNCERTAIN;
    return fail(env, closed ? "ERR_LEASE_RELEASE" : "ERR_LEASE_NATIVE", closed);
  }
  return result;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  void *data = NULL;
  bool exclusive = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 2 ||
      napi_get_value_bool(env, argv[1], &exclusive) != napi_ok)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  file_handle file = open_file(env, argv[0]);
  return file == INVALID_FILE ? NULL : hold(env, data, file, exclusive, NULL);
}

static struct lease *lookup(napi_env env, struct context *owner, napi_value value) {
  void *opaque = NULL;
  if (napi_get_value_external(env, value, &opaque) == napi_ok) {
    for (struct lease *lease = owner->head; lease; lease = lease->next)
      if (lease == opaque) return lease;
  }
  fail(env, "ERR_LEASE_ARGUMENT", 0);
  return NULL;
}

static char *text_argument(napi_env env, napi_value value, size_t limit) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || !length || length > limit) {
    fail(env, "ERR_LEASE_ARGUMENT", 0); return NULL;
  }
  char *text = calloc(length + 1, 1);
  if (!text) { fail(env, "ERR_LEASE_ALLOCATION", 0); return NULL; }
  if (napi_get_value_string_utf8(env, value, text, length + 1, &length) != napi_ok || memchr(text, 0, length)) {
    free(text); fail(env, "ERR_LEASE_ARGUMENT", 0); return NULL;
  }
  return text;
}

static napi_value hold_directory(napi_env env, struct context *owner, struct directory *directory, struct lease *parent) {
  napi_value result;
  struct lease *lease = calloc(1, sizeof(*lease));
  if (!lease) {
    uint32_t closed = directory_close(directory);
    if (closed && parent) parent->state = LEASE_UNCERTAIN;
    return fail(env, closed ? "ERR_LEASE_RELEASE" : "ERR_LEASE_ALLOCATION", closed);
  }
  lease->file = INVALID_FILE;
  lease->directory = directory;
  lease->state = LEASE_HELD;
  lease->owner = owner;
  lease->parent = parent;
  if (parent) parent->children++;
  lease->next = owner->head;
  owner->head = lease;
  if (napi_create_external(env, lease, finalize, NULL, &result) != napi_ok) {
    uint32_t closed = close_resource(lease);
    if (closed == 0) forget(lease);
    else lease->state = LEASE_UNCERTAIN;
    return fail(env, closed ? "ERR_LEASE_RELEASE" : "ERR_LEASE_NATIVE", closed);
  }
  return result;
}

static napi_value pin(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  void *data = NULL;
  bool create = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || (argc != 2 && argc != 3) ||
      napi_get_value_bool(env, argv[1], &create) != napi_ok) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *path = text_argument(env, argv[0], MAX_PATH_UNITS * 4);
  if (!path) return NULL;
  struct directory_error error = {0};
  enum directory_role role = DIRECTORY_PRIVATE;
  if (argc == 3) {
    char *value = text_argument(env, argv[2], 16);
    if (!value) { free(path); return NULL; }
    bool valid = !strcmp(value, "private") || !strcmp(value, "project") || !strcmp(value, "installation");
    if (!strcmp(value, "project")) role = DIRECTORY_PROJECT;
    if (!strcmp(value, "installation")) role = DIRECTORY_INSTALLATION;
    free(value);
    if (!valid) { free(path); return fail(env, "ERR_LEASE_ARGUMENT", 0); }
  }
  struct directory *directory = directory_open_role(path, create, role, &error);
  free(path);
  if (!directory) return fail_directory(env, &error);
  return hold_directory(env, data, directory, NULL);
}

static napi_value pin_child(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 2)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *name = text_argument(env, argv[1], DIRECTORY_NAME_BYTES);
  if (!name) return NULL;
  struct directory_error error = {0};
  struct directory *directory = directory_pin_child(parent->directory, name, &error);
  free(name);
  if (!directory) {
    if (!strcmp(error.code, "ERR_LEASE_RELEASE")) parent->state = LEASE_UNCERTAIN;
    return fail_directory(env, &error);
  }
  return hold_directory(env, data, directory, parent);
}

static napi_value identity(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 1)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *lease = lookup(env, data, argv[0]);
  if (!lease) return NULL;
  if (lease->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!lease->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  if (napi_create_string_utf8(env, directory_identity(lease->directory), NAPI_AUTO_LENGTH, &result) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

#ifndef _WIN32
static napi_value persistent_identity(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 1)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *lease = lookup(env, data, argv[0]);
  if (!lease) return NULL;
  if (lease->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!lease->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char value[DIRECTORY_IDENTITY_BYTES];
  struct directory_error error = {0};
  if (!directory_persistent_identity(lease->directory, value, &error))
    return fail_directory(env, &error);
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}
#endif

static napi_value lineage(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 1)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *lease = lookup(env, data, argv[0]);
  if (!lease) return NULL;
  if (lease->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!lease->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  size_t depth = directory_depth(lease->directory);
  if (napi_create_array(env, &result) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  const char *leaf = directory_identity(lease->directory);
  uint32_t next = 0;
  for (size_t i = 0; i < depth; i++) {
    if (!strcmp(leaf, directory_ancestor(lease->directory, i))) continue;
    bool duplicate = false;
    for (size_t prior = 0; prior < i; prior++) {
      if (!strcmp(directory_ancestor(lease->directory, prior), directory_ancestor(lease->directory, i))) {
        duplicate = true; break;
      }
    }
    if (duplicate) continue;
    napi_value value;
    if (napi_create_string_utf8(env, directory_ancestor(lease->directory, i), NAPI_AUTO_LENGTH, &value) != napi_ok ||
        napi_set_element(env, result, next++, value) != napi_ok)
      return fail(env, "ERR_LEASE_NATIVE", 0);
  }
  napi_value selected;
  if (napi_create_string_utf8(env, leaf, NAPI_AUTO_LENGTH, &selected) != napi_ok ||
      napi_set_element(env, result, next, selected) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

static napi_value acquire_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  void *data = NULL;
  bool exclusive = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 3 ||
      napi_get_value_bool(env, argv[2], &exclusive) != napi_ok) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *name = text_argument(env, argv[1], 128);
  if (!name) return NULL;
  struct directory_error error = {0};
  file_handle file = directory_file(parent->directory, name, &error);
  free(name);
  if (file == INVALID_FILE) return fail_directory(env, &error);
  return hold(env, data, file, exclusive, parent);
}

static napi_value reclaim_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], result, removed, busy, retained;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 2)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *identity = text_argument(env, argv[1], DIRECTORY_IDENTITY_BYTES);
  if (!identity) return NULL;
  struct directory_error error = {0};
  struct directory_reclamation outcome = {0};
  bool collected = directory_reclaim(parent->directory, identity, &outcome, &error);
  free(identity);
  if (!collected) {
    if (!strcmp(error.code, "ERR_LEASE_RELEASE")) parent->state = LEASE_UNCERTAIN;
    return fail_directory(env, &error);
  }
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_uint32(env, outcome.removed, &removed) != napi_ok ||
      napi_get_boolean(env, outcome.busy, &busy) != napi_ok ||
      napi_get_boolean(env, outcome.retained, &retained) != napi_ok ||
      napi_set_named_property(env, result, "removed", removed) != napi_ok ||
      napi_set_named_property(env, result, "busy", busy) != napi_ok ||
      napi_set_named_property(env, result, "retained", retained) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

static napi_value release(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  void *data = NULL, *opaque = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], &opaque) != napi_ok)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct context *owner = data;
  struct lease *lease = owner->head;
  while (lease && lease != opaque) lease = lease->next;
  if (!lease) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  if (lease->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (lease->children) return fail(env, "ERR_LEASE_IN_USE", 0);
  // A failed close is never retried or represented as proof of release.
  lease->state = LEASE_UNCERTAIN;
  uint32_t error = close_resource(lease);
  if (error) return fail(env, "ERR_LEASE_NATIVE", error);
  lease->file = INVALID_FILE;
  lease->state = LEASE_CLOSED;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}

static napi_value create_child(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], result;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 2)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *name = text_argument(env, argv[1], MAX_PATH_UNITS * 4);
  if (!name) return NULL;
  char identity[DIRECTORY_IDENTITY_BYTES];
  struct directory_error error = {0};
  bool created = directory_child(parent->directory, name, identity, &error);
  free(name);
  if (!created) return fail_directory(env, &error);
  if (napi_create_string_utf8(env, identity, NAPI_AUTO_LENGTH, &result) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

static napi_value create_at(napi_env env, napi_callback_info info) {
  size_t argc = 4, length = 0;
  napi_value argv[4], result;
  void *data = NULL, *buffer = NULL;
  bool is_buffer = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 3 ||
      napi_is_buffer(env, argv[2], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[2], &buffer, &length) != napi_ok ||
      !length || length > DIRECTORY_READ_LIMIT)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *name = text_argument(env, argv[1], 128);
  if (!name) return NULL;
  struct directory_error error = {0};
  bool created = directory_create(parent->directory, name, buffer, length, &error);
  free(name);
  if (!created) {
    if (!strcmp(error.code, "ERR_LEASE_RELEASE")) parent->state = LEASE_UNCERTAIN;
    return fail_directory(env, &error);
  }
  if (napi_get_undefined(env, &result) != napi_ok) return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

/* Plain own enumerable data properties; defineProperty avoids __proto__ setters. */
static napi_value list_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4], result;
  void *data = NULL;
  double entries = 0, bytes = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 3 ||
      napi_get_value_double(env, argv[1], &entries) != napi_ok ||
      napi_get_value_double(env, argv[2], &bytes) != napi_ok ||
      !(entries >= 1 && entries <= DIRECTORY_RECORD_LIMIT) || (double)(size_t)entries != entries ||
      !(bytes >= 1 && bytes <= DIRECTORY_READ_LIMIT) || (double)(size_t)bytes != bytes)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct directory_error error = {0};
  struct directory_records records = {0};
  if (!directory_list(parent->directory, (size_t)entries, (size_t)bytes, &records, &error)) {
    if (!strcmp(error.code, "ERR_LEASE_RELEASE")) parent->state = LEASE_UNCERTAIN;
    return fail_directory(env, &error);
  }
  napi_status status = napi_create_object(env, &result);
  for (size_t i = 0; status == napi_ok && i < records.count; i++) {
    napi_value value;
    status = napi_create_buffer_copy(env, records.items[i].length, records.items[i].data, NULL, &value);
    if (status != napi_ok) break;
    napi_property_descriptor property = {
      .utf8name = records.items[i].name, .value = value,
      .attributes = napi_writable | napi_enumerable | napi_configurable,
    };
    status = napi_define_properties(env, result, 1, &property);
  }
  directory_records_free(&records);
  if (status != napi_ok) return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

static napi_value read_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4], result;
  void *data = NULL;
  double requested = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 3 ||
      napi_get_value_double(env, argv[2], &requested) != napi_ok ||
      !(requested >= 1 && requested <= DIRECTORY_READ_LIMIT) || (double)(size_t)requested != requested)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct lease *parent = lookup(env, data, argv[0]);
  if (!parent) return NULL;
  if (parent->state != LEASE_HELD) return fail(env, "ERR_LEASE_CLOSED", 0);
  if (!parent->directory) return fail(env, "ERR_LEASE_ARGUMENT", 0);
  char *name = text_argument(env, argv[1], 128);
  if (!name) return NULL;
  size_t limit = (size_t)requested, length = 0;
  unsigned char *buffer = malloc(limit + 1);
  if (!buffer) { free(name); return fail(env, "ERR_LEASE_ALLOCATION", 0); }
  bool missing = false;
  struct directory_error error = {0};
  bool read = directory_read(parent->directory, name, buffer, limit, &length, &missing, &error);
  free(name);
  if (!read) { free(buffer); return fail_directory(env, &error); }
  napi_status status = missing ? napi_get_null(env, &result)
                              : napi_create_buffer_copy(env, length, buffer, NULL, &result);
  free(buffer);
  if (status != napi_ok) return fail(env, "ERR_LEASE_NATIVE", 0);
  return result;
}

#include "startup.h"
#include "family.h"

static napi_value initialize(napi_env env, napi_value exports) {
  struct context *owner = calloc(1, sizeof(*owner));
  if (!owner) return fail(env, "ERR_LEASE_ALLOCATION", 0);
  if (napi_add_env_cleanup_hook(env, detach_environment, owner) != napi_ok) {
    free(owner);
    return fail(env, "ERR_LEASE_NATIVE", 0);
  }
  napi_property_descriptor properties[] = {
#ifdef _WIN32
      {"openFamily", NULL, open_family, NULL, NULL, NULL, napi_default, NULL},
      {"assertUpdateInstallationIdle", NULL, assert_installation_idle, NULL, NULL, NULL, napi_default, NULL},
#endif
      {"startupSession", NULL, startup_session, NULL, NULL, NULL, napi_default, owner},
      {"maintenanceSession", NULL, maintenance_session, NULL, NULL, NULL, napi_default, owner},
      {"acquire", NULL, acquire, NULL, NULL, NULL, napi_default, owner},
      {"release", NULL, release, NULL, NULL, NULL, napi_default, owner},
      {"pin", NULL, pin, NULL, NULL, NULL, napi_default, owner},
      {"pinChild", NULL, pin_child, NULL, NULL, NULL, napi_default, owner},
      {"identity", NULL, identity, NULL, NULL, NULL, napi_default, owner},
#ifndef _WIN32
      {"persistentIdentity", NULL, persistent_identity, NULL, NULL, NULL, napi_default, owner},
#endif
      {"lineage", NULL, lineage, NULL, NULL, NULL, napi_default, owner},
      {"acquireAt", NULL, acquire_at, NULL, NULL, NULL, napi_default, owner},
      {"reclaimAt", NULL, reclaim_at, NULL, NULL, NULL, napi_default, owner},
      {"createChild", NULL, create_child, NULL, NULL, NULL, napi_default, owner},
      {"createAt", NULL, create_at, NULL, NULL, NULL, napi_default, owner},
      {"listAt", NULL, list_at, NULL, NULL, NULL, napi_default, owner},
      {"readAt", NULL, read_at, NULL, NULL, NULL, napi_default, owner},
  };
  if (napi_define_properties(env, exports, sizeof(properties)/sizeof(properties[0]), properties) != napi_ok)
    return fail(env, "ERR_LEASE_NATIVE", 0);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
