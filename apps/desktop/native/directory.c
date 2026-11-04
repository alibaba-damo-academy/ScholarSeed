// Authorized directory pins. Namespace migration still needs product admission;
// these pins do not prevent a same-user, non-cooperating rename on macOS.
#include "directory.h"
#include "security.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include <stddef.h>
#include <wchar.h>

#define DIRECTORY_DEPTH_LIMIT 256
#define IDENTITY_BYTES DIRECTORY_IDENTITY_BYTES
#define LEAF_BYTES DIRECTORY_NAME_BYTES

#ifdef _WIN32
#include <aclapi.h>
#include <sddl.h>
#include <winternl.h>
#define PATH_UNITS 32760
#else
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <membership.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/attr.h>
#include <uuid/uuid.h>
#include <unistd.h>
#include "darwin-permissions.h"
#define PATH_UNITS 4096
#endif

struct directory {
  enum directory_role role;
  file_handle handles[DIRECTORY_DEPTH_LIMIT];
  size_t count;
  struct directory *physical;
  struct directory *logical;
  struct directory *parent;
  char identities[DIRECTORY_DEPTH_LIMIT][IDENTITY_BYTES];
#ifdef _WIN32
  wchar_t *path;
  PSID user;
  PSECURITY_DESCRIPTOR security;
#else
  char *path;
#endif
};

static void failure(struct directory_error *error, const char *code, uint32_t system) {
  error->code = code;
  error->system = system;
  error->permission_reason = NULL;
  error->permission_mask = 0;
  error->permission_index = -1;
  error->permission_scope = 0;
}

#ifndef _WIN32
bool directory_persistent_identity(struct directory *directory,
                                   char identity[DIRECTORY_IDENTITY_BYTES],
                                   struct directory_error *error) {
  int descriptor = directory->handles[directory->count - 1];
  struct attrlist attributes = { .bitmapcount = ATTR_BIT_MAP_COUNT,
    .volattr = ATTR_VOL_INFO | ATTR_VOL_UUID };
  struct { uint32_t length; uuid_t uuid; } volume = {0};
  struct stat info;
  if (fgetattrlist(descriptor, &attributes, &volume, sizeof(volume), 0) ||
      fstat(descriptor, &info)) {
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno);
    return false;
  }
  if (volume.length != sizeof(volume) || uuid_is_null(volume.uuid) ||
      !info.st_ino || info.st_birthtimespec.tv_sec <= 0 ||
      info.st_birthtimespec.tv_nsec < 0 || info.st_birthtimespec.tv_nsec >= 1000000000) {
    failure(error, "ERR_LEASE_UNSUPPORTED", 0);
    return false;
  }
  char uuid[33];
  for (size_t i = 0; i < sizeof(volume.uuid); i++)
    snprintf(uuid + i * 2, 3, "%02x", volume.uuid[i]);
  /* st_dev is a mount/session identity. Do not persist it across boots.
     Birth time also fences reuse of an inode on the same persistent volume. */
  snprintf(identity, DIRECTORY_IDENTITY_BYTES, "darwin:%s:%016" PRIx64 ":%016" PRIx64 ":%08" PRIx32,
           uuid, (uint64_t)info.st_ino, (uint64_t)info.st_birthtimespec.tv_sec,
           (uint32_t)info.st_birthtimespec.tv_nsec);
  return true;
}
#endif

static uint32_t close_handle(file_handle handle) {
#ifdef _WIN32
  return CloseHandle(handle) ? 0 : GetLastError();
#else
  return close(handle) == 0 ? 0 : (uint32_t)errno;
#endif
}

uint32_t directory_close(struct directory *directory) {
  // Consume each chain once. A failed close may already have closed its handle;
  // retain all later chains/ancestors until process exit, without retrying.
  struct directory *physical = directory->physical;
  directory->physical = NULL;
  uint32_t error = physical ? directory_close(physical) : 0;
  if (error) return error;
  struct directory *logical = directory->logical;
  directory->logical = NULL;
  error = logical ? directory_close(logical) : 0;
  if (error) return error;
  while (directory->count) {
    error = close_handle(directory->handles[--directory->count]);
    if (error) return error;
  }
  free(directory->path);
#ifdef _WIN32
  free(directory->user);
  if (directory->security) LocalFree(directory->security);
#endif
  free(directory);
  return 0;
}

const char *directory_identity(struct directory *directory) {
  return directory->identities[directory->count - 1];
}

size_t directory_depth(struct directory *directory) {
  return directory->count + (directory->parent ? directory_depth(directory->parent) : 0) +
    (directory->physical ? directory_depth(directory->physical) - 1 : 0) +
    (directory->logical ? directory_depth(directory->logical) - 1 : 0);
}

const char *directory_ancestor(struct directory *directory, size_t index) {
  size_t parent = directory->parent ? directory_depth(directory->parent) : 0;
  if (index < parent) return directory_ancestor(directory->parent, index);
  index -= parent;
  size_t physical = directory->physical ? directory_depth(directory->physical) - 1 : 0;
  if (index < physical) return directory_ancestor(directory->physical, index);
  index -= physical;
  size_t logical = directory->logical ? directory_depth(directory->logical) - 1 : 0;
  if (index < logical) return directory_ancestor(directory->logical, index);
  index -= logical;
  return index < directory->count ? directory->identities[index] : NULL;
}

static bool leaf_name(const char *name) {
  size_t length = strlen(name);
  if (!length || length > LEAF_BYTES || name[0] == '.' || name[length - 1] == '.') return false;
  for (size_t i = 0; i < length; i++) {
    if (!((name[i] >= 'a' && name[i] <= 'z') || (name[i] >= '0' && name[i] <= '9') ||
          name[i] == '-' || name[i] == '_' || name[i] == '.')) return false;
  }
  return true;
}

static bool child_name(const char *name) {
  size_t length = strlen(name);
  if (!length || length >= PATH_UNITS || !strcmp(name, ".") || !strcmp(name, "..")) return false;
  for (size_t i = 0; i < length; i++) {
    if (name[i] == '/') return false;
#ifdef _WIN32
    if (name[i] == '\\' || name[i] == ':') return false;
#endif
  }
#ifdef _WIN32
  if (name[length - 1] == '.' || name[length - 1] == ' ') return false;
#endif
  return true;
}

#ifdef _WIN32
static bool authority(PSID sid, PSID user) {
  return sc_authority(sid, GetLengthSid(sid), user, GetLengthSid(user));
}

static bool permissions(HANDLE handle, PSID user, bool ancestor, struct directory_error *error) {
  PSID owner = NULL;
  PACL acl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                &owner, NULL, &acl, NULL, &descriptor);
  if (status != ERROR_SUCCESS) {
    failure(error, "ERR_LEASE_NATIVE", status);
    return false;
  }
  const char *permission_reason = "invalid_descriptor";
  struct sc_result verdict = {0};
  bool valid = owner && IsValidSid(owner) && acl && IsValidAcl(acl);
  int role = ancestor ? SC_ROLE_ANCESTOR : SC_ROLE_CONTENT;
  if (ancestor) {
    wchar_t resolved[PATH_UNITS];
    DWORD length = GetFinalPathNameByHandleW(handle, resolved, PATH_UNITS, VOLUME_NAME_GUID);
    if (!length || length >= PATH_UNITS) valid = false;
    else if (!wcsncmp(resolved, L"\\\\?\\Volume{", 11)) {
      wchar_t *end = wcschr(resolved, L'}');
      if (end && end[1] == L'\\' && end[2] == 0) role = SC_ROLE_VOLUME;
    }
  }
  /* Volume management is outside the installation boundary. Direct child
     deletion remains dangerous; ordinary ancestors and content keep owner checks. */
  if (valid && !sc_owner(role, authority(owner, user))) {
    valid = false;
    permission_reason = "untrusted_owner";
  }
  struct sc_entry *entries = acl ? calloc(acl->AceCount, sizeof(*entries)) : NULL;
  PSID *principals = acl ? calloc(acl->AceCount, sizeof(*principals)) : NULL;
  if (acl && acl->AceCount && (!entries || !principals)) valid = false;
  for (DWORD i = 0; valid && i < acl->AceCount; i++) {
    PACE_HEADER header = NULL;
    if (!GetAce(acl, i, (void **)&header) ||
        (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) ||
        (header->AceFlags & ~0x1f) || header->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8) {
      permission_reason = "unsupported_ace";
      valid = false;
      break;
    }
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
    PSID sid = &ace->SidStart;
    if (*GetSidSubAuthorityCount(sid) > SID_MAX_SUB_AUTHORITIES ||
        8 + 4 * *GetSidSubAuthorityCount(sid) + offsetof(ACCESS_ALLOWED_ACE, SidStart) != header->AceSize ||
        !IsValidSid(sid)) {
      valid = false;
      break;
    }
    // OWNER RIGHTS denotes the actual owner, whose authority was checked above.
    // Official Codex Homes use this ACE; it must not waive the owner check.
    if (IsWellKnownSid(sid, WinCreatorOwnerRightsSid)) sid = owner;
    principals[i] = sid;
    uint32_t principal = i;
    for (DWORD j = 0; j < i; j++) if (EqualSid(principals[j], sid)) { principal = entries[j].principal; break; }
    entries[i] = (struct sc_entry){ .principal = principal, .mask = ace->Mask,
      .flags = header->AceFlags, .deny = header->AceType == ACCESS_DENIED_ACE_TYPE,
      .trusted = authority(sid, user), .universal = IsWellKnownSid(sid, WinWorldSid) };
  }
  if (valid) {
    verdict = sc_evaluate(entries, acl->AceCount, role, false);
    valid = verdict.reason == 0;
    if (!valid) permission_reason = "foreign_writer";
  }
  free(principals);
  free(entries);
  LocalFree(descriptor);
  if (!valid) {
    failure(error, "ERR_LEASE_PERMISSION", 0);
    error->permission_reason = permission_reason;
    error->permission_mask = verdict.mask;
    error->permission_index = verdict.reason ? verdict.index : -1;
    error->permission_scope = verdict.scope;
  }
  return valid;
}

// Product data uses the caller's actual Windows access rights. The installation
// role remains distinct for every child and record; it must never downgrade to
// PRIVATE after opening the root. Existing user ACLs are not rewritten.
static bool record_permissions(struct directory *directory, HANDLE handle,
                               struct directory_error *error) {
  return directory->role == DIRECTORY_PRIVATE ||
         permissions(handle, directory->user, false, error);
}

static bool user_security(struct directory *directory, struct directory_error *error) {
  HANDLE token;
  DWORD bytes = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError());
    return false;
  }
  GetTokenInformation(token, TokenUser, NULL, 0, &bytes);
  TOKEN_USER *value = bytes ? malloc(bytes) : NULL;
  bool valid = value && GetTokenInformation(token, TokenUser, value, bytes, &bytes);
  DWORD status = valid ? 0 : GetLastError();
  CloseHandle(token);
  if (!valid) {
    free(value);
    failure(error, "ERR_LEASE_NATIVE", status);
    return false;
  }
  DWORD length = GetLengthSid(value->User.Sid);
  directory->user = malloc(length);
  valid = directory->user && CopySid(length, directory->user, value->User.Sid);
  free(value);
  if (!valid) {
    failure(error, "ERR_LEASE_ALLOCATION", 0);
    return false;
  }
  LPWSTR sid = NULL;
  if (!ConvertSidToStringSidW(directory->user, &sid)) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError());
    return false;
  }
  wchar_t sddl[256];
  int written = swprintf(sddl, 256, L"O:%lsD:P(A;;FA;;;%ls)(A;;FA;;;SY)", sid, sid);
  LocalFree(sid);
  if (written < 0 || !ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl, SDDL_REVISION_1, &directory->security, NULL)) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError());
    return false;
  }
  return true;
}

static bool check_object(HANDLE handle, bool is_directory, struct directory_error *error) {
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info)) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError());
    return false;
  }
  if (GetFileType(handle) != FILE_TYPE_DISK || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != is_directory ||
      (!is_directory && info.nNumberOfLinks != 1)) {
    failure(error, "ERR_LEASE_DIRECTORY", 0);
    return false;
  }
  return true;
}

static bool object_identity(HANDLE handle, char *encoded, struct directory_error *error) {
  FILE_ID_INFO identity;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity))) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError()); return false;
  }
  int offset = snprintf(encoded, IDENTITY_BYTES, "windows:%016" PRIx64 ":", (uint64_t)identity.VolumeSerialNumber);
  for (size_t i = 0; i < sizeof(identity.FileId.Identifier); i++)
    snprintf(encoded + offset + i * 2, IDENTITY_BYTES - (size_t)offset - i * 2, "%02x", identity.FileId.Identifier[i]);
  return true;
}

bool directory_child(struct directory *directory, const char *name, char *identity, struct directory_error *error) {
  if (!child_name(name)) { failure(error, "ERR_LEASE_ARGUMENT", 0); return false; }
  int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, NULL, 0);
  if (units < 2 || units > PATH_UNITS) { failure(error, "ERR_LEASE_ARGUMENT", 0); return false; }
  wchar_t *wide = calloc((size_t)units, sizeof(wchar_t));
  if (!wide) { failure(error, "ERR_LEASE_ALLOCATION", 0); return false; }
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, wide, units)) {
    free(wide); failure(error, "ERR_LEASE_ARGUMENT", GetLastError()); return false;
  }
  UNICODE_STRING relative = {(USHORT)((units - 1) * sizeof(wchar_t)), (USHORT)(units * sizeof(wchar_t)), wide};
  OBJECT_ATTRIBUTES attributes = {
    .Length = sizeof(attributes), .RootDirectory = directory->handles[directory->count - 1],
    .ObjectName = &relative, .Attributes = OBJ_CASE_INSENSITIVE, .SecurityDescriptor = directory->security,
  };
  IO_STATUS_BLOCK status;
  HANDLE child = INVALID_FILE;
  // FILE_OPEN_IF never truncates an existing object. Resolve exactly one name
  // against the retained parent handle, even after that parent was renamed.
  NTSTATUS result = NtCreateFile(&child, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | (directory->role == DIRECTORY_INSTALLATION ? READ_CONTROL : 0) | SYNCHRONIZE,
                                &attributes, &status, NULL, FILE_ATTRIBUTE_DIRECTORY,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN_IF,
                                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                                NULL, 0);
  free(wide);
  if (result < 0) { failure(error, "ERR_LEASE_NATIVE", RtlNtStatusToDosError(result)); return false; }
  bool valid = check_object(child, true, error) && (directory->role != DIRECTORY_INSTALLATION || record_permissions(directory, child, error)) &&
               object_identity(child, identity, error);
  uint32_t closed = close_handle(child);
  if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  return valid;
}

struct directory *directory_open_role(const char *path, bool create, enum directory_role role, struct directory_error *error) {
  if ((role != DIRECTORY_PRIVATE && role != DIRECTORY_PROJECT && role != DIRECTORY_INSTALLATION) ||
      (role == DIRECTORY_INSTALLATION && create)) { failure(error, "ERR_LEASE_ARGUMENT", 0); return NULL; }
  struct directory *directory = calloc(1, sizeof(*directory));
  if (!directory) { failure(error, "ERR_LEASE_ALLOCATION", 0); return NULL; }
  directory->role = role;
  int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (units < 4 || units > PATH_UNITS) { failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed; }
  directory->path = calloc((size_t)units + 4, sizeof(wchar_t));
  if (!directory->path) { failure(error, "ERR_LEASE_ALLOCATION", 0); goto failed; }
  wchar_t *name = directory->path;
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, name + 4, units)) {
    failure(error, "ERR_LEASE_ARGUMENT", GetLastError()); goto failed;
  }
  // Local drive roots only. Network filesystem semantics need a separate policy.
  if (!((name[4] >= L'A' && name[4] <= L'Z') || (name[4] >= L'a' && name[4] <= L'z')) ||
      name[5] != L':' || (name[6] != L'/' && name[6] != L'\\')) {
    failure(error, "ERR_LEASE_UNSUPPORTED", 0); goto failed;
  }
  memcpy(name, L"\\\\?\\", 4 * sizeof(wchar_t));
  for (size_t i = 6; name[i]; i++) if (name[i] == L'/') name[i] = L'\\';
  if (!user_security(directory, error)) goto failed;
  size_t length = wcslen(name), end = 7, start = 7;
  for (;;) {
    if (directory->count == DIRECTORY_DEPTH_LIMIT) { failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed; }
    if (end > 7) {
      size_t part = end - start;
      if (!part || name[end - 1] == L'.' || name[end - 1] == L' ') { failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed; }
      for (size_t i = start; i < end; i++) if (name[i] == L':') { failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed; }
    }
    wchar_t saved = name[end]; name[end] = 0;
    if (create && end == length && end > 7) {
      SECURITY_ATTRIBUTES attributes = {sizeof(attributes), directory->security, FALSE};
      if (!CreateDirectoryW(name, &attributes) && GetLastError() != ERROR_ALREADY_EXISTS) {
        failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto failed;
      }
    }
    HANDLE handle = CreateFileW(name, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | (role == DIRECTORY_INSTALLATION && end == length ? READ_CONTROL : 0),
                               FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    name[end] = saved;
    if (handle == INVALID_FILE) {
      DWORD status = GetLastError();
      failure(error, status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND
                     ? "ERR_LEASE_MISSING" : "ERR_LEASE_NATIVE", status);
      goto failed;
    }
    directory->handles[directory->count++] = handle;
    if (directory->count == 1) {
      // A mapped network drive still has a drive-letter spelling. A local
      // physical volume root resolves to this exact GUID-root form; SMB and
      // SUBST roots must not omit physical ancestors from this walk.
      wchar_t volume[64];
      DWORD count = GetFinalPathNameByHandleW(handle, volume, 64, VOLUME_NAME_GUID);
      if (count != 49 || wcsncmp(volume, L"\\\\?\\Volume{", 11) || volume[47] != L'}' || volume[48] != L'\\') {
        failure(error, "ERR_LEASE_UNSUPPORTED", 0); goto failed;
      }
    }
    if (!check_object(handle, true, error) ||
        ((role == DIRECTORY_INSTALLATION && end == length) &&
         !permissions(handle, directory->user, end != length, error))) goto failed;
    if (end == length) break;
    start = end == 7 ? 7 : end + 1;
    end = start;
    while (name[end] && name[end] != L'\\') end++;
    if (end == start) { failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed; }
  }
  for (size_t level = 0; level < directory->count; level++) {
    if (!object_identity(directory->handles[level], directory->identities[level], error)) goto failed;
  }
  return directory;
failed:
  {
    uint32_t closed = directory_close(directory);
    if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
  }
  return NULL;
}

struct directory *directory_pin_child(struct directory *parent, const char *name, struct directory_error *error) {
  if ((parent->role != DIRECTORY_PRIVATE && parent->role != DIRECTORY_INSTALLATION) || !child_name(name) || directory_depth(parent) >= DIRECTORY_DEPTH_LIMIT) {
    failure(error, "ERR_LEASE_ARGUMENT", 0); return NULL;
  }
  wchar_t wide[LEAF_BYTES + 1];
  int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, wide, LEAF_BYTES + 1);
  if (units < 2) { failure(error, "ERR_LEASE_ARGUMENT", GetLastError()); return NULL; }
  struct directory *child = calloc(1, sizeof(*child));
  if (!child) { failure(error, "ERR_LEASE_ALLOCATION", 0); return NULL; }
  child->role = parent->role;
  child->parent = parent;
  if (!user_security(child, error)) goto failed;
  UNICODE_STRING relative = {(USHORT)((units - 1) * sizeof(wchar_t)), (USHORT)(units * sizeof(wchar_t)), wide};
  OBJECT_ATTRIBUTES attributes = {
    .Length = sizeof(attributes), .RootDirectory = parent->handles[parent->count - 1],
    .ObjectName = &relative, .Attributes = OBJ_CASE_INSENSITIVE,
  };
  IO_STATUS_BLOCK status;
  HANDLE handle = INVALID_FILE;
  NTSTATUS result = NtCreateFile(&handle, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | (parent->role == DIRECTORY_INSTALLATION ? READ_CONTROL : 0) | SYNCHRONIZE,
                                &attributes, &status, NULL, FILE_ATTRIBUTE_DIRECTORY,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN,
                                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                                NULL, 0);
  if (result < 0) { failure(error, "ERR_LEASE_NATIVE", RtlNtStatusToDosError(result)); goto failed; }
  child->handles[child->count++] = handle;
  if (!check_object(handle, true, error) || !record_permissions(child, handle, error) ||
      !object_identity(handle, child->identities[0], error)) goto failed;
  return child;
failed:
  {
    uint32_t closed = directory_close(child);
    if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
  }
  return NULL;
}

enum record_access { RECORD_READ, RECORD_LOCK, RECORD_CREATE };

static file_handle open_relative_file(struct directory *directory, const char *name,
                                     enum record_access access, struct directory_error *error) {
  if (!leaf_name(name)) { failure(error, "ERR_LEASE_ARGUMENT", 0); return INVALID_FILE; }
  size_t length = strlen(name);
  wchar_t wide[LEAF_BYTES + 1] = {0};
  for (size_t i = 0; i < length; i++) wide[i] = (wchar_t)name[i];
  UNICODE_STRING relative = {(USHORT)(length * sizeof(wchar_t)),
                             (USHORT)((length + 1) * sizeof(wchar_t)), wide};
  OBJECT_ATTRIBUTES attributes = {
    .Length = sizeof(attributes), .RootDirectory = directory->handles[directory->count - 1],
    .ObjectName = &relative, .Attributes = OBJ_CASE_INSENSITIVE, .SecurityDescriptor = directory->security,
  };
  IO_STATUS_BLOCK status;
  HANDLE file = INVALID_FILE;
  // Resolve against the retained directory, not its possibly replaced pathname.
  // Preserve synchronous IO and never truncate existing coordination files.
  NTSTATUS result = NtCreateFile(&file, (FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE) |
                                (directory->role == DIRECTORY_INSTALLATION || (directory->role == DIRECTORY_PROJECT && access != RECORD_READ) ? READ_CONTROL : 0) |
                                (access != RECORD_READ ? GENERIC_WRITE : 0),
                                &attributes, &status, NULL, FILE_ATTRIBUTE_NORMAL,
                                FILE_SHARE_READ | (access == RECORD_LOCK ? FILE_SHARE_WRITE : 0),
                                access == RECORD_CREATE ? FILE_CREATE : access == RECORD_LOCK ? FILE_OPEN_IF : FILE_OPEN,
                                FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
                                (access == RECORD_CREATE ? FILE_WRITE_THROUGH : 0),
                                NULL, 0);
  if (result < 0) {
    DWORD status = RtlNtStatusToDosError(result);
    const char *code = access == RECORD_READ && status == ERROR_FILE_NOT_FOUND ? "ERR_LEASE_MISSING" :
      access == RECORD_CREATE && (status == ERROR_FILE_EXISTS || status == ERROR_ALREADY_EXISTS) ?
      "ERR_LEASE_EXISTS" : "ERR_LEASE_NATIVE";
    failure(error, code, status);
    return INVALID_FILE;
  }
  if (!check_object(file, false, error) || ((access != RECORD_READ || directory->role == DIRECTORY_INSTALLATION) && !record_permissions(directory, file, error))) {
    uint32_t closed = close_handle(file);
    if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
    return INVALID_FILE;
  }
  return file;
}

file_handle directory_file(struct directory *directory, const char *name, struct directory_error *error) {
  return open_relative_file(directory, name, RECORD_LOCK, error);
}

bool directory_create(struct directory *directory, const char *name, const unsigned char *buffer,
                      size_t length, struct directory_error *error) {
  if (!length || length > DIRECTORY_READ_LIMIT) { failure(error, "ERR_LEASE_ARGUMENT", 0); return false; }
  HANDLE file = open_relative_file(directory, name, RECORD_CREATE, error);
  if (file == INVALID_FILE) return false;
  bool valid = false;
  size_t offset = 0;
  while (offset < length) {
    DWORD written = 0;
    if (!WriteFile(file, buffer + offset, (DWORD)(length - offset), &written, NULL)) {
      failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto done;
    }
    if (!written) { failure(error, "ERR_LEASE_NATIVE", ERROR_WRITE_FAULT); goto done; }
    offset += written;
  }
  if (!check_object(file, false, error) || !record_permissions(directory, file, error)) goto done;
  if (!FlushFileBuffers(file)) { failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto done; }
  valid = true;
done:
  {
    uint32_t closed = close_handle(file);
    if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  }
  // Failed/partial publications remain present; retry must not replace them.
  return valid;
}

bool directory_read(struct directory *directory, const char *name, unsigned char *buffer,
                    size_t limit, size_t *length, bool *missing, struct directory_error *error) {
  *length = 0;
  *missing = false;
  if (!limit || limit > DIRECTORY_READ_LIMIT) { failure(error, "ERR_LEASE_ARGUMENT", 0); return false; }
  HANDLE file = open_relative_file(directory, name, RECORD_READ, error);
  if (file == INVALID_FILE) {
    *missing = !strcmp(error->code, "ERR_LEASE_MISSING");
    return *missing;
  }
  bool valid = false;
  FILE_BASIC_INFO before, after;
  FILE_STANDARD_INFO size_before, size_after;
  if (!GetFileInformationByHandleEx(file, FileBasicInfo, &before, sizeof(before)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &size_before, sizeof(size_before))) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto done;
  }
  if (size_before.EndOfFile.QuadPart < 0 || (uint64_t)size_before.EndOfFile.QuadPart > limit) {
    failure(error, "ERR_LEASE_SIZE", 0); goto done;
  }
  while (*length <= limit) {
    DWORD count = 0;
    if (!ReadFile(file, buffer + *length, (DWORD)(limit + 1 - *length), &count, NULL)) {
      failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto done;
    }
    if (!count) break;
    *length += count;
  }
  if (*length > limit) { failure(error, "ERR_LEASE_SIZE", 0); goto done; }
  if (!GetFileInformationByHandleEx(file, FileBasicInfo, &after, sizeof(after)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &size_after, sizeof(size_after))) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto done;
  }
  if (size_before.EndOfFile.QuadPart != size_after.EndOfFile.QuadPart ||
      (uint64_t)size_after.EndOfFile.QuadPart != *length || size_after.DeletePending ||
      before.CreationTime.QuadPart != after.CreationTime.QuadPart ||
      before.LastWriteTime.QuadPart != after.LastWriteTime.QuadPart ||
      before.ChangeTime.QuadPart != after.ChangeTime.QuadPart || before.FileAttributes != after.FileAttributes) {
    failure(error, "ERR_LEASE_CHANGED", 0); goto done;
  }
  valid = check_object(file, false, error) && (directory->role != DIRECTORY_INSTALLATION || record_permissions(directory, file, error));
done:
  {
    uint32_t closed = close_handle(file);
    if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  }
  return valid;
}
#else
static bool permissions(int descriptor, bool ancestor, struct directory_error *error) {
  struct stat info;
  struct statfs volume;
  if (fstatfs(descriptor, &volume)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return false; }
  if (!(volume.f_flags & MNT_LOCAL)) { failure(error, "ERR_LEASE_UNSUPPORTED", 0); return false; }
  filesec_t security = filesec_init();
  acl_t acl = NULL;
  int present = 0;
  if (!security) { failure(error, "ERR_LEASE_ALLOCATION", 0); return false; }
  if (fstatx_np(descriptor, &info, security) || filesec_query_property(security, FILESEC_ACL, &present) ||
      (present && filesec_get_property(security, FILESEC_ACL, &acl))) {
    uint32_t status = (uint32_t)errno;
    filesec_free(security);
    failure(error, "ERR_LEASE_NATIVE", status); return false;
  }
  filesec_free(security);
  if (!darwin_directory_mode_trusted(info.st_uid, info.st_gid, info.st_mode, ancestor, geteuid())) {
    if (acl) acl_free(acl);
    failure(error, "ERR_LEASE_PERMISSION", 0); return false;
  }
  // No extended ACL is a positive filesec property observation, not an ignored
  // errno from a failed lookup (acl_get_fd_np conflates absence with failure).
  if (!present) return true;
  if (!acl) { failure(error, "ERR_LEASE_PERMISSION", 0); return false; }
  uuid_t current, root;
  bool valid = mbr_uid_to_uuid(geteuid(), current) == 0 && mbr_uid_to_uuid(0, root) == 0;
  const acl_perm_t writes[] = {ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_DELETE, ACL_DELETE_CHILD,
    ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER};
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  while (valid && result == 0) {
    acl_tag_t tag;
    acl_permset_t set;
    acl_flagset_t flags;
    if (acl_get_tag_type(entry, &tag) || acl_get_permset(entry, &set) || acl_get_flagset_np(entry, &flags) ||
        (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY)) { valid = false; break; }
    int inherit_only = acl_get_flag_np(flags, ACL_ENTRY_ONLY_INHERIT);
    if (inherit_only < 0) { valid = false; break; }
    if (tag == ACL_EXTENDED_ALLOW && !inherit_only) {
      void *principal = acl_get_qualifier(entry);
      if (!principal) { valid = false; break; }
      bool trusted = !memcmp(principal, current, sizeof(current)) || !memcmp(principal, root, sizeof(root));
      acl_free(principal);
      for (size_t i = 0; !trusted && i < sizeof(writes)/sizeof(writes[0]); i++)
        if (acl_get_perm_np(set, writes[i]) != 0) valid = false;
    }
    result = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  // Darwin returns -1 / EINVAL at the end of an ACL, not POSIX's zero sentinel.
  if (valid && (result != -1 || errno != EINVAL)) valid = false;
  acl_free(acl);
  if (!valid) failure(error, "ERR_LEASE_PERMISSION", 0);
  return valid;
}

// Project ACLs describe access, not an application-private trust boundary.
// Keep local-volume qualification independently of the private ACL policy.
static bool role_permissions(int descriptor, bool ancestor, enum directory_role role,
                             struct directory_error *error) {
  if (role == DIRECTORY_PRIVATE) return permissions(descriptor, ancestor, error);
  struct statfs volume;
  if (fstatfs(descriptor, &volume)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return false; }
  if (!(volume.f_flags & MNT_LOCAL)) { failure(error, "ERR_LEASE_UNSUPPORTED", 0); return false; }
  return true;
}

static struct directory *open_directory(const char *path, bool create, bool aliases, enum directory_role role, struct directory_error *error) {
  size_t length = strlen(path);
  if (!length || length >= PATH_UNITS || path[0] != '/') { failure(error, "ERR_LEASE_ARGUMENT", 0); return NULL; }
  struct directory *directory = calloc(1, sizeof(*directory));
  char *name = strdup(path);
  if (!directory || !name) { free(directory); free(name); failure(error, "ERR_LEASE_ALLOCATION", 0); return NULL; }
  directory->path = strdup(path);
  if (!directory->path) { free(directory); free(name); failure(error, "ERR_LEASE_ALLOCATION", 0); return NULL; }
  directory->role = role;
  int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto failed; }
  directory->handles[directory->count++] = descriptor;
  if (!role_permissions(descriptor, length > 1, role, error)) goto failed;
  char *cursor = name + 1;
  while (*cursor) {
    char *end = strchr(cursor, '/');
    bool final = end == NULL;
    if (end) *end = 0;
    if (!*cursor || !strcmp(cursor, ".") || !strcmp(cursor, "..") || directory->count == DIRECTORY_DEPTH_LIMIT) {
      failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed;
    }
    if (create && final && mkdirat(descriptor, cursor, 0700) != 0 && errno != EEXIST) {
      failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto failed;
    }
    descriptor = openat(descriptor, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) {
      failure(error, errno == ENOENT ? "ERR_LEASE_MISSING" : "ERR_LEASE_DIRECTORY", (uint32_t)errno);
      goto failed;
    }
    directory->handles[directory->count++] = descriptor;
    if (!role_permissions(descriptor, !final, role, error)) goto failed;
    if (final) break;
    cursor = end + 1;
    if (!*cursor) { failure(error, "ERR_LEASE_ARGUMENT", 0); goto failed; }
  }
  for (size_t level = 0; level < directory->count; level++) {
    struct stat identity;
    if (fstat(directory->handles[level], &identity)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto failed; }
    snprintf(directory->identities[level], IDENTITY_BYTES, "posix:%016" PRIx64 ":%016" PRIx64,
             (uint64_t)identity.st_dev, (uint64_t)identity.st_ino);
  }
  // A firmlink has both logical and physical ancestry. Query both spellings
  // from the actual handle, validate each no-follow walk, and bind the leaf back
  // to this object. Secondary walks never recursively expand aliases.
  if (aliases) {
    char physical_path[PATH_UNITS], logical_path[PATH_UNITS];
    if (fcntl(descriptor, F_GETPATH_NOFIRMLINK, physical_path) < 0 ||
        fcntl(descriptor, F_GETPATH, logical_path) < 0) {
      failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto failed;
    }
    if (strcmp(path, physical_path)) {
      directory->physical = open_directory(physical_path, false, false, role, error);
      if (!directory->physical) goto failed;
      if (strcmp(directory_identity(directory), directory_identity(directory->physical))) {
        failure(error, "ERR_LEASE_DIRECTORY", 0); goto failed;
      }
    }
    if (strcmp(path, logical_path) && strcmp(physical_path, logical_path)) {
      directory->logical = open_directory(logical_path, false, false, role, error);
      if (!directory->logical) goto failed;
      if (strcmp(directory_identity(directory), directory_identity(directory->logical))) {
        failure(error, "ERR_LEASE_DIRECTORY", 0); goto failed;
      }
    }
  }
  free(name);
  return directory;
failed:
  free(name);
  {
    // A failed alias walk may already have hit an uncertain close. Do not
    // release the surrounding chain after receiving that result.
    if (!error->code || strcmp(error->code, "ERR_LEASE_RELEASE")) {
      uint32_t closed = directory_close(directory);
      if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
    }
  }
  return NULL;
}

bool directory_child(struct directory *directory, const char *name, char *encoded, struct directory_error *error) {
  if (!child_name(name)) { failure(error, "ERR_LEASE_ARGUMENT", 0); return false; }
  int parent = directory->handles[directory->count - 1];
  if (mkdirat(parent, name, 0700) != 0 && errno != EEXIST) {
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return false;
  }
  int child = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (child < 0) { failure(error, "ERR_LEASE_DIRECTORY", (uint32_t)errno); return false; }
  bool valid = role_permissions(child, false, directory->role, error);
  struct stat identity;
  if (valid && fstat(child, &identity)) {
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); valid = false;
  }
  if (valid) snprintf(encoded, IDENTITY_BYTES, "posix:%016" PRIx64 ":%016" PRIx64,
                      (uint64_t)identity.st_dev, (uint64_t)identity.st_ino);
  uint32_t closed = close_handle(child);
  if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  return valid;
}

struct directory *directory_open_role(const char *path, bool create, enum directory_role role, struct directory_error *error) {
  if (role != DIRECTORY_PRIVATE && role != DIRECTORY_PROJECT) { failure(error, "ERR_LEASE_ARGUMENT", 0); return NULL; }
  return open_directory(path, create, true, role, error);
}

struct directory *directory_pin_child(struct directory *parent, const char *name, struct directory_error *error) {
  (void)parent;
  (void)name;
  failure(error, "ERR_LEASE_UNSUPPORTED", 0);
  return NULL;
}

file_handle directory_file(struct directory *directory, const char *name, struct directory_error *error) {
  if (!leaf_name(name)) { failure(error, "ERR_LEASE_ARGUMENT", 0); return INVALID_FILE; }
  int parent = directory->handles[directory->count - 1];
  int flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
  /* Separate creation from opening an existing permanent slot. Concurrent
     Darwin O_CREAT opens can return ENOENT. Only EEXIST permits another open;
     a slot removed in between must fail rather than be recreated. */
  int file = openat(parent, name, flags | O_CREAT | O_EXCL, 0600);
  if (file < 0 && errno == EEXIST) file = openat(parent, name, flags);
  if (file < 0) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return INVALID_FILE; }
  struct stat identity;
  if (fstat(file, &identity) || !S_ISREG(identity.st_mode) || identity.st_nlink != 1) {
    failure(error, "ERR_LEASE_FILE", 0);
    uint32_t closed = close_handle(file);
    if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
    return INVALID_FILE;
  }
  if (!permissions(file, false, error)) {
    uint32_t closed = close_handle(file);
    if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
    return INVALID_FILE;
  }
  return file;
}

bool directory_create(struct directory *directory, const char *name, const unsigned char *buffer,
                      size_t length, struct directory_error *error) {
  if (!leaf_name(name) || !length || length > DIRECTORY_READ_LIMIT) {
    failure(error, "ERR_LEASE_ARGUMENT", 0); return false;
  }
  int parent = directory->handles[directory->count - 1];
  int file = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (file < 0) {
    failure(error, errno == EEXIST ? "ERR_LEASE_EXISTS" : "ERR_LEASE_NATIVE", (uint32_t)errno);
    return false;
  }
  bool valid = false;
  struct stat identity;
  if (fstat(file, &identity)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1) {
    failure(error, "ERR_LEASE_FILE", 0); goto done;
  }
  if (!permissions(file, false, error)) goto done;
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(file, buffer + offset, length - offset);
    if (written < 0) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
    if (!written) { failure(error, "ERR_LEASE_NATIVE", EIO); goto done; }
    offset += (size_t)written;
  }
  if (fstat(file, &identity)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1) {
    failure(error, "ERR_LEASE_FILE", 0); goto done;
  }
  if (!permissions(file, false, error)) goto done;
  if (fsync(file) || fsync(parent)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  valid = true;
done:
  {
    uint32_t closed = close_handle(file);
    if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  }
  return valid;
}

bool directory_read(struct directory *directory, const char *name, unsigned char *buffer,
                    size_t limit, size_t *length, bool *missing, struct directory_error *error) {
  *length = 0;
  *missing = false;
  if (!leaf_name(name) || !limit || limit > DIRECTORY_READ_LIMIT) {
    failure(error, "ERR_LEASE_ARGUMENT", 0); return false;
  }
  int file = openat(directory->handles[directory->count - 1], name,
                    O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (file < 0) {
    if (errno == ENOENT) { *missing = true; return true; }
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return false;
  }
  bool valid = false;
  struct stat before, after;
  if (fstat(file, &before)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1) {
    failure(error, "ERR_LEASE_FILE", 0); goto done;
  }
  if (!role_permissions(file, false, directory->role, error)) goto done;
  if (before.st_size < 0 || (uint64_t)before.st_size > limit) {
    failure(error, "ERR_LEASE_SIZE", 0); goto done;
  }
  while (*length <= limit) {
    ssize_t count = read(file, buffer + *length, limit + 1 - *length);
    if (count < 0) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
    if (!count) break;
    *length += (size_t)count;
  }
  if (*length > limit) { failure(error, "ERR_LEASE_SIZE", 0); goto done; }
  if (fstat(file, &after)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || (uint64_t)after.st_size != *length ||
      before.st_mode != after.st_mode || before.st_uid != after.st_uid || before.st_gid != after.st_gid ||
      after.st_nlink != 1 || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
      before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) {
    failure(error, "ERR_LEASE_CHANGED", 0); goto done;
  }
  valid = role_permissions(file, false, directory->role, error);
done:
  {
    uint32_t closed = close_handle(file);
    if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  }
  return valid;
}
#endif


#ifdef __APPLE__
static bool consume_namespace(struct directory *directory, struct directory_error *error) {
  struct directory *current = open_directory(directory->path, false, true, directory->role, error);
  if (!current) return false;
  bool valid = !strcmp(directory_identity(directory), directory_identity(current)) &&
               directory_depth(directory) == directory_depth(current);
  for (size_t index = 0; valid && index < directory_depth(directory); index++)
    valid = !strcmp(directory_ancestor(directory, index), directory_ancestor(current, index));
  uint32_t closed = directory_close(current);
  if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  if (!valid) failure(error, "ERR_LEASE_CHANGED", 0);
  return valid;
}

static bool consume_same_record(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino &&
    before->st_size == after->st_size && before->st_mode == after->st_mode &&
    before->st_uid == after->st_uid && before->st_gid == after->st_gid && after->st_nlink == 1 &&
    before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec &&
    before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec &&
    before->st_ctimespec.tv_sec == after->st_ctimespec.tv_sec &&
    before->st_ctimespec.tv_nsec == after->st_ctimespec.tv_nsec;
}
#endif

bool directory_consume(struct directory *directory, const char *name, const unsigned char *expected,
                       size_t length, uint64_t device, uint64_t inode, struct directory_error *error) {
#ifndef __APPLE__
  (void)directory; (void)name; (void)expected; (void)length; (void)device; (void)inode;
  failure(error, "ERR_LEASE_PLATFORM", 0);
  return false;
#else
  if (!leaf_name(name) || !expected || !length || length > DIRECTORY_READ_LIMIT) {
    failure(error, "ERR_LEASE_ARGUMENT", 0); return false;
  }
  if (!consume_namespace(directory, error)) return false;
  int parent = directory->handles[directory->count - 1];
  int file = openat(parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (file < 0) {
    failure(error, errno == ENOENT ? "ERR_LEASE_MISSING" : "ERR_LEASE_NATIVE", (uint32_t)errno);
    return false;
  }
  bool valid = false;
  unsigned char *observed = NULL;
  struct stat before, after, located;
  if (fstat(file, &before)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_uid != geteuid()) {
    failure(error, "ERR_LEASE_FILE", 0); goto done;
  }
  if (!permissions(file, false, error)) goto done;
  if (before.st_size <= 0 || (uint64_t)before.st_size > DIRECTORY_READ_LIMIT) {
    failure(error, "ERR_LEASE_SIZE", 0); goto done;
  }
  if ((uint64_t)before.st_dev != device || (uint64_t)before.st_ino != inode ||
      (uint64_t)before.st_size != length) {
    failure(error, "ERR_LEASE_CHANGED", 0); goto done;
  }
  observed = malloc(length + 1);
  if (!observed) { failure(error, "ERR_LEASE_ALLOCATION", 0); goto done; }
  size_t received = 0;
  while (received <= length) {
    ssize_t count = read(file, observed + received, length + 1 - received);
    if (count < 0) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
    if (!count) break;
    received += (size_t)count;
  }
  if (received != length || memcmp(observed, expected, length)) {
    failure(error, "ERR_LEASE_CHANGED", 0); goto done;
  }
  if (fstat(file, &after)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (!consume_same_record(&before, &after)) { failure(error, "ERR_LEASE_CHANGED", 0); goto done; }
  if (!permissions(file, false, error) || !consume_namespace(directory, error)) goto done;
  if (fstatat(parent, name, &located, AT_SYMLINK_NOFOLLOW)) {
    failure(error, "ERR_LEASE_CHANGED", (uint32_t)errno); goto done;
  }
  if (!consume_same_record(&after, &located)) { failure(error, "ERR_LEASE_CHANGED", 0); goto done; }
  if (unlinkat(parent, name, 0)) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done; }
  if (fsync(parent)) { failure(error, "ERR_LEASE_SYNC", (uint32_t)errno); goto done; }
  valid = consume_namespace(directory, error);
done:
  free(observed);
  {
    uint32_t closed = close_handle(file);
    if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  }
  return valid;
#endif
}

void directory_records_free(struct directory_records *records) {
  for (size_t i = 0; i < records->count; i++) free(records->items[i].data);
  free(records->items);
  records->items = NULL;
  records->count = 0;
}

static bool record_name(struct directory_records *records, const char *name, size_t entries,
                        struct directory_error *error) {
  if (!leaf_name(name)) { failure(error, "ERR_LEASE_ARGUMENT", 0); return false; }
  for (size_t i = 0; i < records->count; i++) {
    if (!strcmp(records->items[i].name, name)) {
      failure(error, "ERR_LEASE_CHANGED", 0); return false;
    }
  }
  if (records->count == entries) { failure(error, "ERR_LEASE_SIZE", 0); return false; }
  strcpy(records->items[records->count++].name, name);
  return true;
}

static bool record_names(struct directory *directory, size_t entries,
                         struct directory_records *records, struct directory_error *error) {
  file_handle parent = directory->handles[directory->count - 1];
#ifdef _WIN32
  // Empty relative NT name reopens the held object, not a path spelling.
  wchar_t empty[] = L"";
  UNICODE_STRING relative = {0, sizeof(empty), empty};
  OBJECT_ATTRIBUTES attributes = {
    .Length = sizeof(attributes), .RootDirectory = parent,
    .ObjectName = &relative, .Attributes = OBJ_CASE_INSENSITIVE,
  };
  IO_STATUS_BLOCK opened = {0};
  HANDLE listing = INVALID_FILE;
  NTSTATUS opening = NtCreateFile(&listing, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | (directory->role == DIRECTORY_INSTALLATION ? READ_CONTROL : 0) | SYNCHRONIZE,
                                  &attributes, &opened, NULL, FILE_ATTRIBUTE_DIRECTORY,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN,
                                  FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                                  NULL, 0);
  if (opening < 0) { failure(error, "ERR_LEASE_NATIVE", RtlNtStatusToDosError(opening)); return false; }
  bool valid = false;
  char identity[IDENTITY_BYTES];
  if (!check_object(listing, true, error) || (directory->role == DIRECTORY_INSTALLATION && !record_permissions(directory, listing, error)) ||
      !object_identity(listing, identity, error)) goto done;
  if (strcmp(identity, directory_identity(directory))) {
    failure(error, "ERR_LEASE_CHANGED", 0); goto done;
  }
  typedef NTSTATUS (NTAPI *query_directory)(HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK,
                                           PVOID, ULONG, FILE_INFORMATION_CLASS, BOOLEAN,
                                           PUNICODE_STRING, BOOLEAN);
  query_directory query = (query_directory)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryDirectoryFile");
  if (!query) { failure(error, "ERR_LEASE_NATIVE", GetLastError()); goto done; }
  enum { names_header = 12, names_buffer = names_header + DIRECTORY_NAME_BYTES * 2,
         names_information = 12 };
  _Alignas(8) unsigned char buffer[names_buffer];
  BOOLEAN restart = TRUE;
  unsigned dots = 0;
  for (;;) {
    IO_STATUS_BLOCK status = {0};
    NTSTATUS result = query(listing, NULL, NULL, NULL, &status, buffer, sizeof(buffer),
                            (FILE_INFORMATION_CLASS)names_information, TRUE, NULL, restart);
    restart = FALSE;
    if ((uint32_t)result == UINT32_C(0x80000006)) { valid = true; break; }
    if (result != 0) { failure(error, "ERR_LEASE_NATIVE", RtlNtStatusToDosError(result)); break; }
    if (status.Information < names_header || status.Information > sizeof(buffer)) {
      failure(error, "ERR_LEASE_CHANGED", 0); break;
    }
    uint32_t next, length;
    memcpy(&next, buffer, sizeof(next));
    memcpy(&length, buffer + 8, sizeof(length));
    if (next || !length || length % sizeof(wchar_t) || length > status.Information - names_header) {
      failure(error, "ERR_LEASE_CHANGED", 0); break;
    }
    char name[DIRECTORY_NAME_BYTES + 1];
    size_t units = length / sizeof(wchar_t);
    if (units > DIRECTORY_NAME_BYTES) { failure(error, "ERR_LEASE_ARGUMENT", 0); break; }
    bool ascii = true;
    for (size_t i = 0; i < units; i++) {
      uint16_t value;
      memcpy(&value, buffer + names_header + i * sizeof(value), sizeof(value));
      if (!value || value > 127) { ascii = false; break; }
      name[i] = (char)value;
    }
    if (!ascii) { failure(error, "ERR_LEASE_ARGUMENT", 0); break; }
    name[units] = 0;
    unsigned dot = !strcmp(name, ".") ? 1 : (!strcmp(name, "..") ? 2 : 0);
    if (dot) {
      if (dots & dot) { failure(error, "ERR_LEASE_CHANGED", 0); break; }
      dots |= dot;
      continue;
    }
    if (!record_name(records, name, entries, error)) break;
  }
done:
  {
    uint32_t closed = close_handle(listing);
    if (closed) { failure(error, "ERR_LEASE_RELEASE", closed); return false; }
  }
  return valid;
#else
  // A new open file description prevents sharing the retained pin's offset.
  int file = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (file < 0) { failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return false; }
  DIR *listing = fdopendir(file);
  if (!listing) {
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno);
    uint32_t closed = close_handle(file);
    if (closed) failure(error, "ERR_LEASE_RELEASE", closed);
    return false;
  }
  bool valid = false;
  struct stat before, actual;
  if (fstat(parent, &before) || fstat(file, &actual)) {
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); goto done;
  }
  if (before.st_dev != actual.st_dev || before.st_ino != actual.st_ino) {
    failure(error, "ERR_LEASE_CHANGED", 0); goto done;
  }
  if (!role_permissions(file, false, directory->role, error)) goto done;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(listing);
    if (!entry) {
      if (errno) failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno);
      else valid = true;
      break;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (!record_name(records, entry->d_name, entries, error)) break;
  }
done:
  if (closedir(listing)) { failure(error, "ERR_LEASE_RELEASE", (uint32_t)errno); return false; }
  return valid;
#endif
}

bool directory_list(struct directory *directory, size_t entries, size_t limit,
                    struct directory_records *records, struct directory_error *error) {
  *records = (struct directory_records){0};
  if (!entries || entries > DIRECTORY_RECORD_LIMIT || !limit || limit > DIRECTORY_READ_LIMIT) {
    failure(error, "ERR_LEASE_ARGUMENT", 0); return false;
  }
  records->items = calloc(entries, sizeof(*records->items));
  if (!records->items) { failure(error, "ERR_LEASE_ALLOCATION", 0); return false; }
  if (!record_names(directory, entries, records, error)) goto failed;
  unsigned char *buffer = malloc(limit + 1);
  if (!buffer) { failure(error, "ERR_LEASE_ALLOCATION", 0); goto failed; }
  size_t total = 0;
  for (size_t i = 0; i < records->count; i++) {
    struct directory_record *record = &records->items[i];
    bool missing = false;
    if (!directory_read(directory, record->name, buffer, limit, &record->length, &missing, error)) {
      free(buffer); goto failed;
    }
    if (missing) { free(buffer); failure(error, "ERR_LEASE_CHANGED", 0); goto failed; }
    if (record->length > limit - total) {
      free(buffer); failure(error, "ERR_LEASE_SIZE", 0); goto failed;
    }
    total += record->length;
    record->data = malloc(record->length ? record->length : 1);
    if (!record->data) { free(buffer); failure(error, "ERR_LEASE_ALLOCATION", 0); goto failed; }
    memcpy(record->data, buffer, record->length);
  }
  free(buffer);
  return true;
failed:
  directory_records_free(records);
  return false;
}

struct directory *directory_open(const char *path, bool create, struct directory_error *error) {
  return directory_open_role(path, create, DIRECTORY_PRIVATE, error);
}

/* Reclamation keeps admission-a forever. Every cooperating legacy consumer
   holds it before opening any sibling, including the open-before-flock gap. */
enum reclaim_slot { RECLAIM_ERROR, RECLAIM_MISSING, RECLAIM_HELD, RECLAIM_BUSY, RECLAIM_RETAINED };
enum { RECLAIM_GUARD, RECLAIM_ADMISSION, RECLAIM_OCCUPANCY, RECLAIM_OCCUPANCY_SECOND, RECLAIM_SLOTS };
static const char *const reclaim_suffixes[RECLAIM_SLOTS] = {
  "-admission-a", "-admission-b", "-occupancy-a", "-occupancy-b"
};

static bool reclaim_identity(const char *identity) {
  size_t prefix, tail;
  if (!strncmp(identity, "posix-", 6)) { prefix = 6; tail = 16; }
  else if (!strncmp(identity, "windows-", 8)) { prefix = 8; tail = 32; }
  else return false;
  size_t separator = prefix + 16;
  if (strlen(identity) != separator + 1 + tail || identity[separator] != '-') return false;
  for (size_t i = prefix; identity[i]; i++) {
    if (i == separator) continue;
    if (!((identity[i] >= '0' && identity[i] <= '9') || (identity[i] >= 'a' && identity[i] <= 'f')))
      return false;
  }
  return true;
}

static enum reclaim_slot reclaim_validate(struct directory *directory, file_handle file,
                                           const char *name, struct directory_error *error) {
#ifdef _WIN32
  (void)name;
  if (!check_object(file, false, error) || !record_permissions(directory, file, error))
    return !strcmp(error->code, "ERR_LEASE_NATIVE") ? RECLAIM_ERROR : RECLAIM_RETAINED;
  LARGE_INTEGER size;
  if (!GetFileSizeEx(file, &size)) {
    failure(error, "ERR_LEASE_NATIVE", GetLastError()); return RECLAIM_ERROR;
  }
  return size.QuadPart == 0 ? RECLAIM_HELD : RECLAIM_RETAINED;
#else
  struct stat owned, named;
  if (fstat(file, &owned) != 0) {
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return RECLAIM_ERROR;
  }
  if (!S_ISREG(owned.st_mode) || owned.st_nlink != 1 || owned.st_size != 0) return RECLAIM_RETAINED;
  if (!permissions(file, false, error))
    return !strcmp(error->code, "ERR_LEASE_PERMISSION") ? RECLAIM_RETAINED : RECLAIM_ERROR;
  if (fstatat(directory->handles[directory->count - 1], name, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return RECLAIM_RETAINED;
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return RECLAIM_ERROR;
  }
  if (owned.st_dev != named.st_dev || owned.st_ino != named.st_ino ||
      !S_ISREG(named.st_mode) || named.st_nlink != 1 || named.st_size != 0) return RECLAIM_RETAINED;
  return RECLAIM_HELD;
#endif
}

static enum reclaim_slot reclaim_open(struct directory *directory, const char *name, bool deleting,
                                       file_handle *file, struct directory_error *error) {
  *file = INVALID_FILE;
#ifdef _WIN32
  size_t length = strlen(name);
  wchar_t wide[LEAF_BYTES + 1] = {0};
  for (size_t i = 0; i < length; i++) wide[i] = (wchar_t)name[i];
  UNICODE_STRING relative = {(USHORT)(length * sizeof(wchar_t)),
                             (USHORT)((length + 1) * sizeof(wchar_t)), wide};
  OBJECT_ATTRIBUTES attributes = {
    .Length = sizeof(attributes), .RootDirectory = directory->handles[directory->count - 1],
    .ObjectName = &relative, .Attributes = OBJ_CASE_INSENSITIVE,
  };
  IO_STATUS_BLOCK status;
  NTSTATUS opened = NtCreateFile(file, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE |
                                 (deleting ? DELETE : 0), &attributes, &status, NULL, FILE_ATTRIBUTE_NORMAL,
                                 deleting ? 0 : FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN,
                                 FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                                 NULL, 0);
  if (opened < 0) {
    *file = INVALID_FILE;
    DWORD code = RtlNtStatusToDosError(opened);
    if (code == ERROR_FILE_NOT_FOUND) return RECLAIM_MISSING;
    if (code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION || code == ERROR_DELETE_PENDING)
      return RECLAIM_BUSY;
    if (code == ERROR_ACCESS_DENIED || code == ERROR_CANT_ACCESS_FILE) return RECLAIM_RETAINED;
    failure(error, "ERR_LEASE_NATIVE", code); return RECLAIM_ERROR;
  }
#else
  (void)deleting;
  *file = openat(directory->handles[directory->count - 1], name,
                 O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (*file == INVALID_FILE) {
    if (errno == ENOENT) return RECLAIM_MISSING;
    if (errno == ELOOP || errno == EISDIR || errno == EACCES || errno == EPERM) return RECLAIM_RETAINED;
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return RECLAIM_ERROR;
  }
#endif
  enum reclaim_slot valid = reclaim_validate(directory, *file, name, error);
  if (valid != RECLAIM_HELD) return valid;
#ifdef _WIN32
  OVERLAPPED overlap = {0};
  if (!LockFileEx(*file, LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlap)) {
    DWORD code = GetLastError();
    if (code == ERROR_LOCK_VIOLATION) return RECLAIM_BUSY;
    failure(error, "ERR_LEASE_NATIVE", code); return RECLAIM_ERROR;
  }
#else
  if (flock(*file, LOCK_NB | LOCK_EX) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) return RECLAIM_BUSY;
    failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); return RECLAIM_ERROR;
  }
#endif
  return reclaim_validate(directory, *file, name, error);
}

static bool reclaim_close(file_handle *file, struct directory_error *error) {
  if (*file == INVALID_FILE) return true;
  file_handle held = *file;
  *file = INVALID_FILE;
  uint32_t code = close_handle(held);
  if (!code) return true;
  failure(error, "ERR_LEASE_RELEASE", code);
  return false;
}

bool directory_reclaim(struct directory *directory, const char *identity,
                       struct directory_reclamation *result, struct directory_error *error) {
  memset(result, 0, sizeof(*result));
  if (!reclaim_identity(identity) || directory->role != DIRECTORY_PRIVATE) {
    failure(error, "ERR_LEASE_ARGUMENT", 0); return false;
  }
  char names[RECLAIM_SLOTS][LEAF_BYTES + 1];
  file_handle handles[RECLAIM_SLOTS];
  for (size_t i = 0; i < RECLAIM_SLOTS; i++) {
    snprintf(names[i], sizeof(names[i]), "%s%s", identity, reclaim_suffixes[i]);
    handles[i] = INVALID_FILE;
  }
  /* Do not perturb admission for a domain already known to be running. The
     probe is released before admission to preserve the established lock order. */
  file_handle probe = INVALID_FILE;
  enum reclaim_slot state = reclaim_open(directory, names[RECLAIM_OCCUPANCY], false, &probe, error);
  if (!reclaim_close(&probe, error)) return false;
  if (state == RECLAIM_ERROR) return false;
  if (state == RECLAIM_BUSY) { result->busy = true; return true; }
  if (state == RECLAIM_RETAINED) { result->retained = true; return true; }
  bool valid = true;
  for (size_t i = 0; i < RECLAIM_SLOTS; i++) {
    state = reclaim_open(directory, names[i], i != RECLAIM_GUARD, &handles[i], error);
    if (state == RECLAIM_HELD || (state == RECLAIM_MISSING && i != RECLAIM_GUARD)) continue;
    result->busy = state == RECLAIM_BUSY;
    result->retained = state == RECLAIM_RETAINED || state == RECLAIM_MISSING;
    valid = state != RECLAIM_ERROR;
    goto done;
  }
  /* Validate the complete group before deleting anything. Candidate descriptors
     stay exclusively held until deletion and close; the guard is closed last. */
  for (size_t i = 0; i < RECLAIM_SLOTS; i++) {
    if (handles[i] == INVALID_FILE) continue;
    state = reclaim_validate(directory, handles[i], names[i], error);
    if (state != RECLAIM_HELD) {
      result->retained = state == RECLAIM_RETAINED;
      valid = state != RECLAIM_ERROR;
      goto done;
    }
  }
  for (size_t i = RECLAIM_ADMISSION; i < RECLAIM_SLOTS; i++) {
    if (handles[i] == INVALID_FILE) continue;
    state = reclaim_validate(directory, handles[i], names[i], error);
    if (state != RECLAIM_HELD) {
      result->retained = state == RECLAIM_RETAINED;
      valid = state != RECLAIM_ERROR;
      goto done;
    }
#ifdef _WIN32
    FILE_DISPOSITION_INFO disposition = {.DeleteFile = TRUE};
    if (!SetFileInformationByHandle(handles[i], FileDispositionInfo, &disposition, sizeof(disposition))) {
      failure(error, "ERR_LEASE_NATIVE", GetLastError()); valid = false; goto done;
    }
#else
    if (unlinkat(directory->handles[directory->count - 1], names[i], 0) != 0) {
      failure(error, "ERR_LEASE_NATIVE", (uint32_t)errno); valid = false; goto done;
    }
#endif
    result->removed++;
  }
done:
  /* A failed close is indeterminate: never retry it and never drop any remaining
     sibling or permanent guard. N-API poisons the directory pin as well. */
  for (size_t i = RECLAIM_SLOTS; i > 0; i--)
    if (!reclaim_close(&handles[i - 1], error)) return false;
  return valid;
}
