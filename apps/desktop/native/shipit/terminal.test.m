#import "preparation.h"
#import "readiness.h"
#include <assert.h>
#include <sys/stat.h>
#include <unistd.h>

static NSURL *Bundle(NSString *path) {
  NSURL *url = [NSURL fileURLWithPath:path];
  assert([NSFileManager.defaultManager createDirectoryAtURL:[url URLByAppendingPathComponent:@"Contents"] withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  return url;
}
static NSMutableDictionary *Journal(NSString *store) {
  return [NSPropertyListSerialization propertyListWithData:[NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]]
    options:NSPropertyListMutableContainers format:NULL error:NULL];
}
static void WriteJournal(NSString *store, NSDictionary *journal) {
  NSString *path = [store stringByAppendingPathComponent:@"journal.plist"];
  assert([[NSPropertyListSerialization dataWithPropertyList:journal format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL] writeToFile:path atomically:YES]);
  assert(chmod(path.fileSystemRepresentation, 0600) == 0);
}
static NSDictionary *FixtureIdentity(NSString *path) {
  struct stat info;
  assert(lstat(path.fileSystemRepresentation, &info) == 0);
  return @{@"dev":@(info.st_dev), @"ino":@(info.st_ino), @"uid":@(info.st_uid)};
}
static NSUInteger Publications(NSString *root, NSMutableSet *parents) {
  NSUInteger checks = 0;
  NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
    @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@1, @"candidate":@"publication"};
  NSMutableDictionary *nextBinding = [binding mutableCopy];
  nextBinding[@"requestId"] = [@"c" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0];
  for (NSString *name in @[@"prune-missing", @"prune-ack", @"candidate-missing", @"directory-missing", @"parent-missing", @"parent-drift", @"directory-mode", @"directory-link",
    @"ack", @"save", @"target", @"candidate-live", @"directory-live", @"version", @"no-version", @"schema", @"source",
    @"target-receipt", @"failureTarget", @"binding", @"code", @"candidate", @"directory", @"extra", @"empty", @"receipt-type", @"uncommitted"]) {
    NSString *fixture = [[root stringByAppendingPathComponent:@"publication"] stringByAppendingPathComponent:name];
    NSURL *source = Bundle([fixture stringByAppendingPathComponent:@"request/New.app"]), *target = Bundle([fixture stringByAppendingPathComponent:@"live/Old.app"]);
    NSURL *otherSource = Bundle([fixture stringByAppendingPathComponent:@"other/Next.app"]), *otherTarget = Bundle([fixture stringByAppendingPathComponent:@"other-live/Other.app"]);
    NSString *store = [fixture stringByAppendingPathComponent:@"journal"];
    assert([NSFileManager.defaultManager createDirectoryAtPath:store withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]); checks++;
    assert(SSPreparationOpenDirectory(store, NULL)); checks++;
    NSURL *candidate = SSPreparationCopy(source, target, binding, NULL); assert(candidate); checks++;
    [parents addObject:candidate.path.stringByDeletingLastPathComponent];
    if ([name hasPrefix:@"parent-"]) {
      NSString *temporary = [fixture stringByAppendingPathComponent:@"old-temporary"];
      assert([NSFileManager.defaultManager createDirectoryAtPath:temporary withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]); checks++;
      NSString *moved = [temporary stringByAppendingPathComponent:candidate.path.stringByDeletingLastPathComponent.lastPathComponent];
      assert(rename(candidate.path.stringByDeletingLastPathComponent.fileSystemRepresentation, moved.fileSystemRepresentation) == 0); checks++;
      NSMutableDictionary *relocated = Journal(store);
      relocated[@"record"][@"directory"][@"path"] = moved;
      relocated[@"record"][@"directory"][@"parent"] = FixtureIdentity(temporary);
      relocated[@"record"][@"candidate"][@"path"] = [moved stringByAppendingPathComponent:candidate.lastPathComponent];
      SSPreparationClose(); WriteJournal(store, relocated); assert(SSPreparationOpenDirectory(store, NULL)); checks++;
      candidate = [NSURL fileURLWithPath:relocated[@"record"][@"candidate"][@"path"]];
      [parents addObject:moved];
    }
    assert(SSPreparationRecordFailure(source, target, binding, ECANCELED, NULL)); checks++;
    NSInteger code = 0;
    if ([name isEqual:@"uncommitted"]) {
      assert(SSReadinessPublishBound(source, target, binding, NO, ECANCELED, NULL)); checks++;
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid); checks++;
      assert(!SSPreparationCopy(otherSource, otherTarget, nextBinding, NULL)); checks++;
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL)); checks++;
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid); checks++;
      SSPreparationClose(); continue;
    }
    __block NSUInteger launches = 0;
    if ([name isEqual:@"save"]) {
      NSData *before = [NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]];
      NSString *blocked = [store stringByAppendingPathComponent:@"journal.next"];
      assert([NSFileManager.defaultManager createDirectoryAtPath:blocked withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]); checks++;
      assert(!SSPreparationFinishFailure(source, target, binding, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, NULL)); checks++;
      assert(launches == 0 && !SSReadinessFailedRequestBound(source, target, binding)); checks++;
      assert([[NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]] isEqual:before]); checks++;
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid); checks++;
      assert([NSFileManager.defaultManager removeItemAtPath:blocked error:NULL]); checks++;
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL)); checks++;
    }
    NSString *next = [source.path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".scholarseed-prepare.next"];
    assert(symlink(target.path.fileSystemRepresentation, next.fileSystemRepresentation) == 0); checks++;
    assert(!SSPreparationFinishFailure(source, target, binding, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, NULL)); checks++;
    assert(launches == 0 && !SSReadinessFailedRequestBound(source, target, binding)); checks++;
    NSMutableDictionary *journal = Journal(store);
    NSDictionary *publication = journal[@"record"][@"failure"][@"publication"];
    assert([publication isKindOfClass:NSDictionary.class] && publication.count == 8); checks++;
    assert([journal[@"record"][@"terminalVersion"] isEqual:@"1"] && [publication[@"schema"] isEqual:@"1"]); checks++;
    for (NSString *field in @[@"source", @"target", @"binding", @"candidate", @"directory"])
      { assert([publication[field] isEqual:journal[@"record"][field]]); checks++; }
    assert([publication[@"failureTarget"] isEqual:journal[@"record"][@"failure"][@"target"]] && [publication[@"code"] isEqual:@(ECANCELED)]); checks++;
    assert(!SSPreparationCopy(source, target, binding, NULL) && !SSPreparationValidate(source, target, binding, candidate, NULL) && !SSPreparationRetire(source, target, NULL)); checks++;
    SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL)); checks++;
    if ([name isEqual:@"ack"] || [name isEqual:@"prune-ack"]) {
      assert(unlink(next.fileSystemRepresentation) == 0); checks++;
      assert(SSPreparationFinishFailure(source, target, binding, [name isEqual:@"ack"], ^BOOL { return NO; }, ^BOOL {
        assert([Journal(store)[@"record"][@"failure"][@"publication"] isEqual:publication]);
        assert(SSReadinessFailedRequestBound(source, target, binding)); launches++; return YES;
      }, NULL)); checks++;
      assert(launches == ([name isEqual:@"ack"] ? 1u : 0u)); checks++;
    }
    if ([name hasSuffix:@"-missing"]) {
      NSString *missing = [name isEqual:@"candidate-missing"] ? candidate.path : candidate.path.stringByDeletingLastPathComponent;
      if ([name isEqual:@"parent-missing"]) missing = missing.stringByDeletingLastPathComponent;
      if (![name hasPrefix:@"prune-"]) { assert([NSFileManager.defaultManager removeItemAtPath:missing error:NULL]); checks++; }
      assert([NSFileManager.defaultManager removeItemAtPath:source.path.stringByDeletingLastPathComponent error:NULL]); checks++;
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL)); checks++;
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureNone); checks++;
      NSURL *nextCandidate = SSPreparationCopy(otherSource, otherTarget, nextBinding, NULL); assert(nextCandidate); checks++;
      [parents addObject:nextCandidate.path.stringByDeletingLastPathComponent];
    } else if ([name isEqual:@"prune-ack"]) {
      assert([NSFileManager.defaultManager removeItemAtPath:source.path.stringByDeletingLastPathComponent error:NULL]); checks++;
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL)); checks++;
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureNone); checks++;
      NSURL *nextCandidate = SSPreparationCopy(otherSource, otherTarget, nextBinding, NULL); assert(nextCandidate); checks++;
      [parents addObject:nextCandidate.path.stringByDeletingLastPathComponent];
    } else if ([name isEqual:@"target"]) {
      NSString *saved = [target.path stringByAppendingString:@".saved"];
      assert(rename(target.path.fileSystemRepresentation, saved.fileSystemRepresentation) == 0); checks++;
      Bundle(target.path);
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid); checks++;
      assert(!SSPreparationCopy(otherSource, otherTarget, nextBinding, NULL)); checks++;
    } else if ([name isEqual:@"candidate-live"] || [name isEqual:@"directory-live"]) {
      NSString *changed = [name isEqual:@"candidate-live"] ? [candidate.path stringByAppendingPathComponent:@"Contents"] : candidate.path.stringByDeletingLastPathComponent;
      NSString *saved = [changed stringByAppendingString:@".saved"];
      assert(rename(changed.fileSystemRepresentation, saved.fileSystemRepresentation) == 0); checks++;
      assert([NSFileManager.defaultManager createDirectoryAtPath:changed withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]); checks++;
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid); checks++;
      assert(!SSPreparationCopy(otherSource, otherTarget, nextBinding, NULL)); checks++;
      if ([name isEqual:@"directory-live"]) [parents addObject:saved];
    } else if ([name isEqual:@"parent-drift"] || [name isEqual:@"directory-mode"] || [name isEqual:@"directory-link"]) {
      NSString *changed = candidate.path.stringByDeletingLastPathComponent;
      if ([name isEqual:@"parent-drift"]) changed = changed.stringByDeletingLastPathComponent;
      if ([name isEqual:@"directory-mode"]) { assert(chmod(changed.fileSystemRepresentation, 0755) == 0); checks++; }
      else {
        NSString *saved = [changed stringByAppendingString:@".saved"];
        assert(rename(changed.fileSystemRepresentation, saved.fileSystemRepresentation) == 0); checks++;
        if ([name isEqual:@"directory-link"]) { assert(symlink(saved.fileSystemRepresentation, changed.fileSystemRepresentation) == 0); checks++; }
        else { assert([NSFileManager.defaultManager createDirectoryAtPath:changed withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]); checks++; }
        [parents addObject:saved];
      }
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid); checks++;
      assert(!SSPreparationCopy(otherSource, otherTarget, nextBinding, NULL)); checks++;
    } else if (![@[@"ack", @"save"] containsObject:name]) {
      assert(unlink(next.fileSystemRepresentation) == 0); checks++;
      assert(SSReadinessPublishBound(source, target, binding, NO, ECANCELED, NULL)); checks++;
      if ([name isEqual:@"version"]) journal[@"record"][@"terminalVersion"] = @"2";
      else if ([name isEqual:@"no-version"]) [journal[@"record"] removeObjectForKey:@"terminalVersion"];
      else if ([name isEqual:@"extra"]) journal[@"record"][@"failure"][@"publication"][@"extra"] = @YES;
      else if ([name isEqual:@"empty"]) journal[@"record"][@"failure"][@"publication"] = @{};
      else if ([name isEqual:@"receipt-type"]) journal[@"record"][@"failure"][@"publication"] = @"invalid";
      else {
        NSString *field = [name isEqual:@"target-receipt"] ? @"target" : name;
        journal[@"record"][@"failure"][@"publication"][field] = [field isEqual:@"code"] ? @0 : @"invalid";
      }
      SSPreparationClose(); WriteJournal(store, journal);
      assert(!SSPreparationOpenDirectory(store, NULL)); checks++;
    }
    SSPreparationClose();
    NSLog(@"[shipit-publication-test] %@ PASS", name);
  }
  return checks;
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 2 && geteuid() != 0);
    NSString *root = @(argv[1]);
    NSMutableSet *parents = [NSMutableSet set];
    for (NSString *name in @[@"same", @"renamed", @"conflict", @"source-change", @"ownership", @"interrupted", @"intent"]) {
      NSString *fixture = [root stringByAppendingPathComponent:name];
      NSURL *source = Bundle([fixture stringByAppendingPathComponent:@"request/New.app"]);
      NSURL *target = Bundle([fixture stringByAppendingPathComponent:@"live/Old.app"]);
      NSString *store = [fixture stringByAppendingPathComponent:@"journal"];
      assert([NSFileManager.defaultManager createDirectoryAtPath:store withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
      assert(SSPreparationOpenDirectory(store, NULL));
      NSURL *candidate = SSPreparationCopy(source, target, nil, NULL); assert(candidate);
      [parents addObject:candidate.path.stringByDeletingLastPathComponent];
      NSMutableDictionary *legacy = Journal(store);
      [legacy[@"record"] removeObjectForKey:@"terminalVersion"];
      SSPreparationClose(); WriteJournal(store, legacy); assert(SSPreparationOpenDirectory(store, NULL));
      NSInteger code = 0;
      assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureNone);
      NSURL *actual = target;
      BOOL renamed = ![name isEqual:@"same"] && ![name isEqual:@"source-change"] && ![name isEqual:@"ownership"] && ![name isEqual:@"interrupted"] && ![name isEqual:@"intent"];
      if (renamed) {
        actual = [target.URLByDeletingLastPathComponent URLByAppendingPathComponent:@"New.app"];
        assert(rename(target.path.fileSystemRepresentation, actual.path.fileSystemRepresentation) == 0);
      }
      if ([name isEqual:@"ownership"] || [name isEqual:@"interrupted"]) {
        NSString *journalPath = [store stringByAppendingPathComponent:@"journal.plist"];
        NSMutableDictionary *journal = [NSPropertyListSerialization propertyListWithData:[NSData dataWithContentsOfFile:journalPath]
          options:NSPropertyListMutableContainers format:NULL error:NULL];
        if ([name isEqual:@"interrupted"]) journal[@"record"][@"ownership"] = @YES;
        journal[@"record"][@"candidate"][@"item"][@"uid"] = @(getuid() == 0 ? 501 : 0);
        journal[@"record"][@"candidate"][@"contents"][@"uid"] = @(getuid() == 0 ? 501 : 0);
        assert([[NSPropertyListSerialization dataWithPropertyList:journal format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL]
          writeToFile:journalPath atomically:YES]);
        assert(chmod(journalPath.fileSystemRepresentation, 0600) == 0);
        SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      }
      if ([name isEqual:@"intent"]) {
        assert(SSPreparationBeginOwnership(source, target, nil, candidate, NULL));
        SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      }
      if ([name isEqual:@"interrupted"] || [name isEqual:@"intent"])
        assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureRestored && code == ECANCELED);
      else assert(SSPreparationRecordFailure(source, actual, nil, ECANCELED, NULL));
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      assert(!SSPreparationCopy(source, target, nil, NULL));
      assert(!SSPreparationValidate(source, target, nil, candidate, NULL));
      assert(!SSPreparationRetire(source, target, NULL));
      NSURL *otherSource = Bundle([fixture stringByAppendingPathComponent:@"other/New.app"]);
      NSURL *otherTarget = Bundle([fixture stringByAppendingPathComponent:@"other-live/Other.app"]);
      if (renamed) {
        assert(SSPreparationRecoverFailure(otherSource, otherTarget, nil, &code, NULL) == SSPreparationFailureInvalid);
        assert(!SSPreparationCopy(otherSource, otherTarget, nil, NULL));
        assert([NSFileManager.defaultManager fileExistsAtPath:candidate.path]);
      }
      if ([name isEqual:@"conflict"]) {
        Bundle(target.path);
        assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureInvalid);
        assert(!SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { abort(); }, ^BOOL { abort(); }, NULL));
        assert([NSFileManager.defaultManager fileExistsAtPath:actual.path]);
        assert([NSFileManager.defaultManager removeItemAtURL:target error:NULL]);
      }
      if ([name isEqual:@"source-change"]) {
        NSString *saved = [source.path stringByAppendingString:@".saved"];
        assert(rename(source.path.fileSystemRepresentation, saved.fileSystemRepresentation) == 0);
        Bundle(source.path);
        assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureInvalid);
        assert(!SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { abort(); }, ^BOOL { abort(); }, NULL));
        assert([NSFileManager.defaultManager removeItemAtURL:source error:NULL]);
        assert(rename(saved.fileSystemRepresentation, source.path.fileSystemRepresentation) == 0);
      }
      assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureRestored && code == ECANCELED);
      if (renamed) assert(![NSFileManager.defaultManager fileExistsAtPath:actual.path]);
      NSString *next = [source.path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".scholarseed-prepare.next"];
      assert(symlink(target.path.fileSystemRepresentation, next.fileSystemRepresentation) == 0);
      assert(!SSReadinessPublish(source, target, NO, code, NULL));
      __block NSUInteger launches = 0;
      assert(!SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, NULL));
      assert(launches == 0); // Publication failure never starts the application.
      assert(!SSReadinessFailedRequest(source, target));
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nil, &code, NULL) == SSPreparationFailureInvalid);
      assert(!SSPreparationCopy(otherSource, otherTarget, nil, NULL));
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureRestored);
      assert(unlink(next.fileSystemRepresentation) == 0);
      assert(SSReadinessPublish(source, target, NO, code, NULL));
      assert(SSReadinessRead(source, target, NULL) == SSReadinessFailed);
      assert(SSReadinessFailedRequest(source, target));
      assert(SSPreparationFinishFailure(source, target, nil, NO, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, NULL));
      assert(launches == 0); // A preparation request cannot authorize a launch.
      if ([name isEqual:@"same"]) {
        assert(SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { return YES; }, ^BOOL { launches++; return YES; }, NULL));
        assert(launches == 0); // Existing application already owns recovery.
      } else {
        assert(!SSPreparationFinishFailure(source, target, @{@"requestId":@"other"}, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, NULL));
        assert(launches == 0);
        assert(!SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { return NO; }, ^BOOL { launches++; return NO; }, NULL));
        assert(launches == 1);
        SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        assert(SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { return NO; }, ^BOOL {
          assert(SSReadinessFailedRequest(source, target)); launches++; return YES;
        }, NULL));
        assert(launches == 2);
      }
      NSUInteger completedLaunches = launches;
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      assert(SSPreparationFinishFailure(source, target, nil, YES, ^BOOL { abort(); }, ^BOOL { abort(); }, NULL));
      assert(launches == completedLaunches);
      assert([NSFileManager.defaultManager fileExistsAtPath:target.path]);
      assert(!SSPreparationCopy(source, target, nil, NULL));
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nil, &code, NULL) == SSPreparationFailureNone);
      NSURL *nextCandidate = SSPreparationCopy(otherSource, otherTarget, nil, NULL); assert(nextCandidate);
      [parents addObject:nextCandidate.path.stringByDeletingLastPathComponent];
      assert(!SSPreparationCopy(source, target, nil, NULL));
      assert([NSFileManager.defaultManager fileExistsAtPath:nextCandidate.path]);
      SSPreparationClose();
      NSLog(@"[shipit-terminal-test] %@ durable restore publish retry PASS", name);
    }
    NSUInteger publicationChecks = Publications(root, parents);
    NSLog(@"[shipit-publication-test] checks passed=%lu", (unsigned long)publicationChecks);
    for (NSString *parent in parents) if ([NSFileManager.defaultManager fileExistsAtPath:parent]) assert([NSFileManager.defaultManager removeItemAtPath:parent error:NULL]);
  }
  return 0;
}
