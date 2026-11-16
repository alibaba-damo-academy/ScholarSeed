#import <Foundation/Foundation.h>
#import "preparation.h"
#import "cleanup.h"
#import "observation.h"
#include <sys/stat.h>
#include <unistd.h>
#import "retirement.h"

static NSURL *Bundle(NSString *path) {
    assert([NSFileManager.defaultManager createDirectoryAtPath:[path stringByAppendingPathComponent:@"Contents"] withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    return [NSURL fileURLWithPath:path];
}
static void ExplicitRecovery(NSString *root, NSUInteger scenario) {
    NSFileManager *manager = NSFileManager.defaultManager;
    NSString *store = [root stringByAppendingPathComponent:@"preparation"], *cleanup = [root stringByAppendingPathComponent:@"cleanup"];
    NSURL *source = Bundle([root stringByAppendingPathComponent:@"cache/Old.app"]), *target = Bundle([root stringByAppendingPathComponent:@"installed/App.app"]);
    for (NSString *directory in @[store, cleanup]) assert([manager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    assert(SSCleanupOpenDirectory(cleanup, NULL)); SSCleanupClose();
    assert(SSCleanupOpenMaintenanceDirectory(cleanup, NULL));
    assert(SSPreparationOpenDirectory(store, NULL));
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
        @"candidate":@"explicit-maintenance", @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@1};
    NSURL *candidate = SSPreparationCopy(source, target, scenario == 1 ? binding : nil, NULL); assert(candidate);
    NSString *journalPath = [store stringByAppendingPathComponent:@"journal.plist"];
    NSData *journal = [NSData dataWithContentsOfFile:journalPath];
    if (scenario != 2) assert([manager removeItemAtPath:source.path.stringByDeletingLastPathComponent error:NULL]);
    if (scenario == 1) {
        NSString *parent = target.path.stringByDeletingLastPathComponent;
        assert([manager moveItemAtPath:parent toPath:[parent stringByAppendingString:@".old"] error:NULL]);
        Bundle(target.path);
    }
    NSURL *state = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"ShipItState.plist"]];
    NSMutableDictionary *request = [@{@"bundleIdentifier":@"com.scholarseed.fixture", @"updateBundleURL":source.absoluteString,
        @"targetBundleURL":target.absoluteString, @"installationAuthorized":@YES, @"launchAfterInstallation":@YES, @"useUpdateBundleName":@YES} mutableCopy];
    if (scenario == 1) request[@"binding"] = binding;
    NSData *stateBytes = [NSJSONSerialization dataWithJSONObject:request options:0 error:NULL];
    assert([stateBytes writeToURL:state atomically:NO]); assert(chmod(state.path.fileSystemRepresentation, 0600) == 0);
    NSError *error = nil;
    SSPreparationActivity (^absent)(void) = ^{ return SSPreparationActivityAbsent; };
    NSDictionary *proof = SSPreparationRetirementSnapshot(source, target, binding, state, nil, absent, &error);
    if (!proof) NSLog(@"explicit proof refused %@", error);
    assert(proof);
    assert(!SSPreparationRetirementSnapshot(source, target, binding, state, nil, ^{ return SSPreparationActivityActive; }, NULL));
    assert(!SSPreparationRetirementRepair(source, target, binding, state, proof, absent, ^BOOL(NSError **e) { (void)e; return NO; }, NULL));
    assert([[NSData dataWithContentsOfFile:journalPath] isEqual:journal]);
    if (scenario >= 3) {
        // Crash after the durable deny decision, before journal consumption.
        assert(SSPreparationArchiveSnapshot(proof, NULL));
        int directory = SSObservationOpenDirectory(store); assert(directory >= 0);
        NSDictionary *entry = @{@"source":source.path, @"target":target.path, @"operation":binding[@"requestId"],
            @"request":SSObservationDigest(stateBytes), @"journal":SSObservationDigest(journal)};
        NSString *pending = [store stringByAppendingPathComponent:@"retired.next"];
        assert([[@"partial" dataUsingEncoding:NSUTF8StringEncoding] writeToFile:pending atomically:NO]); assert(chmod(pending.fileSystemRepresentation, 0600) == 0);
        assert(SSRetirementAppend(directory, entry, NULL));
        assert(!SSRetirementAllows(directory, source, NULL));
        assert(close(directory) == 0);
        if (scenario == 4) {
            // Crash after advancing the journal, before consuming native state.
            NSData *empty = [NSPropertyListSerialization dataWithPropertyList:@{@"schema":@"1", @"record":@{}} format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
            assert([empty writeToFile:journalPath atomically:NO]);
        }
        SSPreparationClose(); assert(SSPreparationOpenMaintenanceDirectory(store, NULL));
    }
    assert(SSPreparationRetirementRepair(source, target, binding, state, proof, absent, ^BOOL(NSError **e) { (void)e; return YES; }, NULL));
    assert(![manager fileExistsAtPath:state.path]);
    assert([manager fileExistsAtPath:candidate.path]);
    SSPreparationClose(); assert(SSPreparationOpenMaintenanceDirectory(store, NULL));
    assert(SSPreparationRetirementRepair(source, target, binding, state, proof, absent, ^BOOL(NSError **e) { (void)e; return YES; }, NULL));
    Bundle(source.path); assert(!SSPreparationCopy(source, target, nil, NULL));
    NSURL *next = Bundle([root stringByAppendingPathComponent:@"next/New.app"]);
    NSURL *nextCandidate = SSPreparationCopy(next, target, nil, NULL); assert(nextCandidate);
    assert(!SSPreparationRetirementRepair(source, target, binding, state, proof, absent, ^BOOL(NSError **e) { (void)e; return YES; }, NULL));
    SSPreparationClose(); SSCleanupClose();
    assert([manager removeItemAtPath:candidate.path.stringByDeletingLastPathComponent error:NULL]);
    assert([manager removeItemAtPath:nextCandidate.path.stringByDeletingLastPathComponent error:NULL]);
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 2);
        NSString *root = @(argv[1]), *store = [root stringByAppendingPathComponent:@"preparation"], *cleanup = [root stringByAppendingPathComponent:@"cleanup"];
        NSURL *source = Bundle([root stringByAppendingPathComponent:@"source/Old.app"]), *target = Bundle([root stringByAppendingPathComponent:@"target/App.app"]);
        NSURL *next = Bundle([root stringByAppendingPathComponent:@"next/New.app"]);
        for (NSString *path in @[store, cleanup]) assert([NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
        assert(SSCleanupOpenDirectory(cleanup, NULL)); SSCleanupClose();
        assert(SSCleanupOpenExistingDirectory(cleanup, NULL));
        assert(SSPreparationOpenDirectory(store, NULL));
        // Legacy request: no binding, failure acknowledgement or terminal receipt.
        NSURL *candidate = SSPreparationCopy(source, target, nil, NULL); assert(candidate);
        NSData *journal = [NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]]; assert(journal);
        NSString *operation = [@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
        NSDictionary *entry = @{@"source":source.path, @"target":target.path, @"operation":operation,
            @"request":SSObservationDigest([@"legacy request" dataUsingEncoding:NSUTF8StringEncoding]), @"journal":SSObservationDigest(journal)};
        NSMutableDictionary *wrong = [entry mutableCopy]; wrong[@"journal"] = operation;
        assert(!SSPreparationRetireRequest(wrong, NULL));
        NSString *journalPath = [store stringByAppendingPathComponent:@"journal.plist"];
        NSMutableDictionary *changed = [NSPropertyListSerialization propertyListWithData:journal options:NSPropertyListMutableContainers format:NULL error:NULL];
        changed[@"record"][@"attempts"] = @2;
        NSData *changedBytes = [NSPropertyListSerialization dataWithPropertyList:changed format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
        assert([changedBytes writeToFile:journalPath atomically:NO]);
        wrong = [entry mutableCopy]; wrong[@"journal"] = SSObservationDigest(changedBytes);
        assert(!SSPreparationRetireRequest(wrong, NULL)); // Digest alone cannot replace the held transaction.
        assert([[NSData dataWithContentsOfFile:journalPath] isEqual:changedBytes]);
        assert([journal writeToFile:journalPath atomically:NO]);
        NSString *lock = [store stringByAppendingPathComponent:@"lock"];
        NSString *oldLock = [store stringByAppendingPathComponent:@"old-lock"];
        assert(rename(lock.fileSystemRepresentation, oldLock.fileSystemRepresentation) == 0);
        assert([[@"" dataUsingEncoding:NSUTF8StringEncoding] writeToFile:lock atomically:NO]);
        assert(chmod(lock.fileSystemRepresentation, 0600) == 0);
        assert(!SSPreparationRetireRequest(entry, NULL));
        assert(unlink(lock.fileSystemRepresentation) == 0);
        assert(rename(oldLock.fileSystemRepresentation, lock.fileSystemRepresentation) == 0);
        NSString *detached = [store stringByAppendingString:@"-detached"];
        assert(rename(store.fileSystemRepresentation, detached.fileSystemRepresentation) == 0);
        assert([NSFileManager.defaultManager createDirectoryAtPath:store withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
        assert(!SSPreparationRetireRequest(entry, NULL));
        assert(![NSFileManager.defaultManager fileExistsAtPath:[detached stringByAppendingPathComponent:@"retired.plist"]]);
        assert([NSFileManager.defaultManager removeItemAtPath:store error:NULL]);
        assert(rename(detached.fileSystemRepresentation, store.fileSystemRepresentation) == 0);
        // A missing old source must not force recreation of its identity or ack.
        assert([NSFileManager.defaultManager removeItemAtURL:source error:NULL]);
        NSError *failure = nil;
        BOOL retired = SSPreparationRetireRequest(entry, &failure);
        if (!retired) NSLog(@"retirement rejected: %@", failure);
        assert(retired);
        assert(SSPreparationRetireRequest(entry, NULL));
        NSData *emptyJournal = [NSData dataWithContentsOfFile:journalPath];
        assert([journal writeToFile:journalPath atomically:NO]);
        assert(!SSPreparationRetireRequest(entry, NULL)); // Empty cached state cannot hide a newly installed journal.
        assert([[NSData dataWithContentsOfFile:journalPath] isEqual:journal]);
        assert([emptyJournal writeToFile:journalPath atomically:NO]);
        assert([NSFileManager.defaultManager fileExistsAtPath:candidate.path]);
        Bundle(source.path);
        assert(!SSPreparationCopy(source, target, nil, NULL));
        NSInteger code = 0;
        assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureInvalid);
        SSPreparationClose();
        assert(SSPreparationOpenDirectory(store, NULL));
        assert(!SSPreparationCopy(source, target, nil, NULL));
        NSURL *nextCandidate = SSPreparationCopy(next, target, nil, NULL); assert(nextCandidate);
        assert(!SSPreparationCopy(source, target, nil, NULL));
        assert(!SSPreparationRetireRequest(entry, NULL)); // Never clear a newer transaction.
        SSPreparationClose();
        assert(SSPreparationOpenExistingDirectory(store, NULL));
        assert(!SSPreparationRetireRequest(entry, NULL)); // Read-only qualification stays read-only.
        SSPreparationClose();
        // Malformed or replaced ledgers fail closed, rather than forgetting history.
        NSString *ledger = [store stringByAppendingPathComponent:@"retired.plist"];
        assert([@"invalid" writeToFile:ledger atomically:NO encoding:NSUTF8StringEncoding error:NULL]);
        assert(SSPreparationOpenDirectory(store, NULL));
        assert(!SSPreparationCopy(next, target, nil, NULL));
        SSPreparationClose(); SSCleanupClose();
        assert([NSFileManager.defaultManager removeItemAtPath:candidate.path.stringByDeletingLastPathComponent error:NULL]);
        assert([NSFileManager.defaultManager removeItemAtPath:nextCandidate.path.stringByDeletingLastPathComponent error:NULL]);
        NSLog(@"retirement native contracts passed");
        for (NSUInteger scenario = 0; scenario < 5; scenario++) ExplicitRecovery([root stringByAppendingPathComponent:[NSString stringWithFormat:@"explicit-%lu", (unsigned long)scenario]], scenario);
        NSLog(@"explicit retirement lifecycle cases passed=5");
    }
    return 0;
}
