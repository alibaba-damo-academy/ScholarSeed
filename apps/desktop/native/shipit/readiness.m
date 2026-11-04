#import "readiness.h"
#import "binding.h"
#import "observation.h"
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>

static const char *SSAckName = ".scholarseed-prepare.plist";
static const char *SSNextAckName = ".scholarseed-prepare.next";
static const NSUInteger SSMaximumAckBytes = 4096;
static NSString * const SSReadinessPreparationDomain = @"SSReadinessPreparation";

static BOOL SSFail(NSError **error, int code) {
    if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:nil];
    return NO;
}
static NSDictionary *SSIdentity(struct stat st) {
    return @{@"dev":@(st.st_dev), @"ino":@(st.st_ino), @"uid":@(st.st_uid)};
}
static int SSOpenDirectory(NSString *path) {
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    for (NSString *component in path.pathComponents) {
        if ([component isEqual:@"/"]) continue;
        int next = openat(fd, component.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int code = errno; close(fd); fd = next; errno = code;
        if (fd < 0) break;
    }
    return fd;
}
static NSDictionary *SSCapture(NSURL *url, int *parentFD) {
    if (!url.isFileURL || ![url.path hasPrefix:@"/"]) { errno = EINVAL; return nil; }
    NSString *path = url.path.stringByStandardizingPath;
    if ([path isEqual:@"/"]) { errno = EINVAL; return nil; }
    // Resolve only the parent once (including macOS /var aliases), then walk its
    // canonical components with no-follow descriptors and reject a symlink leaf.
    char canonical[PATH_MAX];
    if (!realpath(path.stringByDeletingLastPathComponent.fileSystemRepresentation, canonical)) return nil;
    NSString *parent = @(canonical);
    int fd = SSOpenDirectory(parent);
    if (fd < 0) return nil;
    struct stat p, s;
    BOOL ok = fstat(fd, &p) == 0 && fstatat(fd, path.lastPathComponent.fileSystemRepresentation, &s, AT_SYMLINK_NOFOLLOW) == 0;
    if (ok && !S_ISDIR(s.st_mode)) { errno = EINVAL; ok = NO; }
    if (!ok) { int code = errno; close(fd); errno = code; return nil; }
    NSDictionary *capture = @{@"path":[parent stringByAppendingPathComponent:path.lastPathComponent], @"parent":SSIdentity(p), @"item":SSIdentity(s)};
    if (parentFD) *parentFD = fd; else close(fd);
    return capture;
}
static BOOL SSSafeAck(struct stat st) {
    return S_ISREG(st.st_mode) && st.st_nlink == 1 && (st.st_uid == 0 || st.st_uid == geteuid()) &&
        !(st.st_mode & (S_IWGRP | S_IWOTH)) && st.st_size > 0 && st.st_size <= (off_t)SSMaximumAckBytes;
}
// A killed writer may leave a partial/empty next file. Reclaim only this
// fixed, bounded, owned leaf; an active publisher holds an exclusive inode lock.
static BOOL SSRemoveNext(int directory) {
    int fd = openat(directory, SSNextAckName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_EXLOCK | O_CLOEXEC);
    if (fd < 0) return errno == ENOENT;
    struct stat st, current;
    BOOL ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1 &&
        (st.st_uid == 0 || st.st_uid == geteuid()) && !(st.st_mode & (S_IWGRP | S_IWOTH)) &&
        st.st_size >= 0 && st.st_size <= (off_t)SSMaximumAckBytes &&
        fstatat(directory, SSNextAckName, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        [SSIdentity(st) isEqual:SSIdentity(current)] && S_ISREG(current.st_mode);
    if (!ok) { close(fd); errno = ESTALE; return NO; }
    ok = unlinkat(directory, SSNextAckName, 0) == 0 && fsync(directory) == 0;
    int saved = errno; close(fd); errno = saved;
    return ok;
}
BOOL SSReadinessRemove(NSURL *source, NSError **error) {
    int directory = -1;
    NSDictionary *src = SSCapture(source, &directory);
    if (!src) return SSFail(error, errno);
    int fd = openat(directory, SSAckName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        int saved = errno;
        BOOL ok = saved == ENOENT && [src isEqual:SSCapture(source, NULL)] && SSRemoveNext(directory);
        if (saved == ENOENT && !ok) saved = errno ?: ESTALE;
        close(directory); return ok ? YES : SSFail(error, saved);
    }
    struct stat st, current;
    BOOL ok = fstat(fd, &st) == 0 && SSSafeAck(st);
    uint8_t buffer[4097]; NSUInteger used = 0;
    while (ok && used < sizeof(buffer)) {
        ssize_t count = read(fd, buffer + used, sizeof(buffer) - used);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { ok = NO; break; }
        if (!count) break;
        used += (NSUInteger)count;
    }
    close(fd);
    id record = ok && used <= SSMaximumAckBytes ? [NSPropertyListSerialization propertyListWithData:[NSData dataWithBytes:buffer length:used] options:0 format:NULL error:NULL] : nil;
    ok = [record isKindOfClass:NSDictionary.class] && [record[@"schema"] isEqual:@1] &&
        [record[@"source"] isEqual:src] && [src isEqual:SSCapture(source, NULL)] &&
        fstatat(directory, SSAckName, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        SSSafeAck(current) && [SSIdentity(st) isEqual:SSIdentity(current)];
    if (!ok) { close(directory); return SSFail(error, ESTALE); }
    // Only this fixed leaf is removed. A substituted symlink is never followed.
    ok = SSRemoveNext(directory) && unlinkat(directory, SSAckName, 0) == 0 && fsync(directory) == 0;
    int saved = errno; close(directory);
    return ok ? YES : SSFail(error, saved);
}
BOOL SSReadinessPublishBound(NSURL *source, NSURL *target, NSDictionary *binding, BOOL success, NSInteger code, NSError **error) {
    if (binding && !SSBindingValid(binding)) return SSFail(error, EINVAL);
    int directory = -1;
    NSDictionary *src = SSCapture(source, &directory), *dst = SSCapture(target, NULL);
    if (!src || !dst) { int saved = errno; if (directory >= 0) close(directory); return SSFail(error, saved); }
    struct stat parent;
    BOOL safe = fstat(directory, &parent) == 0 && !(parent.st_mode & (S_IWGRP | S_IWOTH)) &&
        (geteuid() == 0 || parent.st_uid == geteuid());
    if (!safe) { close(directory); return SSFail(error, EPERM); }
    NSMutableDictionary *record = [@{@"schema":@1, @"source":src, @"target":dst, @"ready":@(success), @"code":@(code)} mutableCopy];
    if (binding) record[@"binding"] = binding;
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:record format:NSPropertyListBinaryFormat_v1_0 options:0 error:error];
    if (!data || data.length > SSMaximumAckBytes) { close(directory); return SSFail(error, EFBIG); }
    if (!SSRemoveNext(directory)) { int saved = errno; close(directory); return SSFail(error, saved); }
    int fd = openat(directory, SSNextAckName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK | O_CLOEXEC, 0600);
    if (fd < 0) { int saved = errno; close(directory); return SSFail(error, saved); }
    const uint8_t *bytes = data.bytes; NSUInteger left = data.length;
    while (left) {
        ssize_t count = write(fd, bytes, left);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        bytes += count; left -= (NSUInteger)count;
    }
    BOOL ok = left == 0 && fchmod(fd, 0644) == 0 && fsync(fd) == 0;
    int saved = errno;
    // Refuse a changed request even if copying finished successfully.
    if (ok && (![src isEqual:SSCapture(source, NULL)] || ![dst isEqual:SSCapture(target, NULL)])) { ok = NO; saved = ESTALE; }
    if (ok) { ok = renameat(directory, SSNextAckName, directory, SSAckName) == 0 && fsync(directory) == 0; saved = errno; }
    if (!ok) {
        struct stat owned, named;
        if (fstat(fd, &owned) == 0 && fstatat(directory, SSNextAckName, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
            [SSIdentity(owned) isEqual:SSIdentity(named)] && S_ISREG(named.st_mode)) unlinkat(directory, SSNextAckName, 0);
    }
    close(fd); close(directory);
    return ok ? YES : SSFail(error, saved ?: EIO);
}
BOOL SSReadinessPublish(NSURL *source, NSURL *target, BOOL success, NSInteger code, NSError **error) {
    return SSReadinessPublishBound(source, target, nil, success, code, error);
}
static NSDictionary *SSReadinessObserveBound(NSURL *source, NSURL *target, NSDictionary *binding, BOOL strict, BOOL *pending, NSError **error) {
    if (pending) *pending = NO;
    int directory = -1;
    NSDictionary *src = SSCapture(source, &directory), *dst = SSCapture(target, NULL);
    if (!src || !dst) { int saved = errno; if (directory >= 0) close(directory); SSFail(error, saved); return nil; }
    NSDictionary *observation = SSObservationReadAt(directory, @(SSAckName), SSMaximumAckBytes, NO, YES, error);
    int saved = errno;
    close(directory);
    if (!observation) { if (pending && saved == ENOENT) *pending = YES; return nil; }
    id record = [NSPropertyListSerialization propertyListWithData:observation[@"data"] options:0 format:NULL error:NULL];
    BOOL ok = [record isKindOfClass:NSDictionary.class] && [record[@"schema"] isEqual:@1] &&
        (!binding || (SSBindingValid(binding) && [binding isEqual:record[@"binding"]])) &&
        [record[@"source"] isEqual:src] && [record[@"target"] isEqual:dst] &&
        [record[@"ready"] isKindOfClass:NSNumber.class] && [record[@"code"] isKindOfClass:NSNumber.class] &&
        [src isEqual:SSCapture(source, NULL)] && [dst isEqual:SSCapture(target, NULL)];
    if (strict) ok = ok && [record count] == 6 && SSBindingValid(binding) &&
        SSObservationInteger(record[@"schema"]) && SSObservationBoolean(record[@"ready"]) && SSObservationInteger(record[@"code"]);
    if (!ok) { SSFail(error, EINVAL); return nil; }
    return @{@"record":record, @"snapshot":observation[@"snapshot"]};
}
NSDictionary *SSReadinessFailureSnapshot(NSURL *source, NSURL *target, NSDictionary *binding, NSInteger code, NSError **error) {
    NSDictionary *observation = SSReadinessObserveBound(source, target, binding, YES, NULL, error);
    NSDictionary *record = observation[@"record"];
    if (!record || [record[@"ready"] boolValue] || [record[@"code"] longLongValue] != code) { SSFail(error, EINVAL); return nil; }
    return observation[@"snapshot"];
}
NSInteger SSReadinessReadBound(NSURL *source, NSURL *target, NSDictionary *binding, NSError **error) {
    BOOL pending = NO;
    NSDictionary *observation = SSReadinessObserveBound(source, target, binding, NO, &pending, error);
    if (!observation) { if (pending && error) *error = nil; return pending ? SSReadinessPending : SSReadinessFailed; }
    NSDictionary *record = observation[@"record"];
    if ([record[@"ready"] boolValue]) return SSReadinessReady;
    if (error) *error = [NSError errorWithDomain:SSReadinessPreparationDomain code:[record[@"code"] integerValue] userInfo:nil];
    return SSReadinessFailed;
}
BOOL SSReadinessFailedRequest(NSURL *source, NSURL *target) {
    return SSReadinessFailedRequestBound(source, target, nil);
}
NSInteger SSReadinessRead(NSURL *source, NSURL *target, NSError **error) {
    return SSReadinessReadBound(source, target, nil, error);
}
BOOL SSReadinessFailedRequestBound(NSURL *source, NSURL *target, NSDictionary *binding) {
    NSError *error = nil;
    return SSReadinessReadBound(source, target, binding, &error) == SSReadinessFailed && [error.domain isEqual:SSReadinessPreparationDomain];
}
