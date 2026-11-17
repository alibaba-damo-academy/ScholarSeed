#import "observation.h"
#include <sys/file.h>
#include <limits.h>
#include <stdlib.h>

// Deny-only history, independent of the replaceable preparation journal.
// Only the explicit maintenance protocol may append while holding its lock.
static NSString * const SSRetirementFile = @"retired.plist";
static NSString * const SSRetirementNext = @"retired.next";
static const NSUInteger SSRetirementLimit = 256 * 1024;
static const NSUInteger SSRetirementEntries = 128;

static BOOL SSRetirementPath(id value) {
    return [value isKindOfClass:NSString.class] && [value hasPrefix:@"/"] &&
        [value length] > 1 && [value length] <= 4096 &&
        ![[value pathComponents] containsObject:@"."] && ![[value pathComponents] containsObject:@".."] &&
        [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
}
static BOOL SSRetirementHash(id value) {
    return [value isKindOfClass:NSString.class] && [value length] == 64 &&
        [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound;
}
static NSArray *SSRetirementRead(int directory, NSError **error) {
    NSDictionary *observed = SSObservationReadAt(directory, SSRetirementFile, SSRetirementLimit, YES, NO, error);
    if (!observed) {
        if (errno == ENOENT) { if (error) *error = nil; return @[]; }
        return nil;
    }
    NSDictionary *value = [NSPropertyListSerialization propertyListWithData:observed[@"data"] options:0 format:NULL error:error];
    id entries = [value isKindOfClass:NSDictionary.class] ? value[@"entries"] : nil;
    BOOL valid = [value isKindOfClass:NSDictionary.class] && value.count == 2 &&
        [value[@"schema"] isEqual:@"1"] && [entries isKindOfClass:NSArray.class] && [entries count] <= SSRetirementEntries;
    NSMutableSet *identifiers = [NSMutableSet set];
    if (valid) for (id entry in entries) {
        valid = [entry isKindOfClass:NSDictionary.class] && [entry count] == 5 &&
            SSRetirementPath(entry[@"source"]) && SSRetirementPath(entry[@"target"]) &&
            SSRetirementHash(entry[@"request"]) && SSRetirementHash(entry[@"journal"]) && SSRetirementHash(entry[@"operation"]) &&
            ![identifiers containsObject:entry[@"operation"]];
        if (!valid) break;
        [identifiers addObject:entry[@"operation"]];
    }
    if (!valid) { SSObservationFail(error, EINVAL); return nil; }
    return entries;
}
static BOOL SSRetirementAllows(int directory, NSURL *source, NSError **error) {
    NSArray *entries = SSRetirementRead(directory, error);
    if (!entries) return NO;
    if (!source.isFileURL) return SSObservationFail(error, EINVAL);
    NSString *path = source.path.stringByStandardizingPath;
    if (entries.count) {
        char parent[PATH_MAX];
        if (!realpath(path.stringByDeletingLastPathComponent.fileSystemRepresentation, parent)) return SSObservationFail(error, errno);
        path = [@(parent) stringByAppendingPathComponent:path.lastPathComponent];
    }
    for (NSDictionary *entry in entries)
        if ([entry[@"source"] isEqual:path]) return SSObservationFail(error, ECANCELED);
    return YES;
}

// Called only after the caller has archived the exact input bytes and stopped
// the legacy launchd job. This function never grants installation authority.
static BOOL SSRetirementAppend(int directory, NSDictionary *entry, NSError **error) {
    NSArray *existing = SSRetirementRead(directory, error);
    if (!existing) return NO;
    if (![entry isKindOfClass:NSDictionary.class] || entry.count != 5 ||
        !SSRetirementPath(entry[@"source"]) || !SSRetirementPath(entry[@"target"]) ||
        !SSRetirementHash(entry[@"request"]) || !SSRetirementHash(entry[@"journal"]) || !SSRetirementHash(entry[@"operation"]))
        return SSObservationFail(error, EINVAL);
    for (NSDictionary *previous in existing) {
        if ([previous[@"operation"] isEqual:entry[@"operation"]])
            return [previous isEqual:entry] ? YES : SSObservationFail(error, ESTALE);
    }
    if (existing.count >= SSRetirementEntries) return SSObservationFail(error, ENOSPC);
    NSData *bytes = [NSPropertyListSerialization dataWithPropertyList:@{@"schema":@"1", @"entries":[existing arrayByAddingObject:entry]}
        format:NSPropertyListBinaryFormat_v1_0 options:0 error:error];
    if (!bytes || bytes.length > SSRetirementLimit) return SSObservationFail(error, EFBIG);
    // The ledger remains authoritative until rename. A private staging file is
    // disposable after a crash; reconstruct it from the held ledger and request.
    struct stat pending;
    if (fstatat(directory, SSRetirementNext.fileSystemRepresentation, &pending, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!S_ISREG(pending.st_mode) || pending.st_uid != geteuid() || pending.st_nlink != 1 ||
            (pending.st_mode & 077) || pending.st_size < 0 || pending.st_size > (off_t)SSRetirementLimit)
            return SSObservationFail(error, EPERM);
        if (unlinkat(directory, SSRetirementNext.fileSystemRepresentation, 0) != 0) return SSObservationFail(error, errno);
    } else if (errno != ENOENT) return SSObservationFail(error, errno);
    int fd = openat(directory, SSRetirementNext.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return SSObservationFail(error, errno);
    const uint8_t *cursor = bytes.bytes; NSUInteger remaining = bytes.length;
    BOOL ok = YES; int code = 0;
    while (remaining) {
        ssize_t count = write(fd, cursor, remaining);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { ok = NO; code = errno ?: EIO; break; }
        cursor += count; remaining -= (NSUInteger)count;
    }
    if (ok && fsync(fd) != 0) { ok = NO; code = errno; }
    if (close(fd) != 0) { ok = NO; if (!code) code = errno; }
    if (ok && renameat(directory, SSRetirementNext.fileSystemRepresentation, directory, SSRetirementFile.fileSystemRepresentation) != 0) { ok = NO; code = errno; }
    if (ok && fsync(directory) != 0) { ok = NO; code = errno; }
    return ok ? YES : SSObservationFail(error, code);
}
