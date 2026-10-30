// Compile the production scanner with OS failure injection, not a second policy.
#include <windows.h>
#include <tlhelp32.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdbool.h>
#include <wchar.h>
static const WCHAR *test_image = L"\\Device\\Volume2\\other\\current\\ScholarSeed.exe";
static DWORD test_session = 3;
static bool unavailable = false, malformed = false, missing_session = false, enumeration_error = false;
static unsigned closed = 0;
static bool system_snapshot = false, invalid_snapshot = false, absent_api = false;
static HANDLE fake_open(DWORD access, BOOL inherit, DWORD pid) {
  (void)access; (void)inherit; (void)pid; SetLastError(ERROR_ACCESS_DENIED); return NULL;
}
static BOOL fake_close(HANDLE handle) { (void)handle; closed++; return TRUE; }
static HANDLE fake_directory(LPCWSTR path, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
                             DWORD disposition, DWORD flags, HANDLE template) {
  (void)path; (void)access; (void)share; (void)security; (void)disposition; (void)flags; (void)template;
  return (HANDLE)1;
}
static DWORD fake_final(HANDLE handle, LPWSTR path, DWORD length, DWORD flags) {
  (void)handle; assert(length > 100); assert(flags == (FILE_NAME_NORMALIZED | VOLUME_NAME_NT));
  wcscpy(path, L"\\Device\\Volume2\\app"); return (DWORD)wcslen(path);
}
static HANDLE fake_snapshot(DWORD flags, DWORD pid) { (void)flags; (void)pid; return (HANDLE)2; }
static BOOL fake_first(HANDLE h, LPPROCESSENTRY32W entry) {
  (void)h; entry->th32ProcessID = 123; wcscpy(entry->szExeFile, L"ScholarSeed.exe"); return TRUE;
}
static BOOL fake_next(HANDLE h, LPPROCESSENTRY32W entry) {
  (void)h; (void)entry; SetLastError(enumeration_error ? ERROR_ACCESS_DENIED : ERROR_NO_MORE_FILES); return FALSE;
}
static BOOL fake_session(DWORD pid, DWORD *session) {
  (void)pid; *session = test_session;
  if (missing_session) { SetLastError(ERROR_INVALID_PARAMETER); return FALSE; } return TRUE;
}
static FARPROC fake_address(HMODULE module, LPCSTR name);
#define OpenProcess fake_open
#define CloseHandle fake_close
#define CreateFileW fake_directory
#define GetFinalPathNameByHandleW fake_final
#define CreateToolhelp32Snapshot fake_snapshot
#define Process32FirstW fake_first
#define Process32NextW fake_next
#define ProcessIdToSessionId fake_session
#define GetProcAddress fake_address
#include "installation.h"
static LONG NTAPI fake_query(ULONG kind, void *bytes, ULONG size, ULONG *returned) {
  (void)returned;
  if (kind == SystemProcessInformation) {
    if (!system_snapshot) return (LONG)0xc0000022;
    assert(size >= sizeof(SYSTEM_PROCESS_INFORMATION));
    SYSTEM_PROCESS_INFORMATION *entry = bytes;
    memset(entry, 0, sizeof(*entry));
    entry->UniqueProcessId = (HANDLE)123;
    entry->SessionId = test_session;
    *returned = invalid_snapshot ? sizeof(*entry) - 1 : sizeof(*entry);
    return 0;
  }
  assert(kind == INSTALLATION_PROCESS_ID_INFORMATION);
  assert(size == sizeof(struct installation_process));
  struct installation_process *information = bytes;
  assert((uintptr_t)information->pid == 123);
  if (unavailable) return (LONG)0xc0000022;
  wcscpy(information->image.buffer, test_image);
  information->image.length = (USHORT)(wcslen(test_image) * sizeof(WCHAR));
  if (malformed) information->image.length++;
  return 0;
}
static FARPROC fake_address(HMODULE module, LPCSTR name) {
  assert(module); assert(strcmp(name, "NtQuerySystemInformation") == 0);
  return absent_api ? NULL : (FARPROC)(uintptr_t)fake_query;
}
static void expect(enum installation_result expected) {
  DWORD error = 0; closed = 0;
  assert(installation_check(L"C:\\app", L"ScholarSeed.exe", 2, &error) == expected);
  assert((error != 0) == (expected == INSTALLATION_UNKNOWN));
  assert(closed == 2);
}
int main(void) {
  expect(INSTALLATION_IDLE); // same name, access denied, different installation
  test_image = L"\\Device\\Volume2\\APP\\runtime\\engine.exe";
  expect(INSTALLATION_BUSY); // actual path, regardless of executable name/case
  test_image = L"\\Device\\Volume2\\app-other\\current\\ScholarSeed.exe";
  expect(INSTALLATION_IDLE); // separator boundary
  test_image = L"\\Device\\Volume3\\app\\current\\ScholarSeed.exe";
  expect(INSTALLATION_IDLE); // different volume
  unavailable = true; expect(INSTALLATION_UNKNOWN); unavailable = false;
  malformed = true; expect(INSTALLATION_UNKNOWN); malformed = false;
  test_image = L"relative.exe"; expect(INSTALLATION_UNKNOWN);
  test_image = L"\\Device\\Volume2\\app\\current\\ScholarSeed.exe";
  test_session = 2; expect(INSTALLATION_IDLE); test_session = 3;
  missing_session = true; expect(INSTALLATION_UNKNOWN); missing_session = false;
  test_image = L"\\Device\\Volume2\\other\\current\\ScholarSeed.exe";
  enumeration_error = true; expect(INSTALLATION_UNKNOWN); enumeration_error = false;
  absent_api = true; expect(INSTALLATION_UNKNOWN); absent_api = false;
  missing_session = true; system_snapshot = true;
  expect(INSTALLATION_IDLE); // SessionId query also denied; system snapshot proves another session
  test_image = L"\\Device\\Volume2\\app\\current\\ScholarSeed.exe";
  expect(INSTALLATION_BUSY);
  invalid_snapshot = true; expect(INSTALLATION_UNKNOWN);
  puts("installation occupancy: 14 contracts passed");
  return 0;
}
