#import "preparation.h"
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <assert.h>

static NSFileManager *Manager;
static NSUInteger Passed;
static NSString *Root, *CurrentStore;
static NSMutableSet<NSString *> *OwnedParents;
static NSString *Directory(NSString *path) {
    assert([Manager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    return path;
}
static NSURL *Bundle(NSString *path) {
    Directory([path stringByAppendingPathComponent:@"Contents"]);
    assert([@"fixture" writeToFile:[path stringByAppendingPathComponent:@"Contents/data"] atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
    return [NSURL fileURLWithPath:path];
}
static NSString *Case(NSString *name) {
    SSPreparationClose();
    return Directory([Root stringByAppendingPathComponent:name]);
}
static NSString *Store(NSString *root) {
    NSString *store = Directory([root stringByAppendingPathComponent:@"store"]);
    assert(SSPreparationOpenDirectory(store, NULL));
    CurrentStore = store;
    return store;
}
static NSMutableDictionary *Journal(NSString *store) {
    NSData *data = [NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]];
    assert(data);
    NSMutableDictionary *journal = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListMutableContainers format:NULL error:NULL];
    assert(journal); return journal;
}
static NSURL *Prepare(NSURL *source, NSURL *target, NSError **error) {
    NSURL *result = SSPreparationCopy(source, target, nil, error);
    NSString *journalPath = [CurrentStore stringByAppendingPathComponent:@"journal.plist"];
    if ([Manager fileExistsAtPath:journalPath]) {
        NSString *owned = Journal(CurrentStore)[@"record"][@"directory"][@"path"];
        if (owned) [OwnedParents addObject:owned];
    }
    return result;
}
static void Check(BOOL value, NSString *label) {
    if (!value) NSLog(@"FAIL %@", label);
    assert(value); Passed++; NSLog(@"PASS %@", label);
}
static BOOL Exists(NSURL *url) { return [Manager fileExistsAtPath:url.path]; }
static void Rewrite(NSString *store, NSDictionary *journal) {
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:journal format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
    NSString *path = [store stringByAppendingPathComponent:@"journal.plist"];
    assert([data writeToFile:path atomically:YES]); assert(chmod(path.fileSystemRepresentation, 0600) == 0);
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 2 && geteuid() != 0); Manager = NSFileManager.defaultManager;
        Root = @(argv[1]); Directory(Root); OwnedParents = [NSMutableSet set];
        NSString *root = Case(@"success"), *store = Store(root);
        NSURL *source = Bundle([root stringByAppendingPathComponent:@"source.app"]);
        NSURL *target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        NSURL *candidate = Prepare(source, target, NULL);
        Check(candidate && Exists(source) && Exists(target) && Exists(candidate), @"copy preserves source and installed app");
        Check(![candidate.path isEqual:source.path] && ![candidate.path isEqual:target.path], @"candidate is independent");
        Check([candidate.lastPathComponent isEqual:source.lastPathComponent], @"candidate preserves bundle name for useUpdateBundleName");
        Check([Journal(store)[@"record"][@"attempts"] isEqual:@1], @"attempt charged before ready");
        SSPreparationClose(); Check(SSPreparationOpenDirectory(store, NULL), @"open durable ready record");
        Check([Prepare(source, target, NULL) isEqual:candidate], @"restart reuses ready candidate");
        Check([Journal(store)[@"record"][@"attempts"] isEqual:@1], @"ready reuse does not charge attempt");
        NSData *beforeValidation = [NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]];
        Check(SSPreparationValidate(source, target, nil, candidate, NULL), @"admission validates the prepared identities without copying");
        for (NSURL *url in @[source, target, candidate, [candidate URLByAppendingPathComponent:@"Contents"]]) {
            NSString *held = [url.path stringByAppendingString:@".held"];
            assert([Manager moveItemAtPath:url.path toPath:held error:NULL]);
            Bundle(url.path);
            NSError *validationError = nil;
            Check(!SSPreparationValidate(source, target, nil, candidate, &validationError) && validationError.code == ESTALE, @"admission rejects a substituted source target candidate or Contents");
            assert([Manager removeItemAtURL:url error:NULL]);
            assert([Manager moveItemAtPath:held toPath:url.path error:NULL]);
            Check(SSPreparationValidate(source, target, nil, candidate, NULL), @"restored identities pass admission");
        }
        NSString *privateParent = candidate.path.stringByDeletingLastPathComponent;
        assert(chmod(privateParent.fileSystemRepresentation, 0777) == 0);
        Check(!SSPreparationValidate(source, target, nil, candidate, NULL), @"admission rejects a newly writable preparation directory");
        assert(chmod(privateParent.fileSystemRepresentation, 0700) == 0);
        Check([beforeValidation isEqual:[NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]]], @"admission validation never rewrites or charges the journal");
        NSURL *secondSource = Bundle([root stringByAppendingPathComponent:@"second.app"]);
        NSURL *second = Prepare(secondSource, target, NULL);
        Check(second && !Exists(candidate) && Exists(source) && Exists(target), @"different request discards only owned candidate");
        Check([Journal(store)[@"record"][@"attempts"] isEqual:@1], @"different request has independent retry budget");

        root = Case(@"missing-after-reboot"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        NSMutableDictionary *rebootJournal = Journal(store);
        NSString *expiredDirectory = rebootJournal[@"record"][@"directory"][@"path"];
        assert([Manager removeItemAtPath:expiredDirectory error:NULL]);
        rebootJournal[@"record"][@"directory"][@"parent"][@"dev"] = @([rebootJournal[@"record"][@"directory"][@"parent"][@"dev"] unsignedLongLongValue] + 1);
        Rewrite(store, rebootJournal); SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        secondSource = Bundle([root stringByAppendingPathComponent:@"second.app"]);
        Check(Prepare(secondSource, target, NULL) != nil && Exists(source) && Exists(target), @"missing previous candidate permits new request after device identity changes");

        root = Case(@"present-after-reboot"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        rebootJournal = Journal(store);
        rebootJournal[@"record"][@"directory"][@"parent"][@"dev"] = @([rebootJournal[@"record"][@"directory"][@"parent"][@"dev"] unsignedLongLongValue] + 1);
        Rewrite(store, rebootJournal); SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        secondSource = Bundle([root stringByAppendingPathComponent:@"second.app"]);
        NSError *identityError = nil;
        Check(Prepare(secondSource, target, &identityError) == nil && identityError.code == ESTALE && Exists(candidate), @"present previous candidate still rejects changed parent identity");
        Check([Journal(store) isEqual:rebootJournal] && Exists(source) && Exists(target), @"identity failure preserves journal and applications");

        root = Case(@"retirement"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        identityError = nil;
        Check(!SSPreparationRetire(source, target, &identityError) && identityError.code == ESTALE, @"uninstalled candidate cannot retire preparation");
        assert([Manager moveItemAtPath:target.path toPath:[root stringByAppendingPathComponent:@"previous.app"] error:NULL]);
        assert([Manager moveItemAtURL:candidate toURL:target error:NULL]);
        secondSource = Bundle([root stringByAppendingPathComponent:@"second.app"]); identityError = nil;
        Check(!SSPreparationRetire(secondSource, target, &identityError) && identityError.code == ESTALE, @"another request cannot retire installed preparation");
        NSString *blockedSave = [store stringByAppendingPathComponent:@"journal.next"];
        Directory(blockedSave); identityError = nil;
        Check(!SSPreparationRetire(source, target, &identityError) && identityError != nil && [Journal(store)[@"record"][@"state"] isEqual:@"ready"], @"retirement persistence failure retains recovery record");
        assert([Manager removeItemAtPath:blockedSave error:NULL]);
        Check(SSPreparationRetire(source, target, NULL) && [Journal(store)[@"record"] count] == 0, @"installed identity retires durable preparation");
        Check(Exists(source) && Exists(target) && [Manager fileExistsAtPath:candidate.path.stringByDeletingLastPathComponent], @"retirement does not delete installed app source or cleanup-owned directory");
        SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        Check(SSPreparationRetire(source, target, NULL), @"retirement is idempotent after reopening");
        Check(Prepare(secondSource, target, NULL) != nil && [Journal(store)[@"record"][@"attempts"] isEqual:@1], @"next update starts independently after retirement");

        root = Case(@"renamed-retirement"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"input/source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        assert([Manager moveItemAtPath:target.path toPath:[root stringByAppendingPathComponent:@"previous.app"] error:NULL]);
        NSURL *renamedTarget = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"source.app"]];
        NSURL *unexpectedTarget = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"unexpected.app"]];
        assert([Manager moveItemAtURL:candidate toURL:unexpectedTarget error:NULL]); identityError = nil;
        Check(!SSPreparationRetire(source, unexpectedTarget, &identityError) && identityError.code == ESTALE, @"unexpected installed path cannot retire preparation");
        assert([Manager moveItemAtURL:unexpectedTarget toURL:renamedTarget error:NULL]);
        Check(SSPreparationRetire(source, renamedTarget, NULL), @"installed source bundle name retires preparation");

        root = Case(@"ownership"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        Check(!SSPreparationAcceptOwnership(source, target, nil, candidate, NULL), @"ownership cannot be accepted without durable intent");
        NSString *intentSave = [store stringByAppendingPathComponent:@"journal.next"];
        Directory(intentSave);
        Check(!SSPreparationBeginOwnership(source, target, nil, candidate, NULL) && !Journal(store)[@"record"][@"ownership"], @"failed intent save prevents ownership mutation");
        assert([Manager removeItemAtPath:intentSave error:NULL]);
        Check(SSPreparationBeginOwnership(source, target, nil, candidate, NULL), @"ownership intent is durable before mutation");
        // Model the durable pre-ownership snapshot with the same real inodes.
        // Privileged ShipIt changes these two owners during signature validation.
        NSMutableDictionary *ownership = Journal(store);
        NSNumber *previousOwner = @(getuid() == 0 ? 501 : 0);
        ownership[@"record"][@"candidate"][@"item"][@"uid"] = previousOwner;
        ownership[@"record"][@"candidate"][@"contents"][@"uid"] = previousOwner;
        Rewrite(store, ownership); SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        Check(!SSPreparationValidate(source, target, nil, candidate, NULL), @"ordinary admission never ignores an owner mismatch");
        NSString *ownershipSave = [store stringByAppendingPathComponent:@"journal.next"];
        Directory(ownershipSave);
        Check(!SSPreparationAcceptOwnership(source, target, nil, candidate, NULL) && [ownership isEqual:Journal(store)], @"ownership persistence failure retains the old durable snapshot");
        assert([Manager removeItemAtPath:ownershipSave error:NULL]);
        Check(SSPreparationAcceptOwnership(source, target, nil, candidate, NULL), @"completed installer ownership transition is recorded explicitly");
        Check(SSPreparationValidate(source, target, nil, candidate, NULL), @"strict admission succeeds against the transitioned snapshot");
        Check([Journal(store)[@"record"][@"candidate"][@"item"][@"uid"] isEqual:@(getuid())] &&
              [Journal(store)[@"record"][@"candidate"][@"contents"][@"uid"] isEqual:@(getuid())], @"both bundle and Contents retain the installer owner");
        SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        Check(SSPreparationValidate(source, target, nil, candidate, NULL), @"accepted ownership survives helper restart");
        for (NSURL *url in @[source, target, candidate, [candidate URLByAppendingPathComponent:@"Contents"]]) {
            NSString *held = [url.path stringByAppendingString:@".held"];
            assert([Manager moveItemAtPath:url.path toPath:held error:NULL]); Bundle(url.path);
            Check(!SSPreparationAcceptOwnership(source, target, nil, candidate, NULL), @"ownership acceptance rejects a replaced request or candidate inode");
            assert([Manager removeItemAtURL:url error:NULL]);
            assert([Manager moveItemAtPath:held toPath:url.path error:NULL]);
        }
        NSDictionary *unchangedOwnership = Journal(store);
        Check(!SSPreparationAcceptOwnership(source, target, @{@"requestId":@"other"}, candidate, NULL) &&
              [unchangedOwnership isEqual:Journal(store)], @"another binding cannot rebase the ownership snapshot");
        assert(chmod(candidate.path.stringByDeletingLastPathComponent.fileSystemRepresentation, 0777) == 0);
        Check(!SSPreparationAcceptOwnership(source, target, nil, candidate, NULL), @"ownership acceptance requires the helper's private parent");
        assert(chmod(candidate.path.stringByDeletingLastPathComponent.fileSystemRepresentation, 0700) == 0);

        root = Case(@"partial"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        NSMutableDictionary *journal = Journal(store);
        journal[@"record"][@"state"] = @"copying"; [journal[@"record"] removeObjectForKey:@"candidate"];
        assert(symlink(target.path.fileSystemRepresentation, [[candidate.path stringByAppendingPathComponent:@"external"] fileSystemRepresentation]) == 0);
        Rewrite(store, journal); SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        NSURL *recovered = Prepare(source, target, NULL);
        Check(recovered && ![recovered isEqual:candidate] && !Exists(candidate), @"incomplete copy is discarded and retried");
        Check(Exists(target), @"partial cleanup unlinks symlink without following target");
        Check([Journal(store)[@"record"][@"attempts"] isEqual:@2], @"interrupted attempt remains charged");
        assert([Manager removeItemAtURL:recovered error:NULL]);
        Check(Prepare(source, target, NULL) != nil, @"missing ready candidate is recreated");

        root = Case(@"retry"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        NSString *unreadable = [source.path stringByAppendingPathComponent:@"Contents/data"];
        assert(chmod(unreadable.fileSystemRepresentation, 0000) == 0);
        for (NSUInteger attempt = 1; attempt <= 3; attempt++) {
            NSError *error = nil; Check(Prepare(source, target, &error) == nil && error != nil, @"copy failure propagates original error");
            Check([Journal(store)[@"record"][@"attempts"] unsignedIntegerValue] == attempt, @"failed attempt persisted independently");
            SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        }
        assert(chmod(unreadable.fileSystemRepresentation, 0600) == 0);
        NSError *error = nil;
        Check(Prepare(source, target, &error) == nil && error.code == ELOOP, @"fourth preparation rejected across restart");
        Check(Exists(source) && Exists(target), @"exhausted preparation never deletes source or target");

        root = Case(@"target-change"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        assert([Manager moveItemAtPath:target.path toPath:[root stringByAppendingPathComponent:@"old-target.app"] error:NULL]);
        Bundle(target.path); error = nil;
        Check(Prepare(source, target, &error) == nil && error.code == ESTALE && Exists(candidate), @"changed installed identity requires rollback reconciliation");
        assert([Manager removeItemAtURL:target error:NULL]); error = nil;
        Check(Prepare(source, target, &error) == nil && error.code == ENOENT && Exists(candidate), @"missing target fails without consuming candidate");

        root = Case(@"source-change"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        assert([Manager moveItemAtPath:source.path toPath:[root stringByAppendingPathComponent:@"old-source.app"] error:NULL]); Bundle(source.path); error = nil;
        Check(Prepare(source, target, &error) == nil && error.code == ESTALE, @"same path with substituted source is rejected");

        root = Case(@"parent-symlink"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        NSString *parent = candidate.path.stringByDeletingLastPathComponent;
        NSString *moved = [parent stringByAppendingString:@".moved"];
        assert([Manager moveItemAtPath:parent toPath:moved error:NULL]);
        assert(symlink(moved.fileSystemRepresentation, parent.fileSystemRepresentation) == 0); error = nil;
        Check(Prepare(source, target, &error) == nil && error != nil, @"candidate parent symlink cannot become ready");
        secondSource = Bundle([root stringByAppendingPathComponent:@"second.app"]); error = nil;
        Check(Prepare(secondSource, target, &error) == nil && Exists([NSURL fileURLWithPath:[moved stringByAppendingPathComponent:source.lastPathComponent]]), @"discard refuses substituted parent and preserves linked tree");
        assert(unlink(parent.fileSystemRepresentation) == 0); assert([Manager moveItemAtPath:moved toPath:parent error:NULL]);

        root = Case(@"candidate-symlink"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        candidate = Prepare(source, target, NULL); assert(candidate);
        NSString *held = [candidate.path stringByAppendingString:@".held"];
        assert([Manager moveItemAtPath:candidate.path toPath:held error:NULL]);
        assert(symlink(target.path.fileSystemRepresentation, candidate.path.fileSystemRepresentation) == 0);
        secondSource = Bundle([root stringByAppendingPathComponent:@"second.app"]); error = nil;
        Check(Prepare(secondSource, target, &error) == nil && error.code == ESTALE && Exists(target), @"discard refuses substituted ready candidate");
        assert(unlink(candidate.path.fileSystemRepresentation) == 0); assert([Manager moveItemAtPath:held toPath:candidate.path error:NULL]);

        root = Case(@"journal-safety"); store = Store(root); SSPreparationClose();
        NSString *victim = [root stringByAppendingPathComponent:@"victim"];
        assert([@"untouched" writeToFile:victim atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
        NSString *journalPath = [store stringByAppendingPathComponent:@"journal.plist"];
        assert(symlink(victim.fileSystemRepresentation, journalPath.fileSystemRepresentation) == 0);
        Check(!SSPreparationOpenDirectory(store, NULL), @"journal symlink rejected");
        assert(unlink(journalPath.fileSystemRepresentation) == 0); assert(link(victim.fileSystemRepresentation, journalPath.fileSystemRepresentation) == 0);
        Check(!SSPreparationOpenDirectory(store, NULL), @"journal hardlink rejected");
        assert(unlink(journalPath.fileSystemRepresentation) == 0);
        assert(mkfifo(journalPath.fileSystemRepresentation, 0600) == 0);
        Check(!SSPreparationOpenDirectory(store, NULL), @"journal FIFO fails without blocking");
        assert(unlink(journalPath.fileSystemRepresentation) == 0); assert(chmod(store.fileSystemRepresentation, 0777) == 0);
        Check(!SSPreparationOpenDirectory(store, NULL), @"shared writable store rejected");
        assert(chmod(store.fileSystemRepresentation, 0700) == 0); assert(SSPreparationOpenDirectory(store, NULL));
        pid_t child = fork(); assert(child >= 0);
        if (!child) { SSPreparationClose(); _exit(SSPreparationOpenDirectory(store, NULL) ? 1 : 0); }
        int status; assert(waitpid(child, &status, 0) == child);
        Check(WIFEXITED(status) && WEXITSTATUS(status) == 0, @"independent processes cannot share preparation lock");

        root = Case(@"killed-copy"); store = Store(root); source = Bundle([root stringByAppendingPathComponent:@"source.app"]); target = Bundle([root stringByAppendingPathComponent:@"target.app"]);
        for (NSUInteger i = 0; i < 3000; i++) {
            NSString *file = [source.path stringByAppendingPathComponent:[NSString stringWithFormat:@"Contents/file-%lu", (unsigned long)i]];
            assert([@"fixture" writeToFile:file atomically:NO encoding:NSUTF8StringEncoding error:NULL]);
        }
        SSPreparationClose(); child = fork(); assert(child >= 0);
        if (!child) { assert(SSPreparationOpenDirectory(store, NULL)); Prepare(source, target, NULL); _exit(0); }
        BOOL observed = NO;
        for (NSUInteger poll = 0; poll < 10000; poll++) {
            NSData *data = [NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]];
            NSDictionary *state = data ? [NSPropertyListSerialization propertyListWithData:data options:0 format:NULL error:NULL] : nil;
            if ([state[@"record"][@"state"] isEqual:@"copying"]) { observed = YES; assert(kill(child, SIGKILL) == 0); break; }
            usleep(1000);
        }
        assert(waitpid(child, &status, 0) == child);
        Check(observed && WIFSIGNALED(status), @"process interrupted after durable copying record");
        assert(SSPreparationOpenDirectory(store, NULL)); candidate = Prepare(source, target, NULL);
        Check(candidate && [Journal(store)[@"record"][@"attempts"] isEqual:@2] && Exists(source) && Exists(target), @"killed copy recovers without touching source or running target");
        SSPreparationClose();
        for (NSString *parent in OwnedParents) {
            assert([parent.lastPathComponent hasPrefix:@"shipit-candidate."]);
            if ([Manager fileExistsAtPath:parent]) assert([Manager removeItemAtPath:parent error:NULL]);
            assert(![Manager fileExistsAtPath:parent]);
        }
        NSLog(@"preparation contract checks passed: %lu", (unsigned long)Passed);
    }
    return 0;
}
