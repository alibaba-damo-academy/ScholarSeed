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

static NSString * const SSCleanupSchema = @"1";
static NSString * const SSJournal = @"journal.plist";
static NSString * const SSNextJournal = @"journal.next";
static NSString * const SSLock = @"lock";
static NSString * const SSDirectory = @"DeferredCleanup";
static const NSUInteger SSRetryCount = 3;
static const off_t SSMaximumJournalBytes = 1024 * 1024;
static const useconds_t SSRetryDelay = 250000;
static int SSDirectoryFD = -1, SSLockFD = -1;
static NSMutableArray *SSRecords;

static BOOL SSFail(NSError **error, int code) {
    if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:nil];
    return NO;
}
static NSString *SSCanonical(NSString *path) {
    if (!path.length) { errno = EINVAL; return nil; }
    char resolved[PATH_MAX];
    return realpath(path.fileSystemRepresentation, resolved) ? @(resolved) : nil;
}
static NSDictionary *SSIdentity(struct stat st) {
    return @{@"dev":@(st.st_dev), @"ino":@(st.st_ino), @"uid":@(st.st_uid)};
}
static BOOL SSMatches(NSDictionary *identity, struct stat st) {
    return [identity isEqual:SSIdentity(st)];
}
// Walk every ancestor using descriptors. Never resolve a symlink supplied by a journal.
static int SSOpenDirectory(NSString *path) {
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
static NSString *SSKey(NSString *path) {
    if (![path hasPrefix:@"/"] || [path rangeOfString:@"\0"].location != NSNotFound) return nil;
    NSMutableArray *components = [NSMutableArray array];
    for (NSString *component in [path componentsSeparatedByString:@"/"]) {
        if ([component isEqual:@"."] || [component isEqual:@".."]) return nil;
        if (component.length) [components addObject:component];
    }
    if (!components.count) return @"/";
    NSString *root = [@"/" stringByAppendingString:components[0]];
    struct stat link, after;
    if (lstat(root.fileSystemRepresentation, &link) == 0 && S_ISLNK(link.st_mode)) {
        if (link.st_uid != 0) return nil;
        NSString *canonical = SSCanonical(root);
        if (!canonical) return nil;
        NSString *parent = canonical.stringByDeletingLastPathComponent;
        while (YES) {
            int directory = SSOpenDirectory(parent);
            struct stat identity;
            BOOL trusted = directory >= 0 && fstat(directory, &identity) == 0 && identity.st_uid == 0 && !(identity.st_mode & (S_IWGRP | S_IWOTH));
            if (directory >= 0) close(directory);
            if (!trusted) return nil;
            if ([parent isEqual:@"/"]) break;
            parent = parent.stringByDeletingLastPathComponent;
        }
        if (lstat(root.fileSystemRepresentation, &after) != 0 || !SSMatches(SSIdentity(link), after)) return nil;
        root = canonical;
    }
    [components removeObjectAtIndex:0];
    return components.count ? [root stringByAppendingFormat:@"/%@", [components componentsJoinedByString:@"/"]] : root;
}
static NSString *SSPath(NSURL *url) {
    return url.isFileURL && !url.host.length ? SSKey(url.path) : nil;
}
static BOOL SSSamePath(NSString *recorded, NSURL *url) {
    return [SSKey(recorded) isEqual:SSPath(url)];
}
static NSDictionary *SSCapture(NSString *path, BOOL missingAllowed) {
    NSString *parent = path.stringByDeletingLastPathComponent;
    // Foundation collapses /private/var to /var, which is itself a system symlink.
    // Freeze the POSIX canonical parent once; all subsequent opens are nofollow.
    char canonical[PATH_MAX];
    if (!realpath(parent.fileSystemRepresentation, canonical)) return nil;
    parent = @(canonical);
    path = [parent stringByAppendingPathComponent:path.lastPathComponent];
    int fd = SSOpenDirectory(parent);
    if (fd < 0) return nil;
    struct stat p, s; BOOL ok = fstat(fd, &p) == 0;
    int status = fstatat(fd, path.lastPathComponent.fileSystemRepresentation, &s, AT_SYMLINK_NOFOLLOW);
    int code = errno; close(fd);
    if (!ok || (status != 0 && !(missingAllowed && code == ENOENT))) return nil;
    if (status == 0 && !S_ISDIR(s.st_mode)) { errno = EINVAL; return nil; }
    return @{@"path":path, @"parent":SSIdentity(p), @"item": status == 0 ? SSIdentity(s) : @{}, @"absent":@(status != 0)};
}
static BOOL SSValidIdentity(id identity) {
    if (![identity isKindOfClass:NSDictionary.class]) return NO;
    for (NSString *key in @[@"dev", @"ino", @"uid"]) if (![identity[key] isKindOfClass:NSNumber.class]) return NO;
    return [identity count] == 3;
}
static BOOL SSValidCapture(id item) {
    return [item isKindOfClass:NSDictionary.class] && [item[@"path"] isKindOfClass:NSString.class] &&
        [item[@"absent"] isKindOfClass:NSNumber.class] && SSValidIdentity(item[@"parent"]) &&
        ([item[@"absent"] boolValue] ? [item[@"item"] isKindOfClass:NSDictionary.class] : SSValidIdentity(item[@"item"])) &&
        [@[@"cleanup-source", @"cleanup-stage", @"cleanup-previous"] containsObject:item[@"stage"]];
}
static BOOL SSReadOnly;
static NSDictionary *SSReadOnlyJournal;
static NSString *SSReadOnlyDirectory;
static BOOL SSCloseUncertain;

static BOOL SSSave(void) {
    if (SSReadOnly) { errno = EROFS; return NO; }
    NSError *error;
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:@{@"schema":SSCleanupSchema, @"records":SSRecords} format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
    if (!data) return NO;
    if (data.length > (NSUInteger)SSMaximumJournalBytes) { errno = EFBIG; return NO; }
    unlinkat(SSDirectoryFD, SSNextJournal.UTF8String, 0);
    int fd = openat(SSDirectoryFD, SSNextJournal.UTF8String, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR);
    if (fd < 0) return NO;
    const uint8_t *bytes = data.bytes; NSUInteger left = data.length;
    while (left) { ssize_t n = write(fd, bytes, left); if (n < 0 && errno == EINTR) continue; if (n <= 0) { close(fd); return NO; } left -= (NSUInteger)n; bytes += n; }
    BOOL ok = fsync(fd) == 0; close(fd);
    return ok && renameat(SSDirectoryFD, SSNextJournal.UTF8String, SSDirectoryFD, SSJournal.UTF8String) == 0 && fsync(SSDirectoryFD) == 0;
}
BOOL SSCleanupCloseChecked(NSError **error) {
    if (SSCloseUncertain) return SSFail(error, EIO);
    for (NSUInteger index = 0; index < 2; index++) {
        int *descriptor = index == 0 ? &SSDirectoryFD : &SSLockFD;
        int closing = *descriptor;
        *descriptor = -1;
        if (closing >= 0 && close(closing) != 0) { SSCloseUncertain = YES; return SSFail(error, errno); }
    }
    SSRecords = nil;
    SSReadOnly = NO;
    SSReadOnlyJournal = nil;
    SSReadOnlyDirectory = nil;
    return YES;
}
void SSCleanupClose(void) {
    SSCleanupCloseChecked(NULL);
}
static BOOL SSCleanupOpenDirectoryMode(NSString *directory, BOOL readOnly, NSError **error) {
    if (!SSCleanupCloseChecked(error)) return NO;
    SSReadOnly = readOnly;
    if (readOnly) SSReadOnlyDirectory = directory;
    SSDirectoryFD = SSOpenDirectory(directory);
    if (SSDirectoryFD < 0) return SSFail(error, errno);
    struct stat st;
    if (fstat(SSDirectoryFD, &st) != 0 || st.st_uid != geteuid() || (st.st_mode & (S_IRWXG | S_IRWXO))) { SSCleanupClose(); return SSFail(error, EPERM); }
    SSLockFD = openat(SSDirectoryFD, SSLock.UTF8String, (readOnly ? O_RDONLY | O_NONBLOCK : O_CREAT | O_RDWR) | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR);
    if (SSLockFD < 0 || fstat(SSLockFD, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != geteuid() || st.st_nlink != 1 ||
        (readOnly && (st.st_mode & (S_IRWXG | S_IRWXO))) || flock(SSLockFD, LOCK_EX | LOCK_NB) != 0) { int code = errno ?: EPERM; SSCleanupClose(); return SSFail(error, code); }
    SSRecords = [NSMutableArray array];
    NSDictionary *observation = SSObservationReadAt(SSDirectoryFD, SSJournal, (NSUInteger)SSMaximumJournalBytes, NO, NO, error);
    if (!observation) { if (errno == ENOENT) { if (readOnly) SSReadOnlyJournal = @{@"state":@"absent"}; return YES; } int code = errno; SSCleanupClose(); return SSFail(error, code); }
    id record = [NSPropertyListSerialization propertyListWithData:observation[@"data"] options:NSPropertyListMutableContainers format:NULL error:error];
    if (![record isKindOfClass:NSDictionary.class] || ![record[@"schema"] isEqual:SSCleanupSchema] || ![record[@"records"] isKindOfClass:NSArray.class]) { SSCleanupClose(); return SSFail(error, EINVAL); }
    for (id item in record[@"records"]) {
        if (![item isKindOfClass:NSDictionary.class] || ![item[@"source"] isKindOfClass:NSString.class] || ![item[@"target"] isKindOfClass:NSString.class] || ![item[@"originalTarget"] isKindOfClass:NSString.class] || ![item[@"previous"] isKindOfClass:NSString.class] || ![item[@"items"] isKindOfClass:NSArray.class] || !SSValidIdentity(item[@"targetIdentity"]) || !SSValidIdentity(item[@"previousIdentity"]) || ![item[@"launched"] isKindOfClass:NSNumber.class]) { SSCleanupClose(); return SSFail(error, EINVAL); }
        for (NSString *key in @[@"source", @"target", @"originalTarget", @"previous"]) if (!SSKey(item[key])) { SSCleanupClose(); return SSFail(error, EINVAL); }
        if (item[@"previousCapture"] && (!SSValidCapture(item[@"previousCapture"]) || ![item[@"previousCapture"][@"stage"] isEqual:@"cleanup-previous"] || ![item[@"previousCapture"][@"item"] isEqual:item[@"previousIdentity"]])) { SSCleanupClose(); return SSFail(error, EINVAL); }
        for (id capture in item[@"items"]) if (!SSValidCapture(capture)) { SSCleanupClose(); return SSFail(error, EINVAL); }
    }
    SSRecords = record[@"records"];
    if (readOnly) SSReadOnlyJournal = observation[@"snapshot"];
    return YES;
}
BOOL SSCleanupOpenDirectory(NSString *directory, NSError **error) {
    return SSCleanupOpenDirectoryMode(directory, NO, error);
}
BOOL SSCleanupOpenExistingDirectory(NSString *directory, NSError **error) {
    return SSCleanupOpenDirectoryMode(directory, YES, error);
}
NSDictionary *SSCleanupReadOnlySnapshot(NSError **error) {
    if (SSCloseUncertain || !SSReadOnly || SSDirectoryFD < 0 || SSLockFD < 0) { SSFail(error, EBADF); return nil; }
    NSDictionary *qualified = SSObservationDirectorySnapshot(SSDirectoryFD, SSLockFD, SSLock, SSReadOnlyDirectory, error);
    if (!qualified) return nil;
    NSDictionary *observation = SSObservationReadAt(SSDirectoryFD, SSJournal, (NSUInteger)SSMaximumJournalBytes, NO, NO, error);
    NSDictionary *current = observation ? observation[@"snapshot"] : errno == ENOENT ? @{@"state":@"absent"} : nil;
    if (![current isEqual:SSReadOnlyJournal]) { SSFail(error, ESTALE); return nil; }
    return @{@"qualification":qualified, @"journal":current, @"recordCount":@(SSRecords.count)};
}
BOOL SSCleanupClearRollback(NSString *label, NSString *key) {
    if (SSReadOnly) { errno = EROFS; return NO; }
    CFPreferencesSetValue((__bridge CFStringRef)key, NULL, (__bridge CFStringRef)label, kCFPreferencesCurrentUser, kCFPreferencesCurrentHost);
    return CFPreferencesSynchronize((__bridge CFStringRef)label, kCFPreferencesCurrentUser, kCFPreferencesCurrentHost);
}
static BOOL SSCleanupOpenOwner(NSString *label, NSError **error) {
    NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"] invertedSet];
    if (!label.length || [label rangeOfCharacterFromSet:invalid].location != NSNotFound || [label isEqual:@"."] || [label isEqual:@".."]) return SSFail(error, EINVAL);
    NSURL *cache = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:error];
    if (!cache) return NO;
    // Foundation may collapse /private/var back to the /var system symlink.
    // Resolve only the OS-selected support root, never our private descendants
    // or a journal-supplied path. Keep all subsequent opens no-follow.
    char canonical[PATH_MAX];
    if (!realpath(cache.path.fileSystemRepresentation, canonical)) {
        int code = errno;
        NSLog(@"[shipit-directory] event=resolve-failed operation=realpath path=%@ uid=%u euid=%u errno=%d", cache.path, getuid(), geteuid(), code);
        return SSFail(error, code);
    }
    NSString *supportPath = @(canonical);
    NSLog(@"[shipit-directory] event=resolved label=%@ input=%@ canonical=%@ uid=%u euid=%u", label, cache.path, supportPath, getuid(), geteuid());
    NSString *base = [supportPath stringByAppendingPathComponent:label];
    // Create our own durable owner directory; caches are not a commit journal.
    int owner = SSOpenDirectory(supportPath);
    if (owner < 0) return SSFail(error, errno);
    if (mkdirat(owner, label.UTF8String, S_IRWXU) != 0 && errno != EEXIST) { int code = errno; close(owner); return SSFail(error, code); }
    if (fsync(owner) != 0) { int code = errno; close(owner); return SSFail(error, code); }
    close(owner);
    int parent = SSOpenDirectory(base);
    if (parent < 0) return SSFail(error, errno);
    struct stat st;
    if (fstat(parent, &st) != 0 || st.st_uid != geteuid() || (st.st_mode & (S_IWGRP | S_IWOTH))) { close(parent); return SSFail(error, EPERM); }
    if (mkdirat(parent, SSDirectory.UTF8String, S_IRWXU) != 0 && errno != EEXIST) { int code = errno; close(parent); return SSFail(error, code); }
    if (fsync(parent) != 0) { int code = errno; close(parent); return SSFail(error, code); }
    close(parent);
    return SSCleanupOpenDirectory([base stringByAppendingPathComponent:SSDirectory], error);
}
BOOL SSCleanupOpen(NSString *label, NSError **error) {
    NSError *failure = nil;
    BOOL opened = SSCleanupOpenOwner(label, &failure);
    if (!opened) {
        NSLog(@"[shipit-directory] event=owner-open-failed owner=SSCleanup label=%@ uid=%u euid=%u error=%@", label, getuid(), geteuid(), failure);
        if (error) *error = failure;
    }
    return opened;
}
static BOOL SSTargetMatches(NSDictionary *record, NSURL *target) {
    if (!SSSamePath(record[@"target"], target)) return NO;
    NSDictionary *capture = SSCapture([SSPath(target) stringByAppendingPathComponent:@"Contents"], NO);
    return capture && [capture[@"item"] isEqual:record[@"targetIdentity"]];
}
BOOL SSCleanupCommit(NSURL *source, NSURL *stage, NSURL *previous, NSURL *target, NSURL *originalTarget, NSError **error) {
    if (SSReadOnly) return SSFail(error, EROFS);
    if (SSDirectoryFD < 0) return SSFail(error, EBADF);
    for (NSURL *url in @[source, stage, previous, target, originalTarget]) if (!SSPath(url)) return SSFail(error, EINVAL);
    NSMutableArray *items = [NSMutableArray array];
    NSArray *urls = @[source, stage, previous]; NSArray *labels = @[@"cleanup-source", @"cleanup-stage", @"cleanup-previous"];
    for (NSUInteger i = 0; i < urls.count; i++) {
        NSDictionary *capture = SSCapture(SSPath(urls[i]), i == 1);
        if (!capture) return SSFail(error, errno ?: EINVAL);
        NSString *path = capture[@"path"], *active = SSCanonical(SSPath(target));
        if (!active || [path isEqual:active] || [active hasPrefix:[path stringByAppendingString:@"/"]] || [path hasPrefix:[active stringByAppendingString:@"/"]]) return SSFail(error, EINVAL);
        NSMutableDictionary *item = [capture mutableCopy]; item[@"stage"] = labels[i]; [items addObject:item];
    }
    NSDictionary *capture = SSCapture([SSPath(target) stringByAppendingPathComponent:@"Contents"], NO);
    if (!capture) return SSFail(error, errno ?: EINVAL);
    NSMutableDictionary *record = [@{@"source":SSPath(source), @"originalTarget":SSPath(originalTarget), @"target":SSPath(target), @"targetIdentity":capture[@"item"], @"previous":SSPath(previous), @"previousIdentity":items[2][@"item"], @"previousCapture":items[2], @"items":items, @"launched":@NO} mutableCopy];
    NSMutableArray *before = SSRecords;
    SSRecords = [NSMutableArray array];
    // A different committed request supersedes completed tombstones, never pending work.
    for (NSDictionary *old in before) if ([old[@"items"] count]) [SSRecords addObject:old];
    [SSRecords addObject:record];
    if (!SSSave()) { SSRecords = before; return SSFail(error, errno ?: EIO); }
    NSLog(@"[shipit-cleanup] event=committed pending=%lu", (unsigned long)items.count);
    return YES;
}
BOOL SSCleanupKnowsRollback(NSURL *previous, NSURL *target) {
    for (NSDictionary *r in SSRecords) if (SSSamePath(r[@"previous"], previous) && SSSamePath(r[@"target"], target)) return YES;
    return NO;
}
BOOL SSCleanupReconcilesRollback(NSURL *previous, NSURL *target) {
    // A durable commit retires this rollback even if a later actor changes the target.
    for (NSDictionary *r in SSRecords) if (SSSamePath(r[@"previous"], previous) && SSSamePath(r[@"target"], target)) {
        NSDictionary *capture = r[@"previousCapture"];
        for (NSDictionary *item in r[@"items"]) if (!capture && [item[@"stage"] isEqual:@"cleanup-previous"]) capture = item;
        NSString *path = capture ? capture[@"path"] : SSPath(previous);
        int parent = SSOpenDirectory(path.stringByDeletingLastPathComponent);
        if (parent < 0) return errno == ENOENT;
        struct stat identity, current;
        BOOL matches = !capture || (fstat(parent, &identity) == 0 && SSMatches(capture[@"parent"], identity));
        int status = matches ? fstatat(parent, path.lastPathComponent.fileSystemRepresentation, &current, AT_SYMLINK_NOFOLLOW) : -1;
        int code = errno;
        close(parent);
        return matches && ((status < 0 && code == ENOENT) || (capture && status == 0 && S_ISDIR(current.st_mode) && SSMatches(r[@"previousIdentity"], current)));
    }
    return NO;
}
NSURL *SSCleanupRecoveredTarget(NSURL *source, NSURL *requestedTarget) {
    for (NSDictionary *record in SSRecords) {
        NSURL *finalTarget = [NSURL fileURLWithPath:record[@"target"]];
        if (SSSamePath(record[@"source"], source) &&
            (SSSamePath(record[@"originalTarget"], requestedTarget) || SSSamePath(record[@"target"], requestedTarget)) && SSTargetMatches(record, finalTarget)) return finalTarget;
    }
    return nil;
}
BOOL SSCleanupKnownRequest(NSURL *source) {
    for (NSDictionary *r in SSRecords) if (SSSamePath(r[@"source"], source)) return YES;
    return NO;
}
BOOL SSCleanupCommittedRequest(NSURL *source, NSURL *target) {
    return SSCleanupRecoveredTarget(source, target) != nil;
}
BOOL SSCleanupLaunchNeeded(NSURL *source, NSURL *target) {
    for (NSDictionary *r in SSRecords) if (SSSamePath(r[@"source"], source) && SSTargetMatches(r, target)) return ![r[@"launched"] boolValue];
    return YES;
}
BOOL SSCleanupMarkLaunched(NSURL *source, NSURL *target) {
    if (SSReadOnly) { errno = EROFS; return NO; }
    for (NSMutableDictionary *r in SSRecords) if (SSSamePath(r[@"source"], source) && SSTargetMatches(r, target)) { r[@"launched"] = @YES; return SSSave(); }
    return YES;
}
// Unlink symlinks themselves; never follow them. Bind each opened directory to its inspected inode.
static BOOL SSRemoveChildren(int directory, dev_t device) {
    DIR *stream = fdopendir(dup(directory)); if (!stream) return NO;
    BOOL ok = YES; struct dirent *entry;
    while ((entry = readdir(stream))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        struct stat before, opened;
        if (fstatat(directory, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) != 0) { if (errno == ENOENT) continue; ok = NO; break; }
        if (before.st_dev != device) { errno = EXDEV; ok = NO; break; }
        if (S_ISDIR(before.st_mode)) {
            int child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child < 0 || fstat(child, &opened) != 0 || before.st_dev != opened.st_dev || before.st_ino != opened.st_ino || !SSRemoveChildren(child, device)) { if (child >= 0) close(child); ok = NO; break; }
            close(child);
            if (unlinkat(directory, entry->d_name, AT_REMOVEDIR) != 0 && errno != ENOENT) { ok = NO; break; }
        } else if (unlinkat(directory, entry->d_name, 0) != 0 && errno != ENOENT) { ok = NO; break; }
    }
    closedir(stream); return ok;
}
static BOOL SSRemoveItem(NSDictionary *item, NSURL *protectedTarget) {
    NSString *path = item[@"path"], *active = SSCanonical(SSPath(protectedTarget));
    if (!active || ![path isKindOfClass:NSString.class] || ![item[@"parent"] isKindOfClass:NSDictionary.class] || ![item[@"item"] isKindOfClass:NSDictionary.class] || [path isEqual:active] || [active hasPrefix:[path stringByAppendingString:@"/"]] || [path hasPrefix:[active stringByAppendingString:@"/"]]) { errno = EPERM; return NO; }
    NSString *parent = path.stringByDeletingLastPathComponent;
    int fd = SSOpenDirectory(parent); if (fd < 0) return errno == ENOENT;
    struct stat p, s;
    if (fstat(fd, &p) != 0 || !SSMatches(item[@"parent"], p)) { close(fd); errno = ESTALE; return NO; }
    BOOL ok = YES;
    if (fstatat(fd, path.lastPathComponent.fileSystemRepresentation, &s, AT_SYMLINK_NOFOLLOW) == 0) {
        if ([item[@"absent"] boolValue] || !S_ISDIR(s.st_mode) || !SSMatches(item[@"item"], s)) { close(fd); errno = ESTALE; return NO; }
        int child = openat(fd, path.lastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        struct stat opened;
        ok = child >= 0 && fstat(child, &opened) == 0 && SSMatches(item[@"item"], opened) && SSRemoveChildren(child, opened.st_dev);
        if (child >= 0) close(child);
        if (ok) ok = unlinkat(fd, path.lastPathComponent.fileSystemRepresentation, AT_REMOVEDIR) == 0 || errno == ENOENT;
    } else ok = errno == ENOENT;
    close(fd);
    // Parent is never recursively removed, and a substituted parent is rejected.
    if (ok) {
        int ancestor = SSOpenDirectory(parent.stringByDeletingLastPathComponent);
        if (ancestor < 0) return errno == ENOENT;
        int status = fstatat(ancestor, parent.lastPathComponent.fileSystemRepresentation, &p, AT_SYMLINK_NOFOLLOW);
        if (status == 0) {
            if (!SSMatches(item[@"parent"], p)) { errno = ESTALE; ok = NO; }
            else if (unlinkat(ancestor, parent.lastPathComponent.fileSystemRepresentation, AT_REMOVEDIR) != 0 && errno != ENOENT && errno != ENOTEMPTY) ok = NO;
        } else if (errno != ENOENT) ok = NO;
        close(ancestor);
    }
    return ok;
}
BOOL SSCleanupDrain(NSURL *protectedTarget) {
    if (SSReadOnly) { errno = EROFS; return NO; }
    if (SSDirectoryFD < 0) return NO;
    BOOL all = YES;
    for (NSMutableDictionary *record in SSRecords) {
        // Old committed garbage remains collectible after a later successful update.
        // Item identities and the current protected target govern deletion.
        NSMutableArray *pending = record[@"items"];
        for (NSMutableDictionary *item in [pending copy]) {
            BOOL ok = NO;
            for (NSUInteger attempt = 0; attempt < SSRetryCount; attempt++) {
                NSTimeInterval start = NSProcessInfo.processInfo.systemUptime;
                ok = SSRemoveItem(item, protectedTarget); int code = ok ? 0 : errno;
                NSLog(@"[shipit-cleanup] stage=%@ result=%@ attempt=%lu elapsedMs=%.3f errorCode=%d", item[@"stage"], ok ? @"success" : @"error", (unsigned long)attempt + 1, (NSProcessInfo.processInfo.systemUptime - start) * 1000, code);
                if (ok) break;
                if (attempt + 1 < SSRetryCount) usleep(SSRetryDelay);
            }
            if (ok) {
                if (!record[@"previousCapture"] && [item[@"stage"] isEqual:@"cleanup-previous"]) record[@"previousCapture"] = item;
                [pending removeObjectIdenticalTo:item];
                if (!SSSave()) { [pending addObject:item]; all = NO; }
            }
            else all = NO;
        }
    }
    return all;
}
