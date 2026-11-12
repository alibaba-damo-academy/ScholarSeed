// Contract-only bridge: real kernel readers over an explicit test-owned inventory.
#import <Foundation/Foundation.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <node_api.h>
#include <errno.h>
#include <unistd.h>

static NSArray<NSNumber *> *SSFixtureChildren;
static pid_t SSFixtureDeniedMappingProcess;
static NSUInteger SSFixtureMappingDenials;

static int FixtureSysctl(int *name, u_int length, void *output, size_t *bytes, void *input, size_t inputBytes) {
    if (length != 4 || name[0] != CTL_KERN || name[1] != KERN_PROC || name[2] != KERN_PROC_ALL)
        return sysctl(name, length, output, bytes, input, inputBytes);
    if (!SSFixtureChildren || !bytes || input || inputBytes) { errno = EINVAL; return -1; }
    NSMutableData *inventory = [NSMutableData data];
    for (NSNumber *value in [@[@(getpid())] arrayByAddingObjectsFromArray:SSFixtureChildren]) {
        int query[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, value.intValue};
        struct kinfo_proc process = {0};
        size_t size = sizeof(process);
        if (sysctl(query, 4, &process, &size, NULL, 0) != 0) return -1;
        if (!size) continue;
        if (size != sizeof(process)) { errno = EIO; return -1; }
        [inventory appendBytes:&process length:size];
    }
    if (output && *bytes < inventory.length) { *bytes = inventory.length; errno = ENOMEM; return -1; }
    if (output) memcpy(output, inventory.bytes, inventory.length);
    *bytes = inventory.length;
    return 0;
}

static int FixturePidInfo(int process, int flavor, uint64_t argument, void *buffer, int bytes) {
    if (process == SSFixtureDeniedMappingProcess && flavor == PROC_PIDREGIONPATHINFO) {
        SSFixtureMappingDenials++;
        errno = EPERM;
        return 0;
    }
    return proc_pidinfo(process, flavor, argument, buffer, bytes);
}

// Keep all seams in this translation unit, outside the shipped repair.node.
#define sysctl FixtureSysctl
#define proc_pidinfo FixturePidInfo
#define SSBridgeHolder SSRepairContractHolder
#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc)
#import "bridge.m"
#undef sysctl
#undef proc_pidinfo
#undef SSBridgeHolder
#undef NAPI_MODULE

static napi_value FixtureProcessScope(napi_env environment, napi_callback_info info) {
    @autoreleasepool {
        size_t count = 3;
        napi_value arguments[3], result;
        bool array = false;
        uint32_t length = 0;
        int32_t denied = 0;
        if (napi_get_cb_info(environment, info, &count, arguments, NULL, NULL) != napi_ok || count != 2 ||
            napi_is_array(environment, arguments[0], &array) != napi_ok || !array ||
            napi_get_array_length(environment, arguments[0], &length) != napi_ok || length > 16 ||
            napi_get_value_int32(environment, arguments[1], &denied) != napi_ok || denied < 0)
            return BridgeFail(environment, "ERR_FIXTURE_SCOPE", EINVAL);
        pthread_mutex_lock(&SSBridgeMutex);
        @try {
            if (SSBridgeActive) return BridgeFail(environment, "ERR_FIXTURE_SCOPE", EBUSY);
            NSMutableArray *children = [NSMutableArray array];
            for (uint32_t index = 0; index < length; index++) {
                napi_value value;
                int32_t process = 0;
                SSProcessIdentity identity;
                BOOL present = NO;
                if (napi_get_element(environment, arguments[0], index, &value) != napi_ok ||
                    napi_get_value_int32(environment, value, &process) != napi_ok || process <= 0 ||
                    [children containsObject:@(process)] || !ObserveIdentity(process, &identity, &present) || !present ||
                    identity.parentPidAtSnapshot != getpid())
                    return BridgeFail(environment, "ERR_FIXTURE_SCOPE", EINVAL);
                [children addObject:@(process)];
            }
            if (denied && ![children containsObject:@(denied)]) return BridgeFail(environment, "ERR_FIXTURE_SCOPE", EINVAL);
            SSFixtureChildren = [children copy];
            SSFixtureDeniedMappingProcess = denied;
            SSFixtureMappingDenials = 0;
            napi_get_undefined(environment, &result);
            return result;
        } @finally { pthread_mutex_unlock(&SSBridgeMutex); }
    }
}

static napi_value FixtureMappingDenials(napi_env environment, napi_callback_info info) {
    (void)info;
    napi_value result;
    if (napi_create_uint32(environment, (uint32_t)SSFixtureMappingDenials, &result) != napi_ok)
        return BridgeFail(environment, "ERR_FIXTURE_SCOPE", EIO);
    return result;
}

NAPI_MODULE_INIT() {
    napi_value initialized = BridgeInitialize(env, exports);
    if (!initialized) return NULL;
    napi_property_descriptor methods[] = {
        {.utf8name = "processScope", .method = FixtureProcessScope, .attributes = napi_default},
        {.utf8name = "mappingDenials", .method = FixtureMappingDenials, .attributes = napi_default},
    };
    if (napi_define_properties(env, exports, 2, methods) != napi_ok) return BridgeFail(env, "ERR_FIXTURE_SCOPE", EIO);
    return exports;
}
