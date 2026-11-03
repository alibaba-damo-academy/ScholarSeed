// Synchronous, read-only bootstrap of the already-running native parent.
// No startup path is consumed from environment JSON. The same parent later
// accepts the ordinary asynchronous resident connection.
#ifndef SCHOLARSEED_STARTUP_H
#define SCHOLARSEED_STARTUP_H

#ifdef _WIN32
#include <stdio.h>
#include <wchar.h>

#define STARTUP_FRAME_BYTES (128u << 10)
#define STARTUP_DEADLINE_MS 10000u

struct startup_read {
  HANDLE pipe, event, parent;
  OVERLAPPED overlap;
  bool pending;
  unsigned char bytes[STARTUP_FRAME_BYTES + 1];
};

static bool startup_creation(HANDLE process, char output[32]) {
  FILETIME created, exited, kernel_time, user_time;
  if (!GetProcessTimes(process, &created, &exited, &kernel_time, &user_time)) return false;
  unsigned long long value = ((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime;
  return snprintf(output, 32, "windows-%016llx", value) == 24;
}

// Pending IO retains its OVERLAPPED, buffer and handles if cancellation cannot
// be proven complete. Returning a timeout must not free kernel-owned memory.
static bool startup_release(struct startup_read *read) {
  if (read->pending) {
    if (!CancelIoEx(read->pipe, &read->overlap) && GetLastError() != ERROR_NOT_FOUND) return false;
    if (WaitForSingleObject(read->event, 1000) != WAIT_OBJECT_0) return false;
    DWORD count = 0;
    if (!GetOverlappedResult(read->pipe, &read->overlap, &count, FALSE) && GetLastError() == ERROR_IO_INCOMPLETE) return false;
    read->pending = false;
  }
  if (read->pipe != INVALID_HANDLE_VALUE && !CloseHandle(read->pipe)) return false;
  read->pipe = INVALID_HANDLE_VALUE;
  if (read->event && !CloseHandle(read->event)) return false;
  read->event = NULL;
  if (read->parent && !CloseHandle(read->parent)) return false;
  read->parent = NULL;
  return true;
}
#endif

static napi_value owner_session(napi_env env, napi_callback_info info, bool bootstrap) {
#ifndef _WIN32
  (void)info;
  (void)bootstrap;
  return fail(env, "ERR_LEASE_PLATFORM", 0);
#else
  size_t argc = 3, length = 0;
  napi_value argv[3], result, bytes, owner_created, leader_created;
  void *data = NULL;
  double parent_pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 2 ||
      napi_get_value_double(env, argv[1], &parent_pid) != napi_ok ||
      !(parent_pid >= 1 && parent_pid <= UINT32_MAX) || (double)(DWORD)parent_pid != parent_pid ||
      napi_get_value_string_utf16(env, argv[0], NULL, 0, &length) != napi_ok)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  const wchar_t prefix[] = L"\\\\.\\pipe\\scholarseed-updater-";
  const size_t prefix_length = sizeof(prefix)/sizeof(prefix[0])-1;
  wchar_t name[128];
  if (length != prefix_length + 64 || length >= sizeof(name)/sizeof(name[0]) ||
      napi_get_value_string_utf16(env, argv[0], (char16_t *)name, sizeof(name)/sizeof(name[0]), &length) != napi_ok ||
      wmemcmp(name, prefix, prefix_length) != 0)
    return fail(env, "ERR_LEASE_ARGUMENT", 0);
  for (size_t i=prefix_length; i<length; ++i)
    if (!((name[i] >= L'0' && name[i] <= L'9') || (name[i] >= L'a' && name[i] <= L'f')))
      return fail(env, "ERR_LEASE_ARGUMENT", 0);
  struct context *context = data;
  if (bootstrap) {
    if (context->startup_consumed) return fail(env, "ERR_LEASE_CLOSED", 0);
    context->startup_consumed = true;
  }
  struct startup_read *read = calloc(1, sizeof(*read));
  if (!read) return fail(env, "ERR_LEASE_ALLOCATION", 0);
  read->pipe = INVALID_HANDLE_VALUE;
  DWORD error = ERROR_INVALID_DATA;
  char owner[32], leader[32];
  size_t total = 0;
  ULONGLONG deadline = GetTickCount64() + STARTUP_DEADLINE_MS;
  for (;;) {
    read->pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                             FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (read->pipe != INVALID_HANDLE_VALUE) break;
    error = GetLastError();
    if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) goto failed;
    if (GetTickCount64() >= deadline) { error = WAIT_TIMEOUT; goto failed; }
    // The parent creates the first listening instance after resuming Electron.
    // A short wait is bounded by the single overall connection/read deadline.
    if (!WaitNamedPipeW(name, 25) && GetLastError() == ERROR_FILE_NOT_FOUND) Sleep(1);
  }
  ULONG server_pid = 0;
  if (!GetNamedPipeServerProcessId(read->pipe, &server_pid)) { error=GetLastError(); goto failed; }
  if (server_pid != (DWORD)parent_pid) { error=ERROR_ACCESS_DENIED; goto failed; }
  read->parent = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, server_pid);
  if (!read->parent || !startup_creation(read->parent, owner) || !startup_creation(GetCurrentProcess(), leader)) {
    error=GetLastError(); goto failed;
  }
  if (WaitForSingleObject(read->parent, 0) != WAIT_TIMEOUT) { error=ERROR_PROCESS_ABORTED; goto failed; }
  read->event=CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!read->event) { error=GetLastError(); goto failed; }
  for (;;) {
    if (GetTickCount64() >= deadline) { error=WAIT_TIMEOUT; goto failed; }
    if (!ResetEvent(read->event)) { error=GetLastError(); goto failed; }
    memset(&read->overlap, 0, sizeof(read->overlap)); read->overlap.hEvent=read->event;
    DWORD count=0;
    BOOL complete=ReadFile(read->pipe, read->bytes+total, (DWORD)(sizeof(read->bytes)-total), &count, &read->overlap);
    if (!complete) {
      error=GetLastError(); if (error != ERROR_IO_PENDING) goto failed;
      read->pending=true;
      ULONGLONG now=GetTickCount64();
      DWORD wait=WaitForSingleObject(read->event, now>=deadline ? 0 : (DWORD)(deadline-now));
      if (wait != WAIT_OBJECT_0) { error=wait==WAIT_TIMEOUT ? WAIT_TIMEOUT : GetLastError(); goto failed; }
      if (!GetOverlappedResult(read->pipe, &read->overlap, &count, FALSE)) { error=GetLastError(); goto failed; }
      read->pending=false;
    }
    if (count==0 || count>sizeof(read->bytes)-total) { error=ERROR_INVALID_DATA; goto failed; }
    total+=count;
    unsigned char *newline=memchr(read->bytes, '\n', total);
    if (newline) {
      if (newline != read->bytes+total-1 || total>STARTUP_FRAME_BYTES) { error=ERROR_INVALID_DATA; goto failed; }
      break;
    }
    if (total>=STARTUP_FRAME_BYTES) { error=ERROR_BUFFER_OVERFLOW; goto failed; }
  }
  if (WaitForSingleObject(read->parent, 0) != WAIT_TIMEOUT) { error=ERROR_PROCESS_ABORTED; goto failed; }
  if (!startup_release(read)) return fail(env, "ERR_LEASE_RELEASE", GetLastError());
  napi_status status=napi_create_object(env,&result);
  if (status==napi_ok) status=napi_create_buffer_copy(env,total,read->bytes,NULL,&bytes);
  free(read);
  if (status==napi_ok) status=napi_create_string_utf8(env,owner,NAPI_AUTO_LENGTH,&owner_created);
  if (status==napi_ok) status=napi_create_string_utf8(env,leader,NAPI_AUTO_LENGTH,&leader_created);
  if (status==napi_ok) status=napi_set_named_property(env,result,"bytes",bytes);
  if (status==napi_ok) status=napi_set_named_property(env,result,"ownerCreated",owner_created);
  if (status==napi_ok) status=napi_set_named_property(env,result,"leaderCreated",leader_created);
  if (status!=napi_ok) return fail(env,"ERR_LEASE_NATIVE",0);
  return result;
failed:
  if (!startup_release(read)) return fail(env,"ERR_LEASE_RELEASE",GetLastError());
  free(read);
  return fail(env, bootstrap ? "ERR_LEASE_STARTUP" : "ERR_LEASE_MAINTENANCE", error);
#endif
}
// Startup is deliberately one-shot; an independent maintenance worker may be
// observed after readiness and on a later retry. Each call reopens and verifies
// the actual pipe server. No parent relationship is asserted for that worker.
static napi_value startup_session(napi_env env, napi_callback_info info) {
  return owner_session(env, info, true);
}

static napi_value maintenance_session(napi_env env, napi_callback_info info) {
  return owner_session(env, info, false);
}
#endif
