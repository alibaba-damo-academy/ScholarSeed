#import "cleanup.h"
#import "preparation.h"
#import "binding.h"
#import "observation.h"
#include "../directory.h"
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <time.h>

#define SS_PREFLIGHT_REPORTED_NAME_BYTES (sizeof(((struct kinfo_proc *)0)->kp_proc.p_comm))
#define SS_PREFLIGHT_REPORTED_NAME_ESCAPE_BYTES 4

typedef struct {
    pid_t process;
    uid_t owner;
    uid_t real;
    uid_t saved;
    struct timeval started;
    unsigned char status;
    pid_t parentPidAtSnapshot;
    char reportedName[SS_PREFLIGHT_REPORTED_NAME_BYTES];
} SSProcessIdentity;

typedef BOOL (^SSProcessIdentityRead)(pid_t process, SSProcessIdentity *identity, BOOL *present);
typedef NSString *(^SSProcessImageRead)(pid_t process);

#define SS_PREFLIGHT_DIFFERENCE_LIMIT 8
typedef NS_ENUM(NSUInteger, SSProcessDifferenceKind) {
    SSProcessDifferenceNone,
    SSProcessDifferenceNew,
    SSProcessDifferenceReused,
    SSProcessDifferenceZombieToLive,
    SSProcessDifferenceStarting,
};
typedef struct {
    SSProcessDifferenceKind kind;
    BOOL hasBefore;
    SSProcessIdentity before;
    SSProcessIdentity after;
} SSProcessDifference;
typedef struct {
    BOOL valid;
    NSUInteger beforeCount, afterCount, total, count;
    SSProcessDifference differences[SS_PREFLIGHT_DIFFERENCE_LIMIT];
} SSInventoryDiagnostic;

static const char *DifferenceName(SSProcessDifferenceKind kind) {
    switch (kind) {
        case SSProcessDifferenceNew: return "new";
        case SSProcessDifferenceReused: return "reused";
        case SSProcessDifferenceZombieToLive: return "zombie-to-live";
        case SSProcessDifferenceStarting: return "sidl";
        default: return "unknown";
    }
}

static NSString *ReportedName(SSProcessIdentity identity) {
    int saved = errno;
    const char hexadecimal[] = "0123456789abcdef";
    char escaped[sizeof(identity.reportedName) * SS_PREFLIGHT_REPORTED_NAME_ESCAPE_BYTES + 1] = {0};
    NSUInteger offset = 0;
    for (NSUInteger index = 0; index < sizeof(identity.reportedName) && identity.reportedName[index]; index++) {
        unsigned char character = (unsigned char)identity.reportedName[index];
        BOOL literal = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-';
        if (literal) escaped[offset++] = (char)character;
        else {
            escaped[offset++] = '\\';
            escaped[offset++] = 'x';
            escaped[offset++] = hexadecimal[character >> 4];
            escaped[offset++] = hexadecimal[character & 0x0f];
        }
    }
    NSString *name = @(escaped);
    errno = saved;
    return name;
}

static SSProcessIdentity KernelIdentity(struct kinfo_proc process) {
    SSProcessIdentity identity = {.process = process.kp_proc.p_pid, .owner = process.kp_eproc.e_ucred.cr_uid,
        .real = process.kp_eproc.e_pcred.p_ruid, .saved = process.kp_eproc.e_pcred.p_svuid,
        .started = process.kp_proc.p_starttime, .status = process.kp_proc.p_stat, .parentPidAtSnapshot = process.kp_eproc.e_ppid};
    memcpy(identity.reportedName, process.kp_proc.p_comm, sizeof(identity.reportedName));
    return identity;
}

static BOOL ValidProcess(SSProcessIdentity identity) {
    return identity.process >= 0 && identity.status >= SIDL && identity.status <= SZOMB &&
        (identity.process == 0 || (identity.started.tv_sec > 0 && identity.started.tv_usec >= 0 && identity.started.tv_usec < 1000000));
}

static BOOL EqualProcess(SSProcessIdentity left, SSProcessIdentity right) {
    return left.process == right.process && left.owner == right.owner && left.real == right.real && left.saved == right.saved &&
        left.started.tv_sec == right.started.tv_sec && left.started.tv_usec == right.started.tv_usec;
}

static BOOL ScopedProcess(SSProcessIdentity identity, uid_t current) {
    return identity.process > 0 && (identity.owner == 0 || identity.owner == current || identity.real == 0 || identity.real == current || identity.saved == 0 || identity.saved == current);
}

static NSDictionary *ProcessInventory(NSArray *processes, uid_t current, pid_t observer) {
    if (!processes.count) return nil;
    NSMutableDictionary *inventory = [NSMutableDictionary dictionary];
    BOOL observed = NO;
    for (id value in processes) {
        if (![value isKindOfClass:NSValue.class] || strcmp([value objCType], @encode(SSProcessIdentity)) != 0) return nil;
        SSProcessIdentity identity;
        [value getValue:&identity size:sizeof(identity)];
        if (!ValidProcess(identity) || inventory[@(identity.process)]) return nil;
        inventory[@(identity.process)] = value;
        if (identity.process == observer && identity.owner == current && identity.status != SZOMB) observed = YES;
    }
    return observed ? inventory : nil;
}

static BOOL ObserveImage(SSProcessIdentity expected, SSProcessIdentityRead readIdentity, SSProcessImageRead readImage, NSString **image, BOOL *exited) {
    *exited = NO;
    *image = nil;
    if (!ValidProcess(expected) || expected.process <= 0 || expected.status == SIDL || !readIdentity || !readImage) return NO;
    if (expected.status == SZOMB) { *exited = YES; return YES; }
    NSString *first = nil;
    for (NSUInteger index = 0; index < 3; index++) {
        SSProcessIdentity current;
        BOOL present = NO;
        if (!readIdentity(expected.process, &current, &present)) return NO;
        if (!present) { *exited = YES; return YES; }
        if (!ValidProcess(current) || !EqualProcess(expected, current)) return NO;
        if (current.status == SZOMB) { *exited = YES; return YES; }
        if (current.status == SIDL) return NO;
        if (index == 2) break;
        NSString *path = readImage(expected.process);
        if (!path) {
            if (errno != ESRCH) return NO;
            if (!readIdentity(expected.process, &current, &present)) return NO;
            if (!present || (ValidProcess(current) && EqualProcess(expected, current) && current.status == SZOMB)) { *exited = YES; return YES; }
            return NO;
        }
        if (!first) first = path;
        else if (![first isEqual:path]) return NO;
    }
    *image = first;
    return first != nil;
}

static SSPreparationActivity ClassifyProcess(SSProcessIdentity identity, NSArray *prefixes,
    BOOL (^readImage)(SSProcessIdentity, NSString **, BOOL *), NSString *(^canonicalize)(NSString *), BOOL *live) {
    *live = NO;
    if (identity.status == SIDL) return SSPreparationActivityUnknown;
    NSString *path = nil;
    BOOL exited = NO;
    if (!readImage(identity, &path, &exited)) return SSPreparationActivityUnknown;
    if (exited) return SSPreparationActivityAbsent;
    if (![path hasPrefix:@"/"] || [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return SSPreparationActivityUnknown;
    BOOL known = [path.lastPathComponent isEqual:@"ShipIt"];
    for (NSString *prefix in prefixes) known = known || [path hasPrefix:prefix];
    if (!known) {
        NSString *canonical = canonicalize(path);
        if (![canonical hasPrefix:@"/"] || [canonical rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return SSPreparationActivityUnknown;
        known = [canonical.lastPathComponent isEqual:@"ShipIt"];
        for (NSString *prefix in prefixes) known = known || [canonical hasPrefix:prefix];
    }
    *live = YES;
    return known ? SSPreparationActivityActive : SSPreparationActivityAbsent;
}

static SSPreparationActivity ClassifyActivity(NSArray *processes, uid_t current, pid_t observer, NSURL *source, NSURL *target,
    BOOL (^readImage)(SSProcessIdentity, NSString **, BOOL *), NSString *(^canonicalize)(NSString *), NSMutableDictionary *coverage) {
    if (!ProcessInventory(processes, current, observer) || !readImage || !canonicalize) return SSPreparationActivityUnknown;
    NSArray *prefixes = @[[source.path stringByAppendingPathComponent:@"Contents/"], [target.path stringByAppendingPathComponent:@"Contents/"]];
    BOOL active = NO;
    for (NSValue *value in processes) {
        SSProcessIdentity identity;
        [value getValue:&identity size:sizeof(identity)];
        if (!ScopedProcess(identity, current)) continue;
        BOOL live = NO;
        SSPreparationActivity activity = ClassifyProcess(identity, prefixes, readImage, canonicalize, &live);
        if (activity == SSPreparationActivityUnknown) return activity;
        if (live && coverage) coverage[@(identity.process)] = value;
        active = active || activity == SSPreparationActivityActive;
    }
    return active ? SSPreparationActivityActive : SSPreparationActivityAbsent;
}

static SSProcessDifferenceKind InventoryDifference(NSValue *original, SSProcessIdentity identity, SSProcessIdentity *previous) {
    *previous = (SSProcessIdentity){0};
    if (!original) return SSProcessDifferenceNew;
    [original getValue:previous size:sizeof(*previous)];
    if (!EqualProcess(*previous, identity)) return SSProcessDifferenceReused;
    if (previous->status == SZOMB) return SSProcessDifferenceZombieToLive;
    if (identity.status == SIDL) return SSProcessDifferenceStarting;
    return SSProcessDifferenceNone;
}

static BOOL RelatedProcess(NSValue *original, SSProcessIdentity identity, uid_t current) {
    if (identity.status == SZOMB) return NO;
    if (ScopedProcess(identity, current)) return YES;
    if (!original) return NO;
    SSProcessIdentity previous;
    [original getValue:&previous size:sizeof(previous)];
    return ScopedProcess(previous, current);
}

static BOOL SameInventory(NSArray *before, NSArray *after, uid_t current, pid_t observer, SSInventoryDiagnostic *diagnostic) {
    int saved = errno;
    NSDictionary *earlier = ProcessInventory(before, current, observer), *later = ProcessInventory(after, current, observer);
    SSInventoryDiagnostic result = {.valid = earlier != nil && later != nil, .beforeCount = before.count, .afterCount = after.count};
    BOOL same = result.valid;
    for (NSValue *value in result.valid ? later.allValues : @[]) {
        SSProcessIdentity identity, previous = {0};
        [value getValue:&identity size:sizeof(identity)];
        NSValue *original = earlier[@(identity.process)];
        if (!RelatedProcess(original, identity, current)) continue;
        SSProcessDifferenceKind kind = InventoryDifference(original, identity, &previous);
        if (kind == SSProcessDifferenceNone) continue;
        same = NO;
        result.total++;
        if (result.count < SS_PREFLIGHT_DIFFERENCE_LIMIT)
            result.differences[result.count++] = (SSProcessDifference){.kind = kind, .hasBefore = original != nil, .before = previous, .after = identity};
    }
    if (diagnostic) *diagnostic = result;
    errno = saved;
    return same;
}

static BOOL CoveredProcess(NSDictionary *coverage, SSProcessIdentity identity) {
    NSValue *record = coverage[@(identity.process)];
    if (!record) return NO;
    SSProcessIdentity observed;
    [record getValue:&observed size:sizeof(observed)];
    return EqualProcess(observed, identity);
}

static const double SSPreflightProcessSeconds = 2;

static SSPreparationActivity ObserveActivity(uid_t current, pid_t observer, NSURL *source, NSURL *target,
    NSArray *(^readInventory)(void), BOOL (^readImage)(SSProcessIdentity, NSString **, BOOL *), NSString *(^canonicalize)(NSString *),
    double (^clock)(void), void (^unavailable)(NSString *, int, const SSInventoryDiagnostic *, double)) {
    if (!readInventory || !readImage || !canonicalize || !clock) return SSPreparationActivityUnknown;
    double started = clock();
    SSPreparationActivity (^unknown)(NSString *, int, const SSInventoryDiagnostic *) = ^SSPreparationActivity(NSString *operation, int code, const SSInventoryDiagnostic *diagnostic) {
        if (unavailable) unavailable(operation, code, diagnostic, started);
        return SSPreparationActivityUnknown;
    };
    BOOL (^withinDeadline)(void) = ^BOOL {
        double now = clock();
        if (started < 0 || now < started || now - started >= SSPreflightProcessSeconds) { errno = ETIMEDOUT; return NO; }
        return YES;
    };
    BOOL (^checkedImage)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity identity, NSString **path, BOOL *exited) {
        return withinDeadline() && readImage(identity, path, exited);
    };
    NSArray *initial = started >= 0 ? readInventory() : nil;
    NSDictionary *original = ProcessInventory(initial, current, observer);
    if (!original) return unknown(@"kernel-inventory", errno ?: EAGAIN, NULL);
    NSMutableDictionary *coverage = [NSMutableDictionary dictionary];
    SSPreparationActivity activity = ClassifyActivity(initial, current, observer, source, target, checkedImage, canonicalize, coverage);
    if (activity == SSPreparationActivityUnknown) return unknown(@"kernel-identity-or-image", errno ?: EAGAIN, NULL);
    if (activity == SSPreparationActivityActive) return activity;
    if (!withinDeadline()) return unknown(@"kernel-observation-time", ETIMEDOUT, NULL);
    NSArray *middle = readInventory();
    if (!ProcessInventory(middle, current, observer)) return unknown(@"kernel-inventory-final", errno ?: EAGAIN, NULL);
    NSMutableArray *pending = [NSMutableArray array];
    for (NSValue *value in middle) {
        SSProcessIdentity identity, previous;
        [value getValue:&identity size:sizeof(identity)];
        NSValue *record = original[@(identity.process)];
        if (!RelatedProcess(record, identity, current)) continue;
        SSProcessDifferenceKind kind = InventoryDifference(record, identity, &previous);
        if (kind == SSProcessDifferenceNew && identity.status != SIDL) { [pending addObject:value]; continue; }
        if (kind != SSProcessDifferenceNone) {
            SSInventoryDiagnostic diagnostic;
            SameInventory(initial, middle, current, observer, &diagnostic);
            return unknown(@"kernel-inventory-changed", ESTALE, &diagnostic);
        }
        if (!CoveredProcess(coverage, identity)) return unknown(@"kernel-live-coverage", ESTALE, NULL);
    }
    if (!withinDeadline()) return unknown(@"kernel-observation-time", ETIMEDOUT, NULL);
    if (!pending.count) return SSPreparationActivityAbsent;
    NSArray *prefixes = @[[source.path stringByAppendingPathComponent:@"Contents/"], [target.path stringByAppendingPathComponent:@"Contents/"]];
    for (NSValue *value in pending) {
        SSProcessIdentity identity;
        [value getValue:&identity size:sizeof(identity)];
        BOOL live = NO;
        activity = ClassifyProcess(identity, prefixes, checkedImage, canonicalize, &live);
        if (activity == SSPreparationActivityUnknown) return unknown(@"kernel-identity-or-image", errno ?: EAGAIN, NULL);
        if (activity == SSPreparationActivityActive) return activity;
        if (live) coverage[@(identity.process)] = value;
    }
    if (!withinDeadline()) return unknown(@"kernel-observation-time", ETIMEDOUT, NULL);
    NSArray *final = readInventory();
    if (!final) return unknown(@"kernel-inventory-closure", errno ?: EAGAIN, NULL);
    SSInventoryDiagnostic diagnostic;
    if (!SameInventory(middle, final, current, observer, &diagnostic)) return unknown(@"kernel-inventory-changed", ESTALE, &diagnostic);
    for (NSValue *value in final) {
        SSProcessIdentity identity;
        [value getValue:&identity size:sizeof(identity)];
        if (ScopedProcess(identity, current) && identity.status != SZOMB && !CoveredProcess(coverage, identity))
            return unknown(@"kernel-live-coverage", ESTALE, NULL);
    }
    if (!withinDeadline()) return unknown(@"kernel-observation-time", ETIMEDOUT, NULL);
    return SSPreparationActivityAbsent;
}

#ifndef SS_PREFLIGHT_CONTRACT
static const NSUInteger SSPreflightArgumentBytes = 64 * 1024;
static const NSUInteger SSPreflightProcessBytes = 16 * 1024 * 1024;
static const NSUInteger SSPreflightProcessPadding = 64;

static SSPreparationActivity UnavailableActivity(NSString *operation, int code) {
    int saved = errno;
    NSLog(@"[shipit-preflight] event=process-evidence-unavailable operation=%@ errno=%d", operation, code);
    errno = saved;
    return SSPreparationActivityUnknown;
}

static double ProcessTime(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static void LogInventoryDifference(const SSInventoryDiagnostic *diagnostic, double started) {
    int saved = errno;
    double finished = ProcessTime();
    double elapsed = started >= 0 && finished >= started ? (finished - started) * 1000.0 : -1;
    NSLog(@"[shipit-preflight] event=kernel-inventory-delta inventoriesValid=%s before=%lu after=%lu total=%lu emitted=%lu truncated=%lu elapsedMs=%.3f",
        diagnostic->valid ? "true" : "false", (unsigned long)diagnostic->beforeCount, (unsigned long)diagnostic->afterCount,
        (unsigned long)diagnostic->total, (unsigned long)diagnostic->count, (unsigned long)(diagnostic->total - diagnostic->count), elapsed);
    for (NSUInteger index = 0; index < diagnostic->count; index++) {
        SSProcessDifference difference = diagnostic->differences[index];
        NSLog(@"[shipit-preflight] event=kernel-inventory-difference index=%lu change=%s pid=%d beforePresent=%s beforeUid=%u beforeRealUid=%u beforeSavedUid=%u beforeStartSec=%lld beforeStartUsec=%d beforeStatus=%u beforeParentPidAtSnapshot=%d beforeReportedName=\"%@\" afterUid=%u afterRealUid=%u afterSavedUid=%u afterStartSec=%lld afterStartUsec=%d afterStatus=%u afterParentPidAtSnapshot=%d afterReportedName=\"%@\" reportedNameAuthority=untrusted reportedNameSource=kernel-p_comm parentPidMeaning=snapshot-current-parent imageClass=unobserved",
            (unsigned long)index, DifferenceName(difference.kind), difference.after.process, difference.hasBefore ? "true" : "false",
            difference.before.owner, difference.before.real, difference.before.saved, (long long)difference.before.started.tv_sec, difference.before.started.tv_usec, (unsigned)difference.before.status,
            difference.before.parentPidAtSnapshot, ReportedName(difference.before),
            difference.after.owner, difference.after.real, difference.after.saved, (long long)difference.after.started.tv_sec, difference.after.started.tv_usec, (unsigned)difference.after.status,
            difference.after.parentPidAtSnapshot, ReportedName(difference.after));
    }
    errno = saved;
}

static NSArray *ObserveProcesses(void) {
    int query[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    size_t bytes = 0, padding = SSPreflightProcessPadding * sizeof(struct kinfo_proc);
    if (sysctl(query, 4, NULL, &bytes, NULL, 0) != 0 || !bytes || bytes > SSPreflightProcessBytes - padding || bytes % sizeof(struct kinfo_proc)) return nil;
    size_t capacity = bytes + padding;
    struct kinfo_proc *processes = calloc(1, capacity);
    if (!processes) return nil;
    bytes = capacity;
    BOOL complete = sysctl(query, 4, processes, &bytes, NULL, 0) == 0 && bytes > 0 && bytes < capacity && bytes % sizeof(*processes) == 0;
    NSMutableArray *observed = complete ? [NSMutableArray array] : nil;
    for (size_t index = 0; complete && index < bytes / sizeof(*processes); index++) {
        SSProcessIdentity identity = KernelIdentity(processes[index]);
        [observed addObject:[NSValue valueWithBytes:&identity objCType:@encode(SSProcessIdentity)]];
    }
    free(processes);
    return observed;
}

static BOOL ObserveIdentity(pid_t process, SSProcessIdentity *identity, BOOL *present) {
    int query[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, process};
    struct kinfo_proc current = {0};
    size_t bytes = sizeof(current);
    *present = NO;
    if (sysctl(query, 4, &current, &bytes, NULL, 0) != 0) return errno == ESRCH;
    if (!bytes) return YES;
    if (bytes != sizeof(current)) { errno = EIO; return NO; }
    *identity = KernelIdentity(current);
    if (!ValidProcess(*identity) || identity->process != process) { errno = EIO; return NO; }
    *present = YES;
    return YES;
}

static NSString *ObserveExecutable(pid_t process) {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int bytes = proc_pidpath(process, path, sizeof(path));
    if (bytes <= 0 || (NSUInteger)bytes >= sizeof(path) || strnlen(path, sizeof(path)) >= sizeof(path)) return nil;
    NSString *image = [NSString stringWithUTF8String:path];
    if (!image) errno = EILSEQ;
    return image;
}

static SSPreparationActivity InspectActivity(NSURL *source, NSURL *target) {
    return ObserveActivity(getuid(), getpid(), source, target, ^NSArray * { return ObserveProcesses(); },
        ^BOOL(SSProcessIdentity expected, NSString **path, BOOL *exited) {
            return ObserveImage(expected, ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) { return ObserveIdentity(process, identity, present); },
                ^NSString *(pid_t process) { return ObserveExecutable(process); }, path, exited);
        }, ^NSString *(NSString *path) {
        char canonical[PATH_MAX];
        return realpath(path.fileSystemRepresentation, canonical) ? @(canonical) : nil;
    }, ^double { return ProcessTime(); }, ^void(NSString *operation, int code, const SSInventoryDiagnostic *diagnostic, double started) {
        if (diagnostic) LogInventoryDifference(diagnostic, started);
        UnavailableActivity(operation, code);
    });
}

static NSDictionary *InspectSelection(NSDictionary *selection, NSMutableArray *pins, NSError **error) {
    id schema = selection[@"schema"], paths = selection[@"paths"], identities = selection[@"identities"];
    if (selection.count != 3 || !SSObservationInteger(schema) || ![@[@1, @2] containsObject:schema] ||
        ![paths isKindOfClass:NSArray.class] || [paths count] != 3 || ![identities isKindOfClass:NSArray.class] || [identities count] != 3) {
        SSObservationFail(error, EINVAL); return nil;
    }
    NSMutableArray *observed = [NSMutableArray array];
    for (NSUInteger index = 0; index < 3; index++) {
        if (![paths[index] isKindOfClass:NSString.class] || ![identities[index] isKindOfClass:NSString.class]) { SSObservationFail(error, EINVAL); return nil; }
        struct directory_error failure = {0};
        struct directory *pin = directory_open_role([paths[index] fileSystemRepresentation], false, DIRECTORY_PRIVATE, &failure);
        if (!pin) { SSObservationFail(error, (int)failure.system ?: EPERM); return nil; }
        [pins addObject:[NSValue valueWithPointer:pin]];
        char persistent[DIRECTORY_IDENTITY_BYTES];
        const char *identity = [schema isEqual:@1] ? directory_identity(pin) :
            directory_persistent_identity(pin, persistent, &failure) ? persistent : NULL;
        NSString *value = identity ? @(identity) : nil;
        if (!value || ![value isEqual:identities[index]]) { SSObservationFail(error, ESTALE); return nil; }
        [observed addObject:value];
    }
    NSDictionary *summary = @{@"schema":schema, @"identities":observed};
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:summary options:NSJSONWritingSortedKeys error:error];
    if (!bytes) return nil;
    return @{@"schema":schema, @"sha256":SSObservationDigest(bytes)};
}

#ifndef SS_PREFLIGHT_EMBED
int main(int argc, const char **argv) {
    @autoreleasepool {
        NSError *failure = nil;
        NSMutableDictionary *options = [NSMutableDictionary dictionary];
        NSSet *allowed = [NSSet setWithArray:@[@"--cleanup", @"--preparation", @"--source", @"--target", @"--state", @"--binding", @"--selection"]];
        BOOL valid = argc == 13 || argc == 15;
        for (int index = 1; valid && index < argc; index += 2) {
            NSString *key = @(argv[index]), *value = @(argv[index + 1]);
            valid = [allowed containsObject:key] && !options[key] && [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= SSPreflightArgumentBytes;
            if (valid) options[key] = value;
        }
        valid = valid && options.count >= 6 && getuid() == geteuid();
        for (NSString *key in @[@"--cleanup", @"--preparation", @"--source", @"--target", @"--state", @"--binding"]) valid = valid && options[key] != nil;
        for (NSString *key in @[@"--cleanup", @"--preparation", @"--source", @"--target", @"--state"]) {
            NSString *path = options[key];
            valid = valid && [path hasPrefix:@"/"] && ![path.pathComponents containsObject:@"."] && ![path.pathComponents containsObject:@".."];
        }
        NSDictionary *binding = valid ? [NSJSONSerialization JSONObjectWithData:[options[@"--binding"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
        valid = valid && SSBindingValid(binding);
        NSDictionary *selection = options[@"--selection"] ? [NSJSONSerialization JSONObjectWithData:[options[@"--selection"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
        if (options[@"--selection"] && ![selection isKindOfClass:NSDictionary.class]) valid = NO;
        NSMutableArray *pins = [NSMutableArray array];
        NSDictionary *selectionBefore = valid && selection ? InspectSelection(selection, pins, &failure) : nil;
        if (selection && !selectionBefore) valid = NO;
        NSDictionary *proof = nil;
        if (valid && SSCleanupOpenExistingDirectory(options[@"--cleanup"], &failure) && SSPreparationOpenExistingDirectory(options[@"--preparation"], &failure)) {
            NSURL *source = [NSURL fileURLWithPath:options[@"--source"]], *target = [NSURL fileURLWithPath:options[@"--target"]];
            NSDictionary *observation = SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:options[@"--state"]],
                ^SSPreparationActivity { return InspectActivity(source, target); }, &failure);
            if (observation) {
                NSMutableDictionary *result = [observation mutableCopy];
                if (selection) {
                    NSDictionary *selectionAfter = InspectSelection(selection, pins, &failure);
                    if ([selectionAfter isEqual:selectionBefore]) result[@"selection"] = selectionAfter;
                    else result = nil;
                }
                proof = result;
            }
        }
        BOOL released = SSPreparationCloseChecked(&failure) && SSCleanupCloseChecked(&failure);
        if (!released) proof = nil;
        if (released) for (NSValue *value in [pins reverseObjectEnumerator]) {
            uint32_t closed = directory_close(value.pointerValue);
            if (closed) { proof = nil; SSObservationFail(&failure, (int)closed); break; }
        }
        NSDictionary *output = proof ? @{@"schema":@1, @"mode":@"inspect", @"proof":proof} :
            @{@"schema":@1, @"mode":@"inspect", @"error":@{@"code":@(failure ? failure.code : EINVAL)}};
        NSData *bytes = [NSJSONSerialization dataWithJSONObject:output options:NSJSONWritingSortedKeys error:NULL];
        if (!bytes || fwrite(bytes.bytes, 1, bytes.length, stdout) != bytes.length || fputc('\n', stdout) == EOF) return EXIT_FAILURE;
        return proof ? EXIT_SUCCESS : EXIT_FAILURE;
    }
}
#endif
#endif
