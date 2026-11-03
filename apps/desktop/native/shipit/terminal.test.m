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
    for (NSString *parent in parents) if ([NSFileManager.defaultManager fileExistsAtPath:parent]) assert([NSFileManager.defaultManager removeItemAtPath:parent error:NULL]);
  }
  return 0;
}
