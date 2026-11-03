#import "cleanup.h"
#import "preparation.h"
#import <objc/runtime.h>
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <pwd.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

// Substitute only Foundation's account directory lookup. All native traversal,
// ownership checks, locks and filesystem operations remain real production code.
static NSURL *Support;
static NSURL *Lookup(id self, SEL selector, NSSearchPathDirectory directory,
                     NSSearchPathDomainMask domain, NSURL *url, BOOL create, NSError **error) {
    (void)self; (void)selector; (void)url; (void)error;
    assert(directory == NSApplicationSupportDirectory && domain == NSUserDomainMask && create);
    return Support;
}
static void Make(NSString *path) {
    assert([NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES
        attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
}
static void Remove(NSString *path) {
    assert([NSFileManager.defaultManager removeItemAtPath:path error:NULL]);
}
static void Check(BOOL (*openOwner)(NSString *, NSError **), void (*closeOwner)(void),
                  NSString *label, NSString *store) {
    NSError *error = nil;
    assert(openOwner(label, &error)); closeOwner();
    assert(openOwner(label, &error)); closeOwner();
    NSString *owner = [Support.path stringByAppendingPathComponent:label];
    NSString *directory = [owner stringByAppendingPathComponent:store];
    NSString *saved = [directory stringByAppendingString:@".saved"];
    assert(rename(directory.fileSystemRepresentation, saved.fileSystemRepresentation) == 0);
    assert(symlink(saved.fileSystemRepresentation, directory.fileSystemRepresentation) == 0);
    int descriptors[2]; assert(pipe(descriptors) == 0);
    int savedStderr = dup(STDERR_FILENO); assert(savedStderr >= 0);
    assert(dup2(descriptors[1], STDERR_FILENO) >= 0); close(descriptors[1]);
    assert(!openOwner(label, &error)); closeOwner();
    assert(dup2(savedStderr, STDERR_FILENO) >= 0); close(savedStderr);
    NSMutableData *diagnostic = [NSMutableData data]; char buffer[4096]; ssize_t count;
    while ((count = read(descriptors[0], buffer, sizeof(buffer))) > 0)
        [diagnostic appendBytes:buffer length:(NSUInteger)count];
    assert(count == 0); close(descriptors[0]);
    NSString *message = [[NSString alloc] initWithData:diagnostic encoding:NSUTF8StringEncoding];
    assert([message containsString:@"operation=openat"]);
    assert([message containsString:[@"component=" stringByAppendingString:store]]);
    assert([message containsString:@"path="] && [message containsString:@"errno="]);
    assert(([message containsString:[NSString stringWithFormat:@"uid=%u euid=%u", getuid(), geteuid()]]));
    fprintf(stderr, "%s", message.UTF8String);
    assert(unlink(directory.fileSystemRepresentation) == 0);
    assert(rename(saved.fileSystemRepresentation, directory.fileSystemRepresentation) == 0);
    assert(chmod(directory.fileSystemRepresentation, 0777) == 0);
    assert(!openOwner(label, &error) && error.code == EPERM); closeOwner();
    assert(chmod(directory.fileSystemRepresentation, 0700) == 0);
    if (geteuid() == 0) {
        struct passwd *other = getpwnam("nobody"); assert(other && other->pw_uid != 0);
        assert(chown(directory.fileSystemRepresentation, other->pw_uid, (gid_t)-1) == 0);
        assert(!openOwner(label, &error) && error.code == EPERM); closeOwner();
        assert(chown(directory.fileSystemRepresentation, 0, (gid_t)-1) == 0);
        NSLog(@"[shipit-path-test] wrong-owner rejected under root PASS");
    }
    for (NSString *name in @[@"lock", @"journal.plist"]) {
        NSString *file = [directory stringByAppendingPathComponent:name];
        if ([NSFileManager.defaultManager fileExistsAtPath:file]) Remove(file);
        NSString *outside = [owner stringByAppendingPathComponent:@"untouched"];
        assert([@"sentinel" writeToFile:outside atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
        assert(symlink(outside.fileSystemRepresentation, file.fileSystemRepresentation) == 0);
        assert(!openOwner(label, &error)); closeOwner();
        assert([[NSString stringWithContentsOfFile:outside encoding:NSUTF8StringEncoding error:NULL] isEqual:@"sentinel"]);
        assert(unlink(file.fileSystemRepresentation) == 0);
        assert(link(outside.fileSystemRepresentation, file.fileSystemRepresentation) == 0);
        assert(!openOwner(label, &error)); closeOwner();
        assert(unlink(file.fileSystemRepresentation) == 0);
        Remove(outside);
    }
    // A substituted label must not be canonicalized along with the trusted base.
    saved = [owner stringByAppendingString:@".saved"];
    assert(rename(owner.fileSystemRepresentation, saved.fileSystemRepresentation) == 0);
    assert(symlink(saved.fileSystemRepresentation, owner.fileSystemRepresentation) == 0);
    assert(!openOwner(label, &error)); closeOwner();
    assert(unlink(owner.fileSystemRepresentation) == 0);
    assert(rename(saved.fileSystemRepresentation, owner.fileSystemRepresentation) == 0);
    assert(openOwner(label, &error)); closeOwner();
    NSLog(@"[shipit-path-test] label=%@ euid=%u reopen directory-mode label-symlink store-symlink lock-symlink lock-hardlink journal-symlink journal-hardlink diagnostics PASS", label, geteuid());
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 2);
        NSString *root = @(argv[1]);
        Make(root);
        char canonical[PATH_MAX]; assert(realpath(root.fileSystemRepresentation, canonical));
        NSString *physical = @(canonical);
        Method method = class_getInstanceMethod(NSFileManager.class,
            @selector(URLForDirectory:inDomain:appropriateForURL:create:error:));
        IMP original = method_setImplementation(method, (IMP)Lookup);
        for (NSString *base in @[physical, root]) {
            Support = [NSURL fileURLWithPath:[base stringByAppendingPathComponent:@"Library/Application Support"]];
            Make(Support.path);
            Check(SSCleanupOpen, SSCleanupClose, @"test.cleanup", @"DeferredCleanup");
            Check(SSPreparationOpen, SSPreparationClose, @"test.preparation", @"CandidatePreparation");
        }
        // realpath failure must remain a failure, never fall back to an alias.
        Support = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"missing"]];
        NSError *error = nil;
        assert(!SSCleanupOpen(@"test.missing", &error) && error.code == ENOENT);
        assert(!SSPreparationOpen(@"test.missing", &error) && error.code == ENOENT);
        assert(!SSCleanupOpen(@"../escape", &error) && error.code == EINVAL);
        assert(!SSPreparationOpen(@"../escape", &error) && error.code == EINVAL);
        method_setImplementation(method, original);
        NSLog(@"[shipit-path-test] ALL PASS euid=%u physical=%@ input=%@", geteuid(), physical, root);
    }
    return 0;
}
