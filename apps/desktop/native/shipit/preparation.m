#import "preparation.h"
#import "readiness.h"
#import "binding.h"
#import "cleanup.h"
#import "observation.h"
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <mach/mach_time.h>

static NSString * const SSPreparationDirectory = @"CandidatePreparation";
static NSString * const SSPreparationJournal = @"journal.plist";
static NSString * const SSPreparationNext = @"journal.next";
static NSString * const SSPreparationLock = @"lock";
static NSString * const SSPreparationSchema = @"1";
static NSString * const SSPreparationCopying = @"copying";
static NSString * const SSPreparationReady = @"ready";
static NSString * const SSPreparationTerminalVersion = @"1";
static NSString * const SSPreparationPrefix = @"shipit-candidate.";
static const NSUInteger SSPreparationAttempts = 3;
static const off_t SSPreparationMaximumBytes = 64 * 1024;
static const double SSPreparationMilliseconds = 1000;
static const NSUInteger SSPreparationPublicationFields = 8;
static int SSPreparationFD = -1, SSPreparationLockFD = -1;
static NSMutableDictionary *SSPreparationRecord;
static BOOL SSPreparationReadOnly;
static NSDictionary *SSPreparationObservation;
static NSString *SSPreparationObservedDirectory;
static BOOL SSPreparationCloseUncertain;
static int SSPreparationUncertainCode;

static BOOL Fail(NSError **error, int code) {
    errno = code;
    if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:nil];
    return NO;
}
int SSPreparationUncertaintyCode(void) {
    return SSPreparationCloseUncertain ? SSPreparationUncertainCode ?: EIO : 0;
}
static BOOL UncertainIO(NSError **error, int code) {
    if (!SSPreparationCloseUncertain) SSPreparationUncertainCode = code ?: EIO;
    SSPreparationCloseUncertain = YES;
    return Fail(error, SSPreparationUncertaintyCode());
}
static NSDictionary *Identity(struct stat value) {
    return @{@"dev":@(value.st_dev), @"ino":@(value.st_ino), @"uid":@(value.st_uid)};
}
static BOOL ValidIdentity(id value) {
    if (![value isKindOfClass:NSDictionary.class] || [value count] != 3) return NO;
    for (NSString *key in @[@"dev", @"ino", @"uid"]) if (![value[key] isKindOfClass:NSNumber.class]) return NO;
    return YES;
}
static int OpenDirectory(NSString *path) {
    if (![path hasPrefix:@"/"] || [path.pathComponents containsObject:@".."] || [path.pathComponents containsObject:@"."]) { errno = EINVAL; return -1; }
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) {
        int code = errno;
        NSLog(@"[shipit-directory] event=open-failed operation=open path=/ component=/ uid=%u euid=%u errno=%d", getuid(), geteuid(), code);
        errno = code;
        return -1;
    }
    for (NSString *component in path.pathComponents) {
        if ([component isEqual:@"/"]) continue;
        int next = openat(fd, component.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int code = errno; close(fd); fd = next; errno = code;
        if (fd < 0) {
            NSLog(@"[shipit-directory] event=open-failed operation=openat path=%@ component=%@ uid=%u euid=%u errno=%d", path, component, getuid(), geteuid(), code);
            errno = code;
            return -1;
        }
    }
    return fd;
}
static NSDictionary *Capture(NSString *path, BOOL contents) {
    char canonical[PATH_MAX];
    if (!realpath(path.stringByDeletingLastPathComponent.fileSystemRepresentation, canonical)) return nil;
    NSString *parent = @(canonical);
    int fd = OpenDirectory(parent); if (fd < 0) return nil;
    struct stat p, item, inner;
    BOOL ok = fstat(fd, &p) == 0 && fstatat(fd, path.lastPathComponent.fileSystemRepresentation, &item, AT_SYMLINK_NOFOLLOW) == 0;
    int code = errno;
    if (ok && !S_ISDIR(item.st_mode)) { ok = NO; code = EINVAL; }
    if (ok && contents) {
        int child = openat(fd, path.lastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        struct stat opened;
        ok = child >= 0 && fstat(child, &opened) == 0;
        if (ok && ![Identity(opened) isEqual:Identity(item)]) { ok = NO; errno = ESTALE; }
        if (ok) ok = fstatat(child, "Contents", &inner, AT_SYMLINK_NOFOLLOW) == 0;
        code = errno;
        if (ok && !S_ISDIR(inner.st_mode)) { ok = NO; code = EINVAL; }
        if (child >= 0) close(child);
    }
    close(fd); errno = code;
    if (!ok) return nil;
    NSMutableDictionary *result = [@{@"path":[parent stringByAppendingPathComponent:path.lastPathComponent], @"parent":Identity(p), @"item":Identity(item)} mutableCopy];
    if (contents) result[@"contents"] = Identity(inner);
    return result;
}
static BOOL ValidCapture(id value, BOOL contents) {
    return [value isKindOfClass:NSDictionary.class] && [value[@"path"] isKindOfClass:NSString.class] &&
        [value[@"path"] hasPrefix:@"/"] && ValidIdentity(value[@"parent"]) && ValidIdentity(value[@"item"]) &&
        (!contents || ValidIdentity(value[@"contents"]));
}
static BOOL StrictCapture(NSDictionary *capture, BOOL contents) {
    if (!ValidCapture(capture, contents) || capture.count != (contents ? 4u : 3u)) return NO;
    for (NSString *part in contents ? @[@"parent", @"item", @"contents"] : @[@"parent", @"item"]) {
        NSDictionary *identity = capture[part];
        for (NSString *field in @[@"dev", @"ino", @"uid"])
            if (!SSObservationInteger(identity[field]) || [identity[field] longLongValue] < 0) return NO;
    }
    return YES;
}
static NSDictionary *TerminalPublication(NSDictionary *record) {
    NSDictionary *failure = record[@"failure"];
    if (![record[@"terminalVersion"] isEqual:SSPreparationTerminalVersion] || ![record[@"state"] isEqual:SSPreparationReady] || record[@"ownership"] ||
        ![failure isKindOfClass:NSDictionary.class] || !SSObservationInteger(failure[@"code"]) || !SSBindingValid(record[@"binding"]) ||
        !StrictCapture(record[@"source"], YES) || !StrictCapture(record[@"target"], YES) || !StrictCapture(failure[@"target"], YES) ||
        !StrictCapture(record[@"candidate"], YES) || !StrictCapture(record[@"directory"], NO)) return nil;
    return @{@"schema":SSPreparationTerminalVersion, @"source":record[@"source"], @"target":record[@"target"], @"failureTarget":failure[@"target"],
        @"binding":record[@"binding"], @"code":failure[@"code"], @"candidate":record[@"candidate"], @"directory":record[@"directory"]};
}
static BOOL ValidTerminalRecord(NSDictionary *record) {
    id version = record[@"terminalVersion"], failure = record[@"failure"];
    id publication = [failure isKindOfClass:NSDictionary.class] ? failure[@"publication"] : nil;
    if (!version) return publication == nil;
    if (![version isKindOfClass:NSString.class] || ![version isEqual:SSPreparationTerminalVersion]) return NO;
    if (!publication) return YES;
    NSDictionary *expected = TerminalPublication(record);
    return [publication isKindOfClass:NSDictionary.class] && [publication count] == SSPreparationPublicationFields &&
        SSObservationInteger(publication[@"code"]) && SSBindingValid(publication[@"binding"]) &&
        StrictCapture(publication[@"source"], YES) && StrictCapture(publication[@"target"], YES) && StrictCapture(publication[@"failureTarget"], YES) &&
        StrictCapture(publication[@"candidate"], YES) && StrictCapture(publication[@"directory"], NO) && [publication isEqual:expected];
}
static BOOL CandidateOwnershipMatches(NSDictionary *expected, NSDictionary *current) {
    if (!current || ![current[@"path"] isEqual:expected[@"path"]] ||
        ![current[@"parent"] isEqual:expected[@"parent"]]) return NO;
    for (NSString *key in @[@"item", @"contents"]) {
        NSDictionary *before = expected[key], *after = current[key];
        if (![before[@"dev"] isEqual:after[@"dev"]] || ![before[@"ino"] isEqual:after[@"ino"]] ||
            (![before[@"uid"] isEqual:after[@"uid"]] && ![after[@"uid"] isEqual:@(getuid())])) return NO;
    }
    return YES;
}
static BOOL Save(NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationReadOnly) return Fail(error, EROFS);
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:@{@"schema":SSPreparationSchema, @"record":SSPreparationRecord ?: @{}} format:NSPropertyListBinaryFormat_v1_0 options:0 error:error];
    if (!data) return NO;
    if (data.length > SSPreparationMaximumBytes) return Fail(error, EFBIG);
    if (unlinkat(SSPreparationFD, SSPreparationNext.UTF8String, 0) != 0 && errno != ENOENT) return Fail(error, errno);
    int fd = openat(SSPreparationFD, SSPreparationNext.UTF8String, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY | O_CLOEXEC, S_IRUSR | S_IWUSR);
    if (fd < 0) return Fail(error, errno);
    const uint8_t *bytes = data.bytes; NSUInteger left = data.length;
    while (left) {
        ssize_t n = write(fd, bytes, left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { int code = n < 0 ? errno : EIO; if (close(fd) != 0) UncertainIO(NULL, errno); return Fail(error, code); }
        bytes += n; left -= (NSUInteger)n;
    }
    BOOL ok = fsync(fd) == 0; int code = errno;
    if (close(fd) != 0) { if (ok) code = errno; ok = NO; }
    if (!ok) return UncertainIO(error, code);
    if (renameat(SSPreparationFD, SSPreparationNext.UTF8String, SSPreparationFD, SSPreparationJournal.UTF8String) != 0) return Fail(error, errno);
    if (fsync(SSPreparationFD) != 0) return UncertainIO(error, errno);
    return YES;
}
BOOL SSPreparationCloseChecked(NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    for (NSUInteger index = 0; index < 2; index++) {
        int *descriptor = index == 0 ? &SSPreparationFD : &SSPreparationLockFD;
        int closing = *descriptor;
        *descriptor = -1;
        if (closing >= 0 && close(closing) != 0) return UncertainIO(error, errno);
    }
    SSPreparationRecord = nil;
    SSPreparationReadOnly = NO;
    SSPreparationObservation = nil;
    SSPreparationObservedDirectory = nil;
    return YES;
}
void SSPreparationClose(void) {
    SSPreparationCloseChecked(NULL);
}
static BOOL SSPreparationOpenDirectoryMode(NSString *directory, BOOL readOnly, NSError **error) {
    if (!SSPreparationCloseChecked(error)) return NO;
    SSPreparationReadOnly = readOnly;
    if (readOnly) SSPreparationObservedDirectory = directory;
    SSPreparationFD = OpenDirectory(directory);
    if (SSPreparationFD < 0) return Fail(error, errno);
    struct stat st;
    if (fstat(SSPreparationFD, &st) != 0) { int code = errno; SSPreparationClose(); return Fail(error, code); }
    if (st.st_uid != geteuid() || (st.st_mode & (S_IRWXG | S_IRWXO))) { SSPreparationClose(); return Fail(error, EPERM); }
    SSPreparationLockFD = openat(SSPreparationFD, SSPreparationLock.UTF8String, (readOnly ? O_RDONLY | O_NONBLOCK : O_CREAT | O_RDWR) | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR);
    if (SSPreparationLockFD < 0) { int code = errno; SSPreparationClose(); return Fail(error, code); }
    if (fstat(SSPreparationLockFD, &st) != 0) { int code = errno; SSPreparationClose(); return Fail(error, code); }
    if (!S_ISREG(st.st_mode) || st.st_uid != geteuid() || st.st_nlink != 1 || (st.st_mode & (S_IRWXG | S_IRWXO))) { SSPreparationClose(); return Fail(error, EPERM); }
    if (flock(SSPreparationLockFD, LOCK_EX | LOCK_NB) != 0) { int code = errno; SSPreparationClose(); return Fail(error, code); }
    NSDictionary *observation = SSObservationReadAt(SSPreparationFD, SSPreparationJournal, (NSUInteger)SSPreparationMaximumBytes, YES, NO, error);
    if (!observation) { if (!readOnly && errno == ENOENT) return YES; int code = errno; SSPreparationClose(); return Fail(error, code); }
    id journal = [NSPropertyListSerialization propertyListWithData:observation[@"data"] options:NSPropertyListMutableContainers format:NULL error:error];
    id record = [journal isKindOfClass:NSDictionary.class] ? journal[@"record"] : nil;
    BOOL valid = [journal isKindOfClass:NSDictionary.class] && [journal[@"schema"] isEqual:SSPreparationSchema] && [record isKindOfClass:NSDictionary.class];
    if (valid && [record count]) {
        valid = ValidCapture(record[@"source"], YES) && ValidCapture(record[@"target"], YES) &&
            [record[@"attempts"] isKindOfClass:NSNumber.class] && [record[@"attempts"] unsignedIntegerValue] > 0 && [record[@"attempts"] unsignedIntegerValue] <= SSPreparationAttempts &&
            [@[SSPreparationCopying, SSPreparationReady] containsObject:record[@"state"]] &&
            ValidCapture(record[@"directory"], NO) && [record[@"directory"][@"path"] isKindOfClass:NSString.class] &&
            [[record[@"directory"][@"path"] lastPathComponent] hasPrefix:SSPreparationPrefix] &&
            (!record[@"candidate"] || ValidCapture(record[@"candidate"], YES)) &&
            (!record[@"binding"] || SSBindingValid(record[@"binding"])) &&
            (!record[@"ownership"] || [record[@"ownership"] isEqual:@YES]) &&
            (!record[@"failure"] || ([record[@"failure"] isKindOfClass:NSDictionary.class] &&
                [record[@"failure"][@"code"] isKindOfClass:NSNumber.class] &&
                (!record[@"failure"][@"launched"] || [record[@"failure"][@"launched"] isEqual:@YES]) &&
                ValidCapture(record[@"failure"][@"target"], YES) &&
                [record[@"failure"][@"target"][@"parent"] isEqual:record[@"target"][@"parent"]] &&
                [record[@"failure"][@"target"][@"item"] isEqual:record[@"target"][@"item"]] &&
                [record[@"failure"][@"target"][@"contents"] isEqual:record[@"target"][@"contents"]] &&
                [[record[@"failure"][@"target"][@"path"] stringByDeletingLastPathComponent] isEqual:[record[@"target"][@"path"] stringByDeletingLastPathComponent]])) &&
            ([record[@"state"] isEqual:SSPreparationCopying] || (ValidCapture(record[@"candidate"], YES) &&
                [record[@"candidate"][@"path"] isEqual:[record[@"directory"][@"path"] stringByAppendingPathComponent:[record[@"source"][@"path"] lastPathComponent]] ]));
    }
    if (valid) valid = ValidTerminalRecord(record);
    if (!valid) { SSPreparationClose(); return Fail(error, EINVAL); }
    SSPreparationRecord = [record count] ? record : nil;
    if (readOnly) SSPreparationObservation = observation[@"snapshot"];
    return YES;
}
BOOL SSPreparationOpenDirectory(NSString *directory, NSError **error) {
    return SSPreparationOpenDirectoryMode(directory, NO, error);
}
BOOL SSPreparationOpenExistingDirectory(NSString *directory, NSError **error) {
    if (!SSCleanupReadOnlySnapshot(error)) return NO;
    return SSPreparationOpenDirectoryMode(directory, YES, error);
}
static BOOL SSPreparationOpenOwner(NSString *label, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"] invertedSet];
    if (!label.length || [label rangeOfCharacterFromSet:invalid].location != NSNotFound || [@[@".", @".."] containsObject:label]) return Fail(error, EINVAL);
    NSURL *support = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:error];
    if (!support) return NO;
    // Foundation may collapse /private/var back to the /var system symlink.
    // Resolve only the OS-selected support root, never our private descendants
    // or a journal-supplied path. Keep all subsequent opens no-follow.
    char canonical[PATH_MAX];
    if (!realpath(support.path.fileSystemRepresentation, canonical)) {
        int code = errno;
        NSLog(@"[shipit-directory] event=resolve-failed operation=realpath path=%@ uid=%u euid=%u errno=%d", support.path, getuid(), geteuid(), code);
        return Fail(error, code);
    }
    NSString *supportPath = @(canonical);
    NSLog(@"[shipit-directory] event=resolved label=%@ input=%@ canonical=%@ uid=%u euid=%u", label, support.path, supportPath, getuid(), geteuid());
    NSString *base = supportPath;
    int fd = OpenDirectory(base); if (fd < 0) return Fail(error, errno);
    if ((mkdirat(fd, label.UTF8String, S_IRWXU) != 0 && errno != EEXIST) || fsync(fd) != 0) { int code = errno; close(fd); return Fail(error, code); }
    close(fd);
    base = [base stringByAppendingPathComponent:label];
    fd = OpenDirectory(base); if (fd < 0) return Fail(error, errno);
    struct stat st;
    if (fstat(fd, &st) != 0) { int code = errno; close(fd); return Fail(error, code); }
    if (st.st_uid != geteuid() || (st.st_mode & (S_IWGRP | S_IWOTH))) { close(fd); return Fail(error, EPERM); }
    if ((mkdirat(fd, SSPreparationDirectory.UTF8String, S_IRWXU) != 0 && errno != EEXIST) || fsync(fd) != 0) { int code = errno; close(fd); return Fail(error, code); }
    close(fd);
    return SSPreparationOpenDirectory([base stringByAppendingPathComponent:SSPreparationDirectory], error);
}
BOOL SSPreparationOpen(NSString *label, NSError **error) {
    NSError *failure = nil;
    BOOL opened = SSPreparationOpenOwner(label, &failure);
    if (!opened) {
        NSLog(@"[shipit-directory] event=owner-open-failed owner=SSPreparation label=%@ uid=%u euid=%u error=%@", label, getuid(), geteuid(), failure);
        if (error) *error = failure;
    }
    return opened;
}
static BOOL Overlaps(NSString *a, NSString *b) {
    return [a isEqual:b] || [a hasPrefix:[b stringByAppendingString:@"/"]] || [b hasPrefix:[a stringByAppendingString:@"/"]];
}
static BOOL RemoveChildren(int fd, dev_t device) {
    DIR *stream = fdopendir(dup(fd)); if (!stream) return NO;
    BOOL ok = YES; int code = 0;
    for (;;) {
        errno = 0; struct dirent *entry = readdir(stream);
        if (!entry) { if (errno) { ok = NO; code = errno; } break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        struct stat before, opened;
        if (fstatat(fd, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) != 0) { ok = NO; code = errno; break; }
        if (before.st_dev != device) { ok = NO; code = EXDEV; break; }
        if (S_ISDIR(before.st_mode)) {
            int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            ok = child >= 0 && fstat(child, &opened) == 0;
            code = errno;
            if (ok && ![Identity(before) isEqual:Identity(opened)]) { ok = NO; code = ESTALE; }
            if (ok && !RemoveChildren(child, device)) { ok = NO; code = errno; }
            if (child >= 0) close(child);
            if (!ok) break;
            if (fstatat(fd, entry->d_name, &opened, AT_SYMLINK_NOFOLLOW) != 0) { ok = NO; code = errno; break; }
            if (![Identity(before) isEqual:Identity(opened)]) { ok = NO; code = ESTALE; break; }
            if (unlinkat(fd, entry->d_name, AT_REMOVEDIR) != 0) { ok = NO; code = errno; break; }
        } else if (unlinkat(fd, entry->d_name, 0) != 0) { ok = NO; code = errno; break; }
    }
    closedir(stream); errno = code; return ok;
}
static BOOL Discard(NSDictionary *source, NSDictionary *target, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    NSDictionary *directory = SSPreparationRecord[@"directory"];
    if (!directory) return YES;
    NSString *path = directory[@"path"];
    for (NSString *protectedPath in @[source[@"path"], target[@"path"], SSPreparationRecord[@"source"][@"path"], SSPreparationRecord[@"target"][@"path"]])
        if (Overlaps(path, protectedPath)) return Fail(error, EPERM);
    int parent = OpenDirectory(path.stringByDeletingLastPathComponent);
    if (parent < 0) return errno == ENOENT ? YES : Fail(error, errno);
    struct stat p, item;
    if (fstat(parent, &p) != 0) { int code = errno; close(parent); return Fail(error, code); }
    if (fstatat(parent, path.lastPathComponent.fileSystemRepresentation, &item, AT_SYMLINK_NOFOLLOW) != 0) { int code = errno; close(parent); return code == ENOENT ? YES : Fail(error, code); }
    if (![Identity(p) isEqual:directory[@"parent"]]) { close(parent); return Fail(error, ESTALE); }
    if (!S_ISDIR(item.st_mode) || item.st_uid != geteuid() || (item.st_mode & (S_IRWXG | S_IRWXO)) || ![Identity(item) isEqual:directory[@"item"]]) { close(parent); return Fail(error, ESTALE); }
    int child = openat(parent, path.lastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat opened; BOOL ok = child >= 0 && fstat(child, &opened) == 0; int code = errno;
    if (ok && ![Identity(opened) isEqual:directory[@"item"]]) { ok = NO; code = ESTALE; }
    // A ready candidate may have moved to the installed target. Never follow that move.
    if (ok && SSPreparationRecord[@"candidate"]) {
        if (fstatat(child, [SSPreparationRecord[@"source"][@"path"] lastPathComponent].UTF8String, &item, AT_SYMLINK_NOFOLLOW) == 0) {
            if (![Identity(item) isEqual:SSPreparationRecord[@"candidate"][@"item"]]) { ok = NO; code = ESTALE; }
        } else if (errno != ENOENT) { ok = NO; code = errno; }
    }
    if (ok && !RemoveChildren(child, opened.st_dev)) { ok = NO; code = errno; }
    if (child >= 0) close(child);
    if (ok && fstatat(parent, path.lastPathComponent.fileSystemRepresentation, &item, AT_SYMLINK_NOFOLLOW) != 0) { ok = NO; code = errno; }
    if (ok && ![Identity(item) isEqual:directory[@"item"]]) { ok = NO; code = ESTALE; }
    if (ok && (unlinkat(parent, path.lastPathComponent.fileSystemRepresentation, AT_REMOVEDIR) != 0 || fsync(parent) != 0)) { ok = NO; code = errno; }
    close(parent); return ok ? YES : Fail(error, code);
}
static BOOL FailureTargetRestored(void) {
    if (SSPreparationCloseUncertain) return NO;
    NSDictionary *expected = SSPreparationRecord[@"target"], *failure = SSPreparationRecord[@"failure"];
    if (![Capture(expected[@"path"], YES) isEqual:expected]) return NO;
    if ([failure[@"target"][@"path"] isEqual:expected[@"path"]]) return YES;
    struct stat remaining;
    return lstat([failure[@"target"][@"path"] fileSystemRepresentation], &remaining) != 0 && errno == ENOENT;
}
static BOOL PublishedCandidateMatches(void) {
    if (SSPreparationCloseUncertain) return NO;
    NSDictionary *directory = SSPreparationRecord[@"directory"], *candidate = SSPreparationRecord[@"candidate"];
    NSString *path = directory[@"path"];
    int parent = OpenDirectory(path.stringByDeletingLastPathComponent);
    if (parent < 0) return errno == ENOENT;
    struct stat info;
    BOOL safe = fstat(parent, &info) == 0 && [Identity(info) isEqual:directory[@"parent"]];
    BOOL missing = NO;
    if (safe && fstatat(parent, path.lastPathComponent.fileSystemRepresentation, &info, AT_SYMLINK_NOFOLLOW) != 0) {
        missing = errno == ENOENT;
        safe = missing;
    }
    if (safe && !missing) {
        safe = S_ISDIR(info.st_mode) && info.st_uid == geteuid() && !(info.st_mode & (S_IRWXG | S_IRWXO)) && [Identity(info) isEqual:directory[@"item"]];
        int child = safe ? openat(parent, path.lastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) : -1;
        safe = safe && child >= 0 && fstat(child, &info) == 0 && [Identity(info) isEqual:directory[@"item"]];
        if (safe && fstatat(child, [candidate[@"path"] lastPathComponent].fileSystemRepresentation, &info, AT_SYMLINK_NOFOLLOW) != 0) {
            missing = errno == ENOENT;
            safe = missing;
        }
        if (safe && !missing) safe = S_ISDIR(info.st_mode) && [Identity(info) isEqual:candidate[@"item"]] && [Capture(candidate[@"path"], YES) isEqual:candidate];
        if (child >= 0 && close(child) != 0) { UncertainIO(NULL, errno); safe = NO; }
    }
    if (close(parent) != 0) { UncertainIO(NULL, errno); safe = NO; }
    return safe;
}
static BOOL FailurePublished(void) {
    if (SSPreparationCloseUncertain) return NO;
    if (!ValidTerminalRecord(SSPreparationRecord) || !FailureTargetRestored()) return NO;
    if (SSPreparationRecord[@"terminalVersion"]) {
        return SSPreparationRecord[@"failure"][@"publication"] != nil && PublishedCandidateMatches();
    }
    return FailureTargetRestored() && SSReadinessFailedRequestBound([NSURL fileURLWithPath:SSPreparationRecord[@"source"][@"path"]],
        [NSURL fileURLWithPath:SSPreparationRecord[@"target"][@"path"]], SSPreparationRecord[@"binding"]);
}
NSURL *SSPreparationCopy(NSURL *sourceURL, NSURL *targetURL, NSDictionary *binding, NSError **error) {
    if (SSPreparationCloseUncertain) { Fail(error, SSPreparationUncertaintyCode()); return nil; }
    if (SSPreparationReadOnly) { Fail(error, EROFS); return nil; }
    if (SSPreparationFD < 0) { Fail(error, EBADF); return nil; }
    if (!sourceURL.isFileURL || !targetURL.isFileURL) { Fail(error, EINVAL); return nil; }
    if (SSPreparationRecord[@"ownership"]) { Fail(error, ECANCELED); return nil; }
    NSDictionary *source = Capture(sourceURL.path, YES);
    if (!source) { Fail(error, errno); return nil; }
    NSDictionary *target = Capture(targetURL.path, YES);
    if (!target) { Fail(error, errno); return nil; }
    NSError *ackError = nil;
    if (SSReadinessRead(sourceURL, targetURL, &ackError) == SSReadinessFailed) { if (error) *error = ackError; return nil; }
    if (Overlaps(source[@"path"], target[@"path"])) { Fail(error, EINVAL); return nil; }
    if (binding && !SSBindingValid(binding)) { Fail(error, EINVAL); return nil; }
    if ([source[@"path"] isEqual:SSPreparationRecord[@"source"][@"path"]] && ![(binding ?: @{}) isEqual:(SSPreparationRecord[@"binding"] ?: @{})]) { Fail(error, ESTALE); return nil; }
    BOOL same = [source isEqual:SSPreparationRecord[@"source"]] && [target isEqual:SSPreparationRecord[@"target"]];
    if (SSPreparationRecord[@"failure"] && ([source[@"path"] isEqual:SSPreparationRecord[@"source"][@"path"]] || !FailurePublished())) { Fail(error, ECANCELED); return nil; }
    if (SSPreparationRecord && !same && [source[@"path"] isEqual:SSPreparationRecord[@"source"][@"path"]]) { Fail(error, ESTALE); return nil; }
    NSString *candidatePath = [SSPreparationRecord[@"directory"][@"path"] stringByAppendingPathComponent:[SSPreparationRecord[@"source"][@"path"] lastPathComponent]];
    if (same && [SSPreparationRecord[@"state"] isEqual:SSPreparationReady]) {
        NSDictionary *directory = Capture(SSPreparationRecord[@"directory"][@"path"], NO);
        if (directory && ![directory isEqual:SSPreparationRecord[@"directory"]]) { Fail(error, ESTALE); return nil; }
        if (!directory && errno != ENOENT) { Fail(error, errno); return nil; }
        if (directory) {
            int fd = OpenDirectory(directory[@"path"]); struct stat st;
            if (fd < 0) { Fail(error, errno); return nil; }
            if (fstat(fd, &st) != 0) { int code = errno; close(fd); Fail(error, code); return nil; }
            close(fd);
            if (st.st_uid != geteuid() || (st.st_mode & (S_IRWXG | S_IRWXO))) { Fail(error, EPERM); return nil; }
        }
        NSDictionary *candidate = directory ? Capture(candidatePath, YES) : nil;
        if ([candidate isEqual:SSPreparationRecord[@"candidate"]]) {
            NSLog(@"[shipit-preparation] event=reused attempt=%lu", (unsigned long)[SSPreparationRecord[@"attempts"] unsignedIntegerValue]);
            return [NSURL fileURLWithPath:candidatePath isDirectory:YES];
        }
        if (candidate || errno != ENOENT) { Fail(error, candidate ? ESTALE : errno); return nil; }
    }
    NSUInteger attempts = same ? [SSPreparationRecord[@"attempts"] unsignedIntegerValue] : 0;
    if (!Discard(source, target, error)) return nil;
    if (attempts >= SSPreparationAttempts) { Fail(error, ELOOP); return nil; }
    NSString *template = [NSTemporaryDirectory() stringByAppendingPathComponent:[SSPreparationPrefix stringByAppendingString:@"XXXXXX"]];
    char *buffer = strdup(template.fileSystemRepresentation);
    if (!buffer) { Fail(error, ENOMEM); return nil; }
    char *created = mkdtemp(buffer);
    if (!created) { int code = errno; free(buffer); Fail(error, code); return nil; }
    NSDictionary *directory = Capture(@(created), NO);
    free(buffer);
    if (!directory) { Fail(error, errno); return nil; }
    SSPreparationRecord = [@{@"source":source, @"target":target, @"directory":directory, @"state":SSPreparationCopying, @"attempts":@(attempts + 1), @"terminalVersion":SSPreparationTerminalVersion} mutableCopy];
    if (binding) SSPreparationRecord[@"binding"] = binding;
    // Persist the owned destination and charge this preparation attempt before copying.
    if (!Save(error)) return nil;
    candidatePath = [directory[@"path"] stringByAppendingPathComponent:[SSPreparationRecord[@"source"][@"path"] lastPathComponent]];
    NSURL *candidateURL = [NSURL fileURLWithPath:candidatePath isDirectory:YES];
    NSTimeInterval start = NSProcessInfo.processInfo.systemUptime;
    unsigned long long identifier = mach_absolute_time();
    @try { NSLog(@"[shipit-timing] schema=1 id=%llu stage=copy-candidate event=start", identifier); } @catch (__unused NSException *exception) {}
    BOOL copied = [NSFileManager.defaultManager copyItemAtURL:[NSURL fileURLWithPath:source[@"path"]] toURL:candidateURL error:error];
    @try { NSLog(@"[shipit-timing] schema=1 id=%llu stage=copy-candidate event=end result=%@ elapsedMs=%.3f errorCode=%ld", identifier, copied ? @"success" : @"error", (NSProcessInfo.processInfo.systemUptime - start) * SSPreparationMilliseconds, (long)(copied ? 0 : (error ? (*error).code : EIO))); } @catch (__unused NSException *exception) {}
    if (!copied) return nil;
    NSDictionary *candidate = Capture(candidatePath, YES);
    if (!candidate) { Fail(error, errno); return nil; }
    if (![source isEqual:Capture(sourceURL.path, YES)] || ![target isEqual:Capture(targetURL.path, YES)] || ![directory isEqual:Capture(directory[@"path"], NO)]) { Fail(error, ESTALE); return nil; }
    // Persist candidate directory entries before acknowledging readiness. Signature
    // validation remains authoritative if storage loses copied content on recovery.
    for (NSString *path in @[candidatePath, directory[@"path"]]) {
        int fd = OpenDirectory(path);
        if (fd < 0) { Fail(error, errno); return nil; }
        BOOL synced = fsync(fd) == 0; int code = errno; close(fd);
        if (!synced) { Fail(error, code); return nil; }
    }
    // The normal installer still validates the candidate signature after termination.
    SSPreparationRecord[@"candidate"] = candidate;
    SSPreparationRecord[@"state"] = SSPreparationReady;
    if (!Save(error)) { SSPreparationRecord[@"state"] = SSPreparationCopying; [SSPreparationRecord removeObjectForKey:@"candidate"]; return nil; }
    NSLog(@"[shipit-preparation] event=ready attempt=%lu", (unsigned long)attempts + 1);
    return candidateURL;
}
static BOOL ValidatePreparation(NSURL *sourceURL, NSURL *targetURL, NSDictionary *binding, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationFD < 0) return Fail(error, EBADF);
    if (SSPreparationRecord[@"failure"]) return Fail(error, ECANCELED);
    if (![(binding ?: @{}) isEqual:(SSPreparationRecord[@"binding"] ?: @{})]) return Fail(error, ESTALE);
    if (!sourceURL.isFileURL || !targetURL.isFileURL) return Fail(error, EINVAL);
    if (![SSPreparationRecord[@"state"] isEqual:SSPreparationReady]) return Fail(error, ESTALE);
    for (NSString *key in @[@"source", @"target", @"directory"]) {
        NSDictionary *expected = SSPreparationRecord[key];
        NSURL *url = [key isEqual:@"source"] ? sourceURL : [key isEqual:@"target"] ? targetURL : [NSURL fileURLWithPath:expected[@"path"]];
        NSDictionary *current = Capture(url.path, ![key isEqual:@"directory"]);
        if (!current || ![current isEqual:expected]) return Fail(error, ESTALE);
    }
    int directory = OpenDirectory(SSPreparationRecord[@"directory"][@"path"]);
    if (directory < 0) return Fail(error, errno);
    struct stat info;
    BOOL inspected = fstat(directory, &info) == 0;
    int code = errno; close(directory);
    if (!inspected) return Fail(error, code);
    return info.st_uid == geteuid() && !(info.st_mode & (S_IRWXG | S_IRWXO)) ? YES : Fail(error, EPERM);
}
BOOL SSPreparationValidate(NSURL *sourceURL, NSURL *targetURL, NSDictionary *binding, NSURL *candidateURL, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (!candidateURL.isFileURL) return Fail(error, EINVAL);
    if (!ValidatePreparation(sourceURL, targetURL, binding, error)) return NO;
    NSDictionary *expected = SSPreparationRecord[@"candidate"], *current = Capture(candidateURL.path, YES);
    if ([current isEqual:expected]) return YES;
    NSLog(@"[shipit-preparation] event=validation-failed subject=candidate ownership-transition=%@",
        CandidateOwnershipMatches(expected, current) ? @"yes" : @"no");
    return Fail(error, ESTALE);
}
BOOL SSPreparationBeginOwnership(NSURL *source, NSURL *target, NSDictionary *binding, NSURL *candidate, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationReadOnly) return Fail(error, EROFS);
    if (!SSPreparationValidate(source, target, binding, candidate, error)) return NO;
    if (SSPreparationRecord[@"ownership"]) return Fail(error, ECANCELED);
    SSPreparationRecord[@"ownership"] = @YES;
    if (Save(error)) return YES;
    [SSPreparationRecord removeObjectForKey:@"ownership"];
    return NO;
}
BOOL SSPreparationAcceptOwnership(NSURL *sourceURL, NSURL *targetURL, NSDictionary *binding, NSURL *candidateURL, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationReadOnly) return Fail(error, EROFS);
    if (!candidateURL.isFileURL) return Fail(error, EINVAL);
    if (!ValidatePreparation(sourceURL, targetURL, binding, error)) return NO;
    NSDictionary *before = SSPreparationRecord[@"candidate"], *after = Capture(candidateURL.path, YES);
    if (!CandidateOwnershipMatches(before, after)) return Fail(error, ESTALE);
    // SQRLInstaller.takeOwnershipOfFileSecurity uses the real UID, not a
    // request-supplied account. Its private copy remains under our EUID-owned parent.
    if (![after[@"item"][@"uid"] isEqual:@(getuid())] || ![after[@"contents"][@"uid"] isEqual:@(getuid())]) return Fail(error, EPERM);
    if (!SSPreparationRecord[@"ownership"]) return Fail(error, EPERM);
    SSPreparationRecord[@"candidate"] = after;
    [SSPreparationRecord removeObjectForKey:@"ownership"];
    if (!Save(error)) { SSPreparationRecord[@"candidate"] = before; SSPreparationRecord[@"ownership"] = @YES; return NO; }
    NSLog(@"[shipit-preparation] event=ownership-accepted uid=%u bundle-changed=%d contents-changed=%d",
        getuid(), ![before[@"item"] isEqual:after[@"item"]], ![before[@"contents"] isEqual:after[@"contents"]]);
    return SSPreparationValidate(sourceURL, targetURL, binding, candidateURL, error);
}
static BOOL FailureTrusted(NSURL *source, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationFD < 0) return Fail(error, EBADF);
    if (!source.isFileURL || ![SSPreparationRecord[@"state"] isEqual:SSPreparationReady]) return Fail(error, ESTALE);
    if (![Capture(source.path, YES) isEqual:SSPreparationRecord[@"source"]]) return Fail(error, ESTALE);
    if (!CandidateOwnershipMatches(SSPreparationRecord[@"candidate"], Capture(SSPreparationRecord[@"candidate"][@"path"], YES))) return Fail(error, ESTALE);
    NSDictionary *expected = SSPreparationRecord[@"directory"];
    if (![Capture(expected[@"path"], NO) isEqual:expected]) return Fail(error, ESTALE);
    int directory = OpenDirectory(SSPreparationRecord[@"directory"][@"path"]);
    if (directory < 0) return Fail(error, errno);
    struct stat info;
    BOOL safe = fstat(directory, &info) == 0 && info.st_uid == geteuid() && !(info.st_mode & (S_IRWXG | S_IRWXO));
    close(directory);
    return safe ? YES : Fail(error, EPERM);
}
static NSDictionary *ObserveState(NSURL *state, NSError **error) {
    if (!state.isFileURL || state.host.length) { Fail(error, EINVAL); return nil; }
    int parent = OpenDirectory(state.path.stringByDeletingLastPathComponent);
    if (parent < 0) { Fail(error, errno); return nil; }
    NSDictionary *observed = SSObservationReadAt(parent, state.path.lastPathComponent, (NSUInteger)SSPreparationMaximumBytes, NO, NO, error);
    int saved = errno;
    if (close(parent) != 0 && observed) { Fail(error, errno); return nil; }
    errno = saved;
    return observed;
}
NSDictionary *SSPreparationFailureSnapshot(NSURL *source, NSURL *target, NSDictionary *binding,
    NSURL *state, SSPreparationActivity (^activity)(void), NSError **error) {
    if (SSPreparationCloseUncertain) { Fail(error, SSPreparationUncertaintyCode()); return nil; }
    if (!SSPreparationReadOnly || SSPreparationFD < 0 || SSPreparationLockFD < 0 || getuid() != geteuid()) { Fail(error, EBADF); return nil; }
    NSDictionary *cleanup = SSCleanupReadOnlySnapshot(error);
    if (!cleanup) return nil;
    SSPreparationActivity activityBefore = activity ? activity() : SSPreparationActivityUnknown;
    if (activityBefore != SSPreparationActivityAbsent) { Fail(error, activityBefore == SSPreparationActivityActive ? EBUSY : EAGAIN); return nil; }
    NSDictionary *qualification = SSObservationDirectorySnapshot(SSPreparationFD, SSPreparationLockFD, SSPreparationLock, SSPreparationObservedDirectory, error);
    NSDictionary *journal = SSObservationReadAt(SSPreparationFD, SSPreparationJournal, (NSUInteger)SSPreparationMaximumBytes, YES, NO, error);
    NSDictionary *failure = SSPreparationRecord[@"failure"];
    if (!qualification || ![journal[@"snapshot"] isEqual:SSPreparationObservation]) { Fail(error, ESTALE); return nil; }
    if (!SSBindingValid(binding) || ![binding isEqual:SSPreparationRecord[@"binding"]] ||
        !SSObservationInteger(failure[@"code"]) || SSPreparationRecord[@"ownership"] || Overlaps(source.path, target.path) ||
        !StrictCapture(SSPreparationRecord[@"source"], YES) || !StrictCapture(SSPreparationRecord[@"target"], YES) ||
        !SSObservationInteger(SSPreparationRecord[@"attempts"]) || !FailureTrusted(source, error) || !FailurePublished() ||
        ![Capture(target.path, YES) isEqual:SSPreparationRecord[@"target"]] || SSCleanupCommittedRequest(source, target)) {
        Fail(error, ESTALE); return nil;
    }
    NSInteger code = [failure[@"code"] integerValue];
    NSDictionary *ack = SSReadinessFailureSnapshot(source, target, binding, code, error);
    NSDictionary *observedState = ObserveState(state, error);
    NSDictionary *request = observedState ? [NSJSONSerialization JSONObjectWithData:observedState[@"data"] options:0 error:NULL] : nil;
    if (!ack || ![request isKindOfClass:NSDictionary.class] || request.count != 7 ||
        ![request[@"binding"] isEqual:binding] || ![request[@"bundleIdentifier"] isKindOfClass:NSString.class] || ![request[@"bundleIdentifier"] length]) { Fail(error, EINVAL); return nil; }
    for (NSString *key in @[@"useUpdateBundleName", @"installationAuthorized", @"launchAfterInstallation"])
        if (!SSObservationBoolean(request[key])) { Fail(error, EINVAL); return nil; }
    if ([request[@"installationAuthorized"] boolValue] && ![request[@"launchAfterInstallation"] boolValue]) { Fail(error, EINVAL); return nil; }
    for (NSArray *pair in @[@[@"updateBundleURL", @"source"], @[@"targetBundleURL", @"target"]]) {
        if (![request[pair[0]] isKindOfClass:NSString.class]) { Fail(error, EINVAL); return nil; }
        NSURL *url = [NSURL URLWithString:request[pair[0]]];
        if (!url.isFileURL || url.host.length || ![Capture(url.path, YES) isEqual:SSPreparationRecord[pair[1]]]) { Fail(error, ESTALE); return nil; }
    }
    if (activity() != SSPreparationActivityAbsent ||
        ![SSCleanupReadOnlySnapshot(error) isEqual:cleanup] ||
        ![SSObservationReadAt(SSPreparationFD, SSPreparationJournal, (NSUInteger)SSPreparationMaximumBytes, YES, NO, error)[@"snapshot"] isEqual:journal[@"snapshot"]] ||
        ![SSReadinessFailureSnapshot(source, target, binding, code, error) isEqual:ack] ||
        ![ObserveState(state, error)[@"snapshot"] isEqual:observedState[@"snapshot"]] ||
        ![SSObservationDirectorySnapshot(SSPreparationFD, SSPreparationLockFD, SSPreparationLock, SSPreparationObservedDirectory, error) isEqual:qualification] ||
        !FailureTrusted(source, error) || !FailureTargetRestored()) { Fail(error, ESTALE); return nil; }
    return @{@"kind":@"terminal-failure-observation", @"binding":binding, @"code":@(code), @"bundleIdentifier":request[@"bundleIdentifier"], @"source":SSPreparationRecord[@"source"],
        @"target":SSPreparationRecord[@"target"], @"journal":journal[@"snapshot"], @"ack":ack, @"state":observedState[@"snapshot"],
        @"cleanup":cleanup, @"qualification":qualification};
}
BOOL SSPreparationRecordFailure(NSURL *source, NSURL *actualTarget, NSDictionary *binding, NSInteger code, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationReadOnly) return Fail(error, EROFS);
    if (SSPreparationRecord[@"failure"]) return Fail(error, EALREADY);
    if (![(binding ?: @{}) isEqual:(SSPreparationRecord[@"binding"] ?: @{})]) return Fail(error, ESTALE);
    if (!FailureTrusted(source, error) || !actualTarget.isFileURL) return NO;
    NSDictionary *expected = SSPreparationRecord[@"target"], *actual = Capture(actualTarget.path, YES);
    if (!actual || ![actual[@"parent"] isEqual:expected[@"parent"]] ||
        ![actual[@"item"] isEqual:expected[@"item"]] || ![actual[@"contents"] isEqual:expected[@"contents"]] ||
        ![[actual[@"path"] stringByDeletingLastPathComponent] isEqual:[expected[@"path"] stringByDeletingLastPathComponent]]) return Fail(error, ESTALE);
    id previous = SSPreparationRecord[@"failure"];
    id previousOwnership = SSPreparationRecord[@"ownership"];
    NSDictionary *previousCandidate = SSPreparationRecord[@"candidate"];
    NSDictionary *candidate = Capture(previousCandidate[@"path"], YES);
    if (!CandidateOwnershipMatches(previousCandidate, candidate)) return Fail(error, ESTALE);
    // A failed signature/permission operation can have completed ownership first.
    // Persist that snapshot only with the terminal fence; this never admits install.
    SSPreparationRecord[@"candidate"] = candidate;
    SSPreparationRecord[@"failure"] = @{@"target":actual, @"code":@(code)};
    [SSPreparationRecord removeObjectForKey:@"ownership"];
    if (Save(error)) return YES;
    SSPreparationRecord[@"candidate"] = previousCandidate;
    if (previousOwnership) SSPreparationRecord[@"ownership"] = previousOwnership;
    if (previous) SSPreparationRecord[@"failure"] = previous; else [SSPreparationRecord removeObjectForKey:@"failure"];
    return NO;
}
SSPreparationFailure SSPreparationRecoverFailure(NSURL *source, NSURL *target, NSDictionary *binding, NSInteger *code, NSError **error) {
    if (SSPreparationCloseUncertain) { Fail(error, SSPreparationUncertaintyCode()); return SSPreparationFailureInvalid; }
    if (SSPreparationReadOnly) { Fail(error, EROFS); return SSPreparationFailureInvalid; }
    if (!SSPreparationRecord[@"failure"]) {
        if (!SSPreparationRecord[@"ownership"]) return SSPreparationFailureNone;
        // No target acquisition is permitted until ownership intent is cleared
        // together with the verified candidate snapshot. Never resume this attempt.
        if (!SSPreparationRecordFailure(source, target, binding, ECANCELED, error)) return SSPreparationFailureInvalid;
    }
    if (!source.isFileURL || !target.isFileURL) { Fail(error, EINVAL); return SSPreparationFailureInvalid; }
    char sourceParent[PATH_MAX];
    if (!realpath(source.path.stringByDeletingLastPathComponent.fileSystemRepresentation, sourceParent)) {
        Fail(error, errno); return SSPreparationFailureInvalid;
    }
    if (![[@(sourceParent) stringByAppendingPathComponent:source.lastPathComponent] isEqual:SSPreparationRecord[@"source"][@"path"]]) {
        if (FailurePublished()) return SSPreparationFailureNone;
        Fail(error, ECANCELED); return SSPreparationFailureInvalid;
    }
    if (![(binding ?: @{}) isEqual:(SSPreparationRecord[@"binding"] ?: @{})]) { Fail(error, ESTALE); return SSPreparationFailureInvalid; }
    if (!FailureTrusted(source, error)) return SSPreparationFailureInvalid;
    NSDictionary *expected = SSPreparationRecord[@"target"], *failure = SSPreparationRecord[@"failure"];
    char canonical[PATH_MAX];
    if (!realpath(target.path.stringByDeletingLastPathComponent.fileSystemRepresentation, canonical) ||
        ![[@(canonical) stringByAppendingPathComponent:target.lastPathComponent] isEqual:expected[@"path"]]) {
        Fail(error, ESTALE); return SSPreparationFailureInvalid;
    }
    NSDictionary *current = Capture(expected[@"path"], YES);
    if (![current isEqual:expected]) {
        int missing = errno;
        NSDictionary *actual = failure[@"target"];
        if (current || missing != ENOENT || ![Capture(actual[@"path"], YES) isEqual:actual]) {
            Fail(error, ESTALE); return SSPreparationFailureInvalid;
        }
        int parent = OpenDirectory([expected[@"path"] stringByDeletingLastPathComponent]);
        struct stat info;
        BOOL matched = parent >= 0 && fstat(parent, &info) == 0 && [Identity(info) isEqual:expected[@"parent"]];
        BOOL restored = matched && renameatx_np(parent, [actual[@"path"] lastPathComponent].fileSystemRepresentation,
            parent, [expected[@"path"] lastPathComponent].fileSystemRepresentation, RENAME_EXCL) == 0 && fsync(parent) == 0;
        int saved = errno; if (parent >= 0) close(parent);
        if (!restored) { Fail(error, saved ?: ESTALE); return SSPreparationFailureInvalid; }
    }
    if (![Capture(expected[@"path"], YES) isEqual:expected] || !FailureTrusted(source, error)) {
        Fail(error, ESTALE); return SSPreparationFailureInvalid;
    }
    if (![failure[@"target"][@"path"] isEqual:expected[@"path"]]) {
        struct stat remaining;
        if (lstat([failure[@"target"][@"path"] fileSystemRepresentation], &remaining) == 0 || errno != ENOENT) {
            Fail(error, ESTALE); return SSPreparationFailureInvalid;
        }
    }
    if (code) *code = [failure[@"code"] integerValue];
    return SSPreparationFailureRestored;
}
BOOL SSPreparationFinishFailure(NSURL *source, NSURL *target, NSDictionary *binding, BOOL authorized,
    BOOL (^running)(void), BOOL (^launch)(void), NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationReadOnly) return Fail(error, EROFS);
    NSInteger code = 0;
    if (SSPreparationRecoverFailure(source, target, binding, &code, error) != SSPreparationFailureRestored) return NO;
    if (!ValidTerminalRecord(SSPreparationRecord)) return Fail(error, EINVAL);
    if (SSPreparationRecord[@"terminalVersion"] && !SSPreparationRecord[@"failure"][@"publication"]) {
        NSDictionary *publication = TerminalPublication(SSPreparationRecord);
        if (!publication || !FailureTargetRestored()) return Fail(error, ESTALE);
        id before = SSPreparationRecord[@"failure"];
        NSMutableDictionary *failure = [before mutableCopy];
        failure[@"publication"] = publication;
        SSPreparationRecord[@"failure"] = failure;
        if (!Save(error)) { SSPreparationRecord[@"failure"] = before; return NO; }
    }
    if (!SSReadinessPublishBound(source, target, binding, NO, code, error)) return NO;
    if (!authorized || [SSPreparationRecord[@"failure"][@"launched"] boolValue]) return YES;
    if (!running || !launch) return Fail(error, EINVAL);
    if (!running() && !launch()) return Fail(error, EIO);
    NSMutableDictionary *failure = [SSPreparationRecord[@"failure"] mutableCopy];
    failure[@"launched"] = @YES;
    id before = SSPreparationRecord[@"failure"];
    SSPreparationRecord[@"failure"] = failure;
    if (Save(error)) return YES;
    SSPreparationRecord[@"failure"] = before;
    return NO;
}
BOOL SSPreparationRetire(NSURL *sourceURL, NSURL *targetURL, NSError **error) {
    if (SSPreparationCloseUncertain) return Fail(error, SSPreparationUncertaintyCode());
    if (SSPreparationReadOnly) return Fail(error, EROFS);
    if (SSPreparationFD < 0) return Fail(error, EBADF);
    if (SSPreparationRecord[@"failure"]) return Fail(error, ECANCELED);
  if (!sourceURL.isFileURL || !targetURL.isFileURL) return Fail(error, EINVAL);
  if (!SSPreparationRecord) return YES;
  NSDictionary *source = Capture(sourceURL.path, YES);
  if (!source) return Fail(error, errno);
  NSDictionary *target = Capture(targetURL.path, YES);
  if (!target) return Fail(error, errno);
  NSDictionary *candidate = SSPreparationRecord[@"candidate"];
  NSString *originalTarget = SSPreparationRecord[@"target"][@"path"];
  NSString *renamedTarget = [originalTarget.stringByDeletingLastPathComponent stringByAppendingPathComponent:[source[@"path"] lastPathComponent]];
  if (![SSPreparationRecord[@"state"] isEqual:SSPreparationReady] ||
      ![source isEqual:SSPreparationRecord[@"source"]] ||
      (![target[@"path"] isEqual:originalTarget] && ![target[@"path"] isEqual:renamedTarget]) ||
      ![target[@"parent"] isEqual:SSPreparationRecord[@"target"][@"parent"]] ||
      ![target[@"item"] isEqual:candidate[@"item"]] ||
      ![target[@"contents"] isEqual:candidate[@"contents"]]) return Fail(error, ESTALE);
  NSMutableDictionary *record = SSPreparationRecord;
  SSPreparationRecord = nil;
  if (!Save(error)) { SSPreparationRecord = record; return NO; }
  NSLog(@"[shipit-preparation] event=retired");
  return YES;
}
