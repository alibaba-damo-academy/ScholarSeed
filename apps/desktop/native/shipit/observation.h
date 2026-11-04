#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static inline int SSObservationOpenDirectory(NSString *path) {
    if (![path hasPrefix:@"/"] || [path.pathComponents containsObject:@".."] || [path.pathComponents containsObject:@"."]) { errno = EINVAL; return -1; }
    int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    for (NSString *component in path.pathComponents) {
        if ([component isEqual:@"/"]) continue;
        if (descriptor < 0) return -1;
        int next = openat(descriptor, component.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int saved = errno;
        close(descriptor);
        descriptor = next;
        errno = saved;
    }
    return descriptor;
}

static inline BOOL SSObservationFail(NSError **error, int code) {
    errno = code;
    if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:nil];
    return NO;
}

static inline NSDictionary *SSObservationIdentity(struct stat value) {
    return @{@"dev":@(value.st_dev), @"ino":@(value.st_ino), @"uid":@(value.st_uid)};
}

static inline NSString *SSObservationDigest(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    return hex;
}

static inline NSDictionary *SSObservationDirectorySnapshot(int directory, int lock, NSString *name, NSString *path, NSError **error) {
    struct stat held, current, locked, named;
    int observed = SSObservationOpenDirectory(path);
    BOOL safe = observed >= 0 && fstat(directory, &held) == 0 && fstat(observed, &current) == 0 &&
        S_ISDIR(held.st_mode) && held.st_uid == geteuid() && !(held.st_mode & (S_IRWXG | S_IRWXO)) &&
        [SSObservationIdentity(held) isEqual:SSObservationIdentity(current)] &&
        fstat(lock, &locked) == 0 && fstatat(directory, name.fileSystemRepresentation, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(locked.st_mode) && locked.st_uid == geteuid() && locked.st_nlink == 1 && !(locked.st_mode & (S_IRWXG | S_IRWXO)) &&
        [SSObservationIdentity(locked) isEqual:SSObservationIdentity(named)];
    if (observed >= 0 && close(observed) != 0) safe = NO;
    if (!safe) { SSObservationFail(error, ESTALE); return nil; }
    return @{@"directory":SSObservationIdentity(held), @"lock":SSObservationIdentity(locked)};
}

static inline NSDictionary *SSObservationReadAt(int directory, NSString *name, NSUInteger limit, BOOL private, BOOL allowRoot, NSError **error) {
    int descriptor = openat(directory, name.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (descriptor < 0) { SSObservationFail(error, errno); return nil; }
    struct stat before, after, named;
    mode_t prohibited = private ? (S_IRWXG | S_IRWXO) : (S_IWGRP | S_IWOTH);
    BOOL safe = fstat(descriptor, &before) == 0 && S_ISREG(before.st_mode) && before.st_nlink == 1 &&
        (before.st_uid == geteuid() || (allowRoot && before.st_uid == 0)) && !(before.st_mode & prohibited) &&
        before.st_size > 0 && (unsigned long long)before.st_size <= limit;
    NSMutableData *data = [NSMutableData data];
    unsigned char buffer[4096];
    int saved = EPERM;
    while (safe && data.length <= limit) {
        ssize_t count = read(descriptor, buffer, MIN(sizeof(buffer), limit + 1 - data.length));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { safe = NO; saved = errno; break; }
        if (count == 0) break;
        [data appendBytes:buffer length:(NSUInteger)count];
    }
    safe = safe && data.length == (NSUInteger)before.st_size && data.length <= limit &&
        fstat(descriptor, &after) == 0 && fstatat(directory, name.fileSystemRepresentation, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
        [SSObservationIdentity(before) isEqual:SSObservationIdentity(after)] &&
        [SSObservationIdentity(before) isEqual:SSObservationIdentity(named)] &&
        before.st_size == after.st_size && before.st_mode == after.st_mode && before.st_nlink == after.st_nlink &&
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
        before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
    if (close(descriptor) != 0 && safe) { safe = NO; saved = errno; }
    if (!safe) { SSObservationFail(error, saved); return nil; }
    NSDictionary *snapshot = @{@"identity":SSObservationIdentity(before), @"size":@(data.length), @"mode":@(before.st_mode & 07777),
        @"mtime":@[@(before.st_mtimespec.tv_sec), @(before.st_mtimespec.tv_nsec)],
        @"ctime":@[@(before.st_ctimespec.tv_sec), @(before.st_ctimespec.tv_nsec)], @"sha256":SSObservationDigest(data)};
    return @{@"data":data, @"snapshot":snapshot};
}

static inline BOOL SSObservationInteger(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
        [value doubleValue] == [value longLongValue];
}

static inline BOOL SSObservationBoolean(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}
