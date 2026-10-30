// Read-only installation occupancy observation; never grants process termination.
// Keep NT device paths on both sides so drive aliases cannot change the result.
#include <windows.h>
#include <tlhelp32.h>
#include <winternl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <wchar.h>

enum installation_result { INSTALLATION_IDLE, INSTALLATION_BUSY, INSTALLATION_UNKNOWN };
enum { INSTALLATION_PATH_UNITS = 32760, INSTALLATION_PROCESS_ID_INFORMATION = 88 };
struct installation_string { USHORT length, maximum; WCHAR *buffer; };
struct installation_process { HANDLE pid; struct installation_string image; };
typedef LONG (NTAPI *installation_query)(ULONG, void *, ULONG, ULONG *);

static bool installation_contains(const WCHAR *root, const WCHAR *image) {
  size_t length = wcslen(root);
  return wcslen(image) > length && _wcsnicmp(root, image, length) == 0 && image[length] == L'\\';
}

// ProcessIdToSessionId also opens the target on some Windows versions. Its
// access-denied result is not proof of a different session or of process exit.
static bool installation_session(DWORD pid, DWORD *session, DWORD *error) {
  if (ProcessIdToSessionId(pid, session)) return true;
  *error = GetLastError();
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  installation_query query = module ? (installation_query)(uintptr_t)
      GetProcAddress(module, "NtQuerySystemInformation") : NULL;
  if (!query) return false;
  enum { SNAPSHOT_INITIAL = 65536, SNAPSHOT_LIMIT = 16 * 1024 * 1024 };
  for (ULONG capacity = SNAPSHOT_INITIAL; capacity <= SNAPSHOT_LIMIT; capacity *= 2) {
    BYTE *bytes = malloc(capacity);
    if (!bytes) { *error = ERROR_NOT_ENOUGH_MEMORY; return false; }
    ULONG returned = 0;
    LONG status = query(SystemProcessInformation, bytes, capacity, &returned);
    if ((ULONG)status == 0xc0000004UL) { free(bytes); continue; } // STATUS_INFO_LENGTH_MISMATCH
    if (status < 0) { *error = (DWORD)status; free(bytes); return false; }
    bool found = false;
    if (returned <= capacity) {
      ULONG offset = 0;
      while (offset <= returned && returned - offset >= sizeof(SYSTEM_PROCESS_INFORMATION)) {
        SYSTEM_PROCESS_INFORMATION *entry = (void *)(bytes + offset);
        if ((uintptr_t)entry->UniqueProcessId == pid) {
          *session = entry->SessionId; found = true; break;
        }
        if (!entry->NextEntryOffset || entry->NextEntryOffset < sizeof(*entry) ||
            entry->NextEntryOffset > returned - offset) break;
        offset += entry->NextEntryOffset;
      }
    }
    free(bytes);
    *error = found ? ERROR_SUCCESS : ERROR_INVALID_DATA;
    return found;
  }
  *error = ERROR_INSUFFICIENT_BUFFER;
  return false;
}

static bool installation_image(DWORD pid, WCHAR *image, DWORD *error) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  DWORD length = INSTALLATION_PATH_UNITS;
  BOOL queried = process && QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE, image, &length);
  *error = queried ? ERROR_SUCCESS : GetLastError();
  if (process) CloseHandle(process);
  if (queried) return true;
  // Optional NT information class: no target handle, privilege adjustment or
  // user-controlled process metadata. Resolve dynamically and fail closed on
  // unsupported versions/errors. ABI: phnt/ntexapi.h SYSTEM_PROCESS_ID_INFORMATION.
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  installation_query query = module ? (installation_query)(uintptr_t)
      GetProcAddress(module, "NtQuerySystemInformation") : NULL;
  if (!query) return false;
  struct installation_process information = {
    (HANDLE)(uintptr_t)pid, {0, (USHORT)(INSTALLATION_PATH_UNITS * sizeof(WCHAR)), image}
  };
  LONG status = query(INSTALLATION_PROCESS_ID_INFORMATION, &information, sizeof(information), NULL);
  if (status < 0) { *error = (DWORD)status; return false; }
  size_t units = information.image.length / sizeof(WCHAR);
  if (information.image.buffer != image || !units || units >= INSTALLATION_PATH_UNITS ||
      information.image.length % sizeof(WCHAR) || wcsnlen(image, units) != units ||
      units < 8 || wcsncmp(image, L"\\Device\\", 8) != 0) {
    *error = ERROR_INVALID_DATA; return false;
  }
  image[units] = 0;
  *error = ERROR_SUCCESS;
  return true;
}

static enum installation_result installation_check(const WCHAR *path, const WCHAR *name,
                                                    DWORD own_session, DWORD *error) {
  WCHAR *root = calloc(INSTALLATION_PATH_UNITS, sizeof(WCHAR));
  WCHAR *image = calloc(INSTALLATION_PATH_UNITS, sizeof(WCHAR));
  enum installation_result result = INSTALLATION_UNKNOWN;
  *error = ERROR_NOT_ENOUGH_MEMORY;
  if (!root || !image) goto done;
  HANDLE directory = CreateFileW(path, FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (directory == INVALID_HANDLE_VALUE) { *error = GetLastError(); goto done; }
  DWORD length = GetFinalPathNameByHandleW(directory, root, INSTALLATION_PATH_UNITS,
                                         FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
  *error = length ? ERROR_INSUFFICIENT_BUFFER : GetLastError();
  CloseHandle(directory);
  if (!length || length >= INSTALLATION_PATH_UNITS) goto done;
  while (length && root[length - 1] == L'\\') root[--length] = 0;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) { *error = GetLastError(); goto done; }
  PROCESSENTRY32W entry = {0}; entry.dwSize = sizeof(entry);
  result = INSTALLATION_IDLE;
  BOOL found = Process32FirstW(snapshot, &entry);
  while (found) {
    DWORD session = 0;
    bool same_name = _wcsicmp(entry.szExeFile, name) == 0;
    if (!installation_session(entry.th32ProcessID, &session, error)) {
      if (same_name) { result = INSTALLATION_UNKNOWN; break; }
    } else if (session != own_session) {
      if (installation_image(entry.th32ProcessID, image, error)) {
        if (installation_contains(root, image)) { result = INSTALLATION_BUSY; break; }
      } else if (same_name) {
        result = INSTALLATION_UNKNOWN; break;
      }
    }
    found = Process32NextW(snapshot, &entry);
  }
  if (!found && GetLastError() != ERROR_NO_MORE_FILES) {
    *error = GetLastError(); result = INSTALLATION_UNKNOWN;
  }
  CloseHandle(snapshot);
  if (result != INSTALLATION_UNKNOWN) *error = ERROR_SUCCESS;
done:
  free(root); free(image);
  return result;
}
