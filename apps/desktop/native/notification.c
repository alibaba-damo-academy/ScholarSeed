// Windows Toast presentation only. Installer shortcuts and application routing
// belong to their respective owners; this module never creates a shortcut.
#ifdef _WIN32
#define COBJMACROS
// Enable the namespace aliases supplied by the pinned mingw WinRT headers.
#define WIDL_using_Windows_UI_Notifications
#define WIDL_using_Windows_Data_Xml_Dom
#include <windows.h>
#include <initguid.h>
#include <roapi.h>
#include <shlobj.h>
#include <knownfolders.h>
#include <propsys.h>
#include <propkey.h>
#include <propvarutil.h>
#include <winstring.h>
#include <windows.ui.notifications.h>
#include <windows.data.xml.dom.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>
#include "notification.h"

#define MAX_TEXT 16384
#define MAX_TOASTS 64
#define NOTIFICATION_ERROR_SIZE 256
#define NOTIFICATION_SETTING_EVENT "setting"
#define NOTIFICATION_SETTING_UNAVAILABLE_EVENT "setting-unavailable"
#define ATTENTION_TAG L"attention"
#define RELEASE(p) do { if (p) { (p)->lpVtbl->Release(p); (p) = NULL; } } while (0)
#define CHECK(call) do { hr = (call); if (FAILED(hr)) goto done; } while (0)
#define CHECK_SHOW(name, call) do { stage = (name); hr = (call); if (FAILED(hr)) goto done; } while (0)

typedef __FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_IInspectable Activated;
typedef __FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_Windows__CUI__CNotifications__CToastDismissedEventArgs Dismissed;
typedef __FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_Windows__CUI__CNotifications__CToastFailedEventArgs Failed;
struct owner;
struct toast;
struct handler { const IUnknownVtbl *lpVtbl; LONG refs; struct toast *toast; int kind; };
struct toast {
  LONG refs;
  CRITICAL_SECTION guard;
  bool closing;
  napi_threadsafe_function callback;
  IToastNotification *notification;
  IToastNotifier *notifier;
  EventRegistrationToken tokens[3];
  bool registered[3];
  struct owner *owner;
  struct toast *next;
};
struct owner { struct toast *first; size_t count; bool initialized; };
struct event { int kind; HRESULT error; };
static const char *EVENTS[] = {"click", "close", "failed", "timeout"};

static void retain(struct toast *toast) { InterlockedIncrement(&toast->refs); }
static void release(struct toast *toast) {
  if (!InterlockedDecrement(&toast->refs)) { DeleteCriticalSection(&toast->guard); free(toast); }
}
static ULONG STDMETHODCALLTYPE handler_add(IUnknown *self) {
  return (ULONG)InterlockedIncrement(&((struct handler *)self)->refs);
}
static ULONG STDMETHODCALLTYPE handler_release(IUnknown *self) {
  struct handler *handler = (struct handler *)self;
  LONG refs = InterlockedDecrement(&handler->refs);
  if (!refs) { release(handler->toast); free(handler); }
  return (ULONG)refs;
}
static HRESULT STDMETHODCALLTYPE handler_query(IUnknown *self, REFIID iid, void **result) {
  struct handler *handler = (struct handler *)self;
  const IID *types[] = {
    &IID___FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_IInspectable,
    &IID___FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_Windows__CUI__CNotifications__CToastDismissedEventArgs,
    &IID___FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_Windows__CUI__CNotifications__CToastFailedEventArgs,
  };
  if (!result) return E_POINTER;
  *result = NULL;
  if (IsEqualIID(iid, &IID_IUnknown) || IsEqualIID(iid, &IID_IAgileObject) || IsEqualIID(iid, types[handler->kind])) {
    *result = self; handler_add(self); return S_OK;
  }
  return E_NOINTERFACE;
}
static HRESULT STDMETHODCALLTYPE handler_invoke(IUnknown *self, IToastNotification *sender, IInspectable *args) {
  (void)sender;
  struct handler *handler = (struct handler *)self;
  struct toast *toast = handler->toast;
  struct event *event = calloc(1, sizeof(*event));
  if (!event) return E_OUTOFMEMORY;
  event->kind = handler->kind;
  if (handler->kind == 1) {
    IToastDismissedEventArgs *dismissed = (IToastDismissedEventArgs *)args;
    ToastDismissalReason reason;
    if (SUCCEEDED(dismissed->lpVtbl->get_Reason(dismissed, &reason)) && reason == ToastDismissalReason_TimedOut) event->kind = 3;
  } else if (handler->kind == 2) {
    IToastFailedEventArgs *failed = (IToastFailedEventArgs *)args;
    failed->lpVtbl->get_ErrorCode(failed, &event->error);
  }
  EnterCriticalSection(&toast->guard);
  napi_threadsafe_function callback = toast->callback;
  bool accepted = !toast->closing && callback && napi_acquire_threadsafe_function(callback) == napi_ok;
  LeaveCriticalSection(&toast->guard);
  if (accepted) {
    if (napi_call_threadsafe_function(callback, event, napi_tsfn_nonblocking) != napi_ok) free(event);
    napi_release_threadsafe_function(callback, napi_tsfn_release);
  } else free(event);
  return S_OK;
}
// WinRT typed event delegates have IUnknown + Invoke (not IInspectable).
static const struct {
  HRESULT (STDMETHODCALLTYPE *query)(IUnknown *, REFIID, void **);
  ULONG (STDMETHODCALLTYPE *add)(IUnknown *);
  ULONG (STDMETHODCALLTYPE *release)(IUnknown *);
  HRESULT (STDMETHODCALLTYPE *invoke)(IUnknown *, IToastNotification *, IInspectable *);
} HANDLER = {handler_query, handler_add, handler_release, handler_invoke};

static void call_js(napi_env env, napi_value callback, void *context, void *data) {
  (void)context;
  struct event *event = data;
  if (env && callback) {
    napi_value args[2], receiver, result;
    napi_create_string_utf8(env, EVENTS[event->kind], NAPI_AUTO_LENGTH, &args[0]);
    napi_create_int32(env, event->error, &args[1]);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 2, args, &result);
  }
  free(event);
}
static void release_toast(struct toast *toast, bool hide) {
  EnterCriticalSection(&toast->guard);
  if (toast->closing) { LeaveCriticalSection(&toast->guard); return; }
  toast->closing = true;
  napi_threadsafe_function callback = toast->callback;
  toast->callback = NULL;
  LeaveCriticalSection(&toast->guard);
  if (toast->notification) {
    if (toast->registered[0]) toast->notification->lpVtbl->remove_Activated(toast->notification, toast->tokens[0]);
    if (toast->registered[1]) toast->notification->lpVtbl->remove_Dismissed(toast->notification, toast->tokens[1]);
    if (toast->registered[2]) toast->notification->lpVtbl->remove_Failed(toast->notification, toast->tokens[2]);
    if (hide && toast->notifier) toast->notifier->lpVtbl->Hide(toast->notifier, toast->notification);
  }
  RELEASE(toast->notification);
  RELEASE(toast->notifier);
  if (callback) napi_release_threadsafe_function(callback, napi_tsfn_release);
  struct owner *owner = toast->owner;
  if (owner) {
    struct toast **entry = &owner->first;
    while (*entry && *entry != toast) entry = &(*entry)->next;
    if (*entry) { *entry = toast->next; owner->count--; }
    toast->owner = NULL;
  }
}
static void close_toast(struct toast *toast) { release_toast(toast, true); }
static void finalize_toast(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  release_toast(data, false); release(data);
}
static void cleanup(void *data) {
  struct owner *owner = data;
  while (owner->first) release_toast(owner->first, false);
  if (owner->initialized) RoUninitialize();
  free(owner);
}
static HRESULT string_value(napi_env env, napi_value value, HSTRING *result) {
  size_t length;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok || !length || length > MAX_TEXT) return E_INVALIDARG;
  WCHAR *text = calloc(length + 1, sizeof(WCHAR));
  if (!text) return E_OUTOFMEMORY;
  HRESULT hr = E_INVALIDARG;
  if (napi_get_value_string_utf16(env, value, (char16_t *)text, length + 1, &length) == napi_ok && wcslen(text) == length)
    hr = WindowsCreateString(text, (UINT32)length, result);
  free(text);
  return hr;
}
static void report_diagnostic(napi_env env, napi_value callback, const char *event, int32_t value) {
  napi_value receiver, arguments[2], ignored;
  if (napi_get_undefined(env, &receiver) != napi_ok ||
      napi_create_string_utf8(env, event, NAPI_AUTO_LENGTH, &arguments[0]) != napi_ok ||
      napi_create_int32(env, value, &arguments[1]) != napi_ok) return;
  if (napi_call_function(env, receiver, callback, 2, arguments, &ignored) == napi_pending_exception)
    napi_get_and_clear_last_exception(env, &ignored);
}

static void throw_toast_error(napi_env env, HRESULT error, const char *stage, NotificationSetting setting) {
  char message[NOTIFICATION_ERROR_SIZE];
  snprintf(message, sizeof(message), "Windows toast failed (stage=%s, HRESULT 0x%08lx, setting=%d)",
    stage, (unsigned long)error, (int)setting);
  napi_value text, exception, value;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, NULL, text, &exception) != napi_ok) {
    napi_throw_error(env, NULL, message);
    return;
  }
  if (napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &value) == napi_ok)
    napi_set_named_property(env, exception, "stage", value);
  if (napi_create_uint32(env, (uint32_t)error, &value) == napi_ok)
    napi_set_named_property(env, exception, "hresult", value);
  if (napi_create_int32(env, (int32_t)setting, &value) == napi_ok)
    napi_set_named_property(env, exception, "setting", value);
  napi_throw(env, exception);
}

static napi_value show(napi_env env, napi_callback_info info) {
  napi_value args[4], result = NULL, name;
  size_t argc = 4;
  struct owner *owner;
  napi_get_cb_info(env, info, &argc, args, NULL, (void **)&owner);
  napi_valuetype type;
  if (argc != 4 || napi_typeof(env, args[2], &type) != napi_ok || type != napi_function || owner->count >= MAX_TOASTS) {
    napi_throw_error(env, NULL, "Invalid toast arguments or too many live notifications"); return NULL;
  }
  HRESULT hr = S_OK;
  const char *stage = "arguments";
  NotificationSetting setting = (NotificationSetting)NOTIFICATION_SETTING_UNKNOWN;
  HSTRING aumid = NULL, xml = NULL, class_name = NULL, group = NULL, tag = NULL;
  IInspectable *instance = NULL;
  IXmlDocument *document = NULL;
  IXmlDocumentIO *io = NULL;
  IToastNotificationFactory *factory = NULL;
  IToastNotification2 *notification2 = NULL;
  IToastNotificationManagerStatics *manager = NULL;
  struct toast *toast = calloc(1, sizeof(*toast));
  if (!toast) { napi_throw_error(env, NULL, "Toast allocation failed"); return NULL; }
  toast->refs = 1;
  InitializeCriticalSection(&toast->guard);
  CHECK_SHOW("Aumid", string_value(env, args[0], &aumid));
  CHECK_SHOW("Xml", string_value(env, args[1], &xml));
  CHECK_SHOW("XmlDocument.ClassName", WindowsCreateString(L"Windows.Data.Xml.Dom.XmlDocument", (UINT32)(sizeof(L"Windows.Data.Xml.Dom.XmlDocument") / sizeof(WCHAR) - 1), &class_name));
  CHECK_SHOW("XmlDocument.RoActivateInstance", RoActivateInstance(class_name, &instance));
  WindowsDeleteString(class_name); class_name = NULL;
  CHECK_SHOW("IXmlDocumentIO.QueryInterface", instance->lpVtbl->QueryInterface(instance, &IID_IXmlDocumentIO, (void **)&io));
  CHECK_SHOW("LoadXml", io->lpVtbl->LoadXml(io, xml));
  CHECK_SHOW("IXmlDocument.QueryInterface", instance->lpVtbl->QueryInterface(instance, &IID_IXmlDocument, (void **)&document));
  CHECK_SHOW("ToastNotification.ClassName", WindowsCreateString(L"Windows.UI.Notifications.ToastNotification", (UINT32)(sizeof(L"Windows.UI.Notifications.ToastNotification") / sizeof(WCHAR) - 1), &class_name));
  CHECK_SHOW("ToastNotification.RoGetActivationFactory", RoGetActivationFactory(class_name, &IID_IToastNotificationFactory, (void **)&factory));
  WindowsDeleteString(class_name); class_name = NULL;
  CHECK_SHOW("CreateToastNotification", factory->lpVtbl->CreateToastNotification(factory, document, &toast->notification));
  CHECK_SHOW("Group", string_value(env, args[3], &group));
  CHECK_SHOW("Tag", WindowsCreateString(ATTENTION_TAG, (UINT32)(sizeof(ATTENTION_TAG) / sizeof(WCHAR) - 1), &tag));
  CHECK_SHOW("IToastNotification2.QueryInterface", toast->notification->lpVtbl->QueryInterface(toast->notification, &IID_IToastNotification2, (void **)&notification2));
  CHECK_SHOW("put_Tag", notification2->lpVtbl->put_Tag(notification2, tag));
  CHECK_SHOW("put_Group", notification2->lpVtbl->put_Group(notification2, group));
  CHECK_SHOW("ToastNotificationManager.ClassName", WindowsCreateString(L"Windows.UI.Notifications.ToastNotificationManager", (UINT32)(sizeof(L"Windows.UI.Notifications.ToastNotificationManager") / sizeof(WCHAR) - 1), &class_name));
  CHECK_SHOW("ToastNotificationManager.RoGetActivationFactory", RoGetActivationFactory(class_name, &IID_IToastNotificationManagerStatics, (void **)&manager));
  CHECK_SHOW("CreateToastNotifierWithId", manager->lpVtbl->CreateToastNotifierWithId(manager, aumid, &toast->notifier));
  stage = "get_Setting";
  hr = toast->notifier->lpVtbl->get_Setting(toast->notifier, &setting);
  if (FAILED(hr)) setting = (NotificationSetting)NOTIFICATION_SETTING_UNKNOWN;
  enum notification_permission permission = notification_permission((int32_t)hr, (int32_t)setting);
  if (permission == NOTIFICATION_PERMISSION_ERROR) goto done;
  if (permission == NOTIFICATION_PERMISSION_UNAVAILABLE) {
    report_diagnostic(env, args[2], NOTIFICATION_SETTING_UNAVAILABLE_EVENT, (int32_t)hr);
    hr = S_OK;
  } else {
    report_diagnostic(env, args[2], NOTIFICATION_SETTING_EVENT, (int32_t)setting);
    if (permission == NOTIFICATION_PERMISSION_DISABLED) { stage = "NotificationSetting"; hr = E_ACCESSDENIED; goto done; }
  }
  napi_create_string_utf8(env, "WindowsToast", NAPI_AUTO_LENGTH, &name);
  stage = "napi_create_threadsafe_function";
  if (napi_create_threadsafe_function(env, args[2], NULL, name, 0, 1, NULL, NULL, NULL, call_js, &toast->callback) != napi_ok) { hr = E_FAIL; goto done; }
  napi_unref_threadsafe_function(env, toast->callback);
  for (int kind = 0; kind < 3; kind++) {
    stage = "AllocateHandler";
    struct handler *handler = calloc(1, sizeof(*handler));
    if (!handler) { hr = E_OUTOFMEMORY; goto done; }
    handler->lpVtbl = (const IUnknownVtbl *)&HANDLER;
    handler->refs = 1; handler->toast = toast; handler->kind = kind; retain(toast);
    if (kind == 0) { stage = "add_Activated"; hr = toast->notification->lpVtbl->add_Activated(toast->notification, (Activated *)handler, &toast->tokens[kind]); }
    else if (kind == 1) { stage = "add_Dismissed"; hr = toast->notification->lpVtbl->add_Dismissed(toast->notification, (Dismissed *)handler, &toast->tokens[kind]); }
    else { stage = "add_Failed"; hr = toast->notification->lpVtbl->add_Failed(toast->notification, (Failed *)handler, &toast->tokens[kind]); }
    handler_release((IUnknown *)handler);
    if (FAILED(hr)) goto done;
    toast->registered[kind] = true;
  }
  CHECK_SHOW("Show", toast->notifier->lpVtbl->Show(toast->notifier, toast->notification));
  stage = "napi_create_external";
  if (napi_create_external(env, toast, finalize_toast, NULL, &result) != napi_ok) { hr = E_FAIL; goto done; }
  toast->owner = owner; toast->next = owner->first; owner->first = toast; owner->count++;
done:
  WindowsDeleteString(aumid); WindowsDeleteString(xml); WindowsDeleteString(class_name);
  WindowsDeleteString(group); WindowsDeleteString(tag);
  RELEASE(instance); RELEASE(document); RELEASE(io); RELEASE(factory); RELEASE(manager); RELEASE(notification2);
  if (FAILED(hr)) {
    close_toast(toast); release(toast);
    throw_toast_error(env, hr, stage, setting); return NULL;
  }
  return result;
}
static napi_value close_native(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  struct toast *toast;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || napi_get_value_external(env, args[0], (void **)&toast) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected toast handle"); return NULL;
  }
  close_toast(toast);
  napi_get_undefined(env, &result); return result;
}
static napi_value detach_native(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  struct toast *toast;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || napi_get_value_external(env, args[0], (void **)&toast) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected toast handle"); return NULL;
  }
  release_toast(toast, false);
  napi_get_undefined(env, &result); return result;
}
static HRESULT notification_history(IToastNotificationHistory **history) {
  HSTRING class_name = NULL;
  IToastNotificationManagerStatics2 *manager = NULL;
  HRESULT hr = WindowsCreateString(L"Windows.UI.Notifications.ToastNotificationManager",
    (UINT32)(sizeof(L"Windows.UI.Notifications.ToastNotificationManager") / sizeof(WCHAR) - 1), &class_name);
  if (SUCCEEDED(hr)) hr = RoGetActivationFactory(class_name, &IID_IToastNotificationManagerStatics2, (void **)&manager);
  if (SUCCEEDED(hr)) hr = manager->lpVtbl->get_History(manager, history);
  WindowsDeleteString(class_name); RELEASE(manager);
  return hr;
}
static napi_value history_native(napi_env env, napi_callback_info info) {
  napi_value args[1], result = NULL;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  HSTRING aumid = NULL, tag = NULL, group = NULL;
  IToastNotificationHistory *history = NULL;
  IToastNotificationHistory2 *history2 = NULL;
  __FIVectorView_1_Windows__CUI__CNotifications__CToastNotification *items = NULL;
  IToastNotification *notification = NULL;
  IToastNotification2 *notification2 = NULL;
  HRESULT hr = argc == 1 ? string_value(env, args[0], &aumid) : E_INVALIDARG;
  UINT32 count = 0, output = 0;
  if (FAILED(hr)) goto done;
  CHECK(notification_history(&history));
  CHECK(history->lpVtbl->QueryInterface(history, &IID_IToastNotificationHistory2, (void **)&history2));
  CHECK(history2->lpVtbl->GetHistoryWithId(history2, aumid, &items));
  CHECK(items->lpVtbl->get_Size(items, &count));
  if (napi_create_array(env, &result) != napi_ok) { hr = E_FAIL; goto done; }
  for (UINT32 index = 0; index < count; index++) {
    CHECK(items->lpVtbl->GetAt(items, index, &notification));
    CHECK(notification->lpVtbl->QueryInterface(notification, &IID_IToastNotification2, (void **)&notification2));
    CHECK(notification2->lpVtbl->get_Tag(notification2, &tag));
    if (wcscmp(WindowsGetStringRawBuffer(tag, NULL), ATTENTION_TAG) == 0) {
      CHECK(notification2->lpVtbl->get_Group(notification2, &group));
      UINT32 length;
      const WCHAR *text = WindowsGetStringRawBuffer(group, &length);
      napi_value id;
      if (napi_create_string_utf16(env, (const char16_t *)text, length, &id) != napi_ok ||
          napi_set_element(env, result, output++, id) != napi_ok) { hr = E_FAIL; goto done; }
      WindowsDeleteString(group); group = NULL;
    }
    WindowsDeleteString(tag); tag = NULL;
    RELEASE(notification2); RELEASE(notification);
  }
done:
  WindowsDeleteString(aumid); WindowsDeleteString(tag); WindowsDeleteString(group);
  RELEASE(history); RELEASE(history2); RELEASE(items); RELEASE(notification); RELEASE(notification2);
  if (FAILED(hr)) {
    char message[80]; snprintf(message, sizeof(message), "Windows toast history failed (HRESULT 0x%08lx)", (unsigned long)hr);
    napi_throw_error(env, NULL, message); return NULL;
  }
  return result;
}
static napi_value remove_native(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  HSTRING aumid = NULL, group = NULL, tag = NULL;
  IToastNotificationHistory *history = NULL;
  HRESULT hr = argc == 2 ? string_value(env, args[0], &aumid) : E_INVALIDARG;
  if (FAILED(hr)) goto done;
  CHECK(string_value(env, args[1], &group));
  CHECK(WindowsCreateString(ATTENTION_TAG, (UINT32)(sizeof(ATTENTION_TAG) / sizeof(WCHAR) - 1), &tag));
  CHECK(notification_history(&history));
  CHECK(history->lpVtbl->RemoveGroupedTagWithId(history, tag, group, aumid));
done:
  WindowsDeleteString(aumid); WindowsDeleteString(group); WindowsDeleteString(tag); RELEASE(history);
  if (FAILED(hr)) {
    char message[80]; snprintf(message, sizeof(message), "Windows toast removal failed (HRESULT 0x%08lx)", (unsigned long)hr);
    napi_throw_error(env, NULL, message); return NULL;
  }
  napi_get_undefined(env, &result); return result;
}
// Read the Shell item's effective identity. IShellLink's property view used by
// Electron does not expose the AUMID on some installer-created links.
static napi_value shortcut_id(napi_env env, napi_callback_info info) {
  napi_value arg, result = NULL;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  HSTRING path = NULL;
  IPropertyStore *store = NULL;
  PROPVARIANT value;
  PropVariantInit(&value);
  PWSTR text = NULL;
  HRESULT hr = argc == 1 ? string_value(env, arg, &path) : E_INVALIDARG;
  if (SUCCEEDED(hr)) hr = SHGetPropertyStoreFromParsingName(WindowsGetStringRawBuffer(path, NULL), NULL,
    GPS_DEFAULT, &IID_IPropertyStore, (void **)&store);
  if (SUCCEEDED(hr)) hr = store->lpVtbl->GetValue(store, &PKEY_AppUserModel_ID, &value);
  if (SUCCEEDED(hr) && value.vt != VT_EMPTY) hr = PropVariantToStringAlloc(&value, &text);
  if (SUCCEEDED(hr)) napi_create_string_utf16(env, (const char16_t *)(text ? text : L""), NAPI_AUTO_LENGTH, &result);
  CoTaskMemFree(text); PropVariantClear(&value); RELEASE(store); WindowsDeleteString(path);
  if (FAILED(hr)) { napi_throw_error(env, NULL, "Shortcut Shell identity unavailable"); return NULL; }
  return result;
}
static napi_value programs(napi_env env, napi_callback_info info) {
  (void)info;
  PWSTR path = NULL;
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_Programs, 0, NULL, &path))) {
    napi_throw_error(env, NULL, "Start Menu Programs directory unavailable"); return NULL;
  }
  napi_value result;
  napi_create_string_utf16(env, (const char16_t *)path, NAPI_AUTO_LENGTH, &result);
  CoTaskMemFree(path);
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  struct owner *owner = calloc(1, sizeof(*owner));
  if (!owner) { napi_throw_error(env, NULL, "Toast owner allocation failed"); return NULL; }
  HRESULT hr = RoInitialize(RO_INIT_SINGLETHREADED);
  owner->initialized = SUCCEEDED(hr);
  if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) { free(owner); napi_throw_error(env, NULL, "Windows Runtime initialization failed"); return NULL; }
  napi_add_env_cleanup_hook(env, cleanup, owner);
  napi_value fn;
  napi_create_function(env, "shortcutId", NAPI_AUTO_LENGTH, shortcut_id, owner, &fn); napi_set_named_property(env, exports, "shortcutId", fn);
  napi_create_function(env, "programs", NAPI_AUTO_LENGTH, programs, owner, &fn); napi_set_named_property(env, exports, "programs", fn);
  napi_create_function(env, "show", NAPI_AUTO_LENGTH, show, owner, &fn); napi_set_named_property(env, exports, "show", fn);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, close_native, owner, &fn); napi_set_named_property(env, exports, "close", fn);
  napi_create_function(env, "detach", NAPI_AUTO_LENGTH, detach_native, owner, &fn); napi_set_named_property(env, exports, "detach", fn);
  napi_create_function(env, "history", NAPI_AUTO_LENGTH, history_native, owner, &fn); napi_set_named_property(env, exports, "history", fn);
  napi_create_function(env, "remove", NAPI_AUTO_LENGTH, remove_native, owner, &fn); napi_set_named_property(env, exports, "remove", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

#else
#include <node_api.h>
static napi_value initialize(napi_env env, napi_value exports) { (void)env; return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
#endif
