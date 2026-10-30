#import "cleanup.h"
#import "preparation.h"
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <assert.h>
#include <limits.h>
#include <errno.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>

static NSString *RaceParent;
static NSString *RaceSaved;
static struct stat RaceIdentity;
static BOOL RaceInjected;

int unlinkat(int directory, const char *name, int flags) {
    int (*original)(int, const char *, int) = dlsym(RTLD_NEXT, "unlinkat");
    assert(original);
    int result = original(directory, name, flags);
    struct stat identity;
    if (result == 0 && flags == AT_REMOVEDIR && RaceParent && fstat(directory, &identity) == 0 &&
        identity.st_dev == RaceIdentity.st_dev && identity.st_ino == RaceIdentity.st_ino) {
        assert(rename(RaceParent.fileSystemRepresentation, RaceSaved.fileSystemRepresentation) == 0);
        assert(mkdir(RaceParent.fileSystemRepresentation, 0700) == 0);
        RaceParent = nil;
        RaceInjected = YES;
        errno = ENOENT;
    }
    return result;
}

static NSURL *Make(NSString *root, NSString *name) {
    NSURL *url = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:name]];
    assert([NSFileManager.defaultManager createDirectoryAtURL:[url URLByAppendingPathComponent:@"Contents"] withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:nil]);
    assert([@"fixture" writeToURL:[url URLByAppendingPathComponent:@"Contents/data"] atomically:YES encoding:NSUTF8StringEncoding error:nil]);
    return url;
}
static BOOL Exists(NSURL *url) { return [NSFileManager.defaultManager fileExistsAtPath:url.path]; }
static NSMutableDictionary *ReadJournal(NSString *directory) {
    NSData *data = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"journal.plist"]];
    NSMutableDictionary *journal = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListMutableContainers format:NULL error:NULL];
    assert(journal);
    return journal;
}
static void WriteJournal(NSString *directory, NSDictionary *journal) {
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:journal format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
    assert(data && [data writeToFile:[directory stringByAppendingPathComponent:@"journal.plist"] atomically:YES]);
}
static NSURL *SystemAlias(NSURL *url) {
    NSString *path = url.path;
    return [NSURL fileURLWithPath:[path hasPrefix:@"/private/"] ? [path substringFromIndex:@"/private".length] : path];
}
static void CheckSystemAliases(void) {
    char temporary[PATH_MAX], canonical[PATH_MAX], fixture[PATH_MAX];
    size_t length = confstr(_CS_DARWIN_USER_TEMP_DIR, temporary, sizeof(temporary));
    assert(length > 1 && length <= sizeof(temporary) && realpath(temporary, canonical));
    NSString *pattern = [@(canonical) stringByAppendingPathComponent:@"scholarseed-cleanup-XXXXXX"];
    assert([pattern getFileSystemRepresentation:fixture maxLength:sizeof(fixture)] && mkdtemp(fixture));
    NSString *root = @(fixture);
    NSURL *source = Make(root, @"source/App.app"), *stage = Make(root, @"stage/App.app");
    NSURL *previous = Make(root, @"previous/App.app"), *target = Make(root, @"live/App.app");
    NSURL *alias = SystemAlias(source);
    assert(![source.path isEqual:alias.path]);
    assert(realpath(alias.path.fileSystemRepresentation, canonical) && [@(canonical) isEqual:source.path]);
    NSString *journal = [root stringByAppendingPathComponent:@"journal"];
    assert([NSFileManager.defaultManager createDirectoryAtPath:journal withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    NSError *error = nil;
    assert(SSCleanupOpenDirectory(journal, &error));
    assert(SSCleanupCommit(alias, SystemAlias(stage), SystemAlias(previous), SystemAlias(target), SystemAlias(target), &error));
    assert(SSCleanupKnownRequest(source) && SSCleanupKnownRequest(alias));
    assert(SSCleanupCommittedRequest(source, target));
    assert(SSCleanupMarkLaunched(alias, SystemAlias(target)));
    SSCleanupClose();
    NSMutableDictionary *saved = ReadJournal(journal);
    NSMutableDictionary *record = [saved[@"records"] lastObject];
    for (NSString *key in @[@"source", @"previous", @"target", @"originalTarget"]) record[key] = SystemAlias([NSURL fileURLWithPath:record[key]]).path;
    WriteJournal(journal, saved);
    assert(SSCleanupOpenDirectory(journal, &error));
    assert(SSCleanupKnownRequest(source) && !SSCleanupLaunchNeeded(source, target));
    assert(SSCleanupDrain(target));
    assert(!Exists(source) && !Exists(previous));
    assert(SSCleanupKnownRequest(alias) && SSCleanupCommittedRequest(source, target));
    assert(SSCleanupKnowsRollback(previous, target) && SSCleanupReconcilesRollback(SystemAlias(previous), SystemAlias(target)));
    SSCleanupClose();
    assert(SSCleanupOpenDirectory(journal, &error));
    assert(SSCleanupCommittedRequest(alias, SystemAlias(target)) && !SSCleanupLaunchNeeded(source, target));
    assert(SSCleanupReconcilesRollback(previous, target));
    SSCleanupClose();
    NSLog(@"[shipit-cleanup-test] distinct-system-alias legacy-key deleted-parent reopen PASS fixture=%@", root);
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 2 && geteuid() != 0);
        NSString *root = @(argv[1]);
        NSString *journal = [root stringByAppendingPathComponent:@"journal"];
        assert([NSFileManager.defaultManager createDirectoryAtPath:journal withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:nil]);
        CheckSystemAliases();
        NSURL *target = Make(root, @"live/App.app");
        NSURL *source = Make(root, @"source/App.app");
        NSURL *stage = Make(root, @"stage/App.app");
        NSURL *previous = Make(root, @"previous/App.app");
        NSURL *external = Make(root, @"external/Keep.app");
        assert(symlink(external.path.UTF8String, [[source.path stringByAppendingPathComponent:@"Contents/link"] UTF8String]) == 0);
        NSError *error;
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(SSCleanupCommittedRequest(source, target));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(SSCleanupLaunchNeeded(source, target));
        assert(SSCleanupMarkLaunched(source, target));
        SSCleanupClose();
        // Durable reopen represents termination after commit and before owned state clear.
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(!SSCleanupLaunchNeeded(source, target));
        assert(SSCleanupDrain(target));
        assert(!Exists(source) && !Exists(stage) && !Exists(previous));
        assert(Exists(target) && Exists(external));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(SSCleanupKnowsRollback(SystemAlias(previous), SystemAlias(target)));
        assert(SSCleanupReconcilesRollback(SystemAlias(previous), SystemAlias(target)));
        assert(SSCleanupKnownRequest(SystemAlias(source)));
        assert(SSCleanupCommittedRequest(SystemAlias(source), SystemAlias(target)));
        assert(!SSCleanupLaunchNeeded(SystemAlias(source), SystemAlias(target)));
        SSCleanupClose();
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupCommittedRequest(source, target));
        assert(SSCleanupReconcilesRollback(SystemAlias(previous), SystemAlias(target)));
        assert(!SSCleanupLaunchNeeded(source, target));
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] crash-reopen tombstone idempotence symlink-child PASS");

        source = Make(root, @"source2/App.app"); stage = Make(root, @"stage2/App.app"); previous = Make(root, @"previous2/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        NSString *saved = [source.path stringByAppendingString:@".saved"];
        assert(rename(source.path.UTF8String, saved.UTF8String) == 0);
        assert(symlink(external.path.UTF8String, source.path.UTF8String) == 0);
        assert(!SSCleanupDrain(target));
        assert(Exists(external) && Exists(target));
        assert(unlink(source.path.UTF8String) == 0);
        assert(rename(saved.UTF8String, source.path.UTF8String) == 0);
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] substituted-root rejection retry PASS");

        source = Make(root, @"source3/App.app"); stage = Make(root, @"stage3/App.app"); previous = Make(root, @"previous3/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(chmod([source.path stringByAppendingPathComponent:@"Contents"].UTF8String, 0500) == 0);
        assert(!SSCleanupDrain(target));
        SSCleanupClose();
        assert(chmod([source.path stringByAppendingPathComponent:@"Contents"].UTF8String, 0700) == 0);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] real-EACCES persistence recovery PASS");

        source = Make(root, @"source4/App.app"); stage = Make(root, @"stage4/App.app"); previous = Make(root, @"previous4/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(!SSCleanupDrain(previous));
        assert(Exists(previous));
        assert(SSCleanupDrain(target));
        assert(!SSCleanupCommit(target, stage, previous, target, target, &error));
        NSLog(@"[shipit-cleanup-test] active-target overlap refusal PASS");
        SSCleanupClose();

        source = Make(root, @"source5/App.app"); stage = Make(root, @"stage5/App.app"); previous = Make(root, @"previous5/App.app");
        pid_t child = fork(); assert(child >= 0);
        if (child == 0) {
            assert(SSCleanupOpenDirectory(journal, &error));
            assert(SSCleanupCommit(source, stage, previous, target, target, &error));
            _exit(0); // no cleanup/close/finally: process dies just after durable commit
        }
        int status; assert(waitpid(child, &status, 0) == child && WEXITSTATUS(status) == 0);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupReconcilesRollback(previous, target));
        child = fork(); assert(child >= 0);
        if (child == 0) { assert(!SSCleanupOpenDirectory(journal, &error)); _exit(0); }
        assert(waitpid(child, &status, 0) == child && WEXITSTATUS(status) == 0);
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] abrupt-process-exit lock-exclusion PASS");

        source = Make(root, @"source6/App.app"); stage = Make(root, @"stage6/App.app"); previous = Make(root, @"previous6/App.app");
        NSURL *renamed = Make(root, @"renamed/New.app");
        assert(SSCleanupCommit(source, stage, previous, renamed, target, &error));
        assert([SSCleanupRecoveredTarget(source, target).path isEqual:renamed.path]);
        assert(SSCleanupDrain(renamed));
        NSLog(@"[shipit-cleanup-test] renamed-target recovery PASS");

        source = Make(root, @"source7/App.app"); stage = Make(root, @"stage7/App.app"); previous = Make(root, @"previous7/App.app");
        assert(chmod(journal.UTF8String, 0500) == 0);
        assert(!SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(Exists(source) && Exists(previous) && Exists(target));
        assert(chmod(journal.UTF8String, 0700) == 0);
        assert(!SSCleanupKnownRequest(source));
        NSLog(@"[shipit-cleanup-test] commit-write-failure preserves-rollback PASS");
        NSString *alias = [root stringByAppendingPathComponent:@"alias"];
        assert(symlink(root.UTF8String, alias.UTF8String) == 0);
        source = Make(alias, @"source8/App.app"); stage = Make(alias, @"stage8/App.app"); previous = Make(alias, @"previous8/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        char physicalSource[PATH_MAX]; assert(realpath(source.path.fileSystemRepresentation, physicalSource));
        assert(!SSCleanupKnownRequest([NSURL fileURLWithPath:@(physicalSource)]));
        NSURL *protectedAlias = [NSURL fileURLWithPath:[alias stringByAppendingPathComponent:@"previous8/App.app"]];
        assert(!SSCleanupDrain(protectedAlias));
        assert(Exists(previous));
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] canonical-parent protected-alias PASS");
        source = Make(root, @"source9/App.app"); stage = Make(root, @"stage9/App.app"); previous = Make(root, @"previous9/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        NSString *contents = [target.path stringByAppendingPathComponent:@"Contents"];
        assert(rename(contents.UTF8String, [contents stringByAppendingString:@".retired"].UTF8String) == 0);
        Make(root, @"live/App.app");
        assert(!SSCleanupCommittedRequest(source, target));
        assert(SSCleanupKnownRequest(source));
        assert(SSCleanupKnowsRollback(previous, target));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] later-target-change retires-committed-rollback PASS");

        source = Make(root, @"identity/source/App.app"); stage = Make(root, @"identity/stage/App.app"); previous = Make(root, @"identity/previous/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        NSString *previousParent = previous.path.stringByDeletingLastPathComponent;
        NSString *savedParent = [previousParent stringByAppendingString:@".saved"];
        assert(rename(previousParent.fileSystemRepresentation, savedParent.fileSystemRepresentation) == 0);
        assert([NSFileManager.defaultManager createDirectoryAtPath:previousParent withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
        errno = ENOENT;
        assert(!SSCleanupReconcilesRollback(previous, target));
        assert(!SSCleanupDrain(target));
        assert([NSFileManager.defaultManager removeItemAtPath:previousParent error:NULL]);
        assert(symlink(savedParent.fileSystemRepresentation, previousParent.fileSystemRepresentation) == 0);
        assert(!SSCleanupReconcilesRollback(previous, target));
        assert(!SSCleanupDrain(target));
        assert(unlink(previousParent.fileSystemRepresentation) == 0);
        assert([@"not a directory" writeToFile:previousParent atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
        assert(!SSCleanupReconcilesRollback(previous, target));
        assert(unlink(previousParent.fileSystemRepresentation) == 0);
        assert(rename(savedParent.fileSystemRepresentation, previousParent.fileSystemRepresentation) == 0);
        assert(chmod(previousParent.fileSystemRepresentation, 0000) == 0);
        assert(!SSCleanupReconcilesRollback(previous, target));
        assert(chmod(previousParent.fileSystemRepresentation, 0700) == 0);
        NSString *savedPrevious = [previous.path stringByAppendingString:@".saved"];
        assert(rename(previous.path.fileSystemRepresentation, savedPrevious.fileSystemRepresentation) == 0);
        Make(root, @"identity/previous/App.app");
        assert(!SSCleanupReconcilesRollback(previous, target));
        assert([NSFileManager.defaultManager removeItemAtURL:previous error:NULL]);
        assert(rename(savedPrevious.fileSystemRepresentation, previous.path.fileSystemRepresentation) == 0);
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] replaced-parent leaf symlink file EACCES fail-closed recovery PASS");

        source = Make(root, @"race/source/App.app"); stage = Make(root, @"race/stage/App.app"); previous = Make(root, @"race/previous/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        NSString *racePath = source.path.stringByDeletingLastPathComponent;
        RaceSaved = [racePath stringByAppendingString:@".saved"];
        assert(stat(racePath.fileSystemRepresentation, &RaceIdentity) == 0);
        RaceParent = racePath;
        assert(!SSCleanupDrain(target));
        assert(RaceInjected && [NSFileManager.defaultManager fileExistsAtPath:racePath]);
        assert([[ReadJournal(journal)[@"records"] lastObject][@"items"] count] == 1);
        SSCleanupClose();
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(!SSCleanupDrain(target));
        assert(rmdir(racePath.fileSystemRepresentation) == 0);
        assert(rename(RaceSaved.fileSystemRepresentation, racePath.fileSystemRepresentation) == 0);
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] post-unlink parent-substitution stale-ENOENT persistence recovery PASS");

        source = Make(root, @"save/source/App.app"); stage = Make(root, @"save/stage/App.app"); previous = Make(root, @"save/previous/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(chmod(journal.fileSystemRepresentation, 0500) == 0);
        assert(!SSCleanupDrain(target));
        assert(!Exists(source) && !Exists(previous));
        SSCleanupClose();
        assert(chmod(journal.fileSystemRepresentation, 0700) == 0);
        assert([[[ReadJournal(journal)[@"records"] lastObject] objectForKey:@"items"] count] == 3);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(SSCleanupDrain(target));
        NSLog(@"[shipit-cleanup-test] drain-save-failure durable-retry missing-parent PASS");

        source = Make(root, @"legacy/source/App.app"); stage = Make(root, @"legacy/stage/App.app"); previous = Make(root, @"legacy/previous/App.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        SSCleanupClose();
        NSMutableDictionary *legacy = ReadJournal(journal);
        NSMutableDictionary *record = [legacy[@"records"] lastObject];
        [record removeObjectForKey:@"previousCapture"];
        for (NSString *key in @[@"source", @"previous", @"target", @"originalTarget"]) record[key] = SystemAlias([NSURL fileURLWithPath:record[key]]).path;
        WriteJournal(journal, legacy);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupKnownRequest(source) && SSCleanupCommittedRequest(source, target));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(SSCleanupMarkLaunched(SystemAlias(source), SystemAlias(target)));
        assert(!SSCleanupLaunchNeeded(source, target));
        assert(SSCleanupDrain(target));
        SSCleanupClose();
        assert([ReadJournal(journal)[@"records"] lastObject][@"previousCapture"]);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupCommittedRequest(source, target) && !SSCleanupLaunchNeeded(source, target));
        assert(SSCleanupReconcilesRollback(previous, target));
        SSCleanupClose();
        legacy = ReadJournal(journal); record = [legacy[@"records"] lastObject];
        [record removeObjectForKey:@"previousCapture"];
        WriteJournal(journal, legacy);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert([NSFileManager.defaultManager createDirectoryAtPath:previous.path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
        assert(SSCleanupReconcilesRollback(previous, target));
        Make(root, @"legacy/previous/App.app");
        assert(!SSCleanupReconcilesRollback(previous, target));
        SSCleanupClose();
        NSLog(@"[shipit-cleanup-test] legacy-key pending-capture durable-retention completed-unknown-parent PASS");

        assert(SSCleanupOpenDirectory(journal, &error));
        source = Make(root, @"shared/source/App.app"); stage = Make(root, @"shared/stage/App.app"); previous = Make(root, @"live/Previous.app");
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(SSCleanupDrain(target));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(Exists(target));
        SSCleanupClose();
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupReconcilesRollback(previous, target));
        SSCleanupClose();
        legacy = ReadJournal(journal); record = [legacy[@"records"] lastObject];
        [record removeObjectForKey:@"previousCapture"];
        WriteJournal(journal, legacy);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(SSCleanupReconcilesRollback(previous, target));
        assert(!SSCleanupKnownRequest([NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"shared/source2/App.app"]]));
        NSLog(@"[shipit-cleanup-test] retained-parent tombstone reopen component-boundary PASS");
        SSCleanupClose();
        NSString *journalFile = [journal stringByAppendingPathComponent:@"journal.plist"];
        NSData *savedJournal = [NSData dataWithContentsOfFile:journalFile];
        for (NSString *invalidPath in @[@"relative/App.app", [root stringByAppendingString:@"/../escape/App.app"], [root stringByAppendingString:@"/bad\0path"]]) {
            NSMutableDictionary *invalid = ReadJournal(journal);
            [[invalid[@"records"] lastObject] setObject:invalidPath forKey:@"source"];
            WriteJournal(journal, invalid);
            NSData *unchanged = [NSData dataWithContentsOfFile:journalFile];
            assert(!SSCleanupOpenDirectory(journal, &error));
            assert([[NSData dataWithContentsOfFile:journalFile] isEqual:unchanged]);
            assert([savedJournal writeToFile:journalFile atomically:YES]);
        }
        NSMutableDictionary *invalid = ReadJournal(journal);
        [[invalid[@"records"] lastObject] setObject:@{} forKey:@"previousCapture"];
        WriteJournal(journal, invalid);
        assert(!SSCleanupOpenDirectory(journal, &error));
        assert([savedJournal writeToFile:journalFile atomically:YES]);
        NSLog(@"[shipit-cleanup-test] invalid-query-key retained-capture journal fail-closed PASS");
        NSData *corrupt = [@"not a plist" dataUsingEncoding:NSUTF8StringEncoding];
        assert([corrupt writeToFile:journalFile atomically:YES]);
        assert(!SSCleanupOpenDirectory(journal, &error));
        assert([[NSData dataWithContentsOfFile:journalFile] isEqual:corrupt]);
        NSData *oversized = [NSMutableData dataWithLength:1024 * 1024 + 1];
        assert([oversized writeToFile:journalFile atomically:YES]);
        assert(!SSCleanupOpenDirectory(journal, &error));
        assert([[NSData dataWithContentsOfFile:journalFile] isEqual:oversized]);
        assert([savedJournal writeToFile:journalFile atomically:YES]);
        assert(SSCleanupOpenDirectory(journal, &error));
        assert(Exists(target));
        NSLog(@"[shipit-cleanup-test] corrupt-oversized journal fail-closed PASS");
        SSCleanupClose();
        NSString *preparationStore = [root stringByAppendingPathComponent:@"preparation"];
        assert([NSFileManager.defaultManager createDirectoryAtPath:preparationStore withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:nil]);
        assert(SSPreparationOpenDirectory(preparationStore, &error));
        assert(SSCleanupOpenDirectory(journal, &error));
        source = Make(root, @"consecutive/source/App.app"); target = Make(root, @"consecutive/live/App.app");
        stage = SSPreparationCopy(source, target, nil, &error); assert(stage);
        previous = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"consecutive/live/Previous.app"]];
        assert(rename(target.path.UTF8String, previous.path.UTF8String) == 0);
        assert(rename(stage.path.UTF8String, target.path.UTF8String) == 0);
        assert(SSCleanupCommit(source, stage, previous, target, target, &error));
        assert(SSPreparationRetire(source, target, &error));
        SSPreparationClose();
        assert(SSCleanupMarkLaunched(source, target));
        assert(SSCleanupDrain(target));
        assert(Exists(target) && !Exists(source) && !Exists(previous));
        assert(SSPreparationOpenDirectory(preparationStore, &error));
        source = Make(root, @"consecutive/next/App.app");
        stage = SSPreparationCopy(source, target, nil, &error); assert(stage);
        assert(Exists(target) && Exists(source) && Exists(stage));
        assert([NSFileManager.defaultManager removeItemAtPath:stage.path.stringByDeletingLastPathComponent error:nil]);
        SSPreparationClose(); SSCleanupClose();
        NSLog(@"[shipit-cleanup-test] committed-preparation retirement cleanup reopen next-update PASS");
        NSLog(@"[shipit-cleanup-test] ALL PASS");
    }
    return 0;
}
