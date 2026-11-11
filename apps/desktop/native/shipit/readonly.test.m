#import "cleanup.h"
#import "preparation.h"
#import "readiness.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static NSFileManager *Manager;
static NSUInteger Passed;
static NSUInteger PreferenceWrites;

#if !defined(CFPreferencesSetValue) || !defined(CFPreferencesSynchronize)
#error readonly preference contracts require compile-time preference stubs
#endif

void SSReadOnlyPreferenceSet(CFStringRef key, CFPropertyListRef value, CFStringRef application, CFStringRef user, CFStringRef host) {
    (void)key; (void)value; (void)application; (void)user; (void)host;
    PreferenceWrites++;
}

Boolean SSReadOnlyPreferenceSync(CFStringRef application, CFStringRef user, CFStringRef host) {
    (void)application; (void)user; (void)host;
    PreferenceWrites++;
    return false;
}

static void Check(BOOL value, NSString *name) {
    if (!value) NSLog(@"FAIL %@", name);
    assert(value);
    Passed++;
}

static NSString *Directory(NSString *path) {
    assert([Manager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    return path;
}

static NSURL *Bundle(NSString *path) {
    Directory([path stringByAppendingPathComponent:@"Contents"]);
    return [NSURL fileURLWithPath:path];
}

static NSDictionary *Read(NSString *path) {
    return [NSPropertyListSerialization propertyListWithData:[NSData dataWithContentsOfFile:path] options:NSPropertyListMutableContainers format:NULL error:NULL];
}

static void Write(NSString *path, NSDictionary *record) {
    NSData *bytes = [NSPropertyListSerialization dataWithPropertyList:record format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
    assert([bytes writeToFile:path atomically:NO]);
    assert(chmod(path.fileSystemRepresentation, 0600) == 0);
}

static void Maintenance(NSString *root, NSURL *source, NSURL *target) {
    NSString *directory = Directory([root stringByAppendingPathComponent:@"maintenance"]);
    NSString *lock = [directory stringByAppendingPathComponent:@"lock"];
    NSError *error = nil;
    Check(!SSCleanupOpenMaintenanceDirectory(directory, &error) && error.code == ENOENT, @"maintenance requires an existing cleanup lock");
    Check(![Manager fileExistsAtPath:lock], @"maintenance never creates a missing cleanup lock");
    error = nil;
    Check(SSCleanupOpenDirectory(directory, &error) && !error, @"absent journal open succeeds without an NSError");
    NSDictionary *first = SSCleanupMaintenanceSnapshot(&error);
    Check(first && [first[@"journal"][@"state"] isEqual:@"absent"] && !error, @"writable cleanup snapshot represents absent journal without an NSError");
    Check([first isEqual:SSCleanupMaintenanceSnapshot(&error)] && !error, @"consecutive absent cleanup snapshots match");
    Check(!SSCleanupReadOnlySnapshot(&error) && error.code == EBADF, @"writable cleanup cannot use readonly snapshot API");
    SSCleanupClose();
    assert(chmod(lock.fileSystemRepresentation, 0644) == 0);
    for (NSUInteger mode = 0; mode < 3; mode++) {
        error = nil;
        BOOL opened;
        if (mode == 0) opened = SSCleanupOpenDirectory(directory, &error);
        else if (mode == 1) opened = SSCleanupOpenExistingDirectory(directory, &error);
        else opened = SSCleanupOpenMaintenanceDirectory(directory, &error);
        Check(!opened && error.code == EPERM, @"all cleanup sessions refuse an existing nonprivate lock");
    }
    assert(chmod(lock.fileSystemRepresentation, 0600) == 0);
    error = nil;
    Check(SSCleanupOpenMaintenanceDirectory(directory, &error) && !error, @"maintenance opens an existing private lock");
    first = SSCleanupMaintenanceSnapshot(&error);
    Check(first && [first isEqual:SSCleanupMaintenanceSnapshot(&error)] && !error, @"maintenance freezes the absent cleanup baseline");
    Check(!SSCleanupReadOnlySnapshot(&error) && error.code == EBADF, @"maintenance and ordinary readonly APIs remain distinct");
    error = nil;
    Check(!SSCleanupCommit(source, source, source, target, target, &error) && error.code == EROFS, @"maintenance cannot commit cleanup");
    errno = 0;
    Check(!SSCleanupDrain(target) && errno == EROFS, @"maintenance cannot delete bundles");
    errno = 0;
    Check(!SSCleanupMarkLaunched(source, target) && errno == EROFS, @"maintenance cannot record a launch");
    NSUInteger before = PreferenceWrites;
    errno = 0;
    Check(!SSCleanupClearRollback(@"com.fixture.maintenance", @"rollback") && errno == EROFS && PreferenceWrites == before, @"maintenance cannot alter rollback preferences");
    NSString *journal = [directory stringByAppendingPathComponent:@"journal.plist"];
    Check(![Manager fileExistsAtPath:journal], @"refused maintenance mutations create no journal");
    Write(journal, @{@"schema":@"1", @"records":@[]});
    error = nil;
    Check(!SSCleanupMaintenanceSnapshot(&error) && error.code == ESTALE, @"maintenance detects cleanup journal changes after opening");
    SSCleanupClose();
    assert(SSCleanupOpenExistingDirectory(directory, NULL));
    error = nil;
    Check(!SSCleanupMaintenanceSnapshot(&error) && error.code == EBADF, @"ordinary readonly session cannot use maintenance snapshot API");
    SSCleanupClose();
}

static NSDictionary *Observe(NSString *cleanup, NSString *preparation, NSURL *source, NSURL *target, NSDictionary *binding, NSString *state) {
    SSPreparationClose();
    SSCleanupClose();
    if (!SSCleanupOpenExistingDirectory(cleanup, NULL) || !SSPreparationOpenExistingDirectory(preparation, NULL)) return nil;
    return SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return SSPreparationActivityAbsent; }, NULL);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 2 && geteuid() != 0);
        NSUInteger initialPreferences = PreferenceWrites;
        CFPreferencesSetValue(CFSTR("canary"), NULL, CFSTR("com.fixture.readonly"), kCFPreferencesCurrentUser, kCFPreferencesCurrentHost);
        assert(PreferenceWrites == initialPreferences + 1);
        Manager = NSFileManager.defaultManager;
        NSString *root = Directory(@(argv[1]));
        NSString *cleanup = Directory([root stringByAppendingPathComponent:@"cleanup"]);
        NSString *preparation = Directory([root stringByAppendingPathComponent:@"preparation"]);
        NSURL *source = Bundle([root stringByAppendingPathComponent:@"update/source.app"]);
        NSURL *target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        Maintenance(root, source, target);
        NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0], @"candidate":@"candidate", @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@100};
        Check(!SSCleanupOpenExistingDirectory(cleanup, NULL), @"missing cleanup lock refuses");
        Check(![Manager fileExistsAtPath:[cleanup stringByAppendingPathComponent:@"lock"]], @"inspection never creates cleanup lock");
        Check(!SSPreparationOpenExistingDirectory(preparation, NULL), @"missing preparation lock refuses");
        Check(![Manager fileExistsAtPath:[preparation stringByAppendingPathComponent:@"lock"]], @"inspection never creates preparation lock");
        assert(SSCleanupOpenDirectory(cleanup, NULL));
        SSCleanupClose();
        assert(SSPreparationOpenDirectory(preparation, NULL));
        assert(SSPreparationCopy(source, target, binding, NULL));
        assert(SSPreparationRecordFailure(source, target, binding, ETIMEDOUT, NULL));
        assert(SSPreparationFinishFailure(source, target, binding, NO, nil, nil, NULL));
        SSPreparationClose();
        NSString *state = [root stringByAppendingPathComponent:@"state.json"];
        NSDictionary *request = @{@"binding":binding, @"updateBundleURL":source.absoluteString, @"targetBundleURL":target.absoluteString, @"bundleIdentifier":@"com.fixture.desktop", @"useUpdateBundleName":@YES, @"installationAuthorized":@NO, @"launchAfterInstallation":@YES};
        assert([[NSJSONSerialization dataWithJSONObject:request options:0 error:NULL] writeToFile:state atomically:NO]);
        assert(chmod(state.fileSystemRepresentation, 0600) == 0);
        NSString *journal = [preparation stringByAppendingPathComponent:@"journal.plist"];
        NSString *ack = [source.path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".scholarseed-prepare.plist"];
        NSData *journalBefore = [NSData dataWithContentsOfFile:journal];
        NSData *ackBefore = [NSData dataWithContentsOfFile:ack];
        NSData *stateBefore = [NSData dataWithContentsOfFile:state];
        NSArray *cleanupBefore = [Manager contentsOfDirectoryAtPath:cleanup error:NULL];
        NSArray *preparationBefore = [Manager contentsOfDirectoryAtPath:preparation error:NULL];
        assert(SSCleanupOpenExistingDirectory(cleanup, NULL));
        assert(SSPreparationOpenExistingDirectory(preparation, NULL));
        NSDictionary *snapshot = SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return SSPreparationActivityAbsent; }, NULL);
        Check(snapshot != nil, @"exact terminal failure is observed");
        Check([snapshot[@"binding"] isEqual:binding] && [snapshot[@"code"] isEqual:@ETIMEDOUT], @"observation preserves exact binding and code");
        Check([snapshot[@"journal"][@"sha256"] length] == 64 && [snapshot[@"ack"][@"sha256"] length] == 64 && [snapshot[@"state"][@"sha256"] length] == 64, @"observation binds all original bytes");
        Check([snapshot[@"source"][@"contents"] isKindOfClass:NSDictionary.class] && [snapshot[@"target"][@"contents"] isKindOfClass:NSDictionary.class], @"observation retains full native captures");
        Check(!snapshot[@"authority"] && !snapshot[@"granted"] && !snapshot[@"apply"], @"observation does not grant recovery authority");
        Check(!SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return SSPreparationActivityUnknown; }, NULL), @"unknown process evidence refuses");
        Check(!SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return SSPreparationActivityActive; }, NULL), @"active process evidence refuses");
        NSMutableDictionary *wrong = [binding mutableCopy]; wrong[@"candidate"] = @"other";
        Check(!SSPreparationFailureSnapshot(source, target, wrong, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return SSPreparationActivityAbsent; }, NULL), @"binding mismatch refuses");
        __block NSUInteger observations = 0;
        Check(!SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return ++observations == 1 ? SSPreparationActivityAbsent : SSPreparationActivityUnknown; }, NULL), @"process evidence is repeated before returning");
        Check(!SSPreparationCopy(source, target, binding, NULL), @"readonly mode cannot prepare");
        NSError *writeError = nil;
        Check(!SSPreparationBeginOwnership(source, target, binding, nil, &writeError) && writeError.code == EROFS, @"readonly mode cannot record ownership intent");
        writeError = nil;
        Check(!SSPreparationAcceptOwnership(source, target, binding, nil, &writeError) && writeError.code == EROFS, @"readonly mode cannot accept ownership");
        writeError = nil;
        Check(!SSPreparationRecordFailure(source, target, binding, ETIMEDOUT, &writeError) && writeError.code == EROFS, @"readonly mode cannot rewrite failure");
        writeError = nil;
        Check(!SSPreparationFinishFailure(source, target, binding, YES, nil, nil, &writeError) && writeError.code == EROFS, @"readonly mode cannot publish or launch");
        Check(!SSPreparationRetire(source, target, NULL), @"readonly mode cannot retire");
        Check(SSPreparationRecoverFailure(source, target, binding, NULL, NULL) == SSPreparationFailureInvalid, @"readonly mode cannot perform recovery");
        Check(!SSCleanupDrain(target), @"readonly mode cannot collect bundles");
        writeError = nil;
        Check(!SSCleanupCommit(source, source, source, target, target, &writeError) && writeError.code == EROFS, @"readonly mode cannot commit cleanup");
        errno = 0;
        Check(!SSCleanupMarkLaunched(source, target) && errno == EROFS, @"readonly mode cannot mark a launch");
        errno = 0;
        NSUInteger preferencesBefore = PreferenceWrites;
        Check(!SSCleanupClearRollback(@"com.fixture.readonly", @"rollback") && errno == EROFS && PreferenceWrites == preferencesBefore, @"readonly mode cannot write preferences");
        Check([[NSData dataWithContentsOfFile:journal] isEqual:journalBefore] && [[NSData dataWithContentsOfFile:ack] isEqual:ackBefore] && [[NSData dataWithContentsOfFile:state] isEqual:stateBefore], @"observation and refused mutation leave records byte-identical");
        Check([[Manager contentsOfDirectoryAtPath:cleanup error:NULL] isEqual:cleanupBefore] && [[Manager contentsOfDirectoryAtPath:preparation error:NULL] isEqual:preparationBefore], @"observation creates no journal or temporary leaf");
        SSPreparationClose(); SSCleanupClose();
        assert(chmod([preparation stringByAppendingPathComponent:@"lock"].fileSystemRepresentation, 0644) == 0);
        assert(SSCleanupOpenExistingDirectory(cleanup, NULL));
        Check(!SSPreparationOpenExistingDirectory(preparation, NULL), @"nonprivate lock refuses");
        assert(chmod([preparation stringByAppendingPathComponent:@"lock"].fileSystemRepresentation, 0600) == 0);
        NSMutableDictionary *record = [Read(journal) mutableCopy];
        record[@"record"][@"ownership"] = @YES;
        Write(journal, record);
        assert(SSCleanupOpenExistingDirectory(cleanup, NULL));
        Check(!SSPreparationOpenExistingDirectory(preparation, NULL), @"published failure with ownership intent refuses at open");
        [record[@"record"] removeObjectForKey:@"terminalVersion"];
        [record[@"record"][@"failure"] removeObjectForKey:@"publication"];
        Write(journal, record);
        assert(SSPreparationOpenExistingDirectory(preparation, NULL));
        Check(!SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity { return SSPreparationActivityAbsent; }, NULL), @"ownership intent refuses");
        SSPreparationClose(); SSCleanupClose();
        assert([journalBefore writeToFile:journal atomically:NO]);
        for (NSDictionary *change in @[@{@"ready":@YES}, @{@"ready":@0}, @{@"code":@YES}, @{@"code":@61}, @{@"schema":@YES}]) {
            NSMutableDictionary *changedAck = [Read(ack) mutableCopy];
            [changedAck addEntriesFromDictionary:change];
            Write(ack, changedAck);
            Check(!Observe(cleanup, preparation, source, target, binding, state), @"nonterminal or inexact typed acknowledgement refuses");
            assert([ackBefore writeToFile:ack atomically:NO]);
        }
        for (NSString *field in @[@"binding", @"installationAuthorized", @"targetBundleURL"]) {
            NSMutableDictionary *changedState = [request mutableCopy];
            changedState[field] = [field isEqual:@"binding"] ? wrong : [field isEqual:@"installationAuthorized"] ? @1 : @"file:///unknown.app";
            assert([[NSJSONSerialization dataWithJSONObject:changedState options:0 error:NULL] writeToFile:state atomically:NO]);
            Check(!Observe(cleanup, preparation, source, target, binding, state), @"native request mismatch refuses");
            assert([stateBefore writeToFile:state atomically:NO]);
        }
        NSMutableDictionary *numericSchema = [Read(journal) mutableCopy]; numericSchema[@"schema"] = @1;
        Write(journal, numericSchema);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"native journal string schema is not interchangeable with numeric schema");
        assert([journalBefore writeToFile:journal atomically:NO]);
        NSMutableDictionary *changedIdentity = [Read(journal) mutableCopy]; changedIdentity[@"record"][@"source"][@"contents"][@"uid"] = @(geteuid() + 1);
        Write(journal, changedIdentity);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"source Contents owner mismatch refuses");
        assert([journalBefore writeToFile:journal atomically:NO]);
        Check(Observe(cleanup, preparation, source, target, binding, state) != nil, @"restored fixture can be inspected again");
        pid_t child = fork(); assert(child >= 0);
        if (child == 0) {
            SSPreparationClose(); SSCleanupClose();
            _exit(SSCleanupOpenExistingDirectory(cleanup, NULL) ? EXIT_FAILURE : EXIT_SUCCESS);
        }
        int status = 0; assert(waitpid(child, &status, 0) == child);
        Check(WIFEXITED(status) && WEXITSTATUS(status) == EXIT_SUCCESS, @"held native lock refuses another process");
        SSPreparationClose(); SSCleanupClose();
        NSString *linked = [root stringByAppendingPathComponent:@"journal.link"];
        assert(link(journal.fileSystemRepresentation, linked.fileSystemRepresentation) == 0);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"journal hardlink refuses");
        assert(unlink(linked.fileSystemRepresentation) == 0);
        assert(chmod(journal.fileSystemRepresentation, 0666) == 0);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"writable journal refuses");
        assert(chmod(journal.fileSystemRepresentation, 0600) == 0);
        SSPreparationClose(); SSCleanupClose();
        NSString *lock = [preparation stringByAppendingPathComponent:@"lock"], *savedLock = [preparation stringByAppendingPathComponent:@"saved-lock"];
        assert(rename(lock.fileSystemRepresentation, savedLock.fileSystemRepresentation) == 0);
        assert(symlink(savedLock.fileSystemRepresentation, lock.fileSystemRepresentation) == 0);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"symlink lock refuses");
        assert(unlink(lock.fileSystemRepresentation) == 0);
        assert(mkfifo(lock.fileSystemRepresentation, 0600) == 0);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"FIFO preparation lock refuses without blocking");
        assert(unlink(lock.fileSystemRepresentation) == 0);
        assert(rename(savedLock.fileSystemRepresentation, lock.fileSystemRepresentation) == 0);
        SSPreparationClose(); SSCleanupClose();
        NSString *cleanupLock = [cleanup stringByAppendingPathComponent:@"lock"], *savedCleanupLock = [cleanup stringByAppendingPathComponent:@"saved-lock"];
        assert(rename(cleanupLock.fileSystemRepresentation, savedCleanupLock.fileSystemRepresentation) == 0);
        assert(mkfifo(cleanupLock.fileSystemRepresentation, 0600) == 0);
        Check(!SSCleanupOpenExistingDirectory(cleanup, NULL), @"FIFO cleanup lock refuses without blocking");
        assert(unlink(cleanupLock.fileSystemRepresentation) == 0);
        assert(rename(savedCleanupLock.fileSystemRepresentation, cleanupLock.fileSystemRepresentation) == 0);
        NSString *savedTarget = [target.path stringByAppendingString:@".held"];
        assert(rename(target.path.fileSystemRepresentation, savedTarget.fileSystemRepresentation) == 0);
        Bundle(target.path);
        Check(!Observe(cleanup, preparation, source, target, binding, state), @"same-path substituted target refuses");
        assert([Manager removeItemAtURL:target error:NULL]);
        assert(rename(savedTarget.fileSystemRepresentation, target.path.fileSystemRepresentation) == 0);
        Check(Observe(cleanup, preparation, source, target, binding, state) != nil, @"matching target identity remains observable");
        __block NSUInteger rounds = 0;
        Check(!SSPreparationFailureSnapshot(source, target, binding, [NSURL fileURLWithPath:state], ^SSPreparationActivity {
            if (++rounds == 2) {
                NSMutableData *changed = [stateBefore mutableCopy]; [changed appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
                assert([changed writeToFile:state atomically:NO]);
            }
            return SSPreparationActivityAbsent;
        }, NULL), @"changed original request bytes invalidate the observation");
        assert([stateBefore writeToFile:state atomically:NO]);
        Check(Observe(cleanup, preparation, source, target, binding, state) != nil, @"a fresh observation can follow a rejected stale observation");
        SSPreparationClose(); SSCleanupClose();
        Check([[NSData dataWithContentsOfFile:journal] isEqual:journalBefore] && [[NSData dataWithContentsOfFile:ack] isEqual:ackBefore] && [[NSData dataWithContentsOfFile:state] isEqual:stateBefore], @"negative inspection never rewrites fixture evidence");
        NSLog(@"readonly contracts passed=%lu", (unsigned long)Passed);
    }
    return 0;
}
