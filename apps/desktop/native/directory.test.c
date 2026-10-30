// Close-boundary contracts: real OS handles, synthetic directory-chain topology.
// Substitution exists only in this test translation unit, never in lease.node.
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <stdbool.h>
static bool capture_locks;
static size_t captured_count;
#ifdef _WIN32
#include <windows.h>
static HANDLE captured_locks[8];
static BOOL WINAPI captured_lock(HANDLE file, DWORD flags, DWORD reserved, DWORD low, DWORD high, LPOVERLAPPED overlap) {
  BOOL result = LockFileEx(file, flags, reserved, low, high, overlap);
  if (result && capture_locks && captured_count < 8) captured_locks[captured_count++] = file;
  return result;
}
#define LockFileEx captured_lock
static size_t calls, fail_at;
static BOOL WINAPI interrupted_close(HANDLE handle) {
  BOOL result = CloseHandle(handle);
  if (++calls == fail_at) { SetLastError(ERROR_OPERATION_ABORTED); return FALSE; }
  return result;
}
#define CloseHandle interrupted_close
#else
#include <unistd.h>
#include <fcntl.h>
#include <sys/file.h>
static int captured_locks[8];
static int captured_lock(int file, int operation) {
  int result = flock(file, operation);
  if (!result && capture_locks && captured_count < 8) captured_locks[captured_count++] = file;
  return result;
}
#define flock captured_lock
static size_t calls, fail_at;
static int interrupted_close(int handle) {
  int result = close(handle);
  if (++calls == fail_at) { errno = EINTR; return -1; }
  return result;
}
#define close interrupted_close
#endif
#include "directory.c"

#define CHAIN_HANDLES 2
#define TOTAL_HANDLES (CHAIN_HANDLES * 3)
static file_handle ordered[TOTAL_HANDLES];
static size_t total;

static struct directory *chain(void) {
  struct directory *value = calloc(1, sizeof(*value));
  if (!value) exit(2);
  for (size_t i = 0; i < CHAIN_HANDLES; i++) {
#ifdef _WIN32
    file_handle handle = CreateFileW(L".", FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS, NULL);
#else
    file_handle handle = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
#endif
    if (handle == INVALID_FILE) exit(3);
    value->handles[value->count++] = handle;
  }
  return value;
}

static void collect(struct directory *value) {
  if (value->physical) collect(value->physical);
  if (value->logical) collect(value->logical);
  for (size_t i = value->count; i; i--) ordered[total++] = value->handles[i - 1];
}

#ifdef _WIN32
// Real Windows ACLs: product data trusts OS access, executable roots do not.
static bool data_access_contract(void) {
  struct directory account = {0};
  struct directory_error error = {0};
  if (!user_security(&account, &error)) return false;
  LPWSTR user = NULL;
  if (!ConvertSidToStringSidW(account.user, &user)) return false;
  wchar_t sddl[512];
  swprintf(sddl, 512, L"O:%lsD:P(A;OICI;FA;;;%ls)(A;OICI;FA;;;SY)(A;OICI;GRGW;;;WD)", user, user);
  PSECURITY_DESCRIPTOR shared = NULL, denied = NULL;
  bool valid = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &shared, NULL);
  swprintf(sddl, 512, L"D:P(D;;GW;;;WD)(A;;FA;;;%ls)(A;;FA;;;SY)", user);
  valid = valid && ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &denied, NULL);
  LocalFree(user);
  char name[96], path[4096], record[4096];
  snprintf(name, sizeof(name), "directory-data-%lu", GetCurrentProcessId());
  SECURITY_ATTRIBUTES security = {sizeof(security), shared, FALSE};
  bool created = valid && CreateDirectoryA(name, &security);
  valid = created && GetFullPathNameA(name, sizeof(path), path, NULL);
  struct directory *data = valid ? directory_open(path, false, &error) : NULL;
  valid = valid && data;
  if (data) {
    unsigned char bytes[65]; size_t length; bool missing;
    valid = valid && directory_read(data, "storage-config.json", bytes, 64, &length, &missing, &error) && missing;
    valid = valid && directory_create(data, "record", (const unsigned char *)"kept", 4, &error);
    snprintf(record, sizeof(record), "%s/record", name);
    valid = valid && SetFileSecurityA(record, DACL_SECURITY_INFORMATION, shared);
    valid = valid && directory_read(data, "record", bytes, 64, &length, &missing, &error) && !missing && length == 4;
    HANDLE file = valid ? directory_file(data, "record", &error) : INVALID_FILE;
    valid = valid && file != INVALID_FILE;
    if (file != INVALID_FILE) valid = close_handle(file) == 0 && valid;
    valid = valid && SetFileSecurityA(record, DACL_SECURITY_INFORMATION, denied);
    file = directory_file(data, "record", &error);
    valid = valid && file == INVALID_FILE && error.system == ERROR_ACCESS_DENIED;
    if (file != INVALID_FILE) close_handle(file);
    valid = directory_close(data) == 0 && valid;
    struct directory *execution = directory_open_role(path, false, DIRECTORY_INSTALLATION, &error);
    valid = valid && !execution && !strcmp(error.code, "ERR_LEASE_PERMISSION");
    if (execution) directory_close(execution);
    DeleteFileA(record);
  }
  if (created) valid = RemoveDirectoryA(name) && valid;
  if (shared) LocalFree(shared);
  if (denied) LocalFree(denied);
  free(account.user);
  LocalFree(account.security);
  printf("Windows user-data ACL / real access denial / execution rejection: %s\n", valid ? "PASS" : "FAIL");
  return valid;
}

static bool owner_rights_contract(void) {
  struct directory account = {0};
  struct directory_error error = {0};
  if (!user_security(&account, &error)) return false;
  PSID owner = NULL;
  BOOL defaulted = FALSE, present = FALSE;
  PACL acl = NULL;
  bool descriptor_valid = GetSecurityDescriptorOwner(account.security, &owner, &defaulted) &&
      owner && EqualSid(owner, account.user) &&
      GetSecurityDescriptorDacl(account.security, &present, &acl, &defaulted) &&
      present && acl && acl->AceCount == 2;
  bool user_allowed = false, system_allowed = false;
  for (DWORD i = 0; descriptor_valid && i < acl->AceCount; i++) {
    void *entry = NULL;
    if (!GetAce(acl, i, &entry)) { descriptor_valid = false; break; }
    ACCESS_ALLOWED_ACE *ace = entry;
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        ace->Mask != FILE_ALL_ACCESS) { descriptor_valid = false; break; }
    PSID principal = &ace->SidStart;
    if (EqualSid(principal, account.user)) user_allowed = true;
    else if (IsWellKnownSid(principal, WinLocalSystemSid)) system_allowed = true;
    else descriptor_valid = false;
  }
  if (!descriptor_valid || !user_allowed || !system_allowed) {
    free(account.user);
    LocalFree(account.security);
    return false;
  }
  const wchar_t *descriptors[] = {
    L"D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
    L"D:P(D;;WD;;;OW)(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
    L"D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;WD)",
    L"D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;S-1-15-3-1)",
    L"D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;S-1-15-3-2968813833-811790644-2202111208-3784096404-1081847329-2708967783-1438471679)",
    L"D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;S-1-15-3-1)(A;;FA;;;WD)",
    L"D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;S-1-15-2-1)",
  };
  const bool endpoint_allowed[] = {true, true, false, false, false, false, false};
  /* Capability writers follow the same ordinary-ancestor policy as other
     untrusted writers; only an actual physical volume gets its narrow role. */
  const bool ancestor_allowed[] = {true, true, false, false, false, false, false};
  bool valid = true;
  for (size_t i = 0; valid && i < sizeof(descriptors) / sizeof(descriptors[0]); i++) {
    PSECURITY_DESCRIPTOR descriptor = NULL;
    wchar_t name[96];
    swprintf(name, 96, L"directory-owner-rights-%lu-%zu", GetCurrentProcessId(), i);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          descriptors[i], SDDL_REVISION_1, &descriptor, NULL)) { valid = false; break; }
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    bool created = CreateDirectoryW(name, &security);
    LocalFree(descriptor);
    if (!created) { valid = false; break; }
    HANDLE handle = CreateFileW(name, FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    bool accepted = handle != INVALID_HANDLE_VALUE && permissions(handle, account.user, false, &error);
    bool parent_accepted = handle != INVALID_HANDLE_VALUE && permissions(handle, account.user, true, &error);
    printf("kernel ACL case %zu: endpoint=%d expected=%d ancestor=%d expected=%d\n",
      i, accepted, endpoint_allowed[i], parent_accepted, ancestor_allowed[i]);
    valid = accepted == endpoint_allowed[i] && parent_accepted == ancestor_allowed[i];
    if (handle != INVALID_HANDLE_VALUE && !CloseHandle(handle)) valid = false;
    if (!RemoveDirectoryW(name)) valid = false;
  }
  free(account.user);
  LocalFree(account.security);
  return valid;
}
#endif

static bool handle_alive(file_handle handle) {
#ifdef _WIN32
  DWORD flags;
  return GetHandleInformation(handle, &flags) != 0;
#else
  return fcntl(handle, F_GETFD) >= 0;
#endif
}

/* Real reclaim syscalls; only close receipts are injected. The executable
   proves retention first, then explicitly closes its own captured test handles. */
static bool reclamation_contract(size_t failed) {
  const char *temporary = getenv("TMPDIR");
  if (!temporary) temporary = getenv("TEMP");
  if (!temporary) return false;
  char root[PATH_UNITS], identity[IDENTITY_BYTES], names[RECLAIM_SLOTS][LEAF_BYTES + 1];
#ifdef _WIN32
  unsigned long pid = (unsigned long)GetCurrentProcessId();
#else
  unsigned long pid = (unsigned long)getpid();
#endif
  size_t temporary_length = strlen(temporary);
  while (temporary_length && (temporary[temporary_length - 1] == '/' || temporary[temporary_length - 1] == '\\')) temporary_length--;
  int length = snprintf(root, sizeof(root), "%.*s/reclamation-close-%lu", (int)temporary_length, temporary, pid);
  if (length < 0 || (size_t)length >= sizeof(root)) return false;
#ifdef _WIN32
  // Native creation applies the same protected DACL as production pins.
  // Do not accept or alter a directory from an earlier test process.
  if (GetFileAttributesA(root) != INVALID_FILE_ATTRIBUTES || GetLastError() != ERROR_FILE_NOT_FOUND) return false;
#else
  if (mkdir(root, 0700) != 0) return false;
  char resolved[PATH_UNITS];
  if (!realpath(root, resolved)) return false;
  strcpy(root, resolved);
#endif
  struct directory_error error = {0};
  struct directory *pin = directory_open(root,
#ifdef _WIN32
      true,
#else
      false,
#endif
      &error);
  if (!pin) return false;
  strcpy(identity, directory_identity(pin));
  for (char *cursor = identity; *cursor; cursor++) if (*cursor == ':') *cursor = '-';
  fail_at = 0;
  for (size_t i = 0; i < RECLAIM_SLOTS; i++) {
    snprintf(names[i], sizeof(names[i]), "%s%s", identity, reclaim_suffixes[i]);
    file_handle slot = directory_file(pin, names[i], &error);
    if (slot == INVALID_FILE || close_handle(slot)) return false;
  }
  calls = captured_count = 0;
  fail_at = failed;
  capture_locks = true;
  struct directory_reclamation result;
  bool collected = directory_reclaim(pin, identity, &result, &error);
  capture_locks = false;
  size_t expected_calls = failed ? failed : RECLAIM_SLOTS + 1;
  bool valid = collected == !failed && calls == expected_calls &&
      (!failed || (error.code && !strcmp(error.code, "ERR_LEASE_RELEASE"))) &&
      captured_count == (failed == 1 ? 1 : RECLAIM_SLOTS + 1);
  fail_at = 0;
  if (failed > 1 && failed < RECLAIM_SLOTS + 1) {
    // The permanent guard must still hold after any sibling close uncertainty.
    file_handle probe = INVALID_FILE;
    enum reclaim_slot state = reclaim_open(pin, names[RECLAIM_GUARD], false, &probe, &error);
    valid = valid && state == RECLAIM_BUSY && handle_alive(captured_locks[1]);
    if (probe != INVALID_FILE && close_handle(probe)) valid = false;
  }
  // Captured descriptor values may repeat because admission reuses the closed
  // probe descriptor. Close each still-live value exactly once, after proof.
  for (size_t i = 0; i < captured_count; i++) {
    bool seen = false;
    for (size_t prior = 0; prior < i; prior++)
      if (captured_locks[prior] == captured_locks[i]) seen = true;
    if (!seen && handle_alive(captured_locks[i]) && close_handle(captured_locks[i])) valid = false;
  }
  if (directory_close(pin)) valid = false;
  for (size_t i = 0; i < RECLAIM_SLOTS; i++) {
    char filename[PATH_UNITS];
    snprintf(filename, sizeof(filename), "%s/%s", root, names[i]);
#ifdef _WIN32
    if (!DeleteFileA(filename) && GetLastError() != ERROR_FILE_NOT_FOUND) valid = false;
#else
    if (unlink(filename) && errno != ENOENT) valid = false;
#endif
  }
#ifdef _WIN32
  if (!RemoveDirectoryA(root)) valid = false;
#else
  if (rmdir(root)) valid = false;
#endif
  calls = 0;
  printf("reclamation close boundary %zu: %s\n", failed, valid ? "passed" : "failed");
  return valid;
}

int main(int argc, char **argv) {
#ifdef _WIN32
  if (!owner_rights_contract()) return 91;
  if (!data_access_contract()) return 92;
  calls = 0;
#endif
#ifndef _WIN32
  const struct { uid_t owner; gid_t group; mode_t mode; bool ancestor; bool accepted; } cases[] = {
    {0, 80, 0775, true, true},
    {0, 80, 0775, false, false},
    {0, 20, 0775, true, false},
    {0, 80, 0777, true, false},
    {501, 80, 0775, true, false},
    {999, 80, 0775, true, false},
    {0, 80, 0755, false, true},
    {0, 0, 01777, true, true},
    {0, 0, 01777, false, false},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    if (darwin_directory_mode_trusted(cases[i].owner, cases[i].group, cases[i].mode,
                                     cases[i].ancestor, 501) != cases[i].accepted) return 90;
  }
#endif
  if (!leaf_name("model_profiles.json")) return 6;
  const char *invalid[] = {"", ".", "..", "../escape", "a/b", "a\\b", "a:stream", "trailing."};
  for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
    if (leaf_name(invalid[i])) return 7;
  }
  if (argc != 2) return 2;
  size_t requested = (size_t)strtoul(argv[1], NULL, 10);
  if (requested > TOTAL_HANDLES) return 2;
  if (!reclamation_contract(requested > RECLAIM_SLOTS + 1 ? RECLAIM_SLOTS + 1 : requested)) return 92;
  fail_at = requested;
  struct directory *value = chain();
  value->physical = chain();
  value->logical = chain();
  collect(value);
  uint32_t result = directory_close(value);
  size_t expected = fail_at ? fail_at : total;
  if ((result != 0) != (fail_at != 0) || calls != expected) {
    fprintf(stderr, "unexpected close result: error=%u attempts=%zu expected=%zu\n", result, calls, expected);
    return 4;
  }
  for (size_t i = 0; i < total; i++) {
#ifdef _WIN32
    DWORD flags;
    bool valid = GetHandleInformation(ordered[i], &flags) != 0;
#else
    bool valid = fcntl(ordered[i], F_GETFD) >= 0;
#endif
    // The injected failure happens after a successful actual close.
    if (valid != (i >= expected)) return 5;
  }
  printf("close boundary %zu: retained %zu handles\n", fail_at, total - expected);
  return 0;
}
