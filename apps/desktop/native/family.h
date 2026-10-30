// Minimal owned-child lifetime boundary. No update or storage policy lives here.
#ifdef _WIN32
#include "installation.h"
struct process_family { HANDLE job; };
static const napi_type_tag family_tag = { 0x8440296bc6b54051ULL, 0xa1c46b63cfbcf233ULL };
static void family_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  struct process_family *family = data;
  if (family->job) CloseHandle(family->job);
  free(family);
}
static struct process_family *family_receiver(napi_env env, napi_callback_info info) {
  napi_value receiver;
  bool matches = false;
  void *data = NULL;
  if (napi_get_cb_info(env, info, NULL, NULL, &receiver, NULL) != napi_ok ||
      napi_check_object_type_tag(env, receiver, &family_tag, &matches) != napi_ok || !matches ||
      napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    fail(env, "ERR_PROCESS_FAMILY_ARGUMENT", 0); return NULL;
  }
  struct process_family *family = data;
  if (!family->job) { fail(env, "ERR_PROCESS_FAMILY_CLOSED", 0); return NULL; }
  return family;
}
static bool family_count(napi_env env, struct process_family *family, DWORD *count) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
  if (!QueryInformationJobObject(family->job, JobObjectBasicAccountingInformation,
                                &accounting, sizeof(accounting), NULL)) {
    fail(env, "ERR_PROCESS_FAMILY_QUERY", GetLastError()); return false;
  }
  *count = accounting.ActiveProcesses;
  return true;
}
static napi_value family_active(napi_env env, napi_callback_info info) {
  struct process_family *family = family_receiver(env, info);
  DWORD count; napi_value result;
  if (!family || !family_count(env, family, &count)) return NULL;
  if (napi_create_uint32(env, count, &result) != napi_ok) return fail(env, "ERR_PROCESS_FAMILY_NATIVE", 0);
  return result;
}
static napi_value family_terminate(napi_env env, napi_callback_info info) {
  struct process_family *family = family_receiver(env, info);
  napi_value result;
  if (!family) return NULL;
  if (!TerminateJobObject(family->job, ERROR_PROCESS_ABORTED))
    return fail(env, "ERR_PROCESS_FAMILY_TERMINATE", GetLastError());
  napi_get_undefined(env, &result); return result;
}
static napi_value family_close(napi_env env, napi_callback_info info) {
  struct process_family *family = family_receiver(env, info);
  DWORD count; napi_value result;
  if (!family || !family_count(env, family, &count)) return NULL;
  if (count) return fail(env, "ERR_PROCESS_FAMILY_BUSY", count);
  if (!CloseHandle(family->job)) return fail(env, "ERR_PROCESS_FAMILY_CLOSE", GetLastError());
  family->job = NULL;
  napi_get_undefined(env, &result); return result;
}
static napi_value open_family(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1], result; uint32_t pid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_uint32(env, argv[0], &pid) != napi_ok || !pid)
    return fail(env, "ERR_PROCESS_FAMILY_ARGUMENT", 0);
  HANDLE child = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!child) return fail(env, "ERR_PROCESS_FAMILY_OPEN", GetLastError());
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) { DWORD error = GetLastError(); CloseHandle(child); return fail(env, "ERR_PROCESS_FAMILY_CREATE", error); }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  // No breakaway: inherited external runtimes remain members of this exact launch.
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job, child)) {
    DWORD error = GetLastError(); CloseHandle(child); CloseHandle(job);
    return fail(env, "ERR_PROCESS_FAMILY_ASSIGN", error);
  }
  CloseHandle(child);
  struct process_family *family = calloc(1, sizeof(*family));
  if (!family) { CloseHandle(job); return fail(env, "ERR_PROCESS_FAMILY_ALLOCATION", 0); }
  family->job = job;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &family_tag) != napi_ok ||
      napi_wrap(env, result, family, family_finalize, NULL, NULL) != napi_ok) {
    family_finalize(env, family, NULL); return fail(env, "ERR_PROCESS_FAMILY_NATIVE", 0);
  }
  napi_property_descriptor properties[] = {
    {"active", NULL, family_active, NULL, NULL, NULL, napi_default, NULL},
    {"terminate", NULL, family_terminate, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, family_close, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, result, sizeof(properties)/sizeof(properties[0]), properties) != napi_ok)
    return fail(env, "ERR_PROCESS_FAMILY_NATIVE", 0);
  return result;
}
// Velopack may terminate processes inside the install root across sessions. Refuse
// that handoff if another login owns such a process; never terminate it ourselves.
static napi_value assert_installation_idle(napi_env env, napi_callback_info info) {
  size_t argc = 2, root_length = 0, name_length = 0;
  napi_value argv[2], result;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_string_utf16(env, argv[0], NULL, 0, &root_length) != napi_ok ||
      napi_get_value_string_utf16(env, argv[1], NULL, 0, &name_length) != napi_ok ||
      !root_length || root_length >= 32760 || !name_length || name_length >= MAX_PATH)
    return fail(env, "ERR_UPDATE_INSTALLATION_ARGUMENT", 0);
  WCHAR *root = calloc(root_length + 1, sizeof(WCHAR));
  WCHAR name[MAX_PATH];
  if (!root) { free(root); return fail(env, "ERR_UPDATE_INSTALLATION_ALLOCATION", 0); }
  if (napi_get_value_string_utf16(env, argv[0], (char16_t *)root, root_length + 1, &root_length) != napi_ok ||
      napi_get_value_string_utf16(env, argv[1], (char16_t *)name, MAX_PATH, &name_length) != napi_ok) {
    free(root); return fail(env, "ERR_UPDATE_INSTALLATION_ARGUMENT", 0);
  }
  for (size_t i = 0; i < root_length; i++) if (root[i] == L'/') root[i] = L'\\';
  DWORD own_session = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &own_session)) {
    DWORD error = GetLastError(); free(root); return fail(env, "ERR_UPDATE_INSTALLATION_SESSION", error);
  }
  DWORD error = 0;
  enum installation_result observed = installation_check(root, name, own_session, &error);
  free(root);
  if (observed == INSTALLATION_BUSY) return fail(env, "ERR_UPDATE_INSTALLATION_IN_USE", 0);
  if (observed == INSTALLATION_UNKNOWN) return fail(env, "ERR_UPDATE_INSTALLATION_QUERY", error);
  napi_get_undefined(env, &result); return result;
}
#endif
