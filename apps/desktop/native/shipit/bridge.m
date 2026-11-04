#define SS_PREFLIGHT_EMBED 1
#import "preflight.m"
#include <node_api.h>
#include <pthread.h>
#include <stdint.h>

typedef NS_ENUM(NSUInteger, SSBridgeState) {
    SSBridgeObserved,
    SSBridgeRejected,
    SSBridgeClosed,
    SSBridgeUncertain,
};

@interface SSBridgeHolder : NSObject
@property(nonatomic, strong) NSDictionary *config;
@property(nonatomic, strong) NSDictionary *selection;
@property(nonatomic, strong) NSDictionary *baseline;
@property(nonatomic, strong) NSMutableArray *pins;
@property(nonatomic, assign) napi_env environment;
@property(nonatomic, assign) pthread_t thread;
@property(nonatomic, assign) pid_t process;
@property(nonatomic, assign) uint64_t generation;
@property(nonatomic, assign) SSBridgeState state;
@property(nonatomic, assign) int uncertaintyCode;
@end

@implementation SSBridgeHolder
@end

static pthread_mutex_t SSBridgeMutex = PTHREAD_MUTEX_INITIALIZER;
static SSBridgeHolder *SSBridgeActive;
static uint64_t SSBridgeGeneration;
static const napi_type_tag SSBridgeTag = {UINT64_C(0x1ccbd912f4c449f1), UINT64_C(0xb28f679535ad59e3)};

static int BridgeUncertain(SSBridgeHolder *holder, int code) {
    if (!holder) return code ?: EIO;
    if (!holder.uncertaintyCode) holder.uncertaintyCode = code ?: EIO;
    holder.state = SSBridgeUncertain;
    return holder.uncertaintyCode;
}

static napi_value BridgeFallback(napi_env environment, const char *code) {
    BOOL critical = strcmp(code, "ERR_TERMINAL_RELEASE") == 0;
    bool pending = false;
    if (critical && (napi_is_exception_pending(environment, &pending) != napi_ok || pending))
        napi_fatal_error("terminal-recovery", NAPI_AUTO_LENGTH, "terminal qualification release could not be reported", NAPI_AUTO_LENGTH);
    if (napi_throw_error(environment, code, "terminal observation failed") != napi_ok && critical)
        napi_fatal_error("terminal-recovery", NAPI_AUTO_LENGTH, "terminal qualification release could not be reported", NAPI_AUTO_LENGTH);
    return NULL;
}

static napi_value BridgeFail(napi_env environment, const char *code, int system) {
    napi_value name, failure, detail;
    if (napi_create_string_utf8(environment, code, NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_error(environment, name, name, &failure) != napi_ok ||
        napi_create_int32(environment, system, &detail) != napi_ok) return BridgeFallback(environment, code);
    napi_property_descriptor property = {.utf8name = "systemCode", .value = detail, .attributes = napi_default};
    if (napi_define_properties(environment, failure, 1, &property) != napi_ok || napi_throw(environment, failure) != napi_ok)
        return BridgeFallback(environment, code);
    return NULL;
}

static BOOL BridgePath(id value) {
    return [value isKindOfClass:NSString.class] && [value hasPrefix:@"/"] &&
        [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= SSPreflightArgumentBytes &&
        [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound &&
        ![[value pathComponents] containsObject:@"."] && ![[value pathComponents] containsObject:@".."];
}

static NSDictionary *BridgeConfig(napi_env environment, napi_value argument) {
    size_t length = 0, copied = 0;
    if (napi_get_value_string_utf8(environment, argument, NULL, 0, &length) != napi_ok || !length || length > SSPreflightArgumentBytes) return nil;
    char *buffer = calloc(length + 1, 1);
    if (!buffer) return nil;
    BOOL valid = napi_get_value_string_utf8(environment, argument, buffer, length + 1, &copied) == napi_ok && copied == length && strlen(buffer) == length;
    NSData *bytes = valid ? [NSData dataWithBytes:buffer length:length] : nil;
    free(buffer);
    NSDictionary *config = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL] : nil;
    if (![config isKindOfClass:NSDictionary.class] || config.count != 8 || !SSObservationInteger(config[@"schema"]) || ![config[@"schema"] isEqual:@1] ||
        !SSBindingValid(config[@"binding"]) || ![config[@"selection"] isKindOfClass:NSDictionary.class]) return nil;
    for (NSString *key in @[@"cleanup", @"preparation", @"source", @"target", @"state"]) if (!BridgePath(config[key])) return nil;
    id roots = config[@"selection"][@"paths"];
    if (![roots isKindOfClass:NSArray.class] || [roots count] != 3) return nil;
    for (id root in roots) if (!BridgePath(root)) return nil;
    return config;
}

static BOOL BridgeReleasePins(SSBridgeHolder *holder, NSMutableArray *pins, NSError **error) {
    while (pins.count) {
        NSValue *value = pins.lastObject;
        [pins removeLastObject];
        uint32_t failure = directory_close(value.pointerValue);
        if (failure) {
            BridgeUncertain(holder, (int)failure);
            if (pins != holder.pins) {
                [holder.pins addObjectsFromArray:pins];
                [pins removeAllObjects];
            }
            return SSObservationFail(error, (int)failure);
        }
    }
    return YES;
}

static BOOL BridgeClose(SSBridgeHolder *holder, NSError **error) {
    if (holder.state == SSBridgeUncertain) return SSObservationFail(error, holder.uncertaintyCode ?: EIO);
    if (!SSPreparationCloseChecked(error) || !SSCleanupCloseChecked(error)) {
        BridgeUncertain(holder, error && *error ? (int)(*error).code : errno);
        return NO;
    }
    if (!BridgeReleasePins(holder, holder.pins, error)) return NO;
    holder.state = SSBridgeClosed;
    if (SSBridgeActive == holder) SSBridgeActive = nil;
    return YES;
}

static NSDictionary *BridgeObserve(SSBridgeHolder *holder, NSError **error) {
    NSMutableArray *pins = [NSMutableArray array];
    NSDictionary *before = InspectSelection(holder.config[@"selection"], pins, error);
    NSDictionary *proof = nil;
    if ([before isEqual:holder.selection]) {
        NSURL *source = [NSURL fileURLWithPath:holder.config[@"source"]], *target = [NSURL fileURLWithPath:holder.config[@"target"]];
        NSDictionary *observed = SSPreparationFailureSnapshot(source, target, holder.config[@"binding"], [NSURL fileURLWithPath:holder.config[@"state"]],
            ^SSPreparationActivity { return InspectActivity(source, target); }, error);
        int uncertainty = SSPreparationUncertaintyCode();
        if (uncertainty) {
            [holder.pins addObjectsFromArray:pins];
            [pins removeAllObjects];
            BridgeUncertain(holder, uncertainty);
            SSObservationFail(error, uncertainty);
            return nil;
        }
        NSDictionary *after = observed ? InspectSelection(holder.config[@"selection"], pins, error) : nil;
        if (observed && [after isEqual:holder.selection]) {
            NSMutableDictionary *result = [observed mutableCopy];
            result[@"selection"] = after;
            proof = result;
        }
    }
    if (!BridgeReleasePins(holder, pins, error)) return nil;
    if (!proof || (holder.baseline && ![holder.baseline isEqual:proof])) {
        holder.state = SSBridgeRejected;
        if (proof || !error || !*error) SSObservationFail(error, ESTALE);
        return nil;
    }
    return proof;
}

static SSBridgeHolder *BridgeLookup(napi_env environment, napi_callback_info info) {
    size_t arguments = 1;
    napi_value receiver;
    void *opaque = NULL;
    bool tagged = false;
    if (napi_get_cb_info(environment, info, &arguments, NULL, &receiver, NULL) != napi_ok || arguments != 0 ||
        napi_check_object_type_tag(environment, receiver, &SSBridgeTag, &tagged) != napi_ok || !tagged ||
        napi_unwrap(environment, receiver, &opaque) != napi_ok || !opaque) return nil;
    SSBridgeHolder *holder = (__bridge SSBridgeHolder *)opaque;
    if (holder.environment != environment || holder.process != getpid() || !pthread_equal(holder.thread, pthread_self())) return nil;
    return holder;
}

static napi_value BridgeObserveCall(napi_env environment, napi_callback_info info) {
    @autoreleasepool {
        pthread_mutex_lock(&SSBridgeMutex);
        @try {
            SSBridgeHolder *holder = BridgeLookup(environment, info);
            if (!holder) return BridgeFail(environment, "ERR_TERMINAL_HANDLE", EINVAL);
            if (holder.state == SSBridgeClosed) return BridgeFail(environment, "ERR_TERMINAL_CLOSED", EBADF);
            if (holder.state == SSBridgeUncertain) return BridgeFail(environment, "ERR_TERMINAL_RELEASE", holder.uncertaintyCode ?: EIO);
            if (holder.state != SSBridgeObserved || SSBridgeActive != holder || holder.generation != SSBridgeGeneration)
                return BridgeFail(environment, "ERR_TERMINAL_OBSERVATION", ESTALE);
            NSError *failure = nil;
            NSDictionary *proof = BridgeObserve(holder, &failure);
            if (!proof) return BridgeFail(environment, holder.state == SSBridgeUncertain ? "ERR_TERMINAL_RELEASE" : "ERR_TERMINAL_OBSERVATION",
                holder.state == SSBridgeUncertain ? holder.uncertaintyCode ?: EIO : (int)failure.code ?: EIO);
            NSData *bytes = [NSJSONSerialization dataWithJSONObject:@{@"schema":@1, @"mode":@"inspect", @"proof":proof} options:NSJSONWritingSortedKeys error:NULL];
            napi_value result;
            if (!bytes || napi_create_string_utf8(environment, bytes.bytes, bytes.length, &result) != napi_ok) {
                holder.state = SSBridgeRejected;
                return BridgeFail(environment, "ERR_TERMINAL_NATIVE", EIO);
            }
            return result;
        } @catch (__unused NSException *exception) {
            return BridgeFail(environment, "ERR_TERMINAL_RELEASE", BridgeUncertain(SSBridgeActive, EIO));
        } @finally { pthread_mutex_unlock(&SSBridgeMutex); }
    }
}

static napi_value BridgeCloseCall(napi_env environment, napi_callback_info info) {
    @autoreleasepool {
        pthread_mutex_lock(&SSBridgeMutex);
        @try {
            SSBridgeHolder *holder = BridgeLookup(environment, info);
            if (!holder) return BridgeFail(environment, "ERR_TERMINAL_HANDLE", EINVAL);
            if (holder.state != SSBridgeClosed) {
                if (SSBridgeActive != holder || holder.generation != SSBridgeGeneration) return BridgeFail(environment, "ERR_TERMINAL_HANDLE", ESTALE);
                NSError *failure = nil;
                if (!BridgeClose(holder, &failure)) return BridgeFail(environment, "ERR_TERMINAL_RELEASE", (int)failure.code ?: EIO);
            }
            napi_value result;
            if (napi_get_undefined(environment, &result) != napi_ok) return BridgeFail(environment, "ERR_TERMINAL_NATIVE", EIO);
            return result;
        } @catch (__unused NSException *exception) {
            return BridgeFail(environment, "ERR_TERMINAL_RELEASE", BridgeUncertain(SSBridgeActive, EIO));
        } @finally { pthread_mutex_unlock(&SSBridgeMutex); }
    }
}

static void BridgeFinalize(napi_env environment, void *data, void *hint) {
    (void)environment; (void)hint;
    CFRelease(data);
}

static napi_value BridgeOpen(napi_env environment, napi_callback_info info) {
    @autoreleasepool {
        size_t arguments = 2;
        napi_value argv[2];
        if (napi_get_cb_info(environment, info, &arguments, argv, NULL, NULL) != napi_ok || arguments != 1 || getuid() != geteuid())
            return BridgeFail(environment, "ERR_TERMINAL_ARGUMENT", EINVAL);
        NSDictionary *config = BridgeConfig(environment, argv[0]);
        if (!config) return BridgeFail(environment, "ERR_TERMINAL_ARGUMENT", EINVAL);
        pthread_mutex_lock(&SSBridgeMutex);
        @try {
            if (SSBridgeActive.state == SSBridgeUncertain) return BridgeFail(environment, "ERR_TERMINAL_RELEASE", SSBridgeActive.uncertaintyCode ?: EIO);
            if (SSBridgeActive || SSBridgeGeneration == UINT64_MAX) return BridgeFail(environment, "ERR_TERMINAL_BUSY", EBUSY);
            SSBridgeHolder *holder = [SSBridgeHolder new];
            holder.environment = environment; holder.thread = pthread_self(); holder.process = getpid();
            holder.generation = ++SSBridgeGeneration; holder.config = config; holder.pins = [NSMutableArray array];
            SSBridgeActive = holder;
            NSError *failure = nil;
            const char *code = "ERR_TERMINAL_ARGUMENT";
            holder.selection = InspectSelection(config[@"selection"], holder.pins, &failure);
            BOOL ready = holder.selection != nil;
            if (ready) {
                code = "ERR_TERMINAL_OPEN";
                ready = SSCleanupOpenExistingDirectory(config[@"cleanup"], &failure) && SSPreparationOpenExistingDirectory(config[@"preparation"], &failure);
            }
            if (ready) {
                code = "ERR_TERMINAL_OBSERVATION";
                holder.baseline = BridgeObserve(holder, &failure);
                ready = holder.baseline != nil;
            }
            napi_value result;
            if (ready) {
                code = "ERR_TERMINAL_NATIVE";
                ready = napi_create_object(environment, &result) == napi_ok && napi_type_tag_object(environment, result, &SSBridgeTag) == napi_ok;
                if (ready) {
                    void *opaque = (void *)CFBridgingRetain(holder);
                    ready = napi_wrap(environment, result, opaque, BridgeFinalize, NULL, NULL) == napi_ok;
                    if (!ready) CFRelease(opaque);
                }
                napi_property_descriptor methods[] = {
                    {.utf8name = "observe", .method = BridgeObserveCall, .attributes = napi_default},
                    {.utf8name = "close", .method = BridgeCloseCall, .attributes = napi_default},
                };
                if (ready) ready = napi_define_properties(environment, result, 2, methods) == napi_ok;
            }
            if (ready) return result;
            int uncertainty = SSPreparationUncertaintyCode();
            if (uncertainty) BridgeUncertain(holder, uncertainty);
            if (holder.state == SSBridgeUncertain) return BridgeFail(environment, "ERR_TERMINAL_RELEASE", holder.uncertaintyCode ?: EIO);
            int system = (int)failure.code ?: EIO;
            NSError *release = nil;
            if (!BridgeClose(holder, &release)) return BridgeFail(environment, "ERR_TERMINAL_RELEASE", (int)release.code ?: EIO);
            return BridgeFail(environment, code, system);
        } @catch (__unused NSException *exception) {
            return BridgeFail(environment, "ERR_TERMINAL_RELEASE", BridgeUncertain(SSBridgeActive, EIO));
        } @finally { pthread_mutex_unlock(&SSBridgeMutex); }
    }
}

static napi_value BridgeInitialize(napi_env environment, napi_value exports) {
    napi_property_descriptor method = {.utf8name = "open", .method = BridgeOpen, .attributes = napi_default};
    if (napi_define_properties(environment, exports, 1, &method) != napi_ok) return BridgeFail(environment, "ERR_TERMINAL_NATIVE", EIO);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, BridgeInitialize)
