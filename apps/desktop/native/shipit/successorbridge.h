#import "successor.h"
#include <node_api.h>

@interface SSSuccessorHandle : NSObject
@property(nonatomic) uint32_t identifier;
@property(nonatomic) napi_env environment;
@property(nonatomic) napi_threadsafe_function callback;
@property(nonatomic, strong) id<SSSuccessor> updater;
@property(nonatomic, strong) NSError *error;
@property(nonatomic) BOOL ready;
@property(nonatomic) BOOL disposed;
@end
@implementation SSSuccessorHandle
@end

static NSMutableDictionary<NSNumber *, SSSuccessorHandle *> *SSHandles;
static uint32_t SSNextHandle;

static napi_value SSSuccessorError(napi_env env, const char *message) {
  napi_throw_error(env, "ERR_UPDATE_SUCCESSOR", message);
  return NULL;
}

static void SSCloseSuccessor(void *data) {
  SSSuccessorHandle *handle = (__bridge SSSuccessorHandle *)data;
  handle.disposed = YES;
  [handle.updater ss_disposeSuccessor];
  if (handle.callback) {
    napi_release_threadsafe_function(handle.callback, napi_tsfn_abort);
    handle.callback = NULL;
  }
  [SSHandles removeObjectForKey:@(handle.identifier)];
}

static void SSDeliverSuccessor(napi_env env, napi_value callback, void *context, void *data) {
  (void)context;
  SSSuccessorHandle *handle = CFBridgingRelease(data);
  if (!env || !callback || handle.disposed) return;
  napi_value argument, receiver;
  napi_status status = handle.error
    ? napi_create_string_utf8(env, handle.error.localizedDescription.UTF8String, NAPI_AUTO_LENGTH, &argument)
    : napi_get_null(env, &argument);
  if (status != napi_ok || napi_get_undefined(env, &receiver) != napi_ok) {
    SSSuccessorError(env, "Could not deliver update preparation result");
    return;
  }
  handle.ready = handle.error == nil;
  napi_call_function(env, receiver, callback, 1, &argument, NULL);
}

static napi_value SSPrepareSuccessor(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 4, length;
    napi_value arguments[4], name, identifier;
    bool alternate;
    napi_valuetype type;
    char feed[256];
    if (!NSThread.isMainThread || napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 3 ||
        napi_get_value_string_utf8(env, arguments[0], NULL, 0, &length) != napi_ok || !length || length >= sizeof(feed) ||
        napi_get_value_string_utf8(env, arguments[0], feed, sizeof(feed), &length) != napi_ok || strlen(feed) != length ||
        napi_get_value_bool(env, arguments[1], &alternate) != napi_ok ||
        napi_typeof(env, arguments[2], &type) != napi_ok || type != napi_function)
      return SSSuccessorError(env, "Invalid update preparation arguments");
    Class<SSSuccessorFactory> factory = (Class<SSSuccessorFactory>)NSClassFromString(@"SQRLUpdater");
    if (![factory respondsToSelector:@selector(ss_prepareSuccessor:alternate:completion:)])
      return SSSuccessorError(env, "The running Squirrel framework does not support another update candidate");
    if (SSNextHandle == UINT32_MAX) return SSSuccessorError(env, "Update handle limit exceeded");
    SSSuccessorHandle *handle = [SSSuccessorHandle new];
    handle.identifier = ++SSNextHandle;
    handle.environment = env;
    napi_threadsafe_function callback;
    if (napi_create_uint32(env, handle.identifier, &identifier) != napi_ok ||
        napi_create_string_utf8(env, "Squirrel preparation", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_threadsafe_function(env, arguments[2], NULL, name, 1, 1, NULL, NULL, NULL, SSDeliverSuccessor, &callback) != napi_ok)
      return SSSuccessorError(env, "Could not register update preparation callback");
    handle.callback = callback;
    @try {
      handle.updater = [factory ss_prepareSuccessor:[NSURL URLWithString:@(feed)] alternate:alternate completion:^(NSError *error) {
        if (handle.disposed || !handle.callback) return;
        handle.error = error;
        void *pending = (__bridge_retained void *)handle;
        if (napi_call_threadsafe_function(handle.callback, pending, napi_tsfn_nonblocking) != napi_ok)
          (void)CFBridgingRelease(pending);
        napi_release_threadsafe_function(handle.callback, napi_tsfn_release);
        handle.callback = NULL;
      }];
    } @catch (NSException *exception) {
      SSCloseSuccessor((__bridge void *)handle);
      return SSSuccessorError(env, exception.reason.UTF8String);
    }
    if (!handle.updater || napi_add_env_cleanup_hook(env, SSCloseSuccessor, (__bridge void *)handle) != napi_ok) {
      SSCloseSuccessor((__bridge void *)handle);
      return SSSuccessorError(env, "Could not reserve the update preparation slot");
    }
    if (!SSHandles) SSHandles = [NSMutableDictionary dictionary];
    SSHandles[@(handle.identifier)] = handle;
    return identifier;
  }
}

static SSSuccessorHandle *SSLookupSuccessor(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value arguments[2];
  double identifier;
  if (!NSThread.isMainThread || napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_double(env, arguments[0], &identifier) != napi_ok || !(identifier > 0 && identifier <= UINT32_MAX) ||
      (double)(uint32_t)identifier != identifier) return nil;
  SSSuccessorHandle *handle = SSHandles[@((uint32_t)identifier)];
  return handle.environment == env && !handle.disposed ? handle : nil;
}

static napi_value SSInstallSuccessor(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    SSSuccessorHandle *handle = SSLookupSuccessor(env, info);
    if (!handle.ready) return SSSuccessorError(env, "Update candidate is not ready");
    NSError *error = nil;
    if (![handle.updater ss_installSuccessor:&error]) return SSSuccessorError(env, error.localizedDescription.UTF8String);
    handle.ready = NO;
    napi_value result; napi_get_undefined(env, &result); return result;
  }
}

static napi_value SSDisposeSuccessor(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    SSSuccessorHandle *handle = SSLookupSuccessor(env, info);
    if (!handle) return SSSuccessorError(env, "Unknown update candidate");
    if (napi_remove_env_cleanup_hook(env, SSCloseSuccessor, (__bridge void *)handle) != napi_ok)
      return SSSuccessorError(env, "Could not release update handle");
    SSCloseSuccessor((__bridge void *)handle);
    napi_value result; napi_get_undefined(env, &result); return result;
  }
}
